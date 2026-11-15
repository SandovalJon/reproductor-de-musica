/* Chromecast / reproducción remota (v3.1.0) — módulo aparte.
   No toca el código de index.html: se engancha solo al <audio id="audio">
   que ya existe en la app y añade un botón "📺 Enviar" como último hijo
   del .controls del reproductor (después de #btnRepeat, el ancla estable).
   Sin HTML que editar para el botón: lo crea este módulo por DOM.

   POR QUÉ REMOTEPLAYBACK Y NO EL SDK PARA ENVIAR LA URL:
   las pistas son archivos locales guardados como blobs en IndexedDB y su
   audio.src es una blob: URL que ningún receptor Chromecast puede
   descargar. Por eso la vía principal es la API RemotePlayback del
   propio elemento <audio> (audio.remote): Chrome se encarga de llevar
   el audio al dispositivo; este módulo NUNCA cambia audio.src, nunca
   auto-conecta y nunca pausa la reproducción local salvo lo que el
   propio navegador haga al enviar. El SDK de Cast
   (https://www.gstatic.com/cv/js/sender/v1/cast_sender.js) solo se
   intenta como fallback cuando RemotePlayback no existe, solo si carga,
   y solo muestra el botón si el receptor puede cargar la pista actual
   (es decir, NO una blob:); en la práctica, con pistas locales, ese
   fallback mantiene el botón oculto.

   FAIL-SAFE: cualquier error, API ausente o SDK que no carga hace que el
   módulo no haga nada. La reproducción local queda byte-idéntica con
   o sin este módulo: si el botón nunca aparece, la app es la misma. */
