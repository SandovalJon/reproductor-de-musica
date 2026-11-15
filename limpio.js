/* Modo pantalla limpia para Reproductor de Música — v3.7.0.
   Módulo aparte: NO toca app/ ni la lógica de reproducción.
   Se engancha solo por DOM a lo que ya existe en la app:
     <audio id="audio">, #nowTitle, #nowArtist, #coverImg,
     #coverFallback, #coverInitial, #btnPlay, #btnPrev, #btnNext,
     #volume.
   Sus botones NO reproducen nada por su cuenta: hacen click en los
   botones reales de la app, así que respetan cola, crossfade, DJ,
   aleatorio y todo lo demás sin duplicar lógica. El volumen escribe
   en #volume y dispara sus eventos 'input'/'change', como si el
   usuario moviera el deslizador de la app.

   Qué hace:
   - Un botón "Pantalla limpia" (creado por el módulo junto a
     #btnParty, en la fila de modos del reproductor) abre un overlay
     a pantalla completa con SOLO: portada grande, título, artista
     y controles básicos (anterior / play-pausa / siguiente,
     volumen, cerrar). Nada más: ni lista, ni pestañas, ni paneles.
   - Se sale con Esc o con el botón ✕. Al salir, la app queda
     exactamente como estaba: el overlay es un elemento propio que
     se oculta (nunca se oculta ni se toca nada de la app); solo se
     restaura el overflow del body y el foco que había antes.
   - Sin canción cargada muestra el estado vacío (título y pista de
     la app, controles de pista desactivados) sin fallar.
   - Respeta prefers-reduced-motion: sin transiciones ni
     animaciones (ver limpio.css).
   - Si el módulo falla al cargar o al arrancar, la app sigue
     igual: todo el init y el sync van en try/catch, y cada acceso
     a un elemento de la app comprueba que existe antes de usarlo.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./limpio.css">
     <script src="./limpio.js"></script>
   Pruebas Node: node --test limpio.test.mjs
   Prueba desde la consola:
     window.__rpmLimpioOpen() / window.__rpmLimpioClose()
     window.__rpmLimpioState()  // { open, hasTrack, playing, title } */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var NO_TRACK_TITLE = 'Ninguna canción seleccionada';
  var EMPTY_ARTIST = 'Añade archivos de audio para empezar';
  var EMPTY_HINT = 'Añade archivos de audio para empezar a escuchar sin distracciones.';

  /* Título vacío = el texto por defecto de la app, o nada. */
  function isEmptyTitle(title) {
    if (title == null) return true;
    var t = String(title).trim();
    return t === '' || t === NO_TRACK_TITLE;
  }

  /* Volumen siempre entre 0 y 100, entero. Acepta números, texto
     numérico y valores fuera de rango; lo que no es número es 100
     (el valor por defecto de #volume en la app). */
  function clampVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) return 100;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return Math.round(n);
  }

  /* prefers-reduced-motion: recibe el resultado de
     matchMedia('(prefers-reduced-motion: reduce)').matches (o nada).
     El CSS hace el trabajo pesado; esto solo lo expone para tests
     y para no animar nada desde JS (que no anima nada). */
  function reducedMotionEnabled(matches) {
    return matches === true;
  }

  /* Convierte una foto del estado real de la app en el estado que
     muestra la vista limpia. snapshot:
       { title, artist, coverSrc, coverVisible, fallbackInitial,
         fallbackBg, paused, playDisabled, volume }
     Todos los campos son opcionales: faltar = estado vacío. */
  function resolveTrackState(snap) {
    var s = snap || {};
    var title = s.title != null ? String(s.title).trim() : '';
    var artist = s.artist != null ? String(s.artist).trim() : '';
    var hasTrack = !isEmptyTitle(title);
    var coverSrc = (s.coverVisible && s.coverSrc) ? String(s.coverSrc) : null;
    return {
      hasTrack: hasTrack,
      title: hasTrack ? title : NO_TRACK_TITLE,
      artist: hasTrack ? artist : EMPTY_ARTIST,
      hint: EMPTY_HINT,
      coverSrc: coverSrc,
      fallbackInitial: s.fallbackInitial != null ? String(s.fallbackInitial) : '♪',
      fallbackBg: s.fallbackBg != null ? String(s.fallbackBg) : '',
      playing: hasTrack && s.paused === false,
      playDisabled: !hasTrack || s.playDisabled === true,
      volume: clampVolume(s.volume)
    };
  }

  /* Qué se muestra y qué se oculta para un estado dado. Es la
     única fuente de verdad de visibilidad: el DOM solo la aplica.
     state: { open, track } con track = resolveTrackState(...). */
  function computeView(state) {
    var st = state || {};
    var open = st.open === true;
    var track = st.track || resolveTrackState(null);
    return {
      overlayHidden: !open,
      overlayOpen: open,
      emptyHidden: !open || track.hasTrack,
      trackHidden: !open || !track.hasTrack,
      playDisabled: track.playDisabled,
      prevDisabled: track.playDisabled,
      nextDisabled: track.playDisabled,
      playLabel: track.playing ? 'Pausar' : 'Reproducir',
      playIcon: track.playing ? 'pause' : 'play',
      showCoverImg: track.hasTrack && !!track.coverSrc,
      volume: track.volume
    };
  }

  /* Esc cierra la vista solo si está abierta; cualquier otra tecla
     (o Esc con la vista cerrada) no hace nada. */
  function shouldCloseOnKey(key, isOpen) {
    return isOpen === true && key === 'Escape';
  }

  /* Máquina de estados abierto/cerrado, sin DOM. */
  function createStateMachine() {
    var open = false;
    return {
      isOpen: function () { return open; },
      open: function () { open = true; return open; },
      close: function () { open = false; return open; },
      toggle: function () { open = !open; return open; },
      onKey: function (key) {
        if (shouldCloseOnKey(key, open)) open = false;
        return open;
      }
    };
  }

  /* ================= Parte DOM (solo navegador) ================= */

  var IDS = {
    overlay: 'rpmLimpioOverlay',
    cover: 'rpmLimpioCover',
    coverFb: 'rpmLimpioCoverFb',
    title: 'rpmLimpioTitle',
    artist: 'rpmLimpioArtist',
    empty: 'rpmLimpioEmpty',
    track: 'rpmLimpioTrack',
    prev: 'rpmLimpioPrev',
    play: 'rpmLimpioPlay',
    playIcon: 'rpmLimpioPlayIcon',
    next: 'rpmLimpioNext',
    vol: 'rpmLimpioVol',
    close: 'rpmLimpioClose',
    openBtn: 'rpmLimpioOpenBtn'
  };

  var machine = createStateMachine();
  var lastFocus = null;      // elemento con foco antes de abrir
  var savedBodyOverflow = ''; // overflow del body antes de abrir

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function clickAppButton(id) {
    try {
      var b = $(id);
      if (b && !b.disabled) b.click();
    } catch (e) { /* botón ausente: no rompe nada */ }
  }

  /* Foto del estado real de la app, tolerante a elementos ausentes. */
  function readSnapshot() {
    var titleEl = $('nowTitle'), artistEl = $('nowArtist');
    var coverImg = $('coverImg'), coverFb = $('coverFallback');
    var coverInitial = $('coverInitial');
    var audio = $('audio'), btnPlay = $('btnPlay'), vol = $('volume');
    var coverVisible = false, coverSrc = '';
    try {
      if (coverImg) {
        coverSrc = coverImg.getAttribute('src') || '';
        var disp = coverImg.style ? coverImg.style.display : '';
        coverVisible = disp !== 'none' && coverSrc !== '';
      }
    } catch (e) { coverVisible = false; }
    var volVal = 100;
    try { if (vol) volVal = vol.value; } catch (e) { volVal = 100; }
    return {
      title: titleEl ? titleEl.textContent : '',
      artist: artistEl ? artistEl.textContent : '',
      coverSrc: coverSrc,
      coverVisible: coverVisible,
      fallbackInitial: coverInitial ? coverInitial.textContent : '♪',
      fallbackBg: (coverFb && coverFb.style) ? (coverFb.style.background || '') : '',
      paused: audio ? !!audio.paused : true,
      playDisabled: btnPlay ? !!btnPlay.disabled : true,
      volume: volVal
    };
  }

  /* Aplica computeView() al overlay real. No toca nada de la app. */
  function render() {
    var overlay = $(IDS.overlay);
    if (!overlay) return;
    var track = resolveTrackState(readSnapshot());
    var view = computeView({ open: machine.isOpen(), track: track });
    try {
      overlay.hidden = view.overlayHidden;
      overlay.classList.toggle('on', view.overlayOpen);
      overlay.setAttribute('aria-hidden', view.overlayHidden ? 'true' : 'false');
      var titleEl = $(IDS.title), artistEl = $(IDS.artist);
      var emptyEl = $(IDS.empty), trackEl = $(IDS.track);
      var coverEl = $(IDS.cover), coverFbEl = $(IDS.coverFb);
      var prevBtn = $(IDS.prev), playBtn = $(IDS.play), nextBtn = $(IDS.next);
      var volEl = $(IDS.vol), playIcon = $(IDS.playIcon);
      if (titleEl) titleEl.textContent = track.title;
      if (artistEl) artistEl.textContent = track.artist;
      if (emptyEl) emptyEl.hidden = view.emptyHidden;
      if (trackEl) trackEl.hidden = view.trackHidden;
      if (coverEl) {
        if (view.showCoverImg) {
          coverEl.setAttribute('src', track.coverSrc);
          coverEl.style.display = '';
        } else {
          coverEl.removeAttribute('src');
          coverEl.style.display = 'none';
        }
      }
      if (coverFbEl) {
        coverFbEl.style.display = view.showCoverImg ? 'none' : '';
        if (track.fallbackBg) coverFbEl.style.background = track.fallbackBg;
        coverFbEl.textContent = track.fallbackInitial;
      }
      if (prevBtn) prevBtn.disabled = view.prevDisabled;
      if (nextBtn) nextBtn.disabled = view.nextDisabled;
      if (playBtn) {
        playBtn.disabled = view.playDisabled;
        playBtn.setAttribute('aria-label', view.playLabel);
      }
      if (playIcon) playIcon.textContent = view.playIcon === 'pause' ? '❚❚' : '▶';
      if (volEl && Number(volEl.value) !== view.volume) volEl.value = String(view.volume);
    } catch (e) { /* render parcial: la app sigue igual */ }
  }

  function open() {
    if (machine.isOpen()) return;
    try { lastFocus = document.activeElement; } catch (e) { lastFocus = null; }
    try { savedBodyOverflow = document.body ? document.body.style.overflow : ''; } catch (e) { savedBodyOverflow = ''; }
    machine.open();
    try { if (document.body) document.body.style.overflow = 'hidden'; } catch (e) { /* sin body: nada */ }
    render();
    try {
      var closeBtn = $(IDS.close);
      if (closeBtn) closeBtn.focus();
    } catch (e) { /* foco opcional */ }
    updateOpenBtn();
  }

  function close() {
    if (!machine.isOpen()) return;
    machine.close();
    render();
    try { if (document.body) document.body.style.overflow = savedBodyOverflow; } catch (e) { /* nada */ }
    try {
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    } catch (e) { /* foco opcional */ }
    lastFocus = null;
    updateOpenBtn();
  }

  function updateOpenBtn() {
    try {
      var b = $(IDS.openBtn);
      if (b) b.setAttribute('aria-pressed', machine.isOpen() ? 'true' : 'false');
    } catch (e) { /* nada */ }
  }

  function buildOverlay() {
    if ($(IDS.overlay)) return;
    var overlay = document.createElement('div');
    overlay.id = IDS.overlay;
    overlay.className = 'rpm-limpio';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Pantalla limpia');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<button class="rpm-limpio-close" id="' + IDS.close + '" type="button" aria-label="Salir de la pantalla limpia">✕</button>' +
      '<div class="rpm-limpio-inner">' +
        '<div class="rpm-limpio-cover-wrap">' +
          '<div class="rpm-limpio-cover-fb" id="' + IDS.coverFb + '">♪</div>' +
          '<img class="rpm-limpio-cover" id="' + IDS.cover + '" alt="Portada del álbum" style="display:none" />' +
        '</div>' +
        '<div class="rpm-limpio-track" id="' + IDS.track + '">' +
          '<h2 class="rpm-limpio-title" id="' + IDS.title + '">' + NO_TRACK_TITLE + '</h2>' +
          '<p class="rpm-limpio-artist" id="' + IDS.artist + '">' + EMPTY_ARTIST + '</p>' +
        '</div>' +
        '<p class="rpm-limpio-empty" id="' + IDS.empty + '" hidden>' + EMPTY_HINT + '</p>' +
        '<div class="rpm-limpio-controls">' +
          '<button class="rpm-limpio-btn" id="' + IDS.prev + '" type="button" aria-label="Canción anterior">⏮</button>' +
          '<button class="rpm-limpio-play" id="' + IDS.play + '" type="button" aria-label="Reproducir"><span id="' + IDS.playIcon + '">▶</span></button>' +
          '<button class="rpm-limpio-btn" id="' + IDS.next + '" type="button" aria-label="Canción siguiente">⏭</button>' +
        '</div>' +
        '<div class="rpm-limpio-vol">' +
          '<span aria-hidden="true">🔊</span>' +
          '<input type="range" id="' + IDS.vol + '" min="0" max="100" value="100" aria-label="Volumen" />' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function buildOpenButton() {
    if ($(IDS.openBtn)) return;
    var btn = document.createElement('button');
    btn.id = IDS.openBtn;
    btn.type = 'button';
    btn.className = 'btn small';
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Pantalla limpia';
    btn.addEventListener('click', function () {
      if (machine.isOpen()) close(); else open();
    });
    var anchor = $('btnParty');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      return;
    }
    var body = null;
    try { body = document.querySelector('.player-card .player-body'); } catch (e) { body = null; }
    if (body) { body.appendChild(btn); return; }
    document.body.appendChild(btn);
  }

  function onVolumeInput() {
    try {
      var volEl = $(IDS.vol);
      var appVol = $('volume');
      if (!volEl || !appVol) return;
      var v = clampVolume(volEl.value);
      appVol.value = String(v);
      appVol.dispatchEvent(new Event('input', { bubbles: true }));
      appVol.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { /* volumen opcional */ }
  }

  function watchApp() {
    try {
      var audio = $('audio');
      if (audio) {
        audio.addEventListener('play', render);
        audio.addEventListener('pause', render);
        audio.addEventListener('ended', render);
        audio.addEventListener('emptied', render);
      }
      var vol = $('volume');
      if (vol) vol.addEventListener('input', render);
      if (typeof MutationObserver !== 'undefined') {
        var obs = new MutationObserver(function () { if (machine.isOpen()) render(); });
        ['nowTitle', 'nowArtist', 'coverImg'].forEach(function (id) {
          var el = $(id);
          if (el) obs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
        });
      }
    } catch (e) { /* observar es opcional */ }
  }

  function init() {
    try {
      if (typeof document === 'undefined' || !document.body) return;
      buildOverlay();
      buildOpenButton();
      var closeBtn = $(IDS.close);
      if (closeBtn) closeBtn.addEventListener('click', close);
      var prevBtn = $(IDS.prev), playBtn = $(IDS.play), nextBtn = $(IDS.next);
      if (prevBtn) prevBtn.addEventListener('click', function () { clickAppButton('btnPrev'); });
      if (nextBtn) nextBtn.addEventListener('click', function () { clickAppButton('btnNext'); });
      if (playBtn) playBtn.addEventListener('click', function () { clickAppButton('btnPlay'); });
      var volEl = $(IDS.vol);
      if (volEl) volEl.addEventListener('input', onVolumeInput);
      document.addEventListener('keydown', function (e) {
        if (e && shouldCloseOnKey(e.key, machine.isOpen())) close();
      });
      watchApp();
      render();
    } catch (e) {
      /* Si el módulo falla al arrancar, la app sigue funcionando. */
    }
  }

  /* Exporta el núcleo puro para Node (limpio.test.mjs) y deja
     controles en window para probar desde la consola. */
  var api = {
    NO_TRACK_TITLE: NO_TRACK_TITLE,
    EMPTY_ARTIST: EMPTY_ARTIST,
    EMPTY_HINT: EMPTY_HINT,
    isEmptyTitle: isEmptyTitle,
    clampVolume: clampVolume,
    reducedMotionEnabled: reducedMotionEnabled,
    resolveTrackState: resolveTrackState,
    computeView: computeView,
    shouldCloseOnKey: shouldCloseOnKey,
    createStateMachine: createStateMachine
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    window.__rpmLimpio = api;
    window.__rpmLimpioOpen = open;
    window.__rpmLimpioClose = close;
    window.__rpmLimpioState = function () {
      var s = null;
      try { s = resolveTrackState(readSnapshot()); } catch (e) { s = null; }
      return { open: machine.isOpen(), hasTrack: s ? s.hasTrack : null, playing: s ? s.playing : null, title: s ? s.title : null };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
