/* wrapped-video.js — «Wrapped como video» (reproductor-de-musica v4.3.0, módulo aparte).
 *
 * Qué hace: añade un botón «🎬 Descargar como video» dentro del modal
 * del Wrapped (junto a «🖼️ Descargar como imagen» / «📋 Copiar
 * resumen») que genera un video corto (WebM, ~12 s, 720x1280 vertical)
 * 100% en local con canvas + MediaRecorder y lo descarga como
 * `año-en-musica-AAAA.webm`. Nada se sube a ningún servidor: el video
 * solo sale del dispositivo si el usuario lo comparte donde quiera.
 *
 * Escenas (ver buildVideoPlan): portada/título, top canciones, top
 * artistas, minutos y racha. Cada escena entra con fundido y las
 * filas del top aparecen una a una.
 *
 * De dónde salen los datos (leído en app/wrapped.js y
 * app/wrapped-img.js antes de diseñar): la vía principal es
 * RECALCULAR con `window.__wrappedHelpers.computeWrapped(datos,
 * {year})`, con los datos leídos igual que wrapped.js (primero
 * `__rpmApp.idbMetaGet('packState')` + `getTracks()`; si no está, la
 * misma IndexedDB en solo lectura: base 'reproductor-musica-local'
 * v3, almacenes meta/packState y tracks) y el año del selector
 * #wrappedYear. Fallback: si __wrappedHelpers no está, se parsea el
 * DOM del modal con `__wrappedImgHelpers.parseWrappedBody` (el
 * parser que ya trae wrapped-img.js); si tampoco está, no hay datos.
 * Mismos tops, mismos minutos, misma racha que el modal.
 *
 * Sin datos de Wrapped (sin escuchas en el año): el botón avisa con
 * toast y NO genera un video vacío. Si el navegador no soporta
 * MediaRecorder con WebM (o canvas.captureStream), lo dice claro con
 * toast y ofrece el PNG («🖼️ Descargar como imagen») como
 * alternativa; no se descarga nada roto.
 *
 * Fail-safe (patrón wrapped.js / wrapped-img.js): IIFE, try/catch en
 * el arranque y en la grabación. Si el módulo falla o no carga, el
 * modal del Wrapped sigue funcionando como en 4.2.0 (solo falta el
 * botón de video). No escribe en IndexedDB ni toca el historial. */
