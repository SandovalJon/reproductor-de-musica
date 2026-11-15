/* Portada animada con la música — «Portada viva» (v4.2.0), módulo aparte.
   AÑADE movimiento a la portada que ya existe en index.html: la imagen
   #coverImg (o el #coverFallback cuando la canción no tiene portada)
   respira al ritmo real de la música — escala con el grave, brillo con
   la energía global y un halo de color alrededor de #coverWrap con el
   tono ponderado por banda. NO reemplaza nada: renderNow() sigue
   poniendo/quitando #coverImg y #coverFallback como antes, y la
   animación de entrada de temas.js (rpmCoverIn, 0,45 s) sigue mandando
   mientras dura: la animación CSS tiene prioridad sobre el transform
   inline que pone este módulo, y al terminar la clase se quita y el
   módulo retoma el control sin tocar nada. Sin cablear (WIRING.md §1),
   portada-viva.js ni siquiera se carga y la app es byte-idéntica a 4.1.0.

   CÓMO FUNCIONA:
   - Solo presentación: se lee getByteFrequencyData() del analizador
     compartido de la app (window.__rpmVizAnalyser, expuesto en
     ensureVisualizer(), index.html:4226) y se escribe transform /
     filter en la portada visible y una variable --pv-halo-shadow en
     #coverWrap. No se toca el audio, ni el ecualizador, ni ningún
     AudioContext. NUNCA se llama a createMediaElementSource().
   - Sin analizador no hay animación: el analizador de la app solo
     existe después de la primera reproducción (ensureVisualizer() se
     llama desde las rutas de play), así que antes de sonar no hay
     nada que animar. A diferencia de luces.js, aquí NO hay tap de
     respaldo por captureStream(): si no hay puente, el módulo no hace
     nada y no falla. La preferencia encendida se conserva: en cuanto
     suena música y el puente existe, la animación arranca sola.
   - La portada visible es #coverImg con imagen cargada, o
     #coverFallback en caso contrario (mismo criterio de visibilidad
     que mini.js: getComputedStyle().display !== 'none'). Con vídeo
     visible (#coverWrap.video-on, #videoEl por encima con z-index 3)
     la portada está tapada y no se anima.
   - Sin parpadeo: energías suavizadas (media exponencial, factor
     0.25) y repintado cada 80 ms, con transición CSS de 0,12 s entre
     valores. La escala máxima es 1.06 y el brillo máximo 1.15: sutil,
     sin marear. El rAF solo existe mientras suena música con la
     portada viva encendida y la portada visible. Al pausar, terminar
     o cambiar de canción, el rAF se cancela y la portada vuelve
     SUAVEMENTE a reposo (escala 1, brillo 1, halo 0), nunca se queda
     congelada a mitad de zoom.
   - El botón #btnPortadaViva (toggle-pill, igual que #btnLuces) lo
     crea el módulo por JS justo después de #btnParty, en la fila de
     botones del reproductor: siempre visible, no escondido en
     Ajustes. Texto: «Portada viva: Encendida/Apagada».

   MOVIMIENTO REDUCIDO: con prefers-reduced-motion: reduce activado,
   la portada viva está APAGADA por defecto y el botón queda
   deshabilitado indicando «No disponible». Se escucha el cambio del
   ajuste en vivo: si se activa mientras está encendida, se apaga y
   la portada vuelve a reposo. Sin ese ajuste, la preferencia por
   defecto es ENCENDIDA (la animación es sutil y es el comportamiento
   del módulo); se guarda en localStorage
   ('reproductor-portada-viva', '1'/'0').

   FAIL-SAFE (patrón visual.js / luces.js): IIFE, try/catch en todo el
   arranque y en cada frame. Si #coverWrap no existe, si no hay
   analizador, o si algo falla, el módulo no hace nada: la portada y
   la reproducción local quedan intactas. Si portada-viva.js no carga,
   window.__rpmPortadaViva no existe y la app es la misma. */
