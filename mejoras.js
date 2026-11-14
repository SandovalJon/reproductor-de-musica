/* Mejoras de la auditoría del sitio en vivo (v2.8.0) — módulo aparte.
   No toca la lógica de index.html: se engancha por DOM y por el hook
   window.__mejorasUpdate(n) que render() llama en index.html.
   Puntos: 1) estado vacío guiado, 2) acciones imposibles en vacío,
   3) un solo camino para añadir música, 4) orden simplificado,
   5) una sola "Actualizar app" y textos sin truncar, 6) móvil. */
(function () {
  'use strict';
  var EMPTY_MSG = 'Añade una canción primero';
  var ADVANCED_VIEWS = ['smart', 'moods', 'stats', 'summary', 'dup', 'incomplete'];
  var ADVANCED_SORT = ['bpmAsc', 'bpmDesc', 'energy', 'key'];
  var ADVANCED_LABEL = { bpmAsc: 'BPM (menor a mayor)', bpmDesc: 'BPM (mayor a menor)', energy: 'Energía (mayor a menor)', key: 'Tonalidad (orden Camelot)' };

  function $(id) { return document.getElementById(id); }
  function count() {
    var el = $('statCount');
    return el ? parseInt(el.textContent, 10) || 0 : 0;
  }
  function isEmpty() { return count() === 0; }

  /* --- 2) Deshabilitar acciones imposibles en vacío --- */
  var ACTION_IDS = [
    'btnPlay', 'btnShuffle', 'btnPrev', 'btnNext', 'btnRepeat', 'btnMixNow',
    'btnSmartShuffle', 'btnRadioCurrent', 'btnRecordMix', 'btnParty', 'btnCar',
    'btnFocus', 'btnLike', 'btnDislike', 'btnResumePlay',
    'btnDiscoverPlay', 'btnDiscoverShuffle', 'btnCalmPlay', 'btnCalmShuffle',
    'btnIntensePlay', 'btnIntenseShuffle', 'btnForgottenPlay', 'btnForgottenShuffle',
    'btnSmartPlay', 'btnSmartShuffle', 'btnPlPlay', 'btnPlShuffle',
    'btnArtistPlay', 'btnArtistShuffle', 'btnAlbumPlay', 'btnAlbumShuffle',
    'btnGenrePlay', 'btnGenreShuffle', 'btnYearPlay', 'btnYearShuffle',
    'btnFolderPlay', 'btnFolderShuffle', 'miniPlay', 'miniPrev', 'miniNext'
  ];
  // Botones cuyo disabled lo gestiona la propia app (renderNow): solo
  // se les añade clase/título en vacío, nunca se toca su disabled.
  var APP_MANAGED = ['btnPlay', 'btnLike', 'btnDislike', 'btnResumePlay'];
  function setDisabled(el, off) {
    if (!el) return;
    if (off) {
      el.classList.add('mejoras-off');
      el.setAttribute('aria-disabled', 'true');
      if (APP_MANAGED.indexOf(el.id) === -1 && 'disabled' in el) el.disabled = true;
      if (!el.getAttribute('data-mejoras-title')) el.setAttribute('data-mejoras-title', el.getAttribute('title') || '');
      el.setAttribute('title', EMPTY_MSG);
    } else {
      el.classList.remove('mejoras-off');
      el.removeAttribute('aria-disabled');
      if (APP_MANAGED.indexOf(el.id) === -1 && 'disabled' in el) el.disabled = false;
      var t = el.getAttribute('data-mejoras-title');
      if (t !== null) { if (t) el.setAttribute('title', t); else el.removeAttribute('title'); }
    }
  }
  function updateActions() {
    var empty = isEmpty();
    ACTION_IDS.forEach(function (id) { setDisabled($(id), empty); });
    // Botones Reproducir/Aleatoria generados en las vistas (sin id fijo).
    document.querySelectorAll('.mood-actions .btn, .subview-actions .btn').forEach(function (b) {
      if (/Reproducir|Aleatoria/i.test(b.textContent || '')) setDisabled(b, empty);
    });
    // Estrellas: ya vienen disabled sin canción; dejar el título claro.
    document.querySelectorAll('#nowStars .star-btn').forEach(function (b) {
      if (empty) b.setAttribute('title', EMPTY_MSG);
    });
    document.body.classList.toggle('empty-lib', empty);
  }

  /* --- 4) Orden simplificado: avanzado a su propio desplegable --- */
  function buildAdvancedSort() {
    var sort = $('sort'); if (!sort || $('sortAdvanced')) return;
    var wrap = sort.parentNode; if (!wrap || !wrap.parentNode) return;
    var adv = document.createElement('details');
    adv.className = 'mejoras-adv-sort';
    adv.innerHTML = '<summary>Orden avanzado</summary>';
    var sel = document.createElement('select');
    sel.id = 'sortAdvanced'; sel.className = 'sort-select'; sel.setAttribute('aria-label', 'Orden avanzado');
    var opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = 'Sin orden avanzado';
    sel.appendChild(opt0);
    ADVANCED_SORT.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = ADVANCED_LABEL[v];
      sel.appendChild(o);
    });
    adv.appendChild(sel);
    wrap.parentNode.insertBefore(adv, wrap.nextSibling);
    // Quitar las opciones avanzadas del selector principal (quedan en el otro).
    Array.prototype.slice.call(sort.options).forEach(function (o) {
      if (ADVANCED_SORT.indexOf(o.value) !== -1) sort.removeChild(o);
    });
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      // Restaurar temporalmente la opción para que el orden de la app la lea.
      var o = document.createElement('option'); o.value = sel.value; o.textContent = ADVANCED_LABEL[sel.value];
      sort.appendChild(o); sort.value = sel.value;
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      sort.removeChild(o);
    });
    sort.addEventListener('change', function () { if (ADVANCED_SORT.indexOf(sort.value) === -1) sel.value = ''; });
  }

  /* --- 5) Una sola "Actualizar app": quitar el botón duplicado de Biblioteca --- */
  function dedupeUpdate() {
    var dup = $('btnCheckUpdate');
    if (dup) dup.remove(); // El botón del encabezado (#btnUpdate) sigue siendo la única acción.
  }

  /* --- 3) Consejo de la carpeta junto a añadir música (respaldo si no está en el HTML) --- */
  function ensureFolderTip() {
    if (document.querySelector('.folder-tip')) return;
    var dz = $('dropzone'); if (!dz || !dz.parentNode) return;
    var p = document.createElement('p');
    p.className = 'folder-tip';
    p.textContent = 'Consejo: en el celular, añade la carpeta completa de música una vez y quedará guardada para la próxima vez que abras esta página en el mismo navegador.';
    dz.parentNode.insertBefore(p, dz.nextSibling);
  }

  /* --- 6) Móvil: menú de secciones colapsable + mini barra fija --- */
  function buildMobile() {
    var tabs = $('viewTabs'); if (!tabs || $('mejorasMenuBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'mejorasMenuBtn'; btn.type = 'button';
    btn.textContent = '☰ Secciones'; btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () {
      var open = tabs.classList.toggle('mejoras-expanded');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '✕ Cerrar secciones' : '☰ Secciones';
    });
    document.body.appendChild(btn);
    tabs.addEventListener('click', function (e) {
      if (e.target.closest('.view-tab') && window.innerWidth < 1024) {
        tabs.classList.remove('mejoras-expanded');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '☰ Secciones';
      }
    });

    // Mini barra fija inferior en móvil, con los controles que ya existen.
    var bar = document.createElement('div');
    bar.id = 'mejorasMiniBar';
    bar.innerHTML = '<span id="mejorasMiniTitle">Sin canción</span>' +
      '<button type="button" id="mejorasMiniPrev" aria-label="Anterior">⏮</button>' +
      '<button type="button" id="mejorasMiniPlay" aria-label="Reproducir o pausar">▶</button>' +
      '<button type="button" id="mejorasMiniNext" aria-label="Siguiente">⏭</button>';
    document.body.appendChild(bar);
    function click(id) { var b = $(id); if (b) b.click(); }
    var bPlay = bar.querySelector('#mejorasMiniPlay');
    var bPrev = bar.querySelector('#mejorasMiniPrev');
    var bNext = bar.querySelector('#mejorasMiniNext');
    if (bPlay) bPlay.addEventListener('click', function () { click('btnPlay'); });
    if (bPrev) bPrev.addEventListener('click', function () { click('btnPrev'); });
    if (bNext) bNext.addEventListener('click', function () { click('btnNext'); });
    bar.addEventListener('click', function (e) {
      if (e.target === bar) { var p = document.querySelector('.player-card'); if (p) p.scrollIntoView({ behavior: 'smooth' }); }
    });
  }
  function updateMiniBar() {
    var t = $('mejorasMiniTitle'); if (!t) return;
    var now = $('nowTitle') ? $('nowTitle').textContent : '';
    t.textContent = now || 'Sin canción';
    var audio = $('audio');
    var bPlay = $('mejorasMiniPlay');
    if (bPlay) bPlay.textContent = (audio && !audio.paused) ? '⏸' : '▶';
  }

  function update() {
    updateActions();
    updateMiniBar();
  }

  function init() {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = './mejoras.css';
    document.head.appendChild(css);
    buildAdvancedSort();
    dedupeUpdate();
    ensureFolderTip();
    buildMobile();
    update();
    // render() llama a window.__mejorasUpdate; además, vigilar cambios de conteo.
    setInterval(update, 1000);
    var audio = $('audio');
    if (audio) { audio.addEventListener('play', updateMiniBar); audio.addEventListener('pause', updateMiniBar); }
  }

  window.__mejorasUpdate = function () { update(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
