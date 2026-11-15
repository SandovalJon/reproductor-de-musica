/* Sonidos para dormir para Reproductor de Música — v3.9.0.
   Módulo aparte: NO toca app/index.html ni ningún otro archivo de la
   app (ver WIRING.md para cablearlo con dos líneas). Se engancha solo
   por DOM y por el hook window.__rpmApp que la app ya expone (toast).
   Si el módulo falla o no carga, la app sigue funcionando como sin él:
   todo el código va dentro de try/catch y nunca lanza errores globales.

   Qué hace:
   - Tres sonidos generados EN LOCAL con Web Audio, sin archivos de
     audio ni internet: lluvia, mar y ruido blanco. Todos parten de
     ruido blanco en bucle (un buffer generado una vez) filtrado y
     modulado de forma distinta por sonido (ver SOUND_PARAMS).
   - Controles: elegir sonido, volumen propio (0-100, independiente
     del volumen de la música), temporizador de apagado (15/30/60 min
     o sin temporizador) con fundido de salida en los últimos 30 s, y
     botón parar. Fundido de entrada de 3 s al arrancar.
   - Suena aunque no haya ninguna canción cargada: usa su propio
     AudioContext y su propio GainNode, nunca el <audio> de la app ni
     el deslizador #volume. No pausa, no baja ni toca la música.

   Comportamiento elegido con la música (documentado, no negociable
   en silencio):
   - Si suena música al arrancar (o mientras suena el sonido), el
     sonido para dormir SE MEZCLA ATENUADO: su volumen efectivo es
     la mitad del elegido (factor 0.5), y el panel lo avisa con
     «Mezclado con la música: volumen a la mitad». La música manda:
     nunca se pausa ni se baja por este módulo.
   - Si no suena música, el sonido suena al volumen elegido.
   - El usuario puede parar el sonido en cualquier momento; parar el
     sonido nunca pausa la música.

   Relación con el temporizador de apagado de la app (importante):
   - La app ya tiene su sleep timer («Temporizador de apagado»,
     #sleepSelect / #sleepStatus, y «Dormir tras N canciones»,
     #sleepSongsStatus). Este módulo NO lo toca, NO lo desactiva y
     NO lee ni escribe su estado interno (vive dentro del IIFE
     cerrado de index.html y no está expuesto).
   - Lo único que hace es DETECTARLO por DOM, en el momento de
     arrancar y mientras suena: si #sleepSelect tiene un valor
     distinto de '0', o #sleepStatus / #sleepSongsStatus muestran
     texto, el panel avisa «El temporizador de apagado de la app
     está activo: apagará la MÚSICA, no este sonido» y lo deja
     correr. El sonido para dormir tiene su propio temporizador y
     su propio fundido; si los dos coinciden, cada uno apaga lo
     suyo y el sonido para dormir sigue hasta su propio temporizador
     (o hasta que el usuario lo pare). Nunca se apaga el sleep
     timer por detrás.
   - Tampoco toca el modo enfoque / Pomodoro: no lee ni escribe
     ninguno de sus controles; si otro módulo baja el volumen de la
     música, a este sonido no le afecta (tiene su propio GainNode).

   Como el resto de módulos, el sonido solo suena con la app
   abierta: si cierras la app o el navegador duerme la pestaña, el
   AudioContext se suspende y el temporizador se detecta al volver
   (se calcula con la hora del sistema, no con ticks contados).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./dormir.css">
     <script src="./dormir.js"></script>
   Pruebas Node: node --test dormir.test.mjs
   Consola: window.__dormir.getState() / .open() / .close() /
     .start('lluvia') / .stop() */
