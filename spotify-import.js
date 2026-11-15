/* spotify-import.js — Importar playlist desde Spotify (reproductor-de-musica v3.5.0, módulo aparte)
 *
 * Qué hace: crea una playlist local a partir de una playlist de Spotify,
 * PERO solo con las canciones que el usuario YA tiene en su biblioteca.
 * No hay clave de API de Spotify ni acceso a su catálogo, y este módulo
 * NO descarga la playlist completa ni los audios: Spotify no deja leer
 * una playlist desde el navegador (CORS), así que el flujo real es
 * pegar la lista en texto (una canción por línea, "Artista - Título").
 *
 * Flujo:
 *   1) El usuario pega un enlace de Spotify. Se extrae y muestra el ID
 *      (extractSpotifyId). Se intenta leer la lista pública con fetch
 *      a la página de incrustación (sin clave, sin servidor): casi
 *      siempre el navegador lo bloquea por CORS, y si la página llega
 *      pero no trae las canciones en un formato legible, tampoco se
 *      puede usar. En ambos casos la pantalla lo dice claro:
 *      "Spotify no deja leer la lista desde el navegador, pega la
 *      lista en texto" — nunca se promete la descarga completa.
 *   2) El usuario pega la lista en texto. Cada línea se parsea
 *      (parseTextLine): número inicial opcional ("1. Artista -
 *      Título"), guion/en dash/em dash, "Artista - Título" o
 *      "Título - Artista" (el emparejamiento prueba los dos órdenes
 *      y se queda con el que coincide), o solo el título.
 *   3) Cada línea se empareja SOLO con la biblioteca local, por
 *      título+artista normalizados (matchImportedLines): minúsculas,
 *      sin acentos, sin "feat." ni paréntesis. Se crea la playlist
 *      con las que coinciden y se listan las que faltan
 *      ("✗ Te falta"). Sin los audios no se puede reproducir lo que
 *      falta, y la pantalla lo dice así. Nunca se inventan canciones
 *      ni duraciones: lo que no está en la biblioteca no entra.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico, como
 * compartir.js / mini.js. Lee las pistas SOLO a través de
 * window.__rpmApp (getTracks / getPackState / applyPackState / toast /
 * render, ya expuestos por app/index.html) y, si no está disponible,
 * lee IndexedDB en solo lectura (base 'reproductor-musica-local',
 * almacenes 'tracks' y 'meta'/'packState') para el emparejamiento.
 * Guardar la playlist exige __rpmApp (applyPackState). Si el módulo
 * falla al cargar, la app sigue funcionando: todo el init va en
 * try/catch y el botón solo se añade si existe #plActions.
 * Ver WIRING.md.
 *
 * Suposiciones (confirmadas leyendo app/index.html; detalle en
 * WIRING.md):
 *   - Playlist: {id, name, trackIds:[], updatedAt}. Los id de pista
 *     son 't'+... locales; por eso el emparejamiento NO usa id de
 *     Spotify, usa título+artista normalizados.
 *   - Pista: {id, name, title, artist, duration, audioHash}.
 *     Se usa title (o name si no hay title) y artist.
 *   - Las playlists son del perfil activo: packState.playlists es la
 *     del perfil activo, y profileStore[activeProfileId].playlists
 *     es la misma lista; se prefiere esta última si existe (igual
 *     que compartir.js).
 *   - La app ya tiene su propio "Crear desde lista de texto"
 *     (btnTextList / matchTextLine, con puntuación tolerante). Este
 *     módulo NO lo toca ni lo duplica: añade el paso del enlace de
 *     Spotify, el aviso honesto sobre CORS y el marcado explícito
 *     tiene/falta con el orden artista-título detectado por
 *     coincidencia. Su normalización es más estricta (exacta tras
 *     normalizar) para no emparejar por parecido.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_LINES = 500;       // tope de líneas pegadas por importación
  var MAX_NAME_LEN = 60;     // igual que maxlength del modal de playlist
  var MAX_FIELD_LEN = 500;   // saneado de artista/título pegados
  var DB_NAME = 'reproductor-musica-local';
  var DB_STORE_TRACKS = 'tracks';
  var DB_STORE_META = 'meta';
  // Mensaje honesto que se muestra siempre que no se puede leer la
  // lista desde Spotify (CORS, error de red o página sin canciones
  // legibles). No se promete descargar la playlist completa.
  var CORS_MESSAGE = 'Spotify no deja leer la lista desde el navegador, pega la lista en texto.';
  // Los ID de Spotify son 22 caracteres base62.
  var SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

  /* ================= Utilidades puras ================= */

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  // Normalización para emparejar título/artista: minúsculas, sin
  // acentos, sin contenido entre paréntesis/corchetes ("(Remastered)",
  // "(feat. X)", "[Explicit]"), sin la cláusula "feat./ft./featuring"
  // que quede fuera de paréntesis ("Canción feat. X" -> "cancion"),
  // sin puntuación sobrante y con espacios colapsados. No quita
  // palabras como "the" ni inventa nada: dos títulos distintos
  // siguen siendo distintos.
  function normalizeForMatch(s) {
    var t = normText(s);
    if (!t) return '';
    // Quita paréntesis y corchetes con su contenido (puede haber varios).
    var prev = null;
    while (prev !== t) {
      prev = t;
      t = t.replace(/\([^()]*\)/g, ' ').replace(/\[[^\[\]]*\]/g, ' ');
    }
    // "feat. / ft. / featuring" y lo que sigue (artista invitado).
    t = t.replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/g, ' ');
    // Puntuación y símbolos que no distinguen canciones; el guion
    // interior ("hip-hop") se vuelve espacio, igual en ambos lados.
    t = t.replace(/[''""«»]/g, '').replace(/[^a-z0-9 ]/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function trackTitle(t) {
    return String((t && (t.title || t.name)) || '').trim();
  }
  function trackArtist(t) {
    return String((t && t.artist) || '').trim();
  }

  /* ================= 1) Enlace de Spotify ================= */

  // Extrae el ID de un enlace de Spotify. Acepta:
  //   https://open.spotify.com/playlist/<id> (con ?si=..., /intl-es/,
  //     barra final o parámetros extra)
  //   https://open.spotify.com/track/<id> (kind 'track': se extrae el
  //     ID, pero NO es una playlist; la UI lo dice y no sigue)
  //   spotify:playlist:<id> / spotify:track:<id>
  //   un ID suelto de 22 caracteres base62
  // Devuelve {ok:true, id, kind:'playlist'|'track'} o
  // {ok:false, error}. Los enlaces de álbum, episodio, artista o
  // usuario se rechazan: no son una playlist ni una canción.
  function extractSpotifyId(input) {
    if (typeof input !== 'string') return { ok: false, error: 'Pega un enlace de Spotify.' };
    var raw = input.trim();
    if (!raw) return { ok: false, error: 'Pega un enlace de Spotify.' };

    var m = raw.match(/^spotify:(playlist|track):([A-Za-z0-9]+)\s*$/);
    if (m) {
      if (!SPOTIFY_ID_RE.test(m[2])) {
        return { ok: false, error: 'Ese enlace de Spotify no trae un identificador válido.' };
      }
      return { ok: true, id: m[2], kind: m[1] };
    }

    if (SPOTIFY_ID_RE.test(raw)) return { ok: true, id: raw, kind: 'playlist' };

    // URL: se acepta open.spotify.com con o sin subdominio de idioma
    // (/intl-es/) y con cualquier query (?si=..., ?utm_...).
    var url;
    try {
      url = new URL(raw.indexOf('://') === -1 ? 'https://' + raw : raw);
    } catch (e) {
      return { ok: false, error: 'Eso no parece un enlace de Spotify.' };
    }
    if (url.hostname !== 'open.spotify.com' && url.hostname !== 'www.open.spotify.com') {
      return { ok: false, error: 'Eso no es un enlace de open.spotify.com.' };
    }
    var parts = url.pathname.split('/').filter(function (p) { return !!p; });
    // Quita el segmento de idioma: /intl-es/playlist/<id>.
    if (parts.length && /^intl-[a-z]{2}$/i.test(parts[0])) parts.shift();
    if (parts.length < 2) {
      return { ok: false, error: 'Ese enlace no apunta a una playlist de Spotify.' };
    }
    var kind = parts[0];
    if (kind !== 'playlist' && kind !== 'track') {
      return { ok: false, error: 'Ese enlace es de un ' + kind + ' de Spotify, no de una playlist.' };
    }
    var id = parts[1];
    if (!SPOTIFY_ID_RE.test(id)) {
      return { ok: false, error: 'Ese enlace de Spotify no trae un identificador válido.' };
    }
    return { ok: true, id: id, kind: kind };
  }

  function spotifyPlaylistUrl(id) {
    return 'https://open.spotify.com/playlist/' + id;
  }

  // Extrae canciones de la página de incrustación de una playlist, si
  // el navegador llegó a leerla. La página incrusta los datos como
  // objetos JSON {"name":"Título","artists":[{"name":"Artista"...}]}.
  // Solo se devuelve lo que la página trae de verdad: si no hay
  // ninguna coincidencia, la lista está vacía y el llamador debe decir
  // que no se pudo leer. No inventa canciones ni duraciones.
  function parseSpotifyEmbedTracks(html) {
    if (typeof html !== 'string' || !html) return [];
    var out = [], seen = {};
    // "name":"Titulo","artists":[{"name":"Artista" — con escapes JSON.
    var re = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"artists"\s*:\s*\[\s*\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    var m;
    function unescapeJson(s) {
      try { return JSON.parse('"' + s + '"'); } catch (e) { return s; }
    }
    while ((m = re.exec(html)) !== null) {
      var title = unescapeJson(m[1]).trim();
      var artist = unescapeJson(m[2]).trim();
      if (!title) continue;
      var key = normalizeForMatch(title) + '|' + normalizeForMatch(artist);
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ title: title.slice(0, MAX_FIELD_LEN), artist: artist.slice(0, MAX_FIELD_LEN) });
    }
    return out;
  }

  // Intento best-effort de leer una playlist pública, SIN clave y SIN
  // servidor. fetchImpl es fetch por defecto (inyectable en pruebas).
  // Casi siempre falla: el navegador bloquea la petición por CORS
  // (open.spotify.com no envía Access-Control-Allow-Origin) y eso NO
  // es un error de la app ni de la conexión. Devuelve siempre
  // {ok:false, reason, message} salvo que la página llegue Y traiga
  // canciones legibles, en cuyo caso {ok:true, tracks:[{title,artist}]}.
  // reason: 'cors' (TypeError de red/CORS) | 'http' (no-OK) |
  // 'unparsed' (llegó pero sin canciones legibles) | 'no-fetch'.
  function tryFetchSpotifyPlaylist(id, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) {
      return Promise.resolve({ ok: false, reason: 'no-fetch', message: CORS_MESSAGE });
    }
    var url = 'https://open.spotify.com/embed/playlist/' + id;
    var p;
    try {
      p = Promise.resolve(doFetch(url, { headers: { Accept: 'text/html' } }));
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'cors', message: CORS_MESSAGE });
    }
    return p.then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, reason: 'http', message: CORS_MESSAGE };
      }
      return res.text().then(function (html) {
        var tracks = parseSpotifyEmbedTracks(html);
        if (!tracks.length) {
          return { ok: false, reason: 'unparsed', message: CORS_MESSAGE };
        }
        return { ok: true, tracks: tracks };
      });
    }).catch(function (err) {
      // TypeError es lo que lanza el navegador ante un bloqueo CORS
      // o un fallo de red; cualquier otro error se trata igual: no
      // se puede leer la lista desde aquí.
      void err;
      return { ok: false, reason: 'cors', message: CORS_MESSAGE };
    });
  }

  /* ================= 2) Lista en texto ================= */

  // Quita el número inicial de una línea: "1. ", "12) ", "3 - " no
  // (el guion con espacios es separador, no número), "#4 ", "(5) ".
  function stripLineNumber(s) {
    return String(s).replace(/^\s*(?:#\s*\d+\s+|\(\s*\d+\s*\)\s+|\d{1,3}\s*[.)\]]\s+)/, '');
  }

  // Divide una línea en dos partes por el primer separador con
  // espacios o guion largo: " - ", " – ", " — " o "–"/"—" sin espacios.
  // El guion pegado a una palabra ("hip-hop") NO separa.
  function splitArtistTitle(s) {
    var m = s.match(/^(.+?)\s*(?:—|–|\s+-\s+)\s*(.+)$/);
    if (!m) return null;
    return [m[1].trim(), m[2].trim()];
  }

  // Parsea una línea. Devuelve null si está vacía o no trae nada útil.
  //   {raw, a, b, titleOnly}
  // a/b son las dos partes en el orden escrito; el emparejamiento
  // prueba a=artista,b=título y al revés, así que parsear no decide
  // el orden: lo decide la coincidencia con la biblioteca.
  // También quita una duración final ("3:45") que Spotify suele
  // pegar al copiar, y viñetas iniciales ("- ", "• ").
  function parseTextLine(line) {
    if (typeof line !== 'string') return null;
    var raw = line.trim();
    if (!raw) return null;
    var s = stripLineNumber(raw);
    s = s.replace(/^\s*(?:[-•·*]\s+)/, '');
    // Duración final pegada al copiar desde Spotify ("Artista - Título 3:45").
    s = s.replace(/\s+\d{1,2}:\d{2}\s*$/, '').trim();
    if (!s) return null;
    var parts = splitArtistTitle(s);
    if (!parts) {
      return { raw: raw, a: s.slice(0, MAX_FIELD_LEN), b: '', titleOnly: true };
    }
    return {
      raw: raw,
      a: parts[0].slice(0, MAX_FIELD_LEN),
      b: parts[1].slice(0, MAX_FIELD_LEN),
      titleOnly: false,
    };
  }

  // Parsea un texto entero (una canción por línea). Devuelve
  // {lines:[...parseados...], skipped} donde skipped cuenta las
  // líneas vacías. Se limita a MAX_LINES líneas útiles.
  function parseTextList(text) {
    if (typeof text !== 'string') return { lines: [], skipped: 0 };
    var rawLines = text.split(/\r\n|\r|\n/);
    var lines = [], skipped = 0, truncated = 0;
    rawLines.forEach(function (raw) {
      var parsed = parseTextLine(raw);
      if (!parsed) { skipped++; return; }
      if (lines.length >= MAX_LINES) { truncated++; return; }
      lines.push(parsed);
    });
    return { lines: lines, skipped: skipped, truncated: truncated };
  }

  /* ================= 3) Emparejamiento con la biblioteca ================= */

  // Índice de la biblioteca: clave exacta título|artista normalizados
  // y, para el rescate por título solo, título normalizado -> pistas.
  function buildLibraryIndex(tracks) {
    var byExact = new Map(), byTitle = new Map();
    (tracks || []).forEach(function (t) {
      if (!t) return;
      var titleN = normalizeForMatch(trackTitle(t));
      if (!titleN) return;
      var artistN = normalizeForMatch(trackArtist(t));
      var exactKey = titleN + '|' + artistN;
      if (!byExact.has(exactKey)) byExact.set(exactKey, t);
      if (!byTitle.has(titleN)) byTitle.set(titleN, []);
      byTitle.get(titleN).push(t);
    });
    return { byExact: byExact, byTitle: byTitle };
  }

  // Empareja un par (artistQ, titleQ) contra el índice. Devuelve
  // {track, via} con via 'exact' | 'title-only' | null. El rescate
  // por título solo solo se acepta si ese título es ÚNICO en la
  // biblioteca: si dos artistas tienen el mismo título, no se adivina.
  function matchPair(index, artistQ, titleQ) {
    var titleN = normalizeForMatch(titleQ);
    if (!titleN) return { track: null, via: null };
    var artistN = normalizeForMatch(artistQ);
    if (artistN) {
      var hit = index.byExact.get(titleN + '|' + artistN);
      if (hit) return { track: hit, via: 'exact' };
    }
    var cands = index.byTitle.get(titleN) || [];
    if (cands.length === 1) return { track: cands[0], via: 'title-only' };
    return { track: null, via: null };
  }

  // Empareja todas las líneas contra la biblioteca.
  // Cada item: {line, artist, title, have, localId, via, duplicate}
  //   via: 'exact' (Artista - Título tal cual) | 'swapped' (la línea
  //     venía Título - Artista) | 'title-only' (solo el título, único
  //     en la biblioteca) | null (falta).
  //   duplicate: true si esa canción ya había coincidido en una línea
  //     anterior (la playlist solo la lleva una vez).
  // haveCount cuenta líneas con coincidencia; distinctCount, canciones
  // distintas que entrarán en la playlist; missingCount, las que faltan.
  function matchImportedLines(parsedLines, tracks) {
    var index = buildLibraryIndex(tracks);
    var seenIds = {};
    var items = [], haveCount = 0, distinctCount = 0;
    (parsedLines || []).forEach(function (parsed) {
      var item = {
        line: parsed.raw, artist: '', title: '',
        have: false, localId: null, via: null, duplicate: false,
      };
      var res = null;
      if (parsed.titleOnly) {
        res = matchPair(index, '', parsed.a);
        item.title = parsed.a;
      } else {
        // Primero en el orden escrito (Artista - Título)...
        res = matchPair(index, parsed.a, parsed.b);
        if (res.track) {
          item.artist = parsed.a; item.title = parsed.b;
          item.via = res.via === 'title-only' ? 'title-only' : 'exact';
        } else {
          // ...y si no, al revés (Título - Artista).
          var swapped = matchPair(index, parsed.b, parsed.a);
          if (swapped.track) {
            res = swapped;
            item.artist = parsed.b; item.title = parsed.a;
            item.via = swapped.via === 'title-only' ? 'title-only' : 'swapped';
          } else {
            item.artist = parsed.a; item.title = parsed.b;
          }
        }
      }
      if (parsed.titleOnly && res.track && res.via === 'title-only') item.via = 'title-only';
      if (parsed.titleOnly && res.track && res.via === 'exact') item.via = 'exact';
      if (res && res.track) {
        item.have = true;
        item.localId = res.track.id;
        haveCount++;
        if (seenIds[res.track.id]) item.duplicate = true;
        else { seenIds[res.track.id] = true; distinctCount++; }
      }
      items.push(item);
    });
    return {
      items: items,
      haveCount: haveCount,
      distinctCount: distinctCount,
      missingCount: items.length - haveCount,
      total: items.length,
    };
  }

  // Ids de pista para la playlist, en el orden de la lista pegada,
  // sin duplicados (la primera aparición manda).
  function matchedTrackIds(matched) {
    var ids = [];
    (matched.items || []).forEach(function (it) {
      if (it.have && it.localId && ids.indexOf(it.localId) === -1) ids.push(it.localId);
    });
    return ids;
  }

  // Construye la playlist (objeto puro, sin escribir nada): nombre
  // único frente a las existentes ("Nombre (2)", "(3)"...), id local
  // 'p'+... como createPlaylist en app/index.html. opts: {now, rand}
  // para hacerla determinista en pruebas.
  function buildPlaylistFromMatches(name, matched, existingPlaylists, opts) {
    var o = opts || {};
    var now = typeof o.now === 'number' ? o.now : Date.now();
    var rand = typeof o.rand === 'function' ? o.rand : Math.random;
    var base = String(name || 'Playlist de Spotify').trim().slice(0, MAX_NAME_LEN) || 'Playlist de Spotify';
    var taken = {};
    (existingPlaylists || []).forEach(function (p) {
      if (p && p.name) taken[normText(p.name)] = true;
    });
    var finalName = base, n = 2;
    while (taken[normText(finalName)]) {
      finalName = base.slice(0, MAX_NAME_LEN - 4) + ' (' + n + ')';
      n++;
    }
    return {
      id: 'p' + now.toString(36) + rand().toString(36).slice(2, 7),
      name: finalName,
      trackIds: matchedTrackIds(matched),
      updatedAt: now,
    };
  }

  /* ================= Parte de navegador (DOM) =================
   * Todo aquí es defensivo: si falta un elemento o la app aún no está
   * lista, el módulo no hace nada y la app sigue igual. */
  var doc = (typeof document !== 'undefined') ? document : null;
  var win = (typeof window !== 'undefined') ? window : global;

  function getApp() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; }
    catch (e) { return null; }
  }
  function appToast(msg) {
    var app = getApp();
    if (app && typeof app.toast === 'function') { try { app.toast(msg); return; } catch (e) {} }
    if (!doc) return;
    var el = doc.getElementById('spotToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'spotToast'; el.className = 'spot-toast'; el.setAttribute('role', 'status');
      doc.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ---------- Lectura de la biblioteca (igual que compartir.js) ---------- */
  function pickPlaylists(packState) {
    if (!packState || typeof packState !== 'object') return { playlists: [], selectedId: null };
    var ps = packState.profileStore;
    var active = packState.activeProfileId;
    if (ps && active && ps[active] && Array.isArray(ps[active].playlists)) {
      return {
        playlists: ps[active].playlists,
        selectedId: ps[active].selectedPlaylistId || packState.selectedPlaylistId || null,
      };
    }
    return {
      playlists: Array.isArray(packState.playlists) ? packState.playlists : [],
      selectedId: packState.selectedPlaylistId || null,
    };
  }
  function readLibraryFromIDB() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME); }
      catch (e) { resolve(null); return; }
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        var db = req.result, out = { tracks: [], packState: null }, pending = 2, settled = false;
        function fin() {
          if (--pending === 0 && !settled) {
            settled = true;
            try { db.close(); } catch (e) {}
            resolve(out);
          }
        }
        try {
          var tx1 = db.transaction(DB_STORE_TRACKS, 'readonly');
          var r1 = tx1.objectStore(DB_STORE_TRACKS).getAll();
          r1.onsuccess = function () { out.tracks = r1.result || []; fin(); };
          r1.onerror = fin;
        } catch (e) { fin(); }
        try {
          var tx2 = db.transaction(DB_STORE_META, 'readonly');
          var r2 = tx2.objectStore(DB_STORE_META).get('packState');
          r2.onsuccess = function () { out.packState = (r2.result && r2.result.value) || null; fin(); };
          r2.onerror = fin;
        } catch (e) { fin(); }
      };
    });
  }
  function getLocalTracks() {
    var app = getApp();
    if (app && typeof app.getTracks === 'function') {
      try { return Promise.resolve(app.getTracks() || []); } catch (e) {}
    }
    return readLibraryFromIDB().then(function (d) { return d ? d.tracks : []; });
  }

  /* ---------- Modal (reusa .modal-overlay/.modal de la app) ---------- */
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function makeOverlay() {
    var ov = el('div', 'modal-overlay spot-overlay');
    var box = el('div', 'modal spot-modal');
    ov.appendChild(box);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeOverlay(ov); });
    doc.body.appendChild(ov);
    return { ov: ov, box: box };
  }
  function openOverlay(ov) { ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); }
  function closeOverlay(ov) { ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); }
  function modalActions(buttons) {
    var row = el('div', 'modal-actions spot-actions');
    buttons.forEach(function (b) {
      var btn = el('button', 'btn small' + (b.primary ? ' primary' : ''), b.label);
      btn.type = 'button';
      if (b.id) btn.id = b.id;
      if (b.disabled) btn.disabled = true;
      btn.addEventListener('click', b.onClick);
      row.appendChild(btn);
    });
    return row;
  }

  var spotModal = null;
  var lastMatched = null;   // último emparejamiento (para "Crear playlist")
  var lastParsedCount = 0;

  function renderResults(wrap, matched) {
    wrap.innerHTML = '';
    if (!matched || !matched.items.length) {
      wrap.appendChild(el('p', 'spot-sub', 'Todavía no hay vista previa: pega la lista y toca «Ver qué tengo».'));
      return;
    }
    var summary = el('p', 'spot-sub',
      'Tienes ' + matched.haveCount + ' de ' + matched.total +
      (matched.total === 1 ? ' canción' : ' canciones') +
      (matched.missingCount ? ' · te faltan ' + matched.missingCount + '.' : ' · ¡las tienes todas!') +
      (matched.distinctCount !== matched.haveCount
        ? ' (' + matched.distinctCount + ' distintas: hay líneas repetidas, la playlist solo lleva cada canción una vez.)' : ''));
    wrap.appendChild(summary);
    var ul = el('ul', 'spot-list');
    matched.items.forEach(function (it) {
      var li = el('li', 'spot-row' + (it.have ? ' have' : ' missing'));
      var main = el('div', 'spot-row-main');
      main.appendChild(el('span', 'spot-row-title', it.title || it.line));
      main.appendChild(el('span', 'spot-row-meta',
        (it.artist ? it.artist : 'sin artista') +
        (it.duplicate ? ' · repetida' : '') +
        (it.via === 'swapped' ? ' · la línea venía como «Título - Artista»' : '') +
        (it.via === 'title-only' ? ' · coincidió solo por el título' : '')));
      li.appendChild(main);
      li.appendChild(el('span', 'spot-badge ' + (it.have ? 'have' : 'missing'),
        it.have ? '✓ La tienes' : '✗ Te falta'));
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    wrap.appendChild(el('p', 'spot-warn',
      '⚠ Solo entran en la playlist las canciones que ya tienes en este dispositivo. ' +
      'Sin los archivos de audio no se puede reproducir lo que falta: para escucharlo, añade esos archivos a tu biblioteca.'));
  }

  function openImportModal() {
    if (!doc) return;
    if (!spotModal) spotModal = makeOverlay();
    var box = spotModal.box;
    box.innerHTML = '';
    box.appendChild(el('h3', null, 'Importar playlist desde Spotify'));
    box.appendChild(el('p', 'spot-warn',
      '⚠ Esto NO descarga la playlist completa ni sus audios: no hay clave de Spotify y Spotify no deja leer una playlist desde el navegador. ' +
      'Lo que hace es crear una playlist con las canciones de esa lista que YA tienes en tu biblioteca, y decirte cuáles te faltan.'));

    // --- Paso 1: enlace ---
    box.appendChild(el('label', 'spot-label', '1 · Enlace de la playlist de Spotify (opcional)'));
    var linkInput = el('input', 'spot-input');
    linkInput.id = 'spotLinkInput'; linkInput.type = 'url'; linkInput.placeholder = 'https://open.spotify.com/playlist/…';
    linkInput.setAttribute('autocomplete', 'off');
    box.appendChild(linkInput);
    var linkStatus = el('p', 'spot-sub spot-status', 'Si el enlace es de una canción (track), se extrae su ID pero no es una playlist: pega la lista en texto igualmente.');
    box.appendChild(linkStatus);
    var readBtn = el('button', 'btn small', 'Intentar leer la lista');
    readBtn.type = 'button';
    box.appendChild(readBtn);

    // --- Paso 2: lista en texto ---
    box.appendChild(el('label', 'spot-label', '2 · Lista en texto (una canción por línea)'));
    box.appendChild(el('p', 'spot-sub',
      'Formato «Artista - Título» (también vale «Título - Artista»: se detecta por coincidencia con tu biblioteca) o solo el título. ' +
      'Las líneas numeradas («1. Artista - Título») también valen.'));
    var nameInput = el('input', 'spot-input');
    nameInput.id = 'spotNameInput'; nameInput.type = 'text'; nameInput.maxLength = MAX_NAME_LEN;
    nameInput.placeholder = 'Nombre de la playlist (opcional)';
    box.appendChild(nameInput);
    var textInput = el('textarea', 'spot-text');
    textInput.id = 'spotTextInput'; textInput.rows = 8;
    textInput.placeholder = 'Artista - Título\nArtista - Título\n…';
    box.appendChild(textInput);

    var resultsWrap = el('div', 'spot-results');
    box.appendChild(resultsWrap);
    renderResults(resultsWrap, null);

    function currentParsed() {
      var parsed = parseTextList(textInput.value);
      lastParsedCount = parsed.lines.length;
      return parsed;
    }
    function preview() {
      var parsed = currentParsed();
      if (!parsed.lines.length) {
        appToast('Pega al menos una línea con una canción.');
        return Promise.resolve(null);
      }
      return getLocalTracks().then(function (tracks) {
        if (!tracks.length) {
          appToast('Tu biblioteca está vacía: primero añade canciones.');
          return null;
        }
        lastMatched = matchImportedLines(parsed.lines, tracks);
        renderResults(resultsWrap, lastMatched);
        return lastMatched;
      }).catch(function () {
        appToast('No se pudo leer tu biblioteca. Inténtalo de nuevo.');
        return null;
      });
    }

    readBtn.addEventListener('click', function () {
      var res = extractSpotifyId(linkInput.value);
      if (!res.ok) { linkStatus.textContent = res.error; return; }
      if (res.kind === 'track') {
        linkStatus.textContent = 'Ese enlace es de una canción, no de una playlist (ID: ' + res.id + '). Pega la lista en texto abajo.';
        return;
      }
      linkStatus.textContent = 'ID de la playlist: ' + res.id + ' · Intentando leerla…';
      readBtn.disabled = true;
      tryFetchSpotifyPlaylist(res.id).then(function (r) {
        readBtn.disabled = false;
        if (!r.ok) {
          linkStatus.textContent = r.message +
            (r.reason === 'http' ? ' (Spotify devolvió un error al pedir la lista.)' : '');
          return;
        }
        var lines = r.tracks.map(function (t) { return t.artist ? t.artist + ' - ' + t.title : t.title; });
        textInput.value = lines.join('\n');
        linkStatus.textContent = 'Se pudieron leer ' + lines.length + ' canciones de la playlist. Revisa la lista abajo y toca «Ver qué tengo».';
        preview();
      });
    });

    var createBtn = null;
    var actions = modalActions([
      {
        label: 'Ver qué tengo', primary: true, onClick: function () { preview(); },
      },
      {
        label: 'Crear playlist con las que tengo', id: 'spotCreateBtn', onClick: function () {
          saveMatchedAsPlaylist(nameInput.value);
        },
      },
      { label: 'Cerrar', onClick: function () { closeOverlay(spotModal.ov); } },
    ]);
    createBtn = actions.querySelector('#spotCreateBtn');
    box.appendChild(actions);
    openOverlay(spotModal.ov);
    linkInput.focus();
  }

  function saveMatchedAsPlaylist(name) {
    var app = getApp();
    if (!lastMatched || !lastMatched.haveCount) {
      appToast('Primero toca «Ver qué tengo»: todavía no hay ninguna canción de la lista en tu biblioteca.');
      return;
    }
    if (!app || typeof app.getPackState !== 'function' || typeof app.applyPackState !== 'function') {
      appToast('Este dispositivo no permite guardar la playlist importada.');
      return;
    }
    var ids = matchedTrackIds(lastMatched);
    app.getPackState().then(function (ps) {
      ps = ps || {};
      var picked = pickPlaylists(ps);
      var pl = buildPlaylistFromMatches(name, lastMatched, picked.playlists);
      var next = picked.playlists.concat([pl]);
      ps.playlists = next;
      if (ps.profileStore && ps.activeProfileId && ps.profileStore[ps.activeProfileId]) {
        ps.profileStore[ps.activeProfileId].playlists = next;
        ps.profileStore[ps.activeProfileId].selectedPlaylistId = pl.id;
      }
      ps.selectedPlaylistId = pl.id;
      return app.applyPackState(ps).then(function () {
        appToast('Playlist «' + pl.name + '» creada con ' + ids.length +
          (ids.length === 1 ? ' canción' : ' canciones') +
          (lastMatched.missingCount ? ' · te faltan ' + lastMatched.missingCount : ' · ¡las tienes todas!'));
        if (spotModal) closeOverlay(spotModal.ov);
        if (typeof app.render === 'function') { try { app.render(); } catch (e) {} }
        lastMatched = null;
      });
    }).catch(function () {
      appToast('No se pudo guardar la playlist. Inténtalo de nuevo.');
    });
  }

  /* ---------- Botón "Importar de Spotify" en la vista de playlists ---------- */
  function ensureImportButton() {
    if (!doc) return;
    var actions = doc.getElementById('plActions');
    if (!actions) return;
    if (doc.getElementById('btnSpotifyImport')) return;
    var btn = el('button', 'btn small', 'Importar de Spotify');
    btn.id = 'btnSpotifyImport'; btn.type = 'button';
    btn.title = 'Crear una playlist con las canciones de una lista de Spotify que ya tengas en tu biblioteca';
    btn.addEventListener('click', openImportModal);
    var share = doc.getElementById('btnPlShare');
    if (share && share.parentNode === actions) actions.insertBefore(btn, share);
    else actions.appendChild(btn);
  }

  function init() {
    if (!doc) return;
    try {
      ensureImportButton();
      var view = doc.getElementById('viewPlaylists');
      if (view && typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () { ensureImportButton(); })
          .observe(view, { childList: true, subtree: true });
      }
      doc.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && spotModal) closeOverlay(spotModal.ov);
      });
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[spotify-import] desactivado por error en el inicio:', e);
      }
    }
  }

  /* ================= API pública ================= */
  var api = {
    VERSION: VERSION,
    MAX_LINES: MAX_LINES,
    MAX_NAME_LEN: MAX_NAME_LEN,
    CORS_MESSAGE: CORS_MESSAGE,
    normalizeForMatch: normalizeForMatch,
    normText: normText,
    extractSpotifyId: extractSpotifyId,
    spotifyPlaylistUrl: spotifyPlaylistUrl,
    parseSpotifyEmbedTracks: parseSpotifyEmbedTracks,
    tryFetchSpotifyPlaylist: tryFetchSpotifyPlaylist,
    stripLineNumber: stripLineNumber,
    splitArtistTitle: splitArtistTitle,
    parseTextLine: parseTextLine,
    parseTextList: parseTextList,
    buildLibraryIndex: buildLibraryIndex,
    matchPair: matchPair,
    matchImportedLines: matchImportedLines,
    matchedTrackIds: matchedTrackIds,
    buildPlaylistFromMatches: buildPlaylistFromMatches,
    openImportModal: openImportModal,
    saveMatchedAsPlaylist: saveMatchedAsPlaylist,
    init: init,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try { global.__rpmSpotifyImport = api; } catch (e) {}
    if (doc) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
