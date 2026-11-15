/* wrapped-img.js — «Wrapped como imagen» (reproductor-de-musica v3.5.0, módulo aparte).
 *
 * Qué hace: añade un botón «🖼️ Descargar como imagen» dentro del modal
 * del Wrapped (junto a «📋 Copiar resumen») que genera un PNG 1080x1350
 * en local con canvas y lo descarga como `año-en-musica-AAAA.png`.
 * Todo es local: nada se sube ni se comparte solo; el PNG solo sale del
 * dispositivo si el usuario lo comparte donde quiera.
 *
 * De dónde salen los datos (leído en app/wrapped.js antes de diseñar):
 *   - window.__wrappedHelpers existe (wrapped.js, línea ~258:
 *     `try { g.__wrappedHelpers = api; }`) y expone computeWrapped,
 *     formatWrappedText, computeStreak, availableYears y fmtMinutes.
 *   - PERO no expone ni el Wrapped ya calculado (vive en la variable
 *     de clausura `currentWrapped`, sin getter: __rpmWrapped solo
 *     expone open/close/computeWrapped/formatWrappedText) ni su
 *     lector interno readData(). Por eso la vía principal NO es
 *     «pedirle el dato al modal», sino RECALCULAR con la misma
 *     función y los mismos datos que usa el modal:
 *       1) computeWrapped(datos, {year}) con datos leídos igual que
 *          wrapped.js (primero __rpmApp.idbMetaGet('packState') +
 *          getTracks(); si no está, la misma IndexedDB en solo
 *          lectura: base 'reproductor-musica-local' v3, almacenes
 *          meta/packState y tracks) y el año del selector
 *          #wrappedYear. Mismos tops, mismos minutos, misma racha.
 *       2) FALLBACK: si __wrappedHelpers no existe o la lectura
 *          falla, se parsea el DOM del modal (#wrappedBody:
 *          .wrapped-big, .wrapped-kicker, .wrapped-streak y las
 *          listas .wrapped-section/.wrapped-rank) con
 *          parseWrappedBody(). Es frágil por diseño (depende del
 *          marcado del modal) y solo se usa cuando la vía 1 no puede.
 *   - Si ninguna vía da datos suficientes (hasData falso, sin tops
 *     ni minutos), el botón avisa con toast y NO genera una imagen
 *     vacía.
 *
 * Por qué el botón se inyecta por DOM y no por HTML estático: el
 * modal del Wrapped (#wrappedModal, con #wrappedCopyBtn) lo construye
 * wrapped.js en JS al abrirse por primera vez; no existe en
 * index.html. Este módulo observa el DOM (MutationObserver + enganche
 * al pulsar #btnWrapped) e inserta el botón junto al de copiar en
 * cuanto el modal existe. Ver WIRING.md.
 *
 * Canvas: 1080x1350 (4:5, apto para compartir), degradado del tema
 * (del --accent actual, leído por getComputedStyle; si no se puede
 * leer, #E94E1B, el acento por defecto de la app), título
 * «Mi año en música», año, top 5 canciones y top 5 artistas, minutos
 * totales y racha. Sin fuentes externas: 'Plus Jakarta Sans' y
 * 'Fraunces' ya autoalojadas por la app (fonts.css, woff2 locales),
 * con fallback a fuentes del sistema (system-ui / Georgia, serif).
 * Si una fuente aún no cargó, el canvas usa el fallback: la imagen
 * sale igual, solo cambia la tipografía.
 *
 * Fail-safe (patrón wrapped.js / visual.js): IIFE, try/catch en el
 * arranque y en la descarga. Si el módulo falla o no carga, el modal
 * del Wrapped sigue funcionando como en 3.4.0 (solo falta el botón
 * de imagen). No escribe en IndexedDB ni toca el historial. */
