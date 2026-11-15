/* Notas personales por canción para Reproductor de Música — v3.8.0.
   Módulo aparte: NO toca index.html, lyrics.js, karaoke.js,
   traduccion.js ni acordes.js. Se engancha solo a lo que ya existe
   en la app:
     - #nowTitle / #nowArtist (título y artista actuales)
     - #nowAlbum (debajo de él se muestra la nota y el editor)
     - #btnEditCurrent (junto a él va el botón discreto "📝 Notas")
   y guarda la nota con clave propia en localStorage.

   Clave de la nota (este módulo), MISMA normalización que
   lyrics.js (keyFor) y que acordes.js / traduccion.js:
     'reproductor-notas:' + norm(título) + ' — ' + norm(artista)
     donde norm = minúsculas, espacios colapsados, sin extremos,
     y ' — ' es guion largo U+2014 rodeado de espacios.
   Ejemplo: canción "Hola Mundo" de "Artista" →
     'reproductor-notas:hola mundo — artista'.

   Qué hace:
   - Apunte personal de texto libre por canción (recordatorio,
     idea, contexto, lo que el usuario quiera). Texto tal cual lo
     escribe; no hay notas automáticas ni generadas.
   - Sin nota, NO se muestra nada extra: ni caja vacía, ni
     marcador, ni aviso. Solo el botón discreto "📝 Notas" junto a
     "Editar datos", que es la puerta para añadirla.
   - Con nota, se muestra debajo del artista/álbum, con un botón
     "Editar" para cambiarla y otro para quitarla.
   - Sin canción (título "Ninguna canción seleccionada" o artista
     con el texto de arranque de la app), el botón queda
     desactivado y no se muestra nada: el módulo no falla.
   - Sincronización: la nota viaja con el .rpmbak SOLO si se
     aplica el parche de 2 líneas de WIRING.md a rpmReadLyrics /
     rpmWriteLyrics en index.html (las claves de notas usan otro
     prefijo y hoy ese lector solo recoge 'reproductor-letras:',
     'reproductor-letras-traduccion:' y
     'reproductor-letras-acordes:'). Sin ese parche, la nota se
     queda en este dispositivo y el resto del sync sigue
     funcionando igual que antes. La fusión (mergeLyrics en
     app/src/sync/sync-bridge.js) NO necesita cambios: es agnóstica
     a la clave, y package-io.js pasa el mapa `lyrics` opaco.
     El módulo DETECTA si el parche está aplicado (sonda con una
     clave temporal, ver probeSyncPatched) y lo dice claro en la
     vista y en el editor: con parche, "viajará en el .rpmbak";
     sin parche, "solo vive en este dispositivo".
   - A prueba de fallos: cualquier error aquí dentro se traga y la
     app sigue funcionando. Sin red, sin dependencias. Todo el
     texto del usuario se inserta con textContent/value (nunca
     innerHTML), así que una nota no puede romper el DOM.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./notas.css">
     <script src="./notas.js"></script>
     (después de traduccion.js / acordes.js)
   Pruebas Node: node --test notas.test.mjs
   Prueba desde la consola:
     window.__notasKey('Song', 'Artist')
     window.__notasGet('Song', 'Artist')
     window.__notasSyncStatus()   // 'patched' | 'not-patched' | 'unknown'
     window.__notasOpenEditor()   // abrir el editor de la canción actual
*/
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var NOTAS_PREFIX = 'reproductor-notas:';
  var SYNC_PREFIX = 'notas:';
  var PROBE_SUFFIX = '__rpm_notas_probe__';
  var MAX_NOTE_LENGTH = 2000;

  /* Textos exactos que pone la app cuando NO hay canción elegida
     (verificados en app/index.html: #nowTitle/#nowArtist por
     defecto, líneas ~869-870, y render() líneas ~3575-3576). */
  var NO_TRACK_TITLES = ['Ninguna canción seleccionada'];
  var NO_TRACK_ARTISTS = [
    'Añade archivos de audio para empezar',
    'Elige una canción de la biblioteca'
  ];

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* Sufijo común a todas las claves: '<título> — <artista>' normalizado. */
  function suffixFor(title, artist) {
    return norm(title) + ' — ' + norm(artist);
  }

  /* Clave de la nota: prefijo propio, misma base que lyrics.js. */
  function notesKeyFor(title, artist) {
    return NOTAS_PREFIX + suffixFor(title, artist);
  }

  /* ¿Es una clave de notas? / ¿qué sufijo lleva? (null si no cuadra). */
  function isNotesKey(k) {
    return String(k || '').indexOf(NOTAS_PREFIX) === 0;
  }
  function suffixFromNotesKey(k) {
    var s = String(k || '');
    return s.indexOf(NOTAS_PREFIX) === 0 ? s.slice(NOTAS_PREFIX.length) : null;
  }

  /* ¿Hay canción elegida? Sin título/artista reales, o con los
     textos de arranque de la app, NO hay canción: el módulo no
     muestra nada y no falla. */
  function isNoTrack(title, artist) {
    var t = String(title || '').trim();
    var a = String(artist || '').trim();
    if (!t) return true;
    if (NO_TRACK_TITLES.indexOf(t) !== -1) return true;
    if (NO_TRACK_ARTISTS.indexOf(a) !== -1) return true;
    return false;
  }

  /* Limpia el texto libre del usuario: saltos de línea unificados
     (CRLF -> LF), extremos recortados, interior tal cual (se
     respeta el formato que escribió). Límite de 2000 caracteres;
     lo que sobra se recorta al guardar, nunca se rechaza el
     guardado. Vacío o solo espacios -> ''. */
  function sanitizeNote(text) {
    if (text == null) return '';
    var out = String(text).replace(/\r\n?/g, '\n').trim();
    if (out.length > MAX_NOTE_LENGTH) out = out.slice(0, MAX_NOTE_LENGTH);
    return out;
  }

  /* ¿Hay nota guardada con contenido real? Un texto vacío o solo
     con espacios/saltos cuenta como "sin nota". */
  function hasNote(raw) {
    return sanitizeNote(raw) !== '';
  }

  /* Guardar / leer / quitar la nota de una canción. `storage` es
     localStorage o un objeto con getItem/setItem/removeItem (así se
     puede probar en Node). Guardar '' (o solo espacios) BORRA la
     clave: una nota vacía no deja basura en localStorage. Devuelve
     el texto guardado ('' si se borró). */
  function saveNote(storage, title, artist, text) {
    var clean = sanitizeNote(text);
    var key = notesKeyFor(title, artist);
    try {
      if (!clean) storage.removeItem(key);
      else storage.setItem(key, clean);
    } catch (e) { /* sin almacenamiento: no se guarda */ }
    return clean;
  }
  function loadNote(storage, title, artist) {
    var raw = null;
    try { raw = storage.getItem(notesKeyFor(title, artist)); } catch (e) { raw = null; }
    return hasNote(raw) ? sanitizeNote(raw) : null;
  }
  function deleteNote(storage, title, artist) {
    try { storage.removeItem(notesKeyFor(title, artist)); } catch (e) {}
  }

  /* ---- Sincronización (mismo patrón que rpmReadLyrics /
     rpmWriteLyrics en index.html; ver WIRING.md) ----
     collectNotes(storage): { '<título> — <artista>': texto }
     applyNotes(storage, map): escribe cada entrada con el
     prefijo de notas. `storage` es localStorage o un objeto
     con length/key(i)/getItem/setItem (así se puede probar en Node).
     Para viajar en el .rpmbak, el mapa de sync usa la clave
     'notas:<sufijo>' (syncMapKey / suffixFromSyncMapKey). */
  function collectNotes(storage) {
    var out = {};
    try {
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (k && k.indexOf(NOTAS_PREFIX) === 0) {
          out[k.slice(NOTAS_PREFIX.length)] = storage.getItem(k);
        }
      }
    } catch (e) { /* localStorage no disponible: mapa vacío */ }
    return out;
  }

  function applyNotes(storage, map) {
    try {
      Object.keys(map || {}).forEach(function (suffix) {
        storage.setItem(NOTAS_PREFIX + suffix, map[suffix]);
      });
    } catch (e) { /* sin almacenamiento: no se aplica */ }
  }

  /* Clave que usan las notas dentro del mapa `lyrics` del paquete
     .rpmbak (WIRING.md): 'notas:<título> — <artista>'. */
  function syncMapKey(suffix) { return SYNC_PREFIX + suffix; }
  function suffixFromSyncMapKey(k) {
    var s = String(k || '');
    return s.indexOf(SYNC_PREFIX) === 0 ? s.slice(SYNC_PREFIX.length) : null;
  }

  /* Fusión de notas para el sync: MISMA regla documentada
     que mergeLyrics en sync-bridge.js (gana la remota si el paquete
     es más nuevo que el último sync, o si la clave no existe en
     local; en cualquier otro caso se conserva la local). Es
     agnóstica a la clave: vale para letras, traducciones, acordes
     y notas. */
  function mergeNotes(localMap, remoteMap, remoteExportedAt, lastSyncAt) {
    var out = {};
    Object.keys(localMap || {}).forEach(function (k) { out[k] = localMap[k]; });
    var remoteMs = Date.parse(remoteExportedAt || '') || 0;
    Object.keys(remoteMap || {}).forEach(function (k) {
      if (!(k in out) || remoteMs > (lastSyncAt || 0)) out[k] = remoteMap[k];
    });
    return out;
  }

  /* ¿Está aplicado el parche de sync de WIRING.md?
     Sonda real y segura: escribe UNA clave temporal
     ('reproductor-notas:__rpm_notas_probe__'), llama a
     readLyricsFn (en el navegador: window.__rpmApp.readLyrics) y
     mira si el mapa que devuelve trae 'notas:__rpm_notas_probe__'.
     Con el parche, sí; sin él, no. La clave temporal se borra
     siempre (finally), no toque ningún dato del usuario, y la
     sonda no escribe nada en el paquete .rpmbak.
     Devuelve true (parche aplicado), false (probado, no aplicado)
     o null (no se puede probar: no hay readLyricsFn). */
  function probeSyncPatched(storage, readLyricsFn) {
    if (typeof readLyricsFn !== 'function') return null;
    var probeKey = NOTAS_PREFIX + PROBE_SUFFIX;
    try {
      storage.setItem(probeKey, '1');
      var map = readLyricsFn() || {};
      return Object.prototype.hasOwnProperty.call(map, SYNC_PREFIX + PROBE_SUFFIX);
    } catch (e) {
      return null;
    } finally {
      try { storage.removeItem(probeKey); } catch (e) {}
    }
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
    note: null,          // texto de la nota o null si no hay
    editorOpen: false,
    syncPatched: null,   // true | false | null (aún sin sondar)
    syncProbed: false
  };

  function currentTitleArtist() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return { title: t, artist: a };
  }

  function hasTrack() {
    var cur = currentTitleArtist();
    return !isNoTrack(cur.title, cur.artist);
  }

  function loadForCurrentTrack() {
    var cur = currentTitleArtist();
    state.note = hasTrack() ? loadNote(localStorage, cur.title, cur.artist) : null;
    state.trackKey = norm(cur.title) + '|' + norm(cur.artist);
  }

  /* Sonda el parche UNA vez por carga (cuando __rpmApp ya existe;
     si aún no existe, el sondeo lo reintenta hasta que aparece).
     El resultado solo alimenta el texto de estado de la UI. */
  function probeSyncOnce() {
    if (state.syncProbed) return;
    try {
      var app = (typeof window !== 'undefined') ? window.__rpmApp : null;
      if (app && typeof app.readLyrics === 'function') {
        state.syncPatched = probeSyncPatched(localStorage, app.readLyrics);
        state.syncProbed = true;
      }
    } catch (e) { /* la sonda nunca debe romper la app */ }
  }

  /* Texto de estado de sync, según la sonda. Se muestra SOLO
     cuando hay nota visible o el editor abierto (sin nota, nada
     extra): con parche, la nota viajará; sin parche, solo vive en
     este dispositivo. */
  function syncStatusText() {
    if (state.syncPatched === true) return '✓ Esta nota viajará en el .rpmbak al sincronizar.';
    if (state.syncPatched === false) return 'Solo en este dispositivo: para que viaje en el .rpmbak falta el parche de sync (ver WIRING.md).';
    return 'Sincronización: estado sin comprobar (se comprueba solo al cargar).';
  }

  /* Inyecta los controles junto a la canción actual (una sola
     vez). Anclas verificadas en app/index.html:
       - #btnEditCurrent ("Editar datos", en la fila de botones
         bajo #nowAlbum): el botón "📝 Notas" va justo después.
       - #nowAlbum: debajo de él van la vista de la nota y el
         editor (nada de esto existe en la app: lo crea el módulo).
     No se toca #editModal ni ningún otro módulo: todo por DOM. */
  function ensurePlayerUI() {
    var editBtn = $('btnEditCurrent');
    if (editBtn && editBtn.parentNode && !$('notasBtn')) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'notasBtn'; btn.className = 'btn small';
      btn.textContent = '📝 Notas';
      btn.title = 'Apunte personal para esta canción';
      btn.addEventListener('click', function () {
        if (state.editorOpen) closeEditor(); else openEditor();
      });
      editBtn.parentNode.insertBefore(btn, editBtn.nextSibling);
    }
    var album = $('nowAlbum');
    if (album && album.parentNode && !$('notasView')) {
      var view = document.createElement('div');
      view.id = 'notasView'; view.className = 'notas-view'; view.hidden = true;
      var label = document.createElement('p');
      label.className = 'notas-label'; label.textContent = '📝 Nota personal';
      view.appendChild(label);
      var text = document.createElement('p');
      text.id = 'notasText'; text.className = 'notas-text';
      view.appendChild(text);
      var row = document.createElement('div');
      row.className = 'notas-view-row';
      var edit = document.createElement('button');
      edit.type = 'button'; edit.id = 'notasViewEdit'; edit.className = 'btn small';
      edit.textContent = 'Editar';
      edit.addEventListener('click', openEditor);
      row.appendChild(edit);
      var del = document.createElement('button');
      del.type = 'button'; del.id = 'notasViewDelete'; del.className = 'btn small';
      del.textContent = 'Quitar nota';
      del.addEventListener('click', deleteCurrentNote);
      row.appendChild(del);
      view.appendChild(row);
      var sync = document.createElement('p');
      sync.id = 'notasSync'; sync.className = 'notas-sync';
      view.appendChild(sync);
      album.parentNode.insertBefore(view, album.nextSibling);

      var ed = document.createElement('div');
      ed.id = 'notasEditor'; ed.className = 'notas-editor'; ed.hidden = true;
      var hint = document.createElement('p');
      hint.className = 'notas-editor-hint';
      hint.textContent = 'Apunte personal para esta canción (recordatorio, idea, contexto…). Solo tú lo ves; no se comparte ni se genera nada solo.';
      ed.appendChild(hint);
      var ta = document.createElement('textarea');
      ta.id = 'notasTextArea'; ta.className = 'notas-textarea';
      ta.setAttribute('aria-label', 'Nota personal para esta canción');
      ta.placeholder = 'Escribe tu apunte aquí…';
      ta.maxLength = MAX_NOTE_LENGTH;
      ta.addEventListener('input', updateCount);
      ed.appendChild(ta);
      var edRow = document.createElement('div');
      edRow.className = 'notas-editor-row';
      var save = document.createElement('button');
      save.type = 'button'; save.id = 'notasSave'; save.className = 'notas-save';
      save.textContent = 'Guardar nota';
      save.addEventListener('click', saveEditor);
      edRow.appendChild(save);
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.id = 'notasCancel';
      cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', closeEditor);
      edRow.appendChild(cancel);
      var del2 = document.createElement('button');
      del2.type = 'button'; del2.id = 'notasDelete';
      del2.textContent = 'Quitar nota';
      del2.addEventListener('click', deleteCurrentNote);
      edRow.appendChild(del2);
      var count = document.createElement('span');
      count.id = 'notasCount'; count.className = 'notas-count';
      edRow.appendChild(count);
      ed.appendChild(edRow);
      var syncHint = document.createElement('p');
      syncHint.id = 'notasSyncHint'; syncHint.className = 'notas-sync';
      ed.appendChild(syncHint);
      view.parentNode.insertBefore(ed, view.nextSibling);
    }
  }

  function updateCount() {
    var ta = $('notasTextArea'); var count = $('notasCount');
    if (ta && count) count.textContent = ta.value.length + ' / ' + MAX_NOTE_LENGTH;
  }

  function refreshUI() {
    var btn = $('notasBtn');
    var view = $('notasView');
    var ed = $('notasEditor');
    var ok = hasTrack();
    if (btn) btn.disabled = !ok;
    if (view) {
      var showView = ok && !!state.note && !state.editorOpen;
      view.hidden = !showView;
      if (showView) {
        var text = $('notasText');
        if (text) text.textContent = state.note;
        var sync = $('notasSync');
        if (sync) sync.textContent = syncStatusText();
      }
    }
    if (ed) {
      ed.hidden = !state.editorOpen;
      if (state.editorOpen) {
        var hint = $('notasSyncHint');
        if (hint) hint.textContent = syncStatusText();
        updateCount();
      }
    }
  }

  function openEditor() {
    if (!hasTrack()) return;
    ensurePlayerUI();
    var ed = $('notasEditor'); if (!ed) return;
    var ta = $('notasTextArea');
    if (ta) ta.value = state.note || '';
    state.editorOpen = true;
    ed.hidden = false;
    refreshUI();
    if (ta) ta.focus();
  }

  function closeEditor() {
    var ed = $('notasEditor'); if (ed) ed.hidden = true;
    state.editorOpen = false;
    refreshUI();
  }

  function saveEditor() {
    var ta = $('notasTextArea'); if (!ta) return;
    var cur = currentTitleArtist();
    if (isNoTrack(cur.title, cur.artist)) { closeEditor(); return; }
    state.note = saveNote(localStorage, cur.title, cur.artist, ta.value) || null;
    loadForCurrentTrack();
    closeEditor();
  }

  function deleteCurrentNote() {
    var cur = currentTitleArtist();
    if (!isNoTrack(cur.title, cur.artist)) deleteNote(localStorage, cur.title, cur.artist);
    loadForCurrentTrack();
    closeEditor();
  }

  function tick() {
    try {
      probeSyncOnce();
      ensurePlayerUI();
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
    // igual que hacen lyrics.js, karaoke.js, traduccion.js y acordes.js.
    try {
      var hasCss = !!document.querySelector('link[href*="notas.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './notas.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try { probeSyncOnce(); } catch (e) {}
    try { loadForCurrentTrack(); } catch (e) {}
    // Mismo sondeo de 600 ms que lyrics.js, karaoke.js,
    // traduccion.js y acordes.js: detecta el cambio de canción y
    // la aparición de los anclajes, y repone la UI cada vez que la
    // app re-renderiza.
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
      suffixFor: suffixFor,
      notesKeyFor: notesKeyFor,
      isNotesKey: isNotesKey,
      suffixFromNotesKey: suffixFromNotesKey,
      isNoTrack: isNoTrack,
      sanitizeNote: sanitizeNote,
      hasNote: hasNote,
      saveNote: saveNote,
      loadNote: loadNote,
      deleteNote: deleteNote,
      collectNotes: collectNotes,
      applyNotes: applyNotes,
      syncMapKey: syncMapKey,
      suffixFromSyncMapKey: suffixFromSyncMapKey,
      mergeNotes: mergeNotes,
      probeSyncPatched: probeSyncPatched,
      NOTAS_PREFIX: NOTAS_PREFIX,
      SYNC_PREFIX: SYNC_PREFIX,
      PROBE_SUFFIX: PROBE_SUFFIX,
      MAX_NOTE_LENGTH: MAX_NOTE_LENGTH,
      NO_TRACK_TITLES: NO_TRACK_TITLES,
      NO_TRACK_ARTISTS: NO_TRACK_ARTISTS
    };
  }
  if (typeof window !== 'undefined') {
    window.__notasKey = notesKeyFor;
    window.__notasGet = function (title, artist) {
      try { return loadNote(localStorage, title, artist); } catch (e) { return null; }
    };
    window.__notasSave = function (title, artist, text) {
      try { return saveNote(localStorage, title, artist, text); } catch (e) { return ''; }
    };
    window.__notasHas = hasNote;
    window.__notasCollect = collectNotes;
    window.__notasApply = applyNotes;
    window.__notasMerge = mergeNotes;
    window.__notasSyncStatus = function () {
      if (state.syncPatched === true) return 'patched';
      if (state.syncPatched === false) return 'not-patched';
      return 'unknown';
    };
    window.__notasProbeSync = function () {
      try {
        state.syncProbed = false;
        probeSyncOnce();
        refreshUI();
        return window.__notasSyncStatus();
      } catch (e) { return 'unknown'; }
    };
    window.__notasOpenEditor = function () { try { openEditor(); } catch (e) {} };
  }
})();
