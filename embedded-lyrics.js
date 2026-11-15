/* Letras incrustadas (USLT/SYLT) para Reproductor de Música — v3.1.0.
   Módulo aparte: lee la letra que ya viene dentro del MP3 (etiqueta
   ID3v2.3/v2.4) y la guarda en localStorage con la MISMA clave que
   usa lyrics.js ('reproductor-letras:<título> — <artista>'), para que
   el panel de letras la muestre sin tocar lyrics.js ni index.html.

   Reglas:
   - .lrc / letra del usuario SIEMPRE gana: si ya hay algo guardado
     para esa canción, no se lee el archivo ni se sobrescribe nada.
   - Si hay SYLT y USLT a la vez, gana SYLT (es la sincronizada).
   - Sin letras incrustadas, el módulo no cambia nada.
   - A prueba de fallos como lyrics.js: cualquier error aquí dentro
     se traga y la app sigue funcionando. Sin red, sin dependencias.

   Uso en la app (ver WIRING.md):
     <script src="./embedded-lyrics.js"></script>
   Prueba desde la consola:
     window.__embeddedLyricsParse(await blob.slice(0, 1e6).arrayBuffer())
     window.__embeddedLyricsToLRC([{ t: 5, text: 'Hola' }])
   Pruebas Node: node --test embedded-lyrics.test.mjs */