(function (g) {
  'use strict';

  var VERSION = '4.3.0';
  var WIDTH = 720;
  var HEIGHT = 1280;
  var FPS = 30;
  var TOP_N = 5;
  var DEFAULT_ACCENT = '#E94E1B'; // --accent por defecto de la app
  var UNKNOWN_ARTIST = 'Artista desconocido';
  var UNKNOWN_TITLE = 'Sin título';
  var DB_NAME = 'reproductor-musica-local';
  var FONT_TITLE = '"Fraunces", Georgia, serif';
  var FONT_BODY = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
  /* Duración de cada escena en ms. Total con las 4 escenas: 12 s.
     Si una escena no tiene contenido (p. ej. sin top artistas) se
     omite y el total baja, pero nunca pasa de 15 s ni baja de 10 s
     cuando hay datos completos. */
  var SCENE_MS = { cover: 2500, songs: 4000, artists: 3000, stats: 2500 };
  var MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

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

  function sanitizeYear(y) {
    var n = parseInt(y, 10);
    if (isFinite(n) && n >= 1900 && n <= 2100) return n;
    return new Date().getFullYear();
  }

  /* Igual que formatMinutes() de wrapped-img.js: «45 min»,
     «1 h 00 min», «2 h 05 min». */
  function formatMinutes(sec) {
    var m = Math.round(num(sec) / 60);
    if (m < 60) return String(m) + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }

  function buildFileName(year) {
    return 'año-en-musica-' + sanitizeYear(year) + '.webm';
  }

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

  /* ---------- Color: degradado del tema (igual que wrapped-img.js) ---------- */

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

  /* ---------- Modelo normalizado (igual que wrapped-img.js) ---------- */

  function hasEnoughData(w) {
    if (!w || w.hasData !== true) return false;
    if (!(num(w.totalSec) > 0) && !(num(w.minutes) > 0)) return false;
    var songs = Array.isArray(w.topSongs) ? w.topSongs : [];
    var artists = Array.isArray(w.topArtists) ? w.topArtists : [];
    return songs.length > 0 || artists.length > 0;
  }

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

  /* ================= Plan de escenas (puro, testeable) =================
   * buildVideoPlan(wrapped, opts) -> plan o null si no hay datos.
   * El plan es todo lo que necesita el dibujo y la grabación: escenas
   * con inicio/fin en ms, filas ya formateadas y nombre de archivo.
   * opts.durationMs (opcional): duración total deseada; se reparte
   * entre las escenas en proporción a SCENE_MS. Sin opts, 12 s con
   * las 4 escenas. */

  function buildVideoPlan(w, opts) {
    var m = normalizeWrapped(w);
    if (!m) return null;
    opts = opts || {};
    var scenes = [];
    scenes.push({
      id: 'cover', kind: 'cover', title: 'Portada',
      durationMs: SCENE_MS.cover,
      kicker: 'TU AÑO EN MÚSICA',
      heading: 'Mi año en música',
      year: m.year,
      minutesText: m.minutesText,
      minutesLabel: 'minutos escuchados' + (m.estimated ? ' (estimados)' : '')
    });
    if (m.topSongs.length) {
      scenes.push({
        id: 'songs', kind: 'songs', title: 'Top canciones',
        durationMs: SCENE_MS.songs,
        heading: 'TOP CANCIONES',
        rows: m.topSongs.map(function (r, i) {
          return {
            rank: i + 1,
            title: truncateText(r.label, 34),
            artist: truncateText(r.sub, 30),
            meta: r.min + ' min' + (r.count > 0 ? ' · ' + r.count + (r.count === 1 ? ' vez' : ' veces') : ''),
            sec: r.sec
          };
        })
      });
    }
    if (m.topArtists.length) {
      scenes.push({
        id: 'artists', kind: 'artists', title: 'Top artistas',
        durationMs: SCENE_MS.artists,
        heading: 'TOP ARTISTAS',
        rows: m.topArtists.map(function (r, i) {
          return {
            rank: i + 1,
            title: truncateText(r.label, 34),
            artist: '',
            meta: r.min + ' min',
            sec: r.sec
          };
        })
      });
    }
    scenes.push({
      id: 'stats', kind: 'stats', title: 'Minutos y racha',
      durationMs: SCENE_MS.stats,
      heading: 'TU AÑO EN NÚMEROS',
      minutesText: m.minutesText,
      minutesLabel: 'minutos escuchados' + (m.estimated ? ' (estimados)' : ''),
      stats: [
        { value: String(m.plays), label: m.plays === 1 ? 'reproducción' : 'reproducciones' },
        { value: String(m.songs), label: m.songs === 1 ? 'canción distinta' : 'canciones distintas' },
        { value: String(m.artistsN), label: m.artistsN === 1 ? 'artista distinto' : 'artistas distintos' }
      ],
      streakText: (typeof m.streak === 'number' && m.streak > 0)
        ? '🔥 Racha: ' + m.streak + (m.streak === 1 ? ' día' : ' días') + ' seguidos'
        : null
    });
    /* Reparto de una duración total pedida (p. ej. 15000 ms): se
       escala cada escena en proporción, sin tocar el orden. */
    var baseTotal = 0;
    scenes.forEach(function (s) { baseTotal += s.durationMs; });
    var totalMs = num(opts.durationMs, 0);
    if (totalMs > 0 && totalMs !== baseTotal) {
      scenes.forEach(function (s) {
        s.durationMs = Math.max(500, Math.round(s.durationMs * totalMs / baseTotal));
      });
    }
    var t = 0;
    scenes.forEach(function (s) {
      s.startMs = t;
      s.endMs = t + s.durationMs;
      t = s.endMs;
    });
    return {
      year: m.year,
      fileName: buildFileName(m.year),
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      durationMs: t,
      totalSec: m.totalSec,
      minutesText: m.minutesText,
      estimated: m.estimated,
      streak: m.streak,
      scenes: scenes
    };
  }

  /* Escena activa en el instante tMs: {scene, index, progress 0..1
     (crudo, sin easing), localMs}. Antes del inicio devuelve la
     primera con progress 0; pasado el final, la última con 1. */
  function sceneAt(plan, tMs) {
    if (!plan || !Array.isArray(plan.scenes) || !plan.scenes.length) return null;
    var t = clamp(num(tMs, 0), 0, plan.durationMs);
    for (var i = 0; i < plan.scenes.length; i++) {
      var s = plan.scenes[i];
      if (t < s.endMs || i === plan.scenes.length - 1) {
        return {
          scene: s,
          index: i,
          progress: s.durationMs > 0 ? clamp((t - s.startMs) / s.durationMs, 0, 1) : 1,
          localMs: t - s.startMs
        };
      }
    }
    return null;
  }

  function easeOutCubic(t) {
    var x = clamp(t, 0, 1);
    return 1 - Math.pow(1 - x, 3);
  }

  /* Alfa de fundido de una escena: entra en el primer 12 %, sale en
     el último 12 % (la última escena se funde a negro al final). */
  function fadeAlpha(progress) {
    var p = clamp(progress, 0, 1);
    if (p < 0.12) return p / 0.12;
    if (p > 0.88) return (1 - p) / 0.12;
    return 1;
  }

  /* Filas visibles de un top en un instante de la escena: aparecen
     una a una durante el primer 70 % (la primera ya está al entrar).
     progress 0 -> 1 fila; progress >= 0.7 -> todas. */
  function visibleRowCount(progress, rowCount) {
    var n = Math.max(0, rowCount | 0);
    if (!n) return 0;
    var p = clamp(progress, 0, 1);
    var count = 0;
    for (var i = 0; i < n; i++) {
      if (p >= (i * 0.7) / n) count++;
    }
    return count;
  }

  /* ================= Soporte de video (puro, con env inyectado) =================
   * checkVideoSupport(env): env = { MediaRecorder, captureStream }.
   * En Node los tests pasan dobles; en el navegador se pasa el env
   * real. Devuelve {supported, mimeType, reason}. reason es null si
   * supported, o 'no-mediarecorder' | 'no-capture-stream' |
   * 'no-webm'. */
  function checkVideoSupport(env) {
    env = env || {};
    var MR = env.MediaRecorder;
    if (!MR || typeof MR !== 'function') {
      return { supported: false, mimeType: null, reason: 'no-mediarecorder' };
    }
    if (env.captureStream === false) {
      return { supported: false, mimeType: null, reason: 'no-capture-stream' };
    }
    var isTypeSupported = typeof MR.isTypeSupported === 'function'
      ? MR.isTypeSupported
      : function () { return false; };
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try {
        if (isTypeSupported(MIME_CANDIDATES[i])) {
          return { supported: true, mimeType: MIME_CANDIDATES[i], reason: null };
        }
      } catch (e) { /* probar el siguiente candidato */ }
    }
    return { supported: false, mimeType: null, reason: 'no-webm' };
  }

  function supportMessage(reason) {
    if (reason === 'no-mediarecorder') {
      return 'Este navegador no puede grabar video (sin MediaRecorder). Puedes descargar el PNG con «🖼️ Descargar como imagen».';
    }
    if (reason === 'no-capture-stream') {
      return 'Este navegador no puede grabar el video desde el canvas. Puedes descargar el PNG con «🖼️ Descargar como imagen».';
    }
    return 'Este navegador no puede grabar video WebM. Puedes descargar el PNG con «🖼️ Descargar como imagen».';
  }

  /* ================= Dibujo de un fotograma (canvas 2d) =================
   * drawVideoFrame(ctx, plan, tMs, opts): dibuja la escena activa en
   * ese instante (fondo con degradado del tema, fundido de entrada /
   * salida y subida suave). opts.accent: color del tema. Devuelve
   * {sceneId, index, progress, visibleRows, width, height} o null
   * si no hay plan / ctx. Funciona con un stub de ctx en Node. */
  function drawVideoFrame(ctx, plan, tMs, opts) {
    if (!ctx || !plan || !Array.isArray(plan.scenes) || !plan.scenes.length) return null;
    opts = opts || {};
    var at = sceneAt(plan, tMs);
    if (!at) return null;
    var scene = at.scene;
    var progress = at.progress;
    var eased = easeOutCubic(progress);
    var alpha = fadeAlpha(progress);
    var slide = Math.round((1 - eased) * 28); // sube 28 px al entrar
    var grad = themeGradient(opts.accent || DEFAULT_ACCENT);
    var W = WIDTH, H = HEIGHT;
    var x0 = 56, x1 = W - 56;

    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, grad.top);
    bg.addColorStop(0.55, grad.mid);
    bg.addColorStop(1, grad.bottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    try { ctx.globalAlpha = 0.07; } catch (e) {}
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(W - 40, 110, 200, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(30, H - 220, 170, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.save();
    try { ctx.globalAlpha = alpha; } catch (e) {}
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    function setLS(px) {
      try { ctx.letterSpacing = px + 'px'; } catch (e) {}
    }

    var visibleRows = 0;
    if (scene.kind === 'cover') {
      var y = 500 + slide;
      setLS(5);
      ctx.fillStyle = grad.muted;
      ctx.font = '700 22px ' + FONT_BODY;
      ctx.fillText(scene.kicker, x0, y);
      setLS(0);
      y += 78;
      ctx.fillStyle = grad.text;
      ctx.font = '700 52px ' + FONT_TITLE;
      ctx.fillText(scene.heading, x0, y);
      y += 108;
      ctx.font = '700 110px ' + FONT_TITLE;
      ctx.fillText(String(scene.year), x0, y);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillRect(x0, y + 36, 100, 5);
      y += 118;
      ctx.fillStyle = grad.text;
      ctx.font = '800 44px ' + FONT_BODY;
      ctx.fillText(scene.minutesText, x0, y);
      y += 44;
      ctx.fillStyle = grad.muted;
      ctx.font = '600 24px ' + FONT_BODY;
      ctx.fillText(scene.minutesLabel, x0, y);
    } else if (scene.kind === 'songs' || scene.kind === 'artists') {
      var rows = scene.rows || [];
      visibleRows = visibleRowCount(progress, rows.length);
      var y2 = 150 + slide;
      setLS(4);
      ctx.fillStyle = grad.muted;
      ctx.font = '800 24px ' + FONT_BODY;
      ctx.fillText(scene.heading, x0, y2);
      setLS(0);
      ctx.fillStyle = grad.text;
      ctx.font = '700 30px ' + FONT_TITLE;
      ctx.fillText('Mi año en música · ' + plan.year, x0, y2 + 52);
      var maxSec = 1;
      rows.forEach(function (r) { if (r.sec > maxSec) maxSec = r.sec; });
      var titleMaxW = x1 - x0 - 58 - 150;
      var top = y2 + 110;
      var rowH = scene.kind === 'songs' ? 108 : 84;
      for (var i = 0; i < visibleRows; i++) {
        var r = rows[i];
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.arc(x0 + 22, top + 20, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = grad.text;
        ctx.font = '800 24px ' + FONT_BODY;
        ctx.textAlign = 'center';
        ctx.fillText(String(r.rank), x0 + 22, top + 28);
        ctx.textAlign = 'left';
        var tx = x0 + 58;
        var shown = r.title + (r.artist ? ' — ' + r.artist : '');
        ctx.fillStyle = grad.text;
        ctx.font = '700 27px ' + FONT_BODY;
        ctx.fillText(truncateToWidth(ctx, shown, titleMaxW), tx, top + 29);
        ctx.fillStyle = grad.muted;
        ctx.font = '700 23px ' + FONT_BODY;
        ctx.textAlign = 'right';
        ctx.fillText(r.meta, x1, top + 28);
        ctx.textAlign = 'left';
        if (scene.kind === 'songs') {
          var barY = top + 44;
          var barW = x1 - tx;
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(tx, barY, barW, 6);
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fillRect(tx, barY, Math.max(8, Math.round(barW * (r.sec / maxSec))), 6);
        }
        top += rowH;
      }
    } else if (scene.kind === 'stats') {
      var y3 = 420 + slide;
      setLS(4);
      ctx.fillStyle = grad.muted;
      ctx.font = '800 24px ' + FONT_BODY;
      ctx.fillText(scene.heading, x0, y3);
      setLS(0);
      y3 += 96;
      ctx.fillStyle = grad.text;
      ctx.font = '800 76px ' + FONT_BODY;
      ctx.fillText(scene.minutesText, x0, y3);
      y3 += 48;
      ctx.fillStyle = grad.muted;
      ctx.font = '600 26px ' + FONT_BODY;
      ctx.fillText(scene.minutesLabel, x0, y3);
      y3 += 96;
      var colW = (x1 - x0) / 3;
      (scene.stats || []).forEach(function (st, i) {
        var cx = x0 + i * colW;
        ctx.fillStyle = grad.text;
        ctx.font = '800 40px ' + FONT_BODY;
        ctx.fillText(st.value, cx, y3);
        ctx.fillStyle = grad.muted;
        ctx.font = '600 22px ' + FONT_BODY;
        ctx.fillText(st.label, cx, y3 + 34);
      });
      if (scene.streakText) {
        y3 += 110;
        ctx.fillStyle = grad.text;
        ctx.font = '700 30px ' + FONT_BODY;
        ctx.fillText(scene.streakText, x0, y3);
      }
    }

    /* Paginación de escenas (abajo) y pie. */
    ctx.fillStyle = grad.faint;
    ctx.font = '600 20px ' + FONT_BODY;
    ctx.textAlign = 'left';
    var dots = '';
    plan.scenes.forEach(function (s, i) { dots += (i === at.index ? '● ' : '○ '); });
    ctx.fillText(dots.trim(), x0, H - 44);
    ctx.textAlign = 'right';
    ctx.fillText('Reproductor de Música', x1, H - 44);
    ctx.textAlign = 'left';
    ctx.restore();

    return {
      sceneId: scene.id,
      index: at.index,
      progress: progress,
      visibleRows: visibleRows,
      width: W,
      height: H
    };
  }

  var api = {
    VERSION: VERSION,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    FPS: FPS,
    TOP_N: TOP_N,
    SCENE_MS: SCENE_MS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    sanitizeYear: sanitizeYear,
    formatMinutes: formatMinutes,
    buildFileName: buildFileName,
    truncateText: truncateText,
    truncateToWidth: truncateToWidth,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    mixHex: mixHex,
    parseCssColor: parseCssColor,
    themeGradient: themeGradient,
    hasEnoughData: hasEnoughData,
    normalizeWrapped: normalizeWrapped,
    buildVideoPlan: buildVideoPlan,
    sceneAt: sceneAt,
    easeOutCubic: easeOutCubic,
    fadeAlpha: fadeAlpha,
    visibleRowCount: visibleRowCount,
    checkVideoSupport: checkVideoSupport,
    supportMessage: supportMessage,
    drawVideoFrame: drawVideoFrame
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__wrappedVideoHelpers = api; } catch (e) {}

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

  /* Lectura de datos como la hacen wrapped.js / wrapped-img.js:
     primero por __rpmApp y, si no está, la misma IndexedDB en solo
     lectura. */
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

  /* Datos para el video: vía 1 (recalcular con __wrappedHelpers) o
     vía 2 (parsear el DOM del modal con __wrappedImgHelpers, si
     wrapped-img.js está cargado). Devuelve {plan, source} o
     {plan:null, source, reason}. */
  function getWrappedForVideo() {
    var helpers = g.__wrappedHelpers;
    var year = selectedYear();
    if (helpers && typeof helpers.computeWrapped === 'function') {
      return readWrappedData().then(function (data) {
        if (!data) return fallbackFromDom('no-data');
        var w;
        try { w = helpers.computeWrapped(data, { year: year }); } catch (e) { return fallbackFromDom('compute-error'); }
        var plan = buildVideoPlan(w);
        if (plan) return { plan: plan, source: 'helpers' };
        return fallbackFromDom('no-data');
      }).catch(function () { return fallbackFromDom('read-error'); });
    }
    return Promise.resolve(fallbackFromDom('no-helpers'));
  }
  function fallbackFromDom(reason) {
    try {
      var imgHelpers = g.__wrappedImgHelpers;
      var body = $('wrappedBody');
      if (!imgHelpers || typeof imgHelpers.parseWrappedBody !== 'function' || !body) {
        return { plan: null, source: 'dom', reason: reason };
      }
      var parsed = imgHelpers.parseWrappedBody(body);
      var plan = buildVideoPlan(parsed);
      if (plan) return { plan: plan, source: 'dom' };
      return { plan: null, source: 'dom', reason: 'no-data' };
    } catch (e) {
      return { plan: null, source: 'dom', reason: 'dom-error' };
    }
  }

  function detectVideoSupport() {
    var captureOk = false;
    try {
      var c = document.createElement('canvas');
      captureOk = typeof c.captureStream === 'function';
    } catch (e) { captureOk = false; }
    return checkVideoSupport({
      MediaRecorder: (typeof MediaRecorder !== 'undefined') ? MediaRecorder : undefined,
      captureStream: captureOk
    });
  }

  /* Graba el video y dispara la descarga. Devuelve una promesa con
     {ok, fileName, source, durationMs} o {ok:false, reason}. */
  function recordWrappedVideo(onProgress) {
    return getWrappedForVideo().then(function (res) {
      if (!res || !res.plan) {
        toast('Todavía no hay escucha registrada en este periodo: escucha algunas canciones y vuelve aquí.');
        return { ok: false, reason: (res && res.reason) || 'no-data' };
      }
      var plan = res.plan;
      var support = detectVideoSupport();
      if (!support.supported) {
        toast(supportMessage(support.reason));
        return { ok: false, reason: support.reason };
      }
      var canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        toast('Este navegador no puede generar el video. Puedes descargar el PNG con «🖼️ Descargar como imagen».');
        return { ok: false, reason: 'no-canvas' };
      }
      var stream;
      try {
        stream = canvas.captureStream(FPS);
      } catch (e) {
        toast(supportMessage('no-capture-stream'));
        return { ok: false, reason: 'no-capture-stream' };
      }
      var recorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType: support.mimeType,
          videoBitsPerSecond: 5000000
        });
      } catch (e) {
        toast(supportMessage('no-webm'));
        return { ok: false, reason: 'no-webm' };
      }
      var chunks = [];
      recorder.ondataavailable = function (ev) {
        if (ev && ev.data && ev.data.size) chunks.push(ev.data);
      };
      var stopped = new Promise(function (resolve, reject) {
        recorder.onstop = resolve;
        recorder.onerror = function () { reject(new Error('mediarecorder-error')); };
      });
      function startRecording() {
        var accent = readThemeAccent();
        var startTs = null;
        var rafId = 0;
        var lastSec = -1;
        function frame(ts) {
          if (startTs === null) startTs = ts;
          var elapsed = ts - startTs;
          try { drawVideoFrame(ctx, plan, elapsed, { accent: accent }); } catch (e) {}
          var sec = Math.floor(elapsed / 1000);
          if (sec !== lastSec) {
            lastSec = sec;
            if (typeof onProgress === 'function') {
              try { onProgress(elapsed, plan.durationMs); } catch (e) {}
            }
          }
          if (elapsed < plan.durationMs) {
            rafId = requestAnimationFrame(frame);
          } else {
            try { cancelAnimationFrame(rafId); } catch (e) {}
            try { recorder.stop(); } catch (e) {}
          }
        }
        try { recorder.start(250); } catch (e) { return Promise.reject(new Error('recorder-start')); }
        rafId = requestAnimationFrame(frame);
        return stopped.then(function () {
          var blob = new Blob(chunks, { type: 'video/webm' });
          if (!blob || !blob.size) throw new Error('empty-video');
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = plan.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
          toast('Video guardado: ' + plan.fileName);
          return { ok: true, fileName: plan.fileName, source: res.source, durationMs: plan.durationMs };
        });
      }
      try {
        if (document.fonts && document.fonts.ready) {
          return Promise.race([
            document.fonts.ready.then(function () { return startRecording(); }),
            new Promise(function (res2) {
              setTimeout(function () { res2(startRecording()); }, 600);
            })
          ]);
        }
      } catch (e) {}
      return startRecording();
    }).catch(function (err) {
      if (err && err.message === 'empty-video') {
        toast('El video salió vacío. Prueba de nuevo o descarga el PNG.');
        return { ok: false, reason: 'empty-video' };
      }
      toast('No se pudo generar el video. Inténtalo de nuevo o descarga el PNG.');
      return { ok: false, reason: 'error' };
    });
  }

  /* ---------- Botón dentro del modal del Wrapped ---------- */

  function syncVideoButton() {
    try {
      var btn = $('wrappedVideoBtn');
      if (!btn) return;
      var copyBtn = $('wrappedCopyBtn');
      var body = $('wrappedBody');
      var hidden = false;
      if (copyBtn && copyBtn.style.display === 'none') hidden = true;
      if (body && body.querySelector('.wrapped-empty')) hidden = true;
      btn.style.display = hidden ? 'none' : '';
    } catch (e) {}
  }

  function ensureVideoButton() {
    try {
      /* Junto al botón de imagen si existe; si no, junto al de copiar. */
      var anchor = $('wrappedImgBtn') || $('wrappedCopyBtn');
      if (!anchor || !anchor.parentNode) return false;
      if ($('wrappedVideoBtn')) { syncVideoButton(); return true; }
      var btn = document.createElement('button');
      btn.className = 'btn small';
      btn.id = 'wrappedVideoBtn';
      btn.type = 'button';
      btn.textContent = '🎬 Descargar como video';
      btn.title = 'Genera un video WebM de unos 12 s con tu año en música, solo en este dispositivo';
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var old = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Grabando…';
        recordWrappedVideo(function (elapsed, total) {
          try {
            btn.textContent = '⏺ Grabando… ' + Math.floor(elapsed / 1000) + ' s / ' + Math.ceil(total / 1000) + ' s';
          } catch (e) {}
        }).then(function () {
          btn.disabled = false;
          btn.textContent = old;
        });
      });
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      syncVideoButton();
      return true;
    } catch (e) { return false; }
  }

  function init() {
    try {
      ensureVideoButton();
      /* El modal lo construye wrapped.js al abrirse: observar el DOM
         para insertar el botón en cuanto aparezca #wrappedCopyBtn /
         #wrappedImgBtn, y re-sincronizar su visibilidad cuando
         cambie #wrappedBody (año distinto, estado vacío). */
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () { ensureVideoButton(); }).observe(document.body, {
          childList: true, subtree: true
        });
      }
      document.addEventListener('click', function (ev) {
        try {
          if (ev.target && ev.target.id === 'btnWrapped') {
            setTimeout(ensureVideoButton, 60);
          }
        } catch (e) {}
      }, true);
    } catch (e) { /* fail-safe: sin botón de video, el Wrapped sigue igual */ }
  }

  var browserApi = {
    record: recordWrappedVideo,
    getWrappedForVideo: getWrappedForVideo,
    checkSupport: detectVideoSupport,
    ensureButton: ensureVideoButton,
    version: VERSION
  };
  try { g.__rpmWrappedVideo = browserApi; } catch (e) {}
  api.record = recordWrappedVideo;
  api.getWrappedForVideo = getWrappedForVideo;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
