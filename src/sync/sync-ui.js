/**
 * sync-ui.js — 3.0.0, fase 2
 *
 * Interfaz de Sincronizar (exportar / importar paquete .rpmbak).
 *
 * Reutiliza el estilo de la app: `modal-overlay`, `modal`,
 * `modal-actions`, `import-row`, `btn small primary` y `sound-note`
 * ya existen en index.html v2.9.1 (ver el modal de importar
 * respaldo). `sync-ui.css` solo añade lo propio del resumen.
 *
 * Regla de oro: NADA se aplica sin confirmación explícita.
 * Importar solo lee el paquete, fusiona en memoria (previewMerge)
 * y muestra el resumen; "Aplicar sincronización" es el único botón
 * que escribe, y los borrados propuestos llevan su propia casilla
 * (sin marcarla, el borrado no se aplica aunque sea más nuevo).
 *
 * Este módulo NO toca IndexedDB ni lee archivos por su cuenta: todo
 * lo hace a través del `bridge` que le pasa la app (ver
 * SYNC-UI.md, cableado). Así la UI se puede probar con un bridge
 * falso y el cableado real queda en index.html (fase 3).
 *
 * bridge = {
 *   getLastSyncInfo() -> Promise<{ lastSyncAt, deviceId, trackCount }>
 *   estimateExport(incremental) -> Promise<{ trackCount, audioCount, totalBytes }>
 *   exportPackage(incremental) -> Promise<{ blob, fileName }>
 *   readPackage(file) -> Promise<remote>        // readSyncPackage
 *   getLocalState() -> Promise<localState>       // para previewMerge
 *   preview(localState, remote) -> { merged, report, summary }
 *   applyMerge(preview, { confirmDeletionKeys }) -> Promise<{ applied, ops }>
 *     Vuelve a fusionar con confirmDeletions=true y solo las tumbas
 *     de confirmDeletionKeys, ejecuta las operaciones (buildApplyOps)
 *     contra IndexedDB y actualiza lastSyncAt. Devuelve cuántas
 *     operaciones aplicó.
 *   titleForKey(key) -> string                  // título legible de una pista
 *   onApplied() -> void                          // refrescar la app
 *   toast(msg) -> void
 * }
 */

// ---------- Ayudas puras (probadas con Node) ----------

export function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',') + ' GB';
}

function titlesFor(keys, titleForKey, limit = 5) {
  const items = (keys || []).map((k) => {
    if (typeof k === 'string') return (titleForKey && titleForKey(k)) || k;
    return (titleForKey && titleForKey(k.key)) || k.key;
  });
  return { shown: items.slice(0, limit), extra: Math.max(0, items.length - limit) };
}

/**
 * Filas del resumen para la pantalla de confirmación, a partir del
 * informe de sync-core (mergeState().report). No toca el DOM.
 * Cada fila: { kind, label, detail, items: [títulos], extra }.
 */
export function summaryRows(report, titleForKey) {
  const rows = [];
  const r = report || {};
  rows.push({
    kind: 'added', label: (r.addedTracks || 0) + ' canciones nuevas',
    detail: 'Se añaden a la biblioteca de este dispositivo.',
    items: [], extra: 0,
  });
  rows.push({
    kind: 'updated', label: (r.updatedTracks || 0) + ' canciones actualizadas',
    detail: 'El otro dispositivo tenía cambios más recientes (likes, estrellas, datos).',
    items: [], extra: 0,
  });
  const pending = titlesFor(r.pendingAudio || [], titleForKey);
  rows.push({
    kind: 'pending', label: (r.pendingAudio || []).length + ' pendientes de audio',
    detail: 'Quedan en la lista pero sin archivo en ningún dispositivo. Al re-añadir el archivo se vinculan solas por huella.',
    items: pending.shown, extra: pending.extra,
  });
  const conflicts = titlesFor((r.conflicts || []).map((c) => c.key), titleForKey);
  rows.push({
    kind: 'conflict', label: (r.conflicts || []).length + ' conflictos',
    detail: 'Misma fecha de cambio en los dos lados: se conserva lo de este dispositivo.',
    items: conflicts.shown, extra: conflicts.extra,
  });
  const skipped = titlesFor(r.skippedDeletions || [], titleForKey);
  rows.push({
    kind: 'skippedDeletion', label: (r.skippedDeletions || []).length + ' borrados NO aplicados',
    detail: 'El otro dispositivo las borró, pero el borrado era más viejo que un cambio o no lo confirmaste: se conservan.',
    items: skipped.shown, extra: skipped.extra,
  });
  return rows;
}

