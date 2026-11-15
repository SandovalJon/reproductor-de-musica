/* Estadísticas por artista (v4.1.0), módulo aparte.
   Se muestra como sección dentro de la vista «Tu año en música»
   (wrapped.js): el módulo observa el cuerpo del modal Wrapped
   (#wrappedBody) y añade su sección tras los tops, respetando el
   año elegido en el selector #wrappedYear. Si wrapped.js no cargó,
   el módulo no rompe nada: expone su propia vista (botón
   «📊 Estadísticas por artista» junto a «Sincronizar» y modal
   propio con su selector de año).

   Fuentes de datos (verificadas en app/index.html y app/wrapped.js,
   NO inventadas): IndexedDB 'reproductor-musica-local' v3, almacén
   META, clave 'packState' (ver saveState/loadState):
     history:  [{id, at}]  más reciente primero, máx. 100
     counts:   {trackId: nº de reproducciones}
     statsLog: [{id, at, sec, title, artist, album}] segundos
               REALMENTE escuchados por reproducción, máx. 1500
   - tracks (vía __rpmApp.getTracks()): {id, name, title, artist,
     album, duration (seg), rating, stars}
   Solo lee: no escribe en IndexedDB ni toca playHistory,
   playCounts o statsLog.

   Límites honestos que el cálculo respeta:
   - statsLog solo guarda las últimas 1500 reproducciones medidas:
     «el año» es en realidad «el periodo con datos guardados en
     este dispositivo». Sin statsLog se cae a playCounts (nº de
     reproducciones y minutos ESTIMADOS con duration de cada pista).
   - La racha por artista solo se puede calcular con fechas
     (statsLog.at): un artista que solo vive en playCounts no tiene
     fechas, así que su racha es null y se muestra «no disponible»,
     no un 0 inventado.
   - Los artistas se agrupan sin distinguir mayúsculas/minúsculas
     ni espacios sobrantes («Artista X» y «artista x» son uno solo);
     se muestra la primera forma vista. Wrapped agrupa por cadena
     exacta, así que en casos raros de mismo artista con distinta
     capitalización los tops pueden diferir en 1 entrada. */