(function (g) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var VERSION = '3.9.0';
  var CONFIG_KEY = 'reproductor-dormir:config';
  var TICK_MS = 250;
  var FADE_IN_SEC = 3;    /* fundido de entrada al arrancar */
  var FADE_OUT_SEC = 30;  /* fundido de salida al final del temporizador */
  var MIX_FACTOR = 0.5;   /* volumen efectivo si suena música */
  var TIMER_OPTIONS_MIN = [0, 15, 30, 60]; /* 0 = sin temporizador */

  /* Parámetros de cada sonido. Todos parten del mismo ruido blanco en
     bucle; lo que cambia es el filtro y la modulación (LFO):
     - lluvia: pasabanda ~1400 Hz, Q baja; LFO lento (0.13 Hz) mueve
       la frecuencia del filtro ±15 %: gotas que van y vienen.
     - mar: pasabajas ~500 Hz; LFO muy lento (0.1 Hz) mueve la
       frecuencia del filtro entre 300 y 800 Hz: oleaje que sube/baja.
     - blanco: sin coloración (pasabajas muy abierto, 10000 Hz) y sin
       LFO: ruido constante.
     baseGain es la ganancia del sonido a volumen 100 (0..1) antes de
     aplicar el volumen del usuario; la lluvia y el mar van algo más
     bajos que el blanco porque su filtro concentra energía. */
  var SOUND_PARAMS = {
    lluvia: {
      label: '🌧 Lluvia',
      filterType: 'bandpass', frequency: 1400, q: 0.6,
      lfoRate: 0.13, lfoDepth: 0.15, lfoTarget: 'frequency',
      baseGain: 0.55
    },
    mar: {
      label: '🌊 Mar',
      filterType: 'lowpass', frequency: 500, q: 0.4,
      lfoRate: 0.1, lfoDepth: 0.5, lfoTarget: 'frequency',
      baseGain: 0.6
    },
    blanco: {
      label: '📻 Ruido blanco',
      filterType: 'lowpass', frequency: 10000, q: 0.0,
      lfoRate: 0, lfoDepth: 0, lfoTarget: 'none',
      baseGain: 0.35
    }
  };
  var SOUND_IDS = ['lluvia', 'mar', 'blanco'];

  function isObject(v) { return v !== null && typeof v === 'object'; }
  function clamp(v, min, max) {
    var n = parseFloat(v);
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }
  function clampInt(v, min, max, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function isSoundId(id) { return SOUND_IDS.indexOf(id) !== -1; }

  /* Parámetros de un sonido (copia; id desconocido -> lluvia). */
  function soundParams(id) {
    var p = SOUND_PARAMS[isSoundId(id) ? id : 'lluvia'];
    return JSON.parse(JSON.stringify(p));
  }

  var DEFAULT_CONFIG = { sound: 'lluvia', volume: 60, timerMin: 30 };

  /* Config válida o los valores por defecto. timerMin solo admite
     0/15/30/60; cualquier otro valor -> 30. Campos desconocidos se
     descartan; volumen fuera de rango se limita. */
  function sanitizeConfig(raw) {
    var out = {
      sound: DEFAULT_CONFIG.sound,
      volume: DEFAULT_CONFIG.volume,
      timerMin: DEFAULT_CONFIG.timerMin
    };
    if (!isObject(raw)) return out;
    if (isSoundId(raw.sound)) out.sound = raw.sound;
    out.volume = clampInt(raw.volume, 0, 100, out.volume);
    var t = parseInt(raw.timerMin, 10);
    if (TIMER_OPTIONS_MIN.indexOf(t) !== -1) out.timerMin = t;
    return out;
  }

  /* Persistencia con un store {getItem,setItem,removeItem}
     (localStorage en el navegador, un doble en los tests). Nunca lanza. */
  function loadConfig(store) {
    try {
      if (!store) return sanitizeConfig(null);
      var raw = store.getItem(CONFIG_KEY);
      if (!raw) return sanitizeConfig(null);
      return sanitizeConfig(JSON.parse(raw));
    } catch (e) { return sanitizeConfig(null); }
  }
  function saveConfig(store, config) {
    try {
      if (!store) return false;
      store.setItem(CONFIG_KEY, JSON.stringify(sanitizeConfig(config)));
      return true;
    } catch (e) { return false; }
  }

  /* ================= Fundidos (puros) ================= */

  /* Interpolación lineal de `from` a `to` con progreso 0..1. */
  function fadeValueAt(progress, from, to) {
    var p = clamp(progress, 0, 1);
    return from + (to - from) * p;
  }
  /* Factor 0..1 del fundido de entrada: 0 al arrancar, 1 tras fadeMs. */
  function fadeInFactor(elapsedMs, fadeMs) {
    if (!(fadeMs > 0)) return 1;
    return clamp(elapsedMs / fadeMs, 0, 1);
  }
  /* Factor 0..1 del fundido de salida: 1 mientras quede más de
     fadeMs, 0 al llegar a cero (lineal en los últimos fadeMs). */
  function fadeOutFactor(remainingMs, fadeMs) {
    if (!(fadeMs > 0)) return 1;
    if (!(remainingMs > 0)) return 0;
    return clamp(remainingMs / fadeMs, 0, 1);
  }
  /* Factor combinado: el menor de entrada y salida. Sin temporizador
     (remainingMs null) no hay fundido de salida. */
  function combinedFadeFactor(elapsedMs, remainingMs, fadeInMs, fadeOutMs) {
    var fIn = fadeInFactor(elapsedMs, fadeInMs);
    if (remainingMs === null || remainingMs === undefined) return fIn;
    return Math.min(fIn, fadeOutFactor(remainingMs, fadeOutMs));
  }

  /* ================= Temporizador y estados (puros) ================= */

  /* Estados: 'idle' (parado), 'playing' (sonando), 'fading'
     (en fundido de salida, últimos FADE_OUT_SEC s del temporizador).
     'stopped' no se guarda: parar vuelve a 'idle'. */
  function createSession() {
    return {
      status: 'idle',
      sound: DEFAULT_CONFIG.sound,
      volume: DEFAULT_CONFIG.volume,
      timerMin: DEFAULT_CONFIG.timerMin,
      startedAt: 0,   /* epoch ms en que empezó a sonar */
      endsAt: 0,      /* epoch ms en que termina; 0 = sin temporizador */
      fadeStarted: false
    };
  }

  function timerDurationMs(timerMin) {
    var t = parseInt(timerMin, 10);
    if (TIMER_OPTIONS_MIN.indexOf(t) === -1 || t === 0) return 0;
    return t * 60 * 1000;
  }
  function remainingMs(endsAt, nowMs) {
    if (!(endsAt > 0)) return null; /* sin temporizador */
    return Math.max(0, endsAt - nowMs);
  }
  function remainingSeconds(endsAt, nowMs) {
    var r = remainingMs(endsAt, nowMs);
    return r === null ? null : Math.ceil(r / 1000);
  }
  function fmtMMSS(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined) return '—';
    var sec = Math.max(0, Math.floor(totalSeconds || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  /* ¿Toca empezar el fundido de salida? Sí cuando queda menos que
     el fundido y el temporizador existe. */
  function shouldStartFade(remainingMsValue, fadeOutMs) {
    if (remainingMsValue === null || remainingMsValue === undefined) return false;
    return remainingMsValue <= fadeOutMs && remainingMsValue > 0;
  }

  /* Arrancar: devuelve una sesión nueva (no muta la recibida).
     Nunca arranca sola: la capa del navegador solo la llama desde
     un clic del usuario. */
  function startSession(session, config, nowMs) {
    var c = sanitizeConfig(config);
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    var dur = timerDurationMs(c.timerMin);
    return {
      status: 'playing',
      sound: c.sound,
      volume: c.volume,
      timerMin: c.timerMin,
      startedAt: now,
      endsAt: dur > 0 ? now + dur : 0,
      fadeStarted: false
    };
  }
  /* Parar: vuelve a 'idle' (sin temporizador pendiente). */
  function stopSession(session) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    s.status = 'idle';
    s.startedAt = 0;
    s.endsAt = 0;
    s.fadeStarted = false;
    return s;
  }
  /* Cambiar de sonido en marcha: mismo estado, mismo temporizador. */
  function changeSound(session, soundId) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    if (isSoundId(soundId)) s.sound = soundId;
    return s;
  }
  /* Cambiar el volumen en marcha (0-100, limitado). */
  function changeVolume(session, volume) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    s.volume = clampInt(volume, 0, 100, s.volume);
    return s;
  }

  /* Avance puro del temporizador: dado el estado y la hora, devuelve
     {session, event}. Eventos: null (sigue igual), 'fadeStart'
     (entra en fundido de salida), 'expired' (temporizador cumplido:
     la sesión vuelve a 'idle'; la capa del navegador corta el audio).
     Si no hay temporizador, nunca expira ni entra en fundido. */
  function sessionTick(session, nowMs) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    if (s.status === 'idle' || !(s.endsAt > 0)) {
      return { session: s, event: null };
    }
    var left = remainingMs(s.endsAt, now);
    if (left <= 0) {
      return { session: stopSession(s), event: 'expired' };
    }
    if (!s.fadeStarted && shouldStartFade(left, FADE_OUT_SEC * 1000)) {
      s.status = 'fading';
      s.fadeStarted = true;
      return { session: s, event: 'fadeStart' };
    }
    return { session: s, event: null };
  }

  /* ================= Mezcla con la música (puro) ================= */

  /* Volumen efectivo del sonido para dormir (0-100): si suena música,
     la mitad del elegido; si no, el elegido. La música nunca se toca. */
  function effectiveVolume(volume0to100, musicPlaying) {
    var v = clampInt(volume0to100, 0, 100, 0);
    if (!musicPlaying) return v;
    return Math.round(v * MIX_FACTOR);
  }
  /* Ganancia lineal 0..1 que se aplica al GainNode: volumen efectivo
     * ganancia base del sonido * factor de fundido. */
  function nodeGain(volume0to100, musicPlaying, soundId, fadeFactor) {
    var p = soundParams(soundId);
    var eff = effectiveVolume(volume0to100, musicPlaying) / 100;
    return eff * p.baseGain * clamp(fadeFactor, 0, 1);
  }

  /* ================= Detección del sleep timer de la app (puro) ================= */

  /* Entrada: lo que se lee por DOM en la app (nada de su estado
     interno, que no está expuesto):
       sleepSelectValue: valor de #sleepSelect ('0' = desactivado,
         '5'/'10'/'15'/'30'/'45'/'60' = en N min, '-1' = al terminar
         la canción).
       sleepStatusText: texto de #sleepStatus.
       sleepSongsStatusText: texto de #sleepSongsStatus.
     Salida: {active, kind, detail} con kind 'minutes' |
     'after-track' | 'songs' | null. Cualquier señal basta: el valor
     del select es la fuente principal y los textos el respaldo (la
     app los rellena en updateSleepUI). */
  function detectSleepTimerConflict(input) {
    var inp = isObject(input) ? input : {};
    var sel = String(inp.sleepSelectValue === undefined || inp.sleepSelectValue === null
      ? '0' : inp.sleepSelectValue);
    var statusText = String(inp.sleepStatusText || '').trim();
    var songsText = String(inp.sleepSongsStatusText || '').trim();
    if (sel === '-1' || /terminar esta canci/i.test(statusText)) {
      return { active: true, kind: 'after-track',
        detail: 'La música se detendrá al terminar esta canción.' };
    }
    if (sel !== '0' && sel !== '') {
      var mins = parseInt(sel, 10);
      return { active: true, kind: 'minutes',
        detail: isFinite(mins) && mins > 0
          ? 'La música se apagará en ' + mins + ' min.'
          : 'El temporizador de apagado de la música está activo.' };
    }
    if (statusText !== '') {
      return { active: true, kind: 'minutes', detail: statusText };
    }
    if (songsText !== '') {
      return { active: true, kind: 'songs',
        detail: 'Dormir tras canciones está activo: ' + songsText };
    }
    return { active: false, kind: null, detail: '' };
  }

  /* Aviso que se muestra al arrancar el sonido si hay conflicto.
     No desactiva nada: solo informa (el sleep timer apaga la
     música, no este sonido). */
  function sleepTimerWarning(conflict) {
    if (!conflict || !conflict.active) return '';
    return 'El temporizador de apagado de la app está activo: apagará ' +
      'la MÚSICA (' + conflict.detail + '), no este sonido. Este sonido ' +
      'sigue con su propio temporizador.';
  }

  /* ================= Capa navegador (solo con document) ================= */

  var state = {
    config: sanitizeConfig(null),
    session: createSession(),
    audioCtx: null,
    nodes: null, /* {source, filter, gain, lfo, lfoGain} */
    noiseBuffer: null,
    tickTimer: null,
    fadeTimer: null
  };
  var els = {};
  var store = null;

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { /* nunca romper la app */ }
    };
  }
  function toast(msg) {
    try {
      if (g.__rpmApp && typeof g.__rpmApp.toast === 'function') {
        g.__rpmApp.toast(msg); return;
      }
    } catch (e) {}
  }

  /* ¿Suena música ahora mismo? Solo se lee <audio>: nunca se pausa
     ni se toca. Sin canción cargada, audio.paused es true y no hay
     src: el sonido para dormir suena igual, a volumen completo. */
  function isMusicPlaying() {
    try {
      var a = $('audio');
      return !!a && !!a.currentSrc && !a.paused && !a.ended;
    } catch (e) { return false; }
  }

  /* Lectura del sleep timer de la app, solo por DOM (ver
     detectSleepTimerConflict). No se escribe nada en sus controles. */
  function readSleepTimerState() {
    try {
      var sel = $('sleepSelect');
      var st = $('sleepStatus');
      var songs = $('sleepSongsStatus');
      return detectSleepTimerConflict({
        sleepSelectValue: sel ? sel.value : '0',
        sleepStatusText: st ? st.textContent : '',
        sleepSongsStatusText: songs ? songs.textContent : ''
      });
    } catch (e) {
      return { active: false, kind: null, detail: '' };
    }
  }

  /* --- Web Audio: ruido blanco en bucle, filtrado y modulado --- */

  function ensureAudioCtx() {
    try {
      if (state.audioCtx) {
        if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
        return state.audioCtx;
      }
      var AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return null;
      state.audioCtx = new AC();
      return state.audioCtx;
    } catch (e) { return null; }
  }

  function getNoiseBuffer(ctx) {
    try {
      if (state.noiseBuffer) return state.noiseBuffer;
      var len = ctx.sampleRate * 2; /* 2 s de ruido, en bucle */
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      state.noiseBuffer = buf;
      return buf;
    } catch (e) { return null; }
  }

  /* Monta la cadena: fuente de ruido -> filtro -> ganancia -> destino.
     El LFO (si el sonido lo tiene) modula la frecuencia del filtro. */
  function buildNodes(ctx, soundId) {
    var p = soundParams(soundId);
    var src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    src.loop = true;
    var filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.frequency.value = p.frequency;
    filter.Q.value = p.q;
    var gain = ctx.createGain();
    gain.gain.value = 0; /* entra con fundido de 3 s */
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    var nodes = { source: src, filter: filter, gain: gain, lfo: null, lfoGain: null };
    if (p.lfoRate > 0 && p.lfoDepth > 0 && p.lfoTarget === 'frequency') {
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.lfoRate;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = p.frequency * p.lfoDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      nodes.lfo = lfo;
      nodes.lfoGain = lfoGain;
    }
    return nodes;
  }

  function applyGain(fadeFactor) {
    try {
      if (!state.nodes || !state.audioCtx) return;
      var target = nodeGain(state.session.volume, isMusicPlaying(),
        state.session.sound, fadeFactor);
      state.nodes.gain.gain.setTargetAtTime(target,
        state.audioCtx.currentTime, 0.1);
    } catch (e) {}
  }

  function stopNodes() {
    try {
      if (!state.nodes) return;
      var n = state.nodes;
      state.nodes = null;
      try { if (n.lfo) n.lfo.stop(); } catch (e) {}
      try { n.source.stop(); } catch (e) {}
      try { n.source.disconnect(); } catch (e) {}
      try { n.filter.disconnect(); } catch (e) {}
      try { n.gain.disconnect(); } catch (e) {}
    } catch (e) {}
  }

  function startTicking() {
    stopTicking();
    state.tickTimer = setInterval(safe(tick), TICK_MS);
    tick();
  }
  function stopTicking() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
  }

  function tick() {
    try {
      var s = state.session;
      if (s.status === 'idle') { render(); return; }
      var now = Date.now();
      var res = sessionTick(s, now);
      state.session = res.session;
      if (res.event === 'fadeStart') {
        startFadeOut();
        toast('🌙 El sonido para dormir se apaga suavemente en 30 s.');
      } else if (res.event === 'expired') {
        stopAudioOnly();
        stopTicking();
        toast('🌙 Sonido para dormir apagado: terminó su temporizador.');
      }
      /* Fundido de entrada: se recalcula en cada tick hasta llegar a 1. */
      if (state.session.status === 'playing') {
        var elapsed = now - state.session.startedAt;
        applyGain(fadeInFactor(elapsed, FADE_IN_SEC * 1000));
      }
      render();
    } catch (e) {}
  }

  /* Fundido de salida de 30 s con el GainNode: baja linealmente de
     su nivel actual a 0. Al terminar, el tick ya habrá puesto la
     sesión en 'idle' (expired) y cortado el audio. */
  function startFadeOut() {
    try {
      if (state.fadeTimer || !state.nodes || !state.audioCtx) return;
      var ctx = state.audioCtx;
      var gain = state.nodes.gain.gain;
      var from = gain.value;
      var steps = Math.max(2, Math.round(FADE_OUT_SEC * 10));
      var i = 0;
      state.fadeTimer = setInterval(function () {
        try {
          i++;
          var f = fadeValueAt(i / steps, 1, 0);
          gain.setTargetAtTime(Math.max(0, from * f), ctx.currentTime, 0.1);
          if (i >= steps) {
            clearInterval(state.fadeTimer);
            state.fadeTimer = null;
          }
        } catch (e) {
          if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
        }
      }, 100);
    } catch (e) {}
  }

  function stopAudioOnly() {
    try {
      stopNodes();
      if (state.audioCtx && state.audioCtx.state === 'running') {
        state.audioCtx.suspend();
      }
    } catch (e) {}
  }

  /* --- Acciones por clic del usuario (nunca automáticas) --- */

  function startSound(soundId) {
    try {
      var cfg = readConfigFromForm();
      if (soundId && isSoundId(soundId)) cfg.sound = soundId;
      state.config = cfg;
      persistConfig();
      var ctx = ensureAudioCtx();
      if (!ctx) { toast('🌙 Tu navegador no permite audio generado (Web Audio no disponible).'); return false; }
      stopNodes();
      if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
      state.session = startSession(state.session, cfg, Date.now());
      state.nodes = buildNodes(ctx, state.session.sound);
      if (!state.nodes) { state.session = stopSession(state.session); return false; }
      try {
        state.nodes.source.start();
        if (state.nodes.lfo) state.nodes.lfo.start();
      } catch (e) { state.session = stopSession(state.session); return false; }
      /* Aviso de mezcla con la música (si suena) y de conflicto con
         el sleep timer de la app (si está activo). Ninguno impide
         arrancar ni apaga nada por detrás. */
      var conflict = readSleepTimerState();
      var warn = sleepTimerWarning(conflict);
      if (isMusicPlaying()) {
        toast('🌙 Sonido para dormir sonando mezclado con la música, a la mitad de volumen.' +
          (warn ? ' ' + warn : ''));
      } else if (warn) {
        toast('🌙 ' + warn);
      } else {
        toast('🌙 Sonido para dormir: ' + soundParams(state.session.sound).label + '.');
      }
      startTicking();
      render();
      return true;
    } catch (e) { return false; }
  }

  function stopSound() {
    try {
      if (state.session.status === 'idle') return false;
      state.session = stopSession(state.session);
      stopAudioOnly();
      stopTicking();
      toast('🌙 Sonido para dormir parado.');
      render();
      return true;
    } catch (e) { return false; }
  }

  function persistConfig() {
    try { if (store) saveConfig(store, state.config); } catch (e) {}
  }
  function readConfigFromForm() {
    try {
      var cfg = sanitizeConfig({
        sound: els.soundSelect ? els.soundSelect.value : state.config.sound,
        volume: els.volume ? els.volume.value : state.config.volume,
        timerMin: els.timerSelect ? els.timerSelect.value : state.config.timerMin
      });
      state.config = cfg;
      persistConfig();
      return cfg;
    } catch (e) { return state.config; }
  }

  /* --- UI --- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function buildOpenButton() {
    try {
      if ($('rpmDormirOpenBtn')) return $('rpmDormirOpenBtn');
      var b = el('button', 'btn small', '🌙 Dormir');
      b.id = 'rpmDormirOpenBtn';
      b.type = 'button';
      b.title = 'Sonidos para dormir: lluvia, mar o ruido blanco, generados en el dispositivo (módulo aparte)';
      b.setAttribute('aria-pressed', 'false');
      /* Ancla: junto al botón «Dormir tras N canciones» de la app
         (#btnSleepSongs), en el grupo del temporizador de apagado.
         Si esa fila no existe, junto a «Modo enfoque» (#btnFocus);
         si tampoco, al final de la tarjeta del reproductor. */
      var anchor = $('btnSleepSongs');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(b, anchor.nextSibling);
        return b;
      }
      var focus = $('btnFocus');
      if (focus && focus.parentNode) {
        focus.parentNode.insertBefore(b, focus.nextSibling);
        return b;
      }
      var card = document.querySelector('.player-card') || document.body;
      card.appendChild(b);
      return b;
    } catch (e) { return null; }
  }

  function buildPanel() {
    try {
      if ($('rpmDormirPanel')) return $('rpmDormirPanel');
      var panel = el('div', 'rpm-dormir');
      panel.id = 'rpmDormirPanel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panel.setAttribute('aria-label', 'Sonidos para dormir');
      panel.setAttribute('aria-hidden', 'true');
      panel.hidden = true;

      var close = el('button', 'rpm-dormir-close', '✕');
      close.id = 'rpmDormirClose';
      close.type = 'button';
      close.setAttribute('aria-label', 'Cerrar el panel de sonidos para dormir (el sonido sigue)');
      panel.appendChild(close);
      els.closeBtn = close;

      panel.appendChild(el('p', 'rpm-dormir-kicker', '🌙 SONIDOS PARA DORMIR'));
      var status = el('p', 'rpm-dormir-status', 'Parado');
      status.id = 'rpmDormirStatus';
      status.setAttribute('role', 'status');
      panel.appendChild(status);
      els.status = status;

      var clock = el('div', 'rpm-dormir-clock', '—');
      clock.id = 'rpmDormirClock';
      panel.appendChild(clock);
      els.clock = clock;

      var warn = el('p', 'rpm-dormir-warn', '');
      warn.id = 'rpmDormirWarn';
      warn.hidden = true;
      panel.appendChild(warn);
      els.warn = warn;

      var form = el('div', 'rpm-dormir-config');
      var soundLab = el('label', null, 'Sonido');
      var sel = el('select');
      sel.id = 'rpmDormirSound';
      sel.setAttribute('aria-label', 'Sonido para dormir');
      SOUND_IDS.forEach(function (id) {
        var o = el('option', null, soundParams(id).label);
        o.value = id;
        sel.appendChild(o);
      });
      sel.value = state.config.sound;
      soundLab.appendChild(sel);
      form.appendChild(soundLab);
      els.soundSelect = sel;

      var timerLab = el('label', null, 'Apagar en');
      var tsel = el('select');
      tsel.id = 'rpmDormirTimer';
      tsel.setAttribute('aria-label', 'Temporizador de apagado del sonido para dormir');
      [['0', 'Sin temporizador'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min']]
        .forEach(function (kv) {
          var o = el('option', null, kv[1]);
          o.value = kv[0];
          tsel.appendChild(o);
        });
      tsel.value = String(state.config.timerMin);
      timerLab.appendChild(tsel);
      form.appendChild(timerLab);
      els.timerSelect = tsel;

      var volLab = el('label', null, 'Volumen del sonido');
      var vol = el('input');
      vol.id = 'rpmDormirVolume';
      vol.type = 'range';
      vol.min = '0'; vol.max = '100'; vol.step = '1';
      vol.value = String(state.config.volume);
      vol.setAttribute('aria-label', 'Volumen del sonido para dormir, de 0 a 100');
      volLab.appendChild(vol);
      var volOut = el('span', 'rpm-dormir-volout', state.config.volume + ' %');
      volOut.id = 'rpmDormirVolumeOut';
      volLab.appendChild(volOut);
      form.appendChild(volLab);
      els.volume = vol; els.volumeOut = volOut;
      panel.appendChild(form);

      var actions = el('div', 'rpm-dormir-actions');
      var start = el('button', 'btn primary', '▶ Sonar');
      start.id = 'rpmDormirStart'; start.type = 'button';
      actions.appendChild(start);
      var stop = el('button', 'btn', '■ Parar');
      stop.id = 'rpmDormirStop'; stop.type = 'button';
      actions.appendChild(stop);
      panel.appendChild(actions);
      els.startBtn = start; els.stopBtn = stop;

      var note = el('p', 'sound-note');
      note.innerHTML = 'Sonido generado <strong>en tu dispositivo</strong>, ' +
        'sin archivos ni internet, y con su <strong>propio volumen</strong>: ' +
        'no toca el volumen ni la reproducción de la música. Si suena ' +
        'música, el sonido se mezcla a la mitad de volumen. ' +
        'El temporizador de apagado de la app (#sleepSelect) apaga la ' +
        'música, no este sonido: si está activo, este panel te avisa y ' +
        'cada uno apaga lo suyo. Cerrar este panel no para el sonido: ' +
        'el botón «🌙 Dormir» muestra lo que queda mientras suena.';
      panel.appendChild(note);

      document.body.appendChild(panel);
      return panel;
    } catch (e) { return null; }
  }

  function render() {
    try {
      var s = state.session;
      var playing = s.status !== 'idle';
      var leftSec = playing ? remainingSeconds(s.endsAt, Date.now()) : null;
      if (els.clock) {
        els.clock.textContent = playing
          ? (leftSec === null ? '∞ sin temporizador' : fmtMMSS(leftSec))
          : '—';
      }
      if (els.status) {
        if (!playing) els.status.textContent = 'Parado';
        else if (s.status === 'fading') els.status.textContent =
          'Apagándose suavemente… · ' + soundParams(s.sound).label;
        else els.status.textContent = 'Sonando · ' + soundParams(s.sound).label +
          (isMusicPlaying() ? ' · mezclado con la música (½ volumen)' : '');
      }
      /* Avisos en vivo: sleep timer de la app y mezcla con música. */
      var conflict = readSleepTimerState();
      var warnText = sleepTimerWarning(conflict);
      if (playing && isMusicPlaying()) {
        warnText = (warnText ? warnText + ' ' : '') +
          'Suena música: el sonido para dormir está mezclado a la mitad de volumen.';
      }
      if (els.warn) {
        els.warn.textContent = warnText;
        els.warn.hidden = !warnText;
      }
      if (els.startBtn) {
        els.startBtn.textContent = playing ? '▶ Cambiar sonido' : '▶ Sonar';
      }
      if (els.stopBtn) els.stopBtn.disabled = !playing;
      if (els.volumeOut) els.volumeOut.textContent = state.config.volume + ' %';
      var openBtn = $('rpmDormirOpenBtn');
      if (openBtn) {
        openBtn.textContent = playing
          ? '🌙 ' + (leftSec === null ? '∞' : fmtMMSS(leftSec))
          : '🌙 Dormir';
      }
    } catch (e) {}
  }

  function openPanel() {
    try {
      var panel = $('rpmDormirPanel');
      if (!panel) return;
      panel.hidden = false;
      panel.setAttribute('aria-hidden', 'false');
      var btn = $('rpmDormirOpenBtn');
      if (btn) btn.setAttribute('aria-pressed', 'true');
      render();
      var start = $('rpmDormirStart');
      if (start) start.focus();
    } catch (e) {}
  }
  function closePanel() {
    try {
      var panel = $('rpmDormirPanel');
      if (!panel) return;
      panel.hidden = true;
      panel.setAttribute('aria-hidden', 'true');
      var btn = $('rpmDormirOpenBtn');
      if (btn) {
        btn.setAttribute('aria-pressed', 'false');
        btn.focus();
      }
    } catch (e) {}
  }

  function wireEvents() {
    try {
      var openBtn = $('rpmDormirOpenBtn');
      if (openBtn) openBtn.addEventListener('click', safe(function () {
        var panel = $('rpmDormirPanel');
        if (panel && !panel.hidden) closePanel(); else openPanel();
      }));
      if (els.closeBtn) els.closeBtn.addEventListener('click', safe(closePanel));
      if (els.startBtn) els.startBtn.addEventListener('click', safe(function () {
        startSound(null);
      }));
      if (els.stopBtn) els.stopBtn.addEventListener('click', safe(stopSound));
      if (els.soundSelect) els.soundSelect.addEventListener('change', safe(function () {
        var cfg = readConfigFromForm();
        /* Si ya suena, cambia el sonido en marcha sin cortar el
           temporizador: se reconstruye la cadena de audio. */
        if (state.session.status !== 'idle') {
          state.session = changeSound(state.session, cfg.sound);
          try {
            stopNodes();
            if (state.audioCtx) {
              state.nodes = buildNodes(state.audioCtx, state.session.sound);
              state.nodes.source.start();
              if (state.nodes.lfo) state.nodes.lfo.start();
              var elapsed = Date.now() - state.session.startedAt;
              applyGain(fadeInFactor(elapsed, FADE_IN_SEC * 1000));
            }
          } catch (e) {}
        }
        render();
      }));
      if (els.timerSelect) els.timerSelect.addEventListener('change', safe(function () {
        var cfg = readConfigFromForm();
        /* Cambiar el temporizador en marcha: recalcula el fin desde
           ahora con el nuevo plazo (0 = sin temporizador). */
        if (state.session.status !== 'idle') {
          var dur = timerDurationMs(cfg.timerMin);
          state.session.timerMin = cfg.timerMin;
          state.session.endsAt = dur > 0 ? Date.now() + dur : 0;
          state.session.fadeStarted = false;
          if (state.session.status === 'fading') state.session.status = 'playing';
          if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
        }
        render();
      }));
      if (els.volume) els.volume.addEventListener('input', safe(function () {
        var cfg = readConfigFromForm();
        if (state.session.status !== 'idle') {
          state.session = changeVolume(state.session, cfg.volume);
          var elapsed = Date.now() - state.session.startedAt;
          applyGain(fadeInFactor(elapsed, FADE_IN_SEC * 1000));
        }
        render();
      }));
      document.addEventListener('keydown', safe(function (ev) {
        if (ev.key === 'Escape') {
          var panel = $('rpmDormirPanel');
          if (panel && !panel.hidden) closePanel();
        }
      }));
      document.addEventListener('visibilitychange', safe(function () {
        if (document.visibilityState === 'visible') {
          /* Al volver, el fin del temporizador se detecta por la
             hora del sistema, no por ticks contados. */
          if (state.session.status !== 'idle') tick();
          render();
        }
      }));
    } catch (e) {}
  }

  function init() {
    try {
      try { store = g.localStorage || null; } catch (e) { store = null; }
      state.config = loadConfig(store);
      buildOpenButton();
      buildPanel();
      wireEvents();
      render();
      /* El sonido nunca arranca solo: solo por clic en «▶ Sonar». */
    } catch (e) { /* sin sonidos para dormir: la app sigue igual */ }
  }

  /* Solo navegador: sin document no hay nada que montar (Node). */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else init();
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  var api = {
    sanitizeConfig: sanitizeConfig,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    soundParams: soundParams,
    isSoundId: isSoundId,
    SOUND_PARAMS: SOUND_PARAMS,
    SOUND_IDS: SOUND_IDS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    CONFIG_KEY: CONFIG_KEY,
    TIMER_OPTIONS_MIN: TIMER_OPTIONS_MIN,
    FADE_IN_SEC: FADE_IN_SEC,
    FADE_OUT_SEC: FADE_OUT_SEC,
    MIX_FACTOR: MIX_FACTOR,
    TICK_MS: TICK_MS,
    fadeValueAt: fadeValueAt,
    fadeInFactor: fadeInFactor,
    fadeOutFactor: fadeOutFactor,
    combinedFadeFactor: combinedFadeFactor,
    createSession: createSession,
    timerDurationMs: timerDurationMs,
    remainingMs: remainingMs,
    remainingSeconds: remainingSeconds,
    fmtMMSS: fmtMMSS,
    shouldStartFade: shouldStartFade,
    startSession: startSession,
    stopSession: stopSession,
    changeSound: changeSound,
    changeVolume: changeVolume,
    sessionTick: sessionTick,
    effectiveVolume: effectiveVolume,
    nodeGain: nodeGain,
    detectSleepTimerConflict: detectSleepTimerConflict,
    sleepTimerWarning: sleepTimerWarning,
    VERSION: VERSION
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    try {
      window.__dormir = {
        version: VERSION,
        open: openPanel,
        close: closePanel,
        start: function (soundId) {
          try { return startSound(soundId || null); }
          catch (e) { return false; }
        },
        stop: function () { try { return stopSound(); } catch (e) { return false; } },
        getState: function () {
          try {
            return {
              config: JSON.parse(JSON.stringify(state.config)),
              session: JSON.parse(JSON.stringify(state.session)),
              musicPlaying: isMusicPlaying(),
              sleepTimer: readSleepTimerState()
            };
          } catch (e) { return null; }
        }
      };
    } catch (e) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
