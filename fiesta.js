/* Modo fiesta con votos — Reproductor de Música v4.1.0 (módulo aparte).
 *
 * En una escucha conjunta activa, cada participante propone canciones
 * de SU biblioteca y vota por las propuestas; al terminar la canción
 * actual gana la más votada y el anfitrión (líder) la pone la primera
 * en la cola. Los votos viajan por el MISMO DataChannel WebRTC de la
 * escucha conjunta ('rpm-conjunta'), con tipos de mensaje nuevos
 * ('fiesta-*'); los mensajes existentes de conjunta.js no se tocan.
 *
 * REGLAS HONESTAS (visibles en el panel):
 * - Los audios NO viajan: cada lado reproduce su copia local, igual
 *   que en la escucha conjunta. Una propuesta solo puede ganar en el
 *   anfitrión si ÉL tiene esa canción en su biblioteca (por audioHash,
 *   o por título+artista+duración si no hay hash, igual que conjunta.js).
 * - Un participante tiene UN voto activo: votar por otra canción MUEVE
 *   su voto (no se suma). Proponer una canción cuenta como votar por
 *   ella. Votar por la misma canción dos veces no suma nada.
 * - Desempate: gana la propuesta antes (proposedAt); si empatan hasta
 *   en eso, la clave menor (determinista en ambos lados).
 * - Las propuestas que no ganan se quedan para la siguiente ronda con
 *   sus votos; solo la ganadora sale de la lista (ya está en la cola).
 * - Sin sesión conjunta activa, el módulo no hace nada: el panel lo
 *   explica y los botones de votar/proponer quedan desactivados.
 * - Sin el enganche de WIRING.md en conjunta.js (tipos 'fiesta-*' en
 *   MESSAGE_TYPES + ruta a window.__fiesta.onChannelMessage + exponer
 *   sendFiesta/onFiestaMessage), los votos NO pueden viajar: el panel
 *   lo dice claro en vez de fingir que votas. Sin conjunta.js cargado,
 *   el módulo carga igual y no rompe nada.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico, como
 * conjunta.js / notas.js. Solo usa lo que la app ya expone:
 *   - window.__rpmApp.getTracks() / trackKey() / toast() / render()
 *   - window.__conjunta.status() / .pure.findLocalTrack() (si cargó)
 *   - Transporte: window.__conjunta.sendFiesta(type, fields) y
 *     window.__conjunta.onFiestaMessage(cb) — los añade el parche de
 *     WIRING.md; sin ellos no hay envío y el panel lo dice.
 *   - Cola: window.__rpmApp.queueNext(id) si el coordinador la expone
 *     (una línea en __rpmApp, ver WIRING.md); si no, el menú ⋯ de la
 *     fila [data-track-id] → "Tocar siguiente" (la app ya hace
 *     queueNext(id) ahí, index.html ~l. 4017). Si la fila no está
 *     visible, se avisa y no se finge.
 *   - Fin de canción: sondeo cada 800 ms (como conjunta.js) que pone
 *     en cola a la ganadora cuando quedan <= 5 s, más 'ended' en
 *     #audio como respaldo. El líder aplica el resultado; el invitado
 *     solo ve el anuncio y sigue al líder por conjunta.js.
 *
 * Estructura: núcleo puro (sin DOM, probable en Node, exportado por
 * module.exports) + pegamento de navegador (transporte, panel, cola).
 * Pruebas Node: node --test fiesta.test.mjs
 * Consola: window.__fiesta (estado, abrir/cerrar, votar, aplicar)
 *
 * Protocolo (mismo sobre JSON que conjunta.js: {v:1, t, from, seq, ts}):
 *   fiesta-propose {key, hash, title, artist, duration, proposedAt}
 *   fiesta-vote    {key}            (key null = quitar mi voto)
 *   fiesta-retract {key}            (retirar una propuesta)
 *   fiesta-sync    {state}          (solo el líder; estado completo)
 *   fiesta-result  {key, hash, title, artist, votes} (solo el líder)
 *   fiesta-clear   {}               (solo el líder; vacía la ronda)
 * La identidad de una canción entre dispositivos es su audioHash, o
 * título+artista+duración redondeada si no hay hash. NUNCA el id
 * local de IndexedDB: ese id es distinto en cada dispositivo.
 */
