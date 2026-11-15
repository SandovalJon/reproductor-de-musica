/* Modo DJ en vivo — cola en vivo y peticiones para fiestas (v4.0.0).
   ---------------------------------------------------------------
   HECHO VERIFICADO EN app/index.html (NO duplicar):
   - Crossfade: #btnCrossfade, #crossfadeRange, settings.crossfade /
     settings.crossfadeSec; maybeCrossfade() / startCrossfade().
   - "Mezclar ahora": #btnMixNow (jugador) y #btnMixNow2 (panel Sonido).
   - Modo DJ: #btnDjToggle / #djState / #djStatus, #djNextBox /
     #djNextText; djPickNext() elige la próxima por cercanía de BPM y
     Camelot. La cola MANUAL manda sobre el DJ en el avance, el
     crossfade y "Mezclar ahora" (onEnded, maybeCrossfade, mixNow).
   - Cola de la app: array interno `queue`; queueNext(id) = la pone la
     primera (sonará a continuación), queueAdd(id) = al final; ambas
     rechazan canciones con dislike. Vista #viewQueue con #queueList:
     cada fila li.track[data-track-id] con botones .remove-btn
     [title="Subir en la cola" / "Bajar en la cola" / "Quitar de la
     cola"]; #btnQueueClear vacía la cola.
   - Menú ⋯ por canción (#trackMenu): "Tocar siguiente" llama a
     queueNext(id) y "Añadir a la cola" a queueAdd(id). Filas de la
     biblioteca: #trackList > li.track[data-track-id] con .menu-btn.
   - Mezcla automática DJ (dj.js, 3.6.0): #btnDjAuto + #djAutoPanel;
     window.__rpmDj.enable()/disable()/isOn()/state() enciende juntos
     crossfade + Modo DJ y al apagar restaura lo que había antes.
   - La app expone window.__rpmApp.getTracks() (lista de pistas con
     id, title, artist, album, bpm, rating).

   LO QUE HACE ESTE MÓDULO (y nada más):
   - Un interruptor visible "🎧 DJ en vivo" que enciende la mezcla
     automática DJ EXISTENTE (vía __rpmDj.enable(), o con .click()
     sobre #btnCrossfade + #btnDjToggle si dj.js no está) y muestra la
     cola en vivo. Al apagarlo, restaura el modo de reproducción
     anterior (vía __rpmDj.disable() o devolviendo los dos botones a
     como estaban). La cola pedida NO se borra al apagar: es la cola
     normal de la app y seguirá sonando en orden.
   - Cola en vivo: espejo de la cola REAL de la app (leída de
     #queueList) en orden, con la siguiente según el DJ detrás de la
     cola (la app la elige solo cuando la cola se vacía). Cada fila
     de la cola tiene ↑ ↓ ✕ que pulsan los botones REALES de la vista
     Cola de la app (Subir / Bajar / Quitar), así el orden se guarda
     con saveState() como siempre.
   - Pedir canciones: buscador sobre la biblioteca (getTracks(), sin
     inventar nada; las canciones con dislike no se pueden pedir
     porque la propia app las rechaza en la cola). "▶ Siguiente" pide
     que suene a continuación y "+ Cola" la añade al final, ambas
     pulsando el menú ⋯ REAL de la canción ("Tocar siguiente" /
     "Añadir a la cola"), así corren queueNext/queueAdd de la app con
     sus toasts y sus validaciones.
   - "Mezclar ahora" dentro del panel: pulsa el #btnMixNow REAL.

   FAIL-SAFE: todo por detección de elementos con guards. Sin
   #btnCrossfade ni #btnDjToggle ni #btnDjAuto, el módulo no monta
   nada. Si el buscador no encuentra la fila de la canción en la
   biblioteca (filtro activo), lo dice y no toca nada. Si el script
   falla al cargar, la app sigue igual: crossfade, Modo DJ, mezcla
   automática y cola manual funcionan exactamente como antes.
   Vanilla JS, sin dependencias. */
