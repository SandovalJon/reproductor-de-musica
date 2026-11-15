/* Escucha conjunta sincronizada — Reproductor de Música v3.9.0 (módulo aparte).
 *
 * Dos personas escuchan la misma canción al mismo tiempo, cada una en su
 * dispositivo. SIN servidor propio ni cuentas: WebRTC con señalización
 * manual por texto copiable (el anfitrión genera una oferta, el invitado
 * pega la oferta y genera una respuesta, el anfitrión pega la respuesta).
 * Un DataChannel sincroniza play/pausa, cambio de canción y posición,
 * con corrección de desfase por ping.
 *
 * REGLA HONESTA (visible en la UI, no se finge nada): los audios NO
 * viajan. Cada lado reproduce SU copia local de la canción, identificada
 * por audioHash. Si el otro lado no tiene esa canción en su biblioteca,
 * se muestra "te falta esta canción" y no se finge que suena.
 *
 * SIN QR: una oferta/respuesta SDP mide típicamente 800-2000 caracteres
 * y el encoder QR propio de compartir.js admite como máximo 106 bytes
 * (versión 5-L). Copiarlo a un QR no es viable; el intercambio es solo
 * texto copiable. No se ha copiado el encoder QR para algo que no cabe.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico, como
 * lyrics.js / karaoke.js / notas.js. Solo usa lo que la app ya expone:
 *   - window.__rpmApp.getTracks() / trackKey() / toast() / render()
 *   - Controles reales por DOM: #audio, #btnPlay, #btnNext, #btnPrev
 *   - Cambio de canción remoto: clic en la fila de la biblioteca
 *     [data-track-id="<id>"] (la app ya hace selectTrack(id, true) al
 *     pulsar una fila; ver index.html ~l. 3838). Si la fila no está
 *     visible en la lista (filtro/búsqueda), se avisa y no se finge.
 * Si WebRTC no existe en el navegador, el modal lo dice y no falla.
 * Si el módulo falla al cargar, la app sigue funcionando: todo el
 * init va en try/catch y el sondeo también.
 *
 * Estructura: núcleo puro (sin DOM, probable en Node, exportado por
 * module.exports) + pegamento de navegador (WebRTC, modal, audio).
 * Pruebas Node: node --test conjunta.test.mjs
 * Consola: window.__conjunta (estado, abrir/cerrar, enviar estado)
 *
 * Protocolo del DataChannel (JSON, un mensaje por línea de texto):
 *   hello {from, role} | state {hash,title,artist,playing,pos,ts}
 *   play {hash,pos,ts} | pause {hash,pos,ts} | seek {hash,pos,ts}
 *   track {hash,title,artist,pos,ts} | ping {t0} | pong {t0,t1}
 *   missing {hash,title,artist} | bye {}
 * Todos llevan v:1, from:<deviceId>, seq:<n>. El líder es el anfitrión.
 * El seguidor solo obedece al líder; el líder ignora órdenes del
 * seguidor (salvo ping/pong y missing). Así no hay peleas de play/pausa.
 */