(function (g) {
  'use strict';

  var VERSION = '3.5.0';
  var WIDTH = 1080;
  var HEIGHT = 1350;
  var TOP_N = 5;
  var DEFAULT_ACCENT = '#E94E1B'; // --accent por defecto de la app
  var UNKNOWN_ARTIST = 'Artista desconocido';
  var UNKNOWN_TITLE = 'Sin título';
  var DB_NAME = 'reproductor-musica-local';
  var FONT_TITLE = '"Fraunces", Georgia, serif';
  var FONT_BODY = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

  /* ================= Ayudas puras (probadas con Node) ================= */

  function num(v, dflt) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : (dflt || 0);
  }
  function str(v, dflt) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : (dflt || '');
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /* Año válido (1900-2100) o el año actual: nunca un nombre de archivo
     con «NaN» o «undefined». */
  function sanitizeYear(y) {
    var n = parseInt(y, 10);
    if (isFinite(n) && n >= 1900 && n <= 2100) return n;
    return new Date().getFullYear();
  }

  /* Minutos como se leen en la imagen: «45 min», «1 h 00 min»,
     «2 h 05 min». Igual que fmtMinutes() de wrapped.js para >= 60
     minutos (horas + minutos a dos cifras) y con la unidad «min»
     siempre visible también por debajo de la hora (en el modal el
     número va acompañado de «minutos escuchados»; en la imagen el
     texto va solo). */
  function formatMinutes(sec) {
    var m = Math.round(num(sec) / 60);
    if (m < 60) return String(m) + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }

  /* Nombre del archivo descargado. */
  function buildFileName(year) {
    return 'año-en-musica-' + sanitizeYear(year) + '.png';
  }

  /* Recorte por caracteres, con elipsis: para títulos largos en el
     modelo de líneas. El recorte fino por ancho real se hace en el
     canvas con truncateToWidth(). */
  function truncateText(text, maxChars) {
    var t = str(text, '');
    if (!t) return '';
    var max = Math.max(1, maxChars | 0 || 40);
    if (t.length <= max) return t;
    return t.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
  }

  /* Recorte por ancho real en el canvas (ctx.measureText). Con un
     ctx stub en Node (measureText: nº de caracteres x ancho fijo)
     se comporta igual. Devuelve el texto tal cual si cabe. */
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

  /* ¿Hay datos suficientes para una imagen que no sea vacía?
     Acepta el objeto tal como lo devuelve computeWrapped() de
     wrapped.js y también el modelo normalizado (ambos llevan
     hasData, totalSec, topSongs y topArtists). */
  function hasEnoughData(w) {
    if (!w || w.hasData !== true) return false;
    if (!(num(w.totalSec) > 0) && !(num(w.minutes) > 0)) return false;
    var songs = Array.isArray(w.topSongs) ? w.topSongs : [];
    var artists = Array.isArray(w.topArtists) ? w.topArtists : [];
    return songs.length > 0 || artists.length > 0;
  }

  /* Normaliza el Wrapped (de computeWrapped o del parseo del DOM) al
     modelo que dibuja la imagen. Nunca lanza con datos raros: los
     campos que faltan se sustituyen por «Sin título» /
     «Artista desconocido» y los tops se recortan a 5. Devuelve null
     si no hay datos suficientes. */
  function normalizeWrapped(w) {
    if (!w || typeof w !== 'object') return null;
    var totalSec = num(w.totalSec, 0);
    if (!totalSec && num(w.minutes) > 0) totalSec = num(w.minutes) * 60;
    var model = {
      year: sanitizeYear(w.year),
      totalSec: totalSec,
      minutes: Math.round(totalSec / 60),
      minutesText: formatMinutes(totalSec),
      estimated: !!w.estimated,
      plays: num(w.plays, 0),
      songs: num(w.songs, 0),
      artistsN: num(w.artistsN, 0),
      streak: (typeof w.streak === 'number' && w.streak > 0) ? Math.floor(w.streak) : null,
      topSongs: [],
      topArtists: [],
      hasData: w.hasData === true
    };
    function normRow(r, withCount) {
      if (!r) return null;
      var label = str(r.label, UNKNOWN_TITLE);
      var sub = str(r.sub, '');
      var sec = num(r.sec, 0);
      if (!sec && num(r.min) > 0) sec = num(r.min) * 60;
      return {
        label: label,
        sub: sub || (withCount ? UNKNOWN_ARTIST : ''),
        sec: sec,
        min: Math.round(sec / 60),
        count: num(r.count, 0)
      };
    }
    (Array.isArray(w.topSongs) ? w.topSongs : []).slice(0, TOP_N).forEach(function (r) {
      var row = normRow(r, true);
      if (row) model.topSongs.push(row);
    });
    (Array.isArray(w.topArtists) ? w.topArtists : []).slice(0, TOP_N).forEach(function (r) {
      var row = normRow(r, false);
      if (row) model.topArtists.push(row);
    });
    if (!hasEnoughData(model)) return null;
    return model;
  }

  /* Formatea el modelo a las líneas que se dibujan: título, año,
     minutos, estadísticas, filas top 5 de canciones y de artistas,
     texto de racha y nota de estimado. Es lo que prueban los tests
     (sin canvas): que solo salgan 5 filas, que los minutos vayan
     como «X h Y min», que los títulos largos se recorten y que el
     año sea el del Wrapped. */
  function buildImageLines(w) {
    var m = normalizeWrapped(w);
    if (!m) return null;
    function songLine(r, i) {
      return {
        rank: i + 1,
        title: truncateText(r.label, 44),
        artist: truncateText(r.sub, 40),
        meta: r.min + ' min' + (r.count > 0 ? ' · ' + r.count + (r.count === 1 ? ' vez' : ' veces') : ''),
        sec: r.sec
      };
    }
    function artistLine(r, i) {
      return { rank: i + 1, title: truncateText(r.label, 44), meta: r.min + ' min', sec: r.sec };
    }
    return {
      title: 'Mi año en música',
      year: m.year,
      yearLine: 'Mi año en música · ' + m.year,
      minutesText: m.minutesText,
      minutesLabel: 'minutos escuchados' + (m.estimated ? ' (estimados)' : ''),
      stats: [
        { value: String(m.plays), label: m.plays === 1 ? 'reproducción' : 'reproducciones' },
        { value: String(m.songs), label: m.songs === 1 ? 'canción distinta' : 'canciones distintas' },
        { value: String(m.artistsN), label: m.artistsN === 1 ? 'artista distinto' : 'artistas distintos' }
      ],
      streakText: (typeof m.streak === 'number' && m.streak > 0)
        ? '🔥 Racha: ' + m.streak + (m.streak === 1 ? ' día' : ' días') + ' seguidos'
        : null,
      songLines: m.topSongs.map(songLine),
      artistLines: m.topArtists.map(artistLine),
      fileName: buildFileName(m.year)
    };
  }

  /* ================= Color: degradado del tema ================= */

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var h = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      h = h.split('').map(function (c) { return c + c; }).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var n = clamp(Math.round(v), 0, 255);
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('').toUpperCase();
  }
  /* Mezcla a -> b con factor t (0 = a, 1 = b). */
  function mixHex(a, b, t) {
    var ra = hexToRgb(a), rb = hexToRgb(b);
    if (!ra || !rb) return DEFAULT_ACCENT;
    return rgbToHex([
      ra[0] + (rb[0] - ra[0]) * t,
      ra[1] + (rb[1] - ra[1]) * t,
      ra[2] + (rb[2] - ra[2]) * t
    ]);
  }
  /* Lee un color CSS (#rrggbb, #rgb o rgb(r,g,b)) y lo normaliza a
     #RRGGBB; null si no se reconoce. */
  function parseCssColor(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    var hex = hexToRgb(v);
    if (hex) return rgbToHex(hex);
    var m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return rgbToHex([+m[1], +m[2], +m[3]]);
    return null;
  }

  /* Degradado de la imagen a partir del acento del tema activo:
     oscuro arriba (ahí va el texto principal, siempre sobre fondo
     oscuro para que el blanco se lea) y acento abajo. Con el acento
     por defecto (#E94E1B) reproduce el aire de .summary-card /
     .wrapped-card (#2B2118 -> #E94E1B); con Neón (#00E5FF),
     Atardecer (#FF6B35) o Bosque (#4ADE80) de temas.js, el mismo
     esquema con su acento. */
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

  /* ================= Fallback: parsear el DOM del modal =================
   * Solo se usa si la vía principal (computeWrapped) no está
   * disponible. Lee lo que el modal ya muestra: .wrapped-kicker
   * (año), .wrapped-big (minutos), .wrapped-streak (racha) y las
   * secciones .wrapped-section con sus filas .wrapped-rank. Si el
   * modal muestra el estado vacío (.wrapped-empty), devuelve un
   * modelo con hasData false (normalizeWrapped lo rechazará). */
  function parseWrappedBody(bodyEl) {
    if (!bodyEl || typeof bodyEl.querySelector !== 'function') return null;
    function textOf(el) {
      return el && typeof el.textContent === 'string' ? el.textContent : '';
    }
    function firstInt(text) {
      var m = String(text || '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }
    var empty = null;
    try { empty = bodyEl.querySelector('.wrapped-empty'); } catch (e) {}
    var kicker = textOf(safeQuery(bodyEl, '.wrapped-kicker'));
    var big = textOf(safeQuery(bodyEl, '.wrapped-big'));
    var streakEl = safeQuery(bodyEl, '.wrapped-streak');
    var yearMatch = kicker.match(/(19|20)\d{2}/);
    var minutes = firstInt(big);
    var streak = null;
    if (streakEl) {
      var sm = textOf(streakEl).match(/(\d+)\s*d[ií]a/);
      if (sm) streak = parseInt(sm[1], 10);
    }
    var estimated = /estimad/i.test(big) || /estimad/i.test(textOf(safeQuery(bodyEl, '.wrapped-note')));
    var topSongs = [], topArtists = [];
    var sections = [];
    try { sections = bodyEl.querySelectorAll('.wrapped-section') || []; } catch (e) { sections = []; }
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      var heading = '';
      try {
        var h = sec.querySelector('h4');
        heading = textOf(h).toLowerCase();
      } catch (e) {}
      var isSongs = heading.indexOf('cancion') !== -1;
      var isArtists = heading.indexOf('artist') !== -1;
      if (!isSongs && !isArtists) continue;
      var rows = [];
      try { rows = sec.querySelectorAll('.wrapped-rank li') || []; } catch (e) { rows = []; }
      var parsedRows = [];
      for (var i = 0; i < rows.length; i++) {
        var li = rows[i];
        var titleEl = null, metaEl = null;
        try { titleEl = li.querySelector('.wrapped-rank-t'); } catch (e) {}
        try { metaEl = li.querySelector('.wrapped-rank-meta'); } catch (e) {}
        var full = textOf(titleEl).trim();
        var label = full, sub = '';
        var sep = full.indexOf(' — ');
        if (sep !== -1) { label = full.slice(0, sep).trim(); sub = full.slice(sep + 3).trim(); }
        var meta = textOf(metaEl);
        var minM = meta.match(/(\d+)\s*min/);
        var countM = meta.match(/(\d+)\s*(?:veces|vez)\b/); // «1 vez» / «10 veces»
        parsedRows.push({
          label: label || UNKNOWN_TITLE,
          sub: sub,
          sec: minM ? parseInt(minM[1], 10) * 60 : 0,
          count: countM ? parseInt(countM[1], 10) : 0
        });
      }
      if (isSongs) topSongs = parsedRows.slice(0, TOP_N);
      else topArtists = parsedRows.slice(0, TOP_N);
    }
    var hasRows = topSongs.length > 0 || topArtists.length > 0;
    return {
      year: yearMatch ? parseInt(yearMatch[0], 10) : sanitizeYear(),
      totalSec: minutes * 60,
      minutes: minutes,
      estimated: estimated,
      plays: 0,
      songs: topSongs.length,
      artistsN: topArtists.length,
      streak: streak,
      topSongs: topSongs,
      topArtists: topArtists,
      hasData: !empty && (minutes > 0 || hasRows),
      source: 'dom'
    };
  }
  function safeQuery(root, sel) {
    try { return root.querySelector(sel); } catch (e) { return null; }
  }

  /* ================= Dibujo en canvas (1080x1350) =================
   * Dibuja sobre cualquier contexto 2d (real o stub de tests).
   * Layout con cursor `y` (las secciones que faltan —racha, tops
   * vacíos— simplemente no ocupan sitio). Devuelve el layout usado,
   * con maxY para comprobar que todo cabe dentro de los 1350 px. */
  function drawWrappedImage(ctx, w, opts) {
    var lines = buildImageLines(w);
    if (!lines || !ctx) return null;
    opts = opts || {};
    var W = WIDTH, H = HEIGHT;
    var grad = themeGradient(opts.accent || DEFAULT_ACCENT);
    var x0 = 80, x1 = W - 80; // márgenes laterales
    var maxY = 0;
    function markY(y) { if (y > maxY) maxY = y; }

    /* Fondo: degradado vertical del tema. */
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, grad.top);
    bg.addColorStop(0.55, grad.mid);
    bg.addColorStop(1, grad.bottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    /* Dos círculos decorativos tenues. */
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

    /* Cabecera. */
    var y = 96;
    setLS(6);
    ctx.fillStyle = grad.muted;
    ctx.font = '700 26px ' + FONT_BODY;
    ctx.fillText('TU AÑO EN MÚSICA', x0, y); markY(y);
    setLS(0);
    y = 168;
    ctx.fillStyle = grad.text;
    ctx.font = '700 64px ' + FONT_TITLE;
    ctx.fillText(lines.title, x0, y); markY(y);
    y = 292;
    ctx.font = '700 120px ' + FONT_TITLE;
    ctx.fillText(String(lines.year), x0, y); markY(y);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(x0, 330, 120, 6); markY(336);

    /* Minutos. */
    y = 428;
    ctx.fillStyle = grad.text;
    ctx.font = '800 64px ' + FONT_BODY;
    ctx.fillText(lines.minutesText, x0, y); markY(y);
    y = 470;
    ctx.fillStyle = grad.muted;
    ctx.font = '600 26px ' + FONT_BODY;
    ctx.fillText(lines.minutesLabel, x0, y); markY(y);

    /* Estadísticas: 3 columnas. */
    y = 540;
    var colW = (x1 - x0) / 3;
    lines.stats.forEach(function (st, i) {
      var cx = x0 + i * colW;
      ctx.fillStyle = grad.text;
      ctx.font = '800 44px ' + FONT_BODY;
      ctx.fillText(st.value, cx, y);
      ctx.fillStyle = grad.muted;
      ctx.font = '600 24px ' + FONT_BODY;
      ctx.fillText(st.label, cx, y + 34);
    });
    y += 34; markY(y);

    /* Racha (solo si hay). */
    if (lines.streakText) {
      y += 30;
      var pillH = 52;
      var pillW = 560;
      try {
        ctx.font = '700 28px ' + FONT_BODY;
        pillW = Math.min(x1 - x0, Math.ceil(ctx.measureText(lines.streakText).width) + 56);
      } catch (e) {}
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRectPath(ctx, x0, y, pillW, pillH, 26);
      ctx.fill();
      ctx.fillStyle = grad.text;
      ctx.font = '700 28px ' + FONT_BODY;
      ctx.fillText(lines.streakText, x0 + 26, y + 36);
      y += pillH; markY(y);
    }

    /* Top canciones: una línea por canción («Título — Artista») + barra. */
    y = drawRankSection(ctx, {
      heading: 'TOP CANCIONES',
      rows: lines.songLines,
      y: y + 58,
      x0: x0, x1: x1,
      rowH: 58,
      grad: grad,
      withBar: true,
      withArtist: false
    });
    markY(y);

    /* Top artistas. */
    y = drawRankSection(ctx, {
      heading: 'TOP ARTISTAS',
      rows: lines.artistLines,
      y: y + 44,
      x0: x0, x1: x1,
      rowH: 40,
      grad: grad,
      withBar: false,
      withArtist: false
    });
    markY(y);

    /* Pie. */
    var footY = H - 44;
    ctx.fillStyle = grad.faint;
    ctx.font = '600 23px ' + FONT_BODY;
    ctx.fillText('Reproductor de Música · Solo en este dispositivo, nada se sube', x0, footY);
    markY(footY);

    return {
      width: W, height: H,
      year: lines.year,
      fileName: lines.fileName,
      songRows: lines.songLines.length,
      artistRows: lines.artistLines.length,
      hasStreak: !!lines.streakText,
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

  /* Una sección de ranking: encabezado + filas con círculo de puesto,
     título (recortado al ancho real; en canciones, «Título — Artista»
     en una sola línea), meta a la derecha y, opcional, barra
     proporcional al máximo. Devuelve la `y` bajo la última fila. */
  function drawRankSection(ctx, o) {
    if (!o.rows || !o.rows.length) return o.y;
    var y = o.y;
    try { ctx.letterSpacing = '4px'; } catch (e) {}
    ctx.fillStyle = o.grad.muted;
    ctx.font = '800 26px ' + FONT_BODY;
    ctx.fillText(o.heading, o.x0, y);
    try { ctx.letterSpacing = '0px'; } catch (e) {}
    y += 16;
    var maxSec = 1;
    o.rows.forEach(function (r) { if (r.sec > maxSec) maxSec = r.sec; });
    var titleMaxW = o.x1 - o.x0 - 62 - 180; // hueco del círculo + meta
    o.rows.forEach(function (r) {
      var top = y;
      /* Círculo del puesto. */
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(o.x0 + 22, top + 20, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = o.grad.text;
      ctx.font = '800 25px ' + FONT_BODY;
      ctx.textAlign = 'center';
      ctx.fillText(String(r.rank), o.x0 + 22, top + 28);
      ctx.textAlign = 'left';
      /* Título + meta. */
      var tx = o.x0 + 58;
      var shown = r.title + (r.artist ? ' — ' + r.artist : '');
      ctx.fillStyle = o.grad.text;
      ctx.font = '700 30px ' + FONT_BODY;
      ctx.fillText(truncateToWidth(ctx, shown, titleMaxW), tx, top + 29);
      ctx.fillStyle = o.grad.muted;
      ctx.font = '700 25px ' + FONT_BODY;
      ctx.textAlign = 'right';
      ctx.fillText(r.meta, o.x1, top + 28);
      ctx.textAlign = 'left';
      if (o.withBar) {
        var barY = top + 42;
        var barW = o.x1 - tx;
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(tx, barY, barW, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(tx, barY, Math.max(8, Math.round(barW * (r.sec / maxSec))), 6);
      }
      y = top + o.rowH;
    });
    return y;
  }

  var api = {
    VERSION: VERSION,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    TOP_N: TOP_N,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    sanitizeYear: sanitizeYear,
    formatMinutes: formatMinutes,
    buildFileName: buildFileName,
    truncateText: truncateText,
    truncateToWidth: truncateToWidth,
    hasEnoughData: hasEnoughData,
    normalizeWrapped: normalizeWrapped,
    buildImageLines: buildImageLines,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    mixHex: mixHex,
    parseCssColor: parseCssColor,
    themeGradient: themeGradient,
    parseWrappedBody: parseWrappedBody,
    drawWrappedImage: drawWrappedImage
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__wrappedImgHelpers = api; } catch (e) {}

  /* ---------- Parte de navegador (no corre en Node) ---------- */
  if (typeof document === 'undefined') return;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function toast(msg) {
    try {
      if (g.__rpmApp && typeof g.__rpmApp.toast === 'function') { g.__rpmApp.toast(msg); return; }
    } catch (e) {}
    var el = $('toast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(function () { el.classList.remove('show'); }, 3200);
    }
  }

  /* Acento actual del tema: --accent que temas.js escribe como
     variable inline (o el :root por defecto). Si no se puede leer,
     el acento por defecto. */
  function readThemeAccent() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      return parseCssColor(v) || DEFAULT_ACCENT;
    } catch (e) { return DEFAULT_ACCENT; }
  }
  function selectedYear() {
    var sel = $('wrappedYear');
    if (!sel) return undefined;
    var y = parseInt(sel.value, 10);
    return isFinite(y) ? y : undefined;
  }

  /* Lectura de datos como la hace wrapped.js: primero por __rpmApp
     y, si no está, la misma IndexedDB en solo lectura. */
  function readWrappedData() {
    var app = g.__rpmApp;
    if (app && typeof app.idbMetaGet === 'function' && typeof app.getTracks === 'function') {
      return Promise.all([app.idbMetaGet('packState'), app.getTracks()]).then(function (res) {
        var st = res[0] || {};
        return {
          statsLog: st.statsLog || [], history: st.history || [],
          counts: st.counts || {}, tracks: res[1] || []
        };
      });
    }
    return readWrappedDataDirect();
  }
  function readWrappedDataDirect() {
    return new Promise(function (resolve) {
      try {
        if (!('indexedDB' in g)) { resolve(null); return; }
        var req = g.indexedDB.open(DB_NAME, 3);
        req.onsuccess = function () {
          var db = req.result;
          var out = { statsLog: [], history: [], counts: {}, tracks: [] };
          var done = 0;
          var finish = function () { done++; if (done >= 2) { try { db.close(); } catch (e) {} resolve(out); } };
          try {
            var tx1 = db.transaction('meta', 'readonly');
            var r1 = tx1.objectStore('meta').get('packState');
            r1.onsuccess = function () {
              var st = (r1.result && r1.result.value) || {};
              out.statsLog = st.statsLog || []; out.history = st.history || []; out.counts = st.counts || [];
              finish();
            };
            r1.onerror = finish;
          } catch (e) { finish(); }
          try {
            var tx2 = db.transaction('tracks', 'readonly');
            var r2 = tx2.objectStore('tracks').getAll();
            r2.onsuccess = function () { out.tracks = r2.result || []; finish(); };
            r2.onerror = finish;
          } catch (e) { finish(); }
        };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  /* Datos para la imagen: vía 1 (recalcular con __wrappedHelpers)
     o vía 2 (parsear el DOM del modal). Devuelve
     {model, source} o {model:null, source, reason}. */
  function getWrappedForImage() {
    var helpers = g.__wrappedHelpers;
    var year = selectedYear();
    if (helpers && typeof helpers.computeWrapped === 'function') {
      return readWrappedData().then(function (data) {
        if (!data) return fallbackFromDom('no-data');
        var w;
        try { w = helpers.computeWrapped(data, { year: year }); } catch (e) { return fallbackFromDom('compute-error'); }
        var model = normalizeWrapped(w);
        if (model) return { model: model, source: 'helpers' };
        return fallbackFromDom('no-data');
      }).catch(function () { return fallbackFromDom('read-error'); });
    }
    return Promise.resolve(fallbackFromDom('no-helpers'));
  }
  function fallbackFromDom(reason) {
    try {
      var body = $('wrappedBody');
      if (!body) return { model: null, source: 'dom', reason: reason };
      var parsed = parseWrappedBody(body);
      var model = normalizeWrapped(parsed);
      if (model) return { model: model, source: 'dom' };
      return { model: null, source: 'dom', reason: 'no-data' };
    } catch (e) {
      return { model: null, source: 'dom', reason: 'dom-error' };
    }
  }

  /* Genera el PNG y dispara la descarga. Devuelve una promesa con
     {ok, fileName, source} o {ok:false, reason}. */
  function downloadWrappedImage() {
    return getWrappedForImage().then(function (res) {
      if (!res || !res.model) {
        toast('Todavía no hay escucha registrada en este periodo: escucha algunas canciones y vuelve aquí.');
        return { ok: false, reason: (res && res.reason) || 'no-data' };
      }
      var model = res.model;
      var fileName = buildFileName(model.year);
      var canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        toast('Este navegador no puede generar la imagen.');
        return { ok: false, reason: 'no-canvas' };
      }
      /* Si las fuentes autoalojadas aún no cargaron, esperar un poco
         a document.fonts para que el título no salga con fallback
         cuando no hace falta; si no hay document.fonts, dibujar ya. */
      function drawAndSave() {
        drawWrappedImage(ctx, model, { accent: readThemeAccent() });
        saveCanvas(canvas, fileName);
        toast('Imagen guardada: ' + fileName);
        return { ok: true, fileName: fileName, source: res.source };
      }
      try {
        if (document.fonts && document.fonts.ready) {
          return Promise.race([
            document.fonts.ready.then(function () { return drawAndSave(); }),
            new Promise(function (res2) { setTimeout(function () { res2(drawAndSave()); }, 600); })
          ]);
        }
      } catch (e) {}
      return drawAndSave();
    }).catch(function () {
      toast('No se pudo generar la imagen. Inténtalo de nuevo.');
      return { ok: false, reason: 'error' };
    });
  }
  function saveCanvas(canvas, fileName) {
    function viaUrl(url) {
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) { saveCanvasDataUrl(canvas, fileName); return; }
        var url = URL.createObjectURL(blob);
        viaUrl(url);
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      }, 'image/png');
    } else {
      saveCanvasDataUrl(canvas, fileName);
    }
  }
  function saveCanvasDataUrl(canvas, fileName) {
    try { viaUrlData(canvas.toDataURL('image/png'), fileName); } catch (e) {}
    function viaUrlData(url, name) {
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  /* ---------- Botón dentro del modal del Wrapped ---------- */

  function syncImgButton() {
    try {
      var btn = $('wrappedImgBtn');
      if (!btn) return;
      var copyBtn = $('wrappedCopyBtn');
      var body = $('wrappedBody');
      var hidden = false;
      if (copyBtn && copyBtn.style.display === 'none') hidden = true;
      if (body && body.querySelector('.wrapped-empty')) hidden = true;
      btn.style.display = hidden ? 'none' : '';
    } catch (e) {}
  }

  function ensureImgButton() {
    try {
      var copyBtn = $('wrappedCopyBtn');
      if (!copyBtn || !copyBtn.parentNode) return false;
      if ($('wrappedImgBtn')) { syncImgButton(); return true; }
      var btn = document.createElement('button');
      btn.className = 'btn small';
      btn.id = 'wrappedImgBtn';
      btn.type = 'button';
      btn.textContent = '🖼️ Descargar como imagen';
      btn.title = 'Genera un PNG 1080x1350 con tu año en música, solo en este dispositivo';
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var old = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Generando…';
        downloadWrappedImage().then(function () {
          btn.disabled = false;
          btn.textContent = old;
        });
      });
      copyBtn.parentNode.insertBefore(btn, copyBtn.nextSibling);
      syncImgButton();
      return true;
    } catch (e) { return false; }
  }

  function init() {
    try {
      ensureImgButton();
      /* El modal lo construye wrapped.js al abrirse: observar el DOM
         para insertar el botón en cuanto aparezca #wrappedCopyBtn, y
         re-sincronizar su visibilidad cuando cambie #wrappedBody
         (año distinto, estado vacío). */
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () { ensureImgButton(); }).observe(document.body, {
          childList: true, subtree: true
        });
      }
      /* Por si el modal ya estaba abierto al cargar este script. */
      document.addEventListener('click', function (ev) {
        try {
          if (ev.target && ev.target.id === 'btnWrapped') {
            setTimeout(ensureImgButton, 60);
          }
        } catch (e) {}
      }, true);
    } catch (e) { /* fail-safe: sin botón de imagen, el Wrapped sigue igual */ }
  }

  var browserApi = {
    download: downloadWrappedImage,
    getWrappedForImage: getWrappedForImage,
    ensureButton: ensureImgButton,
    version: VERSION
  };
  try { g.__rpmWrappedImg = browserApi; } catch (e) {}
  api.download = downloadWrappedImage;
  api.getWrappedForImage = getWrappedForImage;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
