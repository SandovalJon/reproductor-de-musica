/* Mini reproductor flotante para Reproductor de Música — v3.4.0.
   Módulo aparte: NO toca index.html ni la lógica de reproducción.
   Se engancha solo por DOM a lo que ya existe en la app:
     <audio id="audio">, #nowTitle, #nowArtist, #coverImg,
     #coverFallback, #coverInitial, #btnPlay, #btnPrev, #btnNext.
   Sus botones NO reproducen nada por su cuenta: hacen click en los
   botones reales de la app, así que respetan cola, crossfade, DJ,
   aleatorio y todo lo demás sin duplicar lógica.

   Qué hace:
   - Un mini reproductor chiquito siempre visible (cuando el usuario
     lo abre): portada, título, artista, anterior / play-pausa /
     siguiente y ✕ para cerrarlo. Se sincroniza con lo que suena
     observando #nowTitle / #nowArtist / #coverImg y los eventos
     play/pause del <audio>; nunca lee el estado interno de la app.
   - Se arrastra por la pantalla con ratón o con el dedo (Pointer
     Events) y su posición + si estaba abierto se guardan en
     localStorage ('reproductor-mini-float:v1').
   - Se abre/minimiza desde el reproductor grande con el botón
     "Minimizar" que el propio módulo crea junto a #btnMiniPlayer,
     y se cierra con su ✕ (la música sigue sonando). Volver a abrir
     lo restaura en su última posición.
   - Por defecto va en una esquina, con z-index 55 — POR DEBAJO de
     #lyricsBtn (60), #lyricsPanel (61), #mejorasMenuBtn (61) y
     #mejorasMiniBar (62) — así nunca tapa los botones importantes.
     En móvil (<=1023px) su posición por defecto y su zona de
     arrastre dejan libre la franja inferior (mini barra + pestañas
     + botón "☰ Secciones" + botón de Letras).
   - Sin usarlo, nada cambia: por defecto está cerrado y no crea
     nada visible salvo el botón "Minimizar". Si este módulo falla,
     la app sigue funcionando (todo va dentro de try/catch).

   No confundir con el mini reproductor que YA trae la app:
   #btnMiniPlayer abre una ventana Document Picture-in-Picture
   (solo PC y solo si el navegador lo soporta). Este módulo es un
   mini DENTRO de la página, funciona también en móvil y convive
   con aquel: usa IDs con prefijo rpmMini* para no chocar con
   miniTitle/miniPlay/miniPrev/miniNext (ventana PiP) ni con
   mejorasMini* (barra móvil de mejoras.js).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./mini.css">
     <script src="./mini.js"></script>
   Pruebas Node: node --test mini.test.mjs
   Prueba desde la consola:
     window.__rpmMiniOpen() / window.__rpmMiniClose()
     window.__rpmMiniState()  // { open, x, y, playing, title } */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var STORAGE_KEY = 'reproductor-mini-float:v1';
  var NO_TRACK_TITLE = 'Ninguna canción seleccionada';
  var EMPTY_ARTIST = 'Añade archivos de audio para empezar';
  var MARGIN = 8;              // margen mínimo al borde de la ventana
  var MOBILE_MAX_WIDTH = 1023; // mismo corte que mejoras.css
  // Franja inferior reservada en móvil: mini barra (~64) + pestañas
  // (~54, a bottom:64) + botón "☰ Secciones" (bottom:128) + botón de
  // Letras (bottom:180) + un poco de aire. El mini no puede bajar de ahí.
  var MOBILE_RESERVED_BOTTOM = 232;
  var MINI_WIDTH = 300;        // ancho del mini (CSS); alto aprox. 76
  var MINI_HEIGHT = 76;
  var CLICK_SLOP = 6;          // px: por debajo es clic, por encima arrastre

  function isMobileViewport(vw) { return vw <= MOBILE_MAX_WIDTH; }

  /* Posición por defecto: esquina inferior derecha en escritorio;
     en móvil, arriba de la franja inferior reservada. Devuelve
     {x, y} en px (esquina superior izquierda del mini). */
  function defaultPosition(vw, vh) {
    var w = Math.min(MINI_WIDTH, vw - MARGIN * 2);
    if (isMobileViewport(vw)) {
      return { x: Math.max(MARGIN, vw - w - 12), y: Math.max(MARGIN, vh - MOBILE_RESERVED_BOTTOM - MINI_HEIGHT) };
    }
    return { x: Math.max(MARGIN, vw - w - 16), y: Math.max(MARGIN, vh - MINI_HEIGHT - 16) };
  }

  /* Limita una posición para que el mini quede entero dentro de la
     ventana, sin invadir la franja inferior reservada en móvil.
     w/h son el tamaño real del mini; vw/vh el viewport. */
  function clampPosition(x, y, w, h, vw, vh) {
    var maxX = Math.max(MARGIN, vw - w - MARGIN);
    var bottomReserve = isMobileViewport(vw) ? MOBILE_RESERVED_BOTTOM : MARGIN;
    var maxY = Math.max(MARGIN, vh - bottomReserve - h);
    return {
      x: Math.min(Math.max(MARGIN, x), maxX),
      y: Math.min(Math.max(MARGIN, y), maxY)
    };
  }

  /* Arrastre: estado inmutable-ish {startX, startY, origX, origY, moved}.
     dragMove devuelve la nueva posición ya limitada. */
  function dragStart(pointerX, pointerY, posX, posY) {
    return { startX: pointerX, startY: pointerY, origX: posX, origY: posY, moved: false };
  }
  function dragMove(state, pointerX, pointerY, w, h, vw, vh) {
    var dx = pointerX - state.startX;
    var dy = pointerY - state.startY;
    if (Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP) state.moved = true;
    return clampPosition(state.origX + dx, state.origY + dy, w, h, vw, vh);
  }
  function dragWasClick(state) { return !state.moved; }

  /* Persistencia: el estado guardado es {x, y, open}. Todo lo que
     venga roto, incompleto o fuera de pantalla se descarta o se limita;
     nunca se rompe por un valor viejo. */
  function serializePosition(state) {
    return JSON.stringify({ x: Math.round(state.x), y: Math.round(state.y), open: !!state.open });
  }
  function parseStoredPosition(raw, vw, vh) {
    if (!raw) return null;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.x !== 'number' || typeof obj.y !== 'number' ||
        !isFinite(obj.x) || !isFinite(obj.y)) return null;
    var pos = clampPosition(obj.x, obj.y, MINI_WIDTH, MINI_HEIGHT, vw, vh);
    return { x: pos.x, y: pos.y, open: obj.open === true };
  }
  function loadStoredPosition(storage, vw, vh) {
    if (!storage) return null;
    var raw = null;
    try { raw = storage.getItem(STORAGE_KEY); } catch (e) { return null; }
    return parseStoredPosition(raw, vw, vh);
  }
  function saveStoredPosition(storage, state) {
    if (!storage) return false;
    try { storage.setItem(STORAGE_KEY, serializePosition(state)); return true; }
    catch (e) { return false; }
  }

  /* Sincronización de estado: a partir de una foto del DOM de la app
     decide qué debe mostrar el mini. No toca el DOM, solo calcula.
     snap: {title, artist, coverSrc, coverVisible, fallbackInitial,
            fallbackBg, paused, playDisabled} */
  function resolveTrackState(snap) {
    var s = snap || {};
    var title = String(s.title || '').trim() || NO_TRACK_TITLE;
    var artist = String(s.artist || '').trim();
    if (title === NO_TRACK_TITLE && !artist) artist = '';
    else if (!artist && title !== NO_TRACK_TITLE) artist = '';
    var hasTrack = title !== NO_TRACK_TITLE;
    var cover;
    if (s.coverVisible && s.coverSrc) {
      cover = { kind: 'img', src: s.coverSrc, initial: '', background: '' };
    } else {
      cover = {
        kind: 'fallback',
        src: '',
        initial: String(s.fallbackInitial || '').trim().charAt(0).toUpperCase() ||
          (hasTrack ? title.charAt(0).toUpperCase() : '♪'),
        background: String(s.fallbackBg || '') ||
          'linear-gradient(145deg,#2B2118,#E94E1B)'
      };
    }
    return {
      title: title,
      artist: hasTrack ? artist : '',
      emptyHint: hasTrack ? '' : EMPTY_ARTIST,
      cover: cover,
      playing: s.paused === false, // sin dato explícito, no se asume que suena
      controlsDisabled: !!s.playDisabled
    };
  }
  function playIconFor(playing) { return playing ? '⏸' : '▶'; }

  /* ================= Parte DOM (solo navegador) ================= */

  var IDS = {
    root: 'rpmMiniFloat',
    cover: 'rpmMiniCover',
    coverFb: 'rpmMiniCoverFb',
    title: 'rpmMiniTitle',
    artist: 'rpmMiniArtist',
    prev: 'rpmMiniPrev',
    play: 'rpmMiniPlay',
    next: 'rpmMiniNext',
    close: 'rpmMiniClose',
    openBtn: 'rpmMiniOpenBtn'
  };

  function $(id) { return document.getElementById(id); }
  function appBtn(id) { var b = $(id); return b || null; }
  function clickAppButton(id) {
    var b = appBtn(id);
    if (!b || b.disabled) return false;
    try { b.click(); return true; } catch (e) { return false; }
  }

  var root = null;       // el mini flotante
  var openBtn = null;    // botón "Minimizar" en el reproductor grande
  var pos = null;        // {x, y} actuales
  var isOpen = false;
  var drag = null;

  function readSnapshot() {
    var audio = $('audio');
    var nowTitle = $('nowTitle');
    var nowArtist = $('nowArtist');
    var coverImg = $('coverImg');
    var coverFb = $('coverFallback');
    var coverInitial = $('coverInitial');
    var btnPlay = $('btnPlay');
    var coverVisible = false;
    var coverSrc = '';
    if (coverImg) {
      var cs = window.getComputedStyle ? window.getComputedStyle(coverImg) : null;
      coverVisible = cs ? cs.display !== 'none' : coverImg.style.display !== 'none';
      coverSrc = coverImg.getAttribute('src') || coverImg.src || '';
      // Un src vacío o el de la propia página no es portada.
      if (!coverSrc || coverSrc === window.location.href) { coverVisible = false; coverSrc = ''; }
    }
    var fbBg = '';
    if (coverFb) {
      fbBg = coverFb.style.background || '';
      if (!fbBg && window.getComputedStyle) {
        try { fbBg = window.getComputedStyle(coverFb).background || ''; } catch (e) { /* noop */ }
      }
    }
    return {
      title: nowTitle ? nowTitle.textContent : '',
      artist: nowArtist ? nowArtist.textContent : '',
      coverSrc: coverSrc,
      coverVisible: coverVisible,
      fallbackInitial: coverInitial ? coverInitial.textContent : '',
      fallbackBg: fbBg,
      paused: audio ? !!audio.paused : true,
      playDisabled: btnPlay ? !!btnPlay.disabled : true
    };
  }

  function applyState(state) {
    if (!root) return;
    var titleEl = $(IDS.title);
    var artistEl = $(IDS.artist);
    var img = $(IDS.cover);
    var fb = $(IDS.coverFb);
    var playBtn = $(IDS.play);
    if (titleEl) titleEl.textContent = state.title;
    if (artistEl) artistEl.textContent = state.artist || state.emptyHint;
    if (img && fb) {
      if (state.cover.kind === 'img') {
        if (img.getAttribute('src') !== state.cover.src) img.setAttribute('src', state.cover.src);
        img.style.display = 'block';
        fb.style.display = 'none';
      } else {
        img.style.display = 'none';
        img.removeAttribute('src');
        fb.style.display = 'flex';
        fb.textContent = state.cover.initial;
        fb.style.background = state.cover.background;
      }
    }
    if (playBtn) {
      playBtn.textContent = playIconFor(state.playing);
      playBtn.setAttribute('aria-label', state.playing ? 'Pausar' : 'Reproducir');
    }
    [IDS.prev, IDS.play, IDS.next].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = state.controlsDisabled;
    });
    root.classList.toggle('rpm-mini-playing', !!state.playing);
    root.classList.toggle('rpm-mini-empty', !state.title || state.title === NO_TRACK_TITLE);
  }

  function sync() {
    try { applyState(resolveTrackState(readSnapshot())); } catch (e) { /* el mini nunca rompe la app */ }
  }

  function place() {
    if (!root || !pos) return;
    var clamped = clampPosition(pos.x, pos.y, root.offsetWidth || MINI_WIDTH,
      root.offsetHeight || MINI_HEIGHT, window.innerWidth, window.innerHeight);
    pos = clamped;
    root.style.left = clamped.x + 'px';
    root.style.top = clamped.y + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function save() {
    if (!pos) return;
    saveStoredPosition(window.localStorage, { x: pos.x, y: pos.y, open: isOpen });
  }

  function setOpen(open, opts) {
    opts = opts || {};
    if (!root) return;
    isOpen = !!open;
    root.classList.toggle('open', isOpen);
    root.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (openBtn) {
      openBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
      openBtn.textContent = isOpen ? 'Volver al reproductor' : 'Minimizar';
      openBtn.title = isOpen
        ? 'El mini reproductor está abierto; toca para volver al reproductor grande'
        : 'Minimizar a un mini reproductor flotante';
    }
    if (isOpen) {
      place();
      sync();
      if (!opts.silent) save();
    } else if (!opts.silent) {
      save();
    }
  }

  function open() { setOpen(true); }
  function close() {
    setOpen(false);
    if (openBtn) { try { openBtn.focus(); } catch (e) { /* noop */ } }
  }

  function buildRoot() {
    if ($(IDS.root)) return $(IDS.root);
    var el = document.createElement('div');
    el.id = IDS.root;
    el.className = 'rpm-mini';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Mini reproductor flotante');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="rpm-mini-cov">' +
        '<div class="rpm-mini-cover" id="' + IDS.coverFb + '" aria-hidden="true">♪</div>' +
        '<img class="rpm-mini-cover-img" id="' + IDS.cover + '" alt="" style="display:none" />' +
      '</div>' +
      '<div class="rpm-mini-mid" data-rpm-drag>' +
        '<div class="rpm-mini-title" id="' + IDS.title + '">' + NO_TRACK_TITLE + '</div>' +
        '<div class="rpm-mini-artist" id="' + IDS.artist + '">' + EMPTY_ARTIST + '</div>' +
      '</div>' +
      '<div class="rpm-mini-controls">' +
        '<button type="button" class="rpm-mini-btn" id="' + IDS.prev + '" aria-label="Canción anterior">⏮</button>' +
        '<button type="button" class="rpm-mini-btn rpm-mini-play" id="' + IDS.play + '" aria-label="Reproducir o pausar">▶</button>' +
        '<button type="button" class="rpm-mini-btn" id="' + IDS.next + '" aria-label="Canción siguiente">⏭</button>' +
      '</div>' +
      '<button type="button" class="rpm-mini-close" id="' + IDS.close + '" aria-label="Cerrar mini reproductor">✕</button>';
    document.body.appendChild(el);
    return el;
  }

  function buildOpenButton() {
    if ($(IDS.openBtn)) return $(IDS.openBtn);
    var b = document.createElement('button');
    b.id = IDS.openBtn;
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = 'Minimizar';
    b.title = 'Minimizar a un mini reproductor flotante';
    b.setAttribute('aria-pressed', 'false');
    // Junto a #btnMiniPlayer (ventana PiP), en la misma fila de botones
    // del reproductor grande. Si no está, al final del cuerpo del player.
    var anchor = $('btnMiniPlayer');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(b, anchor.nextSibling);
    } else {
      var body = document.querySelector('.player-card .player-body') ||
        document.querySelector('.player-card');
      if (body) body.appendChild(b);
      else document.body.appendChild(b);
    }
    return b;
  }

  function onPointerDown(e) {
    if (!root || !isOpen || e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button')) return; // los botones no arrastran
    var handle = e.target.closest('[data-rpm-drag], .rpm-mini-cov');
    if (!handle) return;
    try {
      drag = dragStart(e.clientX, e.clientY, pos.x, pos.y);
      root.classList.add('dragging');
      if (root.setPointerCapture && e.pointerId !== undefined) {
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      }
      e.preventDefault();
    } catch (err) { drag = null; }
  }
  function onPointerMove(e) {
    if (!drag || !root) return;
    pos = dragMove(drag, e.clientX, e.clientY,
      root.offsetWidth || MINI_WIDTH, root.offsetHeight || MINI_HEIGHT,
      window.innerWidth, window.innerHeight);
    root.style.left = pos.x + 'px';
    root.style.top = pos.y + 'px';
  }
  function onPointerUp(e) {
    if (!drag) return;
    var wasClick = dragWasClick(drag);
    var target = e.target;
    drag = null;
    if (root) root.classList.remove('dragging');
    if (wasClick && target && target.closest && target.closest('[data-rpm-drag]')) {
      // Clic (sin arrastrar) sobre título/artista: subir al reproductor grande.
      var card = document.querySelector('.player-card');
      if (card) { try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) { /* noop */ } }
    } else if (!wasClick) {
      save();
    }
  }

  function watchApp() {
    var audio = $('audio');
    if (audio) {
      ['play', 'pause', 'ended', 'emptied'].forEach(function (ev) {
        audio.addEventListener(ev, sync);
      });
    }
    if (typeof MutationObserver === 'function') {
      var obs = new MutationObserver(function () { sync(); });
      ['nowTitle', 'nowArtist', 'coverImg', 'coverFallback', 'coverInitial'].forEach(function (id) {
        var el = $(id);
        if (el) {
          try {
            obs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
          } catch (e) { /* noop */ }
        }
      });
      // Si la app vuelve a pintar la portada más tarde, el observador ya la cubre.
    }
    window.addEventListener('resize', function () { if (isOpen) place(); });
  }

  function init() {
    try {
      root = buildRoot();
      openBtn = buildOpenButton();
      var vw = window.innerWidth, vh = window.innerHeight;
      var stored = loadStoredPosition(window.localStorage, vw, vh);
      pos = stored ? { x: stored.x, y: stored.y } : defaultPosition(vw, vh);
      // Sin usarlo, nada cambia: por defecto cerrado salvo que el
      // usuario lo dejara abierto en su última visita.
      setOpen(stored ? stored.open : false, { silent: true });
      place();

      openBtn.addEventListener('click', function () { setOpen(!isOpen); });
      $(IDS.prev).addEventListener('click', function () { clickAppButton('btnPrev'); });
      $(IDS.next).addEventListener('click', function () { clickAppButton('btnNext'); });
      $(IDS.play).addEventListener('click', function () { clickAppButton('btnPlay'); });
      $(IDS.close).addEventListener('click', function () { close(); });
      root.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
      });
      root.addEventListener('pointerdown', onPointerDown);
      root.addEventListener('pointermove', onPointerMove);
      root.addEventListener('pointerup', onPointerUp);
      root.addEventListener('pointercancel', function () {
        drag = null;
        root.classList.remove('dragging');
      });
      watchApp();
      sync();
    } catch (e) {
      /* Si el mini falla al arrancar, la app sigue funcionando. */
    }
  }

  /* Exporta el núcleo puro para Node (mini.test.mjs) y deja
     controles en window para probar desde la consola. */
  var api = {
    STORAGE_KEY: STORAGE_KEY,
    NO_TRACK_TITLE: NO_TRACK_TITLE,
    MOBILE_RESERVED_BOTTOM: MOBILE_RESERVED_BOTTOM,
    MINI_WIDTH: MINI_WIDTH,
    MINI_HEIGHT: MINI_HEIGHT,
    isMobileViewport: isMobileViewport,
    defaultPosition: defaultPosition,
    clampPosition: clampPosition,
    dragStart: dragStart,
    dragMove: dragMove,
    dragWasClick: dragWasClick,
    serializePosition: serializePosition,
    parseStoredPosition: parseStoredPosition,
    loadStoredPosition: loadStoredPosition,
    saveStoredPosition: saveStoredPosition,
    resolveTrackState: resolveTrackState,
    playIconFor: playIconFor
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    window.__rpmMini = api;
    window.__rpmMiniOpen = open;
    window.__rpmMiniClose = close;
    window.__rpmMiniState = function () {
      var s = null;
      try { s = resolveTrackState(readSnapshot()); } catch (e) { s = null; }
      return { open: isOpen, x: pos ? pos.x : null, y: pos ? pos.y : null, playing: s ? s.playing : null, title: s ? s.title : null };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
