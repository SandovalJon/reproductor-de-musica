/* Acordes en karaoke para Reproductor de Música — v4.3.0.
   Módulo aparte: NO toca index.html, lyrics.js, karaoke.js,
   karaoke-trad.js, traduccion.js ni acordes.js. Se engancha solo a
   lo que ya existe en la app:
     - #nowTitle / #nowArtist (título y artista actuales)
     - #karaokeView / #karaokeLines / .karaoke-line (modo karaoke)
   y lee los acordes de la MISMA clave de localStorage que usa
   acordes.js (ver WIRING.md).

   Clave base (EXACTA, verificada en app/lyrics.js y app/karaoke.js):
     'reproductor-letras:' + norm(título) + ' — ' + norm(artista)
   Clave de acordes (este módulo, igual que acordes.js):
     'reproductor-letras-acordes:' + norm(título) + ' — ' + norm(artista)
   donde norm = minúsculas, espacios colapsados, sin extremos,
   y ' — ' es guion largo U+2014 rodeado de espacios.
   El valor es texto plano: una línea de acordes por renglón,
   en el mismo orden que las líneas de la letra original.

   Qué hace:
   - En la vista karaoke, muestra los acordes del usuario ENCIMA de
     su línea de letra, alineados por ÍNDICE (la línea de acordes n
     corresponde a la línea original n; como las líneas del karaoke
     van ordenadas por tiempo, el índice ES la alineación por
     tiempo: los acordes se resaltan y se centran con su línea).
   - Junto a la traducción: los acordes van como PRIMER hijo del
     botón de línea (arriba) y la traducción —que pone
     karaoke-trad.js / traduccion.js— como ÚLTIMO hijo (abajo).
     Este módulo NUNCA toca el span .traduccion-line: solo busca,
     crea, actualiza o quita su propio span .acordes-line.
   - Sin acordes guardados para esa canción, el karaoke se ve
     EXACTAMENTE como siempre: no se crea ningún span, no se añade
     ningún aviso y no se inventa ningún acorde.
   - Respeta el flag de visibilidad de acordes.js
     ('reproductor-acordes-visible': '1' | '0', por defecto '1'):
     lo lee en cada sondeo y, si acordes.js NO está cargado, es
     este módulo quien aplica la clase .acordes-visible en
     #karaokeLines. Si acordes.js SÍ está cargado, la visibilidad
     la sigue gestionando él y este módulo no la toca (para no
     pelearse con su estado en memoria).
   - Convivencia con acordes.js: si ya está cargado, él también
     inyecta <span class="acordes-line"> en las líneas del
     karaoke. Este módulo usa el MISMO span, la MISMA posición
     (primer hijo) y la MISMA lógica idempotente (si el span ya
     existe con el texto correcto, no lo toca; si falta, lo crea;
     si sobra, lo quita), así que los dos convergen al mismo DOM
     y nunca hay spans duplicados. El botón 🎸 propio
     (#karaokeAcordesToggle) solo se crea si acordes.js no puso
     ya el suyo (#acordesKaraokeToggle), y su clic delega en
     window.__acordesToggle cuando existe.
   - NUNCA escribe acordes: solo LEE la clave de acordes. No hay
     editor aquí (vive en acordes.js, en el panel de letras), no
     hay detección de audio ni acordes generados: sin acordes
     guardados, no se muestra ninguno.
   - Si karaoke.js no cargó, no existe #karaokeLines y el módulo no
     hace nada. Si acordes.js no cargó, el módulo funciona solo:
     lee los acordes directamente de localStorage. En cualquier
     caso, un error aquí dentro se traga y la app sigue funcionando.
   - Sin red, sin dependencias. Todo el texto del usuario se inserta
     con textContent (nunca innerHTML).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./karaoke-acordes.css">
     <script src="./karaoke-acordes.js"></script>
     (después de karaoke.js, karaoke-trad.js y acordes.js; el orden
     respecto a acordes.js da igual: el módulo detecta en cada
     sondeo si acordes.js está cargado)
   Pruebas Node: node --test karaoke-acordes.test.mjs
   Prueba desde la consola:
     window.__karaokeAcordesPair([{t:5,text:'Hello'}], 'C  G')
     window.__karaokeAcordesChordsKey('Song', 'Artist')
     window.__karaokeAcordesRefresh() */
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

  /* Clave EXACTA de lyrics.js / karaoke.js. */
  function keyFor(title, artist) {
    return LYRICS_PREFIX + suffixFor(title, artist);
  }

  /* Clave de acordes: misma base, prefijo distinto (igual que acordes.js). */
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

  /* Parser LRC, misma semántica que lyrics.js / karaoke.js:
     [mm:ss.xx] texto, varias marcas por línea, [offset:+500], se
     ignoran las etiquetas de metadatos ([ti:], [ar:]...). Sin marcas
     de tiempo, las líneas de texto se devuelven como letra sin
     sincronizar (synced:false). Copia local (no depende del orden de
     carga de karaoke.js ni de acordes.js). */
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
     corrige nada: lo que escribió el usuario, tal cual.
     Misma regla que acordes.js, para que el emparejado coincida. */
  function parseChordsText(text) {
    if (text == null) return [];
    return String(text).split(/\r?\n/).map(function (ln) {
      return ln.replace(/\s+/g, ' ').trim();
    });
  }

  /* Empareja original con acordes por ÍNDICE: la línea de acordes
     n corresponde a la línea original n. Nunca inventa nada: sin
     acordes para una línea, chords es ''.
     Las líneas de acordes que sobran (más que la letra) se
     ignoran al mostrar. El campo t de cada par es el tiempo de la
     línea original, así que los acordes viajan con su línea cuando
     el karaoke la resalta o la centra. */
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

  /* Flag de visibilidad de acordes.js: '0' = ocultar; cualquier
     otro valor (incluido no guardado) = mostrar. */
  function showFromFlag(raw) {
    return raw !== '0';
  }

  /* Decisión pura para la sincronización idempotente de un span
     dentro de una línea del karaoke. existingText es null si la
     línea no tiene span, o el textContent del span que ya hay;
     want es el acorde que debería mostrar esa línea ('' si no
     hay acordes para ella).
       'keep'   el span ya tiene el texto correcto: no tocar el DOM.
       'create' no hay span y hay acordes: crear uno.
       'update' hay span con texto distinto: actualizarlo.
       'remove' hay span pero ya no hay acordes: quitarlo.
     Así, aunque acordes.js y este módulo corran a la vez, los dos
     calculan la misma decisión y el DOM converge sin duplicados.
     (El span de traducción .traduccion-line no entra aquí: este
     módulo ni lo busca ni lo toca.) */
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

  /* ¿Está cargado acordes.js? Se detecta en cada sondeo (el
     orden de carga de los scripts puede variar): expone
     window.__acordesToggle y pone su propio botón 🎸 en karaoke. */
  function acordesLoaded() {
    try {
      if (typeof window !== 'undefined' && typeof window.__acordesToggle === 'function') return true;
      return !!$('acordesKaraokeToggle');
    } catch (e) { return false; }
  }

  var state = {
    trackKey: '',        // norm(título)|norm(artista) de lo cargado
    original: null,      // { synced, lines } o null si no hay letra
    chords: null,        // lista de líneas (strings) o null si no hay
    show: true           // mostrar acordes (flag de acordes.js)
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
     como PRIMER hijo de cada botón .karaoke-line de #karaokeLines,
     es decir, ENCIMA de la letra, según la decisión pura
     spanSyncDecision. Idempotente: si el span ya tiene el texto
     correcto, no toca el DOM (salvo devolverlo arriba si otro
     re-render lo movió). No rompe karaoke.js ni karaoke-trad.js:
     el clic en el span burbujea al botón y el salto de tiempo
     sigue funcionando; el span de traducción (último hijo) no se
     toca nunca; la visibilidad la decide el CSS con la clase
     .acordes-visible del contenedor.
     Si acordes.js está cargado, él gestiona la clase
     .acordes-visible y aquí no se toca; si no lo está, este
     módulo la aplica según el flag. Sin #karaokeLines (karaoke.js
     no cargó), no hace nada. Sin acordes guardados, no se crea
     ningún span: el karaoke queda exactamente como siempre. */
  function syncKaraoke() {
    var box = $('karaokeLines'); if (!box) return;
    var pairs = currentPairs();
    var btns = box.querySelectorAll('.karaoke-line');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var want = (pairs[i] && pairs[i].chords) || '';
      var span = btn.querySelector('.acordes-line');
      var existing = span ? span.textContent : null;
      var decision = spanSyncDecision(existing, want);
      if (decision === 'create') {
        span = document.createElement('span');
        span.className = 'acordes-line';
        span.textContent = want;
        btn.insertBefore(span, btn.firstChild);
      } else if (decision === 'update') {
        span.textContent = want;
        if (btn.firstChild !== span) btn.insertBefore(span, btn.firstChild);
      } else if (decision === 'remove') {
        btn.removeChild(span);
      } else if (decision === 'keep' && span) {
        // Por si otro módulo o un re-render lo movió, que vuelva arriba.
        if (btn.firstChild !== span) btn.insertBefore(span, btn.firstChild);
      }
      // 'keep' sin span: no tocar el DOM.
    }
    if (!acordesLoaded()) {
      box.classList.toggle('acordes-visible', state.show);
    }
    var toggle = $('karaokeAcordesToggle');
    if (toggle) {
      toggle.hidden = !state.chords;
      toggle.classList.toggle('active', state.show && !!state.chords);
      toggle.setAttribute('aria-pressed', state.show ? 'true' : 'false');
    }
  }

  function toggleShow() {
    // Si acordes.js está cargado, delegar en él: mantiene su
    // estado en memoria sincronizado con el flag. Si no, gestionar
    // el flag directamente (misma semántica: '1' | '0').
    if (acordesLoaded() && typeof window.__acordesToggle === 'function') {
      try { window.__acordesToggle(); } catch (e) {}
      try { state.show = showFromFlag(storageGet(SHOW_FLAG_KEY)); } catch (e) {}
    } else {
      state.show = !state.show;
      storageSet(SHOW_FLAG_KEY, state.show ? '1' : '0');
    }
    syncKaraoke();
  }

  /* Botón 🎸 propio en la barra superior del karaoke (una sola
     vez). Solo se crea si acordes.js no puso ya el suyo
     (#acordesKaraokeToggle): un solo botón 🎸 en karaoke.
     Solo muestra/oculta los acordes; el editor vive en el panel
     de letras (acordes.js). */
  function ensureToggle() {
    var view = $('karaokeView'); if (!view) return;
    if ($('acordesKaraokeToggle') || $('karaokeAcordesToggle')) return;
    var top = view.querySelector('.karaoke-top');
    var closeBtn = $('karaokeClose');
    if (!top || !closeBtn) return;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'karaokeAcordesToggle';
    btn.className = 'karaoke-close karaoke-acordes-toggle';
    btn.textContent = '🎸';
    btn.title = 'Mostrar u ocultar los acordes';
    btn.setAttribute('aria-label', 'Mostrar u ocultar los acordes');
    btn.hidden = true; // se muestra solo si hay acordes (syncKaraoke)
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
    // igual que hacen lyrics.js, karaoke.js, karaoke-trad.js y acordes.js.
    try {
      var hasCss = !!document.querySelector('link[href*="karaoke-acordes.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './karaoke-acordes.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try {
      state.show = showFromFlag(storageGet(SHOW_FLAG_KEY));
    } catch (e) {}
    try { loadForCurrentTrack(); } catch (e) {}
    // Mismo sondeo de 600 ms que lyrics.js, karaoke.js,
    // karaoke-trad.js, traduccion.js y acordes.js: detecta el cambio
    // de canción y la aparición de la vista, y repone los spans
    // cada vez que karaoke.js re-renderiza las líneas (al abrir o
    // al cambiar de canción).
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
      chordsKeyFor: chordsKeyFor,
      chordsKeyForBaseKey: chordsKeyForBaseKey,
      baseKeyForChordsKey: baseKeyForChordsKey,
      parseLRC: parseLRC,
      parseChordsText: parseChordsText,
      pairLines: pairLines,
      countWithChords: countWithChords,
      hasChords: hasChords,
      showFromFlag: showFromFlag,
      spanSyncDecision: spanSyncDecision,
      LYRICS_PREFIX: LYRICS_PREFIX,
      CHORDS_PREFIX: CHORDS_PREFIX,
      SHOW_FLAG_KEY: SHOW_FLAG_KEY
    };
  }
  if (typeof window !== 'undefined') {
    window.__karaokeAcordesKey = keyFor;
    window.__karaokeAcordesChordsKey = chordsKeyFor;
    window.__karaokeAcordesParse = parseLRC;
    window.__karaokeAcordesPair = pairLines;
    window.__karaokeAcordesHas = hasChords;
    window.__karaokeAcordesToggle = function () { try { toggleShow(); } catch (e) {} };
    window.__karaokeAcordesRefresh = function () { try { tick(); } catch (e) {} };
  }
})();
