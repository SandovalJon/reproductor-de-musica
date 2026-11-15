/* nube.js — Sincronización automática en la nube (reproductor-de-musica v4.0.0, módulo aparte)
 *
 * Qué hace: sincroniza la biblioteca sola entre dispositivos, sin
 * exportar e importar el .rpmbak a mano. SIN servidor propio ni
 * cuentas nuevas: usa el Google Drive DEL USUARIO a través del
 * módulo de respaldo de la 3.9.0 (drive.js) y el paquete .rpmbak y
 * las reglas de fusión que ya existen (sync-core / package-io).
 *
 * HONESTIDAD, léeme primero:
 * - La app NO tiene cuenta de Google propia. Esto solo funciona si
 *   el usuario ya conectó su Drive en el panel «☁️ Drive» (su propio
 *   Client ID OAuth, permiso drive.file). Sin Drive conectado, el
 *   módulo NO hace nada y lo explica en su panel y en el estado.
 * - Es OPCIONAL y está DESACTIVADO por defecto. Al activarlo, la app
 *   sube sola el paquete a tu Drive cada X minutos y descarga el de
 *   tus otros dispositivos: ese aviso está en el panel, junto al
 *   botón para desactivarla en cualquier momento. Desactivar para
 *   las subidas y descargas automáticas en seco; nada se borra de
 *   tu Drive (el archivo de la nube se queda allí).
 * - No se inventa ningún formato: el archivo en la nube es el mismo
 *   .rpmbak completo que construye __rpmSync.exportPackage(false)
 *   (buildSyncPackage de package-io.js), con nombre fijo
 *   «reproductor-sync-nube.rpmbak» para no confundirlo con los
 *   respaldos manuales de Drive (que llevan fecha). Se actualiza en
 *   el mismo archivo de Drive (PATCH del contenido) en vez de crear
 *   un archivo nuevo en cada sincronización.
 * - La fusión es la que ya existe: previewMerge() + applyMerge() del
 *   puente de sync, con las reglas de sync-core (último cambio gana
 *   POR PISTA; nada se borra sin aviso). La sincronización
 *   automática NUNCA aplica un borrado: si el paquete de la nube
 *   trae borrados pendientes de confirmar (tumbas), NO se aplica
 *   nada automáticamente y se avisa de que hay que revisarlos en
 *   «Sincronizar» → «Importar paquete». Los conflictos (misma fecha
 *   de cambio) se resuelven como ya hace sync-core —gana lo local y
 *   queda registrado— y se muestran en el resumen.
 * - El token de Google vive solo en memoria (lo gestiona drive.js)
 *   y caduca en ~1 hora; si caduca, drive.js pide uno nuevo en
 *   silencio con el permiso ya concedido. Si eso falla (permiso
 *   revocado, sesión cerrada), el ciclo falla con un mensaje claro
 *   y la app sigue funcionando igual: hay que volver a pulsar
 *   «Conectar con Google» en el panel de Drive.
 * - Un ciclo es: descargar la copia de la nube → si es más nueva
 *   que el último sync, fusionar y aplicar (salvo borrados) →
 *   si este dispositivo tiene cambios más nuevos que la nube,
 *   subir el paquete completo. Si la copia de la nube es de ESTE
 *   dispositivo (mismo deviceId), no se descarga nada.
 * - Solo sincroniza mientras la app está abierta (temporizador en
 *   la página). No hay trabajo en segundo plano ni service worker
 *   implicado: si la app está cerrada, no hay sincronización.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico,
 * como drive.js. Solo usa window.__rpmDrive (API ampliada en 4.0.0:
 * isConnected, ensureConnected, listFilesByName, downloadFileBlob,
 * uploadFile, updateFileContent) y window.__rpmSync (getLastSyncInfo,
 * getLocalState, readPackage, preview, applyMerge, exportPackage,
 * onApplied). Si el módulo falla al cargar, o si falta Drive o el
 * sync, la app sigue funcionando igual: todo el init va en
 * try/catch y el botón solo se añade si existe #btnDrive o #btnSync.
 * Ver WIRING.md.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var CLOUD_FILE_NAME = 'reproductor-sync-nube.rpmbak';
  var CLOUD_MIME = 'application/zip';
  var INTERVAL_OPTIONS = [15, 30, 60];
  var DEFAULT_INTERVAL_MINUTES = 30;
  var LS_CONFIG = 'rpm-nube-config';
  var LS_CLOUD_FILE_ID = 'rpm-nube-file-id';
  var FIRST_RUN_DELAY_MS = 10000; // dejar que la app y el sync arranquen

  /* ================= Lógica pura (probada en Node) ================= */

  function defaultConfig() {
    return {
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      lastSyncAt: 0,
      lastResult: null,
      lastError: null,
    };
  }

  // Acepta un objeto, un JSON en texto, null o basura: siempre
  // devuelve una configuración válida, sin inventar valores.
  function parseConfig(raw) {
    var cfg = defaultConfig();
    var obj = null;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    } else if (raw && typeof raw === 'object') {
      obj = raw;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return cfg;
    if (obj.enabled === true) cfg.enabled = true;
    var v = validateInterval(obj.intervalMinutes);
    cfg.intervalMinutes = v.ok ? v.minutes : DEFAULT_INTERVAL_MINUTES;
    if (typeof obj.lastSyncAt === 'number' && isFinite(obj.lastSyncAt) && obj.lastSyncAt > 0) {
      cfg.lastSyncAt = Math.floor(obj.lastSyncAt);
    }
    if (typeof obj.lastResult === 'string' && obj.lastResult) cfg.lastResult = obj.lastResult;
    if (typeof obj.lastError === 'string' && obj.lastError) cfg.lastError = obj.lastError;
    return cfg;
  }

  function serializeConfig(config) {
    var cfg = parseConfig(config);
    return JSON.stringify(cfg);
  }

  // Solo 15, 30 o 60 minutos. Cualquier otra cosa es un error, no se
  // redondea en silencio a un valor que el usuario no eligió.
  function validateInterval(minutes) {
    var n = Number(minutes);
    if (INTERVAL_OPTIONS.indexOf(n) !== -1) return { ok: true, minutes: n };
    return { ok: false, error: 'El intervalo tiene que ser 15, 30 o 60 minutos.' };
  }

  function formatInterval(minutes) {
    var v = validateInterval(minutes);
    var n = v.ok ? v.minutes : DEFAULT_INTERVAL_MINUTES;
    return 'cada ' + n + ' minutos';
  }

  // ¿Toca sincronizar? Solo si está activada y ha pasado el intervalo
  // desde la última sincronización (la primera vez, lastSyncAt es 0
  // y siempre toca).
  function isDue(config, nowMs) {
    var cfg = parseConfig(config);
    if (!cfg.enabled) return false;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    return (now - cfg.lastSyncAt) >= cfg.intervalMinutes * 60000;
  }

  // Milisegundos hasta la próxima sincronización; null si está
  // desactivada; 0 si ya toca.
  function nextSyncInMs(config, nowMs) {
    var cfg = parseConfig(config);
    if (!cfg.enabled) return null;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    return Math.max(0, cfg.lastSyncAt + cfg.intervalMinutes * 60000 - now);
  }

  // De la lista de Drive, la copia de la nube de ESTE módulo: nombre
  // exacto, la más reciente por modifiedTime. Los respaldos manuales
  // (con fecha) no son la copia de la nube y no se tocan. No muta
  // la lista que recibe.
  function pickCloudFile(files) {
    if (!Array.isArray(files)) return null;
    var mine = files.filter(function (f) {
      return f && typeof f === 'object' && f.name === CLOUD_FILE_NAME &&
        typeof f.id === 'string' && !!f.id;
    });
    if (!mine.length) return null;
    mine.sort(function (a, b) {
      return parseExportedAt(b.modifiedTime) - parseExportedAt(a.modifiedTime);
    });
    return mine[0];
  }

  // exportedAt / modifiedTime como milisegundos; 0 si no se entiende.
  // Acepta texto ISO, número y Date.
  function parseExportedAt(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? 0 : value.getTime();
    if (typeof value === 'number' && isFinite(value) && value > 0) return Math.floor(value);
    if (typeof value === 'string' && value) {
      var ms = Date.parse(value);
      return isNaN(ms) ? 0 : ms;
    }
    return 0;
  }

  function isRemoteNewer(remoteExportedAt, lastSyncAt) {
    var remoteMs = parseExportedAt(remoteExportedAt);
    if (!remoteMs) return false;
    return remoteMs > (typeof lastSyncAt === 'number' ? lastSyncAt : 0);
  }

  // El cambio local más reciente: el updatedAt/addedAt mayor de las
  // pistas, o stateUpdatedAt si es mayor. 0 si no hay nada fechado.
  function localNewestChange(localState) {
    var newest = 0;
    var st = localState || {};
    if (typeof st.stateUpdatedAt === 'number' && isFinite(st.stateUpdatedAt)) {
      newest = Math.max(newest, st.stateUpdatedAt);
    }
    (Array.isArray(st.tracks) ? st.tracks : []).forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      var at = (typeof t.updatedAt === 'number' && isFinite(t.updatedAt)) ? t.updatedAt
        : (typeof t.addedAt === 'number' && isFinite(t.addedAt)) ? t.addedAt : 0;
      if (at > newest) newest = at;
    });
    return newest;
  }

  // ¿Hay que subir la copia local a la nube? Sí si este dispositivo
  // tiene cambios más nuevos que la copia de la nube, o si no hay
  // copia en la nube y la biblioteca tiene algo. No si la biblioteca
  // está vacía y sin fechas (no se crea una nube vacía).
  function needsUpload(localState, remoteExportedAt) {
    var newest = localNewestChange(localState);
    if (!newest) return false;
    var remoteMs = parseExportedAt(remoteExportedAt);
    if (!remoteMs) return true;
    return newest > remoteMs;
  }

  // Decisión de aplicar automáticamente una vista previa del sync.
  // La única razón para NO aplicar es que haya borrados pendientes
  // de confirmar: esos los decide el usuario en el sync manual.
  // Conflictos y pendientes de audio se aplican como ya decide
  // sync-core (gana lo local; la pista queda pendiente) y se
  // muestran en el resumen, no se ocultan.
  function decideAutoApply(report) {
    var r = report || {};
    var skipped = Array.isArray(r.skippedDeletions) ? r.skippedDeletions : [];
    if (skipped.length) {
      return {
        apply: false,
        reason: 'borrados-pendientes',
        skippedDeletions: skipped.length,
        message: skipped.length + (skipped.length === 1
          ? ' borrado del otro dispositivo necesita tu confirmación.'
          : ' borrados del otro dispositivo necesitan tu confirmación.') +
          ' La sincronización automática no borra nada sin aviso: revísalos en «Sincronizar» → «Importar paquete».',
      };
    }
    return { apply: true, reason: 'ok', skippedDeletions: 0, message: '' };
  }

  // ¿Es un 404 de Drive? Sirve para reintentar creando el archivo
  // cuando la copia guardada ya no existe en Drive.
  function isNotFoundError(err) {
    if (!err) return false;
    if (err.driveStatus === 404) return true;
    var m = (err.message || '') + '';
    return /\(404\)/.test(m) || /ya no está en Drive/i.test(m);
  }

  // Resumen en español de un ciclo, para el estado y el toast.
  // result: { downloaded, uploaded, skippedDeletions } donde
  // downloaded es { added, updated, conflicts, pendingAudio } o null.
  function summarizeRun(result) {
    var r = result || {};
    if (r.skippedDeletions) {
      return 'Sin cambios automáticos: hay ' + r.skippedDeletions +
        (r.skippedDeletions === 1 ? ' borrado pendiente de confirmar' : ' borrados pendientes de confirmar') +
        ' en «Sincronizar». Nada se borró.';
    }
    var parts = [];
    var d = r.downloaded;
    if (d) {
      var add = d.added || 0, upd = d.updated || 0;
      parts.push('de la nube: ' + add + (add === 1 ? ' canción nueva' : ' canciones nuevas') +
        ', ' + upd + (upd === 1 ? ' actualizada' : ' actualizadas'));
      if (d.conflicts) parts.push(d.conflicts + (d.conflicts === 1 ? ' conflicto (se conservó lo de este dispositivo)' : ' conflictos (se conservó lo de este dispositivo)'));
      if (d.pendingAudio) parts.push(d.pendingAudio + (d.pendingAudio === 1 ? ' pendiente de audio' : ' pendientes de audio'));
    }
    if (r.uploaded) parts.push('copia en la nube actualizada');
    if (!parts.length) return 'Ya estabas al día con la nube.';
    return 'Sincronizado con Drive: ' + parts.join(' · ') + '.';
  }

  // Estado en palabras llanas para el panel, según Drive.
  // driveState: { driveLoaded, hasClientId, connected }.
  function describeStatus(config, driveState) {
    var cfg = parseConfig(config);
    var d = driveState || {};
    if (!d.driveLoaded) {
      return { ready: false, text: 'El módulo de Drive no está cargado: la sincronización en la nube no puede funcionar. Recarga la app.' };
    }
    if (!d.hasClientId) {
      return { ready: false, text: 'Sin Client ID de Google: abre «Drive» y guarda tu Client ID para poder sincronizar en la nube. Mientras tanto no se sube ni se descarga nada.' };
    }
    if (!d.connected) {
      return { ready: false, text: 'Drive sin conectar en esta sesión: abre «Drive» y pulsa «Conectar con Google». La sincronización automática esperará hasta que conectes; no se sube ni se descarga nada.' };
    }
    if (!cfg.enabled) {
      return { ready: true, text: 'Lista, pero desactivada: usa tu Google Drive con tu Client ID. Actívala para sincronizar sola ' + formatInterval(cfg.intervalMinutes) + '.' };
    }
    return { ready: true, text: 'Activa: sincroniza sola con tu Google Drive ' + formatInterval(cfg.intervalMinutes) + ' mientras la app esté abierta.' };
  }

  /* ================= Ciclo de sincronización =================
   * createNubeSync(deps) es la parte que se puede probar en Node:
   * no toca el DOM; Drive y el sync llegan por deps.
   * deps: { drive, sync, store, now }
   *   drive: __rpmDrive (API ampliada en 4.0.0).
   *   sync: __rpmSync (puente de sync por .rpmbak).
   *   store: { get(k), set(k, v), del(k) } (localStorage).
   *   now: () => milisegundos (opcional, para pruebas).
   * run({ manual }) devuelve SIEMPRE un resultado, nunca lanza:
   *   { ok, downloaded, uploaded, skippedDeletions, summary, error, reason }
   */
  function createNubeSync(deps) {
    var drive = deps && deps.drive ? deps.drive : null;
    var sync = deps && deps.sync ? deps.sync : null;
    var store = deps && deps.store ? deps.store : null;
    var nowFn = (deps && typeof deps.now === 'function') ? deps.now : Date.now;
    var running = false;

    function storeGet(k) {
      try { return store ? store.get(k) : null; } catch (e) { return null; }
    }
    function storeSet(k, v) {
      try { if (store) store.set(k, v); } catch (e) {}
    }
    function loadConfig() { return parseConfig(storeGet(LS_CONFIG)); }
    function saveConfig(cfg) { storeSet(LS_CONFIG, serializeConfig(cfg)); }

    function fail(config, message, reason) {
      config.lastError = message;
      config.lastResult = null;
      saveConfig(config);
      return { ok: false, downloaded: null, uploaded: false, skippedDeletions: 0, summary: message, error: message, reason: reason || 'error' };
    }

    function run(opts) {
      var manual = !!(opts && opts.manual);
      if (running) {
        return Promise.resolve({ ok: false, downloaded: null, uploaded: false, skippedDeletions: 0, summary: 'Ya hay una sincronización en curso.', error: 'Ya hay una sincronización en curso.', reason: 'en-curso' });
      }
      running = true;
      var config = loadConfig();
      if (!config.enabled && !manual) {
        running = false;
        return Promise.resolve({ ok: false, downloaded: null, uploaded: false, skippedDeletions: 0, summary: 'La sincronización automática está desactivada.', error: 'La sincronización automática está desactivada.', reason: 'desactivada' });
      }
      if (!drive || typeof drive.getStoredClientId !== 'function') {
        running = false;
        return Promise.resolve(fail(config, 'El módulo de Drive no está cargado: no se puede sincronizar en la nube.', 'sin-drive'));
      }
      var chain = Promise.resolve();
      // Sin Client ID no hay nada que intentar: ni token ni subida.
      if (!drive.getStoredClientId()) {
        running = false;
        return Promise.resolve(fail(config, 'Sin Client ID de Google: abre «Drive» y guarda tu Client ID para sincronizar en la nube.', 'sin-client-id'));
      }
      // Sin token en memoria, pedir uno con el permiso ya concedido.
      // Si falla, no se intenta nada más: hay que reconectar a mano.
      if (typeof drive.isConnected === 'function' && !drive.isConnected()) {
        chain = chain.then(function () {
          if (typeof drive.ensureConnected !== 'function') {
            throw new Error('Drive no expone cómo reconectar: abre «Drive» y pulsa «Conectar con Google».');
          }
          return drive.ensureConnected();
        });
      }
      if (!sync) {
        running = false;
        return Promise.resolve(fail(config, 'La sincronización por .rpmbak no está disponible en esta app.', 'sin-sync'));
      }

      var info = null, localState = null, cloudFile = null, remoteExportedAt = null;
      var downloaded = null, skippedDeletions = 0, uploaded = false;

      chain = chain.then(function () { return sync.getLastSyncInfo(); })
        .then(function (i) { info = i || {}; return sync.getLocalState(); })
        .then(function (st) {
          localState = st || {};
          return drive.listFilesByName(CLOUD_FILE_NAME);
        })
        .then(function (files) {
          cloudFile = pickCloudFile(files);
          if (!cloudFile) return null;
          return drive.downloadFileBlob(cloudFile.id);
        })
        .then(function (blob) {
          if (!blob) return null;
          return sync.readPackage(blob);
        })
        .then(function (remote) {
          if (!remote || !remote.meta) return null;
          remoteExportedAt = remote.meta.exportedAt || null;
          // La copia de la nube es de este dispositivo: ya la tenemos.
          if (remote.meta.deviceId && info.deviceId && remote.meta.deviceId === info.deviceId) {
            return null;
          }
          if (!isRemoteNewer(remoteExportedAt, info.lastSyncAt || 0)) return null;
          var preview = sync.preview(localState, remote);
          var decision = decideAutoApply(preview.report);
          if (!decision.apply) {
            skippedDeletions = decision.skippedDeletions;
            return 'bloqueado-por-borrados';
          }
          return sync.applyMerge(preview, { confirmDeletionKeys: [] }).then(function () {
            downloaded = {
              added: preview.report.addedTracks || 0,
              updated: preview.report.updatedTracks || 0,
              conflicts: (preview.report.conflicts || []).length,
              pendingAudio: (preview.report.pendingAudio || []).length,
            };
            if (typeof sync.onApplied === 'function') {
              try {
                var p = sync.onApplied();
                if (p && typeof p.then === 'function') return p.then(function () { return 'aplicado'; });
              } catch (e) { /* la biblioteca ya está escrita; no es fatal */ }
            }
            return 'aplicado';
          });
        })
        .then(function () {
          if (skippedDeletions) return; // no subir por encima de la copia con borrados pendientes
          // Tras aplicar, releer el estado local: la fusión puede
          // haber traído cambios que ya están en la nube.
          return sync.getLocalState().then(function (st) {
            localState = st || {};
            if (!needsUpload(localState, remoteExportedAt)) return;
            return sync.exportPackage(false).then(function (pkg) {
              if (!pkg || !pkg.blob) throw new Error('El sync no devolvió el paquete .rpmbak.');
              var fileId = storeGet(LS_CLOUD_FILE_ID) || (cloudFile && cloudFile.id) || null;
              var up = Promise.resolve(null);
              if (fileId) {
                up = drive.updateFileContent(fileId, pkg.blob, CLOUD_MIME).catch(function (err) {
                  if (isNotFoundError(err)) return null; // el archivo ya no existe: crear uno nuevo
                  throw err;
                });
              }
              return up.then(function (out) {
                if (!out) return drive.uploadFile(pkg.blob, CLOUD_FILE_NAME, CLOUD_MIME);
                return out;
              }).then(function (out) {
                if (out && out.id) storeSet(LS_CLOUD_FILE_ID, out.id);
                uploaded = true;
              });
            });
          });
        })
        .then(function () {
          config.lastSyncAt = nowFn();
          config.lastError = null;
          var result = { ok: true, downloaded: downloaded, uploaded: uploaded, skippedDeletions: skippedDeletions, summary: '', error: null, reason: 'ok' };
          result.summary = summarizeRun(result);
          config.lastResult = result.summary;
          saveConfig(config);
          running = false;
          return result;
        })
        .catch(function (err) {
          running = false;
          var message = (err && err.message) ? err.message : 'No se pudo sincronizar con la nube.';
          return fail(config, message, 'error');
        });
      return chain;
    }

    return {
      run: run,
      isRunning: function () { return running; },
      loadConfig: loadConfig,
      saveConfig: saveConfig,
    };
  }

  /* ================= Parte de navegador (DOM) =================
   * Todo aquí es defensivo: si falta un elemento o la app aún no
   * está lista, el módulo no hace nada y la app sigue igual. */
  var doc = (typeof document !== 'undefined') ? document : null;
  var win = (typeof window !== 'undefined') ? window : global;

  function getDrive() {
    try { return (typeof window !== 'undefined' && window.__rpmDrive) || null; }
    catch (e) { return null; }
  }
  function getSync() {
    try { return (typeof window !== 'undefined' && window.__rpmSync) || null; }
    catch (e) { return null; }
  }
  function appToast(msg) {
    var app = null;
    try { app = (typeof window !== 'undefined' && window.__rpmApp) || null; } catch (e) {}
    if (app && typeof app.toast === 'function') { try { app.toast(msg); return; } catch (e) {} }
    if (!doc) return;
    var el = doc.getElementById('nubeToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'nubeToast'; el.className = 'nube-toast'; el.setAttribute('role', 'status');
      doc.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3600);
  }

  function lsGet(key) {
    try { return win.localStorage ? win.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { if (win.localStorage) win.localStorage.setItem(key, value); } catch (e) {}
  }
  function lsDel(key) {
    try { if (win.localStorage) win.localStorage.removeItem(key); } catch (e) {}
  }
  var lsStore = { get: lsGet, set: lsSet, del: lsDel };

  var nubeCore = null;
  var timerId = null;
  var nubeModal = null;
  var statusEl = null, toggleEl = null, intervalEl = null, disableBtn = null, syncNowBtn = null;

  function getCore() {
    if (!nubeCore) nubeCore = createNubeSync({ drive: getDrive(), sync: getSync(), store: lsStore });
    return nubeCore;
  }
  // El puente de sync (módulo ES) puede cargar después que este
  // script clásico: recrear el núcleo si Drive o el sync aparecieron.
  function refreshCore() {
    nubeCore = createNubeSync({ drive: getDrive(), sync: getSync(), store: lsStore });
    return nubeCore;
  }

  function driveState() {
    var drive = getDrive();
    if (!drive) return { driveLoaded: false, hasClientId: false, connected: false };
    var hasId = false;
    try { hasId = !!drive.getStoredClientId(); } catch (e) { hasId = false; }
    var connected = false;
    try { connected = (typeof drive.isConnected === 'function') ? !!drive.isConnected() : false; } catch (e) { connected = false; }
    return { driveLoaded: true, hasClientId: hasId, connected: connected };
  }

  function loadConfig() { return parseConfig(lsGet(LS_CONFIG)); }
  function saveConfig(cfg) { lsSet(LS_CONFIG, serializeConfig(cfg)); }

  function formatTime(ms) {
    if (!ms) return 'nunca';
    try {
      var d = new Date(ms);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return 'nunca'; }
  }
  function formatIn(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return 'ahora';
    var min = Math.ceil(ms / 60000);
    if (min < 60) return 'en ' + min + (min === 1 ? ' minuto' : ' minutos');
    var h = Math.floor(min / 60), m = min % 60;
    return 'en ' + h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  function renderStatus() {
    if (!statusEl) return;
    var cfg = loadConfig();
    var base = describeStatus(cfg, driveState());
    var lines = [base.text];
    lines.push(cfg.enabled ? 'Activada (' + formatInterval(cfg.intervalMinutes) + ').' : 'Desactivada.');
    lines.push('Última sincronización: ' + formatTime(cfg.lastSyncAt) +
      (cfg.enabled ? ' · Próxima: ' + formatIn(nextSyncInMs(cfg, Date.now())) : '') + '.');
    if (cfg.lastResult) lines.push('Último resultado: ' + cfg.lastResult);
    if (cfg.lastError) lines.push('Último error: ' + cfg.lastError);
    statusEl.textContent = lines.join(' ');
    if (toggleEl) toggleEl.checked = !!cfg.enabled;
    if (intervalEl) intervalEl.value = String(cfg.intervalMinutes);
    if (disableBtn) disableBtn.disabled = !cfg.enabled;
    if (syncNowBtn) syncNowBtn.disabled = false;
  }

  function stopTimer() {
    if (timerId != null) { clearTimeout(timerId); timerId = null; }
  }
  function scheduleNext() {
    stopTimer();
    var cfg = loadConfig();
    if (!cfg.enabled) return;
    var ms = nextSyncInMs(cfg, Date.now());
    if (ms == null) return;
    timerId = setTimeout(function () {
      timerId = null;
      runAuto().then(function () { scheduleNext(); });
    }, Math.max(ms, 1000));
  }
  function scheduleFirst() {
    // Primera pasada al abrir la app: esperar a que el sync esté
    // listo antes de intentar nada.
    stopTimer();
    var cfg = loadConfig();
    if (!cfg.enabled) return;
    if (!isDue(cfg, Date.now())) { scheduleNext(); return; }
    timerId = setTimeout(function () {
      timerId = null;
      runAuto().then(function () { scheduleNext(); });
    }, FIRST_RUN_DELAY_MS);
  }

  function runAuto() {
    refreshCore();
    return getCore().run({ manual: false }).then(function (res) {
      renderStatus();
      if (res.ok && (res.downloaded || res.uploaded)) appToast(res.summary);
      else if (!res.ok && res.reason !== 'desactivada' && res.reason !== 'en-curso') appToast(res.summary);
      return res;
    });
  }
  function runManual() {
    refreshCore();
    if (syncNowBtn) syncNowBtn.disabled = true;
    return getCore().run({ manual: true }).then(function (res) {
      renderStatus();
      appToast(res.summary);
      return res;
    });
  }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function openOverlay(ov) { ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); }
  function closeOverlay(ov) { ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); }

  function openNubeModal() {
    if (!doc) return;
    if (!nubeModal) {
      var ov = el('div', 'modal-overlay nube-overlay');
      var box = el('div', 'modal nube-modal');
      ov.appendChild(box);
      ov.addEventListener('click', function (ev) { if (ev.target === ov) closeOverlay(ov); });
      doc.body.appendChild(ov);
      nubeModal = { ov: ov, box: box };

      box.appendChild(el('h3', null, 'Sincronización automática en la nube'));
      box.appendChild(el('p', 'nube-sub',
        'Tu biblioteca se sincroniza sola entre tus dispositivos, sin exportar e importar el .rpmbak a mano. ' +
        'No usa ningún servidor nuestro ni cuenta nueva: usa TU Google Drive con TU Client ID (el mismo del panel «☁️ Drive»). ' +
        'Cuando está activada, la app sube sola el paquete .rpmbak a tu Drive y descarga el de tus otros dispositivos. ' +
        'La fusión es la de siempre: último cambio gana por canción, y un borrado del otro dispositivo NUNCA se aplica solo: ' +
        'se avisa y se confirma a mano en «Sincronizar».'));

      statusEl = el('p', 'nube-status', '');
      box.appendChild(statusEl);

      var toggleRow = el('label', 'nube-toggle-row');
      toggleEl = doc.createElement('input');
      toggleEl.type = 'checkbox';
      toggleEl.id = 'nubeEnabled';
      toggleRow.appendChild(toggleEl);
      toggleRow.appendChild(el('span', null, 'Activar la sincronización automática'));
      box.appendChild(toggleRow);

      var intervalRow = el('div', 'nube-interval-row');
      intervalRow.appendChild(el('label', 'nube-interval-label', 'Sincronizar cada'));
      intervalEl = doc.createElement('select');
      intervalEl.id = 'nubeInterval';
      INTERVAL_OPTIONS.forEach(function (m) {
        var opt = doc.createElement('option');
        opt.value = String(m);
        opt.textContent = m + ' minutos';
        intervalEl.appendChild(opt);
      });
      intervalRow.appendChild(intervalEl);
      intervalRow.appendChild(el('span', 'nube-note', 'Solo mientras la app esté abierta.'));
      box.appendChild(intervalRow);

      toggleEl.addEventListener('change', function () {
        var cfg = loadConfig();
        if (!toggleEl.checked) { setEnabled(false); return; }
        // Activar es un gesto del usuario: comprobar aquí mismo que
        // Drive está listo y que el token funciona, antes de dejarla
        // activada y que luego falle en silencio cada X minutos.
        var drive = getDrive();
        if (!drive || !drive.getStoredClientId || !drive.getStoredClientId()) {
          toggleEl.checked = false;
          appToast('Primero guarda tu Client ID en el panel «☁️ Drive». Sin él no se puede sincronizar.');
          renderStatus();
          return;
        }
        var tryConnect = (typeof drive.isConnected === 'function' && drive.isConnected())
          ? Promise.resolve()
          : (typeof drive.ensureConnected === 'function' ? drive.ensureConnected() : Promise.reject(new Error('Drive no expone cómo conectar.')));
        tryConnect.then(function () {
          setEnabled(true);
          appToast('Sincronización automática activada (' + formatInterval(loadConfig().intervalMinutes) + ').');
        }).catch(function (err) {
          toggleEl.checked = false;
          appToast((err && err.message) || 'No se pudo conectar con Google. Abre «Drive» y pulsa «Conectar con Google».');
          renderStatus();
        });
      });

      intervalEl.addEventListener('change', function () {
        var v = validateInterval(intervalEl.value);
        if (!v.ok) { renderStatus(); return; }
        var cfg = loadConfig();
        cfg.intervalMinutes = v.minutes;
        saveConfig(cfg);
        if (cfg.enabled) scheduleNext();
        renderStatus();
      });

      var actions = el('div', 'nube-actions');
      syncNowBtn = el('button', 'btn small primary', 'Sincronizar ahora');
      syncNowBtn.type = 'button';
      syncNowBtn.addEventListener('click', function () { runManual(); });
      actions.appendChild(syncNowBtn);
      var driveBtn = el('button', 'btn small', 'Abrir panel de Drive');
      driveBtn.type = 'button';
      driveBtn.addEventListener('click', function () {
        var drive = getDrive();
        if (drive && typeof drive.openDriveModal === 'function') drive.openDriveModal();
        else appToast('El módulo de Drive no está cargado.');
      });
      actions.appendChild(driveBtn);
      disableBtn = el('button', 'btn small', 'Desactivar sincronización');
      disableBtn.type = 'button';
      disableBtn.addEventListener('click', function () { setEnabled(false); });
      actions.appendChild(disableBtn);
      box.appendChild(actions);

      box.appendChild(el('p', 'nube-note',
        'Archivo en tu Drive: «' + CLOUD_FILE_NAME + '» (se actualiza en el mismo archivo; no se confunde con tus respaldos manuales, que llevan fecha). ' +
        'El token de Google solo vive en memoria y caduca en ~1 hora; si caduca, se renueva solo con el permiso ya concedido. ' +
        'Al desactivar, la app deja de subir y descargar en el acto; el archivo de la nube se queda en tu Drive hasta que lo borres tú.'));

      var closeRow = el('div', 'modal-actions nube-actions');
      var closeBtn = el('button', 'btn small', 'Cerrar');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', function () { closeOverlay(nubeModal.ov); });
      closeRow.appendChild(closeBtn);
      box.appendChild(closeRow);
    }
    renderStatus();
    openOverlay(nubeModal.ov);
  }

  function setEnabled(on) {
    var cfg = loadConfig();
    cfg.enabled = !!on;
    saveConfig(cfg);
    if (on) { scheduleNext(); }
    else { stopTimer(); }
    renderStatus();
    if (!on) appToast('Sincronización automática desactivada. Ya no se sube ni se descarga nada solo.');
  }

  /* ---------- Botón «☁️ Nube» junto a «☁️ Drive» ---------- */
  function ensureNubeButton() {
    if (!doc) return;
    var anchor = doc.getElementById('btnDrive') || doc.getElementById('btnSync');
    if (!anchor) return;
    if (doc.getElementById('btnNube')) return;
    var btn = el('button', 'btn small', '☁️ Nube');
    btn.id = 'btnNube'; btn.type = 'button';
    btn.title = 'Sincronización automática en la nube (tu Google Drive)';
    btn.addEventListener('click', openNubeModal);
    if (anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else anchor.after(btn);
  }

  function init() {
    if (!doc) return;
    try {
      ensureNubeButton();
      scheduleFirst();
      doc.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && nubeModal) closeOverlay(nubeModal.ov);
      });
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', function () {
          if (doc.hidden) return;
          var cfg = loadConfig();
          if (cfg.enabled && isDue(cfg, Date.now())) runAuto().then(function () { scheduleNext(); });
        });
      }
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[nube] desactivado por error en el inicio:', e);
      }
    }
  }

  /* ================= API pública ================= */
  var api = {
    VERSION: VERSION,
    CLOUD_FILE_NAME: CLOUD_FILE_NAME,
    CLOUD_MIME: CLOUD_MIME,
    INTERVAL_OPTIONS: INTERVAL_OPTIONS,
    DEFAULT_INTERVAL_MINUTES: DEFAULT_INTERVAL_MINUTES,
    LS_CONFIG: LS_CONFIG,
    LS_CLOUD_FILE_ID: LS_CLOUD_FILE_ID,
    defaultConfig: defaultConfig,
    parseConfig: parseConfig,
    serializeConfig: serializeConfig,
    validateInterval: validateInterval,
    formatInterval: formatInterval,
    isDue: isDue,
    nextSyncInMs: nextSyncInMs,
    pickCloudFile: pickCloudFile,
    parseExportedAt: parseExportedAt,
    isRemoteNewer: isRemoteNewer,
    localNewestChange: localNewestChange,
    needsUpload: needsUpload,
    decideAutoApply: decideAutoApply,
    isNotFoundError: isNotFoundError,
    summarizeRun: summarizeRun,
    describeStatus: describeStatus,
    createNubeSync: createNubeSync,
    openNubeModal: openNubeModal,
    setEnabled: setEnabled,
    syncNow: function () { return runManual(); },
    init: init,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try { global.__rpmNube = api; } catch (e) {}
    if (doc) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
