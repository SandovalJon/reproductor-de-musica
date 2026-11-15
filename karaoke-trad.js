/* Letras traducidas en karaoke para Reproductor de Música — v4.1.0.
   Módulo aparte: NO toca index.html, lyrics.js, karaoke.js ni
   traduccion.js. Se engancha solo a lo que ya existe en la app:
     - #nowTitle / #nowArtist (título y artista actuales)
     - #karaokeView / #karaokeLines / .karaoke-line (modo karaoke)
   y lee la traducción de la MISMA clave de localStorage que usa
   traduccion.js (ver WIRING.md).

   Clave base (EXACTA, verificada en app/lyrics.js y app/karaoke.js):
     'reproductor-letras:' + norm(título) + ' — ' + norm(artista)
   Clave de traducción (este módulo, igual que traduccion.js):
     'reproductor-letras-traduccion:' + norm(título) + ' — ' + norm(artista)
   donde norm = minúsculas, espacios colapsados, sin extremos,
   y ' — ' es guion largo U+2014 rodeado de espacios.
   El valor es texto plano: una línea de traducción por renglón,
   en el mismo orden que las líneas de la letra original.

   Qué hace:
   - En la vista karaoke, muestra cada línea traducida debajo de su
     línea original, alineada por ÍNDICE (la línea de traducción n
     corresponde a la línea original n; como las líneas del karaoke
     van ordenadas por tiempo, el índice ES la alineación por
     tiempo: la traducción se resalta y se centra con su línea).
   - Sin traducción guardada para esa canción, el karaoke se ve
     EXACTAMENTE como siempre: no se crea ningún span, no se añade
     ningún aviso y no se inventa ninguna traducción.
   - Respeta el flag de visibilidad de traduccion.js
     ('reproductor-traduccion-visible': '1' | '0', por defecto '1'):
     lo lee en cada sondeo y, si traduccion.js NO está cargado, es
     este módulo quien aplica la clase .traduccion-visible en
     #karaokeLines. Si traduccion.js SÍ está cargado, la visibilidad
     la sigue gestionando él y este módulo no la toca (para no
     pelearse con su estado en memoria).
   - Convivencia con traduccion.js: si ya está cargado, él también
     inyecta <span class="traduccion-line"> en las líneas del
     karaoke. Este módulo usa el MISMO span y la MISMA lógica
     idempotente (si el span ya existe con el texto correcto, no lo
     toca; si falta, lo crea; si sobra, lo quita), así que los dos
     convergen al mismo DOM y nunca hay spans duplicados. El botón
     🌐 propio (#karaokeTradToggle) solo se crea si traduccion.js no
     puso ya el suyo (#traduccionKaraokeToggle), y su clic delega en
     window.__traduccionToggle cuando existe.
   - Si karaoke.js no cargó, no existe #karaokeLines y el módulo no
     hace nada. Si traduccion.js no cargó, el módulo funciona solo:
     lee la traducción directamente de localStorage. En cualquier
     caso, un error aquí dentro se traga y la app sigue funcionando.
   - Sin red, sin dependencias. Todo el texto del usuario se inserta
     con textContent (nunca innerHTML).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./karaoke-trad.css">
     <script src="./karaoke-trad.js"></script>
     (después de karaoke.js; el orden respecto a traduccion.js da igual)
   Pruebas Node: node --test karaoke-trad.test.mjs
   Prueba desde la consola:
     window.__karaokeTradPair([{t:5,text:'Hello'}], 'Hola')
     window.__karaokeTradKey('Song', 'Artist')
     window.__karaokeTradRefresh() */
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

  /* Clave EXACTA de lyrics.js / karaoke.js. */
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

  /* Parser LRC, misma semántica que lyrics.js / karaoke.js:
     [mm:ss.xx] texto, varias marcas por línea, [offset:+500], se
     ignoran las etiquetas de metadatos ([ti:], [ar:]...). Sin marcas
     de tiempo, las líneas de texto se devuelven como letra sin
     sincronizar (synced:false). Copia local (no depende del orden de
     carga de karaoke.js ni de traduccion.js). */
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

  /* Empareja original con traducción por ÍNDICE: la línea de
     traducción n corresponde a la línea original n. Nunca inventa
     nada: sin traducción para una línea, translation es ''.
     Las líneas de traducción que sobran (más que la letra) se
     ignoran al mostrar. El campo t de cada par es el tiempo de la
     línea original, así que la traducción viaja con su línea cuando
     el karaoke la resalta o la centra. */
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

  /* Flag de visibilidad de traduccion.js: '0' = ocultar; cualquier
     otro valor (incluido no guardado) = mostrar. */
  function showFromFlag(raw) {
    return raw !== '0';
  }

  /* Decisión pura para la sincronización idempotente de un span
     dentro de una línea del karaoke. existingText es null si la
     línea no tiene span, o el textContent del span que ya hay;
     want es la traducción que debería mostrar esa línea ('' si no
     hay traducción para ella).
       'keep'   el span ya tiene el texto correcto: no tocar el DOM.
       'create' no hay span y hay traducción: crear uno.
       'update' hay span con texto distinto: actualizarlo.
       'remove' hay span pero ya no hay traducción: quitarlo.
     Así, aunque traduccion.js y este módulo corran a la vez, los dos
     calculan la misma decisión y el DOM converge sin duplicados. */
  function spanSyncDecision(existingText, want) {
    var w = String(want || '');
    if (!w) return existingText == null ? 'keep' : 'remove';
    if (existingText == null) return 'create';
    return existingText === w ? 'keep' : 'update';
  }

  /* ================= Pegamento con el navegador ================= */

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  /* ¿Está cargado traduccion.js? Se detecta en cada sondeo (el
     orden de carga de los scripts puede variar): expone
     window.__traduccionToggle y pone su propio botón 🌐 en karaoke. */
  function traduccionLoaded() {
    try {
      if (typeof window !== 'undefined' && typeof window.__traduccionToggle === 'function') return true;
      return !!$('traduccionKaraokeToggle');
    } catch (e) { return false; }
  }

  var state = {
    trackKey: '',        // norm(título)|norm(artista) de lo cargado
    original: null,      // { synced, lines } o null si no hay letra
    translation: null,   // lista de líneas (strings) o null si no hay
    show: true           // mostrar traducción (flag de traduccion.js)
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
     dentro de cada botón .karaoke-line de #karaokeLines, según la
     decisión pura spanSyncDecision. Idempotente: si el span ya tiene
     el texto correcto, no toca el DOM. No rompe karaoke.js: el clic
     en el span burbujea al botón y el salto de tiempo sigue
     funcionando; la visibilidad la decide el CSS con la clase
     .traduccion-visible del contenedor.
     Si traduccion.js está cargado, él gestiona la clase
     .traduccion-visible y aquí no se toca; si no lo está, este
     módulo la aplica según el flag. Sin #karaokeLines (karaoke.js
     no cargó), no hace nada. */
  function syncKaraoke() {
    var box = $('karaokeLines'); if (!box) return;
    var pairs = currentPairs();
    var btns = box.querySelectorAll('.karaoke-line');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var want = (pairs[i] && pairs[i].translation) || '';
      var span = btn.querySelector('.traduccion-line');
      var existing = span ? span.textContent : null;
      var decision = spanSyncDecision(existing, want);
      if (decision === 'create') {
        span = document.createElement('span');
        span.className = 'traduccion-line';
        span.textContent = want;
        btn.appendChild(span);
      } else if (decision === 'update') {
        span.textContent = want;
      } else if (decision === 'remove') {
        btn.removeChild(span);
      }
      // 'keep': no tocar el DOM.
    }
    if (!traduccionLoaded()) {
      box.classList.toggle('traduccion-visible', state.show);
    }
    var toggle = $('karaokeTradToggle');
    if (toggle) {
      toggle.hidden = !state.translation;
      toggle.classList.toggle('active', state.show && !!state.translation);
      toggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
    }
  }

  function toggleShow() {
    // Si traduccion.js está cargado, delegar en él: mantiene su
    // estado en memoria sincronizado con el flag. Si no, gestionar
    // el flag directamente (misma semántica: '1' | '0').
    if (traduccionLoaded() && typeof window.__traduccionToggle === 'function') {
      try { window.__traduccionToggle(); } catch (e) {}
      try { state.show = showFromFlag(storageGet(SHOW_FLAG_KEY)); } catch (e) {}
    } else {
      state.show = !state.show;
      storageSet(SHOW_FLAG_KEY, state.show ? '1' : '0');
    }
    syncKaraoke();
  }

  /* Botón 🌐 propio en la barra superior del karaoke (una sola
     vez). Solo se crea si traduccion.js no puso ya el suyo
     (#traduccionKaraokeToggle): un solo botón 🌐 en karaoke.
     Solo muestra/oculta la traducción; el editor vive en el panel
     de letras (traduccion.js). */
  function ensureToggle() {
    var view = $('karaokeView'); if (!view) return;
    if ($('traduccionKaraokeToggle') || $('karaokeTradToggle')) return;
    var top = view.querySelector('.karaoke-top');
    var closeBtn = $('karaokeClose');
    if (!top || !closeBtn) return;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'karaokeTradToggle';
    btn.className = 'karaoke-close karaoke-trad-toggle';
    btn.textContent = '🌐';
    btn.title = 'Mostrar u ocultar la traducción';
    btn.setAttribute('aria-label', 'Mostrar u ocultar la traducción');
    btn.hidden = true; // se muestra solo si hay traducción (syncKaraoke)
    btn.addEventListener('click', toggleShow);
    top.insertBefore(btn, closeBtn);
  }

  function tick() {
    try {
      ensureToggle();
      var cur = currentTitleArtist();
      var tk = norm(cur.title) + '|' + norm(cur.artist);
      try { state.show = showFromFlag(storageGet(SHOW_FLAG_KEY)); } catch (e) {}
      if (tk !== state.trackKey) {
        loadForCurrentTrack();
      }
      syncKaraoke();
    } catch (e) { /* el sondeo nunca debe romper la app */ }
  }

  function buildUI() {
    // CSS: el <link> de WIRING.md es la vía principal; si falta
    // (o si el módulo se carga solo), se inyecta aquí como respaldo,
    // igual que hacen lyrics.js, karaoke.js y traduccion.js.
    try {
      var hasCss = !!document.querySelector('link[href*="karaoke-trad.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './karaoke-trad.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try {
      state.show = showFromFlag(storageGet(SHOW_FLAG_KEY));
    } catch (e) {}
    try { loadForCurrentTrack(); } catch (e) {}
    // Mismo sondeo de 600 ms que lyrics.js, karaoke.js y
    // traduccion.js: detecta el cambio de canción y la aparición de
    // la vista, y repone los spans cada vez que karaoke.js
    // re-renderiza las líneas (al abrir o al cambiar de canción).
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
      keyFor: keyFor,
      translationKeyFor: translationKeyFor,
      translationKeyForBaseKey: translationKeyForBaseKey,
      baseKeyForTranslationKey: baseKeyForTranslationKey,
      parseLRC: parseLRC,
      parseTranslationText: parseTranslationText,
      pairLines: pairLines,
      countTranslated: countTranslated,
      hasTranslation: hasTranslation,
      showFromFlag: showFromFlag,
      spanSyncDecision: spanSyncDecision,
      LYRICS_PREFIX: LYRICS_PREFIX,
      TRANSLATION_PREFIX: TRANSLATION_PREFIX,
      SHOW_FLAG_KEY: SHOW_FLAG_KEY
    };
  }
  if (typeof window !== 'undefined') {
    window.__karaokeTradKey = keyFor;
    window.__karaokeTradTranslationKey = translationKeyFor;
    window.__karaokeTradParse = parseLRC;
    window.__karaokeTradPair = pairLines;
    window.__karaokeTradHas = hasTranslation;
    window.__karaokeTradToggle = function () { try { toggleShow(); } catch (e) {} };
    window.__karaokeTradRefresh = function () { try { tick(); } catch (e) {} };
  }
})();
