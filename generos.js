/* Géneros más escuchados en "Tu año en música" — v4.4.0.
   Módulo aparte: no toca wrapped.js ni stats-artista.js. Añade su
   sección al final de #wrappedBody (donde wrapped.js pinta el Wrapped)
   y la recalcula al cambiar de año (#wrappedYear) o reabrir el modal.
   Qué hace: top 8 géneros por minutos REALMENTE escuchados en el año
   (statsLog, segundos medidos). Si ese año no tiene escucha medida,
   cae a reproducciones × duración con el aviso visible «estimado»
   (mismo criterio honesto que stats-artista.js); sin ningún dato,
   avisa y no inventa nada. Las canciones sin género no entran en el
   top y se cuentan aparte. Solo lee: packState + getTracks().
   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./generos.css">
     <script src="./generos.js"></script>
   Pruebas Node: node --test generos.test.mjs */
(function (g) {
  'use strict';

  var SECTION_CLASS = 'gn-section';

  /* ---------- Núcleo puro (probable en Node) ---------- */

  function str(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : ''; }

  function yearOf(at) {
    var d = new Date(Number(at));
    return isNaN(d.getTime()) ? null : d.getFullYear();
  }

  function fmtTime(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
  }

  /* statsLog: [{id, at, sec}], tracks: [{id, genre, duration}],
     counts: {id: nº}. year: año a calcular. Devuelve
     {list, estimated, totalSec, noGenreSec, noGenrePlays} donde list
     es [{genre, sec, plays, timeText}] ordenado por segundos. */
  function topGenres(statsLog, tracks, counts, year) {
    var byId = {};
    (Array.isArray(tracks) ? tracks : []).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var buckets = {};
    var totalSec = 0, noGenreSec = 0, noGenrePlays = 0, estimated = false;
    var log = Array.isArray(statsLog) ? statsLog : [];
    var measured = log.filter(function (e) { return e && yearOf(e.at) === year && Number(e.sec) > 0; });
    if (measured.length) {
      measured.forEach(function (e) {
        var t = byId[e.id];
        var genre = t ? str(t.genre) : '';
        var sec = Number(e.sec) || 0;
        totalSec += sec;
        if (!genre) { noGenreSec += sec; noGenrePlays++; return; }
        var key = genre.toLowerCase();
        if (!buckets[key]) buckets[key] = { genre: genre, sec: 0, plays: 0 };
        buckets[key].sec += sec; buckets[key].plays++;
      });
    } else {
      /* Sin escucha medida ese año: estimación visible, nunca silencio. */
      estimated = true;
      var c = counts || {};
      Object.keys(c).forEach(function (id) {
        var n = Number(c[id]) || 0;
        if (n <= 0) return;
        var t = byId[id];
        if (!t) return;
        var sec = n * (Number(t.duration) || 0);
        if (sec <= 0) return;
        var genre = str(t.genre);
        totalSec += sec;
        if (!genre) { noGenreSec += sec; noGenrePlays += n; return; }
        var key = genre.toLowerCase();
        if (!buckets[key]) buckets[key] = { genre: genre, sec: 0, plays: 0 };
        buckets[key].sec += sec; buckets[key].plays += n;
      });
    }
    var list = Object.keys(buckets).map(function (k) { return buckets[k]; });
    list.sort(function (a, b) { return b.sec - a.sec || b.plays - a.plays; });
    list = list.slice(0, 8).map(function (b) {
      return { genre: b.genre, sec: Math.round(b.sec), plays: b.plays, timeText: fmtTime(b.sec) };
    });
    return { list: list, estimated: estimated, totalSec: Math.round(totalSec), noGenreSec: Math.round(noGenreSec), noGenrePlays: noGenrePlays };
  }

  /* ---------- Solo navegador ---------- */

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function readData() {
    var app = g.__rpmApp;
    if (!app || typeof app.idbMetaGet !== 'function' || typeof app.getTracks !== 'function') {
      return Promise.resolve(null);
    }
    return Promise.all([app.idbMetaGet('packState'), app.getTracks()]).then(function (res) {
      var st = res[0] || {};
      return { statsLog: st.statsLog || [], counts: st.counts || {}, tracks: res[1] || [] };
    });
  }

  function render() {
    var body = $('wrappedBody');
    if (!body) return;
    var old = body.querySelector('.' + SECTION_CLASS);
    if (old) old.remove();
    var yearSel = $('wrappedYear');
    var year = yearSel ? Number(yearSel.value) : new Date().getFullYear();
    readData().then(function (data) {
      try {
        var bodyNow = $('wrappedBody');
        if (!bodyNow || bodyNow.querySelector('.' + SECTION_CLASS)) return;
        var wrap = el('div', 'wrapped-section ' + SECTION_CLASS);
        wrap.appendChild(el('h4', null, 'Géneros más escuchados · ' + year));
        if (!data) {
          wrap.appendChild(el('p', 'wrapped-none', 'No se pudieron leer tus datos de escucha.'));
          bodyNow.appendChild(wrap); return;
        }
        var r = topGenres(data.statsLog, data.tracks, data.counts, year);
        if (!r.list.length) {
          wrap.appendChild(el('p', 'wrapped-none', 'Todavía no hay escucha registrada en ' + year + ' para dibujar tus géneros.'));
          bodyNow.appendChild(wrap); return;
        }
        if (r.estimated) {
          wrap.appendChild(el('p', 'wrapped-none', 'Estimado por reproducciones × duración: este año aún no tiene escucha medida.'));
        }
        var max = r.list[0].sec || 1;
        var ol = el('ol', 'wrapped-rank');
        r.list.forEach(function (b, i) {
          var li = el('li', 'wrapped-rank-row');
          li.appendChild(el('span', 'wrapped-rank-n', String(i + 1)));
          var main = el('div', 'wrapped-rank-main');
          main.appendChild(el('div', 'wrapped-rank-t', b.genre));
          var sub = el('div', 'wrapped-rank-s', b.plays + (b.plays === 1 ? ' reproducción' : ' reproducciones'));
          main.appendChild(sub);
          var bar = el('div', 'wrapped-bar');
          var fill = el('div', 'wrapped-bar-fill');
          fill.style.width = Math.max(2, Math.round((b.sec / max) * 100)) + '%';
          bar.appendChild(fill);
          main.appendChild(bar);
          li.appendChild(main);
          li.appendChild(el('span', 'wrapped-rank-meta', b.timeText));
          ol.appendChild(li);
        });
        wrap.appendChild(ol);
        if (r.noGenrePlays) {
          wrap.appendChild(el('p', 'wrapped-none', 'Sin género: ' + fmtTime(r.noGenreSec) + ' en ' + r.noGenrePlays + (r.noGenrePlays === 1 ? ' reproducción' : ' reproducciones') + '.'));
        }
        bodyNow.appendChild(wrap);
      } catch (e) { /* la sección nunca debe romper el Wrapped */ }
    });
  }

  function buildUI() {
    try {
      var body = $('wrappedBody');
      if (!body) return;
      /* wrapped.js vacía #wrappedBody al re-renderizar (cambio de año
         o reapertura): el observador vuelve a pintar la sección. */
      var obs = new MutationObserver(function () {
        if (!$('wrappedBody')) return;
        if (!document.querySelector('.' + SECTION_CLASS)) render();
      });
      obs.observe(body, { childList: true });
      var btn = $('btnWrapped');
      if (btn) btn.addEventListener('click', function () { setTimeout(render, 350); });
    } catch (e) {}
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) {}
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { topGenres: topGenres, fmtTime: fmtTime, yearOf: yearOf };
  }
  if (typeof window !== 'undefined') {
    window.__generosTop = topGenres;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
