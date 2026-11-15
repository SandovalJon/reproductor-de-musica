/* Acordes de guitarra para Reproductor de Música — v3.6.0.
   Módulo aparte: NO toca index.html, lyrics.js, karaoke.js ni
   traduccion.js. Se engancha solo a lo que ya existe en la app:
     - #nowTitle / #nowArtist (título y artista actuales)
     - #lyricsPanel / #lyricsLines / .lyrics-line (panel de letras)
     - #karaokeView / #karaokeLines / .karaoke-line (modo karaoke)
   y lee la letra de la MISMA clave de localStorage que lyrics.js.

   Clave base (EXACTA, verificada en app/lyrics.js y app/karaoke.js):
     'reproductor-letras:' + norm(título) + ' — ' + norm(artista)
     donde norm = minúsculas, espacios colapsados, sin extremos,
     y ' — ' es guion largo U+2014 rodeado de espacios.
   Clave de acordes (este módulo): MISMA base, otro prefijo:
     'reproductor-letras-acordes:' + norm(título) + ' — ' + norm(artista)

   Qué hace:
   - En el panel de letras y en karaoke, muestra los acordes ENCIMA
     de su línea de letra (un acorde —o varios— por línea, en el
     mismo orden), con un botón 🎸 Acordes para mostrarlos u
     ocultarlos.
   - Editor sencillo en el panel de letras: una línea de acordes
     por cada línea de la letra original, en el mismo orden. El
     usuario los escribe o los pega tal cual; se guardan sin tocar
     la letra original ni la traducción.
   - NO hay acordes automáticos: sin acordes guardados, NO se
     muestra ningún acorde inventado, solo un aviso claro para
     añadirlos. No hay detección de audio, ni diccionarios, ni
     nada generado.
   - Sin letra, nada cambia: el módulo no aparece (botones
     desactivados) y el panel/karaoke se comportan como antes.
   - Sincronización: los acordes viajan con el .rpmbak SOLO si se
     aplica el parche de 2 líneas de WIRING.md a rpmReadLyrics /
     rpmWriteLyrics en index.html (las claves de acordes usan otro
     prefijo y hoy ese lector solo recoge 'reproductor-letras:' y
     'reproductor-letras-traduccion:'). Sin ese parche, los acordes
     se quedan en este dispositivo y el resto del sync sigue
     funcionando igual que antes. La fusión (mergeLyrics en
     app/src/sync/sync-bridge.js) NO necesita cambios: es agnóstica
     a la clave, y package-io.js pasa el mapa `lyrics` opaco.
   - A prueba de fallos: cualquier error aquí dentro se traga y la
     app sigue funcionando. Sin red, sin dependencias. Todo el texto
     del usuario se inserta con textContent/value (nunca innerHTML),
     así que unos acordes no pueden romper el DOM.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./acordes.css">
     <script src="./acordes.js"></script>
     (después de lyrics.js, karaoke.js y traduccion.js)
   Pruebas Node: node --test acordes.test.mjs
   Prueba desde la consola:
     window.__acordesPair([{t:5,text:'Hello'}], 'C  G')
     window.__acordesKey('Song', 'Artist') */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var LYRICS_PREFIX = 'reproductor-letras:';
  var CHORDS_PREFIX = 'reproductor-letras-acordes:';
  var SHOW_FLAG_KEY = 'reproductor-acordes-visible'; // '1' | '0'

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* Sufijo común a todas las claves: '<título> — <artista>' normalizado. */
  function suffixFor(title, artist) {
    return norm(title) + ' — ' + norm(artist);
  }

  /* Clave EXACTA de lyrics.js. */
  function keyFor(title, artist) {
    return LYRICS_PREFIX + suffixFor(title, artist);
  }

  /* Clave de acordes: misma base, prefijo distinto. */
  function chordsKeyFor(title, artist) {
    return CHORDS_PREFIX + suffixFor(title, artist);
  }

  /* De una clave base de letra a su clave de acordes (o null si
     la clave dada no es una clave base de letra). */
  function chordsKeyForBaseKey(baseKey) {
    var k = String(baseKey || '');
    if (k.indexOf(LYRICS_PREFIX) !== 0) return null;
    return CHORDS_PREFIX + k.slice(LYRICS_PREFIX.length);
  }

  /* De una clave de acordes a su clave base (o null). */
  function baseKeyForChordsKey(chKey) {
    var k = String(chKey || '');
    if (k.indexOf(CHORDS_PREFIX) !== 0) return null;
    return LYRICS_PREFIX + k.slice(CHORDS_PREFIX.length);
  }

  /* Parser LRC, misma semántica que lyrics.js: [mm:ss.xx] texto,
     varias marcas por línea, [offset:+500], se ignoran las etiquetas
     de metadatos ([ti:], [ar:]...). Sin marcas de tiempo, las líneas
     de texto se devuelven como letra sin sincronizar (synced:false).
     Copia local (no depende del orden de carga de lyrics.js). */
  function parseLRC(text) {
    var lines = [], offset = 0, plain = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/^\uFEFF/, '');
      var mOff = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
      if (mOff) { offset = parseInt(mOff[1], 10) || 0; return; }
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      var times = [], rest = line;
      var m;
      var re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
      while ((m = re.exec(line)) !== null) {
        var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        var frac = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0;
        times.push(sec + frac);
      }
      rest = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      if (times.length) {
        times.forEach(function (t) { lines.push({ t: t + offset / 1000, text: rest || '♪' }); });
      } else if (rest) { plain.push(rest); }
    });
    lines.sort(function (a, b) { return a.t - b.t; });
    if (!lines.length && plain.length) {
      return { synced: false, lines: plain.map(function (p) { return { t: 0, text: p }; }) };
    }
    return { synced: lines.length > 0, lines: lines };
  }

  /* Texto de acordes -> lista de líneas (una por renglón).
     Se colapsan los espacios internos (los acordes se separan con
     un solo espacio) y se recortan los extremos; las líneas vacías
     se conservan como '' (línea sin acordes). No se valida ni se
     corrige nada: lo que escribe el usuario, tal cual. */
  function parseChordsText(text) {
    if (text == null) return [];
    return String(text).split(/\r?\n/).map(function (ln) {
      return ln.replace(/\s+/g, ' ').trim();
    });
  }

  /* Quita las líneas vacías del final (no aportan nada y ensucian
     lo guardado); las vacías del medio se conservan, porque marcan
     la posición de una línea sin acordes. */
  function trimTrailingEmpty(lines) {
    var out = (lines || []).slice();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  /* Lista de líneas -> texto guardable en localStorage. */
  function serializeChords(lines) {
    return trimTrailingEmpty(lines || []).join('\n');
  }

  /* Empareja original con acordes por ÍNDICE: la línea de acordes
     n corresponde a la línea original n. Nunca inventa nada: sin
     acordes para una línea, chords es ''.
     Las líneas de acordes que sobran (más que la letra) se ignoran
     al mostrar; se conservan al guardar por si la letra cambia
     después. */
  function pairLines(originalLines, chordsText) {
    var ch = parseChordsText(chordsText);
    return (originalLines || []).map(function (ln, i) {
      return { t: ln.t, original: ln.text, chords: ch[i] || '' };
    });
  }

  /* ¿Cuántas líneas tienen acordes no vacíos? */
  function countWithChords(pairs) {
    var n = 0;
    (pairs || []).forEach(function (p) { if (p && String(p.chords || '').trim()) n++; });
    return n;
  }

  /* ¿Hay acordes guardados con contenido real? Un texto vacío
     o solo con líneas en blanco cuenta como "sin acordes". */
  function hasChords(raw) {
    if (raw == null) return false;
    return parseChordsText(raw).some(function (ln) { return ln !== ''; });
  }

  /* ---- Sincronización (mismo patrón que rpmReadLyrics /
     rpmWriteLyrics en index.html; ver WIRING.md) ----
     collectChords(storage): { '<título> — <artista>': texto }
     applyChords(storage, map): escribe cada entrada con el
     prefijo de acordes. `storage` es localStorage o un objeto
     con length/key(i)/getItem/setItem (así se puede probar en Node).
     Para viajar en el .rpmbak, el mapa de sync usa la clave
     'acordes:<sufijo>' (syncMapKey / suffixFromSyncMapKey). */
  function collectChords(storage) {
    var out = {};
    try {
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (k && k.indexOf(CHORDS_PREFIX) === 0) {
          out[k.slice(CHORDS_PREFIX.length)] = storage.getItem(k);
        }
      }
    } catch (e) { /* localStorage no disponible: mapa vacío */ }
    return out;
  }

  function applyChords(storage, map) {
    try {
      Object.keys(map || {}).forEach(function (suffix) {
        storage.setItem(CHORDS_PREFIX + suffix, map[suffix]);
      });
    } catch (e) { /* sin almacenamiento: no se aplica */ }
  }

  /* Clave que usan los acordes dentro del mapa `lyrics` del paquete
     .rpmbak (WIRING.md): 'acordes:<título> — <artista>'. */
  function syncMapKey(suffix) { return 'acordes:' + suffix; }
  function suffixFromSyncMapKey(k) {
    var s = String(k || '');
    return s.indexOf('acordes:') === 0 ? s.slice('acordes:'.length) : null;
  }

  /* Fusión de acordes para el sync: MISMA regla documentada
     que mergeLyrics en sync-bridge.js (gana la remota si el paquete
     es más nuevo que el último sync, o si la clave no existe en
     local; en cualquier otro caso se conserva la local). Es
     agnóstica a la clave: vale para letras, traducciones y acordes. */
  function mergeChords(localMap, remoteMap, remoteExportedAt, lastSyncAt) {
    var out = {};
    Object.keys(localMap || {}).forEach(function (k) { out[k] = localMap[k]; });
    var remoteMs = Date.parse(remoteExportedAt || '') || 0;
    Object.keys(remoteMap || {}).forEach(function (k) {
      if (!(k in out) || remoteMs > (lastSyncAt || 0)) out[k] = remoteMap[k];
    });
    return out;
  }

  /* ================= Pegamento con el navegador ================= */

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  var state = {
    trackKey: '',        // norm(título)|norm(artista) de lo cargado
    original: null,      // { synced, lines } o null si no hay letra
    chords: null,        // lista de líneas (strings) o null si no hay
    show: true,          // mostrar acordes (persistente)
    editorOpen: false
  };

  function currentTitleArtist() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return { title: t, artist: a };
  }

  function loadForCurrentTrack() {
    var cur = currentTitleArtist();
    var rawLyrics = storageGet(keyFor(cur.title, cur.artist));
    state.original = rawLyrics ? parseLRC(rawLyrics) : null;
    if (state.original && !state.original.lines.length) state.original = null;
    var rawCh = storageGet(chordsKeyFor(cur.title, cur.artist));
    state.chords = hasChords(rawCh) ? parseChordsText(rawCh) : null;
    state.trackKey = norm(cur.title) + '|' + norm(cur.artist);
  }

  /* Pares original/acordes para la canción actual ([] si no hay
     letra; chords '' en cada línea si no hay acordes). */
  function currentPairs() {
    if (!state.original) return [];
    return pairLines(state.original.lines, (state.chords || []).join('\n'));
  }

  /* Inyecta (o actualiza, o quita) el <span class="acordes-line">
     como PRIMER hijo de cada botón de línea, es decir, ENCIMA de
     la letra. Idempotente: si el span ya tiene el texto correcto,
     no toca el DOM. No rompe los botones de lyrics.js/karaoke.js ni
     el span de traducción (que va al final): el clic en el span
     burbujea al botón y el salto de tiempo sigue funcionando; la
     visibilidad la decide el CSS con la clase .acordes-visible del
     contenedor. */
  function syncSpans(box, lineClass) {
    if (!box) return;
    var pairs = currentPairs();
    var btns = box.querySelectorAll('.' + lineClass);
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var want = (pairs[i] && pairs[i].chords) || '';
      var span = btn.querySelector('.acordes-line');
      if (!want) {
        if (span) btn.removeChild(span);
      } else if (!span) {
        span = document.createElement('span');
        span.className = 'acordes-line';
        span.textContent = want;
        btn.insertBefore(span, btn.firstChild);
      } else {
        if (span.textContent !== want) span.textContent = want;
        // Por si otro módulo o un re-render lo movió, que vuelva arriba.
        if (btn.firstChild !== span) btn.insertBefore(span, btn.firstChild);
      }
    }
    box.classList.toggle('acordes-visible', state.show);
  }

  /* Aviso "sin acordes" dentro del karaoke (un <p> al final de
     #karaokeLines). Idempotente; karaoke.js lo borra al re-renderizar
     y el sondeo lo vuelve a poner. */
  function syncKaraokeNotice() {
    var box = $('karaokeLines'); if (!box) return;
    var note = box.querySelector('.acordes-aviso-karaoke');
    var show = !!state.original && !state.chords;
    if (!show) { if (note) box.removeChild(note); return; }
    if (!note) {
      note = document.createElement('p');
      note.className = 'karaoke-hint acordes-aviso-karaoke';
      note.textContent = 'Sin acordes guardados para esta canción. Añádelos desde el botón ♪ Letras.';
      box.appendChild(note);
    }
  }

  function refreshUI() {
    var hasLyrics = !!state.original;
    var hasCh = !!state.chords;
    var pairs = currentPairs();
    var done = countWithChords(pairs), total = pairs.length;

    var toggle = $('acordesToggle');
    if (toggle) {
      toggle.disabled = !hasCh;
      toggle.classList.toggle('active', state.show && hasCh);
      toggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
      toggle.title = !hasCh ? 'Sin acordes guardados para esta canción'
        : (state.show ? 'Ocultar los acordes' : 'Mostrar los acordes');
    }
    var editBtn = $('acordesEditBtn');
    if (editBtn) {
      editBtn.disabled = !hasLyrics;
      editBtn.textContent = hasCh ? '🎸 Editar acordes' : '🎸 Añadir acordes';
      editBtn.title = !hasLyrics ? 'Primero carga la letra de la canción'
        : (hasCh ? 'Editar los acordes guardados' : 'Escribir los acordes, línea por línea');
    }
    var aviso = $('acordesAviso');
    if (aviso) {
      aviso.hidden = !(hasLyrics && !hasCh && !state.editorOpen);
    }
    var count = $('acordesCount');
    if (count) {
      count.textContent = hasCh ? (done + ' de ' + total + ' líneas con acordes') : '';
    }
    var kToggle = $('acordesKaraokeToggle');
    if (kToggle) {
      kToggle.hidden = !hasCh;
      kToggle.classList.toggle('active', state.show && hasCh);
      kToggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
    }
    syncSpans($('lyricsLines'), 'lyrics-line');
    syncSpans($('karaokeLines'), 'karaoke-line');
    syncKaraokeNotice();
  }

  function openEditor() {
    var ed = $('acordesEditor'); if (!ed || !state.original) return;
    var ta = $('acordesText');
    if (ta) {
      var lines = (state.chords || []).slice();
      while (lines.length < state.original.lines.length) lines.push('');
      ta.value = lines.join('\n');
      ta.disabled = false;
    }
    var hint = $('acordesEditorHint');
    if (hint) hint.textContent = 'Una línea de acordes por cada línea de la letra original (' +
      state.original.lines.length + ' líneas), en el mismo orden. Escribe los acordes de esa línea, ' +
      'separados por espacios (por ejemplo: C  G  Am  F). Deja en blanco la línea que no lleve acordes. ' +
      'No se genera nada automáticamente: solo se guarda lo que escribas.';
    var del = $('acordesDelete');
    if (del) del.hidden = !state.chords;
    state.editorOpen = true;
    ed.hidden = false;
    refreshUI();
    if (ta) ta.focus();
  }

  function closeEditor() {
    var ed = $('acordesEditor'); if (ed) ed.hidden = true;
    state.editorOpen = false;
    refreshUI();
  }

  function saveEditor() {
    var ta = $('acordesText'); if (!ta) return;
    var cur = currentTitleArtist();
    var text = serializeChords(parseChordsText(ta.value));
    if (!text) storageRemove(chordsKeyFor(cur.title, cur.artist));
    else storageSet(chordsKeyFor(cur.title, cur.artist), text);
    loadForCurrentTrack();
    closeEditor();
  }

  function deleteChords() {
    var cur = currentTitleArtist();
    storageRemove(chordsKeyFor(cur.title, cur.artist));
    loadForCurrentTrack();
    closeEditor();
  }

  function toggleShow() {
    state.show = !state.show;
    storageSet(SHOW_FLAG_KEY, state.show ? '1' : '0');
    refreshUI();
  }

  /* Inyecta los controles en el panel de letras (una sola vez).
     El panel lo construye lyrics.js; si aún no existe, el sondeo
     reintenta. No se toca nada de lyrics.js ni de traduccion.js:
     solo se añaden botones. Si traduccion.js también está cargado,
     sus botones y su editor conviven con estos (mismos ganchos,
     ids distintos). */
  function ensureLyricsUI() {
    var panel = $('lyricsPanel'); if (!panel) return;
    var actions = panel.querySelector('.lyrics-actions');
    if (actions && !$('acordesToggle')) {
      var toggle = document.createElement('button');
      toggle.type = 'button'; toggle.id = 'acordesToggle';
      toggle.textContent = '🎸 Acordes';
      toggle.addEventListener('click', toggleShow);
      actions.appendChild(toggle);

      var edit = document.createElement('button');
      edit.type = 'button'; edit.id = 'acordesEditBtn';
      edit.textContent = '🎸 Añadir acordes';
      edit.addEventListener('click', function () {
        if (state.editorOpen) closeEditor(); else openEditor();
      });
      actions.appendChild(edit);
    }
    var lines = $('lyricsLines');
    if (lines && !$('acordesEditor')) {
      var ed = document.createElement('div');
      ed.id = 'acordesEditor'; ed.className = 'acordes-editor'; ed.hidden = true;
      var hint = document.createElement('p');
      hint.id = 'acordesEditorHint'; hint.className = 'acordes-editor-hint';
      ed.appendChild(hint);
      var ta = document.createElement('textarea');
      ta.id = 'acordesText'; ta.className = 'acordes-text';
      ta.setAttribute('aria-label', 'Acordes de guitarra, una línea por cada línea de la letra');
      ta.placeholder = 'C  G  Am  F\nAm  G  C';
      ed.appendChild(ta);
      var row = document.createElement('div');
      row.className = 'acordes-editor-row';
      var save = document.createElement('button');
      save.type = 'button'; save.id = 'acordesSave'; save.className = 'acordes-save';
      save.textContent = 'Guardar acordes';
      save.addEventListener('click', saveEditor);
      row.appendChild(save);
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.id = 'acordesCancel';
      cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', closeEditor);
      row.appendChild(cancel);
      var del = document.createElement('button');
      del.type = 'button'; del.id = 'acordesDelete';
      del.textContent = 'Quitar acordes';
      del.addEventListener('click', deleteChords);
      row.appendChild(del);
      var count = document.createElement('span');
      count.id = 'acordesCount'; count.className = 'acordes-count';
      row.appendChild(count);
      ed.appendChild(row);
      lines.parentNode.insertBefore(ed, lines);

      var aviso = document.createElement('p');
      aviso.id = 'acordesAviso'; aviso.className = 'acordes-aviso'; aviso.hidden = true;
      var avisoText = document.createElement('span');
      avisoText.textContent = 'Sin acordes guardados para esta canción. ';
      aviso.appendChild(avisoText);
      var avisoBtn = document.createElement('button');
      avisoBtn.type = 'button'; avisoBtn.textContent = 'Añadir acordes';
      avisoBtn.addEventListener('click', openEditor);
      aviso.appendChild(avisoBtn);
      lines.parentNode.insertBefore(aviso, lines);
    }
  }

  /* Botón 🎸 en la barra superior del karaoke (una sola vez). El
     editor vive solo en el panel de letras; aquí solo se muestra u
     ocultan los acordes. Sin tocar karaoke.js: por DOM. */
  function ensureKaraokeUI() {
    var view = $('karaokeView'); if (!view) return;
    var top = view.querySelector('.karaoke-top');
    var closeBtn = $('karaokeClose');
    if (top && closeBtn && !$('acordesKaraokeToggle')) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'acordesKaraokeToggle';
      btn.className = 'karaoke-close acordes-karaoke-toggle';
      btn.textContent = '🎸';
      btn.title = 'Mostrar u ocultar los acordes';
      btn.setAttribute('aria-label', 'Mostrar u ocultar los acordes');
      btn.addEventListener('click', toggleShow);
      top.insertBefore(btn, closeBtn);
    }
  }

  function tick() {
    try {
      ensureLyricsUI();
      ensureKaraokeUI();
      var cur = currentTitleArtist();
      var tk = norm(cur.title) + '|' + norm(cur.artist);
      if (tk !== state.trackKey) {
        loadForCurrentTrack();
        if (state.editorOpen) closeEditor(); else refreshUI();
      } else {
        refreshUI();
      }
    } catch (e) { /* el sondeo nunca debe romper la app */ }
  }

  function buildUI() {
    // CSS: el <link> de WIRING.md es la vía principal; si falta
    // (o si el módulo se carga solo), se inyecta aquí como respaldo,
    // igual que hacen lyrics.js, karaoke.js y traduccion.js.
    try {
      var hasCss = !!document.querySelector('link[href*="acordes.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './acordes.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try {
      var flag = storageGet(SHOW_FLAG_KEY);
      state.show = flag !== '0'; // por defecto, mostrar si hay acordes
    } catch (e) {}
    try { loadForCurrentTrack(); } catch (e) {}
    // Mismo sondeo de 600 ms que lyrics.js, karaoke.js y
    // traduccion.js: detecta el cambio de canción y la aparición
    // del panel/vista, y repone los spans cada vez que lyrics.js o
    // karaoke.js re-renderizan.
    setInterval(tick, 600);
    tick();
  }

  /* Solo navegador: sin document no hay nada que montar (Node). */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      norm: norm,
      keyFor: keyFor,
      chordsKeyFor: chordsKeyFor,
      chordsKeyForBaseKey: chordsKeyForBaseKey,
      baseKeyForChordsKey: baseKeyForChordsKey,
      suffixFor: suffixFor,
      parseLRC: parseLRC,
      parseChordsText: parseChordsText,
      serializeChords: serializeChords,
      trimTrailingEmpty: trimTrailingEmpty,
      pairLines: pairLines,
      countWithChords: countWithChords,
      hasChords: hasChords,
      collectChords: collectChords,
      applyChords: applyChords,
      syncMapKey: syncMapKey,
      suffixFromSyncMapKey: suffixFromSyncMapKey,
      mergeChords: mergeChords,
      LYRICS_PREFIX: LYRICS_PREFIX,
      CHORDS_PREFIX: CHORDS_PREFIX,
      SHOW_FLAG_KEY: SHOW_FLAG_KEY
    };
  }
  if (typeof window !== 'undefined') {
    window.__acordesKey = keyFor;
    window.__acordesChordsKey = chordsKeyFor;
    window.__acordesParse = parseLRC;
    window.__acordesPair = pairLines;
    window.__acordesHas = hasChords;
    window.__acordesCollect = collectChords;
    window.__acordesApply = applyChords;
    window.__acordesMerge = mergeChords;
    window.__acordesToggle = function () { try { toggleShow(); } catch (e) {} };
    window.__acordesOpenEditor = function () { try { openEditor(); } catch (e) {} };
  }
})();
