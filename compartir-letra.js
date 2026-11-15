/* compartir-letra.js — «Compartir canción con letra» (reproductor-de-musica v4.2.0, módulo aparte).
 *
 * Qué hace: añade un botón «♪ Compartir con letra» junto a «Compartir»
 * (#btnShareCurrent) en la ficha de la canción que suena. Al pulsarlo
 * abre una ventana con la vista previa y tres acciones:
 *   (a) imagen PNG 1080x1350 generada en local con canvas (portada si
 *       existe, título, artista, fragmento de letra y la nota personal
 *       si hay) + texto plano con lo mismo, compartidos con
 *       navigator.share cuando el navegador lo permite;
 *   (b) «Descargar imagen»: descarga el PNG;
 *   (c) «Copiar texto»: copia el texto plano.
 * Si el navegador no puede compartir archivos, comparte solo el texto
 * y lo dice claro; si no hay Web Share, descarga la imagen o copia el
 * texto y lo dice claro. NUNCA se comparte el audio: solo texto/imagen.
 * Distinto de #btnShareCurrent («Compartir»): ese botón comparte el
 * ARCHIVO DE AUDIO con Web Share (shareTrack en index.html); este
 * módulo no lo toca ni lo usa, y no llama a getTrackBlob().
 *
 * De dónde salen los datos (verificado en el código real; ver WIRING.md):
 *   - Canción actual: NO hay getCurrentTrack() en __rpmApp, así que se
 *     identifica como whatsapp.js: se cruzan #nowTitle / #nowArtist
 *     con __rpmApp.getTracks() (título exacto normalizado, artista
 *     como desempate); si no hay coincidencia, título/artista del DOM.
 *   - Letra: localStorage, clave 'reproductor-letras:' + norm(título)
 *     + ' — ' + norm(artista) (lyrics.js, keyFor, línea 14). El valor
 *     es el texto LRC tal cual (con marcas [mm:ss.xx] y etiquetas
 *     [ti:]/[ar:]/...); aquí se limpia a líneas de texto plano con
 *     parseLRC(), misma semántica que lyrics.js / traduccion.js.
 *     Vía de respaldo: __rpmApp.readLyrics() (index.html, línea
 *     12756; rpmReadLyrics, línea 12720) devuelve un mapa cuyas claves
 *     son el sufijo sin prefijo ('título — artista').
 *   - Nota: localStorage, clave 'reproductor-notas:' + mismo sufijo
 *     (notas.js, línea 12 y NOTAS_PREFIX, línea 65). Texto plano libre
 *     (máx. 2000 caracteres en notas.js). Vía de respaldo: el mismo
 *     mapa de readLyrics(), clave 'notas:' + sufijo (rpmReadLyrics ya
 *     recoge el prefijo de notas desde 3.8.0, index.html línea 12728).
 *     Sin nota guardada, no se muestra nada de nota (ni en el texto
 *     ni en la imagen), igual que notas.js no muestra nada sin nota.
 *   - Portada: __rpmApp.getCoverBlob(pista) (index.html, línea 12755:
 *     idbGet(t.id).coverBlob) o, si falla, fetch de track.coverUrl o
 *     de #coverImg.src si se ve (mismo orden que whatsapp.js).
 *   - Sin letra guardada, se ofrece compartir solo título / artista /
 *     nota y se dice explícitamente (en la ventana y en el texto:
 *     «Sin letra guardada para esta canción.»). La imagen también se
 *     genera en ese caso (título, artista, nota si hay).
 *
 * Canvas: mismo patrón que wrapped-img.js (1080x1350, degradado del
 * --accent actual, fuentes autoalojadas Fraunces / Plus Jakarta Sans
 * con fallback del sistema, sin librerías externas ni red).
 *
 * Fail-safe (patrón wrapped-img.js / whatsapp.js / compartir.js):
 * IIFE, try/catch en el arranque y en cada acción. Si el módulo falla
 * o no carga, la app sigue igual (solo falta el botón). No escribe en
 * IndexedDB ni en localStorage: solo lee letra, nota y portada. */
