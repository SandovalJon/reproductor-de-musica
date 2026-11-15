/* Visualizador y efectos (v3.2.0) — módulo aparte.
   AÑADE dos modos al visualizador que ya existe en index.html y un fondo
   que se tiñe con el color dominante de la portada. NO reemplaza nada:
   los modos 'bars' | 'wave' | 'circle' los sigue dibujando drawViz() de
   la app; este módulo solo dibuja cuando el estilo elegido es 'combo'
   o 'rings', y solo si el coordinador añade la línea de guarda al inicio
   de drawViz() (ver modules/visual/WIRING.md §3). Sin esa línea, el
   módulo no dibuja nada y la app es byte-idéntica a 3.1.0.

   ANALIZADOR COMPARTIDO (un solo AudioContext / AnalyserNode):
   el AnalyserNode de la app vive dentro de la IIFE de index.html y no es
   accesible desde fuera. Por eso el módulo lo busca en este orden:
     1) Puente: window.__rpmVizAnalyser, que el coordinador expone con
        UNA línea dentro de ensureVisualizer() (WIRING.md §4). Es la vía
        preferida: mismo contexto y mismo analizador que el EQ y los
        efectos, sin crear nada más.
     2) Respaldo best-effort: audio.captureStream() + un AudioContext
        propio SOLO con MediaStreamSource -> AnalyserNode (sin conectar
        a destination, para no duplicar el sonido). Si el navegador no
        lo soporta, o el grafo de la app ya es dueño del elemento (en
        Chrome, captureStream() puede devolver silencio en ese caso),
        el módulo NO inventa movimiento: dibuja la base quieta.
   NUNCA se llama a createMediaElementSource(): un <audio> solo admite
   una, y la app ya creó la suya; crear otra rompería el EQ y los
   efectos (ensureVisualizer() anularía todo su grafo al fallar).

   SIN AUDIO / SIN CANCIÓN: el módulo NO tiene un bucle propio corriendo:
   su rAF solo existe mientras suena un modo nuevo; en pausa, al terminar
   o sin canción dibuja UNA vez la base quieta y cancela el rAF
   (cancelAnimationFrame). Tampoco crea rAF para el fondo: el brillo es
   CSS puro con transición de opacidad. El bucle drawViz() de la app
   sigue existiendo como antes (lo hacía ya en 3.1.0 para los 3 modos);
   con un modo nuevo, su guarda lo convierte en un tick vacío.

   FONDO CON EL COLOR DE LA PORTADA: lee #coverImg con su propio canvas
   (24x24, mismo peso por saturación que extractCoverAccent del tema
   dinámico) y tiñe un div fijo detrás del contenido (.app tiene
   z-index:1; el brillo va a z-index:0, pointer-events:none, y se inserta
   ANTES de #bgPhoto para que la foto personalizada del usuario, cuando
   existe, quede por encima de él). Sin portada, el brillo se apaga solo.
   Se apaga desde Ajustes > Apariencia con el botón que crea el módulo
   ("Fondo con el color de la portada"), guardado en localStorage.

   FAIL-SAFE (patrón cast.js / lyrics.js): IIFE, try/catch en todo el
   arranque y en cada frame. Si <audio> o #viz no existen, si el
   analizador no se puede crear o si algo falla, el módulo no hace nada:
   el visualizador existente y la reproducción local quedan intactos.
   Si visual.js no carga, window.__rpmVisual no existe y la guarda de
   drawViz() es falsa: la app es la misma. */