(function (global) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var PROTOCOL_VERSION = 1;
  var SIGNAL_PREFIX = 'RPM9-';          // prefijo del código copiable
  var SEEK_THRESHOLD_S = 0.75;          // desfase a partir del cual se corrige
  var MAX_SIGNAL_CHARS = 20000;         // anti-abuso al pegar un código
  var PING_INTERVAL_MS = 5000;
  var STATE_INTERVAL_MS = 2000;

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function normHash(h) {
    return String(h == null ? '' : h).trim().toLowerCase();
  }

  /* ---------- base64url (sin btoa/Buffer: navegador y Node) ----------
     Misma idea que compartir.js: implementación propia, UTF-8 manual. */
  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_REV = null;
  function b64Rev() {
    if (B64_REV) return B64_REV;
    B64_REV = {};
    for (var i = 0; i < 64; i++) B64_REV[B64_ALPHABET[i]] = i;
    return B64_REV;
  }
  function utf8Encode(str) {
    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
               str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
        var cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return bytes;
  }
  function utf8Decode(bytes) {
    var out = '', i = 0, c, c2, c3;
    while (i < bytes.length) {
      c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xC0 && c < 0xE0 && i < bytes.length) {
        c2 = bytes[i++]; out += String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F));
      } else if (c >= 0xE0 && c < 0xF0 && i + 1 < bytes.length) {
        c2 = bytes[i++]; c3 = bytes[i++];
        out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
      } else if (c >= 0xF0 && i + 2 < bytes.length) {
        c2 = bytes[i++]; c3 = bytes[i++]; var c4 = bytes[i++];
        var cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else out += '\uFFFD';
    }
    return out;
  }
  function base64urlEncode(bytes) {
    var out = '', i, n;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] +
             B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      n = bytes[i] << 16;
      out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
    } else if (rem === 2) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] +
             B64_ALPHABET[(n >> 6) & 63];
    }
    return out;
  }
  function base64urlDecode(str) {
    var rev = b64Rev(), bytes = [], i, n, c;
    var clean = String(str || '').replace(/[^A-Za-z0-9\-_]/g, '');
    if (clean.length === 0) return String(str || '').length === 0 ? [] : null;
    for (i = 0; i + 3 < clean.length; i += 4) {
      n = (rev[clean[i]] << 18) | (rev[clean[i + 1]] << 12) |
          (rev[clean[i + 2]] << 6) | rev[clean[i + 3]];
      bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    var rem = clean.length - i;
    if (rem === 2) {
      n = (rev[clean[i]] << 18) | (rev[clean[i + 1]] << 12);
      bytes.push((n >> 16) & 255);
    } else if (rem === 3) {
      // 3 caracteres = 18 bits: (byte0 << 10) | (byte1 << 2), 2 bits de relleno.
      n = (rev[clean[i]] << 12) | (rev[clean[i + 1]] << 6) | rev[clean[i + 2]];
      bytes.push((n >> 10) & 255, (n >> 2) & 255);
    } else if (rem === 1) return null; // base64url válido nunca deja 1 resto
    for (i = 0; i < clean.length; i++) {
      c = clean[i];
      if (c !== '-' && c !== '_' && !(c in rev)) return null;
    }
    return bytes;
  }

  /* ---------- Señalización manual (oferta / respuesta) ---------- */
  function encodeSignal(obj) {
    if (!obj || typeof obj !== 'object') return null;
    try {
      var payload = { v: PROTOCOL_VERSION, kind: obj.kind, sdp: obj.sdp, from: obj.from || '' };
      return SIGNAL_PREFIX + base64urlEncode(utf8Encode(JSON.stringify(payload)));
    } catch (e) { return null; }
  }
  function decodeSignal(str) {
    // Devuelve {v, kind, sdp, from} o null si no es un código válido.
    if (typeof str !== 'string') return null;
    var s = str.trim();
    if (s.length === 0 || s.length > MAX_SIGNAL_CHARS) return null;
    if (s.indexOf(SIGNAL_PREFIX) !== 0) return null;
    var bytes = base64urlDecode(s.slice(SIGNAL_PREFIX.length));
    if (!bytes) return null;
    var obj;
    try { obj = JSON.parse(utf8Decode(bytes)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== PROTOCOL_VERSION) return null;
    if (obj.kind !== 'offer' && obj.kind !== 'answer') return null;
    if (!obj.sdp || typeof obj.sdp !== 'object') return null;
    if (obj.sdp.type !== 'offer' && obj.sdp.type !== 'answer') return null;
    if (typeof obj.sdp.sdp !== 'string' || obj.sdp.sdp.length === 0) return null;
    if (obj.kind === 'offer' && obj.sdp.type !== 'offer') return null;
    if (obj.kind === 'answer' && obj.sdp.type !== 'answer') return null;
    return { v: obj.v, kind: obj.kind, sdp: { type: obj.sdp.type, sdp: obj.sdp.sdp }, from: String(obj.from || '') };
  }
  function isOfferCode(str) { var d = decodeSignal(str); return !!d && d.kind === 'offer'; }
  function isAnswerCode(str) { var d = decodeSignal(str); return !!d && d.kind === 'answer'; }

  /* ---------- Líder ---------- */
  // El anfitrión (quien crea la oferta) es el líder: solo él manda
  // play/pausa/cambio de canción; el invitado solo obedece.
  function isLeader(role) { return role === 'host'; }
  // Desempate determinista por id de dispositivo (por si en el futuro
  // hay reconexión sin roles): gana el id menor, igual en ambos lados.
  function electLeaderById(myId, peerId) {
    var a = String(myId || ''), b = String(peerId || '');
    if (!a || !b) return null;
    if (a === b) return null;
    return a < b ? 'me' : 'peer';
  }

  /* ---------- Desfase por ping (NTP simplificado) ----------
     ping: A envía {t0}; B responde pong {t0, t1=hora de B al recibir};
     A recibe a t3. rtt = t3 - t0; offset = t1 - (t0 + rtt/2).
     offset > 0 significa que el reloj de B va por delante del de A. */
  function computeOffset(t0, tRemote, t3) {
    t0 = Number(t0); tRemote = Number(tRemote); t3 = Number(t3);
    if (!isFinite(t0) || !isFinite(tRemote) || !isFinite(t3)) return null;
    var rtt = t3 - t0;
    if (rtt < 0) return null;
    return { offsetMs: tRemote - (t0 + rtt / 2), rttMs: rtt };
  }
  // De varias muestras se queda la de menor RTT (la menos contaminada
  // por la red). Devuelve null sin muestras válidas.
  function bestOffset(samples) {
    var best = null;
    (samples || []).forEach(function (s) {
      if (!s) return;
      var o = computeOffset(s.t0, s.tRemote, s.t3);
      if (!o) return;
      if (!best || o.rttMs < best.rttMs) best = o;
    });
    return best;
  }
  // Posición remota proyectada a "ahora" local: el remoto estaba en
  // pos en su instante ts; han pasado (nowLocal - (ts + offset)) ms.
  function projectRemotePos(pos, remoteTs, offsetMs, nowLocalMs) {
    var p = Number(pos), ts = Number(remoteTs), off = Number(offsetMs || 0), now = Number(nowLocalMs);
    if (!isFinite(p) || !isFinite(ts) || !isFinite(now)) return null;
    var elapsed = (now - (ts + off)) / 1000;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > 3600) return null; // estado demasiado viejo: no fiarse
    return p + elapsed;
  }

  /* ---------- Coincidencia de pistas por audioHash ---------- */
  // Misma regla que compartir.js (markShared): hash igual manda; si
  // alguna de las dos no tiene hash, título+artista+duración redondeada;
  // si ambas tienen hash y difieren, NO coincide aunque coincida el título.
  function tracksMatch(a, b) {
    if (!a || !b) return false;
    var ha = normHash(a.audioHash), hb = normHash(b.audioHash);
    if (ha && hb) return ha === hb;
    if (ha || hb) {
      // Una tiene hash y la otra no: solo metadatos, y se marca como
      // coincidencia débil (el llamador decide si fiarse).
      return normText(a.title) === normText(b.title) &&
             normText(a.artist) === normText(b.artist) &&
             Math.round(Number(a.duration) || 0) === Math.round(Number(b.duration) || 0);
    }
    return normText(a.title) === normText(b.title) &&
           normText(a.artist) === normText(b.artist) &&
           Math.round(Number(a.duration) || 0) === Math.round(Number(b.duration) || 0);
  }
  // ¿La coincidencia es por hash (fuerte) o solo por metadatos (débil)?
  function matchStrength(a, b) {
    if (!tracksMatch(a, b)) return 'none';
    if (normHash(a.audioHash) && normHash(b.audioHash)) return 'hash';
    return 'meta';
  }
  function findLocalTrack(tracks, wanted) {
    if (!wanted) return null;
    var list = tracks || [], i, best = null;
    for (i = 0; i < list.length; i++) {
      if (matchStrength(list[i], wanted) === 'hash') return list[i];
      if (!best && tracksMatch(list[i], wanted)) best = list[i];
    }
    return best; // null si no está, o la débil si solo hay esa
  }

  /* ---------- Mensajes del canal ---------- */
  var MESSAGE_TYPES = ['hello', 'state', 'play', 'pause', 'seek', 'track', 'ping', 'pong', 'missing', 'bye'];
  function createMessage(type, fields, from, seq) {
    if (MESSAGE_TYPES.indexOf(type) === -1) return null;
    var msg = { v: PROTOCOL_VERSION, t: type, from: String(from || ''), seq: Number(seq) || 0, ts: Date.now() };
    var f = fields || {}, k;
    for (k in f) if (Object.prototype.hasOwnProperty.call(f, k)) msg[k] = f[k];
    return msg;
  }
  function validateMessage(raw) {
    // Devuelve el mensaje normalizado o null. No confía en el otro lado.
    var msg = raw;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return null; } }
    if (!msg || typeof msg !== 'object') return null;
    if (msg.v !== PROTOCOL_VERSION) return null;
    if (MESSAGE_TYPES.indexOf(msg.t) === -1) return null;
    if (typeof msg.from !== 'string') return null;
    if (typeof msg.ts !== 'number' || !isFinite(msg.ts)) return null;
    var numFields = ['pos', 't0', 't1'];
    for (var i = 0; i < numFields.length; i++) {
      var k = numFields[i];
      if (msg[k] !== undefined && (typeof msg[k] !== 'number' || !isFinite(msg[k]))) return null;
    }
    if (msg.pos !== undefined && msg.pos < 0) return null;
    if ((msg.t === 'track' || msg.t === 'state' || msg.t === 'play' || msg.t === 'pause' || msg.t === 'seek') &&
        msg.hash !== undefined && typeof msg.hash !== 'string') return null;
    return msg;
  }

  /* ---------- Decisión del seguidor ante un mensaje del líder ----------
     Pura: no toca el audio. Devuelve {action, ...}:
       'none'    nada que hacer (mismo estado)
       'play'    {pos}  reproducir (con salto a pos si viene)
       'pause'   {pos}  pausar (con salto a pos si viene)
       'seek'    {pos}  solo corregir la posición
       'track'   {track} cambiar a esa canción y reproducir si playing
       'missing' {track} el otro lado pide una canción que aquí no está
     local: {hash, title, artist, playing, pos}; hasLocal: bool. */
  function decideRemoteAction(msg, local, hasLocal, offsetMs) {
    if (!msg || !local) return { action: 'none' };
    var now = Date.now();
    function projectedPos() {
      var p = projectRemotePos(msg.pos, msg.ts, offsetMs || 0, now);
      return (p == null) ? (typeof msg.pos === 'number' ? msg.pos : local.pos) : p;
    }
    if (msg.t === 'track' || (msg.t === 'state' && msg.hash !== undefined &&
        normHash(msg.hash) !== normHash(local.hash) &&
        !(normHash(msg.hash) === '' && normText(msg.title) === normText(local.title)))) {
      if (!hasLocal) return { action: 'missing', track: { hash: msg.hash || '', title: msg.title || '', artist: msg.artist || '' } };
      return { action: 'track', track: { hash: msg.hash || '', title: msg.title || '', artist: msg.artist || '' },
               playing: msg.playing !== false, pos: projectedPos() };
    }
    if (msg.t === 'play') {
      var pp = projectedPos();
      if (!local.playing) return { action: 'play', pos: pp };
      return decideSeek(local.pos, pp);
    }
    if (msg.t === 'pause') {
      var pa = projectedPos();
      if (local.playing) return { action: 'pause', pos: pa };
      return decideSeek(local.pos, pa);
    }
    if (msg.t === 'seek') return decideSeek(local.pos, projectedPos());
    if (msg.t === 'state') {
      if (msg.playing === true && !local.playing) return { action: 'play', pos: projectedPos() };
      if (msg.playing === false && local.playing) return { action: 'pause', pos: projectedPos() };
      return decideSeek(local.pos, projectedPos());
    }
    return { action: 'none' };
  }
  // ¿Hace falta corregir la posición? Solo si el desfase supera el umbral.
  function decideSeek(localPos, remotePos, thresholdS) {
    var th = (typeof thresholdS === 'number') ? thresholdS : SEEK_THRESHOLD_S;
    var l = Number(localPos) || 0, r = Number(remotePos);
    if (!isFinite(r) || r < 0) return { action: 'none' };
    if (Math.abs(r - l) > th) return { action: 'seek', pos: Math.max(0, r) };
    return { action: 'none' };
  }

  /* ================= Pegamento con el navegador ================= */

  var state = {
    role: null,            // 'host' | 'guest' | null
    pc: null, channel: null,
    connected: false, supported: null,
    myId: '', peerId: '', seq: 0,
    offsetMs: 0, rttMs: null, pingSamples: [],
    applyingRemote: false, applyingUntil: 0,
    lastTrackKey: '', lastPlaying: null, lastBroadcast: 0,
    missingTrack: null,    // {title, artist} que aquí falta (para la UI)
    peerMissing: null,     // lo que al otro lado le falta
    lastState: null,
    timers: []
  };

  function $(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
  function app() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; } catch (e) { return null; }
  }
  function toast(msg) {
    try {
      var a = app();
      if (a && typeof a.toast === 'function') { a.toast(msg); return; }
    } catch (e) {}
    try { var t = $('conjuntaToast'); if (t) { t.textContent = msg; t.hidden = false; } } catch (e) {}
  }
  function deviceId() {
    if (state.myId) return state.myId;
    var id = '';
    try {
      id = localStorage.getItem('reproductor-conjunta-id') || '';
      if (!id) {
        id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('reproductor-conjunta-id', id);
      }
    } catch (e) { id = 'd' + Math.random().toString(36).slice(2, 10); }
    state.myId = id;
    return id;
  }
  function audioEl() { return $('audio'); }
  function nowText() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return { title: String(t || '').trim(), artist: String(a || '').trim() };
  }
  function currentTrack() {
    var a = app(); if (!a || typeof a.getTracks !== 'function') return null;
    var cur = nowText(), list = a.getTracks() || [], i;
    for (i = 0; i < list.length; i++) {
      if (normText(list[i].title) === normText(cur.title) &&
          normText(list[i].artist) === normText(cur.artist)) return list[i];
    }
    return null;
  }
  function localState() {
    var audio = audioEl(), t = currentTrack();
    return {
      hash: t ? normHash(t.audioHash) : '',
      title: t ? (t.title || '') : nowText().title,
      artist: t ? (t.artist || '') : nowText().artist,
      playing: !!(audio && !audio.paused && !audio.ended),
      pos: audio ? (audio.currentTime || 0) : 0,
      duration: audio ? (audio.duration || 0) : 0
    };
  }
  function trackKeyOf(t) {
    if (!t) return '';
    var a = app();
    if (a && typeof a.trackKey === 'function') { try { return String(a.trackKey(t) || ''); } catch (e) {} }
    return normHash(t.audioHash) || (normText(t.title) + '|' + normText(t.artist));
  }

  /* ---------- Envío ---------- */
  function send(type, fields) {
    if (!state.channel || state.channel.readyState !== 'open') return false;
    var msg = createMessage(type, fields || {}, deviceId(), ++state.seq);
    if (!msg) return false;
    try { state.channel.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }
  function broadcastState(force) {
    if (!state.connected || !isLeader(state.role)) return;
    var now = Date.now();
    if (!force && now - state.lastBroadcast < 1500) return;
    state.lastBroadcast = now;
    var s = localState();
    state.lastState = s;
    send('state', { hash: s.hash, title: s.title, artist: s.artist, playing: s.playing, pos: s.pos });
  }

  /* ---------- Aplicar lo que manda el líder (seguidor) ---------- */
  function applyRemote(msg) {
    var local = localState();
    var wanted = { hash: msg.hash || '', title: msg.title || '', artist: msg.artist || '',
                   duration: 0 };
    var hasLocal = false, localTrack = null;
    if (msg.t === 'track' || msg.t === 'state' || msg.t === 'play' || msg.t === 'pause' || msg.t === 'seek') {
      var a = app();
      if (a && typeof a.getTracks === 'function') {
        localTrack = findLocalTrack(a.getTracks() || [], wanted);
        hasLocal = !!localTrack;
        if (localTrack) wanted.duration = localTrack.duration || 0;
      } else hasLocal = true; // sin biblioteca visible: no afirmar que falta
    }
    var decision = decideRemoteAction(msg, local, hasLocal, state.offsetMs);
    state.missingTrack = (decision.action === 'missing') ? decision.track : null;
    if (decision.action === 'missing') {
      send('missing', { hash: wanted.hash, title: wanted.title, artist: wanted.artist });
      refreshUI();
      toast('Te falta esta canción: "' + wanted.title + '" — añádela a tu biblioteca para escucharla juntos.');
      return;
    }
    if (decision.action === 'track') {
      if (!localTrack) { state.missingTrack = decision.track; refreshUI(); return; }
      state.missingTrack = null;
      state.applyingRemote = true; state.applyingUntil = Date.now() + 1500;
      var row = null;
      try { row = document.querySelector('[data-track-id="' + String(localTrack.id).replace(/"/g, '') + '"]'); } catch (e) {}
      if (row) {
        row.click(); // la app hace selectTrack(id, true)
        setTimeout(function () {
          var audio = audioEl();
          if (audio && typeof decision.pos === 'number') {
            try { audio.currentTime = Math.max(0, decision.pos); } catch (e) {}
          }
          if (decision.playing === false && audio && !audio.paused) { try { audio.pause(); } catch (e) {} }
          state.applyingRemote = false;
        }, 600);
      } else {
        state.applyingRemote = false;
        toast('Tienes "' + (localTrack.title || '') + '" en tu biblioteca, pero su fila no está visible en la lista: búscala y dale a play.');
      }
      refreshUI();
      return;
    }
    var audio = audioEl(); if (!audio) return;
    state.applyingRemote = true; state.applyingUntil = Date.now() + 1200;
    try {
      if (decision.action === 'play') {
        if (typeof decision.pos === 'number' && Math.abs(decision.pos - (audio.currentTime || 0)) > SEEK_THRESHOLD_S)
          audio.currentTime = Math.max(0, decision.pos);
        if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
      } else if (decision.action === 'pause') {
        if (typeof decision.pos === 'number' && Math.abs(decision.pos - (audio.currentTime || 0)) > SEEK_THRESHOLD_S)
          audio.currentTime = Math.max(0, decision.pos);
        if (!audio.paused) audio.pause();
      } else if (decision.action === 'seek') {
        if (typeof decision.pos === 'number') audio.currentTime = Math.max(0, decision.pos);
      }
    } catch (e) {}
    setTimeout(function () { state.applyingRemote = false; }, 1200);
    refreshUI();
  }
  function onChannelMessage(ev) {
    var msg = validateMessage(typeof ev.data === 'string' ? ev.data : '');
    if (!msg) return;
    if (msg.from === deviceId()) return; // eco propio
    if (msg.from) state.peerId = msg.from;
    if (msg.t === 'ping') { send('pong', { t0: msg.t0, t1: Date.now() }); return; }
    if (msg.t === 'pong') {
      var o = computeOffset(msg.t0, msg.t1, Date.now());
      if (o) {
        state.pingSamples.push({ t0: msg.t0, tRemote: msg.t1, t3: Date.now() });
        if (state.pingSamples.length > 5) state.pingSamples.shift();
        var best = bestOffset(state.pingSamples);
        if (best) { state.offsetMs = best.offsetMs; state.rttMs = best.rttMs; }
      }
      refreshUI();
      return;
    }
    if (msg.t === 'missing') {
      state.peerMissing = { title: msg.title || '', artist: msg.artist || '' };
      refreshUI();
      toast('Al otro lado le falta "' + (msg.title || '') + '": no puede sonar allí hasta que la añada.');
      return;
    }
    if (msg.t === 'hello') { refreshUI(); return; }
    if (msg.t === 'bye') { toast('El otro lado cerró la escucha conjunta.'); disconnect(false); return; }
    // Órdenes de reproducción: solo el líder manda; el seguidor obedece.
    if (isLeader(state.role)) return; // soy líder: ignoro play/pausa/seek/track del otro
    if (msg.t === 'state' || msg.t === 'play' || msg.t === 'pause' || msg.t === 'seek' || msg.t === 'track') applyRemote(msg);
  }

  /* ---------- WebRTC (señalización manual, sin servidor) ---------- */
  function rtcSupported() {
    if (state.supported !== null) return state.supported;
    state.supported = (typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection === 'function');
    return state.supported;
  }
  function newPC() {
    // STUN público solo para atravesar NAT; no hay servidor propio ni
    // cuentas. En la misma Wi-Fi funciona incluso sin STUN.
    return new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
  }
  function waitIceComplete(pc) {
    return new Promise(function (resolve) {
      if (!pc || pc.iceGatheringState === 'complete') { resolve(); return; }
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      var to = setTimeout(finish, 4000); // no esperar eternamente
      try {
        pc.addEventListener('icegatheringstatechange', function () {
          if (pc.iceGatheringState === 'complete') { clearTimeout(to); finish(); }
        });
      } catch (e) { finish(); }
    });
  }
  function wirePC(pc, channel) {
    state.pc = pc; state.channel = channel || null;
    pc.onconnectionstatechange = function () {
      try {
        if (pc.connectionState === 'connected') {
          state.connected = true;
          send('hello', { role: state.role });
          refreshUI();
          toast('Escucha conjunta conectada 🎧');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (state.connected) toast('Se perdió la conexión de escucha conjunta.');
          state.connected = false; refreshUI();
        }
      } catch (e) {}
    };
    if (channel) wireChannel(channel);
    pc.ondatachannel = function (ev) { wireChannel(ev.channel); };
  }
  function wireChannel(ch) {
    state.channel = ch;
    ch.onopen = function () {
      state.connected = true;
      send('hello', { role: state.role });
      refreshUI();
      toast('Escucha conjunta conectada 🎧');
    };
    ch.onclose = function () { state.connected = false; refreshUI(); };
    ch.onmessage = onChannelMessage;
  }
  function createOffer() {
    if (!rtcSupported()) return Promise.reject(new Error('unsupported'));
    disconnect(true);
    state.role = 'host';
    var pc = newPC();
    var ch = pc.createDataChannel('rpm-conjunta');
    wirePC(pc, ch);
    return pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return waitIceComplete(pc); })
      .then(function () { return encodeSignal({ kind: 'offer', sdp: pc.localDescription, from: deviceId() }); });
  }
  function createAnswer(offerCode) {
    var offer = decodeSignal(offerCode);
    if (!offer || offer.kind !== 'offer') return Promise.reject(new Error('bad-offer'));
    if (!rtcSupported()) return Promise.reject(new Error('unsupported'));
    disconnect(true);
    state.role = 'guest';
    var pc = newPC();
    wirePC(pc, null);
    return pc.setRemoteDescription(new RTCSessionDescription(offer.sdp))
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { return waitIceComplete(pc); })
      .then(function () { return encodeSignal({ kind: 'answer', sdp: pc.localDescription, from: deviceId() }); });
  }
  function applyAnswer(answerCode) {
    var answer = decodeSignal(answerCode);
    if (!answer || answer.kind !== 'answer') return Promise.reject(new Error('bad-answer'));
    if (!state.pc) return Promise.reject(new Error('no-offer'));
    return state.pc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
  }
  function disconnect(silent) {
    try { if (state.channel) state.channel.close(); } catch (e) {}
    try { if (state.pc) state.pc.close(); } catch (e) {}
    state.channel = null; state.pc = null; state.connected = false;
    state.pingSamples = []; state.offsetMs = 0; state.rttMs = null;
    state.missingTrack = null; state.peerMissing = null;
    if (!silent) refreshUI();
  }

  /* ---------- UI (modal propio, reusa .modal-overlay/.modal/.btn) ---------- */
  function ensureUI() {
    var anchor = $('btnShareCurrent') || $('btnEditCurrent');
    if (anchor && anchor.parentNode && !$('btnConjunta')) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'btnConjunta'; btn.className = 'btn small';
      btn.textContent = '🎧 Escucha conjunta';
      btn.title = 'Escuchar la misma canción a la vez con otra persona (cada uno con su copia local)';
      btn.addEventListener('click', openModal);
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
    if ($('conjuntaModal')) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay conjunta-overlay'; overlay.id = 'conjuntaModal';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="modal conjunta-modal" role="dialog" aria-modal="true" aria-labelledby="conjuntaTitle">' +
      '<h3 id="conjuntaTitle">🎧 Escucha conjunta</h3>' +
      '<p class="conjunta-rule"><strong>Los audios NO viajan.</strong> Cada uno escucha su propia copia de la canción, en su dispositivo. ' +
      'Si al otro lado le falta esa canción en su biblioteca, se avisará y no se fingirá que suena.</p>' +
      '<p class="conjunta-status" id="conjuntaStatus" role="status">Sin conectar.</p>' +
      '<p class="conjunta-missing" id="conjuntaMissing" hidden></p>' +
      '<div class="conjunta-steps" id="conjuntaSteps">' +
      '<p><strong>1.</strong> Uno hace de <em>anfitrión</em> y el otro de <em>invitado</em>. El anfitrión manda: play, pausa y cambio de canción.</p>' +
      '<div class="conjunta-row"><button type="button" class="btn small" id="conjuntaHostBtn">Soy anfitrión</button>' +
      '<button type="button" class="btn small" id="conjuntaGuestBtn">Soy invitado</button></div>' +
      '<div id="conjuntaHostBox" hidden>' +
      '<p><strong>2.</strong> Copia esta oferta y pásasela al invitado (mensaje, WhatsApp…):</p>' +
      '<textarea id="conjuntaOfferOut" class="conjunta-code" readonly rows="4" placeholder="Pulsa «Crear oferta»…"></textarea>' +
      '<div class="conjunta-row"><button type="button" class="btn small primary" id="conjuntaCreateOffer">Crear oferta</button>' +
      '<button type="button" class="btn small" id="conjuntaCopyOffer">Copiar oferta</button></div>' +
      '<p><strong>3.</strong> Pega aquí la respuesta del invitado y conecta:</p>' +
      '<textarea id="conjuntaAnswerIn" class="conjunta-code" rows="4" placeholder="Pega aquí la respuesta…"></textarea>' +
      '<div class="conjunta-row"><button type="button" class="btn small primary" id="conjuntaApplyAnswer">Conectar con la respuesta</button></div>' +
      '<p class="conjunta-note">La oferta es larga (cientos de caracteres): no cabe en un QR, por eso se copia como texto.</p>' +
      '</div>' +
      '<div id="conjuntaGuestBox" hidden>' +
      '<p><strong>2.</strong> Pega aquí la oferta del anfitrión:</p>' +
      '<textarea id="conjuntaOfferIn" class="conjunta-code" rows="4" placeholder="Pega aquí la oferta…"></textarea>' +
      '<div class="conjunta-row"><button type="button" class="btn small primary" id="conjuntaCreateAnswer">Crear respuesta</button></div>' +
      '<p><strong>3.</strong> Copia esta respuesta y pásasela al anfitrión:</p>' +
      '<textarea id="conjuntaAnswerOut" class="conjunta-code" readonly rows="4" placeholder="Pulsa «Crear respuesta»…"></textarea>' +
      '<div class="conjunta-row"><button type="button" class="btn small" id="conjuntaCopyAnswer">Copiar respuesta</button></div>' +
      '</div>' +
      '</div>' +
      '<div class="modal-actions conjunta-actions">' +
      '<button type="button" class="btn small" id="conjuntaDisconnect">Desconectar</button>' +
      '<button type="button" class="btn small" id="conjuntaClose">Cerrar</button>' +
      '</div>' +
      '<p class="conjunta-toast" id="conjuntaToast" hidden></p>' +
      '</div>';
    document.body.appendChild(overlay);
    $('conjuntaClose').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    $('conjuntaHostBtn').addEventListener('click', function () {
      $('conjuntaHostBox').hidden = false; $('conjuntaGuestBox').hidden = true;
    });
    $('conjuntaGuestBtn').addEventListener('click', function () {
      $('conjuntaGuestBox').hidden = false; $('conjuntaHostBox').hidden = true;
    });
    $('conjuntaCreateOffer').addEventListener('click', function () {
      setStatus('Creando oferta… (recogiendo candidatos de red, unos segundos)');
      createOffer().then(function (code) {
        $('conjuntaOfferOut').value = code || '';
        setStatus(code ? 'Oferta lista: cópiala y pásasela al invitado.' : 'No se pudo crear la oferta.');
      }).catch(function (err) {
        setStatus(err && err.message === 'unsupported'
          ? 'Este navegador no soporta WebRTC: no se puede hacer escucha conjunta aquí.'
          : 'No se pudo crear la oferta. Comprueba la conexión e inténtalo de nuevo.');
      });
    });
    $('conjuntaCopyOffer').addEventListener('click', function () { copyText('conjuntaOfferOut', 'Oferta copiada.'); });
    $('conjuntaCreateAnswer').addEventListener('click', function () {
      var code = $('conjuntaOfferIn').value;
      if (!isOfferCode(code)) { setStatus('Esa oferta no es válida: revisa que la pegaste completa (empieza por RPM9-).'); return; }
      setStatus('Creando respuesta…');
      createAnswer(code).then(function (ans) {
        $('conjuntaAnswerOut').value = ans || '';
        setStatus(ans ? 'Respuesta lista: cópiala y pásasela al anfitrión.' : 'No se pudo crear la respuesta.');
      }).catch(function (err) {
        setStatus(err && err.message === 'unsupported'
          ? 'Este navegador no soporta WebRTC: no se puede hacer escucha conjunta aquí.'
          : 'No se pudo crear la respuesta con esa oferta.');
      });
    });
    $('conjuntaCopyAnswer').addEventListener('click', function () { copyText('conjuntaAnswerOut', 'Respuesta copiada.'); });
    $('conjuntaApplyAnswer').addEventListener('click', function () {
      var code = $('conjuntaAnswerIn').value;
      if (!isAnswerCode(code)) { setStatus('Esa respuesta no es válida: revisa que la pegaste completa (empieza por RPM9-).'); return; }
      setStatus('Conectando…');
      applyAnswer(code).then(function () {
        setStatus('Respuesta aplicada: esperando a que se abra el canal…');
      }).catch(function (err) {
        setStatus(err && err.message === 'no-offer'
          ? 'Primero crea una oferta (paso 2).'
          : 'No se pudo aplicar esa respuesta.');
      });
    });
    $('conjuntaDisconnect').addEventListener('click', function () {
      try { send('bye', {}); } catch (e) {}
      disconnect(false);
      setStatus('Desconectado.');
      toast('Escucha conjunta desconectada.');
    });
  }
  function copyText(id, okMsg) {
    var el = $(id);
    if (!el || !el.value) { setStatus('No hay nada que copiar todavía.'); return; }
    function done() { setStatus(okMsg); toast(okMsg); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.value).then(done, function () { el.select(); document.execCommand('copy'); done(); });
      } else { el.select(); document.execCommand('copy'); done(); }
    } catch (e) { try { el.select(); } catch (e2) {} setStatus('No se pudo copiar solo: selecciona el texto y cópialo a mano.'); }
  }
  function setStatus(msg) {
    var el = $('conjuntaStatus');
    if (el) el.textContent = msg;
  }
  function statusText() {
    if (!rtcSupported()) return 'Este navegador no soporta WebRTC: la escucha conjunta no está disponible aquí.';
    if (state.connected) {
      var s = 'Conectado como ' + (state.role === 'host' ? 'anfitrión (tú mandas)' : 'invitado (obedeces al anfitrión)') + '.';
      if (state.rttMs != null) s += ' Ida y vuelta: ' + Math.round(state.rttMs) + ' ms; desfase estimado: ' + Math.round(state.offsetMs) + ' ms.';
      var cur = localState();
      s += ' Sonando aquí: "' + (cur.title || 'ninguna') + '"';
      if (cur.title) s += cur.playing ? ' ▶' : ' ⏸';
      return s;
    }
    if (state.pc) return 'Esperando al otro lado… completa los pasos de arriba.';
    return 'Sin conectar. Elige si eres anfitrión o invitado.';
  }
  function refreshUI() {
    var btn = $('btnConjunta');
    if (btn) btn.textContent = state.connected ? '🎧 Conjunta: conectado' : '🎧 Escucha conjunta';
    var st = $('conjuntaStatus');
    if (st) st.textContent = statusText();
    var miss = $('conjuntaMissing');
    if (miss) {
      if (state.missingTrack) {
        miss.hidden = false;
        miss.textContent = '⚠️ Te falta esta canción: "' + state.missingTrack.title + '" de ' +
          (state.missingTrack.artist || 'artista desconocido') +
          '. Añádela a tu biblioteca para escucharla juntos; aquí no sonará nada hasta entonces.';
      } else if (state.peerMissing) {
        miss.hidden = false;
        miss.textContent = '⚠️ Al otro lado le falta "' + state.peerMissing.title + '": allí no sonará hasta que la añada.';
      } else miss.hidden = true;
    }
  }
  function openModal() {
    ensureUI();
    var m = $('conjuntaModal');
    if (!m) return;
    m.setAttribute('aria-hidden', 'false');
    m.style.display = 'flex';
    refreshUI();
  }
  function closeModal() {
    var m = $('conjuntaModal');
    if (!m) return;
    m.setAttribute('aria-hidden', 'true');
    m.style.display = 'none';
  }

  /* ---------- Sondeo: detectar cambios locales y difundirlos ---------- */
  function tick() {
    try {
      ensureUI();
      var audio = audioEl();
      if (audio && state.connected && isLeader(state.role)) {
        var cur = localState();
        var key = trackKeyOf(currentTrack()) + '|' + (cur.title || '') + '|' + (cur.artist || '');
        var playingChanged = state.lastPlaying !== null && state.lastPlaying !== cur.playing;
        if (key !== state.lastTrackKey) {
          state.lastTrackKey = key;
          var t = currentTrack();
          if (t) send('track', { hash: normHash(t.audioHash), title: t.title || '', artist: t.artist || '', playing: cur.playing, pos: cur.pos });
          else send('state', { hash: '', title: cur.title, artist: cur.artist, playing: cur.playing, pos: cur.pos });
          state.lastBroadcast = Date.now();
        } else if (playingChanged && !state.applyingRemote) {
          send(cur.playing ? 'play' : 'pause', { hash: cur.hash, title: cur.title, artist: cur.artist, pos: cur.pos });
          state.lastBroadcast = Date.now();
        } else {
          broadcastState(false);
        }
        state.lastPlaying = cur.playing;
      }
      // Ping periódico para medir el desfase (ambos lados).
      if (state.connected && state.channel && state.channel.readyState === 'open') {
        var now = Date.now();
        if (!tick._lastPing || now - tick._lastPing > PING_INTERVAL_MS) {
          tick._lastPing = now;
          send('ping', { t0: now });
        }
      }
      refreshUI();
    } catch (e) { /* el sondeo nunca debe romper la app */ }
  }
  function bindAudioEvents() {
    try {
      var audio = audioEl(); if (!audio || audio.__conjuntaBound) return;
      audio.__conjuntaBound = true;
      ['play', 'pause', 'seeked', 'ended'].forEach(function (ev) {
        audio.addEventListener(ev, function () {
          try {
            if (!state.connected || !isLeader(state.role) || state.applyingRemote) return;
            var cur = localState();
            if (ev === 'play') send('play', { hash: cur.hash, title: cur.title, artist: cur.artist, pos: cur.pos });
            else if (ev === 'pause' || ev === 'ended') send('pause', { hash: cur.hash, title: cur.title, artist: cur.artist, pos: cur.pos });
            else if (ev === 'seeked') send('seek', { hash: cur.hash, title: cur.title, artist: cur.artist, pos: cur.pos });
          } catch (e) {}
        });
      });
    } catch (e) {}
  }
  function buildUI() {
    try {
      var hasCss = !!document.querySelector('link[href*="conjunta.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './conjunta.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try { deviceId(); } catch (e) {}
    try { ensureUI(); bindAudioEvents(); } catch (e) {}
    state.timers.push(setInterval(tick, 600));
    try { tick(); } catch (e) {}
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  var pure = {
    normText: normText, normHash: normHash,
    base64urlEncode: base64urlEncode, base64urlDecode: base64urlDecode,
    utf8Encode: utf8Encode, utf8Decode: utf8Decode,
    encodeSignal: encodeSignal, decodeSignal: decodeSignal,
    isOfferCode: isOfferCode, isAnswerCode: isAnswerCode,
    isLeader: isLeader, electLeaderById: electLeaderById,
    computeOffset: computeOffset, bestOffset: bestOffset,
    projectRemotePos: projectRemotePos,
    tracksMatch: tracksMatch, matchStrength: matchStrength, findLocalTrack: findLocalTrack,
    createMessage: createMessage, validateMessage: validateMessage,
    decideRemoteAction: decideRemoteAction, decideSeek: decideSeek,
    PROTOCOL_VERSION: PROTOCOL_VERSION, SIGNAL_PREFIX: SIGNAL_PREFIX,
    SEEK_THRESHOLD_S: SEEK_THRESHOLD_S, MAX_SIGNAL_CHARS: MAX_SIGNAL_CHARS,
    MESSAGE_TYPES: MESSAGE_TYPES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window !== 'undefined') {
    window.__conjunta = {
      pure: pure,
      open: function () { try { openModal(); } catch (e) {} },
      close: function () { try { closeModal(); } catch (e) {} },
      disconnect: function () { try { disconnect(false); } catch (e) {} },
      status: function () {
        return { role: state.role, connected: state.connected,
          supported: rtcSupported(), offsetMs: state.offsetMs, rttMs: state.rttMs,
          missingTrack: state.missingTrack, peerMissing: state.peerMissing };
      },
      sendState: function () { try { broadcastState(true); } catch (e) {} }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