(function () {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  function synchsafe(b, p) {
    return ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) |
      ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
  }

  function u32be(b, p) {
    return (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  }

  function toBytes(input) {
    try {
      if (!input) return null;
      if (input instanceof Uint8Array) return input;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        return new Uint8Array(input);
      }
      // DataView u otro ArrayBufferView.
      if (typeof input.byteLength === 'number' && input.buffer) {
        return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
      }
    } catch (e) { /* fallthrough */ }
    return null;
  }

  /* Quita los 0x00 que la "unsynchronisation" ID3 inserta tras cada 0xFF. */
  function deunsync(bytes) {
    var out = new Uint8Array(bytes.length), n = 0, i;
    for (i = 0; i < bytes.length; i++) {
      out[n++] = bytes[i];
      if (bytes[i] === 0xFF && i + 1 < bytes.length && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  }

  function decodeLatin1(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s;
  }

  /* UTF-16 manual (sin depender de TextDecoder): respeta el BOM y los
     pares sustitutos; enc 1 = con BOM (por defecto LE), enc 2 = BE. */
  function decodeUTF16(bytes, littleEndian) {
    var s = '', i = 0;
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) { littleEndian = true; i = 2; }
      else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { littleEndian = false; i = 2; }
    }
    while (i + 1 < bytes.length) {
      var c = littleEndian
        ? (bytes[i] | (bytes[i + 1] << 8))
        : ((bytes[i] << 8) | bytes[i + 1]);
      i += 2;
      if (c === 0) break;
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < bytes.length) {
        var c2 = littleEndian
          ? (bytes[i] | (bytes[i + 1] << 8))
          : ((bytes[i] << 8) | bytes[i + 1]);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) { s += String.fromCharCode(c, c2); i += 2; continue; }
      }
      s += String.fromCharCode(c);
    }
    return s;
  }

  function decodeUTF8(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g, '');
      }
    } catch (e) { /* fallback abajo */ }
    return decodeLatin1(bytes);
  }

  /* Codificaciones ID3: 0 latin1, 1 UTF-16 con BOM, 2 UTF-16BE, 3 UTF-8.
     Una codificación desconocida se intenta como UTF-8 (best effort). */
  function decodeText(bytes, enc) {
    try {
      if (enc === 0) return decodeLatin1(bytes);
      if (enc === 1) {
        var le = true;
        if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) le = false;
        return decodeUTF16(bytes, le);
      }
      if (enc === 2) return decodeUTF16(bytes, false);
      return decodeUTF8(bytes); // enc 3 y desconocidas
    } catch (e) {
      return '';
    }
  }

  /* Lee una cadena terminada en NUL desde pos. Para UTF-16 el
     terminador es 00 00 alineado a 2 bytes desde el inicio. Devuelve
     { text, next } donde next es el primer byte tras el terminador. */
  function readTerminated(bytes, pos, enc) {
    var wide = (enc === 1 || enc === 2);
    var i = pos;
    if (!wide) {
      while (i < bytes.length && bytes[i] !== 0) i++;
      return { text: decodeText(bytes.subarray(pos, i), enc), next: Math.min(i + 1, bytes.length) };
    }
    while (i + 1 < bytes.length) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && ((i - pos) % 2 === 0)) break;
      i++;
    }
    return { text: decodeText(bytes.subarray(pos, i), enc), next: Math.min(i + 2, bytes.length) };
  }

  /* USLT: [encoding 1B][idioma 3B][descriptor NUL][texto...] */
  function parseUSLT(data) {
    try {
      if (!data || data.length < 4) return null;
      var enc = data[0];
      var r = readTerminated(data, 4, enc);
      var text = decodeText(data.subarray(r.next), enc)
        .replace(/\0+$/g, '').replace(/\r\n?/g, '\n').trim();
      return text ? text : null;
    } catch (e) {
      return null;
    }
  }

  /* SYLT: [encoding 1B][idioma 3B][formato-tiempo 1B][tipo 1B]
     [descripción NUL][texto NUL + sello 4B BE]... */
  function parseSYLT(data) {
    try {
      if (!data || data.length < 6) return null;
      var enc = data[0];
      var tsFormat = data[4];
      /* Estándar ID3v2.3 §4.10 / v2.4: formato $01 = tramas MPEG,
         $02 = milisegundos. Solo se leen milisegundos; el formato 1
         (tramas) se omite porque convertir tramas a segundos exige
         la frecuencia de muestreo del audio, que la etiqueta no
         trae; adivinar 26,12 ms/trama sería erróneo. */
      if (tsFormat === 1) return null;
      if (tsFormat !== 2) return null; // formato desconocido: no adivinar
      var r = readTerminated(data, 6, enc); // descripción
      var pos = r.next, lines = [];
      while (pos < data.length) {
        var e = readTerminated(data, pos, enc);
        var text = e.text.replace(/\0+$/g, '').trim();
        pos = e.next;
        if (pos + 4 > data.length) break; // sello truncado: parar sin tirar
        var ms = u32be(data, pos);
        pos += 4;
        if (text) lines.push({ t: ms / 1000, text: text });
      }
      lines.sort(function (a, b) { return a.t - b.t; });
      return lines.length ? lines : null;
    } catch (e) {
      return null;
    }
  }

  /* Recorre los frames ID3v2.3/v2.4 y devuelve
     { uslt: string|null, sylt: [{ t: segundos, text }]|null }.
     Nunca lanza: con entrada no-ID3, truncada o corrupta devuelve
     nulls (o lo que se alcanzara a leer antes del corte). */
  function parseEmbeddedLyrics(input) {
    var out = { uslt: null, sylt: null };
    try {
      var v = toBytes(input);
      if (!v || v.length < 10) return out;
      if (v[0] !== 0x49 || v[1] !== 0x44 || v[2] !== 0x33) return out; // 'ID3'
      var ver = v[3];
      if (ver !== 3 && ver !== 4) return out; // v2.2 y otras: fuera de alcance
      var flags = v[5];
      var tagSize = synchsafe(v, 6);
      var body = v.slice(10, Math.min(10 + tagSize, v.length));
      if (flags & 0x80) body = deunsync(body); // unsynchronisation
      var end = body.length, off = 0;
      if (flags & 0x40) { // cabecera extendida: saltarla (best effort)
        if (end < 4) return out;
        var extSize = (ver === 4) ? synchsafe(body, 0) : u32be(body, 0);
        off = (ver === 4) ? 4 + extSize : extSize;
        if (off >= end) return out;
      }
      while (off + 10 <= end) {
        var id = String.fromCharCode(body[off], body[off + 1], body[off + 2], body[off + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // relleno (00 00...) o basura
        // v2.4: tamaño synchsafe; v2.3: entero BE normal.
        var size = (ver === 4) ? synchsafe(body, off + 4) : u32be(body, off + 4);
        if (size <= 0) break;
        if (off + 10 + size > end) break; // frame truncado: conservar lo leído
        var data = body.subarray(off + 10, off + 10 + size);
        if (id === 'USLT' && !out.uslt) {
          var u = parseUSLT(data);
          if (u) out.uslt = u;
        } else if (id === 'SYLT' && !out.sylt) {
          var s = parseSYLT(data);
          if (s && s.length) out.sylt = s;
        }
        off += 10 + size;
      }
    } catch (e) { /* nunca romper la app: devolver lo que haya */ }
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtLrcTime(t) {
    var cs = Math.round(Math.max(0, t) * 100);
    return pad2(Math.floor(cs / 6000)) + ':' + pad2(Math.floor((cs % 6000) / 100)) +
      '.' + pad2(cs % 100);
  }

  /* [{ t: segundos, text }] -> texto LRC '[mm:ss.xx] línea' por línea,
     ordenado por tiempo. Texto vacío -> '♪', como hace lyrics.js. */
  function syltToLRC(lines) {
    var out = [];
    try {
      (lines || []).slice().sort(function (a, b) {
        return (a.t || 0) - (b.t || 0);
      }).forEach(function (ln) {
        if (!ln) return;
        var text = String(ln.text == null ? '' : ln.text).trim() || '♪';
        out.push('[' + fmtLrcTime(+ln.t || 0) + '] ' + text);
      });
    } catch (e) { /* devolver lo acumulado */ }
    return out.join('\n');
  }

  /* ================= Pegamento con el navegador ================= */

  var MAX_HEAD_BYTES = 1024 * 1024; // 1 MB: la etiqueta ID3 va al principio
  var POLL_MS = 600; // igual que lyrics.js
  var LYRICS_PREFIX = 'reproductor-letras:';

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function $(id) { return document.getElementById(id); }
  function keyForTitleArtist(title, artist) {
    // Clave EXACTA de lyrics.js: 'reproductor-letras:<título> — <artista>'
    return LYRICS_PREFIX + norm(title) + ' — ' + norm(artist);
  }
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* sin storage: nada */ }
  }

  function findTrack(app, title, artist) {
    try {
      var tracks = (app && typeof app.getTracks === 'function') ? app.getTracks() : null;
      if (!tracks || !tracks.length) return null;
      var nt = norm(title), na = norm(artist), i, t;
      for (i = 0; i < tracks.length; i++) {
        t = tracks[i];
        if (!t) continue;
        if (norm(t.title || t.name) !== nt) continue;
        if (na && norm(t.artist || '') !== na) continue;
        return t;
      }
    } catch (e) { /* sin pista: nada */ }
    return null;
  }

  function blobToArrayBuffer(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      try {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(new Error('No se pudo leer el audio')); };
        r.readAsArrayBuffer(blob);
      } catch (e) { reject(e); }
    });
  }

  /* Intenta importar la letra incrustada de la canción actual.
     Terminal (marca attempted): ya hay letra, no hay blob, o la
     lectura terminó (con o sin letra). No terminal: falta __rpmApp
     o la pista aún no está en la biblioteca -> se reintenta cuando
     cambie la canción (o en el siguiente tick si sigue pendiente). */
  function maybeImport(attempted, inFlight) {
    var app = (typeof window !== 'undefined') ? window.__rpmApp : null;
    if (!app || typeof app.getTracks !== 'function' || typeof app.getTrackBlob !== 'function') return;
    var title = $('nowTitle') ? $('nowTitle').textContent : '';
    var artist = $('nowArtist') ? $('nowArtist').textContent : '';
    if (!norm(title)) return;
    var key = keyForTitleArtist(title, artist);
    if (attempted[key] || inFlight[key]) return;
    if (storageGet(key) != null) { attempted[key] = true; return; } // .lrc gana
    var track;
    try { track = findTrack(app, title, artist); } catch (e) { track = null; }
    if (!track) return; // biblioteca aún cargando
    var res;
    try { res = app.getTrackBlob(track); } catch (e) { return; }
    if (!res) { attempted[key] = true; return; }
    inFlight[key] = true;
    Promise.resolve(res).then(function (blob) {
      if (!blob || typeof blob.slice !== 'function') return;
      return blobToArrayBuffer(blob.slice(0, MAX_HEAD_BYTES));
    }).then(function (buf) {
      if (!buf) return;
      if (storageGet(key) != null) return; // el usuario pegó una letra entretanto
      var parsed = parseEmbeddedLyrics(buf);
      var text = null;
      if (parsed.sylt && parsed.sylt.length) text = syltToLRC(parsed.sylt);
      else if (parsed.uslt) text = parsed.uslt;
      if (!text) return;
      if (storageGet(key) != null) return; // última comprobación antes de escribir
      storageSet(key, text);
    }).catch(function () { /* leer falló: no pasa nada */
    }).then(function () {
      delete inFlight[key];
      attempted[key] = true;
    });
  }

  function startWatch() {
    var attempted = {}, inFlight = {};
    var last = '';
    function tick() {
      try {
        var title = $('nowTitle') ? $('nowTitle').textContent : '';
        var artist = $('nowArtist') ? $('nowArtist').textContent : '';
        var cur = norm(title) + '|' + norm(artist);
        if (cur !== last) last = cur;
        // Se llama en cada tick (no solo al cambiar) para reintentar
        // mientras la biblioteca carga; maybeImport es barato cuando
        // no hay nada que hacer y solo lee el blob una vez por canción.
        maybeImport(attempted, inFlight);
      } catch (e) { /* el sondeo nunca debe romper la app */ }
    }
    setInterval(tick, POLL_MS);
    tick();
  }

  /* Solo navegador: sin document no hay nada que vigilar (Node). */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWatch);
      } else {
        startWatch();
      }
    } catch (e) { /* sin reloj: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseEmbeddedLyrics: parseEmbeddedLyrics,
      syltToLRC: syltToLRC,
      parseUSLT: parseUSLT,
      parseSYLT: parseSYLT
    };
  }
  if (typeof window !== 'undefined') {
    window.__embeddedLyricsParse = parseEmbeddedLyrics;
    window.__embeddedLyricsToLRC = syltToLRC;
  }
})();
