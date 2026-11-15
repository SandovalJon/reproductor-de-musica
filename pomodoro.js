/* Modo enfoque con Pomodoro para Reproductor de Música — v3.5.0.
   Módulo aparte: NO toca app/index.html ni ningún otro archivo de la
   app (ver WIRING.md para cablearlo con dos líneas). Se engancha solo
   por DOM y por el hook window.__rpmApp que la app ya expone.
   Si el módulo falla o no carga, la app sigue funcionando como sin él:
   todo el código va dentro de try/catch y nunca lanza errores globales.

   Qué hace:
   - Bloques de enfoque de 25 min y descansos de 5 min, ambos
     ajustables (enfoque 5-60 min, descanso 1-30 min), con cuenta atrás
     visible y barra de progreso.
   - Cada N bloques (configurable, por defecto 4) el descanso es largo
     (15 min por defecto).
   - Al terminar un bloque de enfoque suena un aviso suave (Web Audio,
     sin ningún archivo) y, según la opción elegida, la música se pausa
     o baja a la mitad de volumen. Al terminar el descanso suena otro
     aviso y se ofrece empezar otro bloque (nunca empieza solo).
   - Guarda la configuración y el progreso del día (bloques
     completados hoy, minutos enfocados) en localStorage con claves
     'reproductor-pomodoro:config' y 'reproductor-pomodoro:progress'.
   - Nunca empieza solo: todo arranca por clic del usuario.

   Relación con lo que la app YA trae (importante, léelo antes de
   cablearlo):
   - La app ya tiene su propio «Modo enfoque» (Pack 13: botón
     #btnFocus, overlay #focusOverlay): 25/5 min, pausa o volumen
     bajo en el descanso, sin descanso largo, sin sonido de aviso,
     sin progreso diario y con avance automático descanso -> enfoque.
     Este módulo NO lo toca, NO lo desactiva y NO lee ni escribe su
     estado interno (vive dentro del IIFE cerrado de index.html y no
     está expuesto). Es un temporizador independiente que añade:
     descanso largo cada N bloques, aviso sonoro, volumen a la mitad
     exacto, progreso del día y que el siguiente bloque solo empiece
     si el usuario lo pide.
   - Usa el botón #btnFocus solo como ANCLA para colocar su propio
     botón «🍅 Pomodoro» justo después, en la fila de modos. No llama
     a #btnFocus ni abre su overlay.
   - NO toca el temporizador de apagado de la app: no lee ni escribe
     ninguno de sus controles ni variables, y su temporizador corre
     con su propio setInterval y su propio endsAt. La única
     interacción indirecta y documentada es la del volumen: bajar a
     la mitad mueve el deslizador #volume como lo haría el usuario
     (disparando su evento 'input'), y eso es exactamente lo mismo
     que mover el deslizador a mano.
   - La pausa y la reanudación se hacen con clic en #btnPlay (como
     haría el usuario) y solo si el estado de <audio> lo pide:
     nunca se pulsa #btnPlay a ciegas.

   Reglas de la música al terminar cada fase:
   - Fin de enfoque -> descanso: 'pause' pausa solo si algo suena
     (y recuerda que la pausa la hizo el módulo); 'half' guarda el
     volumen del deslizador y lo pone a la mitad.
   - Fin de descanso: el volumen vuelve a su nivel (si se había
     bajado y el usuario no lo cambió a mano entretanto). Si la
     música se pausó, NO vuelve sola: el panel ofrece «Reanudar
     música» y «Empezar otro bloque» (este último reanuda la música
     si la pausa la hizo el módulo). Detener a mitad de un descanso
     también restaura el volumen, pero tampoco reanuda la música.
   - Si el usuario mueve el deslizador a mano durante un descanso
     con volumen bajado, manda el usuario: al terminar el descanso
     no se restaura nada.

   Como el resto de módulos, el temporizador solo avanza con la app
   abierta: si cierras la app o el navegador duerme la pestaña, se
   detiene hasta que vuelvas (el fin de fase se detecta al volver,
   porque se calcula con la hora del sistema, no con ticks contados).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./pomodoro.css">
     <script src="./pomodoro.js"></script>
   Pruebas Node: node --test pomodoro.test.mjs
   Consola: window.__pomodoro.getState() / .open() / .close() /
     .start() / .stop() */
