/* Wrapped — «Tu año en música» (v3.3.0), módulo aparte.
   No toca la lógica de index.html: se engancha por DOM y por el hook
   window.__rpmApp que la app ya expone (idbMetaGet, getTracks, toast).
   Si el módulo falla o no carga, la app sigue funcionando como en
   3.2.0: el botón «Tu año en música» solo avisa y nada más cambia.

   Fuentes de datos (verificadas en app/index.html, NO inventadas):
   - IndexedDB 'reproductor-musica-local' v3, almacén META, clave
     'packState' (ver saveState/loadState):
       history:  [{id, at}]  más reciente primero, máx. 100
       counts:   {trackId: nº de reproducciones}
       statsLog: [{id, at, sec, title, artist, album}] segundos
                 REALMENTE escuchados por reproducción, máx. 1500
   - tracks (vía __rpmApp.getTracks()): {id, name, title, artist,
     album, duration (seg), rating ('like'/'dislike'/null), stars 0-3}
   - La app ya tiene «Tu resumen» (viewSummary, por mes o año, con
     PNG): Wrapped no lo duplica. Wrapped es solo el año (o el año con
     datos), añade la racha de días seguidos y el botón «Copiar resumen»
     como texto plano.

   Límites honestos que el cálculo respeta:
   - statsLog solo guarda las últimas 1500 reproducciones medidas y
     playHistory solo las últimas 100: «el año» es en realidad «el
     periodo con datos guardados en este dispositivo».
   - statsLog existe desde que se añadió el registro de segundos; las
     reproducciones anteriores solo viven en playCounts, sin fecha:
     si statsLog está vacío se cae a playCounts (tops por nº de veces,
     minutos ESTIMADOS con duration de cada pista) y la racha se omite
     cuando no hay ninguna fecha (statsLog.at ni history.at).
   - Todo es local: nada se sube ni se comparte solo; el texto copiado
     solo sale del dispositivo si el usuario lo pega donde quiera. */