(function (g) {
  'use strict';

  var UNKNOWN_ARTIST = 'Artista desconocido';
  var UNKNOWN_TITLE = 'Sin título';
  var TOP_N = 10;

  /* ---------- Ayudas puras (probadas con Node) ---------- */

  function num(v, dflt) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : (dflt || 0);
  }
  function str(v, dflt) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : (dflt || '');
  }
  function artistKey(name) {
    return str(name, UNKNOWN_ARTIST).toLowerCase().replace(/\s+/g, ' ');
  }
  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* «2 h 05 min», «45 min», «0 min». Siempre horas/minutos, nunca
     segundos sueltos: es tiempo total escuchado, no duración. */
  function formatTime(sec) {
    var m = Math.round(num(sec) / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }

  /* Racha actual de días seguidos con escucha (mismo criterio que
     wrapped.js / listeningStats() en index.html: si hoy aún no hay
     escucha se empieza a contar desde ayer). Devuelve null cuando no
     hay ninguna fecha: no se puede calcular, se omite, no se
     inventa un 0. */
  function computeStreak(dayStarts, now) {
    if (!dayStarts || !dayStarts.length) return null;
    var set = {};
    /* Se normaliza cada fecha a inicio de día: admite tanto
       timestamps tal cual (at) como días ya normalizados. */
    dayStarts.forEach(function (d) { set[dayStart(d)] = 1; });
    var d = dayStart(now);
    if (!set[d]) d -= 86400000;
    var streak = 0;
    while (set[d]) { streak++; d -= 86400000; }
    return streak;
  }

  function byRank(a, b) {
    if (b.totalSec !== a.totalSec) return b.totalSec - a.totalSec;
    if (b.plays !== a.plays) return b.plays - a.plays;
    return (a.artist < b.artist) ? -1 : (a.artist > b.artist ? 1 : 0);
  }

  function yearsWithData(statsLog, history) {
    var years = {};
    (statsLog || []).forEach(function (e) {
      if (e && isFinite(Number(e.at))) years[new Date(Number(e.at)).getFullYear()] = 1;
    });
    (history || []).forEach(function (h) {
      if (h && isFinite(Number(h.at))) years[new Date(Number(h.at)).getFullYear()] = 1;
    });
    return years;
  }
  function availableYears(statsLog, history, now) {
    var years = yearsWithData(statsLog, history);
    years[new Date(now).getFullYear()] = 1;
    return Object.keys(years).map(function (y) { return parseInt(y, 10); })
      .sort(function (a, b) { return b - a; });
  }
  function pickYear(statsLog, history, now, wanted) {
    if (isFinite(Number(wanted))) return parseInt(wanted, 10);
    var curYear = new Date(now).getFullYear();
    var curHasData = (statsLog || []).some(function (e) {
      return e && isFinite(Number(e.at)) && new Date(Number(e.at)).getFullYear() === curYear;
    }) || (history || []).some(function (h) {
      return h && isFinite(Number(h.at)) && new Date(Number(h.at)).getFullYear() === curYear;
    });
    if (curHasData) return curYear;
    var dataYears = Object.keys(yearsWithData(statsLog, history))
      .map(function (y) { return parseInt(y, 10); }).sort(function (a, b) { return b - a; });
    return dataYears.length ? dataYears[0] : curYear;
  }

  /* Núcleo: estadísticas por artista de un año.
     data = { statsLog, history, counts, tracks }; opts = { year, now, topN }.
     Nunca lanza con datos raros: entradas sin at/sec/id se ignoran
     y los campos que faltan se sustituyen por «Sin título» /
     «Artista desconocido». Devuelve por artista:
       { artist, songs, plays, totalSec, minutes, timeText, streak }
     streak es null cuando ese artista no tiene ninguna fecha
     (solo vive en playCounts): «no disponible», no 0. */
  function computeArtistStats(data, opts) {
    data = data || {};
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var statsLog = Array.isArray(data.statsLog) ? data.statsLog : [];
    var history = Array.isArray(data.history) ? data.history : [];
    var counts = (data.counts && typeof data.counts === 'object') ? data.counts : {};
    var tracks = Array.isArray(data.tracks) ? data.tracks : [];
    var byId = {};
    tracks.forEach(function (t) { if (t && t.id) byId[t.id] = t; });

    var year = pickYear(statsLog, history, now, opts.year);
    var inYear = function (ts) {
      return isFinite(Number(ts)) && new Date(Number(ts)).getFullYear() === year;
    };
    var entries = statsLog.filter(function (e) { return e && inYear(e.at); });

    var map = {}; // artistKey -> acumulador
    function accFor(artistLabel) {
      var k = artistKey(artistLabel);
      if (!map[k]) {
        map[k] = { artist: str(artistLabel, UNKNOWN_ARTIST), songsSet: {}, plays: 0, totalSec: 0, days: [] };
      }
      return map[k];
    }

    var estimated = false;
    if (entries.length) {
      entries.forEach(function (e) {
        var a = accFor(e.artist);
        a.plays++;
        a.totalSec += num(e.sec);
        var title = str(e.title, UNKNOWN_TITLE);
        var sk = (e.id || '') ? ('id:' + e.id) : ('t:' + title + '|' + a.artist);
        a.songsSet[sk] = 1;
        if (isFinite(Number(e.at))) a.days.push(dayStart(Number(e.at)));
      });
    } else {
      /* Sin segundos medidos en el año: nº de reproducciones por
         playCounts y minutos estimados con la duración de cada pista.
         Sin fechas por artista: la racha queda no disponible. */
      estimated = true;
      Object.keys(counts).forEach(function (id) {
        var c = num(counts[id]);
        if (!c) return;
        var t = byId[id];
        var artist = t ? str(t.artist, UNKNOWN_ARTIST) : UNKNOWN_ARTIST;
        var a = accFor(artist);
        a.plays += c;
        a.totalSec += c * (t ? num(t.duration) : 0);
        a.songsSet['id:' + id] = 1;
      });
      if (!Object.keys(map).length) estimated = false; // sin reproducciones no hay nada que estimar
    }

    var artists = Object.keys(map).map(function (k) {
      var a = map[k];
      return {
        artist: a.artist,
        songs: Object.keys(a.songsSet).length,
        plays: a.plays,
        totalSec: a.totalSec,
        minutes: Math.round(a.totalSec / 60),
        timeText: formatTime(a.totalSec),
        streak: computeStreak(a.days, now) // null = sin fechas: no disponible
      };
    }).sort(byRank);

    var topN = isFinite(Number(opts.topN)) && Number(opts.topN) > 0 ? Math.floor(Number(opts.topN)) : TOP_N;
    var hasData = artists.length > 0 && artists.some(function (a) { return a.plays > 0; });
    var anyData = statsLog.length > 0 ||
      Object.keys(counts).some(function (id) { return num(counts[id]) > 0; }) ||
      history.length > 0;
    return {
      year: year,
      availableYears: availableYears(statsLog, history, now),
      estimated: estimated,
      hasData: hasData,
      anyData: anyData,
      totalArtists: artists.length,
      artists: artists,
      top: artists.slice(0, topN)
    };
  }

  /* Texto plano del top para «Copiar» (modal propio). Con datos
     insuficientes devuelve el mensaje amable, no una lista vacía. */
  function formatArtistStatsText(s) {
    if (!s || !s.hasData) {
      return '📊 Estadísticas por artista' + (s && s.year ? ' · ' + s.year : '') +
        '\nTodavía no hay escucha registrada en este periodo. En cuanto ' +
        'suenen canciones, las estadísticas por artista se arman solas.';
    }
    var lines = [];
    lines.push('📊 Estadísticas por artista · ' + s.year);
    lines.push(s.totalArtists + (s.totalArtists === 1 ? ' artista' : ' artistas') +
      (s.estimated ? ' · minutos estimados por la duración de las canciones' : ''));
    lines.push('');
    s.top.forEach(function (a, i) {
      lines.push((i + 1) + '. ' + a.artist + ' · ' + a.timeText + ' · ' +
        a.plays + (a.plays === 1 ? ' reproducción' : ' reproducciones') + ' · ' +
        a.songs + (a.songs === 1 ? ' canción' : ' canciones') +
        (typeof a.streak === 'number' ? ' · racha ' + a.streak + (a.streak === 1 ? ' día' : ' días') : ' · racha no disponible'));
    });
    return lines.join('\n');
  }

  var api = {
    computeArtistStats: computeArtistStats,
    formatArtistStatsText: formatArtistStatsText,
    formatTime: formatTime,
    computeStreak: computeStreak,
    availableYears: availableYears,
    TOP_N: TOP_N
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__statsArtistaHelpers = api; } catch (e) { /* consola: window.__statsArtistaHelpers */ }

  /* ---------- Parte de navegador (no corre en Node) ---------- */
  if (typeof document === 'undefined') return;

  function $(id) { return document.getElementById(id); }
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

  /* Lee los datos como los guarda la app: primero por __rpmApp
     (idbMetaGet('packState') + getTracks) y, si la app aún no lo
     expuso, leyendo la misma IndexedDB en solo lectura (mismo
     patrón que wrapped.js). */
  function readData() {
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
    return readDataDirect();
  }
  function readDataDirect() {
    return new Promise(function (resolve) {
      try {
        if (!('indexedDB' in g)) { resolve({ statsLog: [], history: [], counts: {}, tracks: [] }); return; }
        var req = g.indexedDB.open('reproductor-musica-local', 3);
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
        req.onerror = function () { resolve({ statsLog: [], history: [], counts: {}, tracks: [] }); };
      } catch (e) {
        resolve({ statsLog: [], history: [], counts: {}, tracks: [] });
      }
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* Sección «Estadísticas por artista» (top 10). Reutiliza las
     clases .wrapped-section/.wrapped-rank de wrapped.css cuando
     está dentro del modal Wrapped; en el modal propio usa las
     mismas clases (wrapped.css ya está cargado en index.html) y
     solo añade lo propio con prefijo .sa-. */
  function buildSection(s) {
    var wrap = el('div', 'wrapped-section sa-section');
    wrap.id = 'saSection';
    wrap.setAttribute('data-year', String(s.year));
    wrap.appendChild(el('h4', null, 'Estadísticas por artista · ' + s.year));
    if (!s.hasData) {
      wrap.appendChild(el('p', 'wrapped-none',
        s.anyData
          ? 'Sin escucha registrada en ' + s.year + '. Prueba con otro año.'
          : 'Todavía no hay escucha registrada. Escucha algunas canciones y vuelve aquí: en cuanto suenen, verás tus artistas más escuchados con sus canciones, reproducciones, tiempo total y racha.'));
      return wrap;
    }
    var max = Math.max.apply(null, s.top.map(function (a) { return a.totalSec; }).concat([1]));
    var ol = el('ol', 'wrapped-rank sa-rank');
    s.top.forEach(function (a, i) {
      var li = el('li');
      li.appendChild(el('span', 'wrapped-rank-n', String(i + 1)));
      var main = el('div', 'wrapped-rank-main');
      main.appendChild(el('div', 'wrapped-rank-t', a.artist));
      var sub = el('div', 'sa-sub',
        a.songs + (a.songs === 1 ? ' canción' : ' canciones') + ' · ' +
        a.plays + (a.plays === 1 ? ' reproducción' : ' reproducciones') + ' · ' +
        (typeof a.streak === 'number'
          ? '🔥 racha ' + a.streak + (a.streak === 1 ? ' día' : ' días')
          : 'racha no disponible'));
      main.appendChild(sub);
      var bar = el('div', 'wrapped-bar');
      var fill = el('div', 'wrapped-bar-fill');
      fill.style.width = Math.max(3, Math.round((a.totalSec / max) * 100)) + '%';
      bar.appendChild(fill);
      main.appendChild(bar);
      li.appendChild(main);
      li.appendChild(el('span', 'wrapped-rank-meta', a.timeText));
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    if (s.estimated) {
      wrap.appendChild(el('p', 'wrapped-note sa-note',
        'Minutos estimados por la duración de las canciones: este periodo no tiene segundos realmente escuchados guardados. La racha no está disponible sin fechas de escucha.'));
    } else if (s.top.some(function (a) { return typeof a.streak !== 'number'; })) {
      wrap.appendChild(el('p', 'wrapped-note sa-note',
        'La racha de un artista no está disponible cuando sus escuchas no tienen fecha guardada.'));
    }
    if (s.totalArtists > s.top.length) {
      wrap.appendChild(el('p', 'sa-more',
        'Mostrando los ' + s.top.length + ' más escuchados de ' + s.totalArtists + ' artistas.'));
    }
    return wrap;
  }

  /* Firma del contenido Wrapped sin contar nuestra sección: así el
     observador no se redispara por sus propios cambios. */
  function wrappedSig(body) {
    var yearSel = $('wrappedYear');
    var year = yearSel ? yearSel.value : '';
    var card = body.querySelector('.wrapped-card') ? '1' : '0';
    var ranks = body.querySelectorAll('.wrapped-rank:not(.sa-rank) li').length;
    var empty = body.querySelector('.wrapped-empty') ? '1' : '0';
    return year + '|' + card + '|' + ranks + '|' + empty;
  }

  var lastSig = null;
  var renderPending = false;
  function injectIntoWrapped() {
    var body = $('wrappedBody');
    if (!body) return;
    var sig = wrappedSig(body);
    if (sig === lastSig) return; // ya inyectado para este contenido
    if (renderPending) return;
    renderPending = true;
    var yearSel = $('wrappedYear');
    var year = yearSel && isFinite(Number(yearSel.value)) ? parseInt(yearSel.value, 10) : undefined;
    readData().then(function (data) {
      var s = computeArtistStats(data, { year: year });
      var old = $('saSection');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      /* Solo inyectar si el modal Wrapped sigue abierto y el
         contenido no ha cambiado mientras se leían los datos. */
      var bodyNow = $('wrappedBody');
      if (!bodyNow) { renderPending = false; return; }
      if (wrappedSig(bodyNow) !== sig) { renderPending = false; injectIntoWrapped(); return; }
      bodyNow.appendChild(buildSection(s));
      lastSig = sig;
      renderPending = false;
    }).catch(function () {
      renderPending = false; // sin sección: el Wrapped sigue intacto
    });
  }

  function observeWrapped() {
    if (!('MutationObserver' in g) || !document.body) return;
    var obs = new MutationObserver(function () {
      var body = $('wrappedBody');
      if (!body) { lastSig = null; return; }
      /* wrapped.js vacía #wrappedBody al re-renderizar (cambio de
         año, reapertura): la firma cambia y se vuelve a inyectar. */
      if (wrappedSig(body) !== lastSig) injectIntoWrapped();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- Modal propio (solo si wrapped.js no cargó) ---------- */
  var ownOverlay = null;
  var currentStats = null;

  function buildOwnModal() {
    ownOverlay = el('div', 'modal-overlay wrapped-overlay');
    ownOverlay.id = 'saModal';
    ownOverlay.setAttribute('aria-hidden', 'true');
    var modal = el('div', 'modal wrapped-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'saModalTitle');
    var head = el('div', 'wrapped-head');
    var h3 = el('h3', null, 'Estadísticas por artista');
    h3.id = 'saModalTitle';
    head.appendChild(h3);
    var closeBtn = el('button', 'wrapped-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar Estadísticas por artista');
    closeBtn.addEventListener('click', closeOwn);
    head.appendChild(closeBtn);
    modal.appendChild(head);
    modal.appendChild(el('p', 'wrapped-sub',
      'Tus artistas más escuchados, calculados solo en este dispositivo con tu historial guardado. Nada se sube a ningún sitio.'));
    var controls = el('div', 'wrapped-controls');
    var sel = el('select');
    sel.id = 'saYear';
    sel.setAttribute('aria-label', 'Año de las estadísticas por artista');
    sel.addEventListener('change', function () { renderOwn(parseInt(sel.value, 10)); });
    controls.appendChild(sel);
    modal.appendChild(controls);
    var body = el('div');
    body.id = 'saBody';
    modal.appendChild(body);
    var actions = el('div', 'modal-actions');
    actions.style.flexWrap = 'wrap';
    var copyBtn = el('button', 'btn small primary', '📋 Copiar top de artistas');
    copyBtn.id = 'saCopyBtn';
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () {
      if (currentStats) copyText(formatArtistStatsText(currentStats), copyBtn);
    });
    var closeBtn2 = el('button', 'btn small', 'Cerrar');
    closeBtn2.type = 'button';
    closeBtn2.addEventListener('click', closeOwn);
    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn2);
    modal.appendChild(actions);
    ownOverlay.appendChild(modal);
    ownOverlay.addEventListener('click', function (ev) { if (ev.target === ownOverlay) closeOwn(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && ownOverlay && ownOverlay.classList.contains('on')) closeOwn();
    });
    document.body.appendChild(ownOverlay);
    return ownOverlay;
  }

  function copyText(text, btn) {
    function done() {
      toast('Top de artistas copiado al portapapeles');
      if (btn) {
        var old = btn.textContent;
        btn.textContent = '¡Copiado! ✓';
        btn.disabled = true;
        setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 2200);
      }
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done();
        else toast('No se pudo copiar: selecciona el texto y cópialo a mano.');
      } catch (e) { toast('No se pudo copiar: selecciona el texto y cópialo a mano.'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }

  function renderOwn(year) {
    var body = $('saBody');
    var sel = $('saYear');
    var copyBtn = $('saCopyBtn');
    if (!body) return;
    body.innerHTML = '';
    readData().then(function (data) {
      var s = computeArtistStats(data, { year: year });
      currentStats = s;
      if (sel) {
        var sig = s.availableYears.join(',');
        if (sel.getAttribute('data-sig') !== sig) {
          sel.setAttribute('data-sig', sig);
          sel.innerHTML = '';
          s.availableYears.forEach(function (y) {
            var o = document.createElement('option');
            o.value = String(y); o.textContent = String(y);
            sel.appendChild(o);
          });
        }
        sel.value = String(s.year);
      }
      if (copyBtn) copyBtn.style.display = s.hasData ? '' : 'none';
      body.appendChild(buildSection(s));
    }).catch(function () {
      body.innerHTML = '';
      var err = el('div', 'wrapped-empty');
      err.appendChild(el('p', null, 'No se pudo leer tu historial ahora mismo.'));
      err.appendChild(el('p', 'wrapped-empty-sub', 'Cierra y vuelve a intentarlo; tu biblioteca y tu historial no se han tocado.'));
      body.appendChild(err);
    });
  }

  function openOwn() {
    if (!ownOverlay) buildOwnModal();
    ownOverlay.classList.add('on');
    ownOverlay.setAttribute('aria-hidden', 'false');
    renderOwn();
    var sel = $('saYear');
    if (sel) sel.focus();
  }
  function closeOwn() {
    if (!ownOverlay) return;
    ownOverlay.classList.remove('on');
    ownOverlay.setAttribute('aria-hidden', 'true');
  }

  /* Si wrapped.js no está (ni su botón), el módulo sigue útil por
     sí solo: botón propio junto a «Sincronizar». No se crea si el
     Wrapped existe, para no duplicar la entrada. */
  function wireFallbackButton() {
    if (g.__rpmWrapped || $('btnWrapped')) return;
    if ($('btnStatsArtista')) return;
    var syncBtn = $('btnSync');
    if (!syncBtn || !syncBtn.parentNode) return;
    var btn = document.createElement('button');
    btn.className = 'btn small';
    btn.id = 'btnStatsArtista';
    btn.type = 'button';
    btn.textContent = '📊 Estadísticas por artista';
    syncBtn.parentNode.insertBefore(btn, syncBtn.nextSibling);
    btn.addEventListener('click', openOwn);
  }

  function init() {
    try {
      observeWrapped();
      injectIntoWrapped();
      /* wrapped.js se carga antes o después según el orden de los
         <script>: esperar un poco antes de decidir que no está y
         crear el botón propio. */
      setTimeout(wireFallbackButton, 3000);
    } catch (e) { /* fail-safe: módulo desactivado, app intacta */ }
  }

  g.__rpmStatsArtista = {
    open: openOwn, close: closeOwn,
    computeArtistStats: computeArtistStats,
    formatArtistStatsText: formatArtistStatsText,
    injectIntoWrapped: injectIntoWrapped
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