(function (global) {
  'use strict';

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* Energía media 0..1 de una franja del espectro. from/to son fracciones
     de 0..1 sobre el número de bins (mismo criterio que visual.js y
     luces.js). */
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
     que bassMidTreble() de visual.js y luces.js). */
  function bassMidTreble(freq) {
    return {
      bass: bandEnergy(freq, 0, 0.10),
      mid: bandEnergy(freq, 0.10, 0.40),
      treble: bandEnergy(freq, 0.40, 0.72)
    };
  }

  /* Suavizado exponencial por banda: evita cambios bruscos. factor 0 =
     se queda en prev, 1 = salta a next. prev null = next tal cual
     (primer frame). Siempre devuelve valores 0..1. */
  function smoothEnergies(prev, next, factor) {
    var f = clamp01(typeof factor === 'number' ? factor : 0.25);
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
     (sin energía) cae a 265, un violeta tranquilo. Mismo criterio que
     levelsToHue() de luces.js. */
  function levelsToHue(e) {
    e = e || {};
    var b = clamp01(e.bass), m = clamp01(e.mid), t = clamp01(e.treble);
    var sum = b + m + t;
    if (sum <= 0) return 265;
    var hue = (b * 0 + m * 150 + t * 270) / sum;
    hue = Math.round(hue) % 360;
    return hue < 0 ? hue + 360 : hue;
  }

  /* Niveles 0..1 -> valores de presentación de la portada:
       escala:     1 + grave*0.04 + global*0.02  (1.00 en silencio, 1.06 a tope)
       brillo:     1 + global*0.15               (1.00 en silencio, 1.15 a tope)
       halo:       global*28 px, alfa 0.18..0.63 (0 px en silencio)
       tono:       levelsToHue() (rojo con graves, violeta con agudos)
     La escala la manda sobre todo el grave (el «latido»); el brillo y
     el halo, la energía global. Todo acotado: nunca más de 1.06 / 1.15. */
  function coverLevels(e) {
    e = e || {};
    var b = clamp01(e.bass), m = clamp01(e.mid), t = clamp01(e.treble);
    var overall = clamp01((b + m + t) / 3);
    return {
      scale: 1 + b * 0.04 + overall * 0.02,
      brightness: 1 + overall * 0.15,
      haloPx: overall * 28,
      haloAlpha: 0.18 + overall * 0.45,
      hue: levelsToHue(e),
      overall: overall
    };
  }

  /* Niveles -> estilos listos para aplicar: transform y filter para el
     elemento de portada visible, y la sombra de halo para #coverWrap
     (se escribe como variable --pv-halo-shadow; el box-shadow completo,
     con su inset original, vive en portada-viva.css para no pisarlo).
     Los números se redondean a 3 decimales para no agitar el DOM con
     decimales largos en cada frame. */
  function coverStyle(e) {
    var l = coverLevels(e);
    var hue = ((Math.round(l.hue) % 360) + 360) % 360;
    return {
      transform: 'scale(' + l.scale.toFixed(3) + ')',
      filter: 'brightness(' + l.brightness.toFixed(3) + ')',
      haloShadow: '0 0 ' + l.haloPx.toFixed(1) + 'px hsla(' + hue + ',90%,60%,' + l.haloAlpha.toFixed(3) + ')'
    };
  }

  /* Reposo: portada quieta, sin zoom, sin brillo extra y sin halo.
     Es lo que se aplica al pausar, al terminar, al apagar y con
     movimiento reducido (con la transición CSS de 0,12 s, la vuelta
     es suave, no un salto). */
  function neutralStyle() {
    return {
      transform: 'scale(1)',
      filter: 'brightness(1)',
      haloShadow: '0 0 0 rgba(0,0,0,0)'
    };
  }

  /* ¿Qué portada está visible? Entradas ya calculadas en el DOM
     (display !== 'none'; con imagen cargada en el caso de <img>).
     'img' tiene prioridad; si no hay ninguna, null (no se anima nada). */
  function pickVisibleCover(imgVisible, fallbackVisible) {
    if (imgVisible) return 'img';
    if (fallbackVisible) return 'fallback';
    return null;
  }

  /* Preferencia guardada: '1' = encendida, '0' = apagada, ausente o
     cualquier otro valor = null (sin preferencia: por defecto
     encendida, salvo movimiento reducido, ver resolvePortadaVivaOn). */
  function parsePortadaVivaPref(v) {
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  }

  /* Decisión final de encendido: el movimiento reducido manda sobre
     todo (siempre apagado); si no, apagado solo si la preferencia
     guardada es '0'; en cualquier otro caso (guardada '1' o sin
     guardar) encendida. */
  function resolvePortadaVivaOn(saved, reducedMotion) {
    if (reducedMotion) return false;
    if (saved === false) return false;
    return true;
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

  /* ¿Debe haber un rAF del módulo corriendo? Solo con la portada viva
     encendida, música sonando con fuente, un analizador disponible, la
     portada visible (imagen o fallback, sin vídeo por encima), sin
     movimiento reducido y con la pestaña visible. En cualquier otro
     caso el bucle no existe (y si existía, se cancela y la portada
     vuelve a reposo). */
  function shouldAnimateCover(s) {
    if (!s) return false;
    return !!s.enabled && !!s.playing && !!s.hasSrc &&
      !!s.hasAnalyser && !!s.coverVisible && !s.reducedMotion && !s.hidden;
  }

  /* ---- Pegamento con el DOM (todo dentro de try/catch) ---- */

  var PORTADA_VIVA_KEY = 'reproductor-portada-viva'; // '1' = encendida (defecto), '0' = apagada
  var SMOOTH_FACTOR = 0.25;
  var FRAME_MS = 80; // la portada solo se repinta cada 80 ms

  var audio = null, coverWrap = null, coverImg = null, coverFallback = null;
  var btnEl = null, stateEl = null;
  var freqArr = null;
  var rafId = null, lastUpdate = 0, smoothed = null;
  var enabled = false, reducedMotion = false, mediaQuery = null;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function isPlaying() {
    try { return !!(audio && audio.src && !audio.paused && !audio.ended); } catch (e) { return false; }
  }

  function isHidden() {
    try { return !!document.hidden; } catch (e) { return false; }
  }

  /* display !== 'none' según el estilo computado (mismo criterio que
     mini.js para #coverImg); si no hay getComputedStyle, el inline. */
  function isDisplayed(el) {
    if (!el) return false;
    try {
      if (window.getComputedStyle) return window.getComputedStyle(el).display !== 'none';
    } catch (e) {}
    try { return el.style.display !== 'none'; } catch (e) { return false; }
  }

  /* Qué portada está visible ahora mismo, o null. Con vídeo visible
     (#coverWrap.video-on) la portada está tapada por #videoEl y no se
     anima aunque #coverImg siga con display:block por debajo. */
  function visibleCover() {
    try {
      if (coverWrap && coverWrap.classList && coverWrap.classList.contains('video-on')) return null;
      var imgVisible = false, fbVisible = false;
      if (coverImg && isDisplayed(coverImg) && coverImg.complete && coverImg.naturalWidth) imgVisible = true;
      if (coverFallback && isDisplayed(coverFallback)) fbVisible = true;
      return pickVisibleCover(imgVisible, fbVisible);
    } catch (e) { return null; }
  }

  function visibleCoverEl() {
    var kind = visibleCover();
    if (kind === 'img') return coverImg;
    if (kind === 'fallback') return coverFallback;
    return null;
  }

  function loadPref() {
    try { return parsePortadaVivaPref(localStorage.getItem(PORTADA_VIVA_KEY)); } catch (e) { return null; }
  }

  function savePref() {
    try { localStorage.setItem(PORTADA_VIVA_KEY, enabled ? '1' : '0'); } catch (e) {}
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./portada-viva.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './portada-viva.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS no hay halo ni transición, pero nada se rompe */ }
  }

  /* Analizador compartido, SOLO el puente de la app (preferido) o el
     puente alternativo __rpm.analyser que también comprueba luces.js.
     Sin puente NO hay tap de respaldo: sin analizador, no se anima
     nada (y no se crea ningún AudioContext). null si no hay. */
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
    return an;
  }

  /* ---- Aplicar / quitar el estilo ---- */

  function applyStyleTo(el, style) {
    if (!el || !style) return;
    try {
      el.style.transform = style.transform;
      el.style.filter = style.filter;
    } catch (e) {}
  }

  function applyHalo(style) {
    try {
      if (coverWrap && coverWrap.style && coverWrap.style.setProperty) {
        coverWrap.style.setProperty('--pv-halo-shadow', style.haloShadow);
      }
    } catch (e) {}
  }

  /* Marca el wrap y el elemento visible con la clase del módulo (la
     transición y el halo viven en portada-viva.css) y quita el estilo
     del elemento que deja de ser visible, para que no se quede con un
     zoom viejo cuando vuelva a aparecer. */
  function markLiveElements() {
    try {
      if (coverWrap) coverWrap.classList.add('rpm-portada-viva');
      var kind = visibleCover();
      if (coverImg) coverImg.classList.toggle('rpm-portada-viva', kind === 'img');
      if (coverFallback) coverFallback.classList.toggle('rpm-portada-viva', kind === 'fallback');
      if (kind === 'img' && coverFallback) applyStyleTo(coverFallback, neutralStyle());
      if (kind === 'fallback' && coverImg) applyStyleTo(coverImg, neutralStyle());
    } catch (e) {}
  }

  /* Vuelta a reposo: escala 1, brillo 1, halo 0 en ambos elementos y
     en el wrap. La transición CSS de 0,12 s lo hace suave. No se quitan
     las clases: si se vuelve a encender, la transición sigue ahí. */
  function resetCover() {
    try {
      var n = neutralStyle();
      applyStyleTo(coverImg, n);
      applyStyleTo(coverFallback, n);
      applyHalo(n);
    } catch (e) {}
  }

  /* ---- Botón visible ---- */

  function syncButtonUI() {
    try {
      if (!btnEl) return;
      btnEl.classList.toggle('on', !!enabled && !reducedMotion);
      btnEl.setAttribute('aria-pressed', (enabled && !reducedMotion) ? 'true' : 'false');
      if (reducedMotion) {
        btnEl.disabled = true;
        btnEl.title = 'La portada animada está desactivada porque tienes activado «Reducir movimiento» en el sistema.';
        if (stateEl) stateEl.textContent = 'No disponible';
      } else {
        btnEl.disabled = false;
        btnEl.title = enabled
          ? 'Portada animada con la música: encendida. Toca para apagarla.'
          : 'Portada animada con la música: apagada. Toca para encenderla.';
        if (stateEl) stateEl.textContent = enabled ? 'Encendida' : 'Apagada';
      }
    } catch (e) {}
  }

  function buildButton() {
    try {
      if (document.getElementById('btnPortadaViva')) {
        btnEl = document.getElementById('btnPortadaViva');
        stateEl = document.getElementById('portadaVivaState');
        syncButtonUI();
        return;
      }
      var btn = document.createElement('button');
      btn.className = 'toggle-pill';
      btn.id = 'btnPortadaViva';
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '<span class="dot"></span><span>Portada viva:&nbsp;</span><span id="portadaVivaState">Apagada</span>';
      // Justo después de #btnParty, en la fila de botones del
      // reproductor (siempre visible). Si ese ancla no existe, tras
      // #btnEditCurrent; si tampoco, al final de su fila.
      var anchor = document.getElementById('btnParty') || document.getElementById('btnEditCurrent');
      if (anchor && anchor.parentNode) {
        if (anchor.nextSibling) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
        else anchor.parentNode.appendChild(btn);
      } else {
        // Sin ancla en el DOM no se crea el botón (la API sigue disponible).
        return;
      }
      btnEl = btn;
      stateEl = document.getElementById('portadaVivaState');
      btnEl.addEventListener('click', function () { setEnabled(!enabled); });
      syncButtonUI();
    } catch (e) {}
  }

  /* ---- Encendido / apagado / bucle ---- */

  function currentState() {
    return {
      enabled: enabled,
      playing: isPlaying(),
      hasSrc: !!(audio && audio.src),
      hasAnalyser: !!getAnalyser(),
      coverVisible: !!visibleCover(),
      reducedMotion: reducedMotion,
      hidden: isHidden()
    };
  }

  function applyFrame() {
    var an = getAnalyser();
    var el = visibleCoverEl();
    if (!an || !el) return false;
    try {
      if (!freqArr || freqArr.length !== an.frequencyBinCount) freqArr = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(freqArr);
      smoothed = smoothEnergies(smoothed, bassMidTreble(freqArr), SMOOTH_FACTOR);
      var style = coverStyle(smoothed);
      markLiveElements();
      applyStyleTo(el, style);
      applyHalo(style);
      return true;
    } catch (e) { return false; }
  }

  function frame() {
    rafId = null;
    try {
      if (!shouldAnimateCover(currentState())) { stopLoop(); resetCover(); return; }
      var now = Date.now();
      if (now - lastUpdate >= FRAME_MS) {
        lastUpdate = now;
        if (!applyFrame()) { stopLoop(); resetCover(); return; }
      }
    } catch (e) {
      try { resetCover(); } catch (e2) {}
      stopLoop();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId !== null) return;
    if (!shouldAnimateCover(currentState())) return;
    lastUpdate = 0; // primer frame pinta de inmediato
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId !== null) {
      try { cancelAnimationFrame(rafId); } catch (e) {}
      rafId = null;
    }
  }

  function setEnabled(on) {
    try {
      if (reducedMotion) on = false; // movimiento reducido: nunca se enciende
      enabled = !!on;
      savePref();
      if (enabled) {
        markLiveElements();
        startLoop(); // si aún no hay analizador, el bucle no arranca:
        // en cuanto suene música y exista el puente, el 'play' lo arranca
      } else {
        stopLoop();
        resetCover();
      }
      syncButtonUI();
    } catch (e) {
      try { stopLoop(); resetCover(); } catch (e2) {}
    }
  }

  function syncLoop() {
    try {
      if (!enabled) return;
      if (shouldAnimateCover(currentState())) startLoop();
      else { stopLoop(); resetCover(); }
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
          if (reducedMotion && enabled) setEnabled(false);
          else syncButtonUI();
        } catch (e) {}
      };
      if (typeof mm.addEventListener === 'function') mm.addEventListener('change', onChange);
      else if (typeof mm.addListener === 'function') mm.addListener(onChange);
    } catch (e) {}
  }

  function watchCover() {
    try {
      if (typeof MutationObserver !== 'function') return;
      // renderNow() cambia display/src de la portada y la clase
      // video-on del wrap: cualquier cambio re-sincroniza el bucle.
      var mo = new MutationObserver(function () { syncLoop(); });
      if (coverWrap) mo.observe(coverWrap, { attributes: true, attributeFilter: ['class'] });
      if (coverImg) mo.observe(coverImg, { attributes: true, attributeFilter: ['style', 'src'] });
      if (coverFallback) mo.observe(coverFallback, { attributes: true, attributeFilter: ['style'] });
    } catch (e) {}
  }

  function init() {
    try {
      audio = $('audio');
      coverWrap = $('coverWrap');
      coverImg = $('coverImg');
      coverFallback = $('coverFallback');
      if (!coverWrap || (!coverImg && !coverFallback)) return; // sin portada no hay nada que hacer
      watchReducedMotion();
      enabled = resolvePortadaVivaOn(loadPref(), reducedMotion);
      ensureCss();
      buildButton();
      if (enabled) markLiveElements();
      syncButtonUI();
      watchCover();

      if (audio) {
        audio.addEventListener('play', function () {
          smoothed = null; // la energía de la canción anterior no se hereda
          if (enabled) startLoop();
        });
        audio.addEventListener('pause', function () { stopLoop(); resetCover(); });
        audio.addEventListener('ended', function () { stopLoop(); resetCover(); });
      }
      if (coverImg) {
        coverImg.addEventListener('load', function () {
          smoothed = null;
          syncLoop();
        });
      }
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { stopLoop(); resetCover(); }
        else syncLoop();
      });
      syncLoop();
    } catch (e) { /* fail-safe: la app sigue sin este módulo */ }
  }

  var api = {
    clamp01: clamp01,
    bandEnergy: bandEnergy,
    bassMidTreble: bassMidTreble,
    smoothEnergies: smoothEnergies,
    levelsToHue: levelsToHue,
    coverLevels: coverLevels,
    coverStyle: coverStyle,
    neutralStyle: neutralStyle,
    pickVisibleCover: pickVisibleCover,
    parsePortadaVivaPref: parsePortadaVivaPref,
    resolvePortadaVivaOn: resolvePortadaVivaOn,
    prefersReducedMotion: prefersReducedMotion,
    shouldAnimateCover: shouldAnimateCover
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmPortadaVivaHelpers = api; } catch (e) {}
  try {
    global.__rpmPortadaViva = {
      version: '4.2.0',
      isOn: function () { return enabled; },
      setOn: function (on) { setEnabled(!!on); },
      toggle: function () { setEnabled(!enabled); }
    };
  } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