(function (g) {
  'use strict';

  var UNKNOWN_ARTIST = 'Artista desconocido';
  var UNKNOWN_TITLE = 'Sin título';
  var TOP_N = 5;

  /* ---------- Ayudas puras (probadas con Node) ---------- */

  function num(v, dflt) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : (dflt || 0);
  }
  function str(v, dflt) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : (dflt || '');
  }
  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function byRank(a, b) {
    if (b.sec !== a.sec) return b.sec - a.sec;
    if (b.count !== a.count) return b.count - a.count;
    return (a.label < b.label) ? -1 : (a.label > b.label ? 1 : 0);
  }
  function topN(map) {
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(byRank).slice(0, TOP_N);
  }

  /* Años con algún dato fechado (statsLog.at o history.at), más el
     año actual. Orden descendente. */
  function availableYears(statsLog, history, now) {
    var years = yearsWithData(statsLog, history);
    years[new Date(now).getFullYear()] = 1;
    return Object.keys(years).map(function (y) { return parseInt(y, 10); })
      .sort(function (a, b) { return b - a; });
  }
  /* Solo los años que tienen datos (sin añadir el actual): para
     elegir el año por defecto cuando el actual está vacío. */
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

  /* Racha actual de días seguidos con escucha, con el mismo criterio
     que listeningStats() en index.html: si hoy aún no hay escucha se
     empieza a contar desde ayer. Devuelve null cuando no hay ninguna
     fecha (no se puede calcular: se omite, no se inventa un 0). */
  function computeStreak(dayStarts, now) {
    if (!dayStarts || !dayStarts.length) return null;
    var set = {};
    dayStarts.forEach(function (d) { set[d] = 1; });
    var d = dayStart(now);
    if (!set[d]) d -= 86400000;
    var streak = 0;
    while (set[d]) { streak++; d -= 86400000; }
    return streak;
  }

  function fmtMinutes(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return String(m);
    var h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }

  /* Núcleo: calcula el Wrapped de un año a partir de los datos tal
     como los guarda la app. data = { statsLog, history, counts,
     tracks }; opts = { year, now }. Nunca lanza con datos raros:
     entradas sin at/sec/id se ignoran y los campos que faltan se
     sustituyen por «Sin título» / «Artista desconocido». */
  function computeWrapped(data, opts) {
    data = data || {};
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var statsLog = Array.isArray(data.statsLog) ? data.statsLog : [];
    var history = Array.isArray(data.history) ? data.history : [];
    var counts = (data.counts && typeof data.counts === 'object') ? data.counts : {};
    var tracks = Array.isArray(data.tracks) ? data.tracks : [];
    var byId = {};
    tracks.forEach(function (t) { if (t && t.id) byId[t.id] = t; });

    var years = availableYears(statsLog, history, now);
    var year = opts.year;
    if (!isFinite(Number(year))) {
      var curYear = new Date(now).getFullYear();
      var curHasData = statsLog.some(function (e) {
        return e && isFinite(Number(e.at)) && new Date(Number(e.at)).getFullYear() === curYear;
      }) || history.some(function (h) {
        return h && isFinite(Number(h.at)) && new Date(Number(h.at)).getFullYear() === curYear;
      });
      if (curHasData) year = curYear;
      else {
        var dataYears = Object.keys(yearsWithData(statsLog, history))
          .map(function (y) { return parseInt(y, 10); }).sort(function (a, b) { return b - a; });
        year = dataYears.length ? dataYears[0] : curYear;
      }
    }
    year = parseInt(year, 10);

    var inYear = function (ts) {
      return isFinite(Number(ts)) && new Date(Number(ts)).getFullYear() === year;
    };
    var entries = statsLog.filter(function (e) { return e && inYear(e.at); });
    var estimated = false;
    var totalSec = 0, plays = 0;
    var songMap = {}, artMap = {}, distinct = {}, artists = {};

    if (entries.length) {
      entries.forEach(function (e) {
        var sec = num(e.sec);
        totalSec += sec;
        plays++;
        var title = str(e.title, UNKNOWN_TITLE);
        var artist = str(e.artist, UNKNOWN_ARTIST);
        var sk = (e.id || '') ? ('id:' + e.id) : ('t:' + title + '|' + artist);
        if (!songMap[sk]) songMap[sk] = { label: title, sub: artist, sec: 0, count: 0 };
        songMap[sk].sec += sec; songMap[sk].count++;
        if (!artMap[artist]) artMap[artist] = { label: artist, sub: '', sec: 0, count: 0 };
        artMap[artist].sec += sec; artMap[artist].count++;
        if (e.id) distinct[e.id] = 1; else distinct[sk] = 1;
        artists[artist] = 1;
      });
    } else {
      /* Sin segundos medidos: tops por nº de reproducciones y
         minutos estimados con la duración de cada pista. */
      estimated = true;
      Object.keys(counts).forEach(function (id) {
        var c = num(counts[id]);
        if (!c) return;
        var t = byId[id];
        var title = t ? str(t.title, UNKNOWN_TITLE) : UNKNOWN_TITLE;
        var artist = t ? str(t.artist, UNKNOWN_ARTIST) : UNKNOWN_ARTIST;
        var dur = t ? num(t.duration) : 0;
        var sec = c * dur;
        totalSec += sec;
        plays += c;
        var sk = 'id:' + id;
        songMap[sk] = { label: title, sub: artist, sec: sec, count: c };
        if (!artMap[artist]) artMap[artist] = { label: artist, sub: '', sec: 0, count: 0 };
        artMap[artist].sec += sec; artMap[artist].count += c;
        distinct[id] = 1;
        artists[artist] = 1;
      });
      if (!plays) estimated = false; // sin reproducciones no hay nada que estimar
    }

    /* Racha: días con escucha en TODO el historial fechado (no solo
       este año: una racha que cruza de diciembre a enero es una sola). */
    var dayStarts = [];
    statsLog.forEach(function (e) { if (e && isFinite(Number(e.at))) dayStarts.push(dayStart(Number(e.at))); });
    history.forEach(function (h) { if (h && isFinite(Number(h.at))) dayStarts.push(dayStart(Number(h.at))); });
    var streak = computeStreak(dayStarts, now);

    var hasData = plays > 0;
    var anyData = statsLog.length > 0 ||
      Object.keys(counts).some(function (id) { return num(counts[id]) > 0; }) ||
      history.length > 0;
    return {
      year: year,
      label: 'Tu año en música · ' + year,
      availableYears: years,
      totalSec: totalSec,
      minutes: Math.round(totalSec / 60),
      minutesText: fmtMinutes(totalSec),
      estimated: estimated,
      plays: plays,
      songs: Object.keys(distinct).length,
      artistsN: Object.keys(artists).length,
      topSongs: topN(songMap),
      topArtists: topN(artMap),
      streak: streak, // null = sin fechas: se omite en la vista
      hasData: hasData, // hay escucha en el año elegido
      anyData: anyData // hay escucha en algún año
    };
  }

  /* Resumen como texto plano para «Copiar resumen»: top 5 canciones,
     top 5 artistas y minutos. Con datos insuficientes devuelve el
     mensaje amable en vez de una lista vacía. */
  function formatWrappedText(w) {
    if (!w || !w.hasData) {
      return '🎧 Tu año en música' + (w && w.year ? ' · ' + w.year : '') +
        '\nTodavía no hay escucha registrada en este periodo. En cuanto ' +
        'suenen canciones, tu resumen se arma solo.';
    }
    var lines = [];
    lines.push('🎧 Tu año en música · ' + w.year);
    lines.push('⏱ ' + w.minutes + ' minutos escuchados' +
      (w.estimated ? ' (estimados por la duración de las canciones)' : '') +
      ' · ' + w.plays + (w.plays === 1 ? ' reproducción' : ' reproducciones') +
      ' · ' + w.songs + (w.songs === 1 ? ' canción' : ' canciones') +
      ' · ' + w.artistsN + (w.artistsN === 1 ? ' artista' : ' artistas'));
    if (typeof w.streak === 'number' && w.streak > 0) {
      lines.push('🔥 Racha: ' + w.streak + (w.streak === 1 ? ' día' : ' días') + ' seguidos escuchando música');
    }
    lines.push('');
    lines.push('Top canciones:');
    w.topSongs.forEach(function (r, i) {
      lines.push((i + 1) + '. ' + r.label + (r.sub ? ' — ' + r.sub : '') +
        ' · ' + Math.round(r.sec / 60) + ' min · ' + r.count + (r.count === 1 ? ' vez' : ' veces'));
    });
    lines.push('');
    lines.push('Top artistas:');
    w.topArtists.forEach(function (r, i) {
      lines.push((i + 1) + '. ' + r.label + ' · ' + Math.round(r.sec / 60) + ' min');
    });
    return lines.join('\n');
  }

  var api = {
    computeWrapped: computeWrapped,
    formatWrappedText: formatWrappedText,
    computeStreak: computeStreak,
    availableYears: availableYears,
    fmtMinutes: fmtMinutes
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__wrappedHelpers = api; } catch (e) { /* consola: window.__wrappedHelpers */ }

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
     expuso, leyendo la misma IndexedDB en solo lectura. */
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

  function copyText(text, btn) {
    function done() {
      toast('Resumen copiado al portapapeles');
      if (btn) {
        var old = btn.textContent;
        btn.textContent = '¡Copiado! ✓';
        btn.disabled = true;
        setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 2200);
      }
      var note = $('wrappedCopied');
      if (note) note.style.display = '';
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

  var currentWrapped = null;
  var overlay = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function buildModal() {
    overlay = el('div', 'modal-overlay wrapped-overlay');
    overlay.id = 'wrappedModal';
    overlay.setAttribute('aria-hidden', 'true');
    var modal = el('div', 'modal wrapped-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'wrappedModalTitle');
    var head = el('div', 'wrapped-head');
    var h3 = el('h3', null, 'Tu año en música');
    h3.id = 'wrappedModalTitle';
    head.appendChild(h3);
    var closeBtn = el('button', 'wrapped-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar Tu año en música');
    closeBtn.addEventListener('click', closeWrapped);
    head.appendChild(closeBtn);
    modal.appendChild(head);
    var sub = el('p', 'wrapped-sub', 'Tu año en música, calculado solo en este dispositivo con tu historial guardado. Nada se sube a ningún sitio.');
    modal.appendChild(sub);
    var controls = el('div', 'wrapped-controls');
    var lbl = el('label', 'sr-only', 'Año del Wrapped');
    lbl.setAttribute('for', 'wrappedYear');
    controls.appendChild(lbl);
    var sel = el('select');
    sel.id = 'wrappedYear';
    sel.setAttribute('aria-label', 'Año del Wrapped');
    sel.addEventListener('change', function () { renderWrapped(parseInt(sel.value, 10)); });
    controls.appendChild(sel);
    modal.appendChild(controls);
    var body = el('div');
    body.id = 'wrappedBody';
    modal.appendChild(body);
    var actions = el('div', 'modal-actions');
    actions.style.flexWrap = 'wrap';
    var copyBtn = el('button', 'btn small primary', '📋 Copiar resumen');
    copyBtn.id = 'wrappedCopyBtn';
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () {
      if (currentWrapped) copyText(formatWrappedText(currentWrapped), copyBtn);
    });
    var closeBtn2 = el('button', 'btn small', 'Cerrar');
    closeBtn2.type = 'button';
    closeBtn2.addEventListener('click', closeWrapped);
    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn2);
    modal.appendChild(actions);
    var copied = el('p', 'wrapped-copied', '✓ Resumen copiado al portapapeles. Pégalo donde quieras compartirlo.');
    copied.id = 'wrappedCopied';
    copied.style.display = 'none';
    modal.appendChild(copied);
    overlay.appendChild(modal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeWrapped(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.classList.contains('on')) closeWrapped();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function rankedList(title, rows, withCount) {
    var wrap = el('div', 'wrapped-section');
    wrap.appendChild(el('h4', null, title));
    if (!rows.length) {
      wrap.appendChild(el('p', 'wrapped-none', 'Sin datos en este periodo.'));
      return wrap;
    }
    var max = Math.max.apply(null, rows.map(function (r) { return r.sec; }).concat([1]));
    var ol = el('ol', 'wrapped-rank');
    rows.forEach(function (r, i) {
      var li = el('li');
      var rank = el('span', 'wrapped-rank-n', String(i + 1));
      li.appendChild(rank);
      var main = el('div', 'wrapped-rank-main');
      var t = el('div', 'wrapped-rank-t', r.label + (r.sub ? ' — ' + r.sub : ''));
      main.appendChild(t);
      var bar = el('div', 'wrapped-bar');
      var fill = el('div', 'wrapped-bar-fill');
      fill.style.width = Math.max(3, Math.round((r.sec / max) * 100)) + '%';
      bar.appendChild(fill);
      main.appendChild(bar);
      li.appendChild(main);
      var meta = el('span', 'wrapped-rank-meta',
        Math.round(r.sec / 60) + ' min' + (withCount ? ' · ' + r.count + (r.count === 1 ? ' vez' : ' veces') : ''));
      li.appendChild(meta);
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    return wrap;
  }

  function renderWrapped(year) {
    var body = $('wrappedBody');
    var sel = $('wrappedYear');
    var copyBtn = $('wrappedCopyBtn');
    if (!body) return;
    body.innerHTML = '';
    var copied = $('wrappedCopied');
    if (copied) copied.style.display = 'none';
    readData().then(function (data) {
      var w = computeWrapped(data, { year: year });
      currentWrapped = w;
      if (sel) {
        var sig = w.availableYears.join(',');
        if (sel.getAttribute('data-sig') !== sig) {
          sel.setAttribute('data-sig', sig);
          sel.innerHTML = '';
          w.availableYears.forEach(function (y) {
            var o = document.createElement('option');
            o.value = String(y); o.textContent = String(y);
            sel.appendChild(o);
          });
        }
        sel.value = String(w.year);
      }
      if (copyBtn) copyBtn.style.display = w.hasData ? '' : 'none';
      if (!w.anyData) {
        var empty = el('div', 'wrapped-empty');
        empty.appendChild(el('div', 'wrapped-empty-art', '🎧'));
        empty.appendChild(el('p', null, 'Todavía no hay nada que resumir.'));
        empty.appendChild(el('p', 'wrapped-empty-sub',
          'Escucha algunas canciones y vuelve aquí: en cuanto suenen, tu año en música se arma solo con tus tops, tus minutos y tu racha.'));
        body.appendChild(empty);
        return;
      }
      if (!w.hasData) {
        var emptyY = el('div', 'wrapped-empty');
        emptyY.appendChild(el('div', 'wrapped-empty-art', '📅'));
        emptyY.appendChild(el('p', null, 'Sin escucha registrada en ' + w.year + '.'));
        emptyY.appendChild(el('p', 'wrapped-empty-sub',
          'Prueba con otro año en el selector de arriba: tu historial guardado puede tener escucha en otros años.'));
        body.appendChild(emptyY);
        return;
      }
      var card = el('div', 'wrapped-card');
      card.appendChild(el('p', 'wrapped-kicker', 'Tu año en música · ' + w.year));
      var big = el('p', 'wrapped-big');
      big.appendChild(el('span', null, String(w.minutes)));
      var small = el('small', null, ' minutos escuchados' + (w.estimated ? ' (estimados)' : ''));
      big.appendChild(small);
      card.appendChild(big);
      var row = el('div', 'wrapped-row');
      [
        { v: String(w.plays), l: 'reproducciones' },
        { v: String(w.songs), l: 'canciones distintas' },
        { v: String(w.artistsN), l: 'artistas distintos' }
      ].forEach(function (s) {
        var box = el('div', 'wrapped-stat');
        box.appendChild(el('div', 'v', s.v));
        box.appendChild(el('div', 'l', s.l));
        row.appendChild(box);
      });
      card.appendChild(row);
      if (typeof w.streak === 'number' && w.streak > 0) {
        card.appendChild(el('p', 'wrapped-streak',
          '🔥 Racha: ' + w.streak + (w.streak === 1 ? ' día' : ' días') + ' seguidos escuchando música'));
      }
      if (w.estimated) {
        card.appendChild(el('p', 'wrapped-note',
          'Minutos estimados por la duración de las canciones: este periodo no tiene segundos realmente escuchados guardados.'));
      }
      body.appendChild(card);
      body.appendChild(rankedList('Canciones top', w.topSongs, true));
      body.appendChild(rankedList('Artistas top', w.topArtists, false));
    }).catch(function () {
      body.innerHTML = '';
      var err = el('div', 'wrapped-empty');
      err.appendChild(el('p', null, 'No se pudo leer tu historial ahora mismo.'));
      err.appendChild(el('p', 'wrapped-empty-sub', 'Cierra y vuelve a intentarlo; tu biblioteca y tu historial no se han tocado.'));
      body.appendChild(err);
    });
  }

  function openWrapped() {
    if (!overlay) buildModal();
    overlay.classList.add('on');
    overlay.setAttribute('aria-hidden', 'false');
    renderWrapped();
    var sel = $('wrappedYear');
    if (sel) sel.focus();
  }
  function closeWrapped() {
    if (!overlay) return;
    overlay.classList.remove('on');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function wireButton() {
    var btn = $('btnWrapped');
    if (!btn) {
      /* Si el cableado HTML no añadió el botón, se crea solo junto a
         «Sincronizar» (backup-row): la vista sigue existiendo. */
      var syncBtn = $('btnSync');
      if (syncBtn && syncBtn.parentNode) {
        btn = document.createElement('button');
        btn.className = 'btn small';
        btn.id = 'btnWrapped';
        btn.type = 'button';
        btn.textContent = '🎧 Tu año en música';
        syncBtn.parentNode.insertBefore(btn, syncBtn.nextSibling);
      } else return;
    }
    if (btn.getAttribute('data-wrapped-wired')) return;
    btn.setAttribute('data-wrapped-wired', '1');
    btn.addEventListener('click', openWrapped);
  }

  function init() {
    try {
      wireButton();
      /* __rpmApp se expone al final del script principal; el sondeo
         corto es solo por si el orden de carga cambia (mismo patrón
         que sync-bridge.js). El botón no depende de él: al abrir, los
         datos se leen por __rpmApp o directamente de IndexedDB. */
      var tries = 0;
      var tick = function () {
        wireButton();
        tries++;
        if (tries < 30 && !g.__rpmApp) setTimeout(tick, 100);
      };
      tick();
    } catch (e) { /* fail-safe: Wrapped desactivado, local intacto */ }
  }

  g.__rpmWrapped = { open: openWrapped, close: closeWrapped, computeWrapped: computeWrapped, formatWrappedText: formatWrappedText };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
