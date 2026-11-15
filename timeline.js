/* Línea de tiempo de escucha (v3.6.0), módulo aparte.
   No toca la lógica de index.html: se engancha por DOM y por el hook
   window.__rpmApp que la app ya expone (idbMetaGet, getTracks, toast).
   Si el módulo falla o no carga, la app sigue funcionando como en
   3.5.0: el botón «Línea de tiempo» solo avisa y nada más cambia.

   Fuente de datos — LA MISMA que wrapped.js (verificada en
   app/index.html y app/wrapped.js, NO inventada, sin segunda fuente):
   - IndexedDB 'reproductor-musica-local' v3, almacén META ('meta'),
     clave 'packState' (guardada como {key, value} por idbMetaSet;
     idbMetaGet devuelve .value):
       statsLog: [{id, at, sec, title, artist, album}] segundos
                 REALMENTE escuchados por reproducción, máx. 1500
       history:  [{id, at}] más reciente primero, máx. 100
       counts:   {trackId: nº de reproducciones} (no se usa aquí:
                 no tiene fecha, así que no puede ir a un calendario)
   - tracks (vía __rpmApp.getTracks()): {id, name, title, artist,
     album, duration (seg), ...} — solo para resolver título/artista
     de las entradas de history, que no los llevan.
   - Lectura: primero por __rpmApp (idbMetaGet('packState') +
     getTracks) y, si la app aún no lo expuso, la misma IndexedDB en
     solo lectura (mismo patrón que wrapped.js).

   Límites honestos que el cálculo respeta:
   - statsLog solo guarda las últimas 1500 reproducciones medidas y
     history solo las últimas 100: el calendario muestra «el periodo
     con datos guardados en este dispositivo», no toda la vida.
   - Un día solo tiene minutos si hay entradas de statsLog ese día.
     Un día que solo aparece en history (sin segundos medidos) se
     marca como «con escucha» y lista sus canciones, pero sus minutos
     son «sin datos», nunca 0 inventado ni estimado con duration.
   - history y statsLog se solapan (la misma reproducción vive en
     los dos): al listar las canciones de un día, una entrada de
     history cuyo id ya está ese día en statsLog NO se duplica.
   - Todo es local: nada se sube ni se comparte. El módulo solo lee;
     no escribe en IndexedDB ni cambia history, counts o statsLog. */
