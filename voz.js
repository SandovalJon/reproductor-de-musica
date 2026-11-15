/* Control por voz para Reproductor de Música — v3.5.0.
   Módulo aparte: NO toca index.html ni la lógica de reproducción.
   Se engancha solo por DOM a lo que ya existe en la app:
     <audio id="audio">, #btnPlay, #btnNext, #btnPrev, #btnMute,
     input#volume (0-100), #search, pestañas [data-view] y los chips
     de playlist de #plBar + #btnPlPlay.
   Sus acciones NO reproducen nada por su cuenta: hacen click en los
   botones reales de la app o disparan el evento 'input' que la app
   ya escucha, así que respetan cola, crossfade, tope de volumen
   seguro (volCap), dislike y todo lo demás sin duplicar lógica.

   Qué hace:
   - Un botón de micrófono 🎙️ junto a #btnMute (en .vol-group, la
     fila de volumen del reproductor). SOLO escucha cuando el usuario
     lo pulsa (push-to-talk): nunca escucha en segundo plano, nunca
     se reinicia solo y se apaga tras cada comando o tras 8 s sin
     hablar. Un segundo toque mientras escucha lo apaga.
   - Usa SpeechRecognition del navegador (webkitSpeechRecognition
     como fallback), lang 'es-MX'. Si el navegador no lo soporta, el
     botón sigue visible y al pulsarlo avisa "Tu navegador no soporta
     voz"; la app no falla.
   - Comandos en español (ver parseCommand): siguiente, anterior,
     pausa, reproduce / pon música / dale, sube/baja el volumen (con
     o sin número: "sube el volumen a 50", "volumen al 80"),
     silencio, "pon la playlist X", "busca X".
   - Confirmación visual breve en una píldora fija ("Entendí:
     siguiente") y mensaje si no se entendió. El micrófono no graba
     nada: el módulo no envía audio a ningún servidor; solo usa la
     API del navegador (ojo: en Chrome/Edge esa API la implementa el
     propio navegador y puede usar sus servidores; ver WIRING.md §7).

   Detalles que importan (verificados en app/index.html 3.4.0):
   - #btnPlay es un TOGGLE (togglePlay). Por eso "reproduce" solo
     pulsa #btnPlay si <audio> está en pausa, y "pausa" solo si está
     sonando: si no, el comando diría lo contrario de lo pedido.
     Lo mismo con #btnMute: "silencio" solo pulsa #btnMute si el
     volumen es > 0; si ya está a 0, pulsar lo RESTAURARÍA (el botón
     alterna entre 0 y lastVolume, línea ~5086).
   - El volumen se cambia poniendo input#volume.value y disparando
     su evento 'input': la app aplica applyVolume() (línea ~5078),
     con su tope volCap y guardado de estado. Nunca se toca
     audio.volume directamente (hay 3 decks: audio, audioB, vídeo).
   - #search solo filtra la biblioteca y su caja (.lib-tools) se
     oculta fuera de la vista Biblioteca (setView, línea ~3610). Por
     eso "busca X" primero pulsa la pestaña [data-view="library"],
     luego escribe en #search y dispara 'input' (línea ~5173).
   - Las playlists NO están expuestas en window.__rpmApp (solo
     getTracks, render, toast...). Sus nombres se leen de los chips
     de #plBar, que renderPlaylists() (línea ~3769, llamada en cada
     renderPack) regenera siempre: chip = "📌 nombre (n)". Para
     reproducir una: pulsar la pestaña Playlists, pulsar su chip
     (selecciona la playlist) y pulsar #btnPlPlay (playPlaylist,
     línea ~3834). Si no hay coincidencia, no se reproduce nada.
   - El reconocimiento es de un solo disparo (continuous=false):
     el navegador lo detiene solo tras la frase; además hay un
     temporizador de 8 s sin hablar que lo apaga.

   FAIL-SAFE: cualquier error, elemento ausente o API ausente hace
   que el módulo no haga nada. La app queda byte-idéntica con o sin
   este módulo: si voz.js no carga, todo lo demás sigue igual.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./voz.css">
     <script src="./voz.js"></script>
   Pruebas Node: node --test voz.test.mjs
   Prueba desde la consola:
     window.__rpmVozParse('pon la playlist Rock')
     window.__rpmVozListen() / window.__rpmVozStop()
     window.__rpmVozState()  // { supported, listening } */
