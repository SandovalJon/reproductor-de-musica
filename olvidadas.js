/* Favoritas olvidadas para Reproductor de Música — v4.4.0.
   Módulo aparte: no toca index.html (salvo el botón #btnOlvidadas
   que añade WIRING.md) ni la lógica de reproducción.
   Qué hace: lista tus canciones favoritas (like o 2-3 estrellas) que
   llevan 90 días o más sin sonar, o que nunca han sonado. Cada fila
   dice cuánto hace que sonó («nunca sonó», «hace 132 días») y tiene
   su ▶ para ponerla. «🔀 Mezclar olvidadas» las baraja, pone la
   primera y encola las demás con queueNext (sin tocar tu cola actual
   más que añadiendo detrás).
   De dónde sale la última escucha: lo más reciente entre history y
   statsLog (los dos los guarda la app). Si una favorita tiene
   reproducciones pero ninguna fecha guardada, sale aparte como «sin
   fecha registrada»: no se inventa que esté olvidada, solo se avisa.
   Las de dislike nunca salen (ni con estrellas). Solo lee.
   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./olvidadas.css">
     <script src="./olvidadas.js"></script>
   Pruebas Node: node --test olvidadas.test.mjs */
(function (g) {
  'use strict';

  var DAYS_DEFAULT = 90;
  var MS_DAY = 86400000;

  /* ---------- Núcleo puro (probable en Node) ---------- */

  function isPlayable(t) { return !!(t && t.id && t.rating !== 'dislike'); }
  function isFavorite(t) { return t.rating === 'like' || (Number(t.stars) || 0) >= 2; }

  /* Última escucha por id: lo más reciente entre history y statsLog. */
  function lastPlayedById(history, statsLog) {
    var out = {};
    (Array.isArray(history) ? history : []).forEach(function (e) {
      if (e && e.id && Number(e.at) > 0) out[e.id] = Math.max(out[e.id] || 0, Number(e.at));
    });
    (Array.isArray(statsLog) ? statsLog : []).forEach(function (e) {
      if (e && e.id && Number(e.at) > 0) out[e.id] = Math.max(out[e.id] || 0, Number(e.at));
    });
    return out;
  }

  function daysAgo(last, nowMs) {
    return Math.max(0, Math.floor((Number(nowMs) - Number(last)) / MS_DAY));
  }

  /* Devuelve {never:[], forgotten:[], nodate:[], total} con las pistas
     (las mismas de tracks) ordenadas: nunca sonadas por título,
     olvidadas por más tiempo sin sonar, sin fecha por título. */
  function findForgotten(tracks, counts, history, statsLog, nowMs, days) {
    var threshold = (typeof days === 'number' && days > 0) ? days : DAYS_DEFAULT;
    var cutoff = Number(nowMs) - threshold * MS_DAY;
    var last = lastPlayedById(history, statsLog);
    var c = counts || {};
    var never = [], forgotten = [], nodate = [];
    (Array.isArray(tracks) ? tracks : []).forEach(function (t) {
      if (!isPlayable(t) || !isFavorite(t)) return;
      var lp = last[t.id] || 0;
      var n = Number(c[t.id]) || 0;
      if (!lp && n <= 0) { never.push(t); return; }
      if (!lp) { nodate.push(t); return; }
      if (lp < cutoff) forgotten.push({ track: t, last: lp, days: daysAgo(lp, nowMs) });
    });
    function byTitle(a, b) {
      var ka = String((a.track || a).title || '').toLowerCase();
      var kb = String((b.track || b).title || '').toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }
    never.sort(byTitle);
    nodate.sort(byTitle);
    forgotten.sort(function (a, b) { return a.last - b.last; });
    return { never: never, forgotten: forgotten, nodate: nodate, total: never.length + forgotten.length + nodate.length };
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /* ---------- Solo navegador ---------- */

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function toast(msg) {
    try {
      var app = g.__rpmApp;
      if (app && typeof app.toast === 'function') { app.toast(msg); return; }
    } catch (e) {}
  }

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

  function readData() {
    var app = g.__rpmApp;
    if (!app || typeof app.idbMetaGet !== 'function' || typeof app.getTracks !== 'function') {
      return Promise.resolve(null);
    }
    return Promise.all([app.idbMetaGet('packState'), app.getTracks()]).then(function (res) {
      var st = res[0] || {};
      return { statsLog: st.statsLog || [], history: st.history || [], counts: st.counts || {}, tracks: res[1] || [] };
    });
  }

  function closeModal() {
    try {
      var m = document.querySelector('.olv-overlay');
      if (m) m.remove();
    } catch (e) {}
  }

  function openModal() {
    closeModal();
    var overlay = el('div', 'modal-overlay olv-overlay');
    var modal = el('div', 'modal olv-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Favoritas olvidadas');
    modal.appendChild(el('h3', null, '💛 Favoritas olvidadas'));
    var status = el('p', 'olv-status', 'Buscando tus favoritas sin sonar…');
    status.setAttribute('role', 'status');
    modal.appendChild(status);
    var list = el('ul', 'olv-list');
    modal.appendChild(list);
    var actions = el('div', 'modal-actions');
    var shuffleBtn = el('button', 'btn small primary', '🔀 Mezclar olvidadas');
    shuffleBtn.type = 'button'; shuffleBtn.style.display = 'none';
    var closeBtn = el('button', 'btn small', 'Cerrar');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeModal);
    actions.appendChild(shuffleBtn); actions.appendChild(closeBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    document.body.appendChild(overlay);

    var current = [];
    function rowFor(t, label) {
      var li = el('li', 'olv-row');
      var play = el('button', 'btn small olv-play', '▶');
      play.type = 'button';
      play.setAttribute('aria-label', 'Reproducir ' + (t.title || 'Sin título'));
      play.addEventListener('click', function () { playTrackById(t.id); });
      li.appendChild(play);
      var main = el('div', 'olv-main');
      main.appendChild(el('div', 'olv-t', t.title || 'Sin título'));
      main.appendChild(el('div', 'olv-s', (t.artist || 'Artista desconocido') + ' · ' + label));
      li.appendChild(main);
      return li;
    }

    readData().then(function (data) {
      try {
        if (!data) { status.textContent = 'No se pudieron leer tus datos. Recarga la app.'; return; }
        var r = findForgotten(data.tracks, data.counts, data.history, data.statsLog, Date.now(), DAYS_DEFAULT);
        current = r.never.concat(r.forgotten.map(function (f) { return f.track; }), r.nodate);
        if (!r.total) {
          status.textContent = 'Nada olvidado: todas tus favoritas han sonado en los últimos ' + DAYS_DEFAULT + ' días. 🎉';
          return;
        }
        status.textContent = r.total + (r.total === 1 ? ' favorita' : ' favoritas') + ' sin sonar desde hace ' + DAYS_DEFAULT + ' días o más.';
        r.never.forEach(function (t) { list.appendChild(rowFor(t, 'nunca sonó')); });
        r.forgotten.forEach(function (f) {
          list.appendChild(rowFor(f.track, 'hace ' + f.days + (f.days === 1 ? ' día' : ' días')));
        });
        r.nodate.forEach(function (t) { list.appendChild(rowFor(t, 'sin fecha registrada')); });
        shuffleBtn.style.display = '';
        shuffleBtn.addEventListener('click', function () {
          var order = shuffle(current);
          if (!order.length) return;
          var app = g.__rpmApp;
          playTrackById(order[0].id);
          if (app && typeof app.queueNext === 'function') {
            for (var i = order.length - 1; i >= 1; i--) app.queueNext(order[i].id);
          }
          closeModal();
          toast('Mezclando ' + order.length + ' favoritas olvidadas.');
        });
      } catch (e) { status.textContent = 'No se pudo armar la lista.'; }
    });
  }

  function buildUI() {
    try {
      var btn = $('btnOlvidadas');
      if (!btn) return; /* sin el botón de WIRING.md, el módulo no hace nada */
      btn.addEventListener('click', openModal);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closeModal();
      });
    } catch (e) {}
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
      else buildUI();
    } catch (e) {}
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { findForgotten: findForgotten, lastPlayedById: lastPlayedById, daysAgo: daysAgo, shuffle: shuffle, DAYS_DEFAULT: DAYS_DEFAULT };
  }
  if (typeof window !== 'undefined') {
    window.__olvidadasFind = findForgotten;
    window.__olvidadasOpen = openModal;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
