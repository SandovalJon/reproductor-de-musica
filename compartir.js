/* compartir.js — Compartir playlist (reproductor-de-musica v3.4.0, módulo aparte)
 *
 * Qué hace: genera un enlace copiable con una playlist (título, artista,
 * duración y huella de cada pista) codificado en el propio enlace
 * (fragmento #share=<base64url del JSON>, sin servidor y sin subir
 * audios), con código QR local, y al abrir ese enlace en otro
 * dispositivo muestra la playlist marcando qué canciones ya tiene ese
 * dispositivo (mismo audioHash) y cuáles faltan.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico, como
 * lyrics.js / karaoke.js. Lee las playlists y las pistas SOLO a través
 * de window.__rpmApp (getPackState / getTracks / toast / applyPackState,
 * ya expuestos por app/index.html) y, si no está disponible, lee
 * IndexedDB en solo lectura (base 'reproductor-musica-local', almacenes
 * 'tracks' y 'meta'/'packState'). Si el módulo falla al cargar, la app
 * sigue funcionando: todo el init va en try/catch y el botón solo se
 * añade si existe #plActions. Ver WIRING.md.
 *
 * Formato del enlace (v1):
 *   <origen y ruta de la app>#share=<base64url(UTF-8(JSON))>
 *   JSON: {"v":1,"n":"Nombre playlist",
 *          "t":[["Título","Artista",183,"~base64url"|null], ...]}
 *   - La duración va en segundos enteros (Math.round, igual que
 *     trackKey() en src/library/track-meta.js).
 *   - El audioHash (96 hex en la app: 24 segmentos x 4) viaja
 *     compactado: "~" + base64url de sus bytes (65 caracteres en vez
 *     de 96). Un hash que no sea hex de longitud par viaja tal cual.
 *   - Solo viajan metadatos. NUNCA el audio: sin los archivos en el
 *     otro dispositivo no se puede reproducir lo que falta, y la
 *     pantalla de recepción lo dice así.
 *
 * Código QR: encoder QR propio, sin librerías ni internet, modo Byte,
 * nivel de corrección L, versiones 1-5, máscara 0 (válida: la máscara
 * solo cambia qué módulos se invierten y la info de formato la
 * refleja). Capacidad máxima: 106 bytes (versión 5-L). Un enlace real
 * con huellas de 96 hex casi nunca cabe (una sola canción ya ronda
 * los 130-200 caracteres de URL); en ese caso la UI lo dice y ofrece
 * copiar el enlace. El encoder es válido para textos cortos y está
 * verificado en las pruebas (bits de formato conocidos, patrones de
 * búsqueda, divisibilidad Reed-Solomon) y contra la librería de
 * referencia `segno` durante el desarrollo.
 *
 * Regla de marcado tiene/falta (markShared):
 *   1) mismo audioHash (insensible a mayúsculas) -> la tiene (vía hash);
 *   2) si la pista compartida NO trae hash, o la candidata local NO
 *      tiene hash calculado, se acepta título+artista+duración
 *      redondeada (normalizado: minúsculas, espacios colapsados);
 *   3) si AMBAS tienen hash y son distintos -> falta (aunque coincidan
 *      título/artista/duración: puede ser otra grabación).
 * Las pistas sin audioHash en origen se marcan en el modal de envío:
 * en el otro dispositivo solo se reconocerán por título/artista/
 * duración. La app calcula el hash bajo demanda (botón "Analizar
 * huellas" / analyzeAllAudioHashes), así que conviene analizar antes
 * de compartir si se quiere el marcado fiable.
 *
 * Suposiciones (confirmadas leyendo app/index.html y
 * src/sync/sync-core.js; detalle en WIRING.md):
 *   - Playlist: {id, name, trackIds:[], updatedAt}. Los id de pista
 *     son 't'+... locales; por eso el enlace NO usa id, usa hash.
 *   - Pista: {id, name, title, artist, duration (segundos, 0 si aún
 *     no se leyó), audioHash (string|null)}.
 *   - Las playlists son del perfil activo: packState.playlists es la
 *     del perfil activo, y profileStore[activeProfileId].playlists
 *     es la misma lista; se prefiere esta última si existe.
 *   - saveState() guarda packState con 150 ms de debounce: al pulsar
 *     Compartir justo después de editar la playlist, la copia leída
 *     puede ir 150 ms desfasada; aceptable y documentado.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var SHARE_FORMAT_VERSION = 1;
  var MAX_TRACKS = 200;      // tope de canciones por enlace compartido
  var MAX_NAME_LEN = 60;     // igual que maxlength del modal de playlist
  var MAX_TITLE_LEN = 500;   // saneado al decodificar (anti-abuso)
  var DB_NAME = 'reproductor-musica-local';
  var DB_STORE_TRACKS = 'tracks';
  var DB_STORE_META = 'meta';

  /* ================= Utilidades puras ================= */

  function roundDuration(d) {
    var n = Number(d);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  }

  // Espejo de fmtTime() de la app (floor, H:MM:SS si >= 1 h).
  function formatDuration(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) {
      return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') +
        ':' + String(s).padStart(2, '0');
    }
    return m + ':' + String(s).padStart(2, '0');
  }

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/\s+/g, ' ').trim();
  }

  /* ---------- base64url (sin btoa/Buffer: funciona en navegador y Node) ---------- */
  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_REV = null;
  function b64Rev() {
    if (B64_REV) return B64_REV;
    B64_REV = {};
    for (var i = 0; i < 64; i++) B64_REV[B64_ALPHABET[i]] = i;
    return B64_REV;
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
    // Alfabeto URL-safe: '+' -> '-', '/' -> '_' (el enlace va en el fragmento).
    return out.replace(/\+/g, '-').replace(/\//g, '_');
  }
  function base64urlDecode(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9+/_-]*$/.test(str)) return null;
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    var rev = b64Rev(), out = [], i, n;
    for (i = 0; i < str.length; i++) if (rev[str[i]] === undefined) return null;
    for (i = 0; i + 3 < str.length; i += 4) {
      n = (rev[str[i]] << 18) | (rev[str[i + 1]] << 12) |
        (rev[str[i + 2]] << 6) | rev[str[i + 3]];
      out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    var rem = str.length - i;
    if (rem === 1) return null;
    if (rem === 2) {
      n = (rev[str[i]] << 18) | (rev[str[i + 1]] << 12);
      out.push((n >> 16) & 255);
    } else if (rem === 3) {
      n = (rev[str[i]] << 18) | (rev[str[i + 1]] << 12) | (rev[str[i + 2]] << 6);
      out.push((n >> 16) & 255, (n >> 8) & 255);
    }
    return new Uint8Array(out);
  }

  /* ---------- UTF-8 ---------- */
  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 < 0xE000) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
          i++;
        } else bytes.push(0xEF, 0xBF, 0xBD);
      } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(bytes);
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (e) { return null; }
    }
    return null;
  }

  /* ---------- Huella compacta ---------- */
  // "~" + base64url(bytes del hash hex). "~" no es un dígito hex: no hay
  // ambigüedad con un hash que viaje tal cual.
  function hashToCompact(hash) {
    if (typeof hash !== 'string' || !hash) return null;
    var h = hash.trim();
    if (/^[0-9a-fA-F]+$/.test(h) && h.length % 2 === 0) {
      var bytes = new Uint8Array(h.length / 2), i;
      for (i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
      return '~' + base64urlEncode(bytes);
    }
    return h;
  }
  function hashFromCompact(c) {
    if (c == null || typeof c !== 'string') return null;
    if (c.charAt(0) === '~') {
      var bytes = base64urlDecode(c.slice(1));
      if (!bytes) return null;
      var out = '', i;
      for (i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      return out;
    }
    return c;
  }

  /* ================= Payload del enlace ================= */

  // playlist: {name, trackIds}; lookup: fn(id)->pista | Map | objeto {id:pista}
  function buildSharePayload(playlist, lookup) {
    if (!playlist || !Array.isArray(playlist.trackIds)) {
      return { ok: false, error: 'La playlist no tiene lista de canciones.' };
    }
    var get = typeof lookup === 'function' ? lookup :
      function (id) {
        if (lookup && typeof lookup.get === 'function') return lookup.get(id);
        return lookup ? lookup[id] : undefined;
      };
    var name = String(playlist.name || 'Playlist').trim().slice(0, MAX_NAME_LEN) || 'Playlist';
    var entries = [], skipped = 0, noHash = 0, truncated = 0;
    var ids = playlist.trackIds.slice(0, MAX_TRACKS);
    truncated = Math.max(0, playlist.trackIds.length - ids.length);
    ids.forEach(function (id) {
      var t = get(id);
      if (!t) { skipped++; return; }
      var title = String(t.title || t.name || '').trim();
      if (!title) { skipped++; return; }
      var hash = hashToCompact(t.audioHash);
      if (!hash) noHash++;
      entries.push([
        title.slice(0, MAX_TITLE_LEN),
        String(t.artist || '').trim().slice(0, MAX_TITLE_LEN),
        roundDuration(t.duration),
        hash,
      ]);
    });
    if (!entries.length) {
      return { ok: false, error: 'Esta playlist está vacía o ninguna canción está ya en la biblioteca.' };
    }
    return {
      ok: true,
      payload: { v: SHARE_FORMAT_VERSION, n: name, t: entries },
      skipped: skipped, noHash: noHash, truncated: truncated,
    };
  }

  function encodeSharePayload(payload) {
    return base64urlEncode(utf8Encode(JSON.stringify(payload)));
  }

  function decodeSharePayload(b64) {
    var bytes = base64urlDecode(b64);
    if (!bytes) return { ok: false, error: 'El enlace no tiene un código válido.' };
    var text = utf8Decode(bytes);
    if (text === null) return { ok: false, error: 'El enlace no tiene texto válido.' };
    var data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, error: 'El enlace no tiene una lista válida.' }; }
    return validateSharePayload(data);
  }

  function validateSharePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'El enlace no trae una playlist.' };
    }
    if (data.v !== SHARE_FORMAT_VERSION) {
      return { ok: false, error: 'Ese enlace es de una versión que esta app no entiende (v' + data.v + ').' };
    }
    if (typeof data.n !== 'string' || !data.n.trim()) {
      return { ok: false, error: 'El enlace no trae el nombre de la playlist.' };
    }
    if (!Array.isArray(data.t) || !data.t.length || data.t.length > MAX_TRACKS) {
      return { ok: false, error: 'El enlace no trae canciones.' };
    }
    var tracks = [];
    for (var i = 0; i < data.t.length; i++) {
      var e = data.t[i];
      if (!Array.isArray(e) || e.length !== 4 ||
        typeof e[0] !== 'string' || !e[0].trim() ||
        typeof e[1] !== 'string' ||
        typeof e[2] !== 'number' || !isFinite(e[2]) || e[2] < 0 ||
        (e[3] !== null && typeof e[3] !== 'string')) {
        return { ok: false, error: 'El enlace trae una canción con datos incompletos.' };
      }
      var hash = hashFromCompact(e[3]);
      if (e[3] !== null && hash === null) {
        return { ok: false, error: 'El enlace trae una huella que no se puede leer.' };
      }
      tracks.push({
        title: e[0].trim().slice(0, MAX_TITLE_LEN),
        artist: e[1].trim().slice(0, MAX_TITLE_LEN),
        dur: Math.round(e[2]),
        hash: hash,
      });
    }
    return {
      ok: true,
      payload: { v: SHARE_FORMAT_VERSION, n: data.n.trim().slice(0, MAX_NAME_LEN), t: tracks },
    };
  }

  function defaultBaseUrl() {
    if (typeof location !== 'undefined' && location.href) return location.href.split('#')[0];
    return 'https://example.invalid/reproductor/';
  }
  function encodeShareLink(payload, baseUrl) {
    var base = String(baseUrl || defaultBaseUrl()).split('#')[0];
    return base + '#share=' + encodeSharePayload(payload);
  }
  // Acepta una URL completa o solo el fragmento ("#share=..." / "share=...").
  function parseShareHash(urlOrHash) {
    if (typeof urlOrHash !== 'string') return null;
    var idx = urlOrHash.indexOf('#share=');
    if (idx >= 0) {
      var rest = urlOrHash.slice(idx + 7).split('&')[0].split('#')[0];
      return rest || null;
    }
    if (urlOrHash.indexOf('share=') === 0) return urlOrHash.slice(6).split('&')[0] || null;
    return null;
  }
  function decodeShareLink(urlOrHash) {
    var b64 = parseShareHash(urlOrHash);
    if (!b64) return { ok: false, error: 'Ese enlace no trae una playlist compartida.' };
    return decodeSharePayload(b64);
  }

  function sharedTrackToObject(entry) {
    if (Array.isArray(entry)) {
      return {
        title: entry[0], artist: entry[1] || '',
        dur: roundDuration(entry[2]), hash: hashFromCompact(entry[3]),
      };
    }
    return {
      title: entry.title, artist: entry.artist || '',
      dur: roundDuration(entry.dur), hash: entry.hash || null,
    };
  }

  /* ================= Marcado tiene/falta ================= */

  function metaKeyFor(title, artist, dur) {
    return normText(title) + '|' + normText(artist) + '|' + roundDuration(dur);
  }

  // localTracks: pistas de este dispositivo {id, title, name, artist,
  // duration, audioHash}. sharedTracks: entradas del payload (array
  // [título, artista, dur, hash] o {title, artist, dur, hash}).
  // Devuelve {items, haveCount, missingCount}; cada item lleva
  // {title, artist, dur, hash, have, localId, via ('hash'|'meta'|null)}.
  function markShared(localTracks, sharedTracks) {
    var byHash = new Map(), byMeta = new Map();
    (localTracks || []).forEach(function (t) {
      if (!t) return;
      if (typeof t.audioHash === 'string' && t.audioHash) {
        var hk = t.audioHash.trim().toLowerCase();
        if (!byHash.has(hk)) byHash.set(hk, t);
      }
      var mk = metaKeyFor(t.title || t.name || '', t.artist || '', t.duration);
      if (!byMeta.has(mk)) byMeta.set(mk, []);
      byMeta.get(mk).push(t);
    });
    var items = [], haveCount = 0;
    (sharedTracks || []).forEach(function (raw) {
      var s = sharedTrackToObject(raw);
      var item = {
        title: s.title, artist: s.artist || '', dur: s.dur,
        hash: s.hash || null, have: false, localId: null, via: null,
      };
      if (s.hash) {
        var hit = byHash.get(String(s.hash).trim().toLowerCase());
        if (hit) {
          item.have = true; item.localId = hit.id; item.via = 'hash';
        }
      }
      if (!item.have) {
        var cands = byMeta.get(metaKeyFor(s.title, s.artist, s.dur)) || [];
        // Solo se acepta el parecido por título/artista/duración si la
        // pista compartida no trae huella, o si la candidata local aún
        // no tiene huella calculada. Si ambas tienen huella distinta,
        // es otra grabación: falta.
        var cand = null;
        for (var i = 0; i < cands.length; i++) {
          var ch = cands[i];
          if (!s.hash || !(typeof ch.audioHash === 'string' && ch.audioHash)) { cand = ch; break; }
        }
        if (cand) {
          item.have = true; item.localId = cand.id; item.via = 'meta';
        }
      }
      if (item.have) haveCount++;
      items.push(item);
    });
    return { items: items, haveCount: haveCount, missingCount: items.length - haveCount };
  }

  /* ================= Código QR (encoder propio, modo Byte, EC nivel L) =================
   * Versiones 1-5 (un solo bloque de datos: sin entrelazado), máscara 0.
   * Capacidad en modo Byte con nivel L: v1=17, v2=32, v3=53, v4=78, v5=106
   * bytes. Si el texto no cabe, qrEncode() devuelve null y la UI lo dice.
   * Referencia: ISO/IEC 18004 (patrones, info de formato, Reed-Solomon
   * sobre GF(256) con polinomio 0x11D). */

  var QR_VERSIONS = {
    1: { total: 26, ec: 7, data: 19, align: [], rem: 0 },
    2: { total: 44, ec: 10, data: 34, align: [6, 18], rem: 7 },
    3: { total: 70, ec: 15, data: 55, align: [6, 22], rem: 7 },
    4: { total: 100, ec: 20, data: 80, align: [6, 26], rem: 7 },
    5: { total: 134, ec: 26, data: 108, align: [6, 30], rem: 7 },
  };
  var QR_MAX_VERSION = 5;
  var QR_MAX_BYTES = 106; // capacidad de la versión 5, nivel L, modo Byte
  var QR_EC_LEVEL_BITS = 1; // nivel L = 01
  var QR_MASK = 0;          // (fila+columna) par

  var GF_EXP = null, GF_LOG = null;
  function gfTables() {
    if (GF_EXP) return;
    GF_EXP = new Array(512); GF_LOG = new Array(256);
    var x = 1, i;
    for (i = 0; i < 255; i++) {
      GF_EXP[i] = x; GF_LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  }
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    gfTables();
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }
  // Polinomio generador grado `degree`, coeficientes en orden ascendente
  // (poly[0] = término independiente). g(x) = (x-a^0)(x-a^1)...(x-a^(d-1)).
  function rsGeneratorPoly(degree) {
    gfTables();
    var poly = [1], i, j;
    for (i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], GF_EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }
  // Resto de data(x)*x^degree / g(x). Devuelve `degree` bytes, el
  // coeficiente de mayor grado primero (orden de los codewords EC).
  function rsRemainder(data, degree) {
    var gen = rsGeneratorPoly(degree);
    var divisor = [], i;
    for (i = degree - 1; i >= 0; i--) divisor.push(gen[i]);
    var result = new Array(divisor.length).fill(0);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      result.shift(); result.push(0);
      for (i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  // Bits de información de formato (15 bits) para nivel EC y máscara.
  // Valor conocido de control: nivel L + máscara 0 = 0x77C4.
  function qrFormatBits(ecLevelBits, mask) {
    var data = ((ecLevelBits & 3) << 3) | (mask & 7);
    var rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return (((data << 10) | rem) ^ 0x5412) & 0x7FFF;
  }

  function qrCapacityBytes(version) {
    var v = QR_VERSIONS[version];
    if (!v) return 0;
    return v.data - 2; // modo (4 bits) + contador (8 bits) = 12 bits -> 2 bytes
  }

  // Codifica `text` (UTF-8, modo Byte) en la versión más pequeña que
  // quepa. Devuelve {version, size, modules} (modules[fila][col] 0/1)
  // o null si no cabe en la versión 5.
  function qrEncode(text) {
    var bytes = utf8Encode(String(text == null ? '' : text));
    var version = 0, v;
    for (v = 1; v <= QR_MAX_VERSION; v++) {
      if (bytes.length <= qrCapacityBytes(v)) { version = v; break; }
    }
    if (!version) return null;
    var spec = QR_VERSIONS[version];
    var size = 21 + (version - 1) * 4;

    // --- Flujo de bits: modo 0100, contador 8 bits, datos, terminador,
    // relleno a byte y bytes de relleno EC/11 alternos. ---
    var bits = [];
    function pushBits(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }
    pushBits(4, 4); // modo Byte = 0100
    pushBits(bytes.length, 8);
    for (var b = 0; b < bytes.length; b++) pushBits(bytes[b], 8);
    var capacityBits = spec.data * 8;
    var term = Math.min(4, capacityBits - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var pad = [0xEC, 0x11], pi = 0;
    while (bits.length < capacityBits) { pushBits(pad[pi % 2], 8); pi++; }
    var dataCodewords = [];
    for (var c = 0; c < spec.data; c++) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[c * 8 + k];
      dataCodewords.push(byte);
    }
    var codewords = dataCodewords.concat(rsRemainder(dataCodewords, spec.ec));
    var totalDataBits = codewords.length * 8;

    // --- Matriz: -1 = aún sin asignar; isFunction marca los patrones. ---
    var modules = [], isFunction = [], r, col;
    for (r = 0; r < size; r++) {
      modules.push(new Array(size).fill(0));
      isFunction.push(new Array(size).fill(false));
    }
    function setFn(row, col, val) {
      modules[row][col] = val ? 1 : 0;
      isFunction[row][col] = true;
    }
    function finder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = r0 + dr, cc = c0 + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var inPat = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          var dark = inPat && (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFn(rr, cc, dark);
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // Timing (fila 6 y columna 6).
    for (var i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    // Patrones de alineación.
    spec.align.forEach(function (ar) {
      spec.align.forEach(function (ac) {
        // Se saltan los que se solapan con los tres patrones de búsqueda.
        if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) ||
          (ar === size - 7 && ac === 6)) return;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFn(ar + dr, ac + dc, dark);
          }
        }
      });
    });
    // Reserva de la información de formato (los valores se ponen luego).
    for (i = 0; i <= 8; i++) { isFunction[8][i] = true; isFunction[i][8] = true; }
    for (i = 0; i < 8; i++) {
      isFunction[8][size - 1 - i] = true;
      isFunction[size - 1 - i][8] = true;
    }
    // Módulo oscuro (siempre 1).
    setFn(size - 8, 8, 1);

    // --- Colocación de datos en zigzag, de derecha a izquierda. ---
    var bitIndex = 0, pair = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      var upward = pair % 2 === 0;
      pair++;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var cc2 = right - j;
          var rr2 = upward ? size - 1 - vert : vert;
          if (isFunction[rr2][cc2]) continue;
          var bit = 0;
          if (bitIndex < totalDataBits) {
            bit = (codewords[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1;
          }
          if ((rr2 + cc2) % 2 === 0) bit ^= 1; // máscara 0
          modules[rr2][cc2] = bit;
          bitIndex++;
        }
      }
    }

    // --- Información de formato (dos copias). ---
    var fmt = qrFormatBits(QR_EC_LEVEL_BITS, QR_MASK);
    function fmtBit(i) { return (fmt >> i) & 1; }
    for (i = 0; i <= 5; i++) setFn(i, 8, fmtBit(i));
    setFn(7, 8, fmtBit(6));
    setFn(8, 8, fmtBit(7));
    setFn(8, 7, fmtBit(8));
    for (i = 9; i <= 14; i++) setFn(8, 14 - i, fmtBit(i));
    for (i = 0; i <= 7; i++) setFn(8, size - 1 - i, fmtBit(i));
    for (i = 8; i <= 14; i++) setFn(size - 15 + i, 8, fmtBit(i));
    setFn(size - 8, 8, 1); // módulo oscuro (por si acaso)

    return { version: version, size: size, modules: modules };
  }

  // Dibuja el QR de `text` en un <canvas>. Devuelve {ok, version} o
  // {ok:false, reason:'too-long', length, max}.
  function drawQR(canvas, text) {
    var qr = qrEncode(text);
    if (!qr) {
      return {
        ok: false, reason: 'too-long',
        length: utf8Encode(String(text == null ? '' : text)).length,
        max: QR_MAX_BYTES,
      };
    }
    var quiet = 4, scale = 6;
    var px = (qr.size + quiet * 2) * scale;
    canvas.width = px; canvas.height = px;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return { ok: true, version: qr.version, size: qr.size };
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
  function waitForApp(triesLeft, done) {
    var app = getApp();
    if (app) { done(app); return; }
    if (triesLeft <= 0) { done(null); return; }
    setTimeout(function () { waitForApp(triesLeft - 1, done); }, 100);
  }
  function appToast(msg) {
    var app = getApp();
    if (app && typeof app.toast === 'function') { try { app.toast(msg); return; } catch (e) {} }
    if (!doc) return;
    var el = doc.getElementById('shareToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'shareToast'; el.className = 'share-toast'; el.setAttribute('role', 'status');
      doc.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function copyText(text, okMsg) {
    function done() { appToast(okMsg || 'Copiado.'); }
    if (typeof navigator !== 'undefined' && navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    if (!doc) return;
    var ta = doc.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    doc.body.appendChild(ta); ta.select();
    try { doc.execCommand('copy'); done(); }
    catch (e) { appToast('No se pudo copiar. Selecciona el enlace a mano.'); }
    doc.body.removeChild(ta);
  }

  /* ---------- Lectura de playlists y pistas ---------- */
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
  // Devuelve {playlist, tracksById, playlists} de la playlist
  // seleccionada, o {error}. Nunca escribe nada.
  function getSelectedPlaylist() {
    var app = getApp();
    function fromData(packState, tracks) {
      var picked = pickPlaylists(packState);
      var pl = picked.playlists.find(function (p) { return p.id === picked.selectedId; }) ||
        picked.playlists[0] || null;
      if (!pl) return Promise.resolve({ error: 'Todavía no tienes playlists. Crea una primero.' });
      var byId = new Map();
      (tracks || []).forEach(function (t) { if (t && t.id) byId.set(t.id, t); });
      return Promise.resolve({ playlist: pl, tracksById: byId, playlists: picked.playlists, packState: packState });
    }
    if (app && typeof app.getPackState === 'function' && typeof app.getTracks === 'function') {
      var tracks = null;
      try { tracks = app.getTracks() || []; } catch (e) { tracks = []; }
      return Promise.resolve(app.getPackState()).then(
        function (ps) { return fromData(ps, tracks); },
        function () { return readLibraryFromIDB().then(function (d) {
          return d ? fromData(d.packState, d.tracks) : { error: 'No se pudo leer la biblioteca.' };
        }); });
    }
    return readLibraryFromIDB().then(function (d) {
      if (!d) return { error: 'La app aún no está lista. Espera un momento e inténtalo de nuevo.' };
      return fromData(d.packState, d.tracks);
    });
  }
  function getLocalTracks() {
    var app = getApp();
    if (app && typeof app.getTracks === 'function') {
      try { return Promise.resolve(app.getTracks() || []); } catch (e) {}
    }
    return readLibraryFromIDB().then(function (d) { return d ? d.tracks : []; });
  }

  /* ---------- Modal genérico (reusa .modal-overlay/.modal de la app) ---------- */
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function makeOverlay() {
    var ov = el('div', 'modal-overlay share-overlay');
    var box = el('div', 'modal share-modal');
    ov.appendChild(box);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeOverlay(ov); });
    doc.body.appendChild(ov);
    return { ov: ov, box: box };
  }
  function openOverlay(ov) { ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); }
  function closeOverlay(ov) { ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); }
  function modalActions(buttons) {
    var row = el('div', 'modal-actions share-actions');
    buttons.forEach(function (b) {
      var btn = el('button', 'btn small' + (b.primary ? ' primary' : ''), b.label);
      btn.type = 'button';
      btn.addEventListener('click', b.onClick);
      row.appendChild(btn);
    });
    return row;
  }
  function trackListEl(items, withMarks) {
    var ul = el('ul', 'share-list');
    items.forEach(function (it) {
      var li = el('li', 'share-row' + (withMarks ? (it.have ? ' have' : ' missing') : ''));
      var main = el('div', 'share-row-main');
      main.appendChild(el('span', 'share-row-title', it.title));
      main.appendChild(el('span', 'share-row-meta',
        (it.artist ? it.artist + ' · ' : '') + formatDuration(it.dur)));
      li.appendChild(main);
      if (withMarks) {
        li.appendChild(el('span', 'share-badge ' + (it.have ? 'have' : 'missing'),
          it.have ? (it.via === 'hash' ? '✓ La tienes' : '✓ La tienes*') : '✗ Te falta'));
      } else if (!it.hash) {
        li.appendChild(el('span', 'share-badge nohash', 'sin huella'));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  /* ---------- Modal de envío ---------- */
  var shareModal = null;
  function openShareModal(built, link) {
    if (!doc) return;
    var payload = built.payload;
    if (!shareModal) shareModal = makeOverlay();
    var box = shareModal.box;
    box.innerHTML = '';
    box.appendChild(el('h3', null, 'Compartir “' + payload.n + '”'));
    var totalDur = payload.t.reduce(function (s, e) { return s + (e[2] || 0); }, 0);
    box.appendChild(el('p', 'share-sub',
      payload.t.length + (payload.t.length === 1 ? ' canción' : ' canciones') +
      ' · ' + formatDuration(totalDur) +
      ' · El enlace solo lleva la lista (títulos, artistas, duraciones y huellas). No sube ningún audio.'));
    if (built.noHash) {
      box.appendChild(el('p', 'share-warn',
        '⚠ ' + built.noHash + (built.noHash === 1 ? ' canción no tiene' : ' canciones no tienen') +
        ' huella de audio calculada: en el otro dispositivo solo se reconocerán por título, artista y duración. ' +
        'Para un marcado fiable, analiza las huellas antes de compartir (botón «Analizar huellas» en la app).'));
    }
    if (built.skipped) {
      box.appendChild(el('p', 'share-warn',
        built.skipped + (built.skipped === 1 ? ' canción de la playlist ya no está' : ' canciones de la playlist ya no están') +
        ' en la biblioteca y no se incluyeron.'));
    }
    if (built.truncated) {
      box.appendChild(el('p', 'share-warn',
        'La playlist tiene más de ' + MAX_TRACKS + ' canciones: solo se compartieron las primeras ' + MAX_TRACKS + '.'));
    }
    var label = el('label', 'share-label', 'Enlace para compartir');
    label.setAttribute('for', 'shareLinkText');
    box.appendChild(label);
    var ta = el('textarea', 'share-link');
    ta.id = 'shareLinkText'; ta.readOnly = true; ta.rows = 3; ta.value = link;
    ta.addEventListener('focus', function () { ta.select(); });
    box.appendChild(ta);
    var qrBox = el('div', 'share-qr-box');
    var canvas = el('canvas', 'share-qr');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Código QR del enlace compartido');
    var qrRes = drawQR(canvas, link);
    if (qrRes.ok) {
      qrBox.appendChild(canvas);
      qrBox.appendChild(el('p', 'share-qr-note',
        'Escanea el QR con la cámara del otro dispositivo para abrir el enlace (QR versión ' + qrRes.version + ').'));
    } else {
      qrBox.appendChild(el('p', 'share-warn',
        'El enlace tiene ' + qrRes.length + ' caracteres y no cabe en un código QR ' +
        '(máximo ' + qrRes.max + ' caracteres). Copia el enlace o usa el botón Compartir.'));
    }
    box.appendChild(qrBox);
    box.appendChild(trackListEl(payload.t.map(function (e) {
      return { title: e[0], artist: e[1], dur: e[2], hash: hashFromCompact(e[3]) };
    }), false));
    var buttons = [
      { label: 'Copiar enlace', primary: true, onClick: function () { copyText(link, 'Enlace copiado.'); } },
      { label: 'Cerrar', onClick: function () { closeOverlay(shareModal.ov); } },
    ];
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      buttons.splice(1, 0, {
        label: 'Compartir…', onClick: function () {
          navigator.share({ title: 'Playlist: ' + payload.n, text: 'Playlist compartida desde el reproductor', url: link })
            .catch(function () { /* el usuario canceló: nada que hacer */ });
        },
      });
    }
    box.appendChild(modalActions(buttons));
    openOverlay(shareModal.ov);
  }

  function openShareForSelected() {
    getSelectedPlaylist().then(function (res) {
      if (res.error) { appToast(res.error); return; }
      var built = buildSharePayload(res.playlist, res.tracksById);
      if (!built.ok) { appToast(built.error); return; }
      openShareModal(built, encodeShareLink(built.payload));
    }).catch(function () { appToast('No se pudo preparar el enlace. Inténtalo de nuevo.'); });
  }

  /* ---------- Modal de recepción ---------- */
  var sharedModal = null;
  function openSharedModal(payload) {
    if (!doc) return;
    if (!sharedModal) sharedModal = makeOverlay();
    var box = sharedModal.box;
    box.innerHTML = '';
    box.appendChild(el('h3', null, 'Playlist compartida: “' + payload.n + '”'));
    box.appendChild(el('p', 'share-warn',
      '⚠ Este enlace solo trae la lista (títulos, artistas, duraciones y huellas), no los audios. ' +
      'Sin los archivos de audio en este dispositivo no se puede reproducir lo que falta.'));
    var status = el('p', 'share-sub', 'Comprobando tu biblioteca…');
    box.appendChild(status);
    var listWrap = el('div', 'share-list-wrap');
    box.appendChild(listWrap);
    var foot = el('p', 'share-sub share-foot', '');
    box.appendChild(foot);
    var saveBtn = null;
    var buttons = [
      {
        label: 'Guardar las que tengo como playlist', primary: true, onClick: function () {
          saveSharedAsPlaylist(payload, markedCache);
        },
      },
      {
        label: 'Copiar lista', onClick: function () {
          var lines = markedCache.items.map(function (it) {
            return (it.have ? '✓ ' : '✗ ') + it.title +
              (it.artist ? ' — ' + it.artist : '') + ' (' + formatDuration(it.dur) + ')';
          });
          copyText('Playlist: ' + payload.n + '\n' + lines.join('\n'), 'Lista copiada.');
        },
      },
      {
        label: 'Cerrar', onClick: function () {
          closeOverlay(sharedModal.ov);
          clearShareHash();
        },
      },
    ];
    var actions = modalActions(buttons);
    saveBtn = actions.querySelector('.btn.primary');
    if (saveBtn) saveBtn.disabled = true;
    box.appendChild(actions);

    var markedCache = { items: [], haveCount: 0, missingCount: 0 };
    function renderMarks(marked) {
      markedCache = marked;
      listWrap.innerHTML = '';
      listWrap.appendChild(trackListEl(marked.items, true));
      status.textContent = 'Tienes ' + marked.haveCount + ' de ' + marked.items.length +
        (marked.items.length === 1 ? ' canción' : ' canciones') +
        (marked.missingCount ? ' · te faltan ' + marked.missingCount + '.' : ' · ¡las tienes todas!');
      foot.textContent = '* «La tienes*» significa que coincidió por título, artista y duración ' +
        'porque esa canción no traía huella (o este dispositivo aún no la tiene calculada).';
      if (saveBtn) saveBtn.disabled = marked.haveCount === 0;
    }
    // getLocalTracks() ya usa IndexedDB si __rpmApp aún no está listo,
    // así que no hace falta esperar a la app.
    getLocalTracks().then(function (tracks) {
      renderMarks(markShared(tracks, payload.t));
    }).catch(function () {
      status.textContent = 'No se pudo leer tu biblioteca: no se puede marcar qué tienes.';
    });
    openOverlay(sharedModal.ov);
  }

  function clearShareHash() {
    try {
      if (typeof history !== 'undefined' && history.replaceState && typeof location !== 'undefined') {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (e) {}
  }

  function saveSharedAsPlaylist(payload, marked) {
    var app = getApp();
    if (!app || typeof app.getPackState !== 'function' || typeof app.applyPackState !== 'function') {
      appToast('Este dispositivo no permite guardar la playlist compartida.');
      return;
    }
    var haveIds = (marked.items || []).filter(function (it) { return it.have && it.localId; })
      .map(function (it) { return it.localId; });
    if (!haveIds.length) { appToast('No tienes ninguna canción de esa playlist en este dispositivo.'); return; }
    app.getPackState().then(function (ps) {
      ps = ps || {};
      var picked = pickPlaylists(ps);
      var base = String(payload.n || 'Playlist compartida').slice(0, MAX_NAME_LEN);
      var name = base, n = 2;
      var taken = new Set(picked.playlists.map(function (p) { return normText(p.name); }));
      while (taken.has(normText(name))) { name = base.slice(0, MAX_NAME_LEN - 4) + ' (' + n + ')'; n++; }
      var pl = {
        id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name: name, trackIds: haveIds, updatedAt: Date.now(),
      };
      var next = picked.playlists.concat([pl]);
      ps.playlists = next;
      if (ps.profileStore && ps.activeProfileId && ps.profileStore[ps.activeProfileId]) {
        ps.profileStore[ps.activeProfileId].playlists = next;
        ps.profileStore[ps.activeProfileId].selectedPlaylistId = pl.id;
      }
      ps.selectedPlaylistId = pl.id;
      return app.applyPackState(ps).then(function () {
        appToast('Playlist «' + name + '» guardada con ' + haveIds.length +
          (haveIds.length === 1 ? ' canción' : ' canciones') + ' de este dispositivo.');
        if (sharedModal) closeOverlay(sharedModal.ov);
        clearShareHash();
      });
    }).catch(function () {
      appToast('No se pudo guardar la playlist. Inténtalo de nuevo.');
    });
  }

  /* ---------- Botón "Compartir" en la vista de playlist ---------- */
  function ensureShareButton() {
    if (!doc) return;
    var actions = doc.getElementById('plActions');
    if (!actions) return;
    if (doc.getElementById('btnPlShare')) return;
    var btn = el('button', 'btn small', 'Compartir');
    btn.id = 'btnPlShare'; btn.type = 'button';
    btn.title = 'Generar un enlace con esta playlist (solo la lista, sin audios)';
    btn.addEventListener('click', openShareForSelected);
    var del = doc.getElementById('btnPlDelete');
    if (del && del.parentNode === actions) actions.insertBefore(btn, del);
    else actions.appendChild(btn);
  }

  function checkIncomingShare() {
    if (!doc || typeof location === 'undefined') return;
    var b64 = parseShareHash(location.hash || '');
    if (!b64) return;
    var res = decodeSharePayload(b64);
    if (!res.ok) {
      appToast(res.error);
      clearShareHash();
      return;
    }
    openSharedModal(res.payload);
  }

  function init() {
    if (!doc) return;
    try {
      ensureShareButton();
      var view = doc.getElementById('viewPlaylists');
      if (view && typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () { ensureShareButton(); })
          .observe(view, { childList: true, subtree: true });
      }
      doc.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          if (shareModal) closeOverlay(shareModal.ov);
          if (sharedModal && sharedModal.ov.classList.contains('on')) {
            closeOverlay(sharedModal.ov);
            clearShareHash();
          }
        }
      });
      checkIncomingShare();
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[compartir] desactivado por error en el inicio:', e);
      }
    }
  }

  /* ================= API pública ================= */
  var api = {
    VERSION: VERSION,
    SHARE_FORMAT_VERSION: SHARE_FORMAT_VERSION,
    MAX_TRACKS: MAX_TRACKS,
    QR_MAX_BYTES: QR_MAX_BYTES,
    QR_MAX_VERSION: QR_MAX_VERSION,
    roundDuration: roundDuration,
    formatDuration: formatDuration,
    normalizeForMatch: normText,
    base64urlEncode: base64urlEncode,
    base64urlDecode: base64urlDecode,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    hashToCompact: hashToCompact,
    hashFromCompact: hashFromCompact,
    buildSharePayload: buildSharePayload,
    encodeSharePayload: encodeSharePayload,
    decodeSharePayload: decodeSharePayload,
    validateSharePayload: validateSharePayload,
    encodeShareLink: encodeShareLink,
    decodeShareLink: decodeShareLink,
    parseShareHash: parseShareHash,
    markShared: markShared,
    metaKeyFor: metaKeyFor,
    qrEncode: qrEncode,
    qrFormatBits: qrFormatBits,
    qrCapacityBytes: qrCapacityBytes,
    rsRemainder: rsRemainder,
    drawQR: drawQR,
    openShareForSelected: openShareForSelected,
    openSharedModal: openSharedModal,
    getSelectedPlaylist: getSelectedPlaylist,
    saveSharedAsPlaylist: saveSharedAsPlaylist,
    init: init,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try { global.__rpmCompartir = api; } catch (e) {}
    if (doc) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
