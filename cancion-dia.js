/* Canción del día para Reproductor de Música — v4.4.0.
   Módulo aparte: no toca index.html (salvo el botón #btnCancionDia
   que añade WIRING.md) ni la lógica de reproducción.
   Qué hace: cada día elige UNA canción de tu biblioteca y la pone a
   sonar con el botón «🎵 Canción del día». La elección es determinista
   (misma fecha → misma canción) y prefiere tus favoritas (like o 2-3
   estrellas); si no tienes ninguna marcada, elige entre todas las que
   pueden sonar. Las de dislike nunca salen. Si la biblioteca está
   vacía, lo dice y no hace nada.
   Reproduce con el mismo truco que buscar-letra.js y tarareo.js:
   clic en la fila real de #trackList (con reintento si hay un filtro).
   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./cancion-dia.css">
     <script src="./cancion-dia.js"></script>
   Pruebas Node: node --test cancion-dia.test.mjs */
(function (g) {
  'use strict';

  /* ---------- Núcleo puro (probable en Node) ---------- */

  /* Hash djb2, estable entre cargas: misma cadena → mismo número. */
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }

  function dailyDateKey(d) {
    var dt = (d instanceof Date) ? d : new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }

  function isPlayable(t) { return !!(t && t.id && t.rating !== 'dislike'); }
  function isFavorite(t) { return t.rating === 'like' || (Number(t.stars) || 0) >= 2; }

  /* tracks: [{id,title,artist,rating,stars}]. dateKey: 'AAAA-MM-DD'.
     Devuelve la pista elegida o null si ninguna puede sonar. */
  function pickDaily(tracks, dateKey) {
    var pool = (Array.isArray(tracks) ? tracks : []).filter(isPlayable);
    if (!pool.length) return null;
    var favs = pool.filter(isFavorite);
    var use = favs.length ? favs : pool;
    var idx = hashStr(String(dateKey) + '|cancion-del-dia') % use.length;
    return use[idx];
  }

  /* ---------- Solo navegador ---------- */

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function toast(msg) {
    try {
      var app = g.__rpmApp;
      if (app && typeof app.toast === 'function') { app.toast(msg); return; }
    } catch (e) {}
  }

  /* Mismo patrón que buscar-letra.js: clic en la fila real de la
     biblioteca; si un filtro la oculta, se limpia la búsqueda, se
     vuelve a la vista Biblioteca y se reintenta a los 250 ms. */
  function playTrackById(id) {
    try {
      var row = document.querySelector('#trackList [data-track-id="' + id + '"]');
      if (row) { row.click(); return true; }
      var tab = document.querySelector('#viewTabs [data-view="library"]');
      if (tab) tab.click();
      var search = $('search');
      if (search && search.value) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      setTimeout(function () {
        try {
          var row2 = document.querySelector('#trackList [data-track-id="' + id + '"]');
          if (row2) row2.click();
        } catch (e) {}
      }, 250);
      return true;
    } catch (e) { return false; }
  }

  function playDaily() {
    try {
      var app = g.__rpmApp;
      if (!app || typeof app.getTracks !== 'function') { toast('La canción del día no se pudo leer. Recarga la app.'); return; }
      var track = pickDaily(app.getTracks() || [], dailyDateKey(new Date()));
      if (!track) { toast('No hay ninguna canción que pueda sonar (revisa los dislikes o añade música).'); return; }
      playTrackById(track.id);
      toast('Canción del día: «' + (track.title || track.name || 'Sin título') + '» — ' + (track.artist || 'Artista desconocido'));
    } catch (e) { toast('No se pudo poner la canción del día.'); }
  }

  function buildUI() {
    try {
      var btn = $('btnCancionDia');
      if (!btn) return; /* sin el botón de WIRING.md, el módulo no hace nada */
      btn.addEventListener('click', playDaily);
    } catch (e) {}
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) {}
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pickDaily: pickDaily, hashStr: hashStr, dailyDateKey: dailyDateKey, isPlayable: isPlayable, isFavorite: isFavorite };
  }
  if (typeof window !== 'undefined') {
    window.__cancionDiaPick = pickDaily;
    window.__cancionDiaPlay = playDaily;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