/** Borrados que el paquete propone y que el usuario puede confirmar. */
export function deletionOptions(report, titleForKey) {
  return ((report || {}).skippedDeletions || []).map((d) => ({
    key: d.key,
    title: (titleForKey && titleForKey(d.key)) || d.key,
    reason: d.deletedAt > d.localAt
      ? 'Borrado más nuevo que el último cambio: se puede aplicar si lo marcas.'
      : 'Borrado más viejo que el último cambio: no se aplicará aunque lo marques.',
    canApply: d.deletedAt > d.localAt,
  }));
}

// ---------- Interfaz (DOM; solo se ejecuta en el navegador) ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtDate(ms) {
  if (!ms) return 'nunca';
  try { return new Date(ms).toLocaleString('es-MX'); } catch (e) { return 'nunca'; }
}

/**
 * Crea la UI de sync y la engancha al DOM. Devuelve { open, close }.
 * No hace nada hasta que se llama a open(): la app decide cuándo
 * mostrarla (botón "Sincronizar" en Biblioteca, ver SYNC-UI.md).
 */
export function createSyncUI(bridge) {
  if (typeof document === 'undefined') {
    throw new Error('createSyncUI solo funciona en el navegador.');
  }
  const b = bridge || {};
  const toast = b.toast || function () {};
  let current = null; // { remote, preview } del paquete en revisión

  const overlay = el('div', 'modal-overlay');
  overlay.id = 'syncModal';
  overlay.setAttribute('aria-hidden', 'true');
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const title = el('h3', null, 'Sincronizar con otro dispositivo');
  const intro = el('p', null,
    'El sync es un archivo: exportas un paquete .rpmbak, lo llevas al otro ' +
    'dispositivo y lo importas. Sin cuenta, sin servidor. Nada se aplica ' +
    'hasta que lo confirmes en el resumen.');
  const body = el('div', 'sync-body');
  const actions = el('div', 'modal-actions');
  modal.appendChild(title);
  modal.appendChild(intro);
  modal.appendChild(body);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.rpmbak,application/zip';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) onImportFile(f);
  });
  document.body.appendChild(fileInput);

  function open() {
    overlay.classList.add('on');
    overlay.setAttribute('aria-hidden', 'false');
    showMenu();
  }
  function close() {
    overlay.classList.remove('on');
    overlay.setAttribute('aria-hidden', 'true');
    current = null;
  }
  function setActions(buttons) {
    actions.innerHTML = '';
    buttons.forEach(([label, cls, fn]) => {
      const btn = el('button', 'btn small' + (cls ? ' ' + cls : ''), label);
      btn.type = 'button';
      btn.addEventListener('click', fn);
      actions.appendChild(btn);
    });
  }
  function clearBody() { body.innerHTML = ''; }

  async function showMenu() {
    clearBody();
    let info = null;
    try { info = await b.getLastSyncInfo(); } catch (e) { /* sin info: se sigue */ }
    const note = el('p', 'sound-note', info
      ? 'Último sync: ' + fmtDate(info.lastSyncAt) + ' · Este dispositivo: ' +
        String(info.deviceId || 'sin id') + ' · ' + (info.trackCount || 0) + ' canciones.'
      : 'Aún no hay ningún sync en este dispositivo.');
    body.appendChild(note);
    const exp = el('button', 'btn small primary', 'Exportar paquete (.rpmbak)');
    exp.type = 'button';
    exp.addEventListener('click', showExport);
    const imp = el('button', 'btn small', 'Importar paquete (.rpmbak)');
    imp.type = 'button';
    imp.addEventListener('click', () => fileInput.click());
    const row = el('div', 'sync-menu-row');
    row.appendChild(exp);
    row.appendChild(imp);
    body.appendChild(row);
    const warn = el('p', 'sound-note',
      'El paquete no va cifrado: quien tenga el archivo tiene tu música y ' +
      'tus metadatos. Muévelo por un canal que ya uses y en el que confíes.');
    body.appendChild(warn);
    setActions([['Cerrar', '', close]]);
  }

  async function showExport() {
    clearBody();
    title.textContent = 'Exportar paquete de sync';
    const incLabel = el('label', 'import-row');
    const incCb = document.createElement('input');
    incCb.type = 'checkbox';
    incCb.checked = true;
    const incTx = el('span');
    incTx.appendChild(el('strong', null, 'Solo cambios desde el último sync'));
    incTx.appendChild(el('span', 'import-detail',
      'Recomendado: el paquete pesa menos y solo lleva los audios que cambiaron.'));
    incLabel.appendChild(incCb);
    incLabel.appendChild(incTx);
    body.appendChild(incLabel);
    const fullLabel = el('label', 'import-row');
    const fullCb = document.createElement('input');
    fullCb.type = 'checkbox';
    const fullTx = el('span');
    fullTx.appendChild(el('strong', null, 'Paquete completo'));
    fullTx.appendChild(el('span', 'import-detail',
      'Toda la biblioteca con todos los audios. Para el primer emparejamiento de un dispositivo. Puede pesar GBs.'));
    fullLabel.appendChild(fullCb);
    fullLabel.appendChild(fullTx);
    body.appendChild(fullLabel);
    incCb.addEventListener('change', () => { if (incCb.checked) fullCb.checked = false; updateEstimate(); });
    fullCb.addEventListener('change', () => { if (fullCb.checked) incCb.checked = false; updateEstimate(); });
    const est = el('p', 'sound-note', 'Calculando tamaño…');
    body.appendChild(est);
    async function updateEstimate() {
      try {
        const e = await b.estimateExport(!fullCb.checked);
        est.textContent = e.trackCount + ' canciones · ' + e.audioCount +
          ' audios en el paquete · ' + formatBytes(e.totalBytes) + ' aprox.';
      } catch (err) { est.textContent = 'No se pudo calcular el tamaño antes de exportar.'; }
    }
    updateEstimate();
    setActions([['Volver', '', () => { title.textContent = 'Sincronizar con otro dispositivo'; showMenu(); }], ['Exportar', 'primary', async () => {
      try {
        const res = await b.exportPackage(!fullCb.checked);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(res.blob);
        a.download = res.fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} if (a.parentNode) a.parentNode.removeChild(a); }, 800);
        toast('Paquete exportado: ' + res.fileName);
        close();
      } catch (err) { toast('No se pudo exportar el paquete.'); }
    }]]);
  }

  async function onImportFile(file) {
    clearBody();
    title.textContent = 'Importar paquete de sync';
    const status = el('p', 'sound-note', 'Leyendo ' + file.name + '…');
    body.appendChild(status);
    setActions([['Cancelar', '', close]]);
    try {
      const remote = await b.readPackage(file);
      const localState = await b.getLocalState();
      const preview = b.preview(localState, remote);
      current = { remote, preview };
      showPreview(file, preview);
    } catch (err) {
      status.textContent = 'No se pudo leer el paquete: ' + (err && err.message ? err.message : 'archivo no válido.');
    }
  }

  function showPreview(file, preview) {
    clearBody();
    title.textContent = 'Revisar antes de aplicar';
    const from = el('p', 'sound-note',
      'Paquete ' + (file ? file.name : '') + '. Esto es solo una vista previa: nada se ha aplicado todavía.');
    body.appendChild(from);
    const rows = summaryRows(preview.report, b.titleForKey);
    rows.forEach((r) => {
      const row = el('div', 'import-row sync-row');
      const tx = el('span');
      tx.appendChild(el('strong', null, r.label));
      tx.appendChild(el('span', 'import-detail', r.detail));
      if (r.items.length) {
        tx.appendChild(el('span', 'import-detail', 'Ej.: ' + r.items.join(' · ') +
          (r.extra ? ' · y ' + r.extra + ' más' : '')));
      }
      row.appendChild(tx);
      body.appendChild(row);
    });
    // Borrados propuestos: casilla por borrado, sin marcar = no se aplica.
    const dels = deletionOptions(preview.report, b.titleForKey);
    const checks = [];
    if (dels.length) {
      body.appendChild(el('p', 'sound-note',
        'Borrados del otro dispositivo: marca solo los que quieras aplicar. Sin marcar, la canción se conserva.'));
      dels.forEach((d) => {
        const label = el('label', 'import-row');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        cb.disabled = !d.canApply;
        const tx = el('span');
        tx.appendChild(el('strong', null, d.title));
        tx.appendChild(el('span', 'import-detail', d.reason));
        label.appendChild(cb);
        label.appendChild(tx);
        body.appendChild(label);
        checks.push({ key: d.key, cb, canApply: d.canApply });
      });
    }
    if (preview.merged && preview.merged.settingsConflict) {
      body.appendChild(el('p', 'sound-note',
        'Los ajustes cambiaron en los dos dispositivos desde el último sync: ' +
        'se conservan los de este dispositivo.'));
    }
    const lines = el('p', 'sound-note', preview.summary.join(' '));
    body.appendChild(lines);
    setActions([['Cancelar', '', close], ['Aplicar sincronización', 'primary', async () => {
      try {
        const confirmed = checks.filter((c) => c.cb.checked && c.canApply).map((c) => c.key);
        const res = await b.applyMerge(preview, { confirmDeletionKeys: confirmed });
        toast('Sincronización aplicada: ' + res.applied + ' operaciones.');
        if (b.onApplied) b.onApplied();
        close();
      } catch (err) { toast('No se pudo aplicar la sincronización.'); }
    }]]);
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { open, close };
}
