/* Letras traducidas para Reproductor de Música — v3.4.0.
   Módulo aparte: NO toca index.html, lyrics.js ni karaoke.js.
   Se engancha solo a lo que ya existe en la app:
     - #nowTitle / #nowArtist (título y artista actuales)
     - #lyricsPanel / #lyricsLines / .lyrics-line (panel de letras)
     - #karaokeView / #karaokeLines / .karaoke-line (modo karaoke)
   y lee la letra de la MISMA clave de localStorage que lyrics.js.

   Clave base (EXACTA, verificada en app/lyrics.js y app/karaoke.js):
     'reproductor-letras:' + norm(título) + ' — ' + norm(artista)
     donde norm = minúsculas, espacios colapsados, sin extremos,
     y ' — ' es guion largo U+2014 rodeado de espacios.
   Clave de traducción (este módulo): MISMA base, otro prefijo:
     'reproductor-letras-traduccion:' + norm(título) + ' — ' + norm(artista)

   Qué hace:
   - En el panel de letras y en karaoke, muestra cada línea traducida
     debajo de su línea original (lado a lado vertical), con un botón
     🌐 Traducción para mostrarla u ocultarla.
   - Editor sencillo en el panel de letras: una línea de traducción
     por cada línea de la letra original, en el mismo orden. Se guarda
     tal cual la escribe el usuario, sin tocar la letra original.
   - Sin traducción guardada, NO se muestra ninguna traducción: solo
     un aviso claro para añadirla. No hay traducción automática, ni
     diccionarios, ni nada inventado.
   - Sin letra, nada cambia: el módulo no aparece (botones
     desactivados) y el panel/karaoke se comportan como antes.
   - Sincronización: la traducción viaja con el .rpmbak SOLO si se
     aplica el parche de 6 líneas de WIRING.md a rpmReadLyrics /
     rpmWriteLyrics en index.html (las claves de traducción usan otro
     prefijo y hoy ese lector solo recoge 'reproductor-letras:').
     Sin ese parche, la traducción se queda en este dispositivo y
     la sincronización de letras sigue funcionando igual que antes.
   - A prueba de fallos: cualquier error aquí dentro se traga y la
     app sigue funcionando. Sin red, sin dependencias. Todo el texto
     del usuario se inserta con textContent/value (nunca innerHTML),
     así que una traducción no puede romper el DOM.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./traduccion.css">
     <script src="./traduccion.js"></script>
     (después de lyrics.js y karaoke.js)
   Pruebas Node: node --test traduccion.test.mjs
   Prueba desde la consola:
     window.__traduccionPair([{t:5,text:'Hello'}], 'Hola')
     window.__traduccionKey('Song', 'Artist') */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var LYRICS_PREFIX = 'reproductor-letras:';
  var TRANSLATION_PREFIX = 'reproductor-letras-traduccion:';
  var SHOW_FLAG_KEY = 'reproductor-traduccion-visible'; // '1' | '0'

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* Sufijo común a ambas claves: '<título> — <artista>' normalizado. */
  function suffixFor(title, artist) {
    return norm(title) + ' — ' + norm(artist);
  }

  /* Clave EXACTA de lyrics.js. */
  function keyFor(title, artist) {
    return LYRICS_PREFIX + suffixFor(title, artist);
  }

  /* Clave de traducción: misma base, prefijo distinto. */
  function translationKeyFor(title, artist) {
    return TRANSLATION_PREFIX + suffixFor(title, artist);
  }

  /* De una clave base de letra a su clave de traducción (o null si
     la clave dada no es una clave base de letra). */
  function translationKeyForBaseKey(baseKey) {
    var k = String(baseKey || '');
    if (k.indexOf(LYRICS_PREFIX) !== 0) return null;
    return TRANSLATION_PREFIX + k.slice(LYRICS_PREFIX.length);
  }

  /* De una clave de traducción a su clave base (o null). */
  function baseKeyForTranslationKey(trKey) {
    var k = String(trKey || '');
    if (k.indexOf(TRANSLATION_PREFIX) !== 0) return null;
    return LYRICS_PREFIX + k.slice(TRANSLATION_PREFIX.length);
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

  /* Texto de traducción -> lista de líneas (una por renglón).
     Se recorta el espacio de los extremos de cada línea; las líneas
     vacías se conservan como '' (línea sin traducir). */
  function parseTranslationText(text) {
    if (text == null) return [];
    return String(text).split(/\r?\n/).map(function (ln) { return ln.trim(); });
  }

  /* Quita las líneas vacías del final (no aportan nada y ensucian
     lo guardado); las vacías del medio se conservan, porque marcan
     la posición de una línea sin traducir. */
  function trimTrailingEmpty(lines) {
    var out = (lines || []).slice();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  /* Lista de líneas -> texto guardable en localStorage. */
  function serializeTranslation(lines) {
    return trimTrailingEmpty(lines || []).join('\n');
  }

  /* Empareja original con traducción por ÍNDICE: la línea de
     traducción n corresponde a la línea original n. Nunca inventa
     nada: sin traducción para una línea, translation es ''.
     Las líneas de traducción que sobran (más que la letra) se
     ignoran al mostrar; se conservan al guardar por si la letra
     cambia después. */
  function pairLines(originalLines, translationText) {
    var tr = parseTranslationText(translationText);
    return (originalLines || []).map(function (ln, i) {
      return { t: ln.t, original: ln.text, translation: tr[i] || '' };
    });
  }

  /* ¿Cuántas líneas tienen traducción no vacía? */
  function countTranslated(pairs) {
    var n = 0;
    (pairs || []).forEach(function (p) { if (p && String(p.translation || '').trim()) n++; });
    return n;
  }

  /* ¿Hay una traducción guardada con contenido real? Un texto vacío
     o solo con líneas en blanco cuenta como "sin traducción". */
  function hasTranslation(raw) {
    if (raw == null) return false;
    return parseTranslationText(raw).some(function (ln) { return ln !== ''; });
  }

  /* ---- Sincronización (mismo patrón que rpmReadLyrics /
     rpmWriteLyrics en index.html; ver WIRING.md) ----
     collectTranslations(storage): { '<título> — <artista>': texto }
     applyTranslations(storage, map): escribe cada entrada con el
     prefijo de traducción. `storage` es localStorage o un objeto
     con length/key(i)/getItem/setItem (así se puede probar en Node).
     Para viajar en el .rpmbak, el mapa de sync usa la clave
     'traduccion:<sufijo>' (syncMapKey / suffixFromSyncMapKey). */
  function collectTranslations(storage) {
    var out = {};
    try {
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (k && k.indexOf(TRANSLATION_PREFIX) === 0) {
          out[k.slice(TRANSLATION_PREFIX.length)] = storage.getItem(k);
        }
      }
    } catch (e) { /* localStorage no disponible: mapa vacío */ }
    return out;
  }

  function applyTranslations(storage, map) {
    try {
      Object.keys(map || {}).forEach(function (suffix) {
        storage.setItem(TRANSLATION_PREFIX + suffix, map[suffix]);
      });
    } catch (e) { /* sin almacenamiento: no se aplica */ }
  }

  /* Clave que usa la traducción dentro del mapa `lyrics` del paquete
     .rpmbak (WIRING.md): 'traduccion:<título> — <artista>'. */
  function syncMapKey(suffix) { return 'traduccion:' + suffix; }
  function suffixFromSyncMapKey(k) {
    var s = String(k || '');
    return s.indexOf('traduccion:') === 0 ? s.slice('traduccion:'.length) : null;
  }

  /* Fusión de traducciones para el sync: MISMA regla documentada
     que mergeLyrics en sync-bridge.js (gana la remota si el paquete
     es más nuevo que el último sync, o si la clave no existe en
     local; en cualquier otro caso se conserva la local). Es
     agnóstica a la clave: vale para letras y para traducciones. */
  function mergeTranslations(localMap, remoteMap, remoteExportedAt, lastSyncAt) {
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
    translation: null,   // lista de líneas (strings) o null si no hay
    show: true,          // mostrar traducción (persistente)
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
    var rawTr = storageGet(translationKeyFor(cur.title, cur.artist));
    state.translation = hasTranslation(rawTr) ? parseTranslationText(rawTr) : null;
    state.trackKey = norm(cur.title) + '|' + norm(cur.artist);
  }

  /* Pares original/traducción para la canción actual ([] si no hay
     letra; translation '' en cada línea si no hay traducción). */
  function currentPairs() {
    if (!state.original) return [];
    return pairLines(state.original.lines, (state.translation || []).join('\n'));
  }

  /* Inyecta (o actualiza, o quita) el <span class="traduccion-line">
     dentro de cada botón de línea. Idempotente: si el span ya tiene
     el texto correcto, no toca el DOM. No rompe los botones de
     lyrics.js/karaoke.js: el clic en el span burbujea al botón y el
     salto de tiempo sigue funcionando; la visibilidad la decide el
     CSS con la clase .traduccion-visible del contenedor. */
  function syncSpans(box, lineClass) {
    if (!box) return;
    var pairs = currentPairs();
    var btns = box.querySelectorAll('.' + lineClass);
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var want = (pairs[i] && pairs[i].translation) || '';
      var span = btn.querySelector('.traduccion-line');
      if (!want) {
        if (span) btn.removeChild(span);
      } else if (!span) {
        span = document.createElement('span');
        span.className = 'traduccion-line';
        span.textContent = want;
        btn.appendChild(span);
      } else if (span.textContent !== want) {
        span.textContent = want;
      }
    }
    box.classList.toggle('traduccion-visible', state.show);
  }

  /* Aviso "sin traducción" dentro del karaoke (un <p> al final de
     #karaokeLines). Idempotente; karaoke.js lo borra al re-renderizar
     y el sondeo lo vuelve a poner. */
  function syncKaraokeNotice() {
    var box = $('karaokeLines'); if (!box) return;
    var note = box.querySelector('.traduccion-aviso-karaoke');
    var show = !!state.original && !state.translation;
    if (!show) { if (note) box.removeChild(note); return; }
    if (!note) {
      note = document.createElement('p');
      note.className = 'karaoke-hint traduccion-aviso-karaoke';
      note.textContent = 'Sin traducción guardada para esta canción. Añádela desde el botón ♪ Letras.';
      box.appendChild(note);
    }
  }

  function refreshUI() {
    var hasLyrics = !!state.original;
    var hasTr = !!state.translation;
    var pairs = currentPairs();
    var done = countTranslated(pairs), total = pairs.length;

    var toggle = $('traduccionToggle');
    if (toggle) {
      toggle.disabled = !hasTr;
      toggle.classList.toggle('active', state.show && hasTr);
      toggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
      toggle.title = !hasTr ? 'Sin traducción guardada para esta canción'
        : (state.show ? 'Ocultar la traducción' : 'Mostrar la traducción');
    }
    var editBtn = $('traduccionEditBtn');
    if (editBtn) {
      editBtn.disabled = !hasLyrics;
      editBtn.textContent = hasTr ? '✏️ Editar traducción' : '✏️ Añadir traducción';
      editBtn.title = !hasLyrics ? 'Primero carga la letra de la canción'
        : (hasTr ? 'Editar la traducción guardada' : 'Escribir la traducción, línea por línea');
    }
    var aviso = $('traduccionAviso');
    if (aviso) {
      aviso.hidden = !(hasLyrics && !hasTr && !state.editorOpen);
    }
    var count = $('traduccionCount');
    if (count) {
      count.textContent = hasTr ? (done + ' de ' + total + ' líneas traducidas') : '';
    }
    var kToggle = $('traduccionKaraokeToggle');
    if (kToggle) {
      kToggle.hidden = !hasTr;
      kToggle.classList.toggle('active', state.show && hasTr);
      kToggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
    }
    syncSpans($('lyricsLines'), 'lyrics-line');
    syncSpans($('karaokeLines'), 'karaoke-line');
    syncKaraokeNotice();
  }

  function openEditor() {
    var ed = $('traduccionEditor'); if (!ed || !state.original) return;
    var ta = $('traduccionText');
    if (ta) {
      var lines = (state.translation || []).slice();
      while (lines.length < state.original.lines.length) lines.push('');
      ta.value = lines.join('\n');
      ta.disabled = false;
    }
    var hint = $('traduccionEditorHint');
    if (hint) hint.textContent = 'Una línea de traducción por cada línea de la letra original (' +
      state.original.lines.length + ' líneas), en el mismo orden. Deja en blanco la que no quieras traducir.';
    var del = $('traduccionDelete');
    if (del) del.hidden = !state.translation;
    state.editorOpen = true;
    ed.hidden = false;
    refreshUI();
    if (ta) ta.focus();
  }

  function closeEditor() {
    var ed = $('traduccionEditor'); if (ed) ed.hidden = true;
    state.editorOpen = false;
    refreshUI();
  }

  function saveEditor() {
    var ta = $('traduccionText'); if (!ta) return;
    var cur = currentTitleArtist();
    var text = serializeTranslation(parseTranslationText(ta.value));
    if (!text) storageRemove(translationKeyFor(cur.title, cur.artist));
    else storageSet(translationKeyFor(cur.title, cur.artist), text);
    loadForCurrentTrack();
    closeEditor();
  }

  function deleteTranslation() {
    var cur = currentTitleArtist();
    storageRemove(translationKeyFor(cur.title, cur.artist));
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
     reintenta. No se toca nada de lyrics.js: solo se añaden botones. */
  function ensureLyricsUI() {
    var panel = $('lyricsPanel'); if (!panel) return;
    var actions = panel.querySelector('.lyrics-actions');
    if (actions && !$('traduccionToggle')) {
      var toggle = document.createElement('button');
      toggle.type = 'button'; toggle.id = 'traduccionToggle';
      toggle.textContent = '🌐 Traducción';
      toggle.addEventListener('click', toggleShow);
      actions.appendChild(toggle);

      var edit = document.createElement('button');
      edit.type = 'button'; edit.id = 'traduccionEditBtn';
      edit.textContent = '✏️ Añadir traducción';
      edit.addEventListener('click', function () {
        if (state.editorOpen) closeEditor(); else openEditor();
      });
      actions.appendChild(edit);
    }
    var lines = $('lyricsLines');
    if (lines && !$('traduccionEditor')) {
      var ed = document.createElement('div');
      ed.id = 'traduccionEditor'; ed.className = 'traduccion-editor'; ed.hidden = true;
      var hint = document.createElement('p');
      hint.id = 'traduccionEditorHint'; hint.className = 'traduccion-editor-hint';
      ed.appendChild(hint);
      var ta = document.createElement('textarea');
      ta.id = 'traduccionText'; ta.className = 'traduccion-text';
      ta.setAttribute('aria-label', 'Traducción de la letra, una línea por cada línea original');
      ta.placeholder = 'Primera línea traducida\nSegunda línea traducida';
      ed.appendChild(ta);
      var row = document.createElement('div');
      row.className = 'traduccion-editor-row';
      var save = document.createElement('button');
      save.type = 'button'; save.id = 'traduccionSave'; save.className = 'traduccion-save';
      save.textContent = 'Guardar traducción';
      save.addEventListener('click', saveEditor);
      row.appendChild(save);
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.id = 'traduccionCancel';
      cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', closeEditor);
      row.appendChild(cancel);
      var del = document.createElement('button');
      del.type = 'button'; del.id = 'traduccionDelete';
      del.textContent = 'Quitar traducción';
      del.addEventListener('click', deleteTranslation);
      row.appendChild(del);
      var count = document.createElement('span');
      count.id = 'traduccionCount'; count.className = 'traduccion-count';
      row.appendChild(count);
      ed.appendChild(row);
      lines.parentNode.insertBefore(ed, lines);

      var aviso = document.createElement('p');
      aviso.id = 'traduccionAviso'; aviso.className = 'traduccion-aviso'; aviso.hidden = true;
      var avisoText = document.createElement('span');
      avisoText.textContent = 'Sin traducción guardada para esta canción. ';
      aviso.appendChild(avisoText);
      var avisoBtn = document.createElement('button');
      avisoBtn.type = 'button'; avisoBtn.textContent = 'Añadir traducción';
      avisoBtn.addEventListener('click', openEditor);
      aviso.appendChild(avisoBtn);
      lines.parentNode.insertBefore(aviso, lines);
    }
  }

  /* Botón 🌐 en la barra superior del karaoke (una sola vez). El
     editor vive solo en el panel de letras; aquí solo se muestra u
     oculta la traducción. */
  function ensureKaraokeUI() {
    var view = $('karaokeView'); if (!view) return;
    var top = view.querySelector('.karaoke-top');
    var closeBtn = $('karaokeClose');
    if (top && closeBtn && !$('traduccionKaraokeToggle')) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'traduccionKaraokeToggle';
      btn.className = 'karaoke-close traduccion-karaoke-toggle';
      btn.textContent = '🌐';
      btn.title = 'Mostrar u ocultar la traducción';
      btn.setAttribute('aria-label', 'Mostrar u ocultar la traducción');
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
    // igual que hacen lyrics.js y karaoke.js con sus CSS.
    try {
      var hasCss = !!document.querySelector('link[href*="traduccion.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './traduccion.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try {
      var flag = storageGet(SHOW_FLAG_KEY);
      state.show = flag !== '0'; // por defecto, mostrar si hay traducción
    } catch (e) {}
    try { loadForCurrentTrack(); } catch (e) {}
    // Mismo sondeo de 600 ms que lyrics.js y karaoke.js: detecta el
    // cambio de canción y la aparición del panel/vista, y repone los
    // spans cada vez que lyrics.js o karaoke.js re-renderizan.
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
      translationKeyFor: translationKeyFor,
      translationKeyForBaseKey: translationKeyForBaseKey,
      baseKeyForTranslationKey: baseKeyForTranslationKey,
      suffixFor: suffixFor,
      parseLRC: parseLRC,
      parseTranslationText: parseTranslationText,
      serializeTranslation: serializeTranslation,
      trimTrailingEmpty: trimTrailingEmpty,
      pairLines: pairLines,
      countTranslated: countTranslated,
      hasTranslation: hasTranslation,
      collectTranslations: collectTranslations,
      applyTranslations: applyTranslations,
      syncMapKey: syncMapKey,
      suffixFromSyncMapKey: suffixFromSyncMapKey,
      mergeTranslations: mergeTranslations,
      LYRICS_PREFIX: LYRICS_PREFIX,
      TRANSLATION_PREFIX: TRANSLATION_PREFIX,
      SHOW_FLAG_KEY: SHOW_FLAG_KEY
    };
  }
  if (typeof window !== 'undefined') {
    window.__traduccionKey = keyFor;
    window.__traduccionTranslationKey = translationKeyFor;
    window.__traduccionParse = parseLRC;
    window.__traduccionPair = pairLines;
    window.__traduccionHas = hasTranslation;
    window.__traduccionCollect = collectTranslations;
    window.__traduccionApply = applyTranslations;
    window.__traduccionMerge = mergeTranslations;
    window.__traduccionToggle = function () { try { toggleShow(); } catch (e) {} };
    window.__traduccionOpenEditor = function () { try { openEditor(); } catch (e) {} };
  }
})();