(function (g) {
  'use strict';

  var VERSION = '4.2.0';
  var WIDTH = 1080;
  var HEIGHT = 1350;
  var MAX_LYRIC_LINES_TEXT = 12;  // líneas de letra en el texto plano
  var MAX_LYRIC_LINES_IMAGE = 8;  // líneas de letra en la imagen
  var MAX_NOTE_LINES_IMAGE = 4;   // líneas visuales de nota en la imagen
  var MAX_TITLE_CHARS = 500;      // saneado defensivo, como compartir.js
  var DEFAULT_ACCENT = '#E94E1B'; // --accent por defecto de la app
  var LYRICS_PREFIX = 'reproductor-letras:';
  var NOTES_PREFIX = 'reproductor-notas:';
  var FONT_TITLE = '"Fraunces", Georgia, serif';
  var FONT_BODY = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
  var NO_TRACK_TITLE = 'Ninguna canción seleccionada';
  var NO_TRACK_ARTISTS = [
    'Añade archivos de audio para empezar',
    'Elige una canción de la biblioteca'
  ];

  /* ================= Ayudas puras (probadas con Node) ================= */

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function str(v, dflt) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : (dflt || '');
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /* Sufijo común a letra y nota: '<título> — <artista>' normalizado.
     ' — ' es guion largo U+2014 rodeado de espacios (lyrics.js). */
  function suffixFor(title, artist) {
    return norm(title) + ' — ' + norm(artist);
  }
  function lyricsKeyFor(title, artist) {
    return LYRICS_PREFIX + suffixFor(title, artist);
  }
  function notesKeyFor(title, artist) {
    return NOTES_PREFIX + suffixFor(title, artist);
  }

  /* ¿Hay canción elegida? Textos exactos de arranque de la app
     (index.html líneas 882-883; render(), líneas 3562-3564; mismo
     criterio que notas.js y whatsapp.js). */
  function isNoTrack(title, artist) {
    var t = String(title == null ? '' : title).trim();
    var a = String(artist == null ? '' : artist).trim();
    if (!t || t === NO_TRACK_TITLE) return true;
    if (NO_TRACK_ARTISTS.indexOf(a) !== -1) return true;
    return false;
  }
  function isPlaceholderArtist(artist) {
    var a = String(artist == null ? '' : artist).trim();
    return !a || NO_TRACK_ARTISTS.indexOf(a) !== -1;
  }

  /* Parser LRC, misma semántica que lyrics.js (líneas 19-48) y
     traduccion.js: [mm:ss.xx] texto, varias marcas por línea,
     [offset:+500], se ignoran las etiquetas de metadatos
     ([ti:], [ar:], [al:], [by:], [length:], [#:). Sin marcas de
     tiempo, las líneas de texto se devuelven como letra sin
     sincronizar (synced:false). Copia local: no depende del orden
     de carga de lyrics.js. */
  function parseLRC(text) {
    var lines = [], offset = 0, plain = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/^\uFEFF/, '');
      var mOff = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
      if (mOff) { offset = parseInt(mOff[1], 10) || 0; return; }
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      var times = [], rest = line;
      var m;
      var re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
      while ((m = re.exec(line)) !== null) {
        var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        var frac = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0;
        times.push(sec + frac);
      }
      rest = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      if (times.length) {
        times.forEach(function (t) { lines.push({ t: t + offset / 1000, text: rest || '♪' }); });
      } else if (rest) { plain.push(rest); }
    });
    lines.sort(function (a, b) { return a.t - b.t; });
    if (!lines.length && plain.length) {
      return { synced: false, lines: plain.map(function (p) { return { t: 0, text: p }; }) };
    }
    return { synced: lines.length > 0, lines: lines };
  }

  /* Letra en bruto (LRC o texto plano) -> líneas de texto plano,
     sin marcas de tiempo, sin etiquetas y sin líneas vacías. Las
     líneas que son solo '♪' (hueco de una marca de tiempo sin texto,
     como hace lyrics.js con `rest || '♪'`) se descartan: no aportan
     nada al compartir. */
  function plainLyricLines(raw) {
    if (raw == null) return [];
    var parsed = parseLRC(raw);
    var out = [];
    parsed.lines.forEach(function (ln) {
      var t = String(ln.text == null ? '' : ln.text).trim();
      if (!t || t === '♪') return;
      out.push(t);
    });
    return out;
  }

  /* Recorte de la letra a N líneas: {lines, total, truncated,
     hasLyrics}. `total` es el número de líneas reales de la letra
     guardada; `truncated` dice si se recortó (para avisarlo). */
  function extractLyricLines(raw, maxLines) {
    var all = plainLyricLines(raw);
    var max = Math.max(1, maxLines | 0 || MAX_LYRIC_LINES_TEXT);
    return {
      lines: all.slice(0, max),
      total: all.length,
      truncated: all.length > max,
      hasLyrics: all.length > 0
    };
  }

  /* Lee letra y nota de un storage (localStorage o un objeto con
     getItem, así se prueba en Node). Devuelve {lyricsRaw, note}
     con null donde no hay nada guardado. La nota vacía o solo con
     espacios cuenta como «sin nota» (mismo criterio que notas.js:
     hasNote / sanitizeNote). */
  function loadLyricsAndNote(storage, title, artist) {
    var lyricsRaw = null, note = null;
    try {
      if (storage && typeof storage.getItem === 'function') {
        lyricsRaw = storage.getItem(lyricsKeyFor(title, artist));
        var rawNote = storage.getItem(notesKeyFor(title, artist));
        if (typeof rawNote === 'string' && rawNote.trim()) note = rawNote.replace(/\r\n?/g, '\n').trim();
      }
    } catch (e) { /* sin almacenamiento: sin letra ni nota */ }
    if (typeof lyricsRaw === 'string' && !lyricsRaw.trim()) lyricsRaw = null;
    return { lyricsRaw: lyricsRaw, note: note };
  }

  /* Misma lectura, pero desde el mapa que devuelve
     __rpmApp.readLyrics() (rpmReadLyrics, index.html línea 12720):
     la letra va con la clave sufijo sin prefijo y la nota con
     'notas:' + sufijo. Solo se usa como respaldo cuando la lectura
     directa de localStorage no dio nada. */
  function loadFromLyricsMap(map, title, artist) {
    var suffix = suffixFor(title, artist);
    var lyricsRaw = null, note = null;
    try {
      if (map && typeof map === 'object') {
        if (typeof map[suffix] === 'string' && map[suffix].trim()) lyricsRaw = map[suffix];
        var rawNote = map['notas:' + suffix];
        if (typeof rawNote === 'string' && rawNote.trim()) note = rawNote.replace(/\r\n?/g, '\n').trim();
      }
    } catch (e) {}
    return { lyricsRaw: lyricsRaw, note: note };
  }

  /* Normaliza título/artista/letra/nota al modelo que comparten el
     texto y la imagen. Devuelve null si no hay título real (sin
     canción no hay nada que compartir). El artista que sea texto de
     arranque de la app se descarta (no es un artista). El álbum solo
     se conserva si viene en la pista (campo real de la app). */
  function buildShareModel(input) {
    if (!input || typeof input !== 'object') return null;
    var title = str(input.title || input.name, '');
    if (!title) return null;
    title = title.slice(0, MAX_TITLE_CHARS);
    var artist = isPlaceholderArtist(input.artist) ? '' : str(input.artist, '');
    artist = artist.slice(0, MAX_TITLE_CHARS);
    var album = str(input.album, '');
    var lyric = extractLyricLines(input.lyricsRaw, MAX_LYRIC_LINES_TEXT);
    var note = null;
    if (typeof input.note === 'string' && input.note.trim()) {
      note = input.note.replace(/\r\n?/g, '\n').trim();
    }
    return {
      title: title,
      artist: artist,
      album: album,
      hasLyrics: lyric.hasLyrics,
      lyricLines: lyric.lines,
      totalLyricLines: lyric.total,
      lyricTruncated: lyric.truncated,
      hasNote: !!note,
      note: note
    };
  }

  /* Texto plano a compartir (y vista previa del modal). Formato:
       🎵 Título
       🎤 Artista            (solo si hay artista real)
       💿 Álbum             (solo si hay álbum)
       <vacía>
       ♪ Letra:
       <líneas…>
       … (letra completa: N líneas; se comparten las primeras 12)
       — o, sin letra: «Sin letra guardada para esta canción.»
       <vacía>
       📝 Nota:
       <nota tal cual>      (solo si hay nota)
       <vacía>
       Compartido desde Reproductor de Música
     La nota va tal cual la escribió el usuario (notas.js no la
     reformatea); la letra va recortada a 12 líneas y se avisa. */
  function buildShareText(model) {
    if (!model || !model.title) return null;
    var lines = ['\uD83C\uDFB5 ' + model.title];
    if (model.artist) lines.push('\uD83C\uDFA4 ' + model.artist);
    if (model.album) lines.push('\uD83D\uDCBF ' + model.album);
    lines.push('');
    if (model.hasLyrics && model.lyricLines && model.lyricLines.length) {
      lines.push('\u266A Letra:');
      model.lyricLines.forEach(function (l) { lines.push(l); });
      if (model.lyricTruncated) {
        lines.push('\u2026 (letra completa: ' + model.totalLyricLines +
          ' l\u00EDneas; se comparten las primeras ' + model.lyricLines.length + ')');
      }
    } else {
      lines.push('Sin letra guardada para esta canci\u00F3n.');
    }
    if (model.hasNote && model.note) {
      lines.push('');
      lines.push('\uD83D\uDCDD Nota:');
      lines.push(model.note);
    }
    lines.push('');
    lines.push('Compartido desde Reproductor de M\u00FAsica');
    return lines.join('\n');
  }

  /* Nombre de archivo del PNG: slug del título (sin tildes, a 60
     caracteres, como coverFileName de whatsapp.js) + '-letra.png'.
     Sin título -> 'cancion-letra.png'. Nunca lleva caracteres que
     rompan una descarga. */
  function slugify(text) {
    var base = String(text == null ? '' : text);
    try { base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
    return base || 'cancion';
  }
  function buildFileName(modelOrTitle) {
    var title = '';
    if (typeof modelOrTitle === 'string') title = modelOrTitle;
    else if (modelOrTitle && typeof modelOrTitle === 'object') title = modelOrTitle.title || modelOrTitle.name || '';
    return slugify(title) + '-letra.png';
  }

  /* Decisión central, probada en Node (mismo patrón que
     decideShareMethod de whatsapp.js):
       'share-files'    -> Web Share con imagen PNG + texto
       'share-text'     -> Web Share solo con texto (sin portada o
                           sin soporte de archivos; se avisa)
       'download-image' -> sin Web Share: descargar el PNG
       'copy-text'      -> sin Web Share y sin imagen: copiar texto
     caps: {hasShare, canShareFiles} (canShareFiles ya incluye que
     haya archivo). hasImage: se pudo generar el PNG. */
  function decideShareMethod(caps, hasImage) {
    caps = caps || {};
    if (hasImage && caps.hasShare && caps.canShareFiles) return 'share-files';
    if (caps.hasShare) return 'share-text';
    if (hasImage) return 'download-image';
    return 'copy-text';
  }
  function canShareFiles(nav, file) {
    if (!nav || !file) return false;
    if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false;
    try { return !!nav.canShare({ files: [file] }); } catch (e) { return false; }
  }
  function hasWebShare(nav) {
    return !!(nav && typeof nav.share === 'function');
  }

  /* Identifica la pista actual en la biblioteca por lo que muestra
     el DOM (misma regla que findCurrentTrack de whatsapp.js):
     título exacto normalizado; si hay varias con el mismo título,
     el artista desempata; si no, la primera. null si el título es
     el texto de «sin canción» o está vacío. */
  function findCurrentTrack(tracks, title, artist) {
    if (isNoTrack(title, artist)) return null;
    var wantTitle = norm(title);
    if (!wantTitle) return null;
    var wantArtist = isPlaceholderArtist(artist) ? '' : norm(artist);
    var firstTitleMatch = null;
    var list = Array.isArray(tracks) ? tracks : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      if (norm(t.title || t.name || '') !== wantTitle) continue;
      if (!firstTitleMatch) firstTitleMatch = t;
      if (!wantArtist) continue;
      var ta = norm(t.artist || '');
      var tn = norm(t.name || '');
      if (ta === wantArtist || tn === wantArtist) return t;
    }
    return firstTitleMatch;
  }

  /* ================= Color: degradado del tema =================
   * Copiado de wrapped-img.js (mismo esquema: oscuro arriba, acento
   * abajo; el texto principal siempre va sobre fondo oscuro). */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var h = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      h = h.split('').map(function (c) { return c + c; }).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var n = clamp(Math.round(v), 0, 255);
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('').toUpperCase();
  }
  function mixHex(a, b, t) {
    var ra = hexToRgb(a), rb = hexToRgb(b);
    if (!ra || !rb) return DEFAULT_ACCENT;
    return rgbToHex([
      ra[0] + (rb[0] - ra[0]) * t,
      ra[1] + (rb[1] - ra[1]) * t,
      ra[2] + (rb[2] - ra[2]) * t
    ]);
  }
  function parseCssColor(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    var hex = hexToRgb(v);
    if (hex) return rgbToHex(hex);
    var m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return rgbToHex([+m[1], +m[2], +m[3]]);
    return null;
  }
  function themeGradient(accent) {
    var a = parseCssColor(accent) || DEFAULT_ACCENT;
    return {
      accent: a,
      top: mixHex(a, '#000000', 0.86),
      mid: mixHex(a, '#000000', 0.52),
      bottom: a,
      text: '#FFFFFF',
      muted: 'rgba(255,255,255,0.78)',
      faint: 'rgba(255,255,255,0.55)'
    };
  }

  /* ================= Texto en canvas ================= */

  function truncateText(text, maxChars) {
    var t = str(text, '');
    if (!t) return '';
    var max = Math.max(1, maxChars | 0 || 40);
    if (t.length <= max) return t;
    return t.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
  }
  function truncateToWidth(ctx, text, maxWidth) {
    var t = str(text, '');
    if (!t || !ctx || typeof ctx.measureText !== 'function' || !(maxWidth > 0)) return t;
    if (ctx.measureText(t).width <= maxWidth) return t;
    var ell = '…';
    var lo = 0, hi = t.length;
    while (lo < hi) {
      var mid = Math.floor((lo + hi + 1) / 2);
      if (ctx.measureText(t.slice(0, mid) + ell).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? t.slice(0, lo) + ell : ell;
  }

  /* Parte el texto en líneas visuales que caben en maxWidth.
     Devuelve {lines, truncated}: las palabras largas que no caben
     ni solas se parten por caracteres. Con un ctx stub en Node
     (measureText: nº de caracteres x ancho fijo) se comporta igual. */
  function wrapText(ctx, text, maxWidth, maxLines) {
    var out = { lines: [], truncated: false };
    var t = str(text, '');
    if (!t || !ctx || typeof ctx.measureText !== 'function' || !(maxWidth > 0)) {
      if (t) out.lines = [t];
      return out;
    }
    var max = Math.max(1, maxLines | 0 || 4);
    var words = t.split(/\s+/);
    var current = '';
    function push(line) {
      if (out.lines.length >= max) { out.truncated = true; return; }
      out.lines.push(line);
    }
    function widthOf(s) { return ctx.measureText(s).width; }
    words.forEach(function (word) {
      if (out.truncated) return;
      /* Palabra que no cabe ni sola: partirla por caracteres. */
      while (word && widthOf(word) > maxWidth) {
        var lo = 0, hi = word.length;
        while (lo < hi) {
          var mid = Math.floor((lo + hi + 1) / 2);
          if (widthOf(word.slice(0, mid)) <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        var chunk = lo > 0 ? word.slice(0, lo) : word.slice(0, 1);
        if (current) { push(current); current = ''; }
        push(chunk);
        word = word.slice(chunk.length);
        if (out.truncated) return;
      }
      if (!word) return;
      var candidate = current ? current + ' ' + word : word;
      if (widthOf(candidate) <= maxWidth) { current = candidate; return; }
      if (current) push(current);
      current = word;
    });
    if (current && !out.truncated) push(current);
    /* Si se recortó, la última línea visible lleva elipsis. */
    if (out.truncated && out.lines.length) {
      var last = out.lines[out.lines.length - 1];
      out.lines[out.lines.length - 1] = truncateToWidth(ctx, last.replace(/…$/, ''), maxWidth);
      if (out.lines[out.lines.length - 1].slice(-1) !== '…') {
        out.lines[out.lines.length - 1] = truncateToWidth(ctx, last, maxWidth);
      }
    }
    return out;
  }

  /* Líneas que dibuja la imagen, a partir del modelo: título,
     artista, hasta 8 líneas de letra (o el aviso de sin letra) y
     la nota (texto plano, sin envolver por ancho: el envoltorio lo
     hace drawLyricsImage con el ctx real). Devuelve null sin
     título. Es lo que prueban los tests sin canvas. */
  function buildImageLines(model) {
    if (!model || !model.title) return null;
    var lyricLines = (model.hasLyrics && model.lyricLines)
      ? model.lyricLines.slice(0, MAX_LYRIC_LINES_IMAGE) : [];
    return {
      title: model.title,
      artist: model.artist || '',
      album: model.album || '',
      hasLyrics: !!model.hasLyrics,
      lyricLines: lyricLines,
      lyricTruncated: !!model.lyricTruncated,
      totalLyricLines: model.totalLyricLines || 0,
      hasNote: !!model.hasNote,
      note: model.note || null,
      fileName: buildFileName(model)
    };
  }

  /* ================= Dibujo en canvas (1080x1350) =================
   * Dibuja sobre cualquier contexto 2d (real o stub de tests).
   * Layout con cursor `y` (las secciones que faltan —portada, nota—
   * simplemente no ocupan sitio). Devuelve el layout usado, con
   * maxY para comprobar que todo cabe dentro de los 1350 px, o null
   * sin modelo / sin ctx. opts: {accent, cover} donde cover es una
   * imagen (HTMLImageElement / ImageBitmap) o null. */
  function drawLyricsImage(ctx, model, opts) {
    var lines = buildImageLines(model);
    if (!lines || !ctx) return null;
    opts = opts || {};
    var W = WIDTH, H = HEIGHT;
    var grad = themeGradient(opts.accent || DEFAULT_ACCENT);
    var x0 = 80, x1 = W - 80;
    var maxY = 0;
    function markY(y) { if (y > maxY) maxY = y; }

    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, grad.top);
    bg.addColorStop(0.55, grad.mid);
    bg.addColorStop(1, grad.bottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(W - 60, 120, 260, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(40, H - 260, 220, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    function setLS(px) {
      try { ctx.letterSpacing = px + 'px'; } catch (e) {}
    }

    /* Cabecera: portada a la izquierda (200x200) si hay; título y
       artista a su derecha. Sin portada, título y artista a todo
       lo ancho. */
    var hasCover = !!(opts.cover && opts.cover.width && opts.cover.height);
    var textX = hasCover ? x0 + 232 : x0;
    var textW = x1 - textX;
    var y = 96;
    if (hasCover) {
      try {
        ctx.save();
        roundRectPath(ctx, x0, 72, 200, 200, 24);
        ctx.clip();
        drawCoverFit(ctx, opts.cover, x0, 72, 200, 200);
        ctx.restore();
      } catch (e) { hasCover = false; }
    }
    setLS(5);
    ctx.fillStyle = grad.muted;
    ctx.font = '700 24px ' + FONT_BODY;
    ctx.fillText('COMPARTIR CON LETRA', textX, y); markY(y);
    setLS(0);
    /* Título: hasta 2 líneas visuales. */
    ctx.fillStyle = grad.text;
    ctx.font = '700 56px ' + FONT_TITLE;
    var titleWrapped = wrapText(ctx, lines.title, textW, 2);
    var ty = 168;
    titleWrapped.lines.forEach(function (ln) {
      ctx.fillText(ln, textX, ty); markY(ty);
      ty += 64;
    });
    /* Artista (y álbum, si hay) en una línea cada uno. */
    var ay = ty + 8;
    if (lines.artist) {
      ctx.fillStyle = grad.muted;
      ctx.font = '600 32px ' + FONT_BODY;
      ctx.fillText(truncateToWidth(ctx, lines.artist, textW), textX, ay); markY(ay);
      ay += 44;
    }
    if (lines.album) {
      ctx.fillStyle = grad.muted;
      ctx.font = '600 28px ' + FONT_BODY;
      ctx.fillText(truncateToWidth(ctx, lines.album, textW), textX, ay); markY(ay);
      ay += 40;
    }
    y = Math.max(312, ay + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x0, y, x1 - x0, 2); markY(y + 2);

    /* Letra: hasta 8 líneas, una por renglón (recortada al ancho). */
    y += 56;
    setLS(4);
    ctx.fillStyle = grad.muted;
    ctx.font = '800 26px ' + FONT_BODY;
    ctx.fillText('♪ LETRA', x0, y); markY(y);
    setLS(0);
    y += 48;
    ctx.fillStyle = grad.text;
    ctx.font = '500 34px ' + FONT_BODY;
    if (lines.lyricLines.length) {
      lines.lyricLines.forEach(function (ln) {
        ctx.fillText(truncateToWidth(ctx, ln, x1 - x0), x0, y); markY(y);
        y += 48;
      });
      if (lines.lyricTruncated) {
        ctx.fillStyle = grad.muted;
        ctx.font = '600 26px ' + FONT_BODY;
        ctx.fillText('… (letra completa: ' + lines.totalLyricLines + ' líneas)', x0, y); markY(y);
        y += 40;
      }
    } else {
      ctx.fillStyle = grad.muted;
      ctx.font = 'italic 500 30px ' + FONT_BODY;
      ctx.fillText('Sin letra guardada para esta canción.', x0, y); markY(y);
      y += 48;
    }

    /* Nota personal (solo si hay): hasta 4 líneas visuales. */
    var noteRows = 0;
    if (lines.hasNote && lines.note) {
      y += 28;
      setLS(4);
      ctx.fillStyle = grad.muted;
      ctx.font = '800 26px ' + FONT_BODY;
      ctx.fillText('📝 NOTA PERSONAL', x0, y); markY(y);
      setLS(0);
      y += 44;
      ctx.fillStyle = grad.text;
      ctx.font = '500 30px ' + FONT_BODY;
      var noteWrapped = wrapText(ctx, lines.note, x1 - x0, MAX_NOTE_LINES_IMAGE);
      noteWrapped.lines.forEach(function (ln) {
        ctx.fillText(ln, x0, y); markY(y);
        y += 42;
      });
      noteRows = noteWrapped.lines.length;
      if (noteWrapped.truncated) {
        ctx.fillStyle = grad.muted;
        ctx.font = '600 26px ' + FONT_BODY;
        ctx.fillText('…', x0, y); markY(y);
        y += 36;
      }
    }

    /* Pie: nunca el audio. */
    var footY = H - 44;
    ctx.fillStyle = grad.faint;
    ctx.font = '600 23px ' + FONT_BODY;
    ctx.fillText('Reproductor de Música · Solo texto e imagen, nunca el audio', x0, footY);
    markY(footY);

    return {
      width: W, height: H,
      fileName: lines.fileName,
      hasLyrics: lines.hasLyrics,
      lyricRows: lines.lyricLines.length,
      lyricTruncated: lines.lyricTruncated,
      hasNote: lines.hasNote,
      noteRows: noteRows,
      hasCover: hasCover,
      maxY: maxY
    };
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* Dibuja la portada cubriendo el cuadro (recorte centrado, sin
     deformar): como object-fit: cover. */
  function drawCoverFit(ctx, img, x, y, w, h) {
    var iw = img.width, ih = img.height;
    if (!iw || !ih) return;
    var scale = Math.max(w / iw, h / ih);
    var dw = iw * scale, dh = ih * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  var api = {
    VERSION: VERSION,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    MAX_LYRIC_LINES_TEXT: MAX_LYRIC_LINES_TEXT,
    MAX_LYRIC_LINES_IMAGE: MAX_LYRIC_LINES_IMAGE,
    MAX_NOTE_LINES_IMAGE: MAX_NOTE_LINES_IMAGE,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    LYRICS_PREFIX: LYRICS_PREFIX,
    NOTES_PREFIX: NOTES_PREFIX,
    NO_TRACK_TITLE: NO_TRACK_TITLE,
    norm: norm,
    suffixFor: suffixFor,
    lyricsKeyFor: lyricsKeyFor,
    notesKeyFor: notesKeyFor,
    isNoTrack: isNoTrack,
    isPlaceholderArtist: isPlaceholderArtist,
    parseLRC: parseLRC,
    plainLyricLines: plainLyricLines,
    extractLyricLines: extractLyricLines,
    loadLyricsAndNote: loadLyricsAndNote,
    loadFromLyricsMap: loadFromLyricsMap,
    buildShareModel: buildShareModel,
    buildShareText: buildShareText,
    slugify: slugify,
    buildFileName: buildFileName,
    decideShareMethod: decideShareMethod,
    canShareFiles: canShareFiles,
    hasWebShare: hasWebShare,
    findCurrentTrack: findCurrentTrack,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    mixHex: mixHex,
    parseCssColor: parseCssColor,
    themeGradient: themeGradient,
    truncateText: truncateText,
    truncateToWidth: truncateToWidth,
    wrapText: wrapText,
    buildImageLines: buildImageLines,
    drawLyricsImage: drawLyricsImage
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__rpmCompartirLetraHelpers = api; } catch (e) {}

  /* ---------- Parte de navegador (no corre en Node) ---------- */
  if (typeof document === 'undefined') return;

  var doc = document;
  var nav = (typeof navigator !== 'undefined') ? navigator : null;

  function $(id) { try { return doc.getElementById(id); } catch (e) { return null; } }
  function getApp() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; }
    catch (e) { return null; }
  }
  function toast(msg) {
    try {
      if (g.__rpmApp && typeof g.__rpmApp.toast === 'function') { g.__rpmApp.toast(msg); return; }
    } catch (e) {}
    var el = $('toast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(function () { el.classList.remove('show'); }, 3200);
      return;
    }
    var mine = $('compartirLetraToast');
    if (!mine) {
      mine = doc.createElement('div');
      mine.id = 'compartirLetraToast';
      mine.className = 'compartir-letra-toast';
      mine.setAttribute('role', 'status');
      doc.body.appendChild(mine);
    }
    mine.textContent = msg;
    mine.classList.add('show');
    clearTimeout(mine._t);
    mine._t = setTimeout(function () { mine.classList.remove('show'); }, 3200);
  }
  function readThemeAccent() {
    try {
      var v = getComputedStyle(doc.documentElement).getPropertyValue('--accent');
      return parseCssColor(v) || DEFAULT_ACCENT;
    } catch (e) { return DEFAULT_ACCENT; }
  }

  /* Lee lo que muestra el reproductor (mismo patrón que whatsapp.js). */
  function readCurrentFromDom(d) {
    d = d || doc;
    if (!d || typeof d.getElementById !== 'function') return null;
    var titleEl = d.getElementById('nowTitle');
    var artistEl = d.getElementById('nowArtist');
    var coverEl = d.getElementById('coverImg');
    var title = titleEl ? String(titleEl.textContent || '').trim() : '';
    var artist = artistEl ? String(artistEl.textContent || '').trim() : '';
    var coverVisible = false, coverSrc = '';
    if (coverEl) {
      if (typeof coverEl.getAttribute === 'function') {
        coverSrc = String(coverEl.getAttribute('src') || '');
      }
      if (!coverSrc) coverSrc = String(coverEl.src || '');
      var display = coverEl.style ? String(coverEl.style.display || '') : '';
      coverVisible = !!coverSrc && display !== 'none';
    }
    return { title: title, artist: artist, coverVisible: coverVisible, coverSrc: coverSrc };
  }
  function getTracksSync() {
    var app = getApp();
    if (app && typeof app.getTracks === 'function') {
      try {
        var t = app.getTracks();
        /* getTracks() devuelve el array en memoria (index.html,
           línea 12753); si algún día devolviera promesa, aquí solo
           se usa la vía síncrona y el flujo async lo resuelve. */
        if (Array.isArray(t)) return t;
      } catch (e) { return []; }
    }
    return [];
  }
  function getTracksAsync() {
    var app = getApp();
    if (app && typeof app.getTracks === 'function') {
      try { return Promise.resolve(app.getTracks()).then(function (t) { return Array.isArray(t) ? t : []; }); }
      catch (e) { return Promise.resolve([]); }
    }
    return Promise.resolve([]);
  }
  function resolveCurrentTrack(d) {
    var shown = readCurrentFromDom(d);
    if (!shown || isNoTrack(shown.title, shown.artist)) {
      return { track: null, reason: 'no-track' };
    }
    var track = findCurrentTrack(getTracksSync(), shown.title, shown.artist);
    if (track) return { track: track, fromDom: false, coverVisible: shown.coverVisible, coverSrc: shown.coverSrc };
    return {
      track: {
        title: shown.title,
        artist: isPlaceholderArtist(shown.artist) ? '' : shown.artist
      },
      fromDom: true, coverVisible: shown.coverVisible, coverSrc: shown.coverSrc
    };
  }

  /* Letra + nota de la canción actual: primero localStorage directo
     (claves exactas de lyrics.js / notas.js); si no sale nada y
     __rpmApp.readLyrics existe, respaldo con su mapa. */
  function loadCurrentData(title, artist) {
    var data = { lyricsRaw: null, note: null };
    try {
      if (typeof localStorage !== 'undefined') data = loadLyricsAndNote(localStorage, title, artist);
    } catch (e) {}
    if (!data.lyricsRaw && !data.note) {
      var app = getApp();
      if (app && typeof app.readLyrics === 'function') {
        try {
          var fromMap = loadFromLyricsMap(app.readLyrics() || {}, title, artist);
          if (fromMap.lyricsRaw) data.lyricsRaw = fromMap.lyricsRaw;
          if (fromMap.note) data.note = fromMap.note;
        } catch (e) {}
      }
    }
    return data;
  }

  /* Portada como Blob: __rpmApp.getCoverBlob() (IndexedDB, la fuente
     fiable) -> fetch(track.coverUrl) -> fetch de #coverImg si se ve.
     Mismo orden que whatsapp.js. Nunca lanza: sin portada, null. */
  function getCoverBlob(track, coverSrc) {
    var app = getApp();
    var fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
    function fromUrl(url) {
      if (!url || !fetchFn) return Promise.resolve(null);
      return Promise.resolve().then(function () { return fetchFn(url); })
        .then(function (res) {
          if (!res) return null;
          if (typeof res.blob === 'function') return res.blob();
          return res;
        }).catch(function () { return null; });
    }
    return Promise.resolve()
      .then(function () {
        if (track && track.id && app && typeof app.getCoverBlob === 'function') {
          return Promise.resolve().then(function () { return app.getCoverBlob(track); })
            .catch(function () { return null; });
        }
        return null;
      })
      .then(function (blob) {
        if (blob && blob.size !== 0) return blob;
        if (track && track.coverUrl) return fromUrl(track.coverUrl);
        return null;
      })
      .then(function (blob) {
        if (blob && blob.size !== 0) return blob;
        if (coverSrc) return fromUrl(coverSrc);
        return null;
      })
      .then(function (blob) {
        if (!blob || blob.size === 0) return null;
        return blob;
      })
      .catch(function () { return null; });
  }
  function blobToImage(blob) {
    if (!blob) return Promise.resolve(null);
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).catch(function () { return imageFromBlob(blob); });
    }
    return imageFromBlob(blob);
  }
  function imageFromBlob(blob) {
    return new Promise(function (resolve) {
      try {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () {
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve(null);
        };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  /* Genera el PNG en un canvas. Devuelve {canvas, blob, dataUrl,
     layout} o {canvas:null, blob:null, dataUrl:null, layout:null,
     reason} si el navegador no puede. La portada se intenta cargar
     (si falla, la imagen sale sin portada, no se cancela nada). */
  function renderImage(model, track, coverSrc) {
    return getCoverBlob(track, coverSrc).then(function (blob) {
      return blobToImage(blob).then(function (coverImg) {
        return drawToCanvas(model, coverImg);
      });
    }).catch(function () { return drawToCanvas(model, null); });
  }
  function drawToCanvas(model, coverImg) {
    var canvas;
    try {
      canvas = doc.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
    } catch (e) { return { canvas: null, blob: null, dataUrl: null, layout: null, reason: 'no-canvas' }; }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) {}
    if (!ctx) return { canvas: canvas, blob: null, dataUrl: null, layout: null, reason: 'no-canvas' };
    function finish() {
      var layout = null;
      try { layout = drawLyricsImage(ctx, model, { accent: readThemeAccent(), cover: coverImg }); } catch (e) {}
      return { canvas: canvas, blob: null, dataUrl: null, layout: layout };
    }
    /* Si las fuentes autoalojadas aún no cargaron, esperar un poco
       a document.fonts (patrón wrapped-img.js, 600 ms máx.). */
    function withBlob(res) {
      if (!res.canvas) return res;
      return new Promise(function (resolve) {
        function done(blob, dataUrl) {
          res.blob = blob || null;
          res.dataUrl = dataUrl || null;
          resolve(res);
        }
        try {
          if (res.canvas.toBlob) {
            res.canvas.toBlob(function (b) {
              if (b) { done(b, null); return; }
              try { done(null, res.canvas.toDataURL('image/png')); } catch (e) { done(null, null); }
            }, 'image/png');
          } else {
            try { done(null, res.canvas.toDataURL('image/png')); } catch (e) { done(null, null); }
          }
        } catch (e) { done(null, null); }
      });
    }
    try {
      if (doc.fonts && doc.fonts.ready) {
        return Promise.race([
          doc.fonts.ready.then(function () { return withBlob(finish()); }),
          new Promise(function (res2) { setTimeout(function () { res2(withBlob(finish())); }, 600); })
        ]);
      }
    } catch (e) {}
    return withBlob(finish());
  }
  function downloadRendered(rendered, fileName) {
    if (!rendered || !rendered.canvas) return false;
    function viaUrl(url) {
      var a = doc.createElement('a');
      a.href = url;
      a.download = fileName;
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
    }
    if (rendered.blob) {
      var url = URL.createObjectURL(rendered.blob);
      viaUrl(url);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      return true;
    }
    if (rendered.dataUrl) { viaUrl(rendered.dataUrl); return true; }
    return false;
  }

  function copyText(text, okMsg) {
    function done() { toast(okMsg || 'Texto copiado.'); }
    if (typeof navigator !== 'undefined' && navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); done(); }
    catch (e) { toast('No se pudo copiar. Selecciona el texto a mano.'); }
    doc.body.removeChild(ta);
  }

  /* ---------- Ventana de compartir ---------- */
  var modal = null;
  var current = { model: null, track: null, coverSrc: null, rendered: null, rendering: null };

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function ensureModal() {
    if (modal) return modal;
    var ov = el('div', 'modal-overlay compartir-letra-overlay');
    ov.id = 'compartirLetraModal';
    var box = el('div', 'modal compartir-letra-modal');
    ov.appendChild(box);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeModal(); });
    doc.body.appendChild(ov);
    modal = { ov: ov, box: box };
    return modal;
  }
  function closeModal() {
    if (modal) {
      modal.ov.classList.remove('on');
      modal.ov.setAttribute('aria-hidden', 'true');
    }
  }
  function openModal() {
    var m = ensureModal();
    var model = current.model;
    var text = buildShareText(model);
    var box = m.box;
    box.innerHTML = '';
    box.appendChild(el('h3', null, 'Compartir con letra'));
    var sub = el('p', 'compartir-letra-sub',
      'Solo texto e imagen. El audio nunca se comparte ni se sube.');
    box.appendChild(sub);
    if (model.hasLyrics) {
      box.appendChild(el('p', 'compartir-letra-ok',
        '\u2713 Letra guardada: ' + model.totalLyricLines +
        (model.totalLyricLines === 1 ? ' l\u00EDnea' : ' l\u00EDneas') +
        (model.lyricTruncated
          ? ' (se comparten las primeras ' + model.lyricLines.length + ').'
          : '.')));
    } else {
      box.appendChild(el('p', 'compartir-letra-warn',
        '\u26A0 Sin letra guardada para esta canci\u00F3n: se comparte solo el t\u00EDtulo, el artista' +
        (model.hasNote ? ' y tu nota.' : '.')));
    }
    if (model.hasNote) {
      box.appendChild(el('p', 'compartir-letra-ok', '\u2713 Se incluye tu nota personal.'));
    }
    var pre = el('pre', 'compartir-letra-preview', text);
    pre.setAttribute('aria-label', 'Vista previa del texto a compartir');
    box.appendChild(pre);
    var row = el('div', 'modal-actions compartir-letra-actions');
    var shareBtn = el('button', 'btn small primary', 'Compartir\u2026');
    shareBtn.type = 'button';
    shareBtn.addEventListener('click', function () { doShare(shareBtn); });
    row.appendChild(shareBtn);
    var dlBtn = el('button', 'btn small', 'Descargar imagen');
    dlBtn.type = 'button';
    dlBtn.addEventListener('click', function () { downloadCurrentImage(dlBtn); });
    row.appendChild(dlBtn);
    var copyBtn = el('button', 'btn small', 'Copiar texto');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () { copyText(text, 'Texto copiado.'); });
    row.appendChild(copyBtn);
    var closeBtn = el('button', 'btn small', 'Cerrar');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeModal);
    row.appendChild(closeBtn);
    box.appendChild(row);
    m.ov.classList.add('on');
    m.ov.setAttribute('aria-hidden', 'false');
  }

  function getRendered() {
    if (current.rendered) return Promise.resolve(current.rendered);
    if (current.rendering) return current.rendering;
    current.rendering = renderImage(current.model, current.track, current.coverSrc)
      .then(function (r) { current.rendered = r; return r; });
    return current.rendering;
  }
  function downloadCurrentImage(btn) {
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Generando\u2026'; }
    getRendered().then(function (rendered) {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      if (!rendered || !rendered.canvas || (!rendered.blob && !rendered.dataUrl)) {
        toast('Este navegador no puede generar la imagen. Puedes copiar el texto.');
        return;
      }
      if (downloadRendered(rendered, buildFileName(current.model))) {
        toast('Imagen guardada: ' + buildFileName(current.model));
      } else {
        toast('No se pudo descargar la imagen. Int\u00E9ntalo de nuevo.');
      }
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      toast('No se pudo generar la imagen. Int\u00E9ntalo de nuevo.');
    });
  }

  /* Flujo completo al pulsar «Compartir…». Nunca lanza: cada fallo
     termina en un toast que dice qué pasó y qué alternativa queda. */
  function doShare(btn) {
    var model = current.model;
    var text = buildShareText(model);
    if (!model || !text) {
      toast('No hay ninguna canci\u00F3n sonando para compartir.');
      return Promise.resolve({ ok: false, reason: 'no-track' });
    }
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparando\u2026'; }
    function restore() { if (btn) { btn.disabled = false; btn.textContent = old; } }
    return getRendered().then(function (rendered) {
      var hasImage = !!(rendered && rendered.blob);
      var file = null;
      if (hasImage) {
        try { file = new File([rendered.blob], buildFileName(model), { type: 'image/png' }); }
        catch (e) { file = rendered.blob; }
      }
      var method = decideShareMethod(
        { hasShare: hasWebShare(nav), canShareFiles: canShareFiles(nav, file) },
        hasImage);
      if (method === 'share-files') {
        return nav.share({ files: [file], text: text, title: model.title })
          .then(function () {
            restore();
            toast('Compartido con letra (imagen + texto).');
            return { ok: true, method: method, withImage: true };
          })
          .catch(function (err) {
            if (err && err.name === 'AbortError') {
              restore();
              return { ok: false, reason: 'cancelled' };
            }
            /* No se pudo adjuntar la imagen: intentar solo texto. */
            return nav.share({ text: text, title: model.title })
              .then(function () {
                restore();
                toast('Compartido (solo texto: no se pudo adjuntar la imagen; puedes descargarla con \u00ABDescargar imagen\u00BB).');
                return { ok: true, method: 'share-text', withImage: false };
              })
              .catch(function (err2) {
                restore();
                if (err2 && err2.name === 'AbortError') return { ok: false, reason: 'cancelled' };
                toast('No se pudo abrir el panel de compartir. Puedes descargar la imagen o copiar el texto.');
                return { ok: false, reason: 'share-failed' };
              });
          });
      }
      if (method === 'share-text') {
        return nav.share({ text: text, title: model.title })
          .then(function () {
            restore();
            toast(hasImage
              ? 'Compartido (solo texto: este dispositivo no permite adjuntar la imagen; puedes descargarla con \u00ABDescargar imagen\u00BB).'
              : 'Compartido (solo texto: no se pudo generar la imagen).');
            return { ok: true, method: method, withImage: false };
          })
          .catch(function (err) {
            restore();
            if (err && err.name === 'AbortError') return { ok: false, reason: 'cancelled' };
            toast('No se pudo abrir el panel de compartir. Puedes descargar la imagen o copiar el texto.');
            return { ok: false, reason: 'share-failed' };
          });
      }
      if (method === 'download-image') {
        restore();
        if (downloadRendered(rendered, buildFileName(model))) {
          toast('Este navegador no permite compartir directamente: se descarg\u00F3 la imagen (' + buildFileName(model) + ') para que la env\u00EDes t\u00FA.');
          return { ok: true, method: method, withImage: true };
        }
        toast('No se pudo descargar la imagen. Puedes copiar el texto.');
        return { ok: false, reason: 'download-failed' };
      }
      /* copy-text: sin Web Share y sin imagen. */
      restore();
      copyText(text, 'Este navegador no permite compartir directamente: se copi\u00F3 el texto.');
      return { ok: true, method: method, withImage: false };
    }).catch(function () {
      restore();
      toast('No se pudo compartir. Int\u00E9ntalo de nuevo.');
      return { ok: false, reason: 'error' };
    });
  }

  /* Abre la ventana para la canción que suena. Devuelve una promesa
     con {ok, model} o {ok:false, reason}. */
  function openShareWithLyrics() {
    var resolved;
    try { resolved = resolveCurrentTrack(doc); } catch (e) { resolved = { track: null, reason: 'no-track' }; }
    if (!resolved || !resolved.track) {
      toast('No hay ninguna canci\u00F3n sonando para compartir con letra.');
      return Promise.resolve({ ok: false, reason: 'no-track' });
    }
    var track = resolved.track;
    var shown = readCurrentFromDom(doc) || {};
    var title = track.title || track.name || shown.title || '';
    var artist = track.artist || '';
    if (isPlaceholderArtist(artist)) artist = '';
    if (!artist && shown.artist && !isPlaceholderArtist(shown.artist)) artist = shown.artist;
    var data = loadCurrentData(title, artist || shown.artist || '');
    var model = buildShareModel({
      title: title,
      artist: artist || shown.artist || '',
      album: track.album || '',
      lyricsRaw: data.lyricsRaw,
      note: data.note
    });
    if (!model) {
      toast('No hay ninguna canci\u00F3n sonando para compartir con letra.');
      return Promise.resolve({ ok: false, reason: 'no-track' });
    }
    current = {
      model: model,
      track: track,
      coverSrc: (resolved.coverVisible && resolved.coverSrc) ? resolved.coverSrc : null,
      rendered: null,
      rendering: null
    };
    openModal();
    return Promise.resolve({ ok: true, model: model });
  }

  /* ---------- Botón «♪ Compartir con letra» junto a «Compartir» ---------- */
  function syncButtonState() {
    try {
      var btn = $('btnCompartirLetra');
      if (!btn) return;
      var shown = readCurrentFromDom(doc);
      btn.disabled = !shown || isNoTrack(shown.title, shown.artist);
    } catch (e) {}
  }
  function ensureButton() {
    try {
      if ($('btnCompartirLetra')) { syncButtonState(); return true; }
      /* Ancla principal: #btnShareCurrent («Compartir», el botón que
         comparte el audio). Respaldo: #btnWhatsApp, #notasBtn o
         #btnEditCurrent, todos en la misma fila de la ficha. */
      var anchor = $('btnShareCurrent') || $('btnWhatsApp') || $('notasBtn') || $('btnEditCurrent');
      if (!anchor || !anchor.parentNode) return false;
      var btn = doc.createElement('button');
      btn.className = 'btn small';
      btn.id = 'btnCompartirLetra';
      btn.type = 'button';
      btn.textContent = '\u266A Compartir con letra';
      btn.title = 'Compartir la canci\u00F3n que suena con su letra y tu nota (imagen + texto; nunca el audio)';
      btn.setAttribute('aria-label', 'Compartir la canci\u00F3n que suena con su letra');
      btn.addEventListener('click', function () { openShareWithLyrics(); });
      if (anchor.nextSibling) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      else anchor.parentNode.appendChild(btn);
      syncButtonState();
      return true;
    } catch (e) { return false; }
  }

  function init() {
    try {
      ensureButton();
      /* La ficha se reescribe al cambiar de canción (render() pone
         #nowTitle / #nowArtist): observar esos dos nodos para
         activar/desactivar el botón, y el body para reponer el
         botón si la fila se reconstruye. */
      if (typeof MutationObserver !== 'undefined') {
        ['nowTitle', 'nowArtist'].forEach(function (id) {
          var node = $(id);
          if (node) {
            new MutationObserver(function () { syncButtonState(); })
              .observe(node, { childList: true, characterData: true, subtree: true });
          }
        });
        new MutationObserver(function () { ensureButton(); })
          .observe(doc.body, { childList: true, subtree: true });
      }
      doc.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && modal && modal.ov.classList.contains('on')) closeModal();
      });
    } catch (e) { /* fail-safe: sin botón, la app sigue igual */ }
  }

  var browserApi = {
    open: openShareWithLyrics,
    share: doShare,
    downloadImage: downloadCurrentImage,
    copyText: copyText,
    ensureButton: ensureButton,
    syncButtonState: syncButtonState,
    resolveCurrentTrack: resolveCurrentTrack,
    loadCurrentData: loadCurrentData,
    renderImage: renderImage,
    version: VERSION
  };
  try { g.__rpmCompartirLetra = browserApi; } catch (e) {}
  api.open = openShareWithLyrics;
  api.share = doShare;
  api.renderImage = renderImage;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
