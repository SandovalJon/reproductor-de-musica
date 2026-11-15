/* Modo coche simplificado para Reproductor de Música — v4.2.0.
   Módulo aparte: NO toca index.html ni la lógica de reproducción.
   NO recrea el overlay de coche: ese ya existe en la app
   (#carOverlay, líneas ~2188 y ~8047-8099 de index.html 4.1.0) con
   sus botones #btnCar, #btnCarClose, #btnCarPlay, #btnCarPrev,
   #btnCarNext, #btnCarLike, #btnCarDislike, #carTitle, #carArtist,
   pantalla completa y Wake Lock. Este módulo solo AÑADE lo que
   faltaba encima de ese overlay, y todo se deshace al salir.

   Qué aporta (verificado en código, no inventado):
   1. Voz manos libres al entrar: reutiliza voz.js tal cual
      (window.__rpmVozListen / __rpmVozStop / __rpmVozState,
      voz.js líneas 707-711). voz.js es push-to-talk de un solo
      disparo (continuous=false, onend NO reinicia: voz.js:605-611),
      así que este módulo rearma la escucha cada vez que voz queda
      en reposo mientras el coche está abierto. No crea un segundo
      reconocedor ni duplica el parser de voz.js.
   2. Anuncio por voz de la canción que suena (speechSynthesis,
      solo si existe): al entrar y cada vez que cambia #carTitle
      dentro del coche. Sin speechSynthesis, no anuncia y no falla.
   3. Botones extragrandes: un interruptor añade la clase
      rpm-coche-xl al overlay (coche.css escala .car-btn, .car-play
      y .car-rate). Al salir se quita la clase.
   4. Atajos de voz propios del coche (parseCarCommand, probado en
      Node): "salir del modo coche", "me gusta", "no me gusta",
      "qué suena", "botones grandes / normales", "activa / apaga
      la voz". Se ejecutan pulsando los botones reales del overlay
      (#btnCarClose, #btnCarLike...) o los interruptores del módulo.

   Al salir del modo coche todo vuelve a lo normal: se apaga la
   escucha que el módulo encendió, se cancela cualquier anuncio a
   medias y se quita la clase XL. Las preferencias (voz, anunciar,
   XL) se guardan en localStorage y se respetan al volver a entrar.

   Límite honesto (verificado en voz.js:575-587): el onresult de
   voz.js llama a su parseCommand INTERNO, no a __rpmVozParse, y no
   expone ningún hook para frases no reconocidas. Por eso un comando
   de coche dicho al micrófono de voz.js recibe "No te entendí"
   hasta que voz.js acepte un hook (ver WIRING.md §7 con la línea
   exacta propuesta). Los comandos de coche sí funcionan desde la
   consola (__rpmCocheParse / __rpmCocheExec) y sus acciones
   equivalentes están en los tres interruptores del overlay.

   FAIL-SAFE: cualquier error, elemento ausente o API ausente hace
   que el módulo no haga nada. Sin voz.js, sin SpeechRecognition o
   sin speechSynthesis, el módulo lo dice en su nota y la app sigue
   igual. Si coche.js no carga, el modo coche de la app funciona
   como antes.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./coche.css">
     <script src="./coche.js"></script>
   Pruebas Node: node --test coche.test.mjs
   Prueba desde la consola:
     window.__rpmCocheParse('salir del modo coche')
     window.__rpmCocheExec('que suena')
     window.__rpmCocheAnnounce()
     window.__rpmCocheState() */