(function (global) {
  'use strict';

  var VERSION = '4.0.0';
  var STORE_KEY = 'rpm-dj-vivo:v1';
  var MAX_QUEUE_SHOWN = 10;
  var MAX_RESULTS = 8;

  /* ================= Partes puras (probadas en Node) ================= */

  function normText(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e')
      .replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o')
      .replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
      .replace(/\s+/g, ' ');
  }

  /* ¿Se puede pedir esta pista? La app rechaza los dislikes en la
     cola (queueNext/queueAdd) y no tiene sentido pedir sin id. */
  function validateRequest(track, mode) {
    if (!track || track.id === undefined || track.id === null || track.id === '') {
      return { ok: false, reason: 'sin-cancion' };
    }
    if (track.rating === 'dislike') {
      return { ok: false, reason: 'dislike' };
    }
    if (mode !== 'next' && mode !== 'end') {
      return { ok: false, reason: 'modo-invalido' };
    }
    return { ok: true, reason: null };
  }

  /* Buscador de la biblioteca: coincide si TODAS las palabras de la
     búsqueda aparecen en título, artista o álbum. Sin dislike (no se
     pueden pedir) y sin inventar resultados. Vacía -> []. */
  function searchTracks(tracks, query) {
    if (!Array.isArray(tracks)) return [];
    var q = normText(query);
    if (!q) return [];
    var words = q.split(' ').filter(Boolean);
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t || t.rating === 'dislike') continue;
      var hay = normText([t.title, t.artist, t.album].filter(Boolean).join(' '));
      var ok = true;
      for (var w = 0; w < words.length; w++) {
        if (hay.indexOf(words[w]) < 0) { ok = false; break; }
      }
      if (ok) out.push(t);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }

  function normTitle(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /* Título de la siguiente según el DJ, del texto que la propia app
     pinta (#djNextText: "La próxima será «Título» de Artista…"). */
  function parseNextTitle(text) {
    if (typeof text !== 'string' || !text) return null;
    var m = text.match(/«(.+?)»/);
    if (m) return m[1].trim() || null;
    return null;
  }

  function findTrackByTitle(tracks, title, artist) {
    if (!Array.isArray(tracks) || !title) return null;
    var t = normTitle(title), a = normTitle(artist);
    var byTitle = null;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (!tr || normTitle(tr.title) !== t) continue;
      if (a && normTitle(tr.artist) === a) return tr;
      if (!byTitle) byTitle = tr;
    }
    return byTitle;
  }

  function trackLabel(t) {
    if (!t) return '—';
    var s = t.title || t.name || 'Sin título';
    if (t.artist) s += ' · ' + t.artist;
    if (typeof t.bpm === 'number' && t.bpm) s += ' · ' + t.bpm + ' BPM';
    return s;
  }

  /* Vista de "qué viene después": primero la cola REAL de la app en
     su orden, y detrás la siguiente según el DJ (que solo sonará
     cuando la cola se vacíe). ids de cola que ya no existen en la
     biblioteca se saltan; el DJ no se repite si ya está en la cola.
     Devuelve { items:[{id,title,artist,bpm,from,pos}], hidden, djId }. */
  function buildLiveQueue(queueIds, tracksById, djNextId, currentId) {
    var items = [];
    var seen = {};
    if (currentId !== undefined && currentId !== null) seen[currentId] = true;
    var ids = Array.isArray(queueIds) ? queueIds : [];
    for (var i = 0; i < ids.length; i++) {
      var t = tracksById ? tracksById[ids[i]] : null;
      if (!t) continue;
      if (seen[t.id]) continue;
      seen[t.id] = true;
      items.push({
        id: t.id, title: t.title || t.name || 'Sin título',
        artist: t.artist || '', bpm: (typeof t.bpm === 'number' && t.bpm) ? t.bpm : null,
        from: 'cola', pos: items.length + 1
      });
    }
    var djShown = null;
    if (djNextId !== null && djNextId !== undefined) {
      var dj = tracksById ? tracksById[djNextId] : null;
      if (dj && !seen[dj.id]) {
        djShown = dj.id;
        items.push({
          id: dj.id, title: dj.title || dj.name || 'Sin título',
          artist: dj.artist || '', bpm: (typeof dj.bpm === 'number' && dj.bpm) ? dj.bpm : null,
          from: 'dj', pos: items.length + 1
        });
      }
    }
    var hidden = Math.max(0, items.length - MAX_QUEUE_SHOWN);
    return { items: items.slice(0, MAX_QUEUE_SHOWN), hidden: hidden, djId: djShown, total: items.length };
  }

  /* Reordenar la cola (puro; la capa DOM lo aplica pulsando los
     botones reales de la vista Cola). Devuelve la lista nueva o null
     si no se puede mover (arriba del todo, abajo del todo, no está). */
  function moveInQueue(ids, id, dir) {
    if (!Array.isArray(ids)) return null;
    var idx = ids.indexOf(id);
    if (idx < 0) return null;
    var to = idx + dir;
    if (to < 0 || to >= ids.length) return null;
    var out = ids.slice();
    var tmp = out[idx]; out[idx] = out[to]; out[to] = tmp;
    return out;
  }

  function removeFromQueue(ids, id) {
    if (!Array.isArray(ids)) return null;
    var idx = ids.indexOf(id);
    if (idx < 0) return null;
    var out = ids.slice();
    out.splice(idx, 1);
    return out;
  }

  /* Plan para encender el DJ en vivo: crossfade + Modo DJ en true.
     null = ya está así, no hay que tocar ese botón. */
  function planVivoEnable(current) {
    function need(want, have) { return want === !!have ? null : want; }
    var c = current || {};
    return { crossfade: need(true, c.crossfade), dj: need(true, c.dj) };
  }

  /* Plan para restaurar lo que había antes de encenderlo. */
  function planVivoRestore(prev, current) {
    if (!prev || typeof prev !== 'object') return { crossfade: null, dj: null };
    function need(want, have) { return want === !!have ? null : want; }
    var c = current || {};
    return { crossfade: need(prev.crossfade, c.crossfade), dj: need(prev.dj, c.dj) };
  }

  /* ¿La mezcla automática DJ (dj.js) está encendida? Se lee de su API
     si existe; si no, de crossfade + DJ directamente. */
  function vivoUnderlyingOn(djAutoOn, current) {
    if (typeof djAutoOn === 'boolean') return djAutoOn;
    var c = current || {};
    return !!(c.crossfade && c.dj);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normText: normText, validateRequest: validateRequest,
      searchTracks: searchTracks, parseNextTitle: parseNextTitle,
      findTrackByTitle: findTrackByTitle, trackLabel: trackLabel,
      buildLiveQueue: buildLiveQueue, moveInQueue: moveInQueue,
      removeFromQueue: removeFromQueue, planVivoEnable: planVivoEnable,
      planVivoRestore: planVivoRestore, vivoUnderlyingOn: vivoUnderlyingOn,
      MAX_QUEUE_SHOWN: MAX_QUEUE_SHOWN, MAX_RESULTS: MAX_RESULTS
    };
  }

  /* ================= Capa DOM (todo con guards) ================= */

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function textOf(el) {
    try { return (el && el.textContent) ? el.textContent : ''; } catch (e) { return ''; }
  }

  function readStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { on: false, viaDjAuto: false, prev: null };
      var o = JSON.parse(raw);
      return {
        on: !!o.on, viaDjAuto: !!o.viaDjAuto,
        prev: (o.prev && typeof o.prev === 'object') ? o.prev : null
      };
    } catch (e) { return { on: false, viaDjAuto: false, prev: null }; }
  }

  function writeStored(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function isToggleOn(btn, stateEl) {
    if (!btn) return false;
    try {
      var ap = btn.getAttribute('aria-pressed');
      if (ap === 'true') return true;
      if (ap === 'false') return false;
      if (btn.classList && btn.classList.contains('on')) return true;
      if (stateEl) {
        var txt = (stateEl.textContent || '').trim();
        if (/^activad/i.test(txt)) return true;
        if (/^apagad/i.test(txt) || /^desactivad/i.test(txt)) return false;
      }
    } catch (e) {}
    return false;
  }

  function currentUnderlying() {
    return {
      crossfade: isToggleOn($('btnCrossfade'), $('crossfadeState')),
      dj: isToggleOn($('btnDjToggle'), $('djState'))
    };
  }

  function djAutoApi() {
    try { return global.__rpmDj || null; } catch (e) { return null; }
  }

  function getTracks() {
    try {
      var app = global.__rpmApp;
      if (app && typeof app.getTracks === 'function') {
        var list = app.getTracks();
        if (Array.isArray(list)) return list;
      }
    } catch (e) {}
    return [];
  }

  function tracksByIdMap(tracks) {
    var map = {};
    (tracks || []).forEach(function (t) { if (t && t.id !== undefined && t.id !== null) map[t.id] = t; });
    return map;
  }

  /* Fila de una canción en la biblioteca (#trackList) por id. */
  function libraryRow(id) {
    try {
      var list = $('trackList');
      if (!list) return null;
      return list.querySelector('li.track[data-track-id="' + String(id).replace(/"/g, '') + '"]');
    } catch (e) { return null; }
  }

  /* Pide una canción pulsando su menú ⋯ REAL ("Tocar siguiente" o
     "Añadir a la cola"). Devuelve true si se pulsó, false si no se
     pudo (fila no renderizada, menú sin esa opción, dislike). */
  function requestViaMenu(track, mode) {
    var v = validateRequest(track, mode);
    if (!v.ok) return { ok: false, reason: v.reason };
    var row = libraryRow(track.id);
    if (!row) return { ok: false, reason: 'sin-fila' };
    var menuBtn = null;
    try { menuBtn = row.querySelector('.menu-btn'); } catch (e) {}
    if (!menuBtn) return { ok: false, reason: 'sin-menu' };
    var menu = $('trackMenu');
    try { menuBtn.click(); } catch (e) { return { ok: false, reason: 'sin-menu' }; }
    /* El menú ⋯ se abre y se cierra con el mismo botón: si ya estaba
       abierto para otra canción, el click lo cierra y hay que abrirlo. */
    try {
      if (menu && !menu.classList.contains('on')) menuBtn.click();
    } catch (e) {}
    var label = mode === 'next' ? 'Tocar siguiente' : 'Añadir a la cola';
    var item = null;
    try {
      var btns = menu ? menu.querySelectorAll('button[role="menuitem"]') : [];
      for (var i = 0; i < btns.length; i++) {
        var span = btns[i].querySelector('span');
        if (span && textOf(span).trim() === label) { item = btns[i]; break; }
      }
    } catch (e) {}
    if (!item) return { ok: false, reason: 'sin-opcion' };
    try { item.click(); } catch (e) { return { ok: false, reason: 'sin-opcion' }; }
    return { ok: true, reason: null };
  }

  /* Cola REAL de la app, leída de su vista #queueList (misma fuente
     que ve el usuario en la pestaña Cola). */
  function readQueueIds() {
    var ids = [];
    try {
      var list = $('queueList');
      if (!list) return ids;
      var rows = list.querySelectorAll('li.track[data-track-id]');
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].getAttribute('data-track-id');
        if (id !== null && id !== '') ids.push(id);
      }
    } catch (e) {}
    return ids;
  }

  /* Pulsa el botón REAL de la vista Cola (Subir / Bajar / Quitar) de
     la fila con ese id. Esos botones guardan el orden con saveState()
     como siempre. */
  function queueRowAction(id, title) {
    try {
      var list = $('queueList');
      if (!list) return false;
      var row = list.querySelector('li.track[data-track-id="' + String(id).replace(/"/g, '') + '"]');
      if (!row) return false;
      var btns = row.querySelectorAll('button[title]');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('title') === title) { btns[i].click(); return true; }
      }
    } catch (e) {}
    return false;
  }

  function readCurrentTrack() {
    var tracks = getTracks();
    var map = tracksByIdMap(tracks);
    try {
      var active = document.querySelector('#trackList .track.active');
      if (active) {
        var id = active.getAttribute('data-track-id');
        if (id !== null && map[id]) return map[id];
      }
    } catch (e) {}
    var title = textOf($('nowTitle')).trim();
    var artist = textOf($('nowArtist')).trim();
    if (title && title !== 'Ninguna canción seleccionada') {
      var tr = findTrackByTitle(tracks, title, artist);
      if (tr) return tr;
      return { title: title, artist: artist };
    }
    return null;
  }

  function readDjNextId(tracks) {
    var under = currentUnderlying();
    if (!under.dj) return null;
    var djText = textOf($('djNextText')) || textOf($('djStatus'));
    if (!djText) return null;
    var title = parseNextTitle(djText);
    if (!title) return null;
    var tr = findTrackByTitle(tracks, title, null);
    return tr ? tr.id : null;
  }

  function setUnderlying(which, wantOn) {
    var btn = which === 'crossfade' ? $('btnCrossfade') : $('btnDjToggle');
    var stateEl = which === 'crossfade' ? $('crossfadeState') : $('djState');
    if (!btn) return false;
    try {
      if (isToggleOn(btn, stateEl) === !!wantOn) return false;
      btn.click();
      return true;
    } catch (e) { return false; }
  }

  var state = { on: false, viaDjAuto: false, prev: null };
  var els = null;
  var lastSearch = '';

  function say(msg) {
    if (els && els.status) els.status.textContent = msg || '';
  }

  function refresh() {
    if (!els) return;
    try {
      var api = djAutoApi();
      var under = currentUnderlying();
      var autoOn = api && typeof api.isOn === 'function' ? api.isOn() : null;
      /* Deriva: si el usuario apagó a mano el crossfade, el DJ o la
         mezcla automática mientras el DJ en vivo estaba encendido, el
         vivo ya no está completo: se apaga solo, sin pulsar nada. */
      if (state.on && !vivoUnderlyingOn(autoOn, under)) {
        state.on = false; state.viaDjAuto = false; state.prev = null;
        writeStored(state);
        say('El crossfade, el Modo DJ o la mezcla automática se cambió a mano: el DJ en vivo quedó desactivado.');
      }
      var tracks = getTracks();
      var map = tracksByIdMap(tracks);
      var cur = readCurrentTrack();
      var queueIds = readQueueIds();
      var djId = readDjNextId(tracks);
      var view = buildLiveQueue(queueIds, map, djId, cur && cur.id !== undefined ? cur.id : null);

      if (els.toggle) {
        els.toggle.classList.toggle('on', state.on);
        els.toggle.setAttribute('aria-pressed', state.on ? 'true' : 'false');
        var label = els.toggle.querySelector('[data-vivo-label]');
        if (label) label.textContent = state.on ? '🎧 DJ en vivo: activado' : '🎧 DJ en vivo';
      }
      if (els.now) {
        els.now.textContent = cur
          ? 'Sonando ahora: ' + trackLabel(cur)
          : 'Sonando ahora: nada todavía. Dale a reproducir una canción.';
      }
      if (els.queue) {
        els.queue.innerHTML = '';
        if (!view.items.length) {
          var li0 = document.createElement('li');
          li0.className = 'dj-vivo-empty';
          li0.textContent = under.dj
            ? 'Cola vacía: cuando termine la actual, el DJ elegirá la siguiente por cercanía de BPM.'
            : 'Cola vacía. Pide una canción abajo o enciende el DJ en vivo para que el DJ elija.';
          els.queue.appendChild(li0);
        }
        view.items.forEach(function (it) {
          var li = document.createElement('li');
          li.className = 'dj-vivo-row' + (it.from === 'dj' ? ' dj-vivo-row-dj' : '');
          li.setAttribute('data-track-id', String(it.id));
          var pos = document.createElement('span');
          pos.className = 'dj-vivo-pos';
          pos.textContent = it.pos + '.';
          var main = document.createElement('span');
          main.className = 'dj-vivo-main';
          main.textContent = trackLabel({ title: it.title, artist: it.artist, bpm: it.bpm });
          var tag = document.createElement('span');
          tag.className = 'dj-vivo-tag';
          tag.textContent = it.from === 'dj' ? 'DJ' : 'pedida';
          li.appendChild(pos); li.appendChild(main); li.appendChild(tag);
          if (it.from === 'cola') {
            [['↑', 'Subir en la cola', -1], ['↓', 'Bajar en la cola', 1]].forEach(function (cfg) {
              var b = document.createElement('button');
              b.type = 'button'; b.className = 'dj-vivo-step';
              b.textContent = cfg[0];
              b.setAttribute('aria-label', cfg[1] + ' ' + it.title);
              b.addEventListener('click', function () {
                /* El orden real lo mueve el botón de la vista Cola;
                   aquí solo se comprueba antes que se pueda mover. */
                if (moveInQueue(queueIds, String(it.id), cfg[2]) === null &&
                    moveInQueue(queueIds, it.id, cfg[2]) === null) {
                  say('«' + it.title + '» ya está ' + (cfg[2] < 0 ? 'la primera' : 'la última') + ' de la cola.');
                  return;
                }
                if (queueRowAction(it.id, cfg[1])) setTimeout(refresh, 60);
                else say('No se pudo reordenar: abre la pestaña Cola y usa sus botones ↑ ↓.');
              });
              li.appendChild(b);
            });
            var x = document.createElement('button');
            x.type = 'button'; x.className = 'dj-vivo-step dj-vivo-x';
            x.textContent = '✕';
            x.setAttribute('aria-label', 'Quitar de la cola ' + it.title);
            x.addEventListener('click', function () {
              if (queueRowAction(it.id, 'Quitar de la cola')) setTimeout(refresh, 60);
              else say('No se pudo quitar: abre la pestaña Cola y usa su botón ✕.');
            });
            li.appendChild(x);
          }
          els.queue.appendChild(li);
        });
        if (view.hidden > 0) {
          var more = document.createElement('li');
          more.className = 'dj-vivo-empty';
          more.textContent = '…y ' + view.hidden + ' más en la cola (ver pestaña Cola).';
          els.queue.appendChild(more);
        }
      }
      if (els.mix) els.mix.style.display = $('btnMixNow') ? '' : 'none';
      if (els.reqBox) els.reqBox.style.display = tracks.length ? '' : 'none';
      if (els.status && !state.on && !/cambió a mano/.test(els.status.textContent || '')) {
        els.status.textContent = state.prev
          ? 'Al apagar volverán el crossfade y el Modo DJ a como estaban.'
          : 'Enciende la mezcla automática DJ y muestra la cola en vivo con peticiones. Al apagar, restaura lo que tenías.';
      } else if (els.status && state.on) {
        els.status.textContent = 'Mezcla automática con crossfade entre canciones. Pide canciones abajo: la cola manda sobre el DJ.';
      }
    } catch (e) { /* El panel nunca debe romper la app. */ }
  }

  function renderSearchResults() {
    if (!els || !els.results) return;
    try {
      var q = lastSearch;
      els.results.innerHTML = '';
      if (!q) return;
      var tracks = getTracks();
      var found = searchTracks(tracks, q);
      if (!found.length) {
        var li0 = document.createElement('li');
        li0.className = 'dj-vivo-empty';
        li0.textContent = 'Sin resultados en tu biblioteca (las canciones con dislike no se pueden pedir).';
        els.results.appendChild(li0);
        return;
      }
      found.forEach(function (t) {
        var li = document.createElement('li');
        li.className = 'dj-vivo-result';
        var main = document.createElement('span');
        main.className = 'dj-vivo-main';
        main.textContent = trackLabel(t);
        li.appendChild(main);
        [['▶ Siguiente', 'next'], ['+ Cola', 'end']].forEach(function (cfg) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'dj-vivo-req';
          b.textContent = cfg[0];
          b.setAttribute('aria-label', cfg[0] + ': ' + (t.title || ''));
          b.addEventListener('click', function () {
            var r = requestViaMenu(t, cfg[1]);
            if (r.ok) {
              say('«' + (t.title || '') + '» pedida: ' + (cfg[1] === 'next' ? 'sonará a continuación.' : 'al final de la cola.'));
              setTimeout(refresh, 120);
            } else if (r.reason === 'dislike') {
              say('«' + (t.title || '') + '» tiene dislike y no puede sonar. Quita el dislike primero.');
            } else if (r.reason === 'sin-fila') {
              say('«' + (t.title || '') + '» no está visible en la lista (filtro activo en la biblioteca). Quita el filtro y vuelve a pedirla.');
            } else {
              say('No se pudo pedir «' + (t.title || '') + '». Pídela desde el botón ⋯ de la canción en la biblioteca.');
            }
          });
          li.appendChild(b);
        });
        els.results.appendChild(li);
      });
    } catch (e) {}
  }

  function enableVivo() {
    var api = djAutoApi();
    if (api && typeof api.enable === 'function' && typeof api.isOn === 'function') {
      state.prev = null;
      state.viaDjAuto = true;
      state.on = true;
      writeStored(state);
      try { api.enable(); } catch (e) {}
      refresh();
      return;
    }
    var under = currentUnderlying();
    state.prev = { crossfade: under.crossfade, dj: under.dj };
    state.viaDjAuto = false;
    state.on = true;
    writeStored(state);
    var plan = planVivoEnable(under);
    if (plan.crossfade !== null) setUnderlying('crossfade', plan.crossfade);
    if (plan.dj !== null) setUnderlying('dj', plan.dj);
    refresh();
  }

  function disableVivo() {
    var api = djAutoApi();
    if (state.viaDjAuto && api && typeof api.disable === 'function') {
      state.on = false; state.viaDjAuto = false; state.prev = null;
      writeStored(state);
      try { api.disable(); } catch (e) {}
      refresh();
      return;
    }
    var plan = planVivoRestore(state.prev, currentUnderlying());
    state.on = false; state.viaDjAuto = false; state.prev = null;
    writeStored(state);
    if (plan.crossfade !== null) setUnderlying('crossfade', plan.crossfade);
    if (plan.dj !== null) setUnderlying('dj', plan.dj);
    refresh();
  }

  function toggleVivo() {
    if (state.on) disableVivo(); else enableVivo();
  }

  function mount() {
    var btnCf = $('btnCrossfade'), btnDj = $('btnDjToggle');
    var api = djAutoApi();
    /* Sin crossfade ni DJ ni mezcla automática en el DOM, no hay nada
       que encender: el módulo no monta nada. */
    if (!btnCf && !btnDj && !api && !$('btnDjAuto')) return false;
    if ($('djVivoPanel')) return true;
    /* Ancla: justo después del panel de mezcla automática DJ si
       existe; si no, después de la fila de "Mezclar ahora" (como
       dj.js); fallback: .player-body. */
    var anchorParent = null, anchorNext = null;
    try {
      var autoPanel = $('djAutoPanel');
      if (autoPanel && autoPanel.parentNode) {
        anchorParent = autoPanel.parentNode; anchorNext = autoPanel.nextSibling;
      } else {
        var mixNow = $('btnMixNow');
        if (mixNow && mixNow.parentElement) {
          anchorParent = mixNow.parentElement.parentNode;
          anchorNext = mixNow.parentElement.nextSibling;
        }
      }
      if (!anchorParent) {
        var body = document.querySelector('.player-body');
        if (body) { anchorParent = body; anchorNext = null; }
      }
    } catch (e) { anchorParent = null; }
    if (!anchorParent) return false;

    var panel = document.createElement('section');
    panel.id = 'djVivoPanel';
    panel.className = 'dj-panel dj-vivo-panel';
    panel.setAttribute('aria-label', 'DJ en vivo');
    panel.innerHTML =
      '<button class="toggle-pill dj-vivo-toggle" id="btnDjVivo" type="button" aria-pressed="false">' +
        '<span class="dot"></span><span data-vivo-label>🎧 DJ en vivo</span>' +
      '</button>' +
      '<p class="dj-status" id="djVivoStatus" role="status"></p>' +
      '<p class="dj-vivo-now" id="djVivoNow"></p>' +
      '<h4 class="dj-vivo-h">Viene después</h4>' +
      '<ol class="dj-vivo-queue" id="djVivoQueue"></ol>' +
      '<div class="dj-vivo-reqbox" id="djVivoReqBox">' +
        '<label class="dj-vivo-h" for="djVivoSearch">Pedir una canción</label>' +
        '<input id="djVivoSearch" type="search" placeholder="Busca por título, artista o álbum…" autocomplete="off">' +
        '<ul class="dj-vivo-results" id="djVivoResults"></ul>' +
      '</div>' +
      '<button class="btn small" id="btnDjVivoMix" type="button">Mezclar ahora</button>';

    try {
      if (anchorNext) anchorParent.insertBefore(panel, anchorNext);
      else anchorParent.appendChild(panel);
    } catch (e) { return false; }

    els = {
      toggle: $('btnDjVivo'), status: $('djVivoStatus'),
      now: $('djVivoNow'), queue: $('djVivoQueue'),
      reqBox: $('djVivoReqBox'), search: $('djVivoSearch'),
      results: $('djVivoResults'), mix: $('btnDjVivoMix')
    };
    if (!els.toggle) return false;

    els.toggle.addEventListener('click', function () { try { toggleVivo(); } catch (e) {} });
    if (els.mix) els.mix.addEventListener('click', function () {
      var real = $('btnMixNow');
      if (real) { try { real.click(); } catch (e) {} setTimeout(refresh, 120); }
    });
    if (els.search) {
      els.search.addEventListener('input', function () {
        lastSearch = els.search.value || '';
        renderSearchResults();
      });
      els.search.addEventListener('change', function () {
        lastSearch = els.search.value || '';
        renderSearchResults();
      });
    }

    /* Refrescar cuando la app cambia de canción, de cola o de estado:
       la app reescribe #queueList, #djNextText, #djStatus y #nowTitle. */
    try {
      var obs = new MutationObserver(function () { refresh(); });
      ['queueList', 'djNextText', 'djStatus', 'nowTitle', 'trackList'].forEach(function (id) {
        var n = $(id);
        if (n && obs.observe) obs.observe(n, { childList: true, characterData: true, subtree: true });
      });
    } catch (e) {}
    ['btnNext', 'btnPrev', 'btnDjToggle', 'btnCrossfade', 'btnDjAuto', 'btnMixNow', 'btnMixNow2', 'btnQueueClear'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', function () { setTimeout(refresh, 60); });
    });
    return true;
  }

  function init() {
    try {
      if (!mount()) return;
      var stored = readStored();
      var api = djAutoApi();
      var under = currentUnderlying();
      var autoOn = api && typeof api.isOn === 'function' ? api.isOn() : null;
      /* Al recargar, la app ya restauró crossfade/djMode y dj.js ya
         restauró su propio estado: si el vivo estaba encendido y la
         mezcla sigue encendida, el interruptor se muestra encendido
         SIN pulsar nada. Si ya no lo está, el vivo quedó desactivado. */
      state.on = !!(stored.on && vivoUnderlyingOn(autoOn, under));
      state.viaDjAuto = state.on ? stored.viaDjAuto : false;
      state.prev = state.on ? stored.prev : null;
      if (stored.on && !state.on) writeStored({ on: false, viaDjAuto: false, prev: null });
      refresh();
      global.__rpmDjVivo = {
        version: VERSION, refresh: refresh, enable: enableVivo,
        disable: disableVivo, toggle: toggleVivo,
        isOn: function () { return state.on; },
        request: function (trackId, mode) {
          var tracks = getTracks();
          var t = null;
          for (var i = 0; i < tracks.length; i++) {
            if (String(tracks[i].id) === String(trackId)) { t = tracks[i]; break; }
          }
          return requestViaMenu(t, mode === 'end' ? 'end' : 'next');
        },
        state: function () {
          return { on: state.on, viaDjAuto: state.viaDjAuto, prev: state.prev, underlying: currentUnderlying() };
        }
      };
    } catch (e) { /* Fallar al cargar no debe romper la app. */ }
  }

  /* Auto-inyección del CSS (mismo patrón que cast.js / dj.js): el
     <link> en index.html es lo recomendado; si falta, el JS lo añade. */
  try {
    var hasCss = false;
    try {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) {
        if ((links[i].getAttribute('href') || '').indexOf('dj-vivo.css') >= 0) { hasCss = true; break; }
      }
    } catch (e) {}
    if (!hasCss) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = './dj-vivo.css';
      (document.head || document.documentElement).appendChild(link);
    }
  } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

})(typeof window !== 'undefined' ? window : this);
