/* Luces de modo fiesta (v3.6.0) — módulo aparte.
   AÑADE luces que cambian al ritmo real de la música dentro del modo
   fiesta (#partyOverlay) que ya existe en index.html. NO reemplaza
   nada: el fondo del overlay lo sigue poniendo setPartyColors() de la
   app, el visualizador #partyViz lo sigue dibujando drawPartyViz() y
   los controles de fiesta (#btnPartyPlay / Prev / Next / Close) no se
   tocan. Sin cablear (WIRING.md §1), luces.js ni siquiera se carga y
   la app es byte-idéntica a 3.5.0.

   CÓMO FUNCIONA:
   - Un div #rpmLuces, creado por JS como primer hijo de #partyOverlay,
     con position:absolute, inset:0, z-index:0 y pointer-events:none.
     Queda POR ENCIMA del fondo del overlay (que es el background del
     propio #partyOverlay) y POR DEBAJO de todo el contenido: luces.css
     sube cada hijo de contenido a position:relative + z-index:1 (y el
     botón de cerrar a z-index:2). Las luces nunca tapan texto ni
     controles y nunca interceptan toques o clics.
   - El color sale del analizador compartido de la app
     (window.__rpmVizAnalyser, expuesto en ensureVisualizer() desde
     3.2.0): grave -> rojo, medio -> verde, agudo -> violeta, con el
     tono ponderado por la energía de cada banda. El módulo lee
     getByteFrequencyData() y pinta dos radiales suaves (hsla, alfa
     0.20..0.65) sobre el overlay. Sin analizador no se inventa
     movimiento: las luces no se encienden.
   - El botón #btnLuces (toggle-pill, igual que #btnWakeParty) se crea
     por JS junto a #btnWakeParty, dentro del overlay: solo es visible
     en modo fiesta, porque el overlay está oculto fuera de él.

   ANALIZADOR COMPARTIDO (igual que visual.js): NUNCA se llama a
   createMediaElementSource(): un <audio> solo admite una, y la app ya
   creó la suya; crear otra rompería el EQ y los efectos. Orden:
     1) Puente: window.__rpmVizAnalyser (preferido, mismo contexto y
        mismo analizador que el EQ, los efectos y #partyViz).
     2) Respaldo best-effort: audio.captureStream() + un AudioContext
        propio SOLO con MediaStreamSource -> AnalyserNode (sin conectar
        a destination, para no duplicar el sonido). Si el navegador no
        lo soporta o el grafo de la app ya es dueño del elemento, el
        módulo NO inventa movimiento: las luces quedan apagadas.
   El analizador de la app tiene fftSize 128 (64 bins); el del tap,
   256 (128 bins). bandEnergy() trabaja con fracciones del espectro,
   así que ambos valen.

   SIN PARPADEO: las energías se suavizan (media exponencial, factor
   0.3) y el fondo solo se actualiza cada 100 ms; el rAF del módulo
   solo existe mientras suena música con las luces encendidas y la
   fiesta abierta. Al pausar (o al terminar, o al cerrar la fiesta) el
   rAF se cancela y el último fondo queda QUIETO y atenuado (clase
   .paused, opacidad 0.45): nunca se queda parpadeando. Al apagar, se
   quita la clase .on y se limpia el fondo: el overlay recupera su
   fondo original (el gradiente de setPartyColors()), sin tocarlo.

   MOVIMIENTO REDUCIDO: con prefers-reduced-motion: reduce activado,
   las luces NO se encienden nunca y el botón queda deshabilitado
   indicando «No disponibles». Se escucha el cambio del ajuste en
   vivo: si se activa mientras las luces están encendidas, se apagan.

   FAIL-SAFE (patrón visual.js / cast.js): IIFE, try/catch en todo el
   arranque y en cada frame. Si #partyOverlay no existe, si no hay
   analizador, o si algo falla, el módulo no hace nada: el modo fiesta
   y la reproducción local quedan intactos. Si luces.js no carga,
   window.__rpmLuces no existe y la app es la misma. La preferencia
   (encendido/apagado) se guarda en localStorage
   ('reproductor-luces-fiesta', '1'/'0'; por defecto apagado: las
   luces son opt-in, nunca sorprenden con destellos al abrir la
   fiesta). */