(function (global) {
  'use strict';

  var CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js';
  var SDK_TIMEOUT_MS = 8000;
  var LABEL_SEND = '📺 Enviar';
  var LABEL_CONNECTING = '📺 Conectando…';
  var LABEL_CONNECTED = '📺 Enviando';
  var TITLE_NONE = 'Sin dispositivos para enviar';
  var TITLE_SEND = 'Enviar a un dispositivo (Chromecast / TV)';
  var TITLE_CONNECTING = 'Conectando con el dispositivo…';
  var TITLE_CONNECTED = 'Enviando a un dispositivo — toca para cambiar o desconectar';

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  /* Estado remoto -> aspecto del botón.
     remoteState: 'disconnected' | 'connecting' | 'connected' | null.
     availability: true si watchAvailability avisó de que hay dispositivo. */
  function castButtonState(remoteState, availability) {
    if (!availability) {
      return { visible: false, disabled: true, label: LABEL_SEND, title: TITLE_NONE, active: false };
    }
    if (remoteState === 'connecting') {
      return { visible: true, disabled: true, label: LABEL_CONNECTING, title: TITLE_CONNECTING, active: false };
    }
    if (remoteState === 'connected') {
      return { visible: true, disabled: false, label: LABEL_CONNECTED, title: TITLE_CONNECTED, active: true };
    }
    return { visible: true, disabled: false, label: LABEL_SEND, title: TITLE_SEND, active: false };
  }

  /* ¿Puede un receptor Cast cargar la pista actual por su cuenta?
     El receptor descarga la URL: una blob: (pistas locales de IndexedDB)
     o data: es inalcanzable para él -> false. Solo http(s) vale. */
  function canSdkCast(src) {
    if (!src || typeof src !== 'string') return false;
    if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) return false;
    return src.indexOf('http://') === 0 || src.indexOf('https://') === 0;
  }

  /* ¿Se muestra el botón, y por qué vía?
     castSdk: null | { available: boolean, canCastCurrent: boolean }.
     Prioridad: RemotePlayback > SDK > nada. */
  function decideCastVisibility(input) {
    var opts = input || {};
    if (opts.remoteSupported && opts.availability) {
      return { visible: true, source: 'remote', reason: 'RemotePlayback disponible con dispositivo' };
    }
    if (opts.remoteSupported) {
      return { visible: false, source: 'remote', reason: TITLE_NONE };
    }
    var sdk = opts.castSdk;
    if (sdk && sdk.available && sdk.canCastCurrent) {
      return { visible: true, source: 'sdk', reason: 'SDK de Cast con receptor disponible' };
    }
    if (sdk && sdk.available && !sdk.canCastCurrent) {
      return { visible: false, source: 'sdk', reason: 'El receptor no puede cargar la pista actual (archivo local)' };
    }
    return { visible: false, source: 'none', reason: 'Sin RemotePlayback ni SDK de Cast' };
  }

  /* ---- Parte de navegador (nunca se ejecuta en Node) ---- */

  function $(id) { return document.getElementById(id); }

  /* Igual que lyrics.js / mejoras.js: el módulo trae su propio CSS si
     WIRING.md no añadió el <link> en index.html. */
  function ensureCss() {
    try {
      if (document.querySelector('link[href="./cast.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './cast.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el botón sigue funcionando, solo sin estilo */ }
  }

  function applyState(btn, st) {
    try {
      btn.hidden = !st.visible;
      btn.classList.toggle('cast-visible', !!st.visible);
      btn.classList.toggle('cast-on', !!st.active);
      btn.disabled = !!st.disabled;
      btn.textContent = st.label;
      btn.title = st.title;
      btn.setAttribute('aria-pressed', st.active ? 'true' : 'false');
    } catch (e) { /* si el botón ya no está en el DOM, no pasa nada */ }
  }

  /* Ancla: último hijo de .controls, después de #btnRepeat.
     Fallbacks por si el HTML cambia: antes de .secondary-row, o al
     final de .player-body. Si no hay ancla, no se crea el botón. */
  function placeButton(btn) {
    var repeat = $('btnRepeat');
    var controls = (repeat && repeat.parentNode) ? repeat.parentNode : document.querySelector('.controls');
    if (controls) { controls.appendChild(btn); return true; }
    var secondary = document.querySelector('.secondary-row');
    if (secondary && secondary.parentNode) { secondary.parentNode.insertBefore(btn, secondary); return true; }
    var body = document.querySelector('.player-body');
    if (body) { body.appendChild(btn); return true; }
    return false;
  }

  function buildButton() {
    if ($('btnCast')) return $('btnCast');
    var btn = document.createElement('button');
    btn.id = 'btnCast';
    btn.type = 'button';
    btn.className = 'btn small cast-btn';
    btn.hidden = true; /* oculto hasta que haya un dispositivo */
    btn.textContent = LABEL_SEND;
    btn.title = TITLE_NONE;
    btn.setAttribute('aria-pressed', 'false');
    if (!placeButton(btn)) return null;
    return btn;
  }

  /* ---- Vía principal: RemotePlayback sobre el <audio> existente ---- */
  function setupRemote(audio, btn) {
    var remote = audio.remote;
    var availability = false;

    function render() {
      var state = 'disconnected';
      try { state = remote.state || 'disconnected'; } catch (e) { state = 'disconnected'; }
      applyState(btn, castButtonState(state, availability));
    }

    try {
      var p = remote.watchAvailability(function (available) {
        availability = !!available;
        render();
      });
      if (p && typeof p.catch === 'function') {
        p.catch(function () { /* sin disponibilidad: el botón sigue oculto */ });
      }
    } catch (e) { return; }

    /* 'connecting' / 'connect' / 'disconnect' llegan en remote.state.
       Al desconectar NO tocamos audio: no play(), no pause(), no src.
       La reproducción local queda exactamente como estaba. */
    ['connecting', 'connect', 'disconnect'].forEach(function (ev) {
      try { remote.addEventListener(ev, render); } catch (e) { /* evento no soportado */ }
    });
    render(); /* estado inicial (p. ej. ya conectado al recargar) */

    btn.addEventListener('click', function () {
      try {
        /* prompt() SOLO vale dentro del gesto del usuario (el clic). */
        var pr = remote.prompt();
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function () { /* usuario canceló o no hay dispositivo */ });
        }
      } catch (e) { /* prompt no disponible en este momento */ }
    });
  }

  /* ---- Fallback: SDK de Cast, solo si RemotePlayback no existe ---- */
  function trySdkFallback(audio, btn) {
    var done = false;
    var timer = null;
    function finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
    }
    function onSdkReady(loaded) {
      if (!loaded) { finish(); return; }
      finish();
      try { initSdk(audio, btn); } catch (e) { /* SDK inutilizable: botón oculto */ }
    }
    try { global.__onGCastApiAvailable = onSdkReady; } catch (e) { /* sin global escribible */ }
    var script = document.createElement('script');
    script.src = CAST_SDK_URL;
    script.async = true;
    script.onload = function () {
      if (done) return;
      var g = global || {};
      if ((g.chrome && g.chrome.cast) || (g.cast && g.cast.framework)) onSdkReady(true);
      else finish();
    };
    script.onerror = function () {
      finish();
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    timer = setTimeout(function () {
      finish();
      if (script.parentNode) script.parentNode.removeChild(script);
    }, SDK_TIMEOUT_MS);
    try { document.head.appendChild(script); } catch (e) { finish(); }
  }

  function initSdk(audio, btn) {
    var g = global || {};
    var receiverAvailable = false;
    var sdkState = 'disconnected'; /* 'disconnected' | 'connecting' | 'connected' */

    function render() {
      var decision = decideCastVisibility({
        remoteSupported: false,
        availability: false,
        castSdk: { available: receiverAvailable, canCastCurrent: canSdkCast(audio.currentSrc || '') }
      });
      /* El botón solo existe si el receptor puede cargar la pista actual;
         con pistas locales (blob:) decideCastVisibility lo oculta. */
      applyState(btn, castButtonState(decision.visible ? sdkState : null, decision.visible));
    }

    function loadViaChromeCast(session) {
      try {
        var mediaInfo = new g.chrome.cast.media.MediaInfo(audio.currentSrc, 'audio/mpeg');
        var request = new g.chrome.cast.media.LoadRequest(mediaInfo);
        request.currentTime = audio.currentTime || 0;
        session.loadMedia(request, function () {}, function () {});
      } catch (e) { /* el receptor no pudo cargar: la pista local sigue sonando */ }
    }

    function loadViaFramework(session) {
      try {
        var mediaInfo = new g.cast.framework.messages.MediaInfo(audio.currentSrc, 'audio/mpeg');
        var request = new g.cast.framework.messages.LoadRequestData();
        request.media = mediaInfo;
        request.currentTime = audio.currentTime || 0;
        var pr = session.loadMedia(request);
        if (pr && typeof pr.catch === 'function') pr.catch(function () {});
      } catch (e) { /* igual que arriba: no se toca la reproducción local */ }
    }

    btn.addEventListener('click', function () {
      try {
        if (g.cast && g.cast.framework) {
          g.cast.framework.CastContext.getInstance().requestSession()
            .then(function (session) { loadViaFramework(session); })
            .catch(function () {});
        } else if (g.chrome && g.chrome.cast) {
          g.chrome.cast.requestSession(function (session) { loadViaChromeCast(session); }, function () {});
        }
      } catch (e) { /* sin sesión: nada cambia */ }
    });

    /* Reevaluar al cambiar de pista: una pista http(s) sí se podría enviar. */
    try { audio.addEventListener('loadedmetadata', render); } catch (e) {}

    if (g.cast && g.cast.framework) {
      var ctx = g.cast.framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: g.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: g.cast.framework.AutoJoinPolicy.ORIGIN_SCOPED
      });
      ctx.addEventListener(g.cast.framework.CastContextEventType.CAST_STATE_CHANGED, function (e) {
        var noDevices = g.cast.framework.CastState.NO_DEVICES_AVAILABLE;
        receiverAvailable = e.castState !== noDevices;
        sdkState = (e.castState === g.cast.framework.CastState.CONNECTED) ? 'connected'
          : (e.castState === g.cast.framework.CastState.CONNECTING) ? 'connecting' : 'disconnected';
        render();
      });
    } else if (g.chrome && g.chrome.cast) {
      var sessionRequest = new g.chrome.cast.SessionRequest(g.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID);
      var apiConfig = new g.chrome.cast.ApiConfig(
        sessionRequest,
        function (session) { /* sesión creada desde otro sitio */
          sdkState = 'connected';
          try { session.addUpdateListener(function (isAlive) { if (!isAlive) { sdkState = 'disconnected'; render(); } }); } catch (e) {}
          render();
        },
        function (availability) { receiverAvailable = availability === 'available'; render(); },
        g.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      );
      g.chrome.cast.initialize(apiConfig, function () { render(); }, function () { /* init fallida: botón oculto */ });
    }
    render();
  }

  function init() {
    try {
      var audio = $('audio');
      if (!audio) return; /* sin <audio> no hay nada que enviar */
      ensureCss();
      var btn = buildButton();
      if (!btn) return; /* sin ancla en el DOM, no se crea el botón */
      if (audio.remote && 'remote' in audio) { setupRemote(audio, btn); return; }
      trySdkFallback(audio, btn);
    } catch (e) { /* fail-safe: Cast desactivado, local intacto */ }
  }

  var api = {
    castButtonState: castButtonState,
    decideCastVisibility: decideCastVisibility,
    canSdkCast: canSdkCast
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__castHelpers = api; } catch (e) { /* consola: window.__castHelpers */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
