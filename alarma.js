/* Despertador para Reproductor de Música — v3.4.0, módulo aparte.
   No toca app/index.html ni ningún otro archivo de la app: se engancha
   solo por DOM y por el hook window.__rpmApp que la app ya expone.
   Si el módulo falla o no carga, la app sigue funcionando como sin él:
   todo el código va dentro de try/catch y nunca lanza errores globales.

   Qué hace (ver WIRING.md para la integración):
   - Elegir hora (input time) y qué suena: una playlist o una canción
     concreta. La lista de playlists se lee del <select id="alarmPlaylist">
     que la propia app ya rellena; la de canciones, de
     window.__rpmApp.getTracks().
   - A la hora, si la pestaña sigue abierta, reproduce lo elegido con
     fade-in de volumen: de 0 al volumen actual en ~30 s.
   - Al sonar: banner con Apagar y Posponer 10 minutos.
   - La alarma se guarda en localStorage con la clave
     'reproductor-alarma:principal' y se recuerda al reabrir; se puede
     cancelar (toggle) o borrar del todo.
   - Aviso honesto y visible: solo suena si la app/pestaña sigue abierta,
     no es una alarma del sistema.
   - Sin alarma puesta, nada cambia: no se toca el volumen, ni la cola,
     ni la canción actual.

   La app YA trae su propia «Reproducción programada» (Pack 6 + Pack 10:
   #btnAlarmOn, #alarmTime, #alarmSource, #alarmPlaylist, repetición
   diaria, sin fade-in, sin posponer, sin canción concreta). Este módulo
   NO la toca ni la desactiva: es una alarma independiente que añade
   canción concreta, fade-in y posponer. Si las dos suenan a la misma
   hora, sonarán las dos: usa una u otra.

   Por qué se reproduce por clic DOM y no llamando a la app:
   selectTrack(), playPlaylist() y play() viven dentro del IIFE cerrado
   de index.html y no están expuestos en window; lo único expuesto es
   window.__rpmApp (getTracks, toast, render...). Así que el módulo
   reproduce como lo haría el usuario: clic en la fila de la canción en
   #trackList, o clic en el chip de la playlist en #plBar + clic en
   #btnPlPlay. Si la fila no está en el DOM (búsqueda activa o más allá
   de las 80 primeras filas que renderiza la app), usa el plan B:
   audio.src = track.url + audio.play() y actualiza #nowTitle/#nowArtist
   a mano (en ese caso el currentId interno de la app no se actualiza;
   ver WIRING.md).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./alarma.css">
     <script src="./alarma.js"></script>
   Pruebas Node: node --test alarma.test.mjs
   Consola: window.__alarma.getState() / .cancel() / .snooze() / .stop() */