(function (global) {
  'use strict';

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* Energía media 0..1 de una franja del espectro. from/to son fracciones
     de 0..1 sobre el número de bins (mismo criterio que visual.js). */
  function bandEnergy(freq, from, to) {
    if (!freq || !freq.length) return 0;
    var a = Math.max(0, Math.min(1, from)), b = Math.max(0, Math.min(1, to));
    var i0 = Math.floor(a * freq.length), i1 = Math.max(i0 + 1, Math.ceil(b * freq.length));
    if (i1 > freq.length) i1 = freq.length;
    var sum = 0, n = 0, i;
    for (i = i0; i < i1; i++) { sum += freq[i] || 0; n++; }
    return n ? (sum / n) / 255 : 0;
  }

  /* Grave / medio / agudo 0..1, sobre el 72% útil del espectro (igual
     que bassMidTreble() de visual.js y que drawPartyViz() de la app). */
  function bassMidTreble(freq) {
    return {
      bass: bandEnergy(freq, 0, 0.10),
      mid: bandEnergy(freq, 0.10, 0.40),
      treble: bandEnergy(freq, 0.40, 0.72)
    };
  }

  /* Suavizado exponencial por banda: evita cambios bruscos (destellos).
     factor 0 = se queda en prev, 1 = salta a next. prev null = next tal
     cual (primer frame). Siempre devuelve valores 0..1. */
  function smoothEnergies(prev, next, factor) {
    var f = clamp01(typeof factor === 'number' ? factor : 0.3);
    next = next || {};
    if (!prev) {
      return { bass: clamp01(next.bass), mid: clamp01(next.mid), treble: clamp01(next.treble) };
    }
    return {
      bass: clamp01(prev.bass + (clamp01(next.bass) - prev.bass) * f),
      mid: clamp01(prev.mid + (clamp01(next.mid) - prev.mid) * f),
      treble: clamp01(prev.treble + (clamp01(next.treble) - prev.treble) * f)
    };
  }

  /* Tono (0..359) ponderado por banda: el grave tira al rojo (0), el
     medio al verde (150) y el agudo al violeta (270). En silencio
     (sin energía) cae a 265, un violeta tranquilo. */
  function levelsToHue(e) {
    e = e || {};
    var b = clamp01(e.bass), m = clamp01(e.mid), t = clamp01(e.treble);
    var sum = b + m + t;
    if (sum <= 0) return 265;
    var hue = (b * 0 + m * 150 + t * 270) / sum;
    hue = Math.round(hue) % 360;
    return hue < 0 ? hue + 360 : hue;
  }

  /* Niveles -> color completo: tono principal, tono secundario (+130°),
     energía global 0..1 y alfa del overlay (0.20 en silencio, 0.65 a
     tope: nunca opaco, para que el fondo de la fiesta siga viéndose). */
  function levelsToColors(e) {
    e = e || {};
    var b = clamp01(e.bass), m = clamp01(e.mid), t = clamp01(e.treble);
    var overall = clamp01((b + m + t) / 3);
    var hue = levelsToHue(e);
    return {
      hue: hue,
      hue2: (hue + 130) % 360,
      overall: overall,
      alpha: 0.20 + overall * 0.45
    };
  }

  /* Fondo del overlay: dos radiales suaves (arriba a la izquierda con
     el tono principal, abajo a la derecha con el secundario) sobre
     transparente. Los tonos se normalizan a 0..359 y el alfa a 0..1. */
  function lightsBackground(hue, hue2, alpha) {
    var h1 = ((Math.round(Number(hue) || 0) % 360) + 360) % 360;
    var h2 = ((Math.round(Number(hue2) || 0) % 360) + 360) % 360;
    var a = clamp01(alpha);
    var a2 = clamp01(a * 0.85);
    return 'radial-gradient(70% 60% at 22% 18%, hsla(' + h1 + ',90%,60%,' + a + ') 0%, transparent 70%), ' +
      'radial-gradient(65% 55% at 82% 85%, hsla(' + h2 + ',90%,58%,' + a2 + ') 0%, transparent 72%)';
  }

  /* Preferencia guardada: solo '1' es encendido; ausente o cualquier
     otro valor es apagado (por defecto apagado: opt-in). */
  function parseLucesPref(v) {
    return v === '1';
  }

  /* ¿Pide el sistema reducir el movimiento? matchMediaFn es la función
     window.matchMedia (se inyecta para poder probarla en Node). Sin
     ella, o si falla, se asume que no. */
  function prefersReducedMotion(matchMediaFn) {
    try {
      if (typeof matchMediaFn !== 'function') return false;
      var mq = matchMediaFn('(prefers-reduced-motion: reduce)');
      return !!(mq && mq.matches);
    } catch (e) { return false; }
  }

  /* ¿Debe haber un rAF del módulo corriendo? Solo con las luces
     encendidas, la fiesta abierta, música sonando con fuente, un
     analizador disponible, sin movimiento reducido y con la pestaña
     visible. En cualquier otro caso el bucle no existe (y si existía,
     se cancela y el fondo queda quieto). */
  function shouldAnimateLights(s) {
    if (!s) return false;
    return !!s.lightsOn && !!s.partyOpen && !!s.playing && !!s.hasSrc &&
      !!s.hasAnalyser && !s.reducedMotion && !s.hidden;
  }

  /* ---- Pegamento con el DOM (todo dentro de try/catch) ---- */

  var LIGHTS_KEY = 'reproductor-luces-fiesta'; // '1' = encendidas, '0' = apagadas (defecto)
  var SMOOTH_FACTOR = 0.3;
  var FRAME_MS = 100; // el fondo solo se repinta cada 100 ms: sin estroboscopio

  var audio = null, partyEl = null, overlayEl = null, btnEl = null, stateEl = null;
  var tapCtx = null, tapAnalyser = null, tapUnsupported = false;
  var freqArr = null;
  var rafId = null, lastUpdate = 0, smoothed = null;
  var lightsOn = false, reducedMotion = false, mediaQuery = null;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function isPartyOpen() {
    try { return !!(partyEl && partyEl.classList.contains('on')); } catch (e) { return false; }
  }

  function isPlaying() {
    try { return !!(audio && audio.src && !audio.paused && !audio.ended); } catch (e) { return false; }
  }

  function isHidden() {
    try { return !!document.hidden; } catch (e) { return false; }
  }

  function loadPref() {
    try { return parseLucesPref(localStorage.getItem(LIGHTS_KEY)); } catch (e) { return false; }
  }

  function savePref() {
    try { localStorage.setItem(LIGHTS_KEY, lightsOn ? '1' : '0'); } catch (e) {}
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./luces.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './luces.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el overlay no se ve, pero la fiesta sigue */ }
  }

  /* Analizador compartido: primero el puente de la app, si existe y sigue
     vivo; si no, el tap propio por captureStream(). null si no hay. */
  function getAnalyser() {
    var an = null;
    try {
      if (global.__rpmVizAnalyser && typeof global.__rpmVizAnalyser.getByteFrequencyData === 'function') {
        an = global.__rpmVizAnalyser;
      } else if (global.__rpm && global.__rpm.analyser && typeof global.__rpm.analyser.getByteFrequencyData === 'function') {
        an = global.__rpm.analyser;
      }
      if (an && an.context && an.context.state === 'closed') an = null;
    } catch (e) { an = null; }
    if (an) return an;
    if (tapAnalyser) {
      try {
        if (tapCtx && tapCtx.state === 'closed') { tapAnalyser = null; tapCtx = null; }
        else return tapAnalyser;
      } catch (e) { tapAnalyser = null; tapCtx = null; }
    }
    return null;
  }

  /* Respaldo: tap por captureStream(). Solo si no hay puente. Si el
     navegador no lo tiene, no se vuelve a intentar en la sesión.
     NUNCA createMediaElementSource(): la app ya es dueña del elemento. */
  function ensureTap() {
    if (getAnalyser() || tapUnsupported || !audio) return;
    try {
      var cap = audio.captureStream || audio.mozCaptureStream;
      if (typeof cap !== 'function') { tapUnsupported = true; return; }
      var stream = cap.call(audio);
      if (!stream) { tapUnsupported = true; return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { tapUnsupported = true; return; }
      try { tapCtx = new AC({ latencyHint: 'playback' }); }
      catch (e) { tapCtx = new AC(); }
      var src = tapCtx.createMediaStreamSource(stream);
      tapAnalyser = tapCtx.createAnalyser();
      tapAnalyser.fftSize = 256;
      tapAnalyser.smoothingTimeConstant = 0.82;
      src.connect(tapAnalyser); // sin salida a destination: no duplica el sonido
      if (tapCtx.state === 'suspended') {
        var rp = tapCtx.resume(); if (rp && rp.catch) rp.catch(function () {});
      }
    } catch (e) {
      tapAnalyser = null;
      try { if (tapCtx && tapCtx.close) tapCtx.close(); } catch (e2) {}
      tapCtx = null;
      tapUnsupported = true; // p. ej. el grafo de la app ya es dueño del elemento
    }
  }

  function suspendTap() {
    try {
      if (tapCtx && tapCtx.state === 'running') {
        var sp = tapCtx.suspend(); if (sp && sp.catch) sp.catch(function () {});
      }
    } catch (e) {}
  }

  function resumeTap() {
    try {
      if (tapCtx && tapCtx.state === 'suspended') {
        var rp = tapCtx.resume(); if (rp && rp.catch) rp.catch(function () {});
      }
    } catch (e) {}
  }

  /* ---- Overlay y botón ---- */

  function ensureOverlayEl() {
    try {
      overlayEl = document.getElementById('rpmLuces');
      if (overlayEl) return;
      if (!partyEl) return;
      overlayEl = document.createElement('div');
      overlayEl.id = 'rpmLuces';
      overlayEl.setAttribute('aria-hidden', 'true');
      // Primer hijo del overlay: con position:absolute no ocupa sitio y
      // queda detrás del contenido (z-index:0, ver luces.css).
      if (partyEl.firstChild) partyEl.insertBefore(overlayEl, partyEl.firstChild);
      else partyEl.appendChild(overlayEl);
    } catch (e) { overlayEl = null; }
  }

  function syncButtonUI() {
    try {
      if (!btnEl) return;
      btnEl.classList.toggle('on', !!lightsOn && !reducedMotion);
      btnEl.setAttribute('aria-pressed', (lightsOn && !reducedMotion) ? 'true' : 'false');
      if (reducedMotion) {
        btnEl.disabled = true;
        btnEl.title = 'Las luces están desactivadas porque tienes activado «Reducir movimiento» en el sistema.';
        if (stateEl) stateEl.textContent = 'No disponibles';
      } else {
        btnEl.disabled = false;
        btnEl.title = lightsOn
          ? 'Luces al ritmo de la música: encendidas. Toca para apagarlas.'
          : 'Luces al ritmo de la música: apagadas. Toca para encenderlas.';
        if (stateEl) stateEl.textContent = lightsOn ? 'Encendidas' : 'Apagadas';
      }
    } catch (e) {}
  }

  function buildButton() {
    try {
      if (document.getElementById('btnLuces')) {
        btnEl = document.getElementById('btnLuces');
        stateEl = document.getElementById('lucesState');
        syncButtonUI();
        return;
      }
      if (!partyEl) return;
      var btn = document.createElement('button');
      btn.className = 'toggle-pill';
      btn.id = 'btnLuces';
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '<span class="dot"></span><span>Luces al ritmo:&nbsp;</span><span id="lucesState">Apagadas</span>';
      // Junto a #btnWakeParty (mismo contenedor flex), dentro del
      // overlay: solo visible en modo fiesta. Si ese ancla no existe,
      // tras los controles de fiesta; si tampoco, al final del overlay.
      var anchor = document.getElementById('btnWakeParty');
      if (anchor && anchor.parentNode) {
        if (anchor.nextSibling) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
        else anchor.parentNode.appendChild(btn);
      } else {
        var controls = partyEl.querySelector ? partyEl.querySelector('.party-controls') : null;
        if (controls && controls.parentNode) controls.parentNode.insertBefore(btn, controls.nextSibling);
        else partyEl.appendChild(btn);
      }
      btnEl = btn;
      stateEl = document.getElementById('lucesState');
      btnEl.addEventListener('click', function () { setLights(!lightsOn); });
      syncButtonUI();
    } catch (e) {}
  }

  /* ---- Encendido / apagado / bucle ---- */

  function currentState() {
    return {
      lightsOn: lightsOn,
      partyOpen: isPartyOpen(),
      playing: isPlaying(),
      hasSrc: !!(audio && audio.src),
      hasAnalyser: !!getAnalyser(),
      reducedMotion: reducedMotion,
      hidden: isHidden()
    };
  }

  function applyFrame() {
    var an = getAnalyser();
    if (!an || !overlayEl) return false;
    try {
      if (!freqArr || freqArr.length !== an.frequencyBinCount) freqArr = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(freqArr);
      smoothed = smoothEnergies(smoothed, bassMidTreble(freqArr), SMOOTH_FACTOR);
      var c = levelsToColors(smoothed);
      overlayEl.style.background = lightsBackground(c.hue, c.hue2, c.alpha);
      return true;
    } catch (e) { return false; }
  }

  function frame() {
    rafId = null;
    try {
      if (!shouldAnimateLights(currentState())) { stopLoop(); freezeOverlay(); return; }
      var now = Date.now();
      if (now - lastUpdate >= FRAME_MS) {
        lastUpdate = now;
        if (!applyFrame()) { stopLoop(); freezeOverlay(); return; }
      }
    } catch (e) {
      try { freezeOverlay(); } catch (e2) {}
      stopLoop();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId !== null) return;
    if (!shouldAnimateLights(currentState())) return;
    ensureTap();
    resumeTap();
    lastUpdate = 0; // primer frame pinta de inmediato
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId !== null) {
      try { cancelAnimationFrame(rafId); } catch (e) {}
      rafId = null;
    }
    suspendTap();
  }

  /* Pausa / fin / fiesta cerrada: el fondo queda QUIETO (último color)
     y atenuado; el rAF ya está cancelado, así que nada parpadea. */
  function freezeOverlay() {
    try {
      if (overlayEl && lightsOn) overlayEl.classList.add('paused');
    } catch (e) {}
  }

  function unfreezeOverlay() {
    try { if (overlayEl) overlayEl.classList.remove('paused'); } catch (e) {}
  }

  /* Fondo original: el overlay es un elemento aparte; apagar es quitar
     su clase .on y limpiar su background. El fondo del overlay de
     fiesta (gradiente de setPartyColors()) no se toca nunca. */
  function clearOverlay() {
    try {
      if (!overlayEl) return;
      overlayEl.classList.remove('on');
      overlayEl.classList.remove('paused');
      overlayEl.style.background = '';
    } catch (e) {}
  }

  function setLights(on) {
    try {
      if (reducedMotion) on = false; // movimiento reducido: nunca se encienden
      if (on) {
        ensureTap();
        if (!getAnalyser()) {
          // Sin analizador no hay ritmo real: no se inventa movimiento.
          on = false;
          if (btnEl) btnEl.title = 'Sin analizador de audio disponible: las luces no pueden seguir la música.';
        }
      }
      lightsOn = !!on;
      savePref();
      if (lightsOn) {
        ensureOverlayEl();
        if (overlayEl) {
          // Color tranquilo de arranque (sin energía aún): el primer
          // frame lo sustituye por el ritmo real en cuanto suena.
          if (!overlayEl.style.background) {
            var c = levelsToColors({ bass: 0.2, mid: 0.2, treble: 0.2 });
            overlayEl.style.background = lightsBackground(c.hue, c.hue2, c.alpha);
          }
          overlayEl.classList.add('on');
          unfreezeOverlay();
        }
        startLoop();
      } else {
        stopLoop();
        clearOverlay();
      }
      syncButtonUI();
    } catch (e) {
      try { stopLoop(); clearOverlay(); } catch (e2) {}
    }
  }

  function syncWithParty() {
    try {
      if (!lightsOn) return;
      if (isPartyOpen() && isPlaying()) { unfreezeOverlay(); startLoop(); }
      else { stopLoop(); freezeOverlay(); }
    } catch (e) {}
  }

  function watchParty() {
    try {
      if (!partyEl || typeof MutationObserver !== 'function') return;
      var mo = new MutationObserver(function () { syncWithParty(); });
      mo.observe(partyEl, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }

  function watchReducedMotion() {
    try {
      var mm = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
        ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (!mm) return;
      mediaQuery = mm;
      reducedMotion = !!mm.matches;
      var onChange = function (ev) {
        try {
          reducedMotion = !!(ev && typeof ev.matches === 'boolean' ? ev.matches : mm.matches);
          if (reducedMotion && lightsOn) setLights(false);
          else syncButtonUI();
        } catch (e) {}
      };
      if (typeof mm.addEventListener === 'function') mm.addEventListener('change', onChange);
      else if (typeof mm.addListener === 'function') mm.addListener(onChange);
    } catch (e) {}
  }

  function init() {
    try {
      audio = $('audio');
      partyEl = $('partyOverlay');
      if (!partyEl) return; // sin modo fiesta no hay nada que hacer
      watchReducedMotion();
      lightsOn = reducedMotion ? false : loadPref();
      ensureCss();
      ensureOverlayEl();
      buildButton();
      if (lightsOn) {
        // Preferencia guardada encendida: el overlay se marca, pero el
        // bucle solo arranca cuando suena música con la fiesta abierta.
        if (overlayEl) {
          var c0 = levelsToColors({ bass: 0.2, mid: 0.2, treble: 0.2 });
          overlayEl.style.background = lightsBackground(c0.hue, c0.hue2, c0.alpha);
          overlayEl.classList.add('on');
          overlayEl.classList.add('paused'); // quieto hasta que suene
        }
        syncButtonUI();
      }
      watchParty();

      if (audio) {
        audio.addEventListener('play', function () { if (lightsOn) { unfreezeOverlay(); startLoop(); } });
        audio.addEventListener('pause', function () { stopLoop(); freezeOverlay(); });
        audio.addEventListener('ended', function () { stopLoop(); freezeOverlay(); });
      }
      // Respaldo por si el observador no existe: los botones de la app
      // abren/cierran la fiesta; el sync se hace tras su handler.
      var btnOpen = $('btnParty'), btnClose = $('btnPartyClose');
      if (btnOpen) btnOpen.addEventListener('click', function () { setTimeout(syncWithParty, 0); });
      if (btnClose) btnClose.addEventListener('click', function () { setTimeout(syncWithParty, 0); });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopLoop();
        else syncWithParty();
      });
      syncWithParty();
    } catch (e) { /* fail-safe: la app sigue sin este módulo */ }
  }

  var api = {
    clamp01: clamp01,
    bandEnergy: bandEnergy,
    bassMidTreble: bassMidTreble,
    smoothEnergies: smoothEnergies,
    levelsToHue: levelsToHue,
    levelsToColors: levelsToColors,
    lightsBackground: lightsBackground,
    parseLucesPref: parseLucesPref,
    prefersReducedMotion: prefersReducedMotion,
    shouldAnimateLights: shouldAnimateLights
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmLucesHelpers = api; } catch (e) {}
  try {
    global.__rpmLuces = {
      version: '3.6.0',
      isOn: function () { return lightsOn; },
      setOn: function (on) { setLights(!!on); },
      toggle: function () { setLights(!lightsOn); }
    };
  } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