(function (global) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var PROTOCOL_VERSION = 1;
  var QUEUE_AHEAD_S = 5;      // poner en cola a la ganadora cuando falte esto
  var MAX_PROPOSALS = 50;     // tope de propuestas por ronda
  var MAX_TITLE_LEN = 200;

  var FIESTA_MESSAGE_TYPES = [
    'fiesta-propose', 'fiesta-vote', 'fiesta-retract',
    'fiesta-sync', 'fiesta-result', 'fiesta-clear'
  ];

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function normHash(h) {
    return String(h == null ? '' : h).trim().toLowerCase();
  }
  function clampText(s, max) {
    var t = String(s == null ? '' : s).trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  /* Clave entre dispositivos: hash manda; sin hash, metadatos.
     Misma regla que conjunta.js (tracksMatch): si una tiene hash y la
     otra no, solo metadatos; aquí la clave ya refleja eso. */
  function trackKeyFor(track) {
    if (!track || typeof track !== 'object') return null;
    var h = normHash(track.audioHash);
    if (h) return 'hash:' + h;
    var title = normText(track.title), artist = normText(track.artist);
    if (!title && !artist) return null;
    var dur = Math.round(Number(track.duration) || 0);
    return 'meta:' + title + '|' + artist + '|' + dur;
  }
  function tracksMatchKey(a, b) {
    if (!a || !b) return false;
    var ka = trackKeyFor(a), kb = trackKeyFor(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    // Una con hash y otra sin: comparar por metadatos (regla conjunta).
    if ((ka.indexOf('hash:') === 0) !== (kb.indexOf('hash:') === 0)) {
      return normText(a.title) === normText(b.title) &&
             normText(a.artist) === normText(b.artist) &&
             Math.round(Number(a.duration) || 0) === Math.round(Number(b.duration) || 0);
    }
    return false;
  }
  function findLocalTrack(tracks, wanted) {
    if (!wanted) return null;
    var list = tracks || [], i, weak = null;
    for (i = 0; i < list.length; i++) {
      var k = trackKeyFor(list[i]);
      if (k && wanted.key && k === wanted.key) return list[i];
      if (!weak && tracksMatchKey(list[i], wanted)) weak = list[i];
    }
    return weak;
  }

  function createState(nowMs) {
    return { v: PROTOCOL_VERSION, round: 1, candidates: {}, votes: {},
             lastResult: null, updatedAt: Number(nowMs) || 0 };
  }
  function cloneState(state) {
    var out = { v: PROTOCOL_VERSION, round: state.round || 1,
                candidates: {}, votes: {}, lastResult: state.lastResult || null,
                updatedAt: state.updatedAt || 0 };
    var k;
    for (k in state.candidates) {
      if (Object.prototype.hasOwnProperty.call(state.candidates, k))
        out.candidates[k] = {
          key: state.candidates[k].key, hash: state.candidates[k].hash || '',
          title: state.candidates[k].title || '', artist: state.candidates[k].artist || '',
          duration: state.candidates[k].duration || 0,
          proposedAt: state.candidates[k].proposedAt || 0,
          proposedBy: state.candidates[k].proposedBy || ''
        };
    }
    for (k in state.votes) {
      if (Object.prototype.hasOwnProperty.call(state.votes, k)) out.votes[k] = state.votes[k];
    }
    return out;
  }
  function countVotes(state, key) {
    var n = 0, v;
    for (v in state.votes) {
      if (Object.prototype.hasOwnProperty.call(state.votes, v) && state.votes[v] === key) n++;
    }
    return n;
  }
  function votersFor(state, key) {
    var out = [], v;
    for (v in state.votes) {
      if (Object.prototype.hasOwnProperty.call(state.votes, v) && state.votes[v] === key) out.push(v);
    }
    return out.sort();
  }
  function myVote(state, voterId) {
    if (!voterId) return null;
    return state.votes[String(voterId)] || null;
  }

  /* Proponer: añade la candidata (si es nueva) y cuenta como votar por
     ella: el voto del proponente se mueve a esta canción. Repetir la
     propuesta no duplica la candidata ni reinicia proposedAt. */
  function propose(state, track, voterId, nowMs) {
    var s = cloneState(state || createState());
    var now = Number(nowMs) || Date.now();
    if (!track || typeof track !== 'object') return { state: s, ok: false, error: 'no-track' };
    var key = trackKeyFor(track);
    if (!key) return { state: s, ok: false, error: 'no-key' };
    var title = clampText(track.title, MAX_TITLE_LEN);
    var artist = clampText(track.artist, MAX_TITLE_LEN);
    if (!title && !normHash(track.audioHash)) return { state: s, ok: false, error: 'no-key' };
    var isNew = !s.candidates[key];
    if (isNew) {
      if (Object.keys(s.candidates).length >= MAX_PROPOSALS)
        return { state: s, ok: false, error: 'full' };
      s.candidates[key] = {
        key: key, hash: normHash(track.audioHash), title: title, artist: artist,
        duration: Math.round(Number(track.duration) || 0),
        proposedAt: now, proposedBy: String(voterId || '')
      };
    }
    var changed = isNew;
    if (voterId && s.votes[String(voterId)] !== key) {
      s.votes[String(voterId)] = key;
      changed = true;
    }
    s.updatedAt = now;
    return { state: s, ok: true, candidate: s.candidates[key], isNew: isNew, changed: changed };
  }

  /* Votar: un voto activo por participante. key null/'' quita el voto.
     Votar por la misma canción es no-op; por una desconocida, error. */
  function vote(state, voterId, key, nowMs) {
    var s = cloneState(state || createState());
    var now = Number(nowMs) || Date.now();
    if (!voterId) return { state: s, ok: false, error: 'no-voter' };
    var v = String(voterId);
    if (key == null || key === '') {
      if (!(v in s.votes)) return { state: s, ok: true, changed: false, previous: null };
      var prev = s.votes[v];
      delete s.votes[v];
      s.updatedAt = now;
      return { state: s, ok: true, changed: true, previous: prev };
    }
    key = String(key);
    if (!s.candidates[key]) return { state: s, ok: false, error: 'unknown-candidate' };
    var previous = s.votes[v] || null;
    if (previous === key) return { state: s, ok: true, changed: false, previous: previous };
    s.votes[v] = key;
    s.updatedAt = now;
    return { state: s, ok: true, changed: true, previous: previous };
  }

  function retractProposal(state, key, voterId, isLeader, nowMs) {
    var s = cloneState(state || createState());
    var now = Number(nowMs) || Date.now();
    if (!key || !s.candidates[String(key)]) return { state: s, ok: false, error: 'unknown-candidate' };
    key = String(key);
    var c = s.candidates[key];
    if (!isLeader && String(voterId || '') !== String(c.proposedBy || ''))
      return { state: s, ok: false, error: 'not-allowed' };
    delete s.candidates[key];
    var v;
    for (v in s.votes) {
      if (Object.prototype.hasOwnProperty.call(s.votes, v) && s.votes[v] === key) delete s.votes[v];
    }
    s.updatedAt = now;
    return { state: s, ok: true, changed: true, candidate: c };
  }

  function tally(state) {
    var s = state || createState();
    var rows = [], k;
    for (k in s.candidates) {
      if (!Object.prototype.hasOwnProperty.call(s.candidates, k)) continue;
      var c = s.candidates[k];
      rows.push({ key: c.key, hash: c.hash || '', title: c.title || '',
                  artist: c.artist || '', duration: c.duration || 0,
                  proposedAt: c.proposedAt || 0, proposedBy: c.proposedBy || '',
                  votes: countVotes(s, k), voters: votersFor(s, k) });
    }
    rows.sort(function (a, b) {
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (a.proposedAt !== b.proposedAt) return a.proposedAt - b.proposedAt;
      return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });
    return rows;
  }

  function toSet(v) {
    if (v == null) return null;
    if (typeof v === 'string') return { _s: true, has: function (x) { return x === v; } };
    if (Array.isArray(v)) {
      var m = {};
      v.forEach(function (x) { m[String(x)] = true; });
      return { _s: true, has: function (x) { return !!m[String(x)]; } };
    }
    if (typeof v.has === 'function') return v;
    return null;
  }

  /* Ganadora: la más votada (desempate: propuesta antes, luego clave).
     Solo candidatas con >= 1 voto. opts.excludeKeys: la que suena ahora
     (y cualquier otra que no deba ganar). opts.availableKeys: si se
     pasa, solo candidatas que el líder tiene en su biblioteca. */
  function pickWinner(state, opts) {
    var o = opts || {};
    var exclude = toSet(o.excludeKeys);
    var available = toSet(o.availableKeys);
    var rows = tally(state);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].votes < 1) continue;
      if (exclude && exclude.has(rows[i].key)) continue;
      if (available && !available.has(rows[i].key)) continue;
      return rows[i];
    }
    return null;
  }

  /* Aplicar la ganadora: sale de la lista, sus votos se liberan (esos
     votantes quedan sin voto y pueden votar de nuevo), ronda + 1. Las
     demás propuestas conservan sus votos para la siguiente ronda. */
  function applyWinner(state, winnerKey, nowMs) {
    var s = cloneState(state || createState());
    var now = Number(nowMs) || Date.now();
    if (!winnerKey || !s.candidates[String(winnerKey)])
      return { state: s, ok: false, error: 'unknown-candidate' };
    var key = String(winnerKey);
    var c = s.candidates[key];
    var n = countVotes(s, key);
    if (n < 1) return { state: s, ok: false, error: 'no-votes' };
    var winner = { key: c.key, hash: c.hash || '', title: c.title || '',
                   artist: c.artist || '', duration: c.duration || 0,
                   proposedAt: c.proposedAt || 0, proposedBy: c.proposedBy || '',
                   votes: n, winnerAt: now };
    delete s.candidates[key];
    var v;
    for (v in s.votes) {
      if (Object.prototype.hasOwnProperty.call(s.votes, v) && s.votes[v] === key) delete s.votes[v];
    }
    s.round = (s.round || 1) + 1;
    s.lastResult = winner;
    s.updatedAt = now;
    return { state: s, ok: true, winner: winner };
  }

  function clearRound(state, nowMs) {
    var s = cloneState(state || createState());
    s.candidates = {};
    s.votes = {};
    s.round = (s.round || 1) + 1;
    s.lastResult = null;
    s.updatedAt = Number(nowMs) || Date.now();
    return s;
  }

  /* ---------- Serialización del estado (para fiesta-sync) ---------- */
  function serializeState(state) {
    var s = state || createState();
    var cands = [];
    var k;
    for (k in s.candidates) {
      if (Object.prototype.hasOwnProperty.call(s.candidates, k)) cands.push(s.candidates[k]);
    }
    cands.sort(function (a, b) { return (a.proposedAt || 0) - (b.proposedAt || 0); });
    return { v: PROTOCOL_VERSION, round: s.round || 1, candidates: cands, votes: s.votes || {} };
  }
  function parseStatePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== PROTOCOL_VERSION) return null;
    if (!Array.isArray(payload.candidates)) return null;
    if (!payload.votes || typeof payload.votes !== 'object' || Array.isArray(payload.votes)) return null;
    if (typeof payload.round !== 'number' || !isFinite(payload.round) || payload.round < 1) return null;
    var s = createState();
    s.round = Math.floor(payload.round);
    var i, c;
    for (i = 0; i < payload.candidates.length; i++) {
      c = payload.candidates[i];
      if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !c.key) return null;
      if (typeof c.title !== 'string') return null;
      if (c.proposedAt !== undefined && (typeof c.proposedAt !== 'number' || !isFinite(c.proposedAt))) return null;
      s.candidates[c.key] = {
        key: c.key, hash: typeof c.hash === 'string' ? normHash(c.hash) : '',
        title: clampText(c.title, MAX_TITLE_LEN),
        artist: typeof c.artist === 'string' ? clampText(c.artist, MAX_TITLE_LEN) : '',
        duration: Math.round(Number(c.duration) || 0),
        proposedAt: Number(c.proposedAt) || 0,
        proposedBy: typeof c.proposedBy === 'string' ? c.proposedBy : ''
      };
    }
    var v;
    for (v in payload.votes) {
      if (!Object.prototype.hasOwnProperty.call(payload.votes, v)) continue;
      if (typeof payload.votes[v] !== 'string') return null;
      if (!s.candidates[payload.votes[v]]) return null; // voto a algo inexistente
      s.votes[String(v)] = payload.votes[v];
    }
    return s;
  }

  /* ---------- Mensajes del canal ---------- */
  function createFiestaMessage(type, fields, from, seq) {
    if (FIESTA_MESSAGE_TYPES.indexOf(type) === -1) return null;
    var msg = { v: PROTOCOL_VERSION, t: type, from: String(from || ''),
                seq: Number(seq) || 0, ts: Date.now() };
    var f = fields || {}, k;
    for (k in f) if (Object.prototype.hasOwnProperty.call(f, k)) msg[k] = f[k];
    return msg;
  }
  function validateFiestaMessage(raw) {
    var msg = raw;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return null; } }
    if (!msg || typeof msg !== 'object') return null;
    if (msg.v !== PROTOCOL_VERSION) return null;
    if (FIESTA_MESSAGE_TYPES.indexOf(msg.t) === -1) return null;
    if (typeof msg.from !== 'string') return null;
    if (typeof msg.ts !== 'number' || !isFinite(msg.ts)) return null;
    if (msg.seq !== undefined && (typeof msg.seq !== 'number' || !isFinite(msg.seq))) return null;
    function strField(k, required) {
      if (msg[k] === undefined) return !required;
      return typeof msg[k] === 'string';
    }
    if (msg.t === 'fiesta-propose') {
      if (!strField('key', true) || !msg.key) return null;
      if (!strField('title', true)) return null;
      if (!strField('hash', false) || !strField('artist', false)) return null;
      if (msg.duration !== undefined && (typeof msg.duration !== 'number' || !isFinite(msg.duration))) return null;
      if (msg.proposedAt !== undefined && (typeof msg.proposedAt !== 'number' || !isFinite(msg.proposedAt))) return null;
    } else if (msg.t === 'fiesta-vote') {
      if (!('key' in msg)) return null;
      if (msg.key !== null && typeof msg.key !== 'string') return null;
    } else if (msg.t === 'fiesta-retract' || msg.t === 'fiesta-result') {
      if (!strField('key', true) || !msg.key) return null;
      if (msg.t === 'fiesta-result' && !strField('title', false)) return null;
    } else if (msg.t === 'fiesta-sync') {
      if (!msg.state || typeof msg.state !== 'object') return null;
      if (!parseStatePayload(msg.state)) return null;
    }
    return msg;
  }

  /* ---------- Reducer de mensajes remotos (puro) ----------
     opts: {myId, peerIsLeader}. El eco propio se ignora. El estado
     completo (sync) y el resultado solo valen si vienen del líder;
     propuestas/votos los aplica cualquiera (el líder reemite sync). */
  function applyRemoteMessage(state, rawMsg, opts) {
    var o = opts || {};
    var s = cloneState(state || createState());
    var msg = validateFiestaMessage(rawMsg);
    if (!msg) return { state: s, changed: false, action: 'invalid' };
    if (o.myId && msg.from === String(o.myId)) return { state: s, changed: false, action: 'echo' };
    var now = Number(msg.ts) || Date.now();
    if (msg.t === 'fiesta-propose') {
      var r = propose(s, { audioHash: msg.hash || '', title: msg.title || '',
                           artist: msg.artist || '', duration: msg.duration || 0 },
                      msg.from, msg.proposedAt || now);
      // La propuesta remota trae su proposedAt original: respetarlo
      // para el desempate aunque llegue tarde.
      if (r.ok && r.candidate && msg.proposedAt) {
        r.state.candidates[r.candidate.key].proposedAt = Number(msg.proposedAt);
      }
      return { state: r.state, changed: r.changed, action: 'propose', ok: r.ok, error: r.error || null };
    }
    if (msg.t === 'fiesta-vote') {
      var v = vote(s, msg.from, msg.key, now);
      return { state: v.state, changed: v.changed, action: 'vote', ok: v.ok, error: v.error || null };
    }
    if (msg.t === 'fiesta-retract') {
      var rt = retractProposal(s, msg.key, msg.from, !!o.peerIsLeader, now);
      return { state: rt.state, changed: rt.changed, action: 'retract', ok: rt.ok, error: rt.error || null };
    }
    if (msg.t === 'fiesta-sync') {
      if (!o.peerIsLeader) return { state: s, changed: false, action: 'sync-ignored-not-leader' };
      var parsed = parseStatePayload(msg.state);
      if (!parsed) return { state: s, changed: false, action: 'invalid' };
      parsed.lastResult = s.lastResult; // el sync no borra el último resultado
      parsed.updatedAt = now;
      return { state: parsed, changed: true, action: 'sync' };
    }
    if (msg.t === 'fiesta-result') {
      if (!o.peerIsLeader) return { state: s, changed: false, action: 'result-ignored-not-leader' };
      var w = applyWinner(s, msg.key, now);
      if (w.ok) return { state: w.state, changed: true, action: 'result', winner: w.winner };
      // La ganadora ya no está en mi lista (sync previo): solo anotar.
      s.lastResult = { key: msg.key, hash: msg.hash || '', title: msg.title || '',
                       artist: msg.artist || '', votes: Number(msg.votes) || 0, winnerAt: now };
      s.updatedAt = now;
      return { state: s, changed: true, action: 'result', winner: s.lastResult };
    }
    if (msg.t === 'fiesta-clear') {
      if (!o.peerIsLeader) return { state: s, changed: false, action: 'clear-ignored-not-leader' };
      return { state: clearRound(s, now), changed: true, action: 'clear' };
    }
    return { state: s, changed: false, action: 'none' };
  }

  /* ================= Pegamento con el navegador ================= */

  var browserState = {
    fiesta: null,           // estado puro
    myId: '', seq: 0,
    lastCurrentKey: '', appliedForTrack: '', // ganador ya en cola para esta canción
    lastSyncSent: '',
    searchQuery: '',
    timers: []
  };

  function $(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
  function app() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; } catch (e) { return null; }
  }
  function conjunta() {
    try { return (typeof window !== 'undefined' && window.__conjunta) || null; } catch (e) { return null; }
  }
  function toast(msg) {
    try {
      var a = app();
      if (a && typeof a.toast === 'function') { a.toast(msg); return; }
    } catch (e) {}
  }
  function deviceId() {
    if (browserState.myId) return browserState.myId;
    var id = '';
    try {
      // MISMA clave que conjunta.js: un solo id por dispositivo para
      // que el voto se identifique igual en ambos módulos.
      id = localStorage.getItem('reproductor-conjunta-id') || '';
      if (!id) {
        id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('reproductor-conjunta-id', id);
      }
    } catch (e) { id = 'd' + Math.random().toString(36).slice(2, 10); }
    browserState.myId = id;
    return id;
  }
  function fiestaState() {
    if (!browserState.fiesta) browserState.fiesta = createState();
    return browserState.fiesta;
  }
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
  function currentKey() {
    var t = currentTrack();
    if (t) { var k = trackKeyFor(t); if (k) return k; }
    var cur = nowText();
    if (!cur.title) return '';
    return trackKeyFor({ title: cur.title, artist: cur.artist, duration: 0 }) || '';
  }
  function localLibraryKeys() {
    var a = app(); if (!a || typeof a.getTracks !== 'function') return null;
    var keys = {}, list = a.getTracks() || [], i, k;
    for (i = 0; i < list.length; i++) {
      if (list[i].rating === 'dislike') continue; // queueNext la rechaza
      k = trackKeyFor(list[i]);
      if (k) keys[k] = true;
    }
    return keys;
  }
  function findLocal(trackLike) {
    var a = app(); if (!a || typeof a.getTracks !== 'function') return null;
    var cj = conjunta();
    if (cj && cj.pure && typeof cj.pure.findLocalTrack === 'function') {
      try { return cj.pure.findLocalTrack(a.getTracks() || [], trackLike) || null; } catch (e) {}
    }
    return findLocalTrack(a.getTracks() || [], trackLike);
  }

  /* ---------- Transporte: el canal de conjunta.js ---------- */
  // Modos: 'patched' (conjunta con el enganche de WIRING.md),
  // 'conjunta-sin-enganche' (conjunta cargó pero sin sendFiesta),
  // 'no-conjunta' (conjunta.js no cargó). Sin 'patched' no hay envío.
  function transportMode() {
    var cj = conjunta();
    if (!cj) return 'no-conjunta';
    if (typeof cj.sendFiesta === 'function' && typeof cj.onFiestaMessage === 'function') return 'patched';
    return 'conjunta-sin-enganche';
  }
  function sessionStatus() {
    var cj = conjunta();
    var st = { mode: transportMode(), connected: false, role: null, isLeader: false };
    if (cj && typeof cj.status === 'function') {
      try {
        var s = cj.status() || {};
        st.connected = !!s.connected;
        st.role = s.role || null;
        st.isLeader = s.role === 'host';
      } catch (e) {}
    }
    return st;
  }
  function sendFiesta(type, fields) {
    var cj = conjunta();
    if (transportMode() !== 'patched' || !cj) return false;
    try { return cj.sendFiesta(type, fields) === true; } catch (e) { return false; }
  }
  function sendSync() {
    var st = sessionStatus();
    if (!st.isLeader || !st.connected) return false;
    var payload = JSON.stringify(serializeState(fiestaState()));
    if (payload === browserState.lastSyncSent) return true; // sin cambios
    browserState.lastSyncSent = payload;
    return sendFiesta('fiesta-sync', { state: serializeState(fiestaState()) });
  }
  function peerIsLeader() {
    // Sesión 1:1: si yo soy invitado, el otro lado es el líder.
    return sessionStatus().role === 'guest';
  }

  /* ---------- Acciones locales (proponer / votar / retirar) ---------- */
  function doPropose(track) {
    var st = sessionStatus();
    if (!st.connected) { toast('Sin escucha conjunta activa: conecta primero para proponer canciones.'); return false; }
    if (!track) return false;
    var ck = currentKey();
    if (ck && trackKeyFor(track) === ck) { toast('Esa canción ya está sonando: propone otra para después.'); return false; }
    var r = propose(fiestaState(), track, deviceId(), Date.now());
    if (!r.ok) { toast(r.error === 'full' ? 'Ya hay 50 propuestas en esta ronda.' : 'Esa canción no se puede proponer (sin título ni huella).'); return false; }
    browserState.fiesta = r.state;
    var c = r.candidate;
    sendFiesta('fiesta-propose', { key: c.key, hash: c.hash, title: c.title, artist: c.artist,
                                   duration: c.duration, proposedAt: c.proposedAt });
    sendSync();
    refreshUI();
    toast('Propuesta: "' + c.title + '"' + (r.isNew ? '' : ' (ya estaba propuesta; tu voto se movió a ella)'));
    return true;
  }
  function doVote(key) {
    var st = sessionStatus();
    if (!st.connected) { toast('Sin escucha conjunta activa: conecta primero para votar.'); return false; }
    var r = vote(fiestaState(), deviceId(), key || null, Date.now());
    if (!r.ok) { toast('Esa propuesta ya no existe.'); return false; }
    browserState.fiesta = r.state;
    sendFiesta('fiesta-vote', { key: key || null });
    sendSync();
    refreshUI();
    return true;
  }
  function doRetractProposal(key) {
    var st = sessionStatus();
    if (!st.connected) { toast('Sin escucha conjunta activa.'); return false; }
    var r = retractProposal(fiestaState(), key, deviceId(), st.isLeader, Date.now());
    if (!r.ok) { toast(r.error === 'not-allowed' ? 'Solo quien la propuso (o el anfitrión) puede retirarla.' : 'Esa propuesta ya no existe.'); return false; }
    browserState.fiesta = r.state;
    sendFiesta('fiesta-retract', { key: String(key) });
    sendSync();
    refreshUI();
    return true;
  }
  function doClearRound() {
    var st = sessionStatus();
    if (!st.isLeader) { toast('Solo el anfitrión puede limpiar la ronda.'); return false; }
    browserState.fiesta = clearRound(fiestaState(), Date.now());
    sendFiesta('fiesta-clear', {});
    sendSync();
    refreshUI();
    toast('Ronda de fiesta vaciada.');
    return true;
  }

  /* ---------- Aplicar la ganadora (solo el líder) ---------- */
  function queueWinnerViaMenu(localTrack) {
    // Respaldo si __rpmApp.queueNext no está expuesto: menú ⋯ de la
    // fila → "Tocar siguiente" (la app hace queueNext(id) ahí).
    var row = null;
    try {
      row = document.querySelector('[data-track-id="' + String(localTrack.id).replace(/"/g, '') + '"]');
    } catch (e) { row = null; }
    if (!row) return false;
    var menuBtn = row.querySelector('.menu-btn');
    if (!menuBtn) return false;
    menuBtn.click();
    var item = null, i, btns = [];
    try { btns = document.querySelectorAll('#trackMenu button'); } catch (e) { btns = []; }
    for (i = 0; i < btns.length; i++) {
      var span = btns[i].querySelector('span');
      if (span && span.textContent.trim() === 'Tocar siguiente') { item = btns[i]; break; }
    }
    if (!item) return false;
    item.click();
    return true;
  }
  function queueWinnerTrack(localTrack) {
    var a = app();
    if (a && typeof a.queueNext === 'function') {
      try { a.queueNext(localTrack.id); return true; } catch (e) { return false; }
    }
    return queueWinnerViaMenu(localTrack);
  }
  function applyWinnerNow(reason) {
    var st = sessionStatus();
    if (!st.isLeader || !st.connected) return { ok: false, error: 'not-leader' };
    var cur = currentKey();
    if (browserState.appliedForTrack && browserState.appliedForTrack === cur) return { ok: false, error: 'already-applied' };
    var available = localLibraryKeys();
    var rows = tally(fiestaState());
    var winner = null, local = null;
    // Probar en orden de votos hasta encontrar una que el líder tenga.
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].votes < 1) break;
      if (cur && rows[i].key === cur) continue;
      if (available && !available[rows[i].key]) continue;
      local = findLocal(rows[i]);
      if (local) { winner = rows[i]; break; }
    }
    if (!winner) {
      if (rows.length) toast('Nadie ha votado por una canción que tengas en tu biblioteca: no hay ganadora para la fiesta.');
      return { ok: false, error: 'no-winner' };
    }
    if (!queueWinnerTrack(local)) {
      toast('No se pudo poner "' + winner.title + '" en la cola: su fila no está visible en la lista. Búscala y usa "Tocar siguiente".');
      return { ok: false, error: 'queue-failed' };
    }
    var r = applyWinner(fiestaState(), winner.key, Date.now());
    if (!r.ok) return { ok: false, error: r.error };
    browserState.fiesta = r.state;
    browserState.appliedForTrack = cur;
    sendFiesta('fiesta-result', { key: r.winner.key, hash: r.winner.hash, title: r.winner.title,
                                  artist: r.winner.artist, votes: r.winner.votes });
    sendSync();
    toast('🎉 Ganó "' + r.winner.title + '" (' + r.winner.votes + (r.winner.votes === 1 ? ' voto' : ' votos') + '): sonará a continuación.');
    refreshUI();
    return { ok: true, winner: r.winner, reason: reason || 'manual' };
  }

  /* ---------- Mensajes que llegan por el canal (los entrega conjunta) ---------- */
  function onChannelMessage(raw) {
    try {
      var msg = validateFiestaMessage(raw);
      if (!msg) return false;
      var r = applyRemoteMessage(fiestaState(), msg, { myId: deviceId(), peerIsLeader: peerIsLeader() });
      if (r.changed) {
        browserState.fiesta = r.state;
        browserState.lastSyncSent = ''; // el estado cambió: el próximo sync sí se envía
        if (r.action === 'result' && r.winner) {
          toast('🎉 Ganó "' + (r.winner.title || '') + '": sonará a continuación.');
        }
        refreshUI();
      }
      return r.changed;
    } catch (e) { return false; }
  }

  /* ---------- UI (panel propio, reusa .modal-overlay/.modal/.btn) ---------- */
  function ensureUI() {
    var anchor = $('btnConjunta') || $('btnShareCurrent') || $('btnEditCurrent');
    if (anchor && anchor.parentNode && !$('btnFiesta')) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'btnFiesta'; btn.className = 'btn small';
      btn.textContent = '🎉 Modo fiesta';
      btn.title = 'Proponer y votar la siguiente canción en la escucha conjunta';
      btn.addEventListener('click', openModal);
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
    if ($('fiestaModal')) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay fiesta-overlay'; overlay.id = 'fiestaModal';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="modal fiesta-modal" role="dialog" aria-modal="true" aria-labelledby="fiestaTitle">' +
      '<h3 id="fiestaTitle">🎉 Modo fiesta con votos</h3>' +
      '<p class="fiesta-rule">En la escucha conjunta, cada uno propone canciones de su biblioteca y vota. ' +
      'Al terminar la que suena, gana la más votada (desempate: la propuesta antes) y el anfitrión la pone la primera en la cola. ' +
      'Tienes un solo voto: votar por otra mueve tu voto. Proponer cuenta como votar por esa canción.</p>' +
      '<p class="fiesta-status" id="fiestaStatus" role="status">Sin escucha conjunta activa.</p>' +
      '<p class="fiesta-winner" id="fiestaWinner" hidden></p>' +
      '<div id="fiestaBody">' +
      '<label class="fiesta-label" for="fiestaSearch">Buscar en tu biblioteca para proponer:</label>' +
      '<input id="fiestaSearch" class="fiesta-search" type="search" placeholder="Título o artista…" autocomplete="off">' +
      '<ul class="fiesta-results" id="fiestaSearchResults"></ul>' +
      '<h4 class="fiesta-sub">Propuestas de esta ronda</h4>' +
      '<ul class="fiesta-list" id="fiestaList"></ul>' +
      '<p class="fiesta-empty" id="fiestaEmpty">Aún no hay propuestas. Busca una canción arriba y proponla.</p>' +
      '</div>' +
      '<div class="modal-actions fiesta-actions">' +
      '<button type="button" class="btn small" id="fiestaClear">Limpiar ronda (anfitrión)</button>' +
      '<button type="button" class="btn small" id="fiestaClose">Cerrar</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    $('fiestaClose').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    $('fiestaClear').addEventListener('click', doClearRound);
    $('fiestaSearch').addEventListener('input', function (ev) {
      browserState.searchQuery = ev.target.value || '';
      renderSearch();
    });
  }
  function statusText() {
    var st = sessionStatus();
    if (st.mode === 'no-conjunta')
      return 'La escucha conjunta no está cargada en esta app: sin ella no hay sesión ni votos. El modo fiesta no hace nada hasta que conjunta.js esté activo.';
    if (st.mode === 'conjunta-sin-enganche')
      return 'La escucha conjunta está cargada, pero sin el enganche de fiesta (ver WIRING.md): los votos no pueden viajar por el canal. Pide al coordinador aplicar el parche de conjunta.js; mientras tanto, votar aquí no llega al otro lado.';
    if (!st.connected)
      return 'Sin escucha conjunta activa: conecta primero con el otro lado (🎧 Escucha conjunta) y vuelve aquí para proponer y votar.';
    return 'Conectado a la escucha conjunta como ' + (st.isLeader ? 'anfitrión (tú aplicas la ganadora)' : 'invitado (el anfitrión aplica la ganadora)') +
      '. Los votos viajan por el mismo canal de la escucha conjunta.';
  }
  function renderSearch() {
    var box = $('fiestaSearchResults');
    if (!box) return;
    box.innerHTML = '';
    var st = sessionStatus();
    var q = normText(browserState.searchQuery || '');
    if (!q || q.length < 2) return;
    var a = app(); if (!a || typeof a.getTracks !== 'function') return;
    var cur = currentKey();
    var shown = 0;
    (a.getTracks() || []).forEach(function (t) {
      if (shown >= 15) return;
      if (normText(t.title).indexOf(q) === -1 && normText(t.artist).indexOf(q) === -1) return;
      if (cur && trackKeyFor(t) === cur) return; // la que suena no se propone
      shown++;
      var li = document.createElement('li');
      li.className = 'fiesta-result-row';
      var name = document.createElement('span');
      name.className = 'fiesta-name';
      name.textContent = (t.title || 'Sin título') + ' — ' + (t.artist || 'artista desconocido');
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small';
      b.textContent = 'Proponer';
      b.disabled = !st.connected;
      b.addEventListener('click', function () { doPropose(t); });
      li.appendChild(name); li.appendChild(b);
      box.appendChild(li);
    });
  }
  function refreshUI() {
    var btn = $('btnFiesta');
    if (btn) {
      var n = Object.keys(fiestaState().candidates).length;
      btn.textContent = n ? '🎉 Fiesta (' + n + ')' : '🎉 Modo fiesta';
    }
    var stEl = $('fiestaStatus');
    if (stEl) stEl.textContent = statusText();
    var win = $('fiestaWinner');
    if (win) {
      var lr = fiestaState().lastResult;
      if (lr && lr.title) {
        win.hidden = false;
        win.textContent = '🏆 Última ganadora: "' + lr.title + '"' +
          (lr.artist ? ' de ' + lr.artist : '') + ' (' + (lr.votes || 0) + ' votos). Ya está en la cola.';
      } else win.hidden = true;
    }
    var body = $('fiestaBody');
    if (body) body.style.display = sessionStatus().connected ? '' : 'none';
    var clearBtn = $('fiestaClear');
    if (clearBtn) clearBtn.style.display = sessionStatus().isLeader ? '' : 'none';
    var list = $('fiestaList'), empty = $('fiestaEmpty');
    if (!list) return;
    list.innerHTML = '';
    var rows = tally(fiestaState());
    if (empty) empty.style.display = rows.length ? 'none' : '';
    var mine = myVote(fiestaState(), deviceId());
    var st = sessionStatus();
    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'fiesta-row' + (mine === row.key ? ' fiesta-mine' : '');
      var name = document.createElement('span');
      name.className = 'fiesta-name';
      var missing = !findLocal(row);
      name.textContent = row.title + ' — ' + (row.artist || 'artista desconocido') +
        (missing ? ' (no está en tu biblioteca)' : '');
      var count = document.createElement('span');
      count.className = 'fiesta-count';
      count.textContent = row.votes + (row.votes === 1 ? ' voto' : ' votos');
      li.appendChild(name); li.appendChild(count);
      var vb = document.createElement('button');
      vb.type = 'button'; vb.className = 'btn small' + (mine === row.key ? ' primary' : '');
      vb.textContent = mine === row.key ? '✓ Tu voto' : 'Votar';
      vb.disabled = !st.connected || mine === row.key;
      vb.addEventListener('click', function () { doVote(row.key); });
      li.appendChild(vb);
      if (mine === row.key) {
        var un = document.createElement('button');
        un.type = 'button'; un.className = 'btn small';
        un.textContent = 'Quitar voto';
        un.disabled = !st.connected;
        un.addEventListener('click', function () { doVote(null); });
        li.appendChild(un);
      }
      if (row.proposedBy === deviceId() || st.isLeader) {
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'btn small';
        rm.textContent = 'Retirar';
        rm.disabled = !st.connected;
        rm.addEventListener('click', function () { doRetractProposal(row.key); });
        li.appendChild(rm);
      }
      list.appendChild(li);
    });
    renderSearch();
  }
  function openModal() {
    ensureUI();
    var m = $('fiestaModal');
    if (!m) return;
    m.setAttribute('aria-hidden', 'false');
    m.style.display = 'flex';
    refreshUI();
  }
  function closeModal() {
    var m = $('fiestaModal');
    if (!m) return;
    m.setAttribute('aria-hidden', 'true');
    m.style.display = 'none';
  }

  /* ---------- Sondeo: fin de canción y registro del transporte ---------- */
  function tick() {
    try {
      ensureUI();
      // Registrar el receptor en conjunta.js en cuanto aparezca el
      // enganche (si conjunta cargó después que fiesta.js).
      var cj = conjunta();
      if (cj && typeof cj.onFiestaMessage === 'function' && !tick._registered) {
        try { cj.onFiestaMessage(onChannelMessage); tick._registered = true; } catch (e) {}
      }
      var st = sessionStatus();
      var cur = currentKey();
      if (cur !== browserState.lastCurrentKey) {
        browserState.lastCurrentKey = cur;
        browserState.appliedForTrack = '';
      }
      if (st.isLeader && st.connected) {
        var audio = $('audio');
        if (audio && isFinite(audio.duration) && audio.duration > 0) {
          var remaining = audio.duration - (audio.currentTime || 0);
          if (remaining <= QUEUE_AHEAD_S && remaining > 0) applyWinnerNow('pre-queue');
        }
        // Si el líder propone/vota, el otro lado se entera por sync.
        sendSync();
      }
      refreshUI();
    } catch (e) { /* el sondeo nunca debe romper la app */ }
  }
  function bindAudioEvents() {
    try {
      var audio = $('audio'); if (!audio || audio.__fiestaBound) return;
      audio.__fiestaBound = true;
      audio.addEventListener('ended', function () {
        try {
          var st = sessionStatus();
          if (st.isLeader && st.connected) applyWinnerNow('ended-fallback');
        } catch (e) {}
      });
    } catch (e) {}
  }
  function buildUI() {
    try {
      var hasCss = !!document.querySelector('link[href*="fiesta.css"]');
      if (!hasCss) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = './fiesta.css';
        document.head.appendChild(css);
      }
    } catch (e) {}
    try { deviceId(); } catch (e) {}
    try { ensureUI(); bindAudioEvents(); } catch (e) {}
    browserState.timers.push(setInterval(tick, 800));
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
    trackKeyFor: trackKeyFor, tracksMatchKey: tracksMatchKey, findLocalTrack: findLocalTrack,
    createState: createState, cloneState: cloneState,
    propose: propose, vote: vote, retractProposal: retractProposal,
    tally: tally, countVotes: countVotes, votersFor: votersFor, myVote: myVote,
    pickWinner: pickWinner, applyWinner: applyWinner, clearRound: clearRound,
    serializeState: serializeState, parseStatePayload: parseStatePayload,
    createFiestaMessage: createFiestaMessage, validateFiestaMessage: validateFiestaMessage,
    applyRemoteMessage: applyRemoteMessage,
    PROTOCOL_VERSION: PROTOCOL_VERSION, QUEUE_AHEAD_S: QUEUE_AHEAD_S,
    MAX_PROPOSALS: MAX_PROPOSALS, FIESTA_MESSAGE_TYPES: FIESTA_MESSAGE_TYPES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window !== 'undefined') {
    window.__fiesta = {
      pure: pure,
      open: function () { try { openModal(); } catch (e) {} },
      close: function () { try { closeModal(); } catch (e) {} },
      status: function () {
        return { mode: transportMode(), session: sessionStatus(),
                 round: fiestaState().round, proposals: tally(fiestaState()),
                 myVote: myVote(fiestaState(), deviceId()),
                 lastResult: fiestaState().lastResult };
      },
      propose: function (track) { try { return doPropose(track); } catch (e) { return false; } },
      vote: function (key) { try { return doVote(key); } catch (e) { return false; } },
      retractVote: function () { try { return doVote(null); } catch (e) { return false; } },
      retractProposal: function (key) { try { return doRetractProposal(key); } catch (e) { return false; } },
      clearRound: function () { try { return doClearRound(); } catch (e) { return false; } },
      applyWinnerNow: function () { try { return applyWinnerNow('manual'); } catch (e) { return { ok: false, error: 'exception' }; } },
      onChannelMessage: onChannelMessage,
      send: function (type, fields) { try { return sendFiesta(type, fields); } catch (e) { return false; } }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
