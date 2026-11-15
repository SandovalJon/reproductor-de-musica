/* Modo lectura de letras para Reproductor de Música — v4.3.0.
   Módulo aparte: no toca index.html ni lyrics.js ni karaoke.js.
   Se engancha solo a #nowTitle / #nowArtist que ya existen, y lee
   la letra de la MISMA clave de localStorage que usa lyrics.js
   ('reproductor-letras:<título> — <artista>'), así que valen las
   letras cargadas con .lrc, pegadas a mano o incrustadas (USLT/SYLT):
   el .lrc externo siempre manda, como ya hace embedded-lyrics.js.
   El módulo nunca escribe en esa clave.

   Qué hace:
   - Botón "Lectura" (id btnLectura; si WIRING.md no se aplicó y no
     existe en index.html, el módulo crea uno flotante como respaldo).
     Solo se muestra cuando hay una canción cargada.
   - Vista propia a pantalla completa (Fullscreen API sobre el
     contenedor; si el navegador lo rechaza, la vista cubre
     igualmente toda la ventana por CSS: position:fixed, inset:0).
     Fondo tranquilo tipo papel, letra grande, sin controles de la
     app visibles: solo el botón ✕ para salir.
   - Muestra la letra COMPLETA como un libro: las marcas de tiempo
     [mm:ss.xx] se quitan, las estrofas se conservan como párrafos.
     No hay resaltado ni seguimiento: no es karaoke.
   - Se sale con Esc (también al salir de pantalla completa) o con
     el botón ✕. Sin letra, lo dice claro y no inventa ninguna.
   - Si cambia la canción mientras la vista está abierta, recarga
     la letra de la nueva canción.

   A prueba de fallos como los demás módulos: cualquier error aquí
   dentro se traga y la app sigue funcionando. Sin red, sin
   dependencias.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./lectura.css">
     <script src="./lectura.js"></script>
   Pruebas Node: node --test lectura.test.mjs
   Prueba desde la consola:
     window.__lecturaParse('[00:05.00] Hola')
     window.__lecturaPlainLines('[00:05.00] Hola\n[00:10.00] Adiós')
     window.__lecturaOpen() / window.__lecturaClose() */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var NO_TRACK_TITLE = 'Ninguna canción seleccionada';
  var LYRICS_PREFIX = 'reproductor-letras:';

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* Clave EXACTA de lyrics.js: 'reproductor-letras:<título> — <artista>' */
  function keyFor(title, artist) {
    return LYRICS_PREFIX + norm(title) + ' — ' + norm(artist);
  }

  /* ¿Hay una canción cargada? Sin canción, #nowTitle muestra el texto
     placeholder y <audio> no tiene src (ver renderNow() en index.html). */
  function hasTrack(title, audioSrc) {
    var t = String(title || '').trim();
    if (!t || t === NO_TRACK_TITLE) return false;
    return !!audioSrc;
  }

  /* Parser LRC, misma semántica que lyrics.js: [mm:ss.xx] texto,
     varias marcas por línea, [offset:+500], se ignoran las etiquetas
     de metadatos ([ti:], [ar:]...). Sin marcas de tiempo, las líneas
     de texto se devuelven como letra sin sincronizar (synced:false).
     Se reutiliza aquí solo para quitar las marcas de tiempo y
     quedarnos con el texto limpio. */
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

  /* Estado de la letra guardada (texto crudo de localStorage):
     'missing' (nada guardado), 'empty' (guardado vacío o sin líneas),
     'synced' (LRC con tiempos), 'plain' (texto sin tiempos). */
  function getLyricsState(raw) {
    if (raw == null) return 'missing';
    if (!String(raw).trim()) return 'empty';
    var data = parseLRC(raw);
    if (!data.lines.length) return 'empty';
    return data.synced ? 'synced' : 'plain';
  }

  /* Líneas de texto para leer, en el orden en que vienen en la
     letra guardada y sin marcas de tiempo ni metadatos. Cada línea
     del texto original aparece una sola vez, aunque lleve varias
     marcas de tiempo ([00:01][00:05] Texto); las líneas repetidas
     de verdad (un estribillo que vuelve) se conservan tal cual.
     Las líneas en blanco se saltan aquí (la separación de estrofas
     la hace splitStanzas). Entrada vacía/nula -> []. */
  function plainLines(raw) {
    var out = [];
    String(raw || '').split(/\r?\n/).forEach(function (rawLine) {
      var line = rawLine.replace(/^\uFEFF/, '');
      if (/^\[offset:\s*[+-]?\d+\s*\]$/i.test(line)) return;
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      var text = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      // Línea solo con tiempo(s) y sin texto: '♪', igual que lyrics.js
      // (marca un pasaje instrumental, no es letra inventada).
      if (!text && /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(line)) text = '♪';
      if (text) out.push(text);
    });
    return out;
  }

  /* Texto completo para leer, con las estrofas separadas por una
     línea en blanco. Es la forma que se muestra en la vista. */
  function plainText(raw) {
    return plainLines(raw).join('\n');
  }

  /* ================= Pegamento con el navegador ================= */

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var state = {
    open: false,
    lyricsState: 'missing',
    trackKey: ''      // 'título|artista' de la letra cargada
  };

  function currentTrackKey() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return norm(t) + '|' + norm(a);
  }

  function loadForCurrentTrack() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    var raw = storageGet(keyFor(t, a));
    state.lyricsState = getLyricsState(raw);
    state.trackKey = currentTrackKey();
    renderHeader();
    renderBody(raw);
  }

  function renderHeader() {
    var title = $('lecturaTitle'), artist = $('lecturaArtist');
    if (title) title.textContent = ($('nowTitle') ? $('nowTitle').textContent : '') || 'Sin canción';
    if (artist) artist.textContent = $('nowArtist') ? $('nowArtist').textContent : '';
  }

  function renderBody(raw) {
    var body = $('lecturaBody'); if (!body) return;
    body.innerHTML = '';
    body.scrollTop = 0;
    var lines = plainLines(raw);
    if (!lines.length) {
      var note = document.createElement('p');
      note.className = 'lectura-empty';
      note.textContent = state.lyricsState === 'empty'
        ? 'La letra guardada para esta canción está vacía.'
        : 'Esta canción no tiene letra guardada.';
      body.appendChild(note);
      var hint = document.createElement('p');
      hint.className = 'lectura-hint';
      hint.textContent = 'Carga un archivo .lrc o pega la letra desde el botón ♪ Letras, y vuelve a abrir la lectura.';
      body.appendChild(hint);
      return;
    }
    // Estrofas: las líneas en blanco del texto original separan
    // párrafos; el resto de líneas van juntas en un mismo párrafo.
    // (plainLines no conserva blancos, así que se reagrupan aquí
    // desde el texto crudo: cada bloque de líneas seguidas es una
    // estrofa; una línea en blanco la corta.)
    var stanzas = splitStanzas(raw);
    stanzas.forEach(function (stanza) {
      var p = document.createElement('p');
      p.className = 'lectura-stanza';
      p.textContent = stanza.join('\n');
      body.appendChild(p);
    });
  }

  /* Divide el texto crudo en estrofas (bloques de líneas seguidas),
     quitando marcas de tiempo y metadatos. Una estrofa con una sola
     línea es un párrafo de una línea. Cada línea del texto original
     aparece una sola vez, aunque lleve varias marcas de tiempo; las
     líneas repetidas de verdad se conservan. */
  function splitStanzas(raw) {
    if (!plainLines(raw).length) return [];
    // Reconstruir estrofas desde el texto crudo: recorrer las líneas
    // originales; una línea en blanco corta la estrofa.
    var stanzas = [], current = [];
    String(raw || '').split(/\r?\n/).forEach(function (rawLine) {
      var line = rawLine.replace(/^\uFEFF/, '');
      if (/^\[offset:\s*[+-]?\d+\s*\]$/i.test(line)) return;
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      var text = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      if (!text && /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(line)) text = '♪';
      if (!text) {
        if (current.length) { stanzas.push(current); current = []; }
        return;
      }
      current.push(text);
    });
    if (current.length) stanzas.push(current);
    return stanzas;
  }

  function open() {
    if (state.open) return;
    var view = $('lecturaView'); if (!view) return;
    var audio = $('audio');
    var title = $('nowTitle') ? $('nowTitle').textContent : '';
    if (!audio || !hasTrack(title, audio.src)) return; // sin canción: no abrir
    loadForCurrentTrack();
    state.open = true;
    view.classList.add('open');
    view.setAttribute('aria-hidden', 'false');
    // Pantalla completa sobre el contenedor. Si el navegador lo
    // rechaza (p. ej. sin gesto de usuario o no soportado), la vista
    // sigue cubriendo toda la ventana por CSS (.lectura-view.open).
    try {
      var req = view.requestFullscreen
        || view.webkitRequestFullscreen
        || view.msRequestFullscreen;
      if (req) {
        var p = req.call(view);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
    var closeBtn = $('lecturaClose');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    var view = $('lecturaView');
    if (view) {
      view.classList.remove('open');
      view.setAttribute('aria-hidden', 'true');
    }
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) {}
    var btn = $('btnLectura');
    if (btn) btn.focus();
  }

  function updateButton() {
    var btn = $('btnLectura'); if (!btn) return;
    var audio = $('audio');
    var title = $('nowTitle') ? $('nowTitle').textContent : '';
    var show = !!audio && hasTrack(title, audio.src);
    btn.style.display = show ? '' : 'none';
    btn.disabled = !show;
  }

  function buildUI() {
    // CSS: el <link> de WIRING.md es la vía principal; si falta
    // (o si el módulo se carga solo), se inyecta aquí como respaldo,
    // igual que hace karaoke.js con karaoke.css.
    try {
      var hasCss = !!document.querySelector('link[href*="lectura.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './lectura.css';
        document.head.appendChild(css);
      }
    } catch (e) {}

    // Botón: si index.html ya trae #btnLectura (WIRING.md), se usa
    // ese; si no, se crea uno flotante como respaldo.
    var btn = $('btnLectura');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnLectura'; btn.type = 'button';
      btn.className = 'lectura-fab';
      btn.textContent = '📖 Lectura';
      btn.title = 'Leer la letra completa de la canción actual, como un libro';
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', open);

    if ($('lecturaView')) { updateButton(); return; }

    var view = document.createElement('div');
    view.id = 'lecturaView';
    view.className = 'lectura-view';
    view.setAttribute('aria-hidden', 'true');
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-label', 'Modo lectura de letra');
    view.innerHTML =
      '<div class="lectura-top">' +
        '<div class="lectura-titles">' +
          '<strong id="lecturaTitle">Sin canción</strong>' +
          '<span id="lecturaArtist"></span>' +
        '</div>' +
        '<button type="button" id="lecturaClose" class="lectura-close" aria-label="Salir del modo lectura">✕</button>' +
      '</div>' +
      '<div id="lecturaBody" class="lectura-body"></div>';
    document.body.appendChild(view);

    $('lecturaClose').addEventListener('click', close);

    // Esc: en pantalla completa el navegador sale solo de fullscreen
    // (y fullscreenchange cierra la vista); fuera de fullscreen, Esc
    // cierra la vista directamente. close() es idempotente.
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.open) close();
    });
    document.addEventListener('fullscreenchange', function () {
      if (state.open && !document.fullscreenElement) close();
    });
    document.addEventListener('webkitfullscreenchange', function () {
      if (state.open && !document.webkitFullscreenElement) close();
    });

    // Detectar cambio de canción por el título que ya muestra la app
    // (mismo sondeo de 600 ms que lyrics.js / karaoke.js): actualiza
    // el botón y, si la vista está abierta, recarga la letra de la
    // nueva canción.
    var last = '';
    setInterval(function () {
      try {
        updateButton();
        var cur = currentTrackKey();
        if (cur !== last) {
          last = cur;
          if (state.open) loadForCurrentTrack();
        }
      } catch (e) { /* el sondeo nunca debe romper la app */ }
    }, 600);
    updateButton();
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
      parseLRC: parseLRC,
      plainLines: plainLines,
      plainText: plainText,
      splitStanzas: splitStanzas,
      keyFor: keyFor,
      hasTrack: hasTrack,
      getLyricsState: getLyricsState,
      NO_TRACK_TITLE: NO_TRACK_TITLE
    };
  }
  if (typeof window !== 'undefined') {
    window.__lecturaParse = parseLRC;
    window.__lecturaPlainLines = plainLines;
    window.__lecturaOpen = open;
    window.__lecturaClose = close;
  }
})();