(function (g) {
  'use strict';

  var UNKNOWN_ARTIST = 'Artista desconocido';
  var UNKNOWN_TITLE = 'Sin título';
  var MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var WEEKDAY_SHORT = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

  /* ---------- Ayudas puras (probadas con Node) ---------- */

  function num(v, dflt) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : (dflt || 0);
  }
  function str(v, dflt) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : (dflt || '');
  }
  /* Inicio del día en hora local, igual que dayStart() en index.html
     y en wrapped.js: los días del calendario son días locales. */
  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }
  /* Suma (o resta) meses a un año/mes (month 0-11). Cruza años. */
  function addMonths(year, month, delta) {
    var total = year * 12 + month + delta;
    var y = Math.floor(total / 12);
    var m = total - y * 12;
    return { year: y, month: m };
  }
  /* «noviembre 2026». Nombres fijos en español (no dependen de la
     configuración regional del navegador). */
  function monthLabel(year, month) {
    var name = MONTH_NAMES[month] || '';
    return name ? (name.charAt(0).toUpperCase() + name.slice(1) + ' ' + year) : String(year);
  }
  function fmtMinutes(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return String(m);
    var h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }
  function fmtDayLabel(ds) {
    var d = new Date(ds);
    var weekday = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d.getDay()];
    return weekday.charAt(0).toUpperCase() + weekday.slice(1) + ' ' +
      d.getDate() + ' de ' + MONTH_NAMES[d.getMonth()] + ' de ' + d.getFullYear();
  }

  /* Rejilla del mes: 6 filas x 7 columnas, semana empezando en lunes
     (calendario en español). Cada celda es {dayStart|null, day|null,
     inMonth}. Las celdas fuera del mes son null (hueco vacío). */
  function buildMonthGrid(year, month) {
    var first = new Date(year, month, 1);
    var offset = (first.getDay() + 6) % 7; // lunes=0 … domingo=6
    var total = daysInMonth(year, month);
    var cells = [];
    for (var i = 0; i < 42; i++) {
      var day = i - offset + 1;
      if (day < 1 || day > total) cells.push({ dayStart: null, day: null, inMonth: false });
      else cells.push({ dayStart: dayStart(new Date(year, month, day).getTime()), day: day, inMonth: true });
    }
    return cells;
  }

  /* Racha actual de días seguidos con escucha, con el mismo criterio
     que wrapped.js y listeningStats() en index.html: si hoy aún no hay
     escucha se empieza a contar desde ayer. Devuelve null cuando no
     hay ninguna fecha (no se puede calcular: se omite, no se inventa
     un 0). */
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

  /* Meses con algún dato fechado (statsLog.at o history.at), más el
     mes actual. Orden descendente (más reciente primero). */
  function availableMonths(statsLog, history, now) {
    var seen = {};
    var push = function (ts) {
      if (!isFinite(Number(ts))) return;
      var d = new Date(Number(ts));
      seen[d.getFullYear() * 12 + d.getMonth()] = 1;
    };
    (statsLog || []).forEach(function (e) { if (e) push(e.at); });
    (history || []).forEach(function (h) { if (h) push(h.at); });
    var cur = new Date(now);
    seen[cur.getFullYear() * 12 + cur.getMonth()] = 1;
    return Object.keys(seen).map(function (k) { return parseInt(k, 10); })
      .sort(function (a, b) { return b - a; })
      .map(function (k) { return { year: Math.floor(k / 12), month: k % 12 }; });
  }

  /* Agrupa la escucha por día (clave: dayStart en ms, hora local).
     Devuelve un objeto { [dayStart]: day } con:
       dayStart, sec (segundos REALES de statsLog, 0 si no hay),
       minutes (redondeado), plays (reproducciones medidas),
       hasMinutes (hay statsLog ese día),
       historyOnly (día solo en history, sin segundos medidos),
       songs: [{key, id, title, artist, sec, count, secUnknown}]
         ordenadas por segundos (luego veces, luego título).
     Las entradas sin at válido se ignoran. Las de history cuyo id ya
     está ese día en statsLog no se duplican. */
  function groupByDay(statsLog, history, tracks) {
    var byId = {};
    (Array.isArray(tracks) ? tracks : []).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var days = {};

    function dayFor(ds) {
      if (!days[ds]) {
        days[ds] = {
          dayStart: ds, sec: 0, minutes: 0, plays: 0,
          hasMinutes: false, historyOnly: false, songs: [], _songMap: {}
        };
      }
      return days[ds];
    }
    function resolveTitle(e, t) {
      return str(e && e.title, t ? str(t.title, UNKNOWN_TITLE) : UNKNOWN_TITLE);
    }
    function resolveArtist(e, t) {
      return str(e && e.artist, t ? str(t.artist, UNKNOWN_ARTIST) : UNKNOWN_ARTIST);
    }

    (Array.isArray(statsLog) ? statsLog : []).forEach(function (e) {
      if (!e || !isFinite(Number(e.at))) return;
      var ds = dayStart(Number(e.at));
      var day = dayFor(ds);
      var sec = num(e.sec);
      day.sec += sec;
      day.plays++;
      day.hasMinutes = true;
      var t = e.id ? byId[e.id] : null;
      var title = resolveTitle(e, t);
      var artist = resolveArtist(e, t);
      var key = (e.id || '') ? ('id:' + e.id) : ('t:' + title + '|' + artist);
      if (!day._songMap[key]) {
        day._songMap[key] = { key: key, id: e.id || null, title: title, artist: artist, sec: 0, count: 0, secUnknown: false };
        day.songs.push(day._songMap[key]);
      }
      day._songMap[key].sec += sec;
      day._songMap[key].count++;
    });

    (Array.isArray(history) ? history : []).forEach(function (h) {
      if (!h || !isFinite(Number(h.at))) return;
      var ds = dayStart(Number(h.at));
      var day = dayFor(ds);
      if (!day.hasMinutes) day.historyOnly = true;
      if (!h.id) return; // sin id no se puede resolver la canción
      var key = 'id:' + h.id;
      if (day._songMap[key]) return; // ya está ese día vía statsLog: no duplicar
      var t = byId[h.id] || null;
      var row = {
        key: key, id: h.id,
        title: t ? str(t.title, UNKNOWN_TITLE) : UNKNOWN_TITLE,
        artist: t ? str(t.artist, UNKNOWN_ARTIST) : UNKNOWN_ARTIST,
        sec: 0, count: 1, secUnknown: true // sonó, pero sin segundos medidos
      };
      day._songMap[key] = row;
      day.songs.push(row);
    });

    Object.keys(days).forEach(function (k) {
      var day = days[k];
      day.minutes = Math.round(day.sec / 60);
      day.songs.sort(function (a, b) {
        if (b.sec !== a.sec) return b.sec - a.sec;
        if (b.count !== a.count) return b.count - a.count;
        return (a.title < b.title) ? -1 : (a.title > b.title ? 1 : 0);
      });
      delete day._songMap;
    });
    return days;
  }

  /* Detalle de un día: canciones/artistas que sonaron ese día, con
     totales. Si el día no tiene datos, devuelve null (la vista
     muestra el mensaje amable, no una lista vacía inventada). */
  function dayDetail(days, ds) {
    if (!days) return null;
    var day = days[ds] || days[String(ds)];
    if (!day || !day.songs.length) return null;
    return {
      dayStart: day.dayStart,
      label: fmtDayLabel(day.dayStart),
      sec: day.sec,
      minutes: day.minutes,
      minutesText: day.hasMinutes ? fmtMinutes(day.sec) : null,
      plays: day.plays,
      hasMinutes: day.hasMinutes,
      historyOnly: day.historyOnly,
      songs: day.songs.map(function (s) {
        return { id: s.id, title: s.title, artist: s.artist, sec: s.sec, count: s.count, secUnknown: !!s.secUnknown };
      })
    };
  }

  /* Núcleo: calcula la línea de tiempo a partir de los datos tal como
     los guarda la app. data = { statsLog, history, tracks };
     opts = { year, month, now }. Nunca lanza con datos raros. */
  function computeTimeline(data, opts) {
    data = data || {};
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var statsLog = Array.isArray(data.statsLog) ? data.statsLog : [];
    var history = Array.isArray(data.history) ? data.history : [];
    var tracks = Array.isArray(data.tracks) ? data.tracks : [];

    var months = availableMonths(statsLog, history, now);
    var year = opts.year;
    var month = opts.month;
    if (!isFinite(Number(year)) || !isFinite(Number(month)) || month < 0 || month > 11) {
      /* Mes por defecto: el actual si tiene datos; si no, el más
         reciente con datos (no un mes vacío). availableMonths()
         siempre incluye el mes actual aunque esté vacío, así que
         aquí se distingue con los meses que de verdad tienen datos. */
      var cur = new Date(now);
      var curKey = cur.getFullYear() * 12 + cur.getMonth();
      var dataKeys = {};
      var collect = function (ts) {
        if (!isFinite(Number(ts))) return;
        var d = new Date(Number(ts));
        dataKeys[d.getFullYear() * 12 + d.getMonth()] = 1;
      };
      statsLog.forEach(function (e) { if (e) collect(e.at); });
      history.forEach(function (h) { if (h) collect(h.at); });
      if (dataKeys[curKey]) {
        year = cur.getFullYear(); month = cur.getMonth();
      } else {
        var dataMonths = Object.keys(dataKeys).map(function (k) { return parseInt(k, 10); })
          .sort(function (a, b) { return b - a; });
        if (dataMonths.length) {
          year = Math.floor(dataMonths[0] / 12); month = dataMonths[0] % 12;
        } else {
          year = cur.getFullYear(); month = cur.getMonth();
        }
      }
    }
    year = parseInt(year, 10);
    month = parseInt(month, 10);

    var days = groupByDay(statsLog, history, tracks);
    var dayStarts = Object.keys(days).map(function (k) { return parseInt(k, 10); });
    var streak = computeStreak(dayStarts, now);

    var totalSec = 0, plays = 0;
    dayStarts.forEach(function (ds) { totalSec += days[ds].sec; plays += days[ds].plays; });

    var monthDays = dayStarts.filter(function (ds) {
      var d = new Date(ds);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    var monthSec = 0, monthPlays = 0;
    monthDays.forEach(function (ds) { monthSec += days[ds].sec; monthPlays += days[ds].plays; });

    var anyData = statsLog.length > 0 || history.length > 0;
    return {
      year: year,
      month: month,
      label: monthLabel(year, month),
      availableMonths: months,
      days: days,
      dayStarts: dayStarts,
      streak: streak, // null = sin fechas: se omite en la vista
      totalDays: dayStarts.length,
      totalSec: totalSec,
      totalMinutes: Math.round(totalSec / 60),
      plays: plays,
      monthDays: monthDays.length,
      monthSec: monthSec,
      monthMinutes: Math.round(monthSec / 60),
      monthPlays: monthPlays,
      hasData: monthDays.length > 0, // hay escucha en el mes elegido
      anyData: anyData // hay escucha en algún mes
    };
  }

  var api = {
    computeTimeline: computeTimeline,
    groupByDay: groupByDay,
    dayDetail: dayDetail,
    computeStreak: computeStreak,
    buildMonthGrid: buildMonthGrid,
    addMonths: addMonths,
    availableMonths: availableMonths,
    daysInMonth: daysInMonth,
    monthLabel: monthLabel,
    fmtMinutes: fmtMinutes,
    fmtDayLabel: fmtDayLabel,
    dayStart: dayStart
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__timelineHelpers = api; } catch (e) { /* consola: window.__timelineHelpers */ }

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

  var currentTimeline = null;
  var selectedDay = null;
  var overlay = null;
  var renderSeq = 0; // la navegación rápida no deja que una lectura vieja pise a la nueva

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* Nivel de intensidad del día (0-4) para el color de la celda,
     relativo al día con más minutos del mes visible. */
  function levelFor(minutes, maxMinutes) {
    if (!minutes || minutes <= 0 || !maxMinutes) return 0;
    var r = minutes / maxMinutes;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  }

  function renderDetail(ds) {
    var box = $('timelineDayDetail');
    if (!box) return;
    box.innerHTML = '';
    if (ds === null || ds === undefined || !currentTimeline) {
      box.appendChild(el('p', 'tl-detail-hint',
        'Toca un día con escucha en el calendario para ver qué canciones y artistas sonaron ese día.'));
      return;
    }
    var d = dayDetail(currentTimeline.days, ds);
    if (!d) {
      box.appendChild(el('p', 'tl-detail-hint',
        'Ese día no hay escucha registrada en tu historial guardado.'));
      return;
    }
    var head = el('div', 'tl-detail-head');
    head.appendChild(el('h4', null, d.label));
    head.appendChild(el('p', 'tl-detail-meta',
      d.hasMinutes
        ? (d.minutesText + ' escuchados · ' + d.plays + (d.plays === 1 ? ' reproducción medida' : ' reproducciones medidas'))
        : 'Con escucha registrada, pero sin segundos medidos guardados ese día.'));
    box.appendChild(head);
    if (d.historyOnly) {
      box.appendChild(el('p', 'tl-note',
        'Las canciones de este día vienen de tu historial (máx. 100 reproducciones): se sabe que sonaron, pero no cuántos minutos, así que no se muestra ningún minuto inventado.'));
    }
    var ol = el('ol', 'tl-day-list');
    var max = Math.max.apply(null, d.songs.map(function (s) { return s.sec; }).concat([1]));
    d.songs.forEach(function (s, i) {
      var li = el('li');
      li.appendChild(el('span', 'tl-rank-n', String(i + 1)));
      var main = el('div', 'tl-rank-main');
      main.appendChild(el('div', 'tl-rank-t', s.title + (s.artist ? ' — ' + s.artist : '')));
      if (!s.secUnknown) {
        var bar = el('div', 'tl-bar');
        var fill = el('div', 'tl-bar-fill');
        fill.style.width = Math.max(3, Math.round((s.sec / max) * 100)) + '%';
        bar.appendChild(fill);
        main.appendChild(bar);
      }
      li.appendChild(main);
      li.appendChild(el('span', 'tl-rank-meta',
        s.secUnknown ? 'sin minutos medidos' : (fmtMinutes(s.sec) + ' · ' + s.count + (s.count === 1 ? ' vez' : ' veces'))));
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  function renderCalendar() {
    var grid = $('timelineCalGrid');
    var label = $('timelineMonthLabel');
    var summary = $('timelineMonthSummary');
    var body = $('timelineBody');
    if (!grid || !currentTimeline) return;
    var t = currentTimeline;
    if (label) label.textContent = t.label;
    if (summary) {
      summary.textContent = t.hasData
        ? (t.monthDays + (t.monthDays === 1 ? ' día' : ' días') + ' con escucha · ' +
           fmtMinutes(t.monthSec) + ' · ' + t.monthPlays + (t.monthPlays === 1 ? ' reproducción medida' : ' reproducciones medidas'))
        : 'Sin escucha registrada en ' + t.label + '.';
    }
    grid.innerHTML = '';
    var cells = buildMonthGrid(t.year, t.month);
    var maxMin = 0;
    cells.forEach(function (c) {
      if (c.inMonth && t.days[c.dayStart]) maxMin = Math.max(maxMin, t.days[c.dayStart].minutes);
    });
    var today = dayStart(Date.now());
    cells.forEach(function (c) {
      var cell;
      if (!c.inMonth) {
        cell = el('span', 'tl-cell tl-cell-empty');
        cell.setAttribute('aria-hidden', 'true');
      } else {
        var day = t.days[c.dayStart];
        cell = el('button', 'tl-cell' + (day ? ' tl-has' : '') + (c.dayStart === today ? ' tl-today' : '') + (c.dayStart === selectedDay ? ' tl-selected' : ''), null);
        cell.type = 'button';
        cell.setAttribute('data-level', String(day ? levelFor(day.minutes, maxMin) : 0));
        if (day && day.historyOnly) cell.classList.add('tl-history-only');
        var numEl = el('span', 'tl-cell-day', String(c.day));
        cell.appendChild(numEl);
        if (day) {
          cell.appendChild(el('span', 'tl-cell-min',
            day.hasMinutes ? (day.minutes < 60 ? day.minutes + ' min' : fmtMinutes(day.sec)) : '♪'));
          cell.setAttribute('aria-label', fmtDayLabel(c.dayStart) +
            (day.hasMinutes ? (': ' + fmtMinutes(day.sec) + ' escuchados') : ': con escucha registrada, sin minutos medidos'));
        } else {
          cell.setAttribute('aria-label', fmtDayLabel(c.dayStart) + ': sin escucha registrada');
        }
        cell.addEventListener('click', function () {
          selectedDay = c.dayStart;
          renderCalendar();
          renderDetail(c.dayStart);
        });
      }
      grid.appendChild(cell);
    });
    if (body) {
      var empty = $('timelineMonthEmpty');
      if (!t.hasData) {
        if (!empty) {
          empty = el('div', 'tl-empty');
          empty.id = 'timelineMonthEmpty';
          empty.appendChild(el('div', 'tl-empty-art', '📅'));
          empty.appendChild(el('p', null, 'Sin escucha registrada en ' + t.label + '.'));
          empty.appendChild(el('p', 'tl-empty-sub',
            'Prueba con otro mes con las flechas de arriba: tu historial guardado puede tener escucha en otros meses.'));
          body.appendChild(empty);
        }
        empty.style.display = '';
      } else if (empty) {
        empty.style.display = 'none';
      }
    }
  }

  function renderTimeline(year, month) {
    var body = $('timelineBody');
    var streakEl = $('timelineStreak');
    if (!body) return;
    body.innerHTML = '';
    var gridWrap = el('div', 'tl-cal-wrap');
    var nav = el('div', 'tl-nav');
    var prev = el('button', 'btn small', '‹ Anterior');
    prev.id = 'timelinePrev';
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Mes anterior');
    prev.addEventListener('click', function () {
      var p = addMonths(currentTimeline.year, currentTimeline.month, -1);
      renderTimeline(p.year, p.month);
    });
    var next = el('button', 'btn small', 'Siguiente ›');
    next.id = 'timelineNext';
    next.type = 'button';
    next.setAttribute('aria-label', 'Mes siguiente');
    next.addEventListener('click', function () {
      var p = addMonths(currentTimeline.year, currentTimeline.month, 1);
      renderTimeline(p.year, p.month);
    });
    var lbl = el('h4', 'tl-month-label', '');
    lbl.id = 'timelineMonthLabel';
    nav.appendChild(prev);
    nav.appendChild(lbl);
    nav.appendChild(next);
    gridWrap.appendChild(nav);
    var sum = el('p', 'tl-month-summary', '');
    sum.id = 'timelineMonthSummary';
    gridWrap.appendChild(sum);
    var head = el('div', 'tl-week-head');
    WEEKDAY_SHORT.forEach(function (w) { head.appendChild(el('span', null, w)); });
    gridWrap.appendChild(head);
    var grid = el('div', 'tl-grid');
    grid.id = 'timelineCalGrid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Calendario de escucha por mes');
    gridWrap.appendChild(grid);
    body.appendChild(gridWrap);
    var detail = el('div', 'tl-detail');
    detail.id = 'timelineDayDetail';
    body.appendChild(detail);
    if (streakEl) streakEl.textContent = '';

    var seq = ++renderSeq;
    readData().then(function (data) {
      if (seq !== renderSeq) return; // una navegación más reciente ya manda
      var t = computeTimeline(data, { year: year, month: month });
      currentTimeline = t;
      selectedDay = null;
      if (streakEl) {
        streakEl.textContent = (typeof t.streak === 'number' && t.streak > 0)
          ? ('🔥 Racha: ' + t.streak + (t.streak === 1 ? ' día' : ' días') + ' seguidos escuchando música · ' +
             t.totalDays + (t.totalDays === 1 ? ' día' : ' días') + ' con escucha en total')
          : (t.anyData ? (t.totalDays + (t.totalDays === 1 ? ' día' : ' días') + ' con escucha en total') : '');
      }
      if (!t.anyData) {
        body.innerHTML = '';
        var empty = el('div', 'tl-empty');
        empty.appendChild(el('div', 'tl-empty-art', '🎧'));
        empty.appendChild(el('p', null, 'Todavía no hay nada en tu línea de tiempo.'));
        empty.appendChild(el('p', 'tl-empty-sub',
          'Escucha algunas canciones y vuelve aquí: en cuanto suenen, verás en qué días escuchaste música, cuántos minutos cada día y tu racha de días seguidos.'));
        body.appendChild(empty);
        return;
      }
      renderCalendar();
      renderDetail(null);
    }).catch(function () {
      if (seq !== renderSeq) return;
      body.innerHTML = '';
      var err = el('div', 'tl-empty');
      err.appendChild(el('p', null, 'No se pudo leer tu historial ahora mismo.'));
      err.appendChild(el('p', 'tl-empty-sub', 'Cierra y vuelve a intentarlo; tu biblioteca y tu historial no se han tocado.'));
      body.appendChild(err);
    });
  }

  function buildModal() {
    overlay = el('div', 'modal-overlay timeline-overlay');
    overlay.id = 'timelineModal';
    overlay.setAttribute('aria-hidden', 'true');
    var modal = el('div', 'modal timeline-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'timelineModalTitle');
    var head = el('div', 'timeline-head');
    var h3 = el('h3', null, 'Línea de tiempo de escucha');
    h3.id = 'timelineModalTitle';
    head.appendChild(h3);
    var closeBtn = el('button', 'timeline-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar línea de tiempo');
    closeBtn.addEventListener('click', closeTimeline);
    head.appendChild(closeBtn);
    modal.appendChild(head);
    modal.appendChild(el('p', 'timeline-sub',
      'Tu calendario de escucha, calculado solo en este dispositivo con tu historial guardado. Nada se sube a ningún sitio.'));
    var streak = el('p', 'timeline-streak', '');
    streak.id = 'timelineStreak';
    modal.appendChild(streak);
    var body = el('div');
    body.id = 'timelineBody';
    modal.appendChild(body);
    var actions = el('div', 'modal-actions');
    actions.style.flexWrap = 'wrap';
    var closeBtn2 = el('button', 'btn small', 'Cerrar');
    closeBtn2.type = 'button';
    closeBtn2.addEventListener('click', closeTimeline);
    actions.appendChild(closeBtn2);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeTimeline(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.classList.contains('on')) closeTimeline();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function openTimeline() {
    if (!overlay) buildModal();
    overlay.classList.add('on');
    overlay.setAttribute('aria-hidden', 'false');
    renderTimeline();
    var prev = $('timelinePrev');
    if (prev) prev.focus();
  }
  function closeTimeline() {
    if (!overlay) return;
    overlay.classList.remove('on');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function wireButton() {
    /* Botón principal: #btnTimeline, junto a #btnWrapped en la fila
       de respaldo. Si el cableado HTML no lo añadió, se crea solo
       después de #btnWrapped (mismo respaldo que wrapped.js). */
    var btn = $('btnTimeline');
    if (!btn) {
      var wrappedBtn = $('btnWrapped');
      if (wrappedBtn && wrappedBtn.parentNode) {
        btn = document.createElement('button');
        btn.className = 'btn small';
        btn.id = 'btnTimeline';
        btn.type = 'button';
        btn.textContent = '📅 Línea de tiempo';
        wrappedBtn.parentNode.insertBefore(btn, wrappedBtn.nextSibling);
      }
    }
    if (btn && !btn.getAttribute('data-timeline-wired')) {
      btn.setAttribute('data-timeline-wired', '1');
      btn.addEventListener('click', openTimeline);
    }
    /* Segundo acceso desde Estadísticas: botón dentro de la
       cabecera de #viewStats (vista «Estadísticas»), junto al
       título «Estadísticas de escucha». */
    var statsView = $('viewStats');
    if (statsView && !$('btnTimelineStats')) {
      var head = statsView.querySelector('.subview-head > div') || statsView.querySelector('.subview-head');
      if (head) {
        var statsBtn = document.createElement('button');
        statsBtn.className = 'btn small';
        statsBtn.id = 'btnTimelineStats';
        statsBtn.type = 'button';
        statsBtn.textContent = '📅 Línea de tiempo';
        statsBtn.addEventListener('click', openTimeline);
        head.appendChild(statsBtn);
      }
    }
  }

  function init() {
    try {
      wireButton();
      var tries = 0;
      var tick = function () {
        wireButton();
        tries++;
        if (tries < 30 && !g.__rpmApp) setTimeout(tick, 100);
      };
      tick();
    } catch (e) { /* fail-safe: línea de tiempo desactivada, app intacta */ }
  }

  g.__rpmTimeline = { open: openTimeline, close: closeTimeline, computeTimeline: computeTimeline, groupByDay: groupByDay, dayDetail: dayDetail };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
