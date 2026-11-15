/* Modo karaoke para Reproductor de Música — v3.3.0.
   Módulo aparte: no toca index.html ni lyrics.js. Se engancha solo al
   <audio id="audio"> y a #nowTitle / #nowArtist que ya existen, y lee
   la letra de la MISMA clave de localStorage que usa lyrics.js
   ('reproductor-letras:<título> — <artista>'), así que valen las
   letras cargadas con .lrc, pegadas a mano o incrustadas (USLT/SYLT):
   el .lrc externo siempre manda, como ya hace embedded-lyrics.js.

   Qué hace:
   - Botón "Karaoke" (id btnKaraoke; si WIRING.md no se aplicó y no
     existe en index.html, el módulo crea uno flotante como respaldo).
     Solo se muestra cuando hay una canción cargada.
   - Vista a pantalla completa con el Fullscreen API sobre el
     contenedor del karaoke; si el navegador lo rechaza, la vista
     cubre igualmente toda la ventana (position:fixed, inset:0).
   - Letra grande, línea actual resaltada y centrada, avanzando con
     audio.currentTime. Clic en una línea salta a ese momento.
   - Se sale con Esc (también al salir de pantalla completa) o con
     el botón ✕. Sin letra, muestra un aviso claro y no falla.
   - Si cambia la canción mientras la vista está abierta, recarga
     la letra de la nueva canción.

   A prueba de fallos como los demás módulos: cualquier error aquí
   dentro se traga y la app sigue funcionando. Sin red, sin
   dependencias.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./karaoke.css">
     <script src="./karaoke.js"></script>
   Pruebas Node: node --test karaoke.test.mjs
   Prueba desde la consola:
     window.__karaokeParse('[00:05.00] Hola')
     window.__karaokeActiveLine([{t:5,text:'Hola'}], 6)
     window.__karaokeOpen() / window.__karaokeClose() */
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
     de texto se devuelven como letra sin sincronizar (synced:false). */
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

  /* Índice de la línea activa en un instante dado: la última línea
     cuyo tiempo ya llegó (con 0,05 s de tolerancia, como lyrics.js).
     -1 = aún no empezó ninguna línea. */
  function activeLineIndex(lines, time) {
    if (!lines || !lines.length) return -1;
    var t = +time || 0, idx = -1, i;
    for (i = 0; i < lines.length; i++) {
      if (lines[i].t <= t + 0.05) idx = i; else break;
    }
    return idx;
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

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(+sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ================= Pegamento con el navegador ================= */

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var state = {
    open: false,
    data: null,       // { synced, lines } o null si no hay letra
    lyricsState: 'missing',
    current: -1,      // índice de la línea activa
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
    state.data = (state.lyricsState === 'synced' || state.lyricsState === 'plain')
      ? parseLRC(raw) : null;
    state.trackKey = currentTrackKey();
    state.current = -1;
    renderLines();
    renderHeader();
  }

  function renderHeader() {
    var title = $('karaokeTitle'), artist = $('karaokeArtist');
    if (title) title.textContent = ($('nowTitle') ? $('nowTitle').textContent : '') || 'Sin canción';
    if (artist) artist.textContent = $('nowArtist') ? $('nowArtist').textContent : '';
  }

  function renderLines() {
    var box = $('karaokeLines'); if (!box) return;
    box.innerHTML = '';
    if (!state.data || !state.data.lines.length) {
      var note = document.createElement('p');
      note.className = 'karaoke-empty';
      note.textContent = state.lyricsState === 'empty'
        ? 'La letra guardada para esta canción está vacía.'
        : 'Esta canción no tiene letra guardada.';
      box.appendChild(note);
      var hint = document.createElement('p');
      hint.className = 'karaoke-hint';
      hint.textContent = 'Carga un archivo .lrc o pega la letra con tiempos desde el botón ♪ Letras, y vuelve a abrir el karaoke.';
      box.appendChild(hint);
      return;
    }
    if (!state.data.synced) {
      var plainNote = document.createElement('p');
      plainNote.className = 'karaoke-hint';
      plainNote.textContent = 'Letra sin tiempos: se muestra completa (sin resaltado).';
      box.appendChild(plainNote);
    }
    state.data.lines.forEach(function (ln, i) {
      var div = document.createElement('button');
      div.type = 'button';
      div.className = 'karaoke-line';
      div.textContent = ln.text;
      div.setAttribute('data-i', String(i));
      div.addEventListener('click', function () {
        var audio = $('audio'); if (!audio) return;
        try { audio.currentTime = ln.t; } catch (e) {}
        if (audio.paused) audio.play().catch(function () {});
      });
      box.appendChild(div);
    });
    sync(true);
  }

  function sync(force) {
    if (!state.open || !state.data || !state.data.synced) return;
    var audio = $('audio'); if (!audio) return;
    var idx = activeLineIndex(state.data.lines, audio.currentTime || 0);
    if (idx === state.current && !force) return;
    state.current = idx;
    var box = $('karaokeLines'); if (!box) return;
    var prev = box.querySelector('.karaoke-line.active');
    if (prev) prev.classList.remove('active');
    if (idx >= 0) {
      var el = box.querySelector('[data-i="' + idx + '"]');
      if (el) {
        el.classList.add('active');
        var reduced = false;
        try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
        try { el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {
          try { el.scrollIntoView(); } catch (e2) {}
        }
      }
    }
    updateProgress();
  }

  function updateProgress() {
    var audio = $('audio');
    var seek = $('karaokeSeek'), cur = $('karaokeTimeCur'), tot = $('karaokeTimeTot');
    if (!audio) return;
    var dur = audio.duration;
    if (cur) cur.textContent = fmtTime(audio.currentTime || 0);
    if (tot) tot.textContent = isFinite(dur) ? fmtTime(dur) : '0:00';
    if (seek) {
      if (isFinite(dur) && dur > 0) {
        seek.disabled = false;
        if (document.activeElement !== seek) {
          seek.value = String(Math.round((audio.currentTime || 0) / dur * 1000));
        }
      } else { seek.disabled = true; }
    }
    var playBtn = $('karaokePlay');
    if (playBtn) playBtn.textContent = audio.paused ? '▶ Reproducir' : '⏸ Pausar';
  }

  function open() {
    if (state.open) return;
    var view = $('karaokeView'); if (!view) return;
    var audio = $('audio');
    var title = $('nowTitle') ? $('nowTitle').textContent : '';
    if (!audio || !hasTrack(title, audio.src)) return; // sin canción: no abrir
    loadForCurrentTrack();
    state.open = true;
    view.classList.add('open');
    view.setAttribute('aria-hidden', 'false');
    updateProgress();
    // Pantalla completa sobre el contenedor. Si el navegador lo
    // rechaza (p. ej. sin gesto de usuario o no soportado), la vista
    // sigue cubriendo toda la ventana por CSS (.karaoke-view.open).
    try {
      var req = view.requestFullscreen
        || view.webkitRequestFullscreen
        || view.msRequestFullscreen;
      if (req) {
        var p = req.call(view);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
    var closeBtn = $('karaokeClose');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    var view = $('karaokeView');
    if (view) {
      view.classList.remove('open');
      view.setAttribute('aria-hidden', 'true');
    }
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) {}
    var btn = $('btnKaraoke');
    if (btn) btn.focus();
  }

  function updateButton() {
    var btn = $('btnKaraoke'); if (!btn) return;
    var audio = $('audio');
    var title = $('nowTitle') ? $('nowTitle').textContent : '';
    var show = !!audio && hasTrack(title, audio.src);
    btn.style.display = show ? '' : 'none';
    btn.disabled = !show;
  }

  function buildUI() {
    // CSS: el <link> de WIRING.md es la vía principal; si falta
    // (o si el módulo se carga solo), se inyecta aquí como respaldo,
    // igual que hace lyrics.js con lyrics.css.
    try {
      var hasCss = !!document.querySelector('link[href*="karaoke.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './karaoke.css';
        document.head.appendChild(css);
      }
    } catch (e) {}

    // Botón: si index.html ya trae #btnKaraoke (WIRING.md), se usa
    // ese; si no, se crea uno flotante como respaldo.
    var btn = $('btnKaraoke');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnKaraoke'; btn.type = 'button';
      btn.className = 'karaoke-fab';
      btn.textContent = '🎤 Karaoke';
      btn.title = 'Ver la letra a pantalla completa, sincronizada con la canción';
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', open);

    if ($('karaokeView')) { updateButton(); return; }

    var view = document.createElement('div');
    view.id = 'karaokeView';
    view.className = 'karaoke-view';
    view.setAttribute('aria-hidden', 'true');
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-label', 'Modo karaoke');
    view.innerHTML =
      '<div class="karaoke-top">' +
        '<div class="karaoke-titles">' +
          '<strong id="karaokeTitle">Sin canción</strong>' +
          '<span id="karaokeArtist"></span>' +
        '</div>' +
        '<button type="button" id="karaokeClose" class="karaoke-close" aria-label="Salir del karaoke">✕</button>' +
      '</div>' +
      '<div id="karaokeLines" class="karaoke-lines"></div>' +
      '<div class="karaoke-foot">' +
        '<button type="button" id="karaokePlay" class="karaoke-play">▶ Reproducir</button>' +
        '<span id="karaokeTimeCur" class="karaoke-time">0:00</span>' +
        '<input type="range" id="karaokeSeek" min="0" max="1000" value="0" step="1" aria-label="Progreso de la canción">' +
        '<span id="karaokeTimeTot" class="karaoke-time">0:00</span>' +
      '</div>';
    document.body.appendChild(view);

    $('karaokeClose').addEventListener('click', close);
    $('karaokePlay').addEventListener('click', function () {
      var audio = $('audio'); if (!audio) return;
      if (audio.paused) audio.play().catch(function () {});
      else audio.pause();
      updateProgress();
    });
    $('karaokeSeek').addEventListener('input', function (e) {
      var audio = $('audio'); if (!audio) return;
      var dur = audio.duration;
      if (isFinite(dur) && dur > 0) {
        try { audio.currentTime = (+e.target.value / 1000) * dur; } catch (err) {}
      }
    });

    var audio = $('audio');
    if (audio) {
      audio.addEventListener('timeupdate', function () { sync(false); });
      audio.addEventListener('play', updateProgress);
      audio.addEventListener('pause', updateProgress);
      audio.addEventListener('loadedmetadata', updateProgress);
    }

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
    // (mismo sondeo de 600 ms que lyrics.js): actualiza el botón y,
    // si la vista está abierta, recarga la letra de la nueva canción.
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
      activeLineIndex: activeLineIndex,
      keyFor: keyFor,
      hasTrack: hasTrack,
      getLyricsState: getLyricsState,
      fmtTime: fmtTime,
      NO_TRACK_TITLE: NO_TRACK_TITLE
    };
  }
  if (typeof window !== 'undefined') {
    window.__karaokeParse = parseLRC;
    window.__karaokeActiveLine = activeLineIndex;
    window.__karaokeOpen = open;
    window.__karaokeClose = close;
  }
})();