(function (g) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var VERSION = '3.5.0';
  var CONFIG_KEY = 'reproductor-pomodoro:config';
  var PROGRESS_KEY = 'reproductor-pomodoro:progress';
  var TICK_MS = 250;

  var DEFAULT_CONFIG = {
    focusMin: 25,
    breakMin: 5,
    longBreakMin: 15,
    blocksBeforeLongBreak: 4,
    breakAction: 'pause' /* 'pause' | 'half' */
  };

  function isObject(v) { return v !== null && typeof v === 'object'; }

  function clampInt(v, min, max, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /* Config válida o los valores por defecto. Campos desconocidos se
     descartan; fuera de rango se limitan (no se rechaza todo). */
  function sanitizeConfig(raw) {
    var out = {
      focusMin: DEFAULT_CONFIG.focusMin,
      breakMin: DEFAULT_CONFIG.breakMin,
      longBreakMin: DEFAULT_CONFIG.longBreakMin,
      blocksBeforeLongBreak: DEFAULT_CONFIG.blocksBeforeLongBreak,
      breakAction: DEFAULT_CONFIG.breakAction
    };
    if (!isObject(raw)) return out;
    out.focusMin = clampInt(raw.focusMin, 5, 60, out.focusMin);
    out.breakMin = clampInt(raw.breakMin, 1, 30, out.breakMin);
    out.longBreakMin = clampInt(raw.longBreakMin, 5, 30, out.longBreakMin);
    out.blocksBeforeLongBreak = clampInt(raw.blocksBeforeLongBreak, 2, 8,
      out.blocksBeforeLongBreak);
    if (raw.breakAction === 'half' || raw.breakAction === 'pause') {
      out.breakAction = raw.breakAction;
    }
    return out;
  }

  /* 'YYYY-MM-DD' en hora local. Sin fecha, hoy. */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayKey(date) {
    var d = (date instanceof Date) ? date : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function isDateKey(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  /* Progreso del día: {date, focusBlocks, focusMinutes}. Si la fecha
     guardada no es hoy, se devuelve un progreso vacío de hoy (el día
     cambió: el contador de ayer no se suma al de hoy). */
  function sanitizeProgress(raw, today) {
    var day = isDateKey(today) ? today : todayKey();
    var out = { date: day, focusBlocks: 0, focusMinutes: 0 };
    if (!isObject(raw)) return out;
    if (raw.date !== day) return out;
    out.focusBlocks = clampInt(raw.focusBlocks, 0, 10000, 0);
    out.focusMinutes = clampInt(raw.focusMinutes, 0, 100000, 0);
    return out;
  }

  /* Sumar un bloque de enfoque completado al progreso del día. */
  function recordFocusComplete(progress, config, today) {
    var p = sanitizeProgress(progress, today);
    var minutes = sanitizeConfig(config).focusMin;
    return {
      date: p.date,
      focusBlocks: p.focusBlocks + 1,
      focusMinutes: p.focusMinutes + minutes
    };
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
  function loadProgress(store, today) {
    try {
      if (!store) return sanitizeProgress(null, today);
      var raw = store.getItem(PROGRESS_KEY);
      if (!raw) return sanitizeProgress(null, today);
      return sanitizeProgress(JSON.parse(raw), today);
    } catch (e) { return sanitizeProgress(null, today); }
  }
  function saveProgress(store, progress) {
    try {
      if (!store) return false;
      store.setItem(PROGRESS_KEY,
        JSON.stringify(sanitizeProgress(progress, progress && progress.date)));
      return true;
    } catch (e) { return false; }
  }

  /* ================= Máquina de estados (pura) ================= */

  /* Fases: 'idle' (sin temporizador), 'focus', 'break', 'longBreak'.
     'awaitingNext' solo existe en la capa del navegador (el panel
     ofrece el siguiente bloque); en el núcleo, tras un descanso la
     sesión vuelve a 'idle' con focusBlocks de la sesión intactos. */
  function createSession() {
    return {
      phase: 'idle',
      running: false,
      paused: false,
      endsAt: 0,        /* epoch ms en que termina la fase actual */
      remainingMs: 0,   /* solo con paused === true */
      focusBlocks: 0,   /* bloques completados en esta sesión */
      lastEvent: null   /* 'focusDone' | 'breakDone' | 'longBreakDone' */
    };
  }

  /* Duración en ms de una fase con una config dada. */
  function phaseDurationMs(phase, config) {
    var c = sanitizeConfig(config);
    if (phase === 'focus') return c.focusMin * 60 * 1000;
    if (phase === 'break') return c.breakMin * 60 * 1000;
    if (phase === 'longBreak') return c.longBreakMin * 60 * 1000;
    return 0;
  }

  /* ¿Toca descanso largo tras este número de bloques? Solo si hay al
     menos un bloque y el total es múltiplo del ciclo. */
  function isLongBreakDue(focusBlocks, config) {
    var c = sanitizeConfig(config);
    return focusBlocks > 0 &&
      (focusBlocks % c.blocksBeforeLongBreak) === 0;
  }

  function phaseAfterFocus(focusBlocks, config) {
    return isLongBreakDue(focusBlocks, config) ? 'longBreak' : 'break';
  }

  /* Iniciar un bloque de enfoque. Devuelve una sesión nueva (no muta
     la recibida). Nunca arranca nada por sí sola: la capa del
     navegador solo la llama desde un clic del usuario. */
  function startFocus(session, config, nowMs) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    s.phase = 'focus';
    s.running = true;
    s.paused = false;
    s.endsAt = now + phaseDurationMs('focus', config);
    s.remainingMs = 0;
    s.lastEvent = null;
    return s;
  }

  /* Completar la fase actual. Devuelve {session, event}:
     - focus -> entra automáticamente en 'break' o 'longBreak'
       (la música ya está en descanso: la capa del navegador aplica
       la pausa o la bajada de volumen al recibir 'focusDone').
     - break / longBreak -> vuelve a 'idle' y NO empieza el siguiente
       bloque: la capa del navegador lo ofrece con un botón.
     - idle -> no hace nada (event null).
     El progreso del día NO se toca aquí: lo actualiza la capa del
     navegador con recordFocusComplete() al recibir 'focusDone', para
     que la máquina siga siendo pura y sin store. */
  function completePhase(session, config, nowMs) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    if (!s.running || s.phase === 'idle') {
      return { session: s, event: null };
    }
    if (s.phase === 'focus') {
      s.focusBlocks += 1;
      var next = phaseAfterFocus(s.focusBlocks, config);
      s.phase = next;
      s.endsAt = now + phaseDurationMs(next, config);
      s.paused = false;
      s.remainingMs = 0;
      s.lastEvent = 'focusDone';
      return { session: s, event: 'focusDone', nextPhase: next };
    }
    var ev = (s.phase === 'longBreak') ? 'longBreakDone' : 'breakDone';
    s.phase = 'idle';
    s.running = false;
    s.paused = false;
    s.endsAt = 0;
    s.remainingMs = 0;
    s.lastEvent = ev;
    return { session: s, event: ev };
  }

  /* Pausar el temporizador (la cuenta atrás, no la música): congela
     lo que queda. Reanudar recalcula endsAt desde ese resto. */
  function pauseTimer(session, nowMs) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    if (!s.running || s.paused || s.phase === 'idle') return s;
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    s.remainingMs = Math.max(0, s.endsAt - now);
    s.paused = true;
    return s;
  }
  function resumeTimer(session, nowMs) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    if (!s.running || !s.paused || s.phase === 'idle') return s;
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    s.endsAt = now + s.remainingMs;
    s.remainingMs = 0;
    s.paused = false;
    return s;
  }

  /* Detener del todo: vuelve a 'idle'. La música la restaura la capa
     del navegador (volumen / pausa), no esta función. */
  function stopSession(session) {
    var s = session ? JSON.parse(JSON.stringify(session)) : createSession();
    s.phase = 'idle';
    s.running = false;
    s.paused = false;
    s.endsAt = 0;
    s.remainingMs = 0;
    s.lastEvent = null;
    return s;
  }

  /* ================= Cálculos de la cuenta atrás ================= */

  function remainingMs(endsAt, nowMs) {
    if (!(endsAt > 0)) return 0;
    return Math.max(0, endsAt - nowMs);
  }
  function remainingSeconds(endsAt, nowMs) {
    return Math.ceil(remainingMs(endsAt, nowMs) / 1000);
  }
  function fmtMMSS(totalSeconds) {
    var sec = Math.max(0, Math.floor(totalSeconds || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return pad2(m) + ':' + pad2(s);
  }
  /* Fracción 0..1 ya transcurrida de una fase (para la barra). */
  function progressFraction(phaseDuration, msLeft) {
    if (!(phaseDuration > 0)) return 0;
    var f = 1 - (msLeft / phaseDuration);
    if (f < 0) return 0;
    if (f > 1) return 1;
    return f;
  }

  /* ================= Volumen a la mitad (puro) ================= */

  /* Mitad del volumen del deslizador (0-100). 0 sigue siendo 0. */
  function halfVolumeOf(volume0to100) {
    var v = parseFloat(volume0to100);
    if (!isFinite(v) || v <= 0) return 0;
    return Math.round(Math.min(100, v) / 2);
  }
  /* ¿Se puede restaurar el volumen guardado? Solo si el usuario no
     movió el deslizador a mano durante el descanso: el valor actual
     debe seguir siendo el valor bajado. */
  function shouldRestoreVolume(saved, current, lowered) {
    if (typeof saved !== 'number' || !isFinite(saved)) return false;
    return current === lowered;
  }

  /* ================= Aviso sonoro (notas puras) ================= */

  /* Dos notas suaves por aviso. La reproducción real (Web Audio) es
     solo navegador (ver playChime más abajo); aquí solo está la
     partitura, que sí se puede probar en Node. */
  function chimeNotes(kind) {
    if (kind === 'breakDone' || kind === 'longBreakDone') {
      return [
        { freq: 659.25, start: 0, dur: 0.9 },    /* Mi5 */
        { freq: 880.00, start: 0.7, dur: 1.2 }   /* La5 */
      ];
    }
    return [
      { freq: 880.00, start: 0, dur: 0.9 },     /* La5 */
      { freq: 1174.66, start: 0.7, dur: 1.2 }   /* Re6 */
    ];
  }

  function describePhase(phase) {
    if (phase === 'focus') return 'Enfoque';
    if (phase === 'break') return 'Descanso';
    if (phase === 'longBreak') return 'Descanso largo';
    return 'En pausa';
  }

  /* ================= Capa navegador (solo con document) ================= */

  var state = {
    config: sanitizeConfig(null),
    progress: sanitizeProgress(null),
    session: createSession(),
    awaitingNext: false,   /* descanso terminado: se ofrece otro bloque */
    pausedByModule: false, /* la pausa actual la hizo este módulo */
    lowered: null,         /* {saved, lowered} mientras el volumen está a la mitad */
    audioCtx: null
  };
  var els = {};
  var store = null;
  var tickTimer = null;

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

  function audioEl() { return $('audio'); }
  function volumeSlider() { return $('volume'); }
  function isPlaying() {
    try {
      var a = audioEl();
      return !!a && !a.paused && !a.ended;
    } catch (e) { return false; }
  }

  /* --- Música: pausa / reanudación por clic DOM, como el usuario --- */

  function pauseMusic() {
    if (!isPlaying()) { state.pausedByModule = false; return false; }
    var btn = $('btnPlay');
    if (!btn || btn.disabled) return false;
    try { btn.click(); state.pausedByModule = true; return true; }
    catch (e) { return false; }
  }
  function resumeMusic() {
    if (!state.pausedByModule) return false;
    if (isPlaying()) { state.pausedByModule = false; return false; }
    var btn = $('btnPlay');
    if (!btn || btn.disabled) return false;
    try { btn.click(); state.pausedByModule = false; return true; }
    catch (e) { return false; }
  }

  /* --- Volumen a la mitad por el deslizador de la app --- */

  /* Mueve #volume como lo haría el usuario: pone el valor y dispara
     'input', que es lo que la app ya escucha para aplicar el volumen
     (con su tope de volumen seguro y su guardado). No se escribe
     audio.volume a mano: la app lo recalcula y lo sobrescribiría. */
  function setSliderVolume(value0to100) {
    var slider = volumeSlider();
    if (!slider) return false;
    try {
      slider.value = String(Math.max(0, Math.min(100, Math.round(value0to100))));
      var ev;
      if (typeof Event === 'function') ev = new Event('input', { bubbles: true });
      else { ev = document.createEvent('Event'); ev.initEvent('input', true, true); }
      slider.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }
  function currentSliderVolume() {
    var slider = volumeSlider();
    if (!slider) return null;
    var v = parseFloat(slider.value);
    return isFinite(v) ? v : null;
  }

  function lowerVolumeToHalf() {
    var cur = currentSliderVolume();
    if (cur === null || cur <= 0) { state.lowered = null; return false; }
    var half = halfVolumeOf(cur);
    if (half >= cur) { state.lowered = null; return false; }
    state.lowered = { saved: cur, lowered: half };
    setSliderVolume(half);
    return true;
  }
  function restoreVolume() {
    if (!state.lowered) return false;
    var cur = currentSliderVolume();
    if (!shouldRestoreVolume(state.lowered.saved, cur, state.lowered.lowered)) {
      /* El usuario movió el volumen a mano durante el descanso:
         manda el usuario, no se restaura nada. */
      state.lowered = null;
      return false;
    }
    setSliderVolume(state.lowered.saved);
    state.lowered = null;
    return true;
  }
  /* Al detener a mitad de un descanso: restaura el volumen, pero la
     música pausada se queda pausada (detener no debe sorprenderte
     reanudando sonido sin que lo pidas). */
  function undoBreakAction() {
    try {
      if (state.session.phase === 'break' || state.session.phase === 'longBreak') {
        restoreVolume();
      } else {
        state.lowered = null;
      }
      /* pausedByModule se conserva a propósito: si la pausa la hizo
         este módulo, «Empezar otro bloque» o «Reanudar música» saben
         que pueden reanudar. Solo se limpia al reanudar de verdad. */
    } catch (e) {}
  }

  /* --- Aviso sonoro (Web Audio, sin archivo) --- */

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
  function playChime(kind) {
    try {
      var ctx = ensureAudioCtx();
      if (!ctx) return false;
      var notes = chimeNotes(kind);
      var t0 = ctx.currentTime + 0.05;
      notes.forEach(function (n) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = n.freq;
        gain.gain.setValueAtTime(0.0001, t0 + n.start);
        gain.gain.exponentialRampToValueAtTime(0.15, t0 + n.start + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + n.start);
        osc.stop(t0 + n.start + n.dur + 0.1);
      });
      return true;
    } catch (e) { return false; }
  }

  /* --- Temporizador --- */

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(safe(tick), TICK_MS);
    tick();
  }
  function stopTicking() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function tick() {
    try {
      var s = state.session;
      if (!s.running || s.paused) { render(); return; }
      var left = remainingMs(s.endsAt, Date.now());
      if (left <= 0) { onPhaseEnd(); return; }
      render();
    } catch (e) {}
  }

  function onPhaseEnd() {
    try {
      var res = completePhase(state.session, state.config, Date.now());
      state.session = res.session;
      if (res.event === 'focusDone') {
        /* Progreso del día: un bloque más + sus minutos. */
        state.progress = recordFocusComplete(state.progress, state.config,
          todayKey());
        if (store) saveProgress(store, state.progress);
        playChime('focusDone');
        var isLong = res.nextPhase === 'longBreak';
        if (state.config.breakAction === 'half') {
          var lowered = lowerVolumeToHalf();
          toast('🍅 Bloque de enfoque completado (' + state.progress.focusBlocks +
            ' hoy). ' + (isLong ? 'Descanso largo' : 'Descanso') + ': ' +
            (lowered ? 'bajé el volumen a la mitad.' : 'el volumen ya estaba a 0, no hay nada que bajar.'));
        } else {
          var paused = pauseMusic();
          toast('🍅 Bloque de enfoque completado (' + state.progress.focusBlocks +
            ' hoy). ' + (isLong ? 'Descanso largo' : 'Descanso') + ': ' +
            (paused ? 'pausé la música suavemente.' : 'la música ya estaba en pausa.'));
        }
        state.awaitingNext = false;
        startTicking();
      } else if (res.event === 'breakDone' || res.event === 'longBreakDone') {
        playChime(res.event);
        restoreVolume();
        state.awaitingNext = true;
        stopTicking();
        toast('🍅 ' + (res.event === 'longBreakDone' ? 'Descanso largo' : 'Descanso') +
          ' terminado. ¿Empezamos otro bloque de enfoque?');
      }
      render();
    } catch (e) {}
  }

  /* --- Acciones por clic del usuario (nunca automáticas) --- */

  function startNextBlock() {
    try {
      /* Si el descanso había pausado la música, el nuevo bloque la
         reanuda: un bloque de enfoque es para escuchar. */
      undoBreakAction();
      state.session = startFocus(state.session, state.config, Date.now());
      state.awaitingNext = false;
      resumeMusic();
      ensureAudioCtx();
      startTicking();
      toast('🍅 Enfoque iniciado: ' + state.config.focusMin +
        ' min. La música suena normal.');
      render();
    } catch (e) {}
  }

  function pauseCountdown() {
    try {
      if (!state.session.running || state.session.paused) return;
      state.session = pauseTimer(state.session, Date.now());
      render();
    } catch (e) {}
  }
  function resumeCountdown() {
    try {
      if (!state.session.running || !state.session.paused) return;
      state.session = resumeTimer(state.session, Date.now());
      startTicking();
      render();
    } catch (e) {}
  }
  function stopAll() {
    try {
      var wasBreak = state.session.phase === 'break' ||
        state.session.phase === 'longBreak';
      state.session = stopSession(state.session);
      state.awaitingNext = false;
      if (wasBreak) restoreVolume();
      else state.lowered = null;
      stopTicking();
      toast('🍅 Pomodoro detenido.');
      render();
    } catch (e) {}
  }

  function persistConfig() {
    try { if (store) saveConfig(store, state.config); } catch (e) {}
  }
  function readConfigFromForm() {
    try {
      var cfg = sanitizeConfig({
        focusMin: els.focusMin ? els.focusMin.value : state.config.focusMin,
        breakMin: els.breakMin ? els.breakMin.value : state.config.breakMin,
        longBreakMin: els.longBreakMin ? els.longBreakMin.value : state.config.longBreakMin,
        blocksBeforeLongBreak: els.blocks ? els.blocks.value : state.config.blocksBeforeLongBreak,
        breakAction: els.breakAction ? els.breakAction.value : state.config.breakAction
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
      if ($('rpmPomodoroOpenBtn')) return $('rpmPomodoroOpenBtn');
      var b = el('button', 'btn small', '🍅 Pomodoro');
      b.id = 'rpmPomodoroOpenBtn';
      b.type = 'button';
      b.title = 'Temporizador Pomodoro: bloques de enfoque con descansos (módulo aparte)';
      b.setAttribute('aria-pressed', 'false');
      /* Ancla: justo después del botón «Modo enfoque» de la app, en
         la misma fila de modos. Si esa fila no existe en esta versión,
         junto al botón de dormir por canciones; si tampoco, al final
         de la tarjeta del reproductor. */
      var anchor = $('btnFocus');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(b, anchor.nextSibling);
        return b;
      }
      var songsBtn = $('btnSleepSongs');
      if (songsBtn && songsBtn.parentNode) {
        songsBtn.parentNode.insertBefore(b, songsBtn.nextSibling);
        return b;
      }
      var card = document.querySelector('.player-card') || document.body;
      card.appendChild(b);
      return b;
    } catch (e) { return null; }
  }

  function buildPanel() {
    try {
      if ($('rpmPomodoroPanel')) return $('rpmPomodoroPanel');
      var panel = el('div', 'rpm-pomodoro');
      panel.id = 'rpmPomodoroPanel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panel.setAttribute('aria-label', 'Temporizador Pomodoro');
      panel.setAttribute('aria-hidden', 'true');
      panel.hidden = true;

      var close = el('button', 'rpm-pomodoro-close', '✕');
      close.id = 'rpmPomodoroClose';
      close.type = 'button';
      close.setAttribute('aria-label', 'Cerrar el panel Pomodoro (el temporizador sigue)');
      panel.appendChild(close);
      els.closeBtn = close;

      panel.appendChild(el('p', 'rpm-pomodoro-kicker', '🍅 MODO ENFOQUE · POMODORO'));
      var phase = el('p', 'rpm-pomodoro-phase', 'Listo para concentrarte');
      phase.id = 'rpmPomodoroPhase';
      panel.appendChild(phase);
      els.phase = phase;

      var clock = el('div', 'rpm-pomodoro-clock', fmtMMSS(state.config.focusMin * 60));
      clock.id = 'rpmPomodoroClock';
      panel.appendChild(clock);
      els.clock = clock;

      var barWrap = el('div', 'rpm-pomodoro-bar');
      barWrap.setAttribute('role', 'progressbar');
      barWrap.setAttribute('aria-label', 'Progreso del bloque actual');
      barWrap.setAttribute('aria-valuemin', '0');
      barWrap.setAttribute('aria-valuemax', '100');
      barWrap.setAttribute('aria-valuenow', '0');
      var fill = el('div', 'rpm-pomodoro-fill');
      fill.id = 'rpmPomodoroFill';
      barWrap.appendChild(fill);
      panel.appendChild(barWrap);
      els.barWrap = barWrap; els.fill = fill;

      var today = el('p', 'rpm-pomodoro-today', '');
      today.id = 'rpmPomodoroToday';
      panel.appendChild(today);
      els.today = today;

      /* Banner de «descanso terminado»: solo visible entonces. */
      var nextBox = el('div', 'rpm-pomodoro-next', '');
      nextBox.id = 'rpmPomodoroNextBox';
      nextBox.hidden = true;
      nextBox.appendChild(el('p', null, 'Descanso terminado. ¿Empezamos otro bloque de enfoque?'));
      var nextBtn = el('button', 'btn primary', '🍅 Empezar otro bloque');
      nextBtn.id = 'rpmPomodoroNextBtn';
      nextBtn.type = 'button';
      nextBox.appendChild(nextBtn);
      var resumeBtn = el('button', 'btn', '▶ Reanudar música');
      resumeBtn.id = 'rpmPomodoroResumeBtn';
      resumeBtn.type = 'button';
      nextBox.appendChild(resumeBtn);
      panel.appendChild(nextBox);
      els.nextBox = nextBox; els.nextBtn = nextBtn; els.resumeBtn = resumeBtn;

      var form = el('div', 'rpm-pomodoro-config');
      function field(labelText, id, min, max, value, aria) {
        var lab = el('label', null, labelText);
        var inp = el('input');
        inp.id = id; inp.type = 'number';
        inp.min = String(min); inp.max = String(max); inp.step = '1';
        inp.value = String(value);
        inp.setAttribute('aria-label', aria);
        lab.appendChild(inp);
        form.appendChild(lab);
        return inp;
      }
      els.focusMin = field('Enfoque (min, 5-60)', 'rpmPomodoroFocusMin',
        5, 60, state.config.focusMin, 'Minutos de enfoque, de 5 a 60');
      els.breakMin = field('Descanso (min, 1-30)', 'rpmPomodoroBreakMin',
        1, 30, state.config.breakMin, 'Minutos de descanso, de 1 a 30');
      els.longBreakMin = field('Descanso largo (min)', 'rpmPomodoroLongMin',
        5, 30, state.config.longBreakMin, 'Minutos de descanso largo');
      els.blocks = field('Bloques antes del descanso largo (2-8)',
        'rpmPomodoroBlocks', 2, 8, state.config.blocksBeforeLongBreak,
        'Bloques de enfoque antes de un descanso largo, de 2 a 8');
      var actionLab = el('label', null, 'Al terminar el enfoque, la música…');
      var sel = el('select');
      sel.id = 'rpmPomodoroBreakAction';
      sel.setAttribute('aria-label', 'Qué hace la música al terminar un bloque de enfoque');
      [['pause', 'Se pausa'], ['half', 'Baja a la mitad de volumen']].forEach(function (kv) {
        var o = el('option', null, kv[1]);
        o.value = kv[0];
        sel.appendChild(o);
      });
      sel.value = state.config.breakAction;
      actionLab.appendChild(sel);
      form.appendChild(actionLab);
      els.breakAction = sel;
      panel.appendChild(form);

      var actions = el('div', 'rpm-pomodoro-actions');
      var start = el('button', 'btn primary', '▶ Iniciar enfoque');
      start.id = 'rpmPomodoroStart'; start.type = 'button';
      actions.appendChild(start);
      var pause = el('button', 'btn', '⏸ Pausar temporizador');
      pause.id = 'rpmPomodoroPause'; pause.type = 'button';
      actions.appendChild(pause);
      var stop = el('button', 'btn', '■ Detener');
      stop.id = 'rpmPomodoroStop'; stop.type = 'button';
      actions.appendChild(stop);
      panel.appendChild(actions);
      els.startBtn = start; els.pauseBtn = pause; els.stopBtn = stop;

      var reset = el('button', 'btn small', 'Reiniciar contador de hoy');
      reset.id = 'rpmPomodoroResetToday'; reset.type = 'button';
      panel.appendChild(reset);
      els.resetBtn = reset;

      var note = el('p', 'sound-note');
      note.innerHTML = 'Solo avanza <strong>con la app abierta</strong>. ' +
        'No es el «Modo enfoque» de la app (botón de al lado): este ' +
        'módulo es independiente y añade descanso largo, aviso sonoro ' +
        'y progreso del día. No uses los dos temporizadores a la vez: ' +
        'cada uno pausaría o bajaría la música por su cuenta. ' +
        'Cerrar este panel no detiene el temporizador: el botón ' +
        '«🍅 Pomodoro» muestra la cuenta atrás mientras corre.';
      panel.appendChild(note);

      document.body.appendChild(panel);
      return panel;
    } catch (e) { return null; }
  }

  function render() {
    try {
      var s = state.session;
      var cfg = state.config;
      var leftSec;
      var frac = 0;
      if (s.running && s.paused) {
        leftSec = Math.ceil(s.remainingMs / 1000);
        frac = progressFraction(phaseDurationMs(s.phase, cfg),
          s.remainingMs);
      } else if (s.running) {
        var left = remainingMs(s.endsAt, Date.now());
        leftSec = Math.ceil(left / 1000);
        frac = progressFraction(phaseDurationMs(s.phase, cfg), left);
      } else if (state.awaitingNext) {
        leftSec = 0;
        frac = 1;
      } else {
        leftSec = cfg.focusMin * 60;
        frac = 0;
      }
      if (els.clock) els.clock.textContent = fmtMMSS(leftSec);
      if (els.fill) els.fill.style.width = (frac * 100).toFixed(1) + '%';
      if (els.barWrap) {
        els.barWrap.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      }
      var phaseText;
      if (state.awaitingNext) phaseText = 'Descanso terminado · ¿otro bloque?';
      else if (!s.running) phaseText = 'Listo para concentrarte';
      else if (s.paused) phaseText = describePhase(s.phase) + ' · en pausa';
      else if (s.phase === 'focus') phaseText = 'Enfoque · tu música suena normal';
      else if (s.phase === 'longBreak') phaseText = 'Descanso largo · ' +
        (cfg.breakAction === 'half' ? 'música a la mitad' : 'música en pausa');
      else phaseText = 'Descanso · ' +
        (cfg.breakAction === 'half' ? 'música a la mitad' : 'música en pausa');
      if (els.phase) els.phase.textContent = phaseText;
      if (els.today) {
        els.today.textContent = 'Hoy: ' + state.progress.focusBlocks +
          (state.progress.focusBlocks === 1 ? ' bloque' : ' bloques') +
          ' · ' + state.progress.focusMinutes + ' min de enfoque' +
          ' · Sesión: ' + s.focusBlocks +
          (s.focusBlocks === 1 ? ' bloque' : ' bloques');
      }
      if (els.nextBox) els.nextBox.hidden = !state.awaitingNext;
      if (els.resumeBtn) {
        els.resumeBtn.style.display =
          (state.awaitingNext && state.pausedByModule && !isPlaying()) ? '' : 'none';
      }
      if (els.startBtn) {
        els.startBtn.textContent = state.awaitingNext ? '🍅 Empezar otro bloque'
          : (s.running ? '▶ Reiniciar enfoque' : '▶ Iniciar enfoque');
        els.startBtn.disabled = false;
      }
      if (els.pauseBtn) {
        els.pauseBtn.textContent = (s.running && s.paused)
          ? '▶ Reanudar temporizador' : '⏸ Pausar temporizador';
        els.pauseBtn.disabled = !s.running;
      }
      if (els.stopBtn) els.stopBtn.disabled = !s.running && !state.awaitingNext;
      var editingLocked = s.running;
      [els.focusMin, els.breakMin, els.longBreakMin, els.blocks, els.breakAction]
        .forEach(function (inp) { if (inp) inp.disabled = editingLocked; });
      /* El botón de apertura muestra la cuenta atrás mientras corre. */
      var openBtn = $('rpmPomodoroOpenBtn');
      if (openBtn) {
        openBtn.textContent = s.running
          ? '🍅 ' + fmtMMSS(leftSec) + ' · ' + describePhase(s.phase)
          : '🍅 Pomodoro';
      }
    } catch (e) {}
  }

  function openPanel() {
    try {
      var panel = $('rpmPomodoroPanel');
      if (!panel) return;
      panel.hidden = false;
      panel.setAttribute('aria-hidden', 'false');
      var btn = $('rpmPomodoroOpenBtn');
      if (btn) btn.setAttribute('aria-pressed', 'true');
      render();
      var start = $('rpmPomodoroStart');
      if (start) start.focus();
    } catch (e) {}
  }
  function closePanel() {
    try {
      var panel = $('rpmPomodoroPanel');
      if (!panel) return;
      panel.hidden = true;
      panel.setAttribute('aria-hidden', 'true');
      var btn = $('rpmPomodoroOpenBtn');
      if (btn) {
        btn.setAttribute('aria-pressed', 'false');
        btn.focus();
      }
    } catch (e) {}
  }

  function wireEvents() {
    try {
      var openBtn = $('rpmPomodoroOpenBtn');
      if (openBtn) openBtn.addEventListener('click', safe(function () {
        var panel = $('rpmPomodoroPanel');
        if (panel && !panel.hidden) closePanel(); else openPanel();
      }));
      if (els.closeBtn) els.closeBtn.addEventListener('click', safe(closePanel));
      if (els.startBtn) els.startBtn.addEventListener('click', safe(function () {
        readConfigFromForm();
        startNextBlock();
      }));
      if (els.nextBtn) els.nextBtn.addEventListener('click', safe(function () {
        readConfigFromForm();
        startNextBlock();
      }));
      if (els.resumeBtn) els.resumeBtn.addEventListener('click', safe(function () {
        resumeMusic();
        render();
        toast('▶ Música reanudada.');
      }));
      if (els.pauseBtn) els.pauseBtn.addEventListener('click', safe(function () {
        if (state.session.running && state.session.paused) resumeCountdown();
        else pauseCountdown();
      }));
      if (els.stopBtn) els.stopBtn.addEventListener('click', safe(stopAll));
      if (els.resetBtn) els.resetBtn.addEventListener('click', safe(function () {
        state.progress = { date: todayKey(), focusBlocks: 0, focusMinutes: 0 };
        if (store) saveProgress(store, state.progress);
        render();
        toast('🍅 Contador de hoy reiniciado.');
      }));
      [els.focusMin, els.breakMin, els.longBreakMin, els.blocks, els.breakAction]
        .forEach(function (inp) {
          if (inp) inp.addEventListener('change', safe(readConfigFromForm));
        });
      document.addEventListener('keydown', safe(function (ev) {
        if (ev.key === 'Escape') {
          var panel = $('rpmPomodoroPanel');
          if (panel && !panel.hidden) closePanel();
        }
      }));
      document.addEventListener('visibilitychange', safe(function () {
        if (document.visibilityState === 'visible') {
          /* Al volver, el fin de fase se detecta por la hora del
             sistema, no por ticks contados. */
          if (state.session.running && !state.session.paused) tick();
          render();
        }
      }));
    } catch (e) {}
  }

  function init() {
    try {
      try { store = g.localStorage || null; } catch (e) { store = null; }
      state.config = loadConfig(store);
      /* El progreso es del día: si la fecha guardada no es hoy, el
         contador empieza en cero (loadProgress ya lo resetea). */
      state.progress = loadProgress(store, todayKey());
      buildOpenButton();
      buildPanel();
      wireEvents();
      render();
      /* El temporizador nunca arranca solo: solo por clic en
         «Iniciar enfoque» / «Empezar otro bloque». */
    } catch (e) { /* sin Pomodoro: la app sigue igual */ }
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
    sanitizeProgress: sanitizeProgress,
    recordFocusComplete: recordFocusComplete,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    loadProgress: loadProgress,
    saveProgress: saveProgress,
    todayKey: todayKey,
    createSession: createSession,
    phaseDurationMs: phaseDurationMs,
    isLongBreakDue: isLongBreakDue,
    phaseAfterFocus: phaseAfterFocus,
    startFocus: startFocus,
    completePhase: completePhase,
    pauseTimer: pauseTimer,
    resumeTimer: resumeTimer,
    stopSession: stopSession,
    remainingMs: remainingMs,
    remainingSeconds: remainingSeconds,
    fmtMMSS: fmtMMSS,
    progressFraction: progressFraction,
    halfVolumeOf: halfVolumeOf,
    shouldRestoreVolume: shouldRestoreVolume,
    chimeNotes: chimeNotes,
    describePhase: describePhase,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    CONFIG_KEY: CONFIG_KEY,
    PROGRESS_KEY: PROGRESS_KEY,
    TICK_MS: TICK_MS,
    VERSION: VERSION
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    try {
      window.__pomodoro = {
        version: VERSION,
        open: openPanel,
        close: closePanel,
        start: function () {
          try { readConfigFromForm(); startNextBlock(); return true; }
          catch (e) { return false; }
        },
        stop: function () { try { stopAll(); return true; } catch (e) { return false; } },
        getState: function () {
          try {
            return {
              config: JSON.parse(JSON.stringify(state.config)),
              progress: JSON.parse(JSON.stringify(state.progress)),
              session: JSON.parse(JSON.stringify(state.session)),
              awaitingNext: state.awaitingNext,
              pausedByModule: state.pausedByModule,
              lowered: state.lowered ? JSON.parse(JSON.stringify(state.lowered)) : null
            };
          } catch (e) { return null; }
        }
      };
    } catch (e) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