(function (g) {
  'use strict';

  /* ================= Núcleo puro (probable en Node) ================= */

  var STORAGE_KEY = 'reproductor-alarma:principal';
  var FADE_MS = 30000;          // fade-in: 0 -> volumen actual en 30 s
  var SNOOZE_MINUTES = 10;      // posponer: +10 min
  var CHECK_MS = 10000;         // revisión del reloj cada 10 s
  var GRACE_MS = 10 * 60 * 1000; // si la pestaña despierta hasta 10 min
                                // tarde (throttling en 2º plano), suena igual
  var VERSION = '3.4.0';

  function isObject(v) { return v !== null && typeof v === 'object'; }

  /* 'HH:MM' (24 h) -> {h, m} o null. Acepta '7:30' y lo normaliza. */
  function parseTimeHHMM(str) {
    if (typeof str !== 'string') return null;
    var m = str.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) return null;
    return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtHHMM(h, m) { return pad2(h) + ':' + pad2(m); }

  /* Clave 'YYYY-MM-DD HH:MM' en hora local: identifica un disparo. */
  function dayTimeKey(date, timeStr) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' +
      pad2(date.getDate()) + ' ' + timeStr;
  }

  /* Próximo disparo en ms (epoch) o null si no hay que sonar.
     alarm: {enabled, time:'HH:MM', repeat, snoozedUntil, lastFiredKey}
     - Sin enabled o sin hora válida -> null.
     - Si hay posposición pendiente y aún no llegó -> esa hora.
     - Si no, la próxima ocurrencia de HH:MM: hoy si falta, mañana si pasó.
     - Si ya sonó para esa ocurrencia (lastFiredKey): con repeat, mañana;
       sin repeat (una sola vez), null (ya cumplió). */
  function nextFireMs(alarm, nowMs) {
    if (!isObject(alarm) || !alarm.enabled) return null;
    var t = parseTimeHHMM(alarm.time);
    if (!t) return null;
    var now = new Date(nowMs);
    if (typeof alarm.snoozedUntil === 'number' && alarm.snoozedUntil > nowMs) {
      return alarm.snoozedUntil;
    }
    var cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      t.h, t.m, 0, 0);
    if (cand.getTime() <= nowMs) cand.setDate(cand.getDate() + 1);
    var timeStr = fmtHHMM(t.h, t.m);
    /* ¿Ya sonó la ocurrencia anterior a la candidata? (La candidata es
       mañana cuando la hora de hoy ya pasó: la que pudo sonar es la de
       hoy, no la de mañana.) Sin repetición, una sola vez ya cumplió
       -> null. Con repetición, la candidata ya es la siguiente. */
    var prev = new Date(cand);
    prev.setDate(prev.getDate() - 1);
    if (alarm.lastFiredKey === dayTimeKey(prev, timeStr)) {
      return alarm.repeat ? cand.getTime() : null;
    }
    if (alarm.lastFiredKey === dayTimeKey(cand, timeStr)) {
      if (!alarm.repeat) return null;
      cand.setDate(cand.getDate() + 1);
    }
    return cand.getTime();
  }

  /* Volumen del fade-in en un instante: rampa lineal 0 -> target.
     elapsedMs<=0 -> 0; elapsedMs>=durationMs -> target. */
  function fadeVolumeAt(elapsedMs, durationMs, target) {
    if (!(target > 0)) return 0;
    if (!(durationMs > 0)) return target;
    if (elapsedMs <= 0) return 0;
    if (elapsedMs >= durationMs) return target;
    return target * (elapsedMs / durationMs);
  }

  /* Posponer: ahora + minutos (por defecto 10). */
  function snoozeUntilMs(nowMs, minutes) {
    var min = (typeof minutes === 'number' && isFinite(minutes) && minutes > 0)
      ? minutes : SNOOZE_MINUTES;
    return nowMs + min * 60 * 1000;
  }

  /* Normaliza una alarma leída de cualquier parte (storage, consola).
     Devuelve una alarma válida o null. Campos desconocidos se descartan. */
  function sanitizeAlarm(raw) {
    if (!isObject(raw)) return null;
    var t = parseTimeHHMM(raw.time);
    if (!t) return null;
    var src = isObject(raw.source) ? raw.source : {};
    var kind = (src.kind === 'track') ? 'track' : 'playlist';
    var out = {
      version: 1,
      enabled: raw.enabled === true,
      time: fmtHHMM(t.h, t.m),
      repeat: raw.repeat === true,
      source: { kind: kind, playlistId: '', playlistName: '', trackId: '', trackTitle: '', trackArtist: '' },
      snoozedUntil: null,
      lastFiredKey: null,
      lastFiredAt: null
    };
    if (kind === 'playlist') {
      out.source.playlistId = (typeof src.playlistId === 'string') ? src.playlistId : '';
      out.source.playlistName = (typeof src.playlistName === 'string') ? src.playlistName : '';
    } else {
      out.source.trackId = (typeof src.trackId === 'string') ? src.trackId : '';
      out.source.trackTitle = (typeof src.trackTitle === 'string') ? src.trackTitle : '';
      out.source.trackArtist = (typeof src.trackArtist === 'string') ? src.trackArtist : '';
    }
    if (typeof raw.snoozedUntil === 'number' && isFinite(raw.snoozedUntil)) {
      out.snoozedUntil = raw.snoozedUntil;
    }
    if (typeof raw.lastFiredKey === 'string') out.lastFiredKey = raw.lastFiredKey;
    if (typeof raw.lastFiredAt === 'number' && isFinite(raw.lastFiredAt)) {
      out.lastFiredAt = raw.lastFiredAt;
    }
    return out;
  }

  /* ¿La alarma tiene qué sonar? Sin playlist/canción elegida no se activa. */
  function hasSource(alarm) {
    if (!isObject(alarm) || !isObject(alarm.source)) return false;
    if (alarm.source.kind === 'track') return !!alarm.source.trackId;
    return !!(alarm.source.playlistId || alarm.source.playlistName);
  }

  function describeSource(alarm) {
    if (!isObject(alarm) || !isObject(alarm.source)) return 'nada elegido';
    if (alarm.source.kind === 'track') {
      var t = alarm.source.trackTitle || 'una canción';
      return 'la canción «' + t + '»' +
        (alarm.source.trackArtist ? ' de ' + alarm.source.trackArtist : '');
    }
    return 'la playlist «' + (alarm.source.playlistName || 'elegida') + '»';
  }

  /* Texto de estado para el panel. nowMs inyectable para probar. */
  function statusText(alarm, nowMs) {
    if (!isObject(alarm) || !alarm.enabled) {
      if (isObject(alarm) && alarm.lastFiredAt) {
        var d = new Date(alarm.lastFiredAt);
        return 'Sonó hoy a las ' + fmtHHMM(d.getHours(), d.getMinutes()) +
          '. Sin alarma activa: elige hora y qué suena, y pulsa Activar.';
      }
      return 'Sin alarma. Elige la hora y qué quieres que suene.';
    }
    var next = nextFireMs(alarm, nowMs);
    if (next === null) return 'Sin alarma. Elige la hora y qué quieres que suene.';
    var nd = new Date(next);
    var today = new Date(nowMs);
    var when = (nd.toDateString() === today.toDateString()) ? 'hoy' : 'mañana';
    var snoozed = (typeof alarm.snoozedUntil === 'number' && alarm.snoozedUntil > nowMs)
      ? ' (pospuesta)' : '';
    return 'Sonará ' + when + ' a las ' + fmtHHMM(nd.getHours(), nd.getMinutes()) +
      snoozed + ': ' + describeSource(alarm) +
      (alarm.repeat ? '. Se repite cada día.' : '. Solo una vez.');
  }

  /* Persistencia con un store {getItem,setItem,removeItem} (localStorage
     en el navegador, un doble en los tests). Nunca lanza. */
  function loadAlarm(store) {
    try {
      var raw = store.getItem(STORAGE_KEY);
      if (!raw) return null;
      return sanitizeAlarm(JSON.parse(raw));
    } catch (e) { return null; }
  }

  function saveAlarm(store, alarm) {
    try {
      var clean = sanitizeAlarm(alarm);
      if (!clean) return false;
      store.setItem(STORAGE_KEY, JSON.stringify(clean));
      return true;
    } catch (e) { return false; }
  }

  function deleteAlarm(store) {
    try { store.removeItem(STORAGE_KEY); return true; } catch (e) { return false; }
  }

  /* ================= Capa navegador (solo con document) ================= */

  var state = { alarm: null, fadeTimer: null, fadeStart: 0, fadeTarget: 0, ringing: false };
  var els = {};
  var store = null; // localStorage real, si existe

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { /* nunca romper la app */ }
    };
  }

  function toast(msg) {
    try {
      if (g.__rpmApp && typeof g.__rpmApp.toast === 'function') { g.__rpmApp.toast(msg); return; }
    } catch (e) {}
  }

  function audioEl() { return $('audio'); }

  /* Volumen objetivo del fade-in: el del deslizador #volume de la app
     (0-100). Si el usuario lo tiene a 0 / silenciado, la alarma usaría
     0 y no se oiría: en ese caso sube al 70% solo durante la alarma
     (settings.volume de la app NO se toca; al apagar se restaura). */
  function targetVolume() {
    var v = null;
    try {
      var slider = $('volume');
      if (slider && slider.value !== undefined && slider.value !== '') {
        v = parseFloat(slider.value) / 100;
      }
    } catch (e) {}
    if (v === null || !isFinite(v)) {
      try { var a = audioEl(); if (a) v = a.volume; } catch (e) {}
    }
    if (v === null || !isFinite(v) || v <= 0) return 0.7;
    return Math.min(1, v);
  }

  /* --- Lectura de lo que ya existe en la app (sin inventar nada) --- */

  /* Playlists: del <select id="alarmPlaylist"> que la propia app ya
     rellena con sus playlists (value = id, texto = nombre). Plan B:
     los chips de #plBar (solo nombre, sin id: se reproduce por nombre). */
  function readPlaylists() {
    var out = [];
    try {
      var sel = $('alarmPlaylist');
      if (sel && sel.options) {
        for (var i = 0; i < sel.options.length; i++) {
          var o = sel.options[i];
          if (o.value) out.push({ id: o.value, name: (o.textContent || '').trim() });
        }
        if (out.length) return out;
      }
      var bar = $('plBar');
      if (bar) {
        var chips = bar.querySelectorAll('.chip');
        for (var j = 0; j < chips.length; j++) {
          var name = (chips[j].textContent || '').replace(/^📌\s*/, '')
            .replace(/\(\d+\)\s*$/, '').trim();
          if (name && name !== '+ Nueva playlist') out.push({ id: '', name: name });
        }
      }
    } catch (e) {}
    return out;
  }

  /* Canciones: de window.__rpmApp.getTracks() (expuesto por la app).
     Plan B: las filas visibles de #trackList. Sin dislike, por título. */
  function readTracks() {
    var out = [];
    try {
      if (g.__rpmApp && typeof g.__rpmApp.getTracks === 'function') {
        var tracks = g.__rpmApp.getTracks() || [];
        tracks.forEach(function (t) {
          if (t && t.id && t.rating !== 'dislike') {
            out.push({ id: t.id, title: t.title || t.name || 'Sin título',
              artist: t.artist || '', url: t.url || '' });
          }
        });
        if (out.length) {
          out.sort(function (a, b) {
            return (a.title + ' ' + a.artist).localeCompare(b.title + ' ' + b.artist, 'es');
          });
          return out;
        }
      }
      var rows = document.querySelectorAll('#trackList li[data-track-id]');
      for (var i = 0; i < rows.length; i++) {
        var titleEl = rows[i].querySelector('.track-title');
        out.push({ id: rows[i].getAttribute('data-track-id'),
          title: titleEl ? titleEl.textContent.trim() : 'Sin título',
          artist: '', url: '' });
      }
    } catch (e) {}
    return out;
  }

  function fillSelect(sel, items, placeholder, valueKey, labelFn) {
    if (!sel) return;
    try {
      var cur = sel.value;
      sel.innerHTML = '';
      var o0 = document.createElement('option');
      o0.value = ''; o0.textContent = placeholder;
      sel.appendChild(o0);
      items.forEach(function (it) {
        var o = document.createElement('option');
        o.value = it[valueKey];
        o.textContent = labelFn(it);
        sel.appendChild(o);
      });
      sel.value = cur || '';
    } catch (e) {}
  }

  function refreshSourceLists() {
    try {
      fillSelect(els.playlistSel, readPlaylists(), 'Elige playlist…', 'id',
        function (p) { return p.name; });
      fillSelect(els.trackSel, readTracks(), 'Elige canción…', 'id',
        function (t) { return t.title + (t.artist ? ' — ' + t.artist : ''); });
      if (state.alarm) {
        if (state.alarm.source.kind === 'playlist' && state.alarm.source.playlistId) {
          els.playlistSel.value = state.alarm.source.playlistId;
        }
        if (state.alarm.source.kind === 'track' && state.alarm.source.trackId) {
          els.trackSel.value = state.alarm.source.trackId;
        }
      }
    } catch (e) {}
  }

  /* --- Reproducción por DOM (la app no expone selectTrack/play) --- */

  function showView(name) {
    try {
      var tab = document.querySelector('.view-tab[data-view="' + name + '"]');
      if (tab) tab.click();
    } catch (e) {}
  }

  function clickTrackRow(trackId) {
    try {
      var row = document.querySelector('#trackList li[data-track-id="' +
        trackId.replace(/"/g, '') + '"]');
      if (row) { row.click(); return true; }
    } catch (e) {}
    return false;
  }

  /* Plan B si la fila no está en el DOM: audio directo con la URL blob
     que la propia app guarda en el track. Actualiza #nowTitle/#nowArtist
     a mano; el currentId interno de la app no se actualiza en este caso. */
  function playTrackDirect(track) {
    try {
      var a = audioEl();
      if (!a || !track || !track.url) return false;
      a.src = track.url;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
      var nt = $('nowTitle'); if (nt) nt.textContent = track.title || 'Sin título';
      var na = $('nowArtist'); if (na) na.textContent = track.artist || '';
      return true;
    } catch (e) { return false; }
  }

  function playChosenTrack(trackId) {
    showView('library');
    if (clickTrackRow(trackId)) return 'row';
    var found = null;
    try {
      (readTracks() || []).forEach(function (t) { if (t.id === trackId) found = t; });
      if (!found && g.__rpmApp && typeof g.__rpmApp.getTracks === 'function') {
        (g.__rpmApp.getTracks() || []).forEach(function (t) {
          if (t && t.id === trackId) found = { id: t.id, title: t.title || t.name || '',
            artist: t.artist || '', url: t.url || '' };
        });
      }
    } catch (e) {}
    if (found && playTrackDirect(found)) return 'direct';
    return null;
  }

  function playChosenPlaylist(pl) {
    showView('playlists');
    var clicked = false;
    try {
      var chips = document.querySelectorAll('#plBar .chip');
      for (var i = 0; i < chips.length; i++) {
        var name = (chips[i].textContent || '').replace(/^📌\s*/, '')
          .replace(/\(\d+\)\s*$/, '').trim();
        if (name && name === pl.name) { chips[i].click(); clicked = true; break; }
      }
    } catch (e) {}
    /* #btnPlPlay es estático en index.html (no lo reconstruye renderPack),
       así que vale aunque la vista acabe de cambiar. Pequeña espera para
       que el clic en el chip actualice selectedPlaylistId. */
    setTimeout(safe(function () {
      try {
        var btn = $('btnPlPlay');
        if (btn) btn.click();
      } catch (e) {}
    }), 250);
    return clicked;
  }

  function playFirstPlayable() {
    try {
      var rows = document.querySelectorAll('#trackList li[data-track-id]:not(.disliked)');
      if (rows.length) { rows[0].click(); return true; }
      var tracks = readTracks();
      if (tracks.length && tracks[0].url) return playTrackDirect(tracks[0]);
    } catch (e) {}
    return false;
  }

  /* --- Fade-in --- */

  function stopFade(restoreTo) {
    try {
      if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
      var a = audioEl();
      if (a && typeof restoreTo === 'number' && isFinite(restoreTo)) {
        a.volume = Math.max(0, Math.min(1, restoreTo));
      }
    } catch (e) {}
  }

  function startFadeIn() {
    try {
      stopFade();
      var a = audioEl();
      if (!a) return;
      state.fadeTarget = targetVolume();
      state.fadeStart = Date.now();
      a.volume = 0;
      state.fadeTimer = setInterval(safe(function () {
        try {
          var au = audioEl();
          if (!au || au.paused || !state.ringing) { stopFade(); return; }
          var v = fadeVolumeAt(Date.now() - state.fadeStart, FADE_MS, state.fadeTarget);
          au.volume = v;
          if (v >= state.fadeTarget) stopFade();
        } catch (e) { stopFade(); }
      }), 500);
      /* Si el usuario mueve el volumen o pausa a mano, el fade-in se
         cancela: manda el usuario, no la alarma. */
      var slider = $('volume');
      if (slider && !slider.__alarmaWired) {
        slider.__alarmaWired = true;
        slider.addEventListener('input', safe(function () { stopFade(); }));
      }
      /* Un solo listener de pausa por elemento <audio>: si el usuario
         pausa a mano durante el fade-in, el volumen vuelve a su nivel. */
      if (!a.__alarmaPauseWired) {
        a.__alarmaPauseWired = true;
        a.addEventListener('pause', safe(function () { stopFade(state.fadeTarget); }));
      }
    } catch (e) {}
  }

  /* --- Banner de "está sonando" --- */

  function showRing(whatText, playFailed) {
    try {
      if (!els.ring) return;
      state.ringing = true;
      els.ringWhat.textContent = whatText;
      els.ring.hidden = false;
      els.ring.style.display = '';
      els.playNow.style.display = playFailed ? '' : 'none';
      if (els.ringTime) els.ringTime.textContent = 'Sonando desde las ' +
        fmtHHMM(new Date().getHours(), new Date().getMinutes());
    } catch (e) {}
  }

  function hideRing() {
    try {
      state.ringing = false;
      if (els.ring) { els.ring.hidden = true; els.ring.style.display = 'none'; }
    } catch (e) {}
  }

  function stopRinging(pauseAudio) {
    try {
      stopFade(state.fadeTarget || undefined);
      if (pauseAudio) { var a = audioEl(); if (a) { try { a.pause(); } catch (e) {} } }
      hideRing();
    } catch (e) {}
  }

  /* --- Disparo --- */

  function fire(alarm, fireKey) {
    try {
      var src = alarm.source;
      var what = describeSource(alarm);
      var started = null;
      if (src.kind === 'track') {
        started = playChosenTrack(src.trackId);
        if (!started) {
          showRing('No se encontró «' + (src.trackTitle || 'la canción') +
            '» en la biblioteca. No suena nada.', false);
          toast('⏰ Despertador: no se encontró la canción elegida.');
        }
      } else {
        var ok = playChosenPlaylist({ id: src.playlistId, name: src.playlistName });
        if (!ok) {
          /* La playlist ya no existe: suena la primera canción
             reproducible antes que dejar la alarma en silencio. */
          if (playFirstPlayable()) {
            showRing('La playlist «' + (src.playlistName || 'elegida') +
              '» ya no existe: suena tu biblioteca.', false);
            toast('⏰ Despertador: la playlist ya no existe, suena tu biblioteca.');
          } else {
            showRing('La playlist «' + (src.playlistName || 'elegida') +
              '» ya no existe y no hay canciones. No suena nada.', false);
            toast('⏰ Despertador: no hay nada que sonar.');
          }
          started = 'fallback';
        } else {
          started = 'playlist';
        }
      }
      if (started && started !== 'fallback') {
        /* El clic en la fila / en #btnPlPlay arranca la reproducción
           dentro de la app; el fade-in se aplica sobre <audio>. */
        setTimeout(safe(function () {
          try {
            var a = audioEl();
            if (a && a.paused) {
              var p = a.play();
              if (p && p.catch) {
                p.catch(function () {
                  showRing(what + ' — el navegador bloqueó el sonido. Pulsa «Tocar ahora».', true);
                });
              }
            }
            showRing('⏰ ¡Despertador! Sonando ' + what + ' (volumen subiendo poco a poco).', false);
            startFadeIn();
          } catch (e) {}
        }), 400);
      } else if (started === 'fallback') {
        setTimeout(safe(function () { startFadeIn(); }), 400);
      }
      /* Una sola vez: al sonar se desactiva sola (no vuelve mañana).
         Con repetición, sigue activa para mañana. */
      var next = {
        version: 1, enabled: alarm.repeat === true, time: alarm.time,
        repeat: alarm.repeat === true, source: alarm.source,
        snoozedUntil: null, lastFiredKey: fireKey, lastFiredAt: Date.now()
      };
      state.alarm = sanitizeAlarm(next);
      if (store) saveAlarm(store, state.alarm);
      refreshStatus();
      syncPanel();
    } catch (e) {}
  }

  function checkFire() {
    try {
      if (!state.alarm || !state.alarm.enabled || state.ringing) return;
      var nowMs = Date.now();
      var next = nextFireMs(state.alarm, nowMs);
      if (next === null) return;
      if (nowMs >= next && nowMs - next <= GRACE_MS) {
        var key = (typeof state.alarm.snoozedUntil === 'number' &&
          state.alarm.snoozedUntil > nowMs && state.alarm.snoozedUntil === next)
          ? 's:' + next
          : 't:' + dayTimeKey(new Date(next), state.alarm.time);
        if (state.alarm.lastFiredKey === key) return;
        fire(state.alarm, key);
      }
    } catch (e) {}
  }

  /* --- UI del panel --- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function buildPanel() {
    try {
      var host = $('soundBody');
      var panel = el('div', 'sound-group rpm-alarma');
      panel.id = 'rpmAlarmaPanel';
      var head = el('div', 'sound-group-head');
      head.appendChild(el('h4', null, '⏰ Despertador'));
      var ver = el('span', 'rpm-alarma-ver', 'módulo v' + VERSION);
      head.appendChild(ver);
      panel.appendChild(head);

      var row1 = el('div', 'sound-inline');
      var onBtn = el('button', 'toggle-pill', null);
      onBtn.id = 'rpmAlarmaOn'; onBtn.type = 'button';
      onBtn.setAttribute('aria-pressed', 'false');
      onBtn.appendChild(el('span', 'dot'));
      onBtn.appendChild(el('span', null, 'Desactivada'));
      els.onBtn = onBtn; els.onLabel = onBtn.querySelector('span:last-child');
      row1.appendChild(onBtn);
      var time = el('input');
      time.id = 'rpmAlarmaTime'; time.type = 'time'; time.value = '07:30';
      time.setAttribute('aria-label', 'Hora del despertador');
      els.time = time;
      row1.appendChild(time);
      var kind = el('select', 'speed-select');
      kind.id = 'rpmAlarmaKind'; kind.setAttribute('aria-label', 'Qué suena: playlist o canción');
      [['playlist', 'Una playlist'], ['track', 'Una canción']].forEach(function (kv) {
        var o = el('option', null, kv[1]); o.value = kv[0]; kind.appendChild(o);
      });
      els.kind = kind;
      row1.appendChild(kind);
      panel.appendChild(row1);

      var row2 = el('div', 'sound-inline');
      row2.style.marginTop = '10px';
      var plSel = el('select', 'speed-select');
      plSel.id = 'rpmAlarmaPlaylist'; plSel.setAttribute('aria-label', 'Playlist del despertador');
      els.playlistSel = plSel;
      row2.appendChild(plSel);
      var trSel = el('select', 'speed-select');
      trSel.id = 'rpmAlarmaTrack'; trSel.setAttribute('aria-label', 'Canción del despertador');
      trSel.style.display = 'none';
      els.trackSel = trSel;
      row2.appendChild(trSel);
      var repLabel = el('label', 'rpm-alarma-repeat');
      var rep = el('input');
      rep.id = 'rpmAlarmaRepeat'; rep.type = 'checkbox';
      repLabel.appendChild(rep);
      repLabel.appendChild(document.createTextNode(' Repetir cada día'));
      els.repeat = rep;
      row2.appendChild(repLabel);
      panel.appendChild(row2);

      var row3 = el('div', 'sound-inline');
      row3.style.marginTop = '10px';
      var del = el('button', 'btn small danger', 'Borrar alarma');
      del.id = 'rpmAlarmaDelete'; del.type = 'button';
      els.deleteBtn = del;
      row3.appendChild(del);
      panel.appendChild(row3);

      var st = el('p', 'sound-note', '');
      st.id = 'rpmAlarmaStatus'; st.setAttribute('role', 'status');
      els.status = st;
      panel.appendChild(st);

      var warn = el('p', 'sound-note rpm-alarma-warn');
      warn.innerHTML = '<strong>Importante:</strong> esto es una página web, ' +
        'no una alarma del sistema: solo suena <strong>con la app abierta</strong> ' +
        'en esta pestaña. Si cierras la app, apagas el dispositivo o el ' +
        'navegador duerme la pestaña, la música no sonará a esa hora. ' +
        'Además, el navegador puede bloquear el sonido hasta que hayas ' +
        'tocado la app al menos una vez: si eso pasa, verás el botón ' +
        '«Tocar ahora» cuando suene. La alarma se guarda solo en este dispositivo.';
      panel.appendChild(warn);

      var note = el('p', 'sound-note');
      note.textContent = 'La app ya trae su propia «Reproducción programada» justo arriba ' +
        '(playlist, cola o seguir donde ibas, cada día). Este módulo añade: canción ' +
        'concreta, volumen que sube poco a poco y posponer 10 minutos. Si las dos ' +
        'suenan a la misma hora, sonarán las dos: usa una u otra.';
      panel.appendChild(note);

      if (host) host.appendChild(panel);
      else {
        /* Sin #soundBody (versión distinta de la app): panel propio
           antes de la biblioteca, visible igualmente. */
        panel.classList.add('rpm-alarma-standalone');
        var lib = document.querySelector('.library');
        if (lib && lib.parentNode) lib.parentNode.insertBefore(panel, lib);
        else document.body.appendChild(panel);
      }
      return panel;
    } catch (e) { return null; }
  }

  function buildRing() {
    try {
      var ring = el('div', 'rpm-alarma-ring');
      ring.id = 'rpmAlarmaRing';
      ring.setAttribute('role', 'alertdialog');
      ring.setAttribute('aria-live', 'assertive');
      ring.setAttribute('aria-label', 'Despertador sonando');
      ring.hidden = true; ring.style.display = 'none';
      ring.appendChild(el('div', 'rpm-alarma-ring-title', '⏰ ¡Despertador!'));
      var what = el('div', 'rpm-alarma-ring-what', '');
      what.id = 'rpmAlarmaRingWhat';
      ring.appendChild(what);
      var tm = el('div', 'rpm-alarma-ring-time', '');
      tm.id = 'rpmAlarmaRingTime';
      ring.appendChild(tm);
      var btns = el('div', 'rpm-alarma-ring-btns');
      var stop = el('button', 'btn primary', 'Apagar');
      stop.id = 'rpmAlarmaStop'; stop.type = 'button';
      els.stopBtn = stop;
      btns.appendChild(stop);
      var snooze = el('button', 'btn', 'Posponer 10 min');
      snooze.id = 'rpmAlarmaSnooze'; snooze.type = 'button';
      els.snoozeBtn = snooze;
      btns.appendChild(snooze);
      var now = el('button', 'btn small', '▶ Tocar ahora');
      now.id = 'rpmAlarmaPlayNow'; now.type = 'button';
      now.style.display = 'none';
      els.playNow = now;
      btns.appendChild(now);
      ring.appendChild(btns);
      els.ring = ring; els.ringWhat = what; els.ringTime = tm;
      document.body.appendChild(ring);
    } catch (e) {}
  }

  function refreshStatus() {
    try {
      if (els.status) {
        els.status.textContent = statusText(state.alarm, Date.now());
      }
    } catch (e) {}
  }

  function syncPanel() {
    try {
      var a = state.alarm;
      if (els.onBtn) {
        els.onBtn.classList.toggle('on', !!(a && a.enabled));
        els.onBtn.setAttribute('aria-pressed', (a && a.enabled) ? 'true' : 'false');
        if (els.onLabel) els.onLabel.textContent = (a && a.enabled) ? 'Activada' : 'Desactivada';
      }
      if (a) {
        if (els.time && document.activeElement !== els.time) els.time.value = a.time || '07:30';
        if (els.kind) els.kind.value = a.source.kind || 'playlist';
        if (els.repeat) els.repeat.checked = !!a.repeat;
        if (els.playlistSel) els.playlistSel.style.display = a.source.kind === 'track' ? 'none' : '';
        if (els.trackSel) els.trackSel.style.display = a.source.kind === 'track' ? '' : 'none';
        if (els.deleteBtn) els.deleteBtn.style.display = '';
      }
      refreshStatus();
    } catch (e) {}
  }

  function readFormIntoAlarm() {
    var time = els.time ? els.time.value : '';
    var kind = els.kind ? els.kind.value : 'playlist';
    var src = { kind: kind, playlistId: '', playlistName: '', trackId: '', trackTitle: '', trackArtist: '' };
    if (kind === 'track') {
      var t = null;
      try {
        (readTracks() || []).forEach(function (x) { if (x.id === els.trackSel.value) t = x; });
      } catch (e) {}
      src.trackId = els.trackSel ? els.trackSel.value : '';
      if (t) { src.trackTitle = t.title; src.trackArtist = t.artist; }
    } else {
      var p = null;
      try {
        (readPlaylists() || []).forEach(function (x) { if (x.id === els.playlistSel.value) p = x; });
      } catch (e) {}
      src.playlistId = els.playlistSel ? els.playlistSel.value : '';
      if (p) src.playlistName = p.name;
      else if (src.playlistId === '' && els.playlistSel && els.playlistSel.selectedOptions &&
        els.playlistSel.selectedOptions[0]) {
        src.playlistName = els.playlistSel.selectedOptions[0].textContent.trim();
      }
    }
    return sanitizeAlarm({
      version: 1,
      enabled: !!(state.alarm && state.alarm.enabled),
      time: time, repeat: els.repeat ? els.repeat.checked : false,
      source: src,
      snoozedUntil: (state.alarm && state.alarm.snoozedUntil) || null,
      lastFiredKey: (state.alarm && state.alarm.lastFiredKey) || null,
      lastFiredAt: (state.alarm && state.alarm.lastFiredAt) || null
    });
  }

  function persist() {
    try { if (store && state.alarm) saveAlarm(store, state.alarm); } catch (e) {}
  }

  function wireEvents() {
    try {
      els.onBtn.addEventListener('click', safe(function () {
        var cur = state.alarm;
        if (cur && cur.enabled) {
          /* Apagar la alarma programada (no la que está sonando: para
             eso está el botón Apagar del banner). */
          state.alarm = sanitizeAlarm({
            version: 1, enabled: false, time: cur.time, repeat: cur.repeat,
            source: cur.source, snoozedUntil: null,
            lastFiredKey: cur.lastFiredKey, lastFiredAt: cur.lastFiredAt
          });
          persist(); syncPanel();
          toast('⏰ Despertador desactivado.');
          return;
        }
        var next = readFormIntoAlarm();
        if (!next) { toast('Elige una hora válida (HH:MM).'); return; }
        if (!hasSource(next)) {
          toast(next.source.kind === 'track'
            ? 'Elige primero la canción que quieres que suene.'
            : 'Elige primero la playlist que quieres que suene.');
          return;
        }
        next.enabled = true;
        next.snoozedUntil = null;
        next.lastFiredKey = null;
        state.alarm = next;
        persist(); syncPanel();
        toast('⏰ Despertador activado: ' + statusText(state.alarm, Date.now()));
      }));

      els.time.addEventListener('change', safe(function () {
        if (!state.alarm) {
          state.alarm = sanitizeAlarm({ version: 1, enabled: false,
            time: els.time.value, repeat: els.repeat.checked,
            source: { kind: els.kind.value } });
          if (!state.alarm) return;
        } else {
          var t = parseTimeHHMM(els.time.value);
          if (!t) return;
          state.alarm.time = fmtHHMM(t.h, t.m);
          state.alarm.lastFiredKey = null;
          state.alarm.snoozedUntil = null;
        }
        persist(); syncPanel();
      }));

      els.kind.addEventListener('change', safe(function () {
        if (!state.alarm) {
          state.alarm = sanitizeAlarm({ version: 1, enabled: false,
            time: els.time.value, repeat: els.repeat.checked,
            source: { kind: els.kind.value } });
        } else {
          state.alarm.source = { kind: els.kind.value, playlistId: '',
            playlistName: '', trackId: '', trackTitle: '', trackArtist: '' };
          state.alarm.lastFiredKey = null;
        }
        persist(); refreshSourceLists(); syncPanel();
      }));

      els.playlistSel.addEventListener('change', safe(function () {
        if (!state.alarm) return;
        var p = null;
        (readPlaylists() || []).forEach(function (x) { if (x.id === els.playlistSel.value) p = x; });
        state.alarm.source.playlistId = els.playlistSel.value;
        state.alarm.source.playlistName = p ? p.name : '';
        state.alarm.lastFiredKey = null;
        persist(); syncPanel();
      }));

      els.trackSel.addEventListener('change', safe(function () {
        if (!state.alarm) return;
        var t = null;
        (readTracks() || []).forEach(function (x) { if (x.id === els.trackSel.value) t = x; });
        state.alarm.source.trackId = els.trackSel.value;
        state.alarm.source.trackTitle = t ? t.title : '';
        state.alarm.source.trackArtist = t ? t.artist : '';
        state.alarm.lastFiredKey = null;
        persist(); syncPanel();
      }));

      els.repeat.addEventListener('change', safe(function () {
        if (!state.alarm) return;
        state.alarm.repeat = els.repeat.checked;
        persist(); syncPanel();
      }));

      els.deleteBtn.addEventListener('click', safe(function () {
        stopRinging(true);
        state.alarm = null;
        if (store) deleteAlarm(store);
        if (els.time) els.time.value = '07:30';
        if (els.kind) els.kind.value = 'playlist';
        if (els.repeat) els.repeat.checked = false;
        refreshSourceLists(); syncPanel();
        toast('⏰ Despertador borrado.');
      }));

      els.stopBtn.addEventListener('click', safe(function () {
        stopRinging(true);
        refreshStatus(); syncPanel();
        toast('⏰ Despertador apagado.');
      }));

      els.snoozeBtn.addEventListener('click', safe(function () {
        stopRinging(true);
        if (state.alarm) {
          state.alarm.snoozedUntil = snoozeUntilMs(Date.now(), SNOOZE_MINUTES);
          /* La posposición es un disparo aparte: no debe quedar marcada
             como ya sonada. */
          state.alarm.lastFiredKey = null;
          persist();
        }
        refreshStatus(); syncPanel();
        toast('⏰ Pospuesta 10 minutos.');
      }));

      els.playNow.addEventListener('click', safe(function () {
        try {
          var a = audioEl();
          if (a) {
            var p = a.play();
            if (p && p.catch) p.catch(function () {});
            if (!a.paused) {
              els.playNow.style.display = 'none';
              startFadeIn();
            }
          }
        } catch (e) {}
      }));

      [els.playlistSel, els.trackSel].forEach(function (s) {
        if (s) s.addEventListener('focus', safe(refreshSourceLists));
      });
      document.addEventListener('visibilitychange', safe(function () {
        if (document.visibilityState === 'visible') {
          refreshSourceLists();
          refreshStatus();
          checkFire();
        }
      }));
    } catch (e) {}
  }

  function init() {
    try {
      try { store = g.localStorage || null; } catch (e) { store = null; }
      if (store) state.alarm = loadAlarm(store);
      buildPanel();
      buildRing();
      wireEvents();
      refreshSourceLists();
      /* La app rellena #alarmPlaylist y expone __rpmApp al cargar su
         biblioteca: reintentar el llenado por si este script corrió antes. */
      setTimeout(safe(refreshSourceLists), 800);
      setTimeout(safe(refreshSourceLists), 2500);
      syncPanel();
      setInterval(safe(checkFire), CHECK_MS);
      setInterval(safe(refreshStatus), 60000);
      checkFire();
    } catch (e) { /* sin despertador: la app sigue igual */ }
  }

  /* Solo navegador: sin document no hay nada que montar (Node). */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else init();
    } catch (e) { /* sin UI: la app sigue igual */ }
  }

  /* ================= Exportaciones ================= */
  var api = {
    parseTimeHHMM: parseTimeHHMM,
    nextFireMs: nextFireMs,
    fadeVolumeAt: fadeVolumeAt,
    snoozeUntilMs: snoozeUntilMs,
    sanitizeAlarm: sanitizeAlarm,
    hasSource: hasSource,
    describeSource: describeSource,
    statusText: statusText,
    loadAlarm: loadAlarm,
    saveAlarm: saveAlarm,
    deleteAlarm: deleteAlarm,
    fmtHHMM: fmtHHMM,
    STORAGE_KEY: STORAGE_KEY,
    FADE_MS: FADE_MS,
    SNOOZE_MINUTES: SNOOZE_MINUTES,
    CHECK_MS: CHECK_MS,
    GRACE_MS: GRACE_MS,
    VERSION: VERSION
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    try {
      window.__alarma = {
        version: VERSION,
        getState: function () {
          try { return state.alarm ? JSON.parse(JSON.stringify(state.alarm)) : null; } catch (e) { return null; }
        },
        cancel: function () {
          try {
            if (state.alarm) {
              state.alarm.enabled = false;
              state.alarm.snoozedUntil = null;
              persist(); syncPanel();
            }
            stopRinging(true);
            return true;
          } catch (e) { return false; }
        },
        snooze: function () {
          try { if (els.snoozeBtn) els.snoozeBtn.click(); return true; } catch (e) { return false; }
        },
        stop: function () {
          try { if (els.stopBtn) els.stopBtn.click(); return true; } catch (e) { return false; }
        }
      };
    } catch (e) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