(function (global) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var STORAGE_KEY = 'reproductor-coche:v1';
  var REARM_MS = 800;        // cada cuánto se comprueba si voz quedó en reposo
  var ANNOUNCE_DEBOUNCE_MS = 400; // espera a que título+artista se actualicen juntos
  var PLACEHOLDER_TITLE = 'Elige una canción'; // texto de #carTitle sin canción (index.html:2193)

  function defaultPrefs() {
    return { voz: true, anunciar: true, xl: false };
  }

  /* Preferencias guardadas -> siempre un objeto válido. JSON corrupto,
     tipos raros o claves extra se descartan; lo que falta, por defecto. */
  function sanitizePrefs(raw) {
    var d = defaultPrefs();
    if (!raw || typeof raw !== 'object') return d;
    return {
      voz: typeof raw.voz === 'boolean' ? raw.voz : d.voz,
      anunciar: typeof raw.anunciar === 'boolean' ? raw.anunciar : d.anunciar,
      xl: typeof raw.xl === 'boolean' ? raw.xl : d.xl
    };
  }

  /* Normaliza lo oído: minúsculas, sin acentos, sin puntuación,
     espacios colapsados, sin "por favor" final. Igual criterio que voz.js. */
  function normalize(text) {
    var s = String(text == null ? '' : text);
    s = s.toLowerCase();
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* sin NFD */ }
    s = s.replace(/[¿¡!?,.;:()"«»“”']/g, ' ');
    s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    s = s.replace(/\s+por favor$/, '').replace(/\s+porfa$/, '');
    return s;
  }

  /* Comandos propios del coche. Solo lo que voz.js NO entiende:
     salir, me gusta / no me gusta, qué suena, tamaño de botones y
     encender/apagar la voz del coche. Los comandos generales
     (siguiente, pausa, playlist, busca...) siguen siendo de voz.js;
     aquí 'siguiente'/'anterior'/'reproduce'/'pausa' solo existen para
     que __rpmCocheExec pueda pulsar los botones DEL OVERLAY. */
  var CAR_EXACT = {
    exit: ['salir del modo coche', 'sal del modo coche', 'cierra el modo coche',
      'cerrar el modo coche', 'salir de modo coche', 'salir del coche',
      'sal del coche', 'cierra el coche', 'salir'],
    like: ['me gusta', 'me gusta esta cancion', 'me gusta esta', 'dale me gusta'],
    dislike: ['no me gusta', 'no me gusta esta cancion', 'no me gusta esta'],
    announce: ['que suena', 'que cancion es esta', 'que cancion suena',
      'que esta sonando', 'anuncia la cancion', 'di que suena',
      'que musica es esta', 'que cancion es'],
    xlOn: ['botones grandes', 'botones extragrandes', 'botones extra grandes',
      'agranda los botones', 'pon los botones grandes', 'botones mas grandes'],
    xlOff: ['botones normales', 'botones pequenos', 'achica los botones',
      'pon los botones normales', 'botones mas pequenos'],
    xlToggle: ['cambia el tamano de los botones'],
    voiceOn: ['activa la voz', 'enciende la voz', 'activa el microfono',
      'escucha', 'activa la voz del coche'],
    voiceOff: ['apaga la voz', 'desactiva la voz', 'apaga el microfono',
      'deja de escuchar', 'silencia la voz'],
    play: ['reproduce', 'pon musica', 'dale'],
    pause: ['pausa', 'pausala'],
    next: ['siguiente', 'siguiente cancion', 'otra cancion'],
    prev: ['anterior', 'cancion anterior', 'la anterior']
  };

  function parseCarCommand(raw) {
    var heard = String(raw == null ? '' : raw).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var s = normalize(raw);
    if (!s) return { kind: 'unknown', heard: heard };
    var kinds = ['exit', 'like', 'dislike', 'announce', 'xlOn', 'xlOff',
      'xlToggle', 'voiceOn', 'voiceOff', 'play', 'pause', 'next', 'prev'];
    for (var k = 0; k < kinds.length; k++) {
      if (CAR_EXACT[kinds[k]].indexOf(s) !== -1) return { kind: kinds[k], heard: heard };
    }
    return { kind: 'unknown', heard: heard };
  }

  function confirmationText(action) {
    if (!action) return null;
    switch (action.kind) {
      case 'exit': return 'Entendí: salir del modo coche';
      case 'like': return 'Entendí: me gusta';
      case 'dislike': return 'Entendí: no me gusta';
      case 'announce': return 'Entendí: qué suena';
      case 'xlOn': return 'Entendí: botones grandes';
      case 'xlOff': return 'Entendí: botones normales';
      case 'xlToggle': return 'Entendí: cambiar el tamaño de los botones';
      case 'voiceOn': return 'Entendí: activar la voz';
      case 'voiceOff': return 'Entendí: apagar la voz';
      case 'play': return 'Entendí: reproduce';
      case 'pause': return 'Entendí: pausa';
      case 'next': return 'Entendí: siguiente';
      case 'prev': return 'Entendí: anterior';
      default: return null;
    }
  }

  /* Texto que se anuncia por voz. null si no hay canción real
     (vacío o el placeholder "Elige una canción" de #carTitle). */
  function announceText(title, artist) {
    var t = String(title == null ? '' : title).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!t || t === PLACEHOLDER_TITLE) return null;
    var a = String(artist == null ? '' : artist).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    return a ? 'Sonando: ' + t + ' de ' + a : 'Sonando: ' + t;
  }

  /* ¿Anunciar este cambio de canción? Solo dentro del coche, con el
     ajuste encendido, con speechSynthesis y si la canción cambió. */
  function shouldAnnounce(opts) {
    var o = opts || {};
    if (!o.carOpen || !o.announcePref || !o.synthSupported) return false;
    if (!announceText(o.title, o.artist)) return false;
    if (o.title === o.lastTitle && o.artist === o.lastArtist) return false;
    return true;
  }

  /* ¿Rearmar la escucha de voz.js ahora? voz.js es de un solo disparo:
     hay que volver a llamar a __rpmVozListen cuando queda en reposo.
     Nunca se llama si ya está escuchando: __rpmVozListen es un toggle
     (voz.js:547-548) y llamarlo escuchando APAGARÍA el micrófono. */
  function decideRearm(opts) {
    var o = opts || {};
    if (!o.carOpen) return { start: false, reason: 'coche cerrado' };
    if (!o.voicePref) return { start: false, reason: 'voz apagada por el usuario' };
    if (!o.vozAvailable) return { start: false, reason: 'voz.js no cargado' };
    if (!o.vozSupported) return { start: false, reason: 'navegador sin SpeechRecognition' };
    if (!o.pageVisible) return { start: false, reason: 'pagina oculta' };
    if (o.vozListening) return { start: false, reason: 'ya escuchando' };
    return { start: true, reason: 'ok' };
  }

  /* Decisiones puras al entrar / salir del coche. */
  function onCarEnter(prefs, caps) {
    var p = sanitizePrefs(prefs);
    var c = caps || {};
    return {
      startVoice: !!(p.voz && c.vozAvailable && c.vozSupported),
      announceNow: !!(p.anunciar && c.synthSupported),
      applyXl: !!p.xl
    };
  }
  function onCarExit() {
    return { stopVoice: true, cancelSpeech: true, removeXl: true };
  }

  /* ================= Parte DOM (solo navegador) ================= */

  var IDS = {
    car: 'carOverlay', title: 'carTitle', artist: 'carArtist',
    audio: 'audio', wakeCar: 'btnWakeCar',
    bar: 'rpmCocheBar', vozBtn: 'rpmCocheVozBtn', annBtn: 'rpmCocheAnunciarBtn',
    xlBtn: 'rpmCocheXlBtn', note: 'rpmCocheNote'
  };

  var prefs = defaultPrefs();
  var carOpen = false;
  var vozStartedByModule = false; // solo apaga la escucha que él encendió
  var lastAnnounced = { title: '', artist: '' };
  var rearmTimer = null;
  var announceTimer = null;
  var carObserver = null;
  var trackObserver = null;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function clickBtn(id) {
    var b = $(id);
    if (!b || b.disabled) return false;
    try { b.click(); return true; } catch (e) { return false; }
  }
  function loadPrefs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      prefs = sanitizePrefs(raw ? JSON.parse(raw) : null);
    } catch (e) { prefs = defaultPrefs(); }
    return prefs;
  }
  function savePrefs() {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) { /* sin almacenamiento: la preferencia solo dura la sesión */ }
  }
  function vozApi() {
    return {
      listen: typeof global.__rpmVozListen === 'function' ? global.__rpmVozListen : null,
      stop: typeof global.__rpmVozStop === 'function' ? global.__rpmVozStop : null,
      state: typeof global.__rpmVozState === 'function' ? global.__rpmVozState : null
    };
  }
  function vozSupported() {
    try {
      var st = vozApi().state;
      return !!st && !!st().supported;
    } catch (e) { return false; }
  }
  function vozListening() {
    try {
      var st = vozApi().state;
      return !!st && !!st().listening;
    } catch (e) { return false; }
  }
  function synthSupported() {
    try { return !!global.speechSynthesis; } catch (e) { return false; }
  }
  function isCarOpen() {
    var el = $(IDS.car);
    if (!el) return false;
    try {
      return el.classList.contains('on') || el.getAttribute('aria-hidden') === 'false';
    } catch (e) { return false; }
  }
  function currentTrackText() {
    var t = $(IDS.title), a = $(IDS.artist);
    return {
      title: t ? String(t.textContent || '') : '',
      artist: a ? String(a.textContent || '') : ''
    };
  }

  /* --- Anuncio por voz (speechSynthesis) --- */
  function speak(text) {
    if (!text || !synthSupported()) return false;
    try {
      global.speechSynthesis.cancel();
      var u = new global.SpeechSynthesisUtterance(text);
      u.lang = 'es-MX';
      u.rate = 1;
      global.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  function announceCurrent() {
    var cur = currentTrackText();
    var text = announceText(cur.title, cur.artist);
    if (!text) return false;
    lastAnnounced = { title: cur.title, artist: cur.artist };
    return speak(text);
  }
  function maybeAnnounce() {
    try {
      var cur = currentTrackText();
      if (!shouldAnnounce({
        carOpen: carOpen, announcePref: prefs.anunciar,
        synthSupported: synthSupported(), title: cur.title, artist: cur.artist,
        lastTitle: lastAnnounced.title, lastArtist: lastAnnounced.artist
      })) return;
      announceCurrent();
    } catch (e) { /* el anuncio nunca rompe la app */ }
  }
  function scheduleAnnounce() {
    try {
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(maybeAnnounce, ANNOUNCE_DEBOUNCE_MS);
    } catch (e) { /* noop */ }
  }

  /* --- Voz manos libres: rearmar voz.js mientras el coche está abierto --- */
  function rearmTick() {
    try {
      if (!carOpen) return;
      var api = vozApi();
      var d = decideRearm({
        carOpen: true, voicePref: prefs.voz, vozAvailable: !!api.listen,
        vozSupported: vozSupported(), vozListening: vozListening(),
        pageVisible: typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
      });
      if (!d.start || !api.listen) return;
      api.listen();
      vozStartedByModule = true;
    } catch (e) { /* el micrófono nunca rompe la app */ }
  }
  function startRearm() {
    stopRearm();
    try { rearmTimer = setInterval(rearmTick, REARM_MS); } catch (e) { /* noop */ }
    rearmTick();
  }
  function stopRearm() {
    try {
      if (rearmTimer) { clearInterval(rearmTimer); rearmTimer = null; }
    } catch (e) { /* noop */ }
  }
  function stopModuleVoice() {
    try {
      if (!vozStartedByModule) return;
      vozStartedByModule = false;
      var api = vozApi();
      if (api.stop && vozListening()) api.stop();
    } catch (e) { /* noop */ }
  }

  /* --- Interruptores dentro del overlay (no duplican botones: son nuevos) --- */
  function syncButtons() {
    try {
      var vb = $(IDS.vozBtn), ab = $(IDS.annBtn), xb = $(IDS.xlBtn);
      if (vb) {
        vb.classList.toggle('on', !!prefs.voz);
        vb.setAttribute('aria-pressed', prefs.voz ? 'true' : 'false');
        vb.innerHTML = '<span class="dot"></span><span>Voz manos libres:&nbsp;</span><span>' + (prefs.voz ? 'Activada' : 'Apagada') + '</span>';
        vb.disabled = !vozApi().listen || !vozSupported();
        vb.title = vozSupported() ? 'Al entrar en modo coche, el micrófono se enciende solo'
          : 'Tu navegador no soporta voz (falta SpeechRecognition o voz.js)';
      }
      if (ab) {
        ab.classList.toggle('on', !!prefs.anunciar);
        ab.setAttribute('aria-pressed', prefs.anunciar ? 'true' : 'false');
        ab.innerHTML = '<span class="dot"></span><span>Anunciar canción:&nbsp;</span><span>' + (prefs.anunciar ? 'Activado' : 'Apagado') + '</span>';
        ab.disabled = !synthSupported();
        ab.title = synthSupported() ? 'Anuncia por voz la canción que suena'
          : 'Tu navegador no soporta anuncios por voz (falta speechSynthesis)';
      }
      if (xb) {
        xb.classList.toggle('on', !!prefs.xl);
        xb.setAttribute('aria-pressed', prefs.xl ? 'true' : 'false');
        xb.innerHTML = '<span class="dot"></span><span>Botones extragrandes:&nbsp;</span><span>' + (prefs.xl ? 'Activados' : 'Apagados') + '</span>';
      }
    } catch (e) { /* noop */ }
  }
  function syncNote() {
    var note = $(IDS.note);
    if (!note) return;
    try {
      var msgs = [];
      if (!vozApi().listen) msgs.push('Voz no disponible: voz.js no cargó.');
      else if (!vozSupported()) msgs.push('Voz no disponible: este navegador no soporta SpeechRecognition.');
      if (!synthSupported()) msgs.push('Anuncios por voz no disponibles: este navegador no soporta speechSynthesis.');
      note.textContent = msgs.join(' ');
      note.style.display = msgs.length ? 'block' : 'none';
    } catch (e) { /* noop */ }
  }
  function applyXl() {
    var el = $(IDS.car);
    if (!el) return;
    try { el.classList.toggle('rpm-coche-xl', !!prefs.xl); } catch (e) { /* noop */ }
  }
  function buildBar() {
    var car = $(IDS.car);
    if (!car || $(IDS.bar)) return $(IDS.bar);
    try {
      var bar = document.createElement('div');
      bar.id = IDS.bar;
      bar.className = 'rpm-coche-bar';
      var vb = document.createElement('button');
      vb.id = IDS.vozBtn; vb.type = 'button'; vb.className = 'toggle-pill';
      vb.setAttribute('aria-pressed', 'false');
      var ab = document.createElement('button');
      ab.id = IDS.annBtn; ab.type = 'button'; ab.className = 'toggle-pill';
      ab.setAttribute('aria-pressed', 'false');
      var xb = document.createElement('button');
      xb.id = IDS.xlBtn; xb.type = 'button'; xb.className = 'toggle-pill';
      xb.setAttribute('aria-pressed', 'false');
      var note = document.createElement('p');
      note.id = IDS.note; note.className = 'rpm-coche-note';
      note.setAttribute('role', 'status'); note.style.display = 'none';
      bar.appendChild(vb); bar.appendChild(ab); bar.appendChild(xb);
      // Antes de la fila de Wake Lock (#btnWakeCar), para no tapar
      // los controles ni la valoración. Si no está, al final.
      // La nota va justo detrás de la barra.
      var wake = $(IDS.wakeCar);
      if (wake && wake.parentNode) {
        car.insertBefore(bar, wake.parentNode);
      } else {
        car.appendChild(bar);
      }
      if (bar.parentNode) bar.parentNode.insertBefore(note, bar.nextSibling);
      else car.appendChild(note);
      vb.addEventListener('click', function () {
        try {
          prefs.voz = !prefs.voz; savePrefs(); syncButtons();
          if (!prefs.voz) { stopRearm(); stopModuleVoice(); }
          else if (carOpen) { startRearm(); }
        } catch (e) { /* noop */ }
      });
      ab.addEventListener('click', function () {
        try {
          prefs.anunciar = !prefs.anunciar; savePrefs(); syncButtons();
          if (!prefs.anunciar) { try { if (synthSupported()) global.speechSynthesis.cancel(); } catch (e2) { /* noop */ } }
          else if (carOpen) { announceCurrent(); }
        } catch (e) { /* noop */ }
      });
      xb.addEventListener('click', function () {
        try {
          prefs.xl = !prefs.xl; savePrefs(); syncButtons(); applyXl();
        } catch (e) { /* noop */ }
      });
      return bar;
    } catch (e) { return null; }
  }

  /* --- Entrar / salir --- */
  function onEnter() {
    try {
      var dec = onCarEnter(prefs, {
        vozAvailable: !!vozApi().listen, vozSupported: vozSupported(),
        synthSupported: synthSupported()
      });
      applyXl();
      syncButtons(); syncNote();
      if (dec.announceNow) {
        lastAnnounced = { title: '', artist: '' };
        announceCurrent();
      }
      if (dec.startVoice) startRearm();
      else stopRearm();
    } catch (e) { /* noop */ }
  }
  function onExit() {
    try {
      onCarExit();
      stopRearm();
      stopModuleVoice();
      try { if (synthSupported()) global.speechSynthesis.cancel(); } catch (e) { /* noop */ }
      var el = $(IDS.car);
      if (el) { try { el.classList.remove('rpm-coche-xl'); } catch (e2) { /* noop */ } }
      syncButtons();
    } catch (e) { /* noop */ }
  }
  function refreshCarState() {
    try {
      var open = isCarOpen();
      if (open === carOpen) return;
      carOpen = open;
      if (carOpen) onEnter(); else onExit();
    } catch (e) { /* noop */ }
  }

  /* Ejecuta un comando de coche ya parseado (o en texto) pulsando los
     botones reales del overlay. Devuelve el mensaje a mostrar. */
  function executeCarCommand(actionOrText) {
    try {
      var action = typeof actionOrText === 'string'
        ? parseCarCommand(actionOrText) : actionOrText;
      if (!action || action.kind === 'unknown') {
        return 'No te entendí. Prueba con "salir del modo coche", "me gusta" o "qué suena".';
      }
      var audio = $(IDS.audio);
      switch (action.kind) {
        case 'exit':
          return clickBtn('btnCarClose') ? confirmationText(action)
            : 'No puedo salir del modo coche ahora mismo.';
        case 'like':
          return clickBtn('btnCarLike') ? confirmationText(action)
            : 'No hay canción para valorar ahora mismo.';
        case 'dislike':
          return clickBtn('btnCarDislike') ? confirmationText(action)
            : 'No hay canción para valorar ahora mismo.';
        case 'announce':
          if (announceCurrent()) return 'Sonando: ' + currentTrackText().title;
          return synthSupported() ? 'No hay ninguna canción sonando.'
            : 'Este navegador no soporta anuncios por voz.';
        case 'xlOn':
          prefs.xl = true; savePrefs(); syncButtons(); applyXl();
          return confirmationText(action);
        case 'xlOff':
          prefs.xl = false; savePrefs(); syncButtons(); applyXl();
          return confirmationText(action);
        case 'xlToggle': {
          var xb = $(IDS.xlBtn);
          if (xb) { xb.click(); return confirmationText(action); }
          prefs.xl = !prefs.xl; savePrefs(); syncButtons(); applyXl();
          return confirmationText(action);
        }
        case 'voiceOn':
          prefs.voz = true; savePrefs(); syncButtons();
          if (carOpen) startRearm();
          return confirmationText(action);
        case 'voiceOff':
          prefs.voz = false; savePrefs(); syncButtons();
          stopRearm(); stopModuleVoice();
          return confirmationText(action);
        case 'play':
          if (audio && !audio.paused) return 'Ya está sonando.';
          return clickBtn('btnCarPlay') ? confirmationText(action)
            : 'No hay ninguna canción para reproducir.';
        case 'pause':
          if (audio && audio.paused) return 'Ya está en pausa.';
          return clickBtn('btnCarPlay') ? confirmationText(action)
            : 'No hay nada sonando para pausar.';
        case 'next':
          return clickBtn('btnCarNext') ? confirmationText(action)
            : 'No puedo pasar a la siguiente ahora mismo.';
        case 'prev':
          return clickBtn('btnCarPrev') ? confirmationText(action)
            : 'No puedo volver a la anterior ahora mismo.';
        default:
          return 'No te entendí. Prueba con "salir del modo coche", "me gusta" o "qué suena".';
      }
    } catch (e) { return 'No pude procesar ese comando.'; }
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./coche.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './coche.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS los interruptores siguen funcionando */ }
  }

  function init() {
    try {
      loadPrefs();
      if (typeof document === 'undefined') return;
      ensureCss();
      var car = $(IDS.car);
      if (!car) return; // sin overlay no hay nada que enganchar
      buildBar();
      syncButtons(); syncNote();
      carOpen = isCarOpen();
      if (carOpen) onEnter();
      // openCar()/closeCar() viven dentro del IIFE de index.html y no
      // están en window: se detecta la apertura por el DOM (clase 'on'
      // + aria-hidden), con los clics en #btnCar/#btnCarClose de apoyo.
      try {
        if (typeof MutationObserver !== 'undefined') {
          carObserver = new MutationObserver(function () { refreshCarState(); });
          carObserver.observe(car, { attributes: true, attributeFilter: ['class', 'aria-hidden'] });
          var titleEl = $(IDS.title), artistEl = $(IDS.artist);
          trackObserver = new MutationObserver(function () { scheduleAnnounce(); });
          if (titleEl) trackObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
          if (artistEl) trackObserver.observe(artistEl, { childList: true, characterData: true, subtree: true });
        }
      } catch (e) { /* sin MutationObserver: solo los clics de apoyo */ }
      var btnCar = $('btnCar'), btnClose = $('btnCarClose');
      if (btnCar) btnCar.addEventListener('click', function () { setTimeout(refreshCarState, 50); });
      if (btnClose) btnClose.addEventListener('click', function () { setTimeout(refreshCarState, 50); });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && carOpen) setTimeout(refreshCarState, 50);
      });
    } catch (e) { /* fail-safe: modo coche sin añadidos, app intacta */ }
  }

  var api = {
    normalize: normalize,
    parseCarCommand: parseCarCommand,
    confirmationText: confirmationText,
    announceText: announceText,
    shouldAnnounce: shouldAnnounce,
    decideRearm: decideRearm,
    onCarEnter: onCarEnter,
    onCarExit: onCarExit,
    sanitizePrefs: sanitizePrefs,
    defaultPrefs: defaultPrefs,
    executeCarCommand: executeCarCommand,
    STORAGE_KEY: STORAGE_KEY,
    REARM_MS: REARM_MS,
    PLACEHOLDER_TITLE: PLACEHOLDER_TITLE
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    global.__rpmCoche = api;
    global.__rpmCocheParse = parseCarCommand;
    global.__rpmCocheExec = executeCarCommand;
    global.__rpmCocheAnnounce = function () { try { return announceCurrent(); } catch (e) { return false; } };
    global.__rpmCocheState = function () {
      return {
        carOpen: carOpen, prefs: sanitizePrefs(prefs),
        vozSupported: vozSupported(), vozListening: vozListening(),
        synthSupported: synthSupported(),
        lastAnnounced: { title: lastAnnounced.title, artist: lastAnnounced.artist }
      };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