(function (global) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var VOLUME_STEP = 10;       // "sube/baja el volumen" sin más
  var VOLUME_STEP_SMALL = 5;  // "sube un poco el volumen"
  var VOLUME_STEP_BIG = 20;   // "sube mucho el volumen"
  var VOLUME_MIN = 0;
  var VOLUME_MAX = 100;
  var SILENCE_TIMEOUT_MS = 8000; // sin hablar: el micrófono se apaga
  var STATUS_MS = 3500;          // cuánto dura la confirmación visible

  /* Normaliza lo oído: minúsculas, sin acentos, sin signos de
     puntuación, espacios colapsados, sin "por favor" final. */
  function normalize(text) {
    var s = String(text == null ? '' : text);
    s = s.toLowerCase();
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* sin NFD */ }
    s = s.replace(/[¿¡!?,.;:()"«»“”']/g, ' ');
    s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    s = s.replace(/\s+por favor$/, '').replace(/\s+porfa$/, '');
    return s;
  }

  /* Número en español (dígitos o palabra) -> 0-100, o null si no es
     un número. "maximo" = 100, "minimo" = 0. */
  var NUMBER_WORDS = {
    cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
    trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
    dieciocho: 18, diecinueve: 19, veinte: 20, veinticinco: 25,
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
    setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
    maximo: 100, minimo: 0
  };
  function parseSpanishNumber(str) {
    var s = normalize(str).replace(/%$/, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      return isFinite(n) ? Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, n)) : null;
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, s)) return NUMBER_WORDS[s];
    return null;
  }

  /* Volumen destino al subir/bajar: actual ± delta, con topes 0-100.
     Sin volumen actual válido se parte de 50. */
  function clampVolume(current, delta) {
    var c = (typeof current === 'number' && isFinite(current)) ? Math.round(current) : 50;
    var d = (typeof delta === 'number' && isFinite(delta)) ? delta : 0;
    return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, c + d));
  }

  /* Buscar una playlist por nombre entre una lista de nombres.
     Orden: coincidencia exacta, luego la que empieza por el texto,
     luego la que lo contiene. Todo normalizado (sin acentos,
     insensible a mayúsculas). Devuelve {name, index} o null. */
  function findPlaylist(names, query) {
    var q = normalize(query);
    if (!q || !names || !names.length) return null;
    var i, n;
    for (i = 0; i < names.length; i++) {
      if (normalize(names[i]) === q) return { name: names[i], index: i };
    }
    for (i = 0; i < names.length; i++) {
      n = normalize(names[i]);
      if (n.indexOf(q) === 0) return { name: names[i], index: i };
    }
    for (i = 0; i < names.length; i++) {
      if (normalize(names[i]).indexOf(q) !== -1) return { name: names[i], index: i };
    }
    return null;
  }

  var NEXT_EXACT = [
    'siguiente', 'la siguiente', 'pon la siguiente', 'pasa a la siguiente',
    'cambia a la siguiente', 'siguiente cancion', 'siguiente tema',
    'la siguiente cancion', 'la siguiente tema', 'pon la siguiente cancion'
  ];
  var PREV_EXACT = [
    'anterior', 'la anterior', 'pon la anterior', 'vuelve a la anterior',
    'anterior cancion', 'anterior tema', 'la anterior cancion',
    'cancion anterior', 'tema anterior', 'la de antes'
  ];
  var PAUSE_EXACT = [
    'pausa', 'pon pausa', 'ponle pausa', 'pausalo', 'pausala', 'para',
    'para la musica', 'para la cancion', 'deten la musica', 'detente',
    'haz una pausa'
  ];
  var PLAY_EXACT = [
    'reproduce', 'reproduce la musica', 'pon musica', 'pon la musica',
    'dale', 'dale play', 'ponle play', 'play', 'reanuda', 'reanudar',
    'continua', 'sigue', 'sigue sonando', 'toca musica'
  ];
  var MUTE_EXACT = [
    'silencio', 'silenciar', 'mute', 'calla', 'callate', 'sin sonido',
    'apaga el sonido', 'quita el sonido', 'quita el audio',
    'sin audio', 'apaga el audio'
  ];
  /* Prefijo normalizado + nº de palabras que ocupa en el texto oído:
     el nombre se recorta del texto ORIGINAL por palabras (no por
     longitud), para no romperlo con acentos ni puntuación. */
  var PLAYLIST_PREFIXES = [
    ['pon la lista de reproduccion ', 5], ['reproduce la lista de reproduccion ', 5],
    ['toca la lista de reproduccion ', 5],
    ['pon la playlist ', 3], ['reproduce la playlist ', 3], ['toca la playlist ', 3],
    ['pon playlist ', 2], ['reproduce playlist ', 2], ['toca playlist ', 2],
    ['pon la lista ', 3], ['reproduce la lista ', 3]
  ];
  var SEARCH_PREFIXES = [
    ['busca la cancion ', 3], ['busca el tema ', 3], ['busca ', 1], ['buscar ', 1]
  ];

  /* Recorta las primeras `words` palabras del texto oído y limpia la
     puntuación del resto: el término tal como se oyó, con sus acentos
     y mayúsculas. */
  function spokenRemainder(heard, words) {
    var parts = String(heard || '').split(/\s+/).filter(function (w) { return w; });
    return parts.slice(words).join(' ')
      .replace(/[¿¡!?,.;:()"«»“”']/g, '')
      .replace(/^\s+|\s+$/g, '');
  }

  /* El corazón del módulo: texto oído -> acción. Devuelve siempre un
     objeto {kind, ...}; kind 'unknown' si no se entendió.
     Orden: playlist, búsqueda, volumen, silencio, exactos. El orden
     importa: "reproduce la playlist X" es playlist, no "reproduce";
     "busca la playlist X" es playlist, no búsqueda. */
  function parseCommand(raw) {
    var heard = String(raw == null ? '' : raw).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var s = normalize(raw);
    if (!s) return { kind: 'unknown', heard: heard };

    var i, p, rest, m, num;

    /* --- "pon / reproduce / toca la playlist X" --- */
    for (i = 0; i < PLAYLIST_PREFIXES.length; i++) {
      p = PLAYLIST_PREFIXES[i][0];
      if (s.indexOf(p) === 0) {
        rest = s.slice(p.length).replace(/^\s+|\s+$/g, '');
        if (!rest) return { kind: 'unknown', heard: heard };
        // Nombre tal como se oyó (con acentos y mayúsculas): para la
        // confirmación; 'query' normalizado, para buscar.
        var nameRaw = spokenRemainder(heard, PLAYLIST_PREFIXES[i][1]);
        if (!nameRaw) return { kind: 'unknown', heard: heard };
        return { kind: 'playlist', name: nameRaw, query: rest };
      }
    }

    /* --- "busca X" --- */
    for (i = 0; i < SEARCH_PREFIXES.length; i++) {
      p = SEARCH_PREFIXES[i][0];
      if (s.indexOf(p) === 0) {
        rest = s.slice(p.length).replace(/^\s+|\s+$/g, '');
        if (!rest) return { kind: 'unknown', heard: heard };
        // "busca la playlist X" -> en realidad quiere la playlist.
        if (rest.indexOf('la playlist ') === 0 || rest.indexOf('playlist ') === 0) {
          var q = rest.replace(/^la playlist /, '').replace(/^playlist /, '');
          if (!q) return { kind: 'unknown', heard: heard };
          // Saltar "busca" + "la playlist" (2 palabras) o "playlist" (1).
          var skip = SEARCH_PREFIXES[i][1] + (rest.indexOf('la playlist ') === 0 ? 2 : 1);
          var pname = spokenRemainder(heard, skip);
          return { kind: 'playlist', name: pname || q, query: q };
        }
        var termRaw = spokenRemainder(heard, SEARCH_PREFIXES[i][1]);
        if (!termRaw) return { kind: 'unknown', heard: heard };
        return { kind: 'search', term: termRaw, query: rest };
      }
    }

    /* --- Volumen absoluto: "volumen al 50", "pon el volumen a 50",
           "sube el volumen a 50", "volumen 50", "volumen al maximo" --- */
    m = s.match(/^(?:pon )?(?:el )?volumen (?:a|al|en) (.+)$/) ||
        s.match(/^sube (?:el )?volumen a (.+)$/) ||
        s.match(/^baja (?:el )?volumen a (.+)$/);
    if (m) {
      num = parseSpanishNumber(m[1]);
      if (num != null) return { kind: 'volumeSet', value: num };
      if (normalize(m[1]) === 'alto') return { kind: 'volumeUp', delta: VOLUME_STEP };
      if (normalize(m[1]) === 'bajo') return { kind: 'volumeDown', delta: VOLUME_STEP };
      return { kind: 'unknown', heard: heard };
    }
    m = s.match(/^(?:pon )?(?:el )?volumen (.+)$/);
    if (m) {
      num = parseSpanishNumber(m[1]);
      if (num != null) return { kind: 'volumeSet', value: num };
      if (normalize(m[1]) === 'alto') return { kind: 'volumeUp', delta: VOLUME_STEP };
      if (normalize(m[1]) === 'bajo') return { kind: 'volumeDown', delta: VOLUME_STEP };
      return { kind: 'unknown', heard: heard };
    }

    /* --- Subir volumen: "sube el volumen", "subele", "mas volumen",
           "sube un poco/mucho el volumen", "sube el volumen 20" --- */
    m = s.match(/^sube (un poco|mucho) (?:el )?volumen$/);
    if (m) return { kind: 'volumeUp', delta: m[1] === 'mucho' ? VOLUME_STEP_BIG : VOLUME_STEP_SMALL };
    m = s.match(/^(?:sube|subele|aumenta)(?:le)? (?:(?:el|al) )?volumen(?: (.+))?$/);
    if (m) {
      if (m[1]) {
        num = parseSpanishNumber(m[1]);
        if (num == null) return { kind: 'unknown', heard: heard };
        return { kind: 'volumeUp', delta: num };
      }
      return { kind: 'volumeUp', delta: VOLUME_STEP };
    }
    if (s === 'mas volumen' || s === 'mas alto' || s === 'sube el volumen') {
      return { kind: 'volumeUp', delta: VOLUME_STEP };
    }

    /* --- Bajar volumen: espejo de subir --- */
    m = s.match(/^baja (un poco|mucho) (?:el )?volumen$/);
    if (m) return { kind: 'volumeDown', delta: m[1] === 'mucho' ? VOLUME_STEP_BIG : VOLUME_STEP_SMALL };
    m = s.match(/^(?:baja|bajale|disminuye)(?:le)? (?:(?:el|al) )?volumen(?: (.+))?$/);
    if (m) {
      if (m[1]) {
        num = parseSpanishNumber(m[1]);
        if (num == null) return { kind: 'unknown', heard: heard };
        return { kind: 'volumeDown', delta: num };
      }
      return { kind: 'volumeDown', delta: VOLUME_STEP };
    }
    if (s === 'menos volumen' || s === 'mas bajo' || s === 'baja el volumen') {
      return { kind: 'volumeDown', delta: VOLUME_STEP };
    }

    /* --- Exactos: silencio, siguiente, anterior, pausa, reproduce --- */
    if (MUTE_EXACT.indexOf(s) !== -1) return { kind: 'mute' };
    if (NEXT_EXACT.indexOf(s) !== -1) return { kind: 'next' };
    if (PREV_EXACT.indexOf(s) !== -1) return { kind: 'prev' };
    if (PAUSE_EXACT.indexOf(s) !== -1) return { kind: 'pause' };
    if (PLAY_EXACT.indexOf(s) !== -1) return { kind: 'play' };

    return { kind: 'unknown', heard: heard };
  }

  /* Texto de confirmación para una acción ("Entendí: siguiente").
     Para playlist/búsqueda incluye el término tal como se oyó. */
  function confirmationText(action) {
    if (!action) return null;
    switch (action.kind) {
      case 'next': return 'Entendí: siguiente';
      case 'prev': return 'Entendí: anterior';
      case 'pause': return 'Entendí: pausa';
      case 'play': return 'Entendí: reproduce';
      case 'mute': return 'Entendí: silencio';
      case 'volumeUp': return 'Entendí: subir el volumen';
      case 'volumeDown': return 'Entendí: bajar el volumen';
      case 'volumeSet': return 'Entendí: volumen al ' + action.value + '%';
      case 'playlist': return 'Entendí: playlist «' + action.name + '»';
      case 'search': return 'Entendí: buscar «' + action.term + '»';
      default: return null;
    }
  }
  function notUnderstoodText() {
    return 'No te entendí. Prueba con "siguiente", "pausa" o "busca Queen".';
  }

  /* ================= Parte DOM (solo navegador) ================= */

  var IDS = { btn: 'rpmVozBtn', status: 'rpmVozStatus' };

  function $(id) { return document.getElementById(id); }
  function clickBtn(id) {
    var b = $(id);
    if (!b || b.disabled) return false;
    try { b.click(); return true; } catch (e) { return false; }
  }
  function clickTab(view) {
    try {
      var tab = document.querySelector('#viewTabs [data-view="' + view + '"]');
      if (!tab) return false;
      tab.click();
      return true;
    } catch (e) { return false; }
  }
  function dispatchInput(el) {
    try {
      var ev;
      if (typeof Event === 'function') ev = new Event('input', { bubbles: true });
      else { ev = document.createEvent('Event'); ev.initEvent('input', true, true); }
      el.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }

  var statusEl = null;
  var micBtn = null;
  var recognition = null;
  var listening = false;
  var silenceTimer = null;
  var hideTimer = null;
  var gotResult = false;

  function showStatus(msg, kind, sticky) {
    if (!statusEl) return;
    try {
      statusEl.textContent = msg;
      statusEl.className = 'rpm-voz-status show' + (kind ? ' ' + kind : '');
      clearTimeout(hideTimer);
      if (!sticky) {
        hideTimer = setTimeout(function () {
          if (statusEl) statusEl.classList.remove('show');
        }, kind === 'error' ? STATUS_MS + 1500 : STATUS_MS);
      }
    } catch (e) { /* noop */ }
  }

  function setListeningUI(on) {
    listening = !!on;
    if (micBtn) {
      micBtn.classList.toggle('listening', listening);
      micBtn.setAttribute('aria-pressed', listening ? 'true' : 'false');
      micBtn.setAttribute('aria-label', listening ? 'Escuchando… pulsa para apagar el micrófono' : 'Control por voz: pulsa y habla');
      micBtn.textContent = listening ? '🔴' : '🎙️';
    }
  }

  function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }
  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(function () {
      // Sin hablar en 8 s: apagar el micrófono sin ejecutar nada.
      if (listening) {
        showStatus('No escuché nada. Pulsa el micrófono e inténtalo de nuevo.', 'error');
        stopListening();
      }
    }, SILENCE_TIMEOUT_MS);
  }

  function getVolume() {
    var v = $('volume');
    if (!v) return null;
    var n = parseInt(v.value, 10);
    return isFinite(n) ? n : null;
  }
  function setVolume(v) {
    var el = $('volume');
    if (!el) return false;
    try {
      el.value = String(Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(v))));
      dispatchInput(el);
      return true;
    } catch (e) { return false; }
  }

  /* Nombres de playlist desde los chips de #plBar ("📌 nombre (n)").
     renderPlaylists() los regenera en cada renderPack, así que la
     lista está al día sin leer el estado interno de la app. */
  function readPlaylistChips() {
    var out = [];
    try {
      var bar = $('plBar');
      if (!bar) return out;
      var chips = bar.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) {
        var t = String(chips[i].textContent || '')
          .replace(/\s*\(\d+\)\s*$/, '')   // el contador "(n)"
          .replace(/^\s*📌\s*/, '')        // la chincheta de fijada
          .replace(/^\s+|\s+$/g, '');
        if (t && t !== '+ Nueva playlist') out.push({ name: t, el: chips[i] });
      }
    } catch (e) { /* noop */ }
    return out;
  }

  function playPlaylistByName(spokenName) {
    var chips = readPlaylistChips();
    if (!chips.length) return null;
    var names = chips.map(function (c) { return c.name; });
    var match = findPlaylist(names, spokenName);
    if (!match) return null;
    // Cambiar a la vista Playlists (regenera los chips) y pulsar el
    // chip de la playlist; luego #btnPlPlay reproduce desde el inicio.
    clickTab('playlists');
    var fresh = readPlaylistChips();
    var target = null;
    for (var i = 0; i < fresh.length; i++) {
      if (normalize(fresh[i].name) === normalize(match.name)) { target = fresh[i].el; break; }
    }
    if (!target) return null;
    try { target.click(); } catch (e) { return null; }
    if (!clickBtn('btnPlPlay')) return null;
    return match.name;
  }

  function doSearch(term) {
    var s = $('search');
    if (!s) return false;
    clickTab('library'); // la caja de búsqueda solo vive en Biblioteca
    try {
      s.value = term;
      dispatchInput(s);
      return true;
    } catch (e) { return false; }
  }

  /* Ejecuta una acción ya parseada. Devuelve el mensaje a mostrar. */
  function execute(action) {
    if (!action || action.kind === 'unknown') return notUnderstoodText();
    var audio = $('audio');
    var cur, target;
    switch (action.kind) {
      case 'next':
        return clickBtn('btnNext') ? confirmationText(action)
          : 'No puedo pasar a la siguiente ahora mismo.';
      case 'prev':
        return clickBtn('btnPrev') ? confirmationText(action)
          : 'No puedo volver a la anterior ahora mismo.';
      case 'pause':
        if (audio && audio.paused) return 'Ya está en pausa.';
        return clickBtn('btnPlay') ? confirmationText(action)
          : 'No hay nada sonando para pausar.';
      case 'play':
        if (audio && !audio.paused) return 'Ya está sonando.';
        return clickBtn('btnPlay') ? confirmationText(action)
          : 'No hay ninguna canción para reproducir.';
      case 'volumeUp':
        cur = getVolume();
        if (cur == null) return 'No puedo leer el volumen ahora mismo.';
        target = clampVolume(cur, action.delta);
        if (target === cur) return 'El volumen ya está al máximo.';
        setVolume(target);
        return 'Entendí: subir el volumen al ' + target + '%';
      case 'volumeDown':
        cur = getVolume();
        if (cur == null) return 'No puedo leer el volumen ahora mismo.';
        target = clampVolume(cur, -action.delta);
        if (target === cur) return 'El volumen ya está al mínimo.';
        setVolume(target);
        return 'Entendí: bajar el volumen al ' + target + '%';
      case 'volumeSet':
        if (getVolume() == null) return 'No puedo leer el volumen ahora mismo.';
        setVolume(action.value);
        return confirmationText(action);
      case 'mute':
        cur = getVolume();
        if (cur == null) return 'No puedo leer el volumen ahora mismo.';
        if (cur === 0) return 'Ya está en silencio.';
        return clickBtn('btnMute') ? confirmationText(action)
          : 'No puedo silenciar ahora mismo.';
      case 'playlist': {
        var name = playPlaylistByName(action.name);
        return name ? 'Entendí: playlist «' + name + '»'
          : 'No encontré la playlist «' + action.name + '».';
      }
      case 'search':
        return doSearch(action.term) ? confirmationText(action)
          : 'No puedo buscar ahora mismo.';
      default:
        return notUnderstoodText();
    }
  }

  function speechRecognitionCtor() {
    try {
      if (typeof window === 'undefined') return null;
      return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    } catch (e) { return null; }
  }
  function isSupported() {
    return !!speechRecognitionCtor();
  }

  function stopListening() {
    clearSilenceTimer();
    var rec = recognition;
    recognition = null;
    if (rec) {
      try { rec.stop(); } catch (e) { /* ya parado */ }
    }
    // onend también llama a setListeningUI(false); por si no llega:
    setListeningUI(false);
  }

  function startListening() {
    if (listening) { stopListening(); return; } // segundo toque: apagar
    var SR = speechRecognitionCtor();
    if (!SR) {
      showStatus('Tu navegador no soporta voz', 'error');
      return;
    }
    var rec;
    try {
      rec = new SR();
    } catch (e) {
      showStatus('Tu navegador no soporta voz', 'error');
      return;
    }
    recognition = rec;
    gotResult = false;
    try {
      rec.lang = 'es-MX';
      rec.continuous = false;     // un solo comando por pulsación
      rec.interimResults = false; // solo el resultado final
      rec.maxAlternatives = 1;
    } catch (e) { /* valores por defecto */ }
    rec.onstart = function () {
      setListeningUI(true);
      showStatus('Escuchando… di un comando', 'listening', true);
      armSilenceTimer();
    };
    rec.onspeechstart = function () { armSilenceTimer(); };
    rec.onresult = function (ev) {
      try {
        gotResult = true;
        clearSilenceTimer();
        var res = ev.results && ev.results[0] && ev.results[0][0];
        var transcript = res ? String(res.transcript || '') : '';
        var action = parseCommand(transcript);
        var msg = execute(action);
        showStatus(msg, action.kind === 'unknown' ? 'error' : 'ok');
      } catch (e) {
        showStatus('No pude procesar ese comando.', 'error');
      }
    };
    rec.onerror = function (ev) {
      clearSilenceTimer();
      var code = ev && ev.error ? String(ev.error) : '';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        showStatus('Permiso de micrófono denegado. Actívalo en el navegador e inténtalo de nuevo.', 'error');
      } else if (code === 'no-speech') {
        showStatus('No escuché nada. Pulsa el micrófono e inténtalo de nuevo.', 'error');
      } else if (code === 'audio-capture') {
        showStatus('No se pudo acceder al micrófono.', 'error');
      } else if (code === 'network') {
        showStatus('El reconocimiento de voz necesita conexión. Inténtalo de nuevo.', 'error');
      } else if (code === 'aborted') {
        /* apagado por el usuario o por el temporizador: sin mensaje */
      } else {
        showStatus('El reconocimiento de voz falló. Inténtalo de nuevo.', 'error');
      }
    };
    rec.onend = function () {
      // Sin reinicio automático: una pulsación = una escucha. El
      // usuario vuelve a pulsar si quiere otro comando.
      clearSilenceTimer();
      recognition = null;
      setListeningUI(false);
      if (!gotResult) {
        // Si onstart/onresult no mostraron nada, no dejar la píldora
        // de "Escuchando…" colgada: se oculta sola por su temporizador.
      }
    };
    try {
      rec.start();
    } catch (e) {
      recognition = null;
      setListeningUI(false);
      showStatus('No pude iniciar el micrófono.', 'error');
    }
  }

  function buildMicButton() {
    if ($(IDS.btn)) return $(IDS.btn);
    var b = document.createElement('button');
    b.id = IDS.btn;
    b.type = 'button';
    b.className = 'rpm-voz-btn';
    b.textContent = '🎙️';
    b.title = 'Control por voz: pulsa y habla';
    b.setAttribute('aria-label', 'Control por voz: pulsa y habla');
    b.setAttribute('aria-pressed', 'false');
    // Ancla: justo después de #btnMute, en la fila de volumen del
    // reproductor. Fallbacks: la fila secundaria, los controles,
    // junto al buscador, y por último el body.
    var mute = $('btnMute');
    if (mute && mute.parentNode) {
      mute.parentNode.insertBefore(b, mute.nextSibling);
    } else {
      var row = document.querySelector('.secondary-row') ||
        document.querySelector('.controls');
      if (row) row.appendChild(b);
      else {
        var search = $('search');
        if (search && search.parentNode) search.parentNode.appendChild(b);
        else document.body.appendChild(b);
      }
    }
    if (!isSupported()) {
      b.classList.add('rpm-voz-unsupported');
      b.title = 'Tu navegador no soporta voz';
      b.setAttribute('aria-label', 'Control por voz: tu navegador no soporta voz');
    }
    return b;
  }

  function buildStatus() {
    if ($(IDS.status)) return $(IDS.status);
    var el = document.createElement('div');
    el.id = IDS.status;
    el.className = 'rpm-voz-status';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./voz.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './voz.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el botón sigue funcionando */ }
  }

  function init() {
    try {
      ensureCss();
      micBtn = buildMicButton();
      statusEl = buildStatus();
      micBtn.addEventListener('click', function () {
        try { startListening(); } catch (e) { /* el micrófono nunca rompe la app */ }
      });
    } catch (e) { /* fail-safe: voz desactivada, app intacta */ }
  }

  var api = {
    normalize: normalize,
    parseSpanishNumber: parseSpanishNumber,
    parseCommand: parseCommand,
    findPlaylist: findPlaylist,
    clampVolume: clampVolume,
    confirmationText: confirmationText,
    notUnderstoodText: notUnderstoodText,
    VOLUME_STEP: VOLUME_STEP,
    VOLUME_STEP_SMALL: VOLUME_STEP_SMALL,
    VOLUME_STEP_BIG: VOLUME_STEP_BIG,
    SILENCE_TIMEOUT_MS: SILENCE_TIMEOUT_MS,
    STATUS_MS: STATUS_MS
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    global.__rpmVoz = api;
    global.__rpmVozParse = parseCommand;
    global.__rpmVozListen = startListening;
    global.__rpmVozStop = stopListening;
    global.__rpmVozState = function () {
      return { supported: isSupported(), listening: listening };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
