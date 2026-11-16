/* Exportar catálogo a CSV para Reproductor de Música — v4.4.0.
   Módulo aparte: no toca index.html (salvo el botón #btnCatalogoCsv
   que añade WIRING.md) ni la lógica de reproducción.
   Qué hace: descarga toda la biblioteca como biblioteca-AAAA-MM-DD.csv
   (Título, Artista, Álbum, Género, Año, Duración, Reproducciones,
   Estrellas, Like), para abrirla en Excel/Sheets o guardarla como
   inventario. Solo lee: getTracks() + counts de packState.
   El CSV usa coma, comillas RFC 4180 y BOM UTF-8 para que Excel lo
   abra bien en español. Sin canciones, avisa y no descarga nada.
   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./catalogo-csv.css">
     <script src="./catalogo-csv.js"></script>
   Pruebas Node: node --test catalogo-csv.test.mjs */
(function (g) {
  'use strict';

  var COLUMNS = ['Título', 'Artista', 'Álbum', 'Género', 'Año', 'Duración', 'Reproducciones', 'Estrellas', 'Like'];

  /* ---------- Núcleo puro (probable en Node) ---------- */

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }

  /* Escapa un campo según RFC 4180: comillas si lleva coma, comilla,
     salto de línea o retorno; las comillas se duplican. */
  function csvEscape(v) {
    var s = str(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function fmtDuration(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n <= 0) return '';
    n = Math.floor(n);
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function likeText(t) {
    if (t && t.rating === 'like') return 'sí';
    if (t && t.rating === 'dislike') return 'no';
    return '';
  }

  function byArtistTitle(a, b) {
    var ka = (str(a.artist) + ' ' + str(a.title)).toLowerCase();
    var kb = (str(b.artist) + ' ' + str(b.title)).toLowerCase();
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  }

  /* tracks: [{id,title,artist,album,genre,year,duration,stars,rating}].
     counts: {trackId: nº de reproducciones}. Devuelve el CSV completo
     (con BOM) ordenado por artista y título. */
  function tracksToCSV(tracks, counts) {
    var list = (Array.isArray(tracks) ? tracks.slice() : []).sort(byArtistTitle);
    var c = counts || {};
    var lines = [COLUMNS.join(',')];
    list.forEach(function (t) {
      lines.push([
        csvEscape(t.title), csvEscape(t.artist), csvEscape(t.album),
        csvEscape(t.genre), csvEscape(t.year == null ? '' : t.year),
        csvEscape(fmtDuration(t.duration)),
        csvEscape(c[t.id] ? c[t.id] : 0),
        csvEscape(t.stars ? t.stars : ''),
        csvEscape(likeText(t))
      ].join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function csvFileName(d) {
    var dt = (d instanceof Date) ? d : new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return 'biblioteca-' + dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + '.csv';
  }

  /* ---------- Solo navegador ---------- */

  function toast(msg) {
    try {
      var app = g.__rpmApp;
      if (app && typeof app.toast === 'function') { app.toast(msg); return; }
      if (typeof alert === 'function') alert(msg);
    } catch (e) { /* nunca romper la app */ }
  }

  function download(csv, name) {
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 500);
  }

  function exportNow() {
    try {
      var app = g.__rpmApp;
      if (!app || typeof app.getTracks !== 'function') { toast('El catálogo no se pudo leer. Recarga la app.'); return; }
      var tracks = app.getTracks() || [];
      if (!tracks.length) { toast('Tu biblioteca está vacía: no hay nada que exportar.'); return; }
      var done = function (counts) {
        try {
          var csv = tracksToCSV(tracks, counts || {});
          download(csv, csvFileName(new Date()));
          toast('Catálogo exportado: ' + tracks.length + ' canciones en CSV.');
        } catch (e) { toast('No se pudo exportar el catálogo.'); }
      };
      if (typeof app.idbMetaGet === 'function') {
        app.idbMetaGet('packState').then(function (st) { done(st && st.counts); }, function () { done({}); });
      } else done({});
    } catch (e) { toast('No se pudo exportar el catálogo.'); }
  }

  function buildUI() {
    try {
      var btn = document.getElementById('btnCatalogoCsv');
      if (!btn) return; /* sin el botón de WIRING.md, el módulo no hace nada */
      btn.addEventListener('click', exportNow);
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) {}
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tracksToCSV: tracksToCSV, csvEscape: csvEscape, fmtDuration: fmtDuration, csvFileName: csvFileName, COLUMNS: COLUMNS };
  }
  if (typeof window !== 'undefined') {
    window.__catalogoCsv = { tracksToCSV: tracksToCSV, exportNow: exportNow };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