(function (global) {
  'use strict';

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  var ALL_VIZ_STYLES = ['bars', 'wave', 'circle', 'combo', 'rings'];
  var NEW_VIZ_STYLES = ['combo', 'rings'];
  var VIZ_LABELS = { bars: 'Barras', wave: 'Onda', circle: 'Círculo', combo: 'Combo', rings: 'Anillos' };

  /* ¿Es uno de los modos nuevos que dibuja este módulo? */
  function isNewVizStyle(style) {
    return NEW_VIZ_STYLES.indexOf(style) !== -1;
  }

  /* Estilo válido o 'bars' si viene algo desconocido (mismo criterio que
     la app: lo que no se reconoce, cae a barras). */
  function sanitizeVizStyle(style) {
    return ALL_VIZ_STYLES.indexOf(style) !== -1 ? style : 'bars';
  }

  function vizStyleLabel(style) {
    return VIZ_LABELS[style] || 'Barras';
  }

  /* Frecuencias (0..255) -> valores de barra 0..1, con el mismo mapeo que
     el modo 'bars' de la app: cada barra toma el bin
     floor(i * len / barras * 0.72), así solo se usa el 72% grave del
     espectro y las barras no se quedan planas en los agudos. */
  function freqToBars(freq, barCount) {
    var out = [], i, idx;
    if (!freq || typeof freq.length !== 'number' || barCount <= 0) return out;
    for (i = 0; i < barCount; i++) {
      idx = Math.floor(i * freq.length / barCount * 0.72);
      if (idx >= freq.length) idx = freq.length - 1;
      out.push(Math.max(0, Math.min(1, (freq[idx] || 0) / 255)));
    }
    return out;
  }

  /* Valores 0..1 -> alturas en px (mínimo 3 px, como el modo 'bars'). */
  function barHeights(values, height) {
    return (values || []).map(function (v) {
      return Math.max(3, v * height * 0.92);
    });
  }

  /* Energía media 0..1 de una franja del espectro. from/to son fracciones
     de 0..1 sobre el número de bins. */
  function bandEnergy(freq, from, to) {
    if (!freq || !freq.length) return 0;
    var a = Math.max(0, Math.min(1, from)), b = Math.max(0, Math.min(1, to));
    var i0 = Math.floor(a * freq.length), i1 = Math.max(i0 + 1, Math.ceil(b * freq.length));
    if (i1 > freq.length) i1 = freq.length;
    var sum = 0, n = 0, i;
    for (i = i0; i < i1; i++) { sum += freq[i] || 0; n++; }
    return n ? (sum / n) / 255 : 0;
  }

  /* Grave / medio / agudo 0..1, sobre el 72% útil del espectro. */
  function bassMidTreble(freq) {
    return {
      bass: bandEnergy(freq, 0, 0.10),
      mid: bandEnergy(freq, 0.10, 0.40),
      treble: bandEnergy(freq, 0.40, 0.72)
    };
  }

  /* Radios de los 3 anillos concéntricos: el grave manda en el anillo
     exterior, el agudo en el interior. base = radio mínimo, maxR = cuánto
     puede crecer cada anillo con la energía (0..1). */
  function ringsRadii(e, base, maxR) {
    e = e || {};
    return {
      bass: base + (e.bass || 0) * maxR,
      mid: base * 0.7 + (e.mid || 0) * maxR * 0.75,
      treble: base * 0.45 + (e.treble || 0) * maxR * 0.5
    };
  }

  /* Muestras de tiempo (0..255, 128 = silencio) -> puntos [x, y] de la
     onda sobre el canvas. */
  function wavePoints(td, width, height) {
    var pts = [], i;
    if (!td || !td.length || !width || !height) return pts;
    for (i = 0; i < td.length; i++) {
      pts.push([ (i / (td.length - 1)) * width, (td[i] / 255) * height ]);
    }
    return pts;
  }

  function mixRgb(a, b, f) {
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
  }

  function scaleRgb(a, f) {
    return [Math.min(255, Math.round(a[0] * f)), Math.min(255, Math.round(a[1] * f)), Math.min(255, Math.round(a[2] * f))];
  }

  function rgba(rgb, alpha) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  }

  /* Color dominante de una imagen ya reducida (datos RGBA planos, como los
     de getImageData). Mismo criterio que extractCoverAccent() de la app:
     se ignoran los píxeles casi negros o casi blancos (no aportan color)
     y los píxeles con color pesan más que los grises. null si no hay
     ningún píxel aprovechable. */
  function dominantColorFromPixels(data) {
    if (!data || typeof data.length !== 'number' || data.length < 4) return null;
    var r = 0, g = 0, b = 0, w = 0, i, R, G, B, mx, mn, lum, sat, weight;
    for (i = 0; i + 3 < data.length; i += 4) {
      R = data[i]; G = data[i + 1]; B = data[i + 2];
      mx = Math.max(R, G, B); mn = Math.min(R, G, B);
      lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (lum < 16 || lum > 245) continue;
      sat = mx === 0 ? 0 : (mx - mn) / mx;
      weight = 0.25 + sat * 1.6;
      r += R * weight; g += G * weight; b += B * weight; w += weight;
    }
    return w ? [Math.round(r / w), Math.round(g / w), Math.round(b / w)] : null;
  }

  /* Fondo del brillo: dos radiales suaves con el color de la portada
     (arriba, más intenso; abajo a la derecha, más apagado) sobre
     transparente. La opacidad queda en el CSS (#rpmVisualGlow.on). */
  function glowBackground(rgb) {
    if (!rgb) return '';
    var light = mixRgb(rgb, [255, 255, 255], 0.35);
    return 'radial-gradient(60% 55% at 50% 0%, ' + rgba(rgb, 0.34) + ' 0%, ' + rgba(rgb, 0.12) + ' 55%, transparent 78%), ' +
      'radial-gradient(55% 45% at 88% 100%, ' + rgba(light, 0.20) + ' 0%, transparent 70%)';
  }

  /* ¿Debe haber un rAF del módulo corriendo? Solo mientras suena un modo
     nuevo y la pestaña está visible. */
  function shouldAnimate(s) {
    if (!s) return false;
    return !!s.playing && !!s.hasSrc && !!s.styleIsNew && !s.hidden;
  }

  /* ---- Pegamento con el DOM (todo dentro de try/catch) ---- */

  var GLOW_KEY = 'reproductor-visual-glow'; // '1' = encendido (defecto), '0' = apagado
  var BAR_COUNT = 36;

  var audio = null, viz = null, vizCtx = null, coverImg = null, select = null;
  var tapCtx = null, tapAnalyser = null, tapUnsupported = false;
  var freqArr = null, timeArr = null;
  var rafId = null, accentCache = null, glowEl = null, glowOn = true;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function currentStyle() {
    try { return select && select.value ? select.value : 'bars'; } catch (e) { return 'bars'; }
  }

  function readAccent() {
    if (accentCache) return accentCache;
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      accentCache = (v && v.trim()) ? v.trim() : 'rgba(255,255,255,0.9)';
    } catch (e) { accentCache = 'rgba(255,255,255,0.9)'; }
    return accentCache;
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./visual.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './visual.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el brillo no se ve, pero el visualizador sigue */ }
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

  /* Respaldo: tap por captureStream(). Se intenta al sonar (gesto del
     usuario) y solo si no hay puente. Si el navegador no lo tiene, no se
     vuelve a intentar en la sesión. */
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

  /* Base quieta, igual que la del modo inactivo de la app: 36 barritas
     tenues. Es lo que queda en el canvas cuando no suena un modo nuevo. */
  function drawIdle() {
    if (!vizCtx || !viz) return;
    try {
      var w = viz.width, h = viz.height, j, bh2, bw2 = w / BAR_COUNT;
      vizCtx.clearRect(0, 0, w, h);
      vizCtx.fillStyle = 'rgba(255,255,255,0.35)';
      for (j = 0; j < BAR_COUNT; j++) {
        bh2 = 3 + Math.abs(Math.sin(j * 0.7)) * 5;
        vizCtx.fillRect(j * bw2 + bw2 * 0.22, h - bh2, bw2 * 0.56, bh2);
      }
    } catch (e) {}
  }

  function drawCombo(w, h, freq, td) {
    var values = freqToBars(freq, BAR_COUNT);
    var heights = barHeights(values, h);
    var bw = w / BAR_COUNT, i, x, y;
    vizCtx.fillStyle = 'rgba(255,255,255,0.85)';
    for (i = 0; i < BAR_COUNT; i++) {
      x = i * bw + bw * 0.22; y = h - heights[i];
      vizCtx.beginPath();
      if (vizCtx.roundRect) vizCtx.roundRect(x, y, bw * 0.56, heights[i], 4);
      else vizCtx.rect(x, y, bw * 0.56, heights[i]);
      vizCtx.fill();
    }
    /* Onda encima de las barras, con el acento actual. */
    var pts = wavePoints(td, w, h);
    if (pts.length) {
      vizCtx.strokeStyle = readAccent();
      vizCtx.globalAlpha = 0.95;
      vizCtx.lineWidth = 2.5;
      vizCtx.beginPath();
      for (i = 0; i < pts.length; i++) {
        if (i === 0) vizCtx.moveTo(pts[i][0], pts[i][1]);
        else vizCtx.lineTo(pts[i][0], pts[i][1]);
      }
      vizCtx.stroke();
      vizCtx.globalAlpha = 1;
    }
  }

  function drawRings(w, h, freq) {
    var e = bassMidTreble(freq);
    var radii = ringsRadii(e, Math.min(w, h) * 0.12, Math.min(w, h) * 0.42);
    var cx = w / 2, cy = h / 2 + 4;
    var overall = (e.bass + e.mid + e.treble) / 3;
    vizCtx.lineCap = 'round';
    var rings = [
      { r: radii.bass, w: 5, style: 'rgba(255,255,255,0.9)' },
      { r: radii.mid, w: 4, style: readAccent() },
      { r: radii.treble, w: 3, style: 'rgba(255,255,255,0.6)' }
    ];
    rings.forEach(function (rg) {
      if (rg.r <= 0) return;
      vizCtx.strokeStyle = rg.style;
      vizCtx.lineWidth = rg.w;
      vizCtx.beginPath();
      vizCtx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      vizCtx.stroke();
    });
    /* Punto central que late con el nivel general. */
    vizCtx.fillStyle = 'rgba(255,255,255,0.9)';
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, 3 + overall * 8, 0, Math.PI * 2);
    vizCtx.fill();
  }

  function stopLoop() {
    if (rafId !== null) {
      try { cancelAnimationFrame(rafId); } catch (e) {}
      rafId = null;
    }
    suspendTap();
  }

  function frame() {
    rafId = null;
    try {
      if (!isNewVizStyle(currentStyle())) { stopLoop(); return; }
      if (!audio || audio.paused || audio.ended || !audio.src || document.hidden) {
        drawIdle(); stopLoop(); return;
      }
      var an = getAnalyser();
      if (!an) { drawIdle(); stopLoop(); return; }
      if (!freqArr || freqArr.length !== an.frequencyBinCount) freqArr = new Uint8Array(an.frequencyBinCount);
      if (!timeArr || timeArr.length !== an.fftSize) timeArr = new Uint8Array(an.fftSize);
      an.getByteFrequencyData(freqArr);
      an.getByteTimeDomainData(timeArr);
      var w = viz.width, h = viz.height;
      vizCtx.clearRect(0, 0, w, h);
      if (currentStyle() === 'rings') drawRings(w, h, freqArr);
      else drawCombo(w, h, freqArr, timeArr);
    } catch (e) {
      /* Un frame fallido no mata el módulo: se deja la base quieta y se para. */
      try { drawIdle(); } catch (e2) {}
      stopLoop();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId !== null) return;
    if (!isNewVizStyle(currentStyle())) return;
    if (!audio || audio.paused || audio.ended || !audio.src || document.hidden) return;
    ensureTap();
    resumeTap();
    rafId = requestAnimationFrame(frame);
  }

  /* ---- Fondo con el color de la portada ---- */

  function loadGlowPref() {
    try {
      var v = localStorage.getItem(GLOW_KEY);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }

  function saveGlowPref() {
    try { localStorage.setItem(GLOW_KEY, glowOn ? '1' : '0'); } catch (e) {}
  }

  function ensureGlowEl() {
    try {
      glowEl = document.getElementById('rpmVisualGlow');
      if (glowEl) return;
      glowEl = document.createElement('div');
      glowEl.id = 'rpmVisualGlow';
      glowEl.setAttribute('aria-hidden', 'true');
      var bgPhoto = document.getElementById('bgPhoto');
      if (bgPhoto && bgPhoto.parentNode) bgPhoto.parentNode.insertBefore(glowEl, bgPhoto);
      else if (document.body) document.body.insertBefore(glowEl, document.body.firstChild);
    } catch (e) { glowEl = null; }
  }

  function hideGlow() {
    if (!glowEl) return;
    try {
      glowEl.classList.remove('on');
      glowEl.style.background = '';
    } catch (e) {}
  }

  function refreshGlow() {
    if (!glowEl) return;
    try {
      if (!glowOn) { hideGlow(); return; }
      if (!coverImg || coverImg.style.display === 'none' || !coverImg.complete || !coverImg.naturalWidth) { hideGlow(); return; }
      var cv = document.createElement('canvas');
      cv.width = 24; cv.height = 24;
      var cx = cv.getContext('2d');
      cx.drawImage(coverImg, 0, 0, 24, 24);
      var px = cx.getImageData(0, 0, 24, 24).data;
      var rgb = dominantColorFromPixels(px);
      if (!rgb) { hideGlow(); return; }
      accentCache = null; // el acento puede seguir a la portada: releerlo
      glowEl.style.background = glowBackground(rgb);
      glowEl.classList.add('on');
    } catch (e) { hideGlow(); } // canvas manchado, portada sin cargar, etc.
  }

  function syncGlowUI() {
    try {
      var b = document.getElementById('btnVisualGlow');
      if (!b) return;
      b.classList.toggle('on', !!glowOn);
      b.setAttribute('aria-pressed', glowOn ? 'true' : 'false');
      var st = document.getElementById('visualGlowState');
      if (st) st.textContent = glowOn ? 'Activado' : 'Apagado';
    } catch (e) {}
  }

  function buildGlowToggle() {
    try {
      if (document.getElementById('btnVisualGlow')) { syncGlowUI(); return; }
      var anchor = document.getElementById('btnDynTheme');
      if (!anchor || !anchor.parentNode) return; // sin ancla no hay botón; el brillo queda encendido por defecto
      var wrap = document.createElement('div');
      wrap.className = 'sound-inline';
      wrap.style.marginTop = '12px';
      wrap.innerHTML = '<button class="toggle-pill" id="btnVisualGlow" type="button" aria-pressed="true">' +
        '<span class="dot"></span><span>Fondo con el color de la portada:&nbsp;</span>' +
        '<span id="visualGlowState">Activado</span></button>';
      anchor.parentNode.parentNode.insertBefore(wrap, anchor.parentNode.nextSibling);
      var btn = document.getElementById('btnVisualGlow');
      btn.addEventListener('click', function () {
        glowOn = !glowOn;
        saveGlowPref();
        syncGlowUI();
        if (glowOn) refreshGlow(); else hideGlow();
      });
      syncGlowUI();
    } catch (e) {}
  }

  function init() {
    try {
      audio = $('audio');
      viz = $('viz');
      coverImg = $('coverImg');
      select = $('vizStyleSelect');
      if (!audio || !viz) return; // sin reproductor no hay nada que hacer
      vizCtx = viz.getContext('2d');
      if (!vizCtx) return;
      glowOn = loadGlowPref();
      ensureCss();
      ensureGlowEl();
      buildGlowToggle();
      refreshGlow();

      audio.addEventListener('play', function () { refreshGlow(); startLoop(); });
      audio.addEventListener('pause', function () { if (isNewVizStyle(currentStyle())) { drawIdle(); stopLoop(); } });
      audio.addEventListener('ended', function () { if (isNewVizStyle(currentStyle())) { drawIdle(); stopLoop(); } });
      audio.addEventListener('loadedmetadata', function () { accentCache = null; refreshGlow(); });
      if (coverImg) coverImg.addEventListener('load', function () { accentCache = null; refreshGlow(); });
      if (select) select.addEventListener('change', function () {
        if (isNewVizStyle(currentStyle())) {
          if (audio && !audio.paused && audio.src) startLoop();
          else drawIdle();
        } else {
          stopLoop(); // el modo viejo lo vuelve a dibujar drawViz() de la app
        }
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopLoop();
        else startLoop();
      });

      if (isNewVizStyle(currentStyle())) {
        if (audio && !audio.paused && audio.src) startLoop();
        else drawIdle();
      }
    } catch (e) { /* fail-safe: la app sigue sin este módulo */ }
  }

  var api = {
    isNewVizStyle: isNewVizStyle,
    sanitizeVizStyle: sanitizeVizStyle,
    vizStyleLabel: vizStyleLabel,
    freqToBars: freqToBars,
    barHeights: barHeights,
    bandEnergy: bandEnergy,
    bassMidTreble: bassMidTreble,
    ringsRadii: ringsRadii,
    wavePoints: wavePoints,
    mixRgb: mixRgb,
    scaleRgb: scaleRgb,
    rgba: rgba,
    dominantColorFromPixels: dominantColorFromPixels,
    glowBackground: glowBackground,
    shouldAnimate: shouldAnimate,
    handles: isNewVizStyle
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__visualHelpers = api; } catch (e) {}
  try { global.__rpmVisual = { handles: isNewVizStyle, isNewVizStyle: isNewVizStyle, version: '3.2.0' }; } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
