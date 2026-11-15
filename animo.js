/* Playlist por estado de ánimo (v3.9.0), módulo aparte.
   No toca la lógica de app/index.html: se engancha por DOM y por el
   hook window.__rpmApp que la app ya expone (getTracks, getPackState,
   applyPackState, toast, render). Si el módulo falla o no carga, la
   app sigue funcionando como en 3.8.0.

   HECHO VERIFICADO EN app/index.html (3.8.0, NO duplicar):
   - Cada pista ya trae datos de análisis: track.bpm (null si no hay),
     track.energy 0-1 (null si no hay), track.brightness 0-1,
     track.mood ('fiesta' | 'relajado' | 'energia' | 'concentracion'
     | null) y track.musicalKey Camelot ("8A", "8B"...) con track.keyName.
     El análisis lo hace analyzeAudioFeatures() y moodFromFeatures()
     (líneas ~10533-10560): fiesta = BPM >= 115 y energy >= 0.60;
     relajado = BPM <= 95 y energy <= 0.42; concentracion = energy
     0.28-0.55 y BPM 70-112; energia = BPM >= 100 o energy >= 0.60.
     En Camelot la letra A = tonalidad menor, B = tonalidad mayor.
   - Playlists normales: {id, name, trackIds:[], updatedAt} creadas
     por createPlaylist(name, addTrackId) (línea ~3777): id =
     'p'+Date.now().toString(36)+random, y se guardan en
     packState.playlists vía saveState() (IndexedDB 'packState').
     createPlaylist es interna del IIFE, así que este módulo guarda
     por la vía pública que ya usan sync-bridge y export-m3u:
     __rpmApp.getPackState() -> añadir la playlist con EL MISMO
     formato -> __rpmApp.applyPackState(st) (que repone playlists en
     memoria, hace saveState() y render()). La playlist resultante es
     una playlist NORMAL: se ve en la vista Playlists, se reproduce,
     se renombra, se borra y viaja en el .rpmbak como cualquier otra.
   - La vista Ambientes ya existe (#viewMoods, #moodGrid, pestaña
     .view-tab[data-view="moods"], línea ~1347 y ~1590): este módulo
     añade su panel JUSTO DESPUÉS de #moodGrid (nunca dentro: la app
     reescribe #moodGrid.innerHTML en renderMoods() y borraría el
     panel) y un botón lanzador #btnAnimo junto a #btnWrapped.
   - Las canciones con dislike no suenan en las playlists (la app las
     excluye de la rotación): este módulo NO las mete en la lista.

   REGLAS DE CADA ÁNIMO (puntuación 0-100, pesos suman 100; ver
   scoreTrack; cada componente es una banda 0-1 alrededor de un
   centro, salvo la energía de "energía" que es una rampa):
   - feliz:   tonalidad mayor +30 · energy ~0.70 +30 · brightness
              ~0.65 +20 · BPM ~120 +12 · mood 'fiesta' +8.
   - triste:  tonalidad menor +30 · energy ~0.20 +30 · BPM ~75 +15 ·
              brightness ~0.25 +15 · mood 'relajado' +10.
   - energía: energy alta (rampa desde 0.45) +40 · BPM ~130 +30 ·
              brightness ~0.70 +15 · mood 'energia'/'fiesta' +10 ·
              tonalidad mayor +5.
   - relax:   energy ~0.20 +35 · BPM ~80 +25 · brightness ~0.35 +15 ·
              mood 'relajado' +15 · tonalidad menor +10.
   - enfoque: energy ~0.40 (banda estrecha: penaliza los extremos)
              +35 · BPM ~90 +30 · brightness ~0.45 +15 · mood
              'concentracion' +15 · tonalidad indiferente +5.
   Sin BPM la componente de BPM vale la mitad de su peso (el resto de
   datos sigue puntuando); sin tonalidad, la componente de tonalidad
   vale ~la mitad. Sin energy NO se puntúa: la pista no está
   analizada y no entra en ninguna lista (nunca se inventan datos).
   Umbral mínimo razonable: 45 puntos; máximo 25 canciones por lista.

   FAIL-SAFE: todo el DOM va con guards y try/catch. Sin __rpmApp,
   sin #moodGrid o sin datos de análisis, el panel lo dice y no
   genera nada inventado. */
(function (global) {
  'use strict';

  var VERSION = '3.9.0';
  var MIN_SCORE = 45;   /* mínimo razonable para entrar en la lista */
  var MAX_TRACKS = 25;  /* tope de canciones por playlist generada */

  var MOODS = [
    { id: 'feliz',   label: 'Feliz',   emoji: '😊', desc: 'Alegre y luminosa: tonalidad mayor, energía media-alta y brillo alto.' },
    { id: 'triste',  label: 'Triste',  emoji: '😢', desc: 'Melancólica y suave: tonalidad menor, energía baja y ritmo lento.' },
    { id: 'energia', label: 'Energía', emoji: '⚡', desc: 'Para moverte: energía alta y BPM alto, sin freno.' },
    { id: 'relax',   label: 'Relax',   emoji: '😌', desc: 'Tranquila: energía baja, ritmo lento y brillo suave.' },
    { id: 'enfoque', label: 'Enfoque', emoji: '🎯', desc: 'Fondo para concentrarte: energía media y BPM medio y estable.' }
  ];

  /* ================= Partes puras (probadas en Node) ================= */

  function moodById(id) {
    for (var i = 0; i < MOODS.length; i++) {
      if (MOODS[i].id === id) return MOODS[i];
    }
    return null;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function clamp01(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  /* Banda 0-1 alrededor de un centro: 1 en el centro, 0 a `width` o
     más de distancia. Devuelve null si el valor no es un número. */
  function band(v, center, width) {
    var n = num(v);
    if (n === null) return null;
    return Math.max(0, 1 - Math.abs(n - center) / width);
  }

  /* Rampa 0-1: 0 hasta `from`, 1 desde `to`. Para "energía", donde
     más energía siempre es mejor (no hay un centro ideal). */
  function ramp(v, from, to) {
    var n = num(v);
    if (n === null) return null;
    if (n <= from) return 0;
    if (n >= to) return 1;
    return (n - from) / (to - from);
  }

  /* Camelot "8A"/"8B": A = menor, B = mayor. Sin tonalidad -> null. */
  function camelotLetter(track) {
    if (!track || typeof track.musicalKey !== 'string') return null;
    var m = track.musicalKey.match(/^\d{1,2}([AB])$/);
    return m ? m[1] : null;
  }
  function isMajor(track) { return camelotLetter(track) === 'B'; }
  function isMinor(track) { return camelotLetter(track) === 'A'; }

  /* ¿Tiene datos de análisis? La energía es el dato central: sin
     ella la pista no está analizada (bpm/brightness/key solos no
     bastan para puntuar un ánimo). */
  function hasAnalysis(track) {
    return !!track && clamp01(track.energy) !== null;
  }

  /* Componente con peso: banda 0-1 * peso; si falta el dato, la mitad
     del peso (no se castiga del todo por un solo dato ausente, pero
     tampoco se regala). */
  function comp(bandValue, weight) {
    if (bandValue === null) return weight / 2;
    return bandValue * weight;
  }

  /* Puntuación 0-100 de una pista para un ánimo, o null si la pista
     no tiene datos de análisis. Las reglas están documentadas en la
     cabecera de este archivo. */
  function scoreTrack(track, moodId) {
    if (!moodById(moodId)) throw new Error('Ánimo desconocido: ' + moodId);
    if (!hasAnalysis(track)) return null;
    var energy = clamp01(track.energy);
    var bright = clamp01(track.brightness);
    var bpm = num(track.bpm);
    var mood = track.mood || null;
    var score = 0;
    if (moodId === 'feliz') {
      score += isMajor(track) ? 30 : (isMinor(track) ? 0 : 12);
      score += comp(band(energy, 0.70, 0.35), 30);
      score += comp(band(bright, 0.65, 0.50), 20);
      score += comp(bpm === null ? null : band(bpm, 120, 45), 12);
      if (mood === 'fiesta') score += 8;
    } else if (moodId === 'triste') {
      score += isMinor(track) ? 30 : (isMajor(track) ? 0 : 12);
      score += comp(band(energy, 0.20, 0.35), 30);
      score += comp(bpm === null ? null : band(bpm, 75, 40), 15);
      score += comp(band(bright, 0.25, 0.45), 15);
      if (mood === 'relajado') score += 10;
    } else if (moodId === 'energia') {
      score += comp(ramp(energy, 0.45, 0.80), 40);
      score += comp(bpm === null ? null : band(bpm, 130, 40), 30);
      score += comp(band(bright, 0.70, 0.50), 15);
      if (mood === 'energia' || mood === 'fiesta') score += 10;
      if (isMajor(track)) score += 5;
    } else if (moodId === 'relax') {
      score += comp(band(energy, 0.20, 0.30), 35);
      score += comp(bpm === null ? null : band(bpm, 80, 35), 25);
      score += comp(band(bright, 0.35, 0.45), 15);
      if (mood === 'relajado') score += 15;
      score += isMinor(track) ? 10 : (isMajor(track) ? 0 : 5);
    } else if (moodId === 'enfoque') {
      score += comp(band(energy, 0.40, 0.22), 35);
      score += comp(bpm === null ? null : band(bpm, 90, 25), 30);
      score += comp(band(bright, 0.45, 0.40), 15);
      if (mood === 'concentracion') score += 15;
      score += 5; /* la tonalidad no importa para concentrarse */
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /* Cuántas pistas hay en total, cuántas analizadas y cuántas sin
     analizar. Sin analizadas no se puede generar nada. */
  function coverage(tracks) {
    var list = Array.isArray(tracks) ? tracks : [];
    var analyzed = 0;
    list.forEach(function (t) { if (hasAnalysis(t)) analyzed++; });
    return { total: list.length, analyzed: analyzed, unanalyzed: list.length - analyzed };
  }

  function byScoreDesc(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var ta = String((a.track && a.track.title) || ''), tb = String((b.track && b.track.title) || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    var aa = String((a.track && a.track.artist) || ''), ab = String((b.track && b.track.artist) || '');
    if (aa < ab) return -1;
    if (aa > ab) return 1;
    return 0;
  }

  /* Genera la lista para un ánimo: pistas analizadas, sin dislike,
     puntuadas, ordenadas por puntuación y filtradas por el mínimo.
     Nunca inventa: si no hay analizadas, tracks=[] y analyzed=0.
     Si hay pocas candidatas, devuelve las que hay (tracks.length
     puede ser < maxTracks) y el llamador avisa cuántas son. */
  function buildMoodPlaylist(tracks, moodId, opts) {
    if (!moodById(moodId)) throw new Error('Ánimo desconocido: ' + moodId);
    opts = opts || {};
    var minScore = (typeof opts.minScore === 'number' && isFinite(opts.minScore))
      ? Math.max(0, Math.min(100, opts.minScore)) : MIN_SCORE;
    var maxTracks = (typeof opts.maxTracks === 'number' && isFinite(opts.maxTracks) && opts.maxTracks > 0)
      ? Math.floor(opts.maxTracks) : MAX_TRACKS;
    var list = Array.isArray(tracks) ? tracks : [];
    var cov = coverage(list);
    var scored = [];
    var disliked = 0;
    list.forEach(function (t) {
      if (!t || !t.id) return;
      if (t.rating === 'dislike') { disliked++; return; }
      var s = scoreTrack(t, moodId);
      if (s === null) return;
      scored.push({ track: t, score: s });
    });
    scored.sort(byScoreDesc);
    var qualified = scored.filter(function (e) { return e.score >= minScore; });
    var picked = qualified.slice(0, maxTracks);
    return {
      moodId: moodId,
      moodLabel: moodById(moodId).label,
      minScore: minScore,
      maxTracks: maxTracks,
      total: cov.total,
      analyzed: cov.analyzed,
      unanalyzed: cov.unanalyzed,
      disliked: disliked,
      scored: scored.length,
      qualified: qualified.length,
      belowMin: scored.length - qualified.length,
      tracks: picked.map(function (e) {
        return { id: e.track.id, title: e.track.title, artist: e.track.artist, score: e.score };
      })
    };
  }

  /* Nombre sin colisión entre las playlists que ya existen: si
     "Ánimo · Feliz" ya existe, "Ánimo · Feliz (2)", " (3)"... */
  function resolvePlaylistName(existingNames, base) {
    var names = Array.isArray(existingNames) ? existingNames : [];
    if (names.indexOf(base) < 0) return base;
    var n = 2;
    while (names.indexOf(base + ' (' + n + ')') >= 0) n++;
    return base + ' (' + n + ')';
  }

  /* Objeto playlist con EL MISMO formato que createPlaylist() en
     app/index.html (~línea 3777): {id: 'p'+..., name, trackIds,
     updatedAt}. `now` y `rand` solo existen para poder probarlo. */
  function buildPlaylistObject(existingPlaylists, name, trackIds, now) {
    var existing = Array.isArray(existingPlaylists) ? existingPlaylists : [];
    var names = existing.map(function (p) { return p && p.name; });
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var ids = Array.isArray(trackIds) ? trackIds.filter(function (id, i, arr) {
      return id && arr.indexOf(id) === i;
    }) : [];
    return {
      id: 'p' + t.toString(36) + Math.random().toString(36).slice(2, 7),
      name: resolvePlaylistName(names, name),
      trackIds: ids,
      updatedAt: t
    };
  }

  /* Guarda la lista como playlist NORMAL de la app: lee el packState
     guardado, añade la playlist con el formato real y lo aplica con
     applyPackState (que hace saveState + render en la app). `app` es
     window.__rpmApp (o un doble en los tests). Resuelve con la
     playlist creada. Si el packState aún no existe, parte de []. */
  function saveAsPlaylist(app, name, trackIds) {
    if (!app || typeof app.getPackState !== 'function' || typeof app.applyPackState !== 'function') {
      return Promise.reject(new Error('La app no expone getPackState/applyPackState todavía.'));
    }
    return Promise.resolve(app.getPackState()).then(function (st) {
      st = (st && typeof st === 'object') ? st : {};
      var existing = Array.isArray(st.playlists) ? st.playlists : [];
      var pl = buildPlaylistObject(existing, name, trackIds);
      var next = {};
      Object.keys(st).forEach(function (k) { next[k] = st[k]; });
      next.playlists = existing.concat([pl]);
      return Promise.resolve(app.applyPackState(next)).then(function () { return pl; });
    });
  }

  var api = {
    MOODS: MOODS, MIN_SCORE: MIN_SCORE, MAX_TRACKS: MAX_TRACKS,
    moodById: moodById, hasAnalysis: hasAnalysis, coverage: coverage,
    isMajor: isMajor, isMinor: isMinor, band: band, ramp: ramp,
    scoreTrack: scoreTrack, buildMoodPlaylist: buildMoodPlaylist,
    resolvePlaylistName: resolvePlaylistName,
    buildPlaylistObject: buildPlaylistObject,
    saveAsPlaylist: saveAsPlaylist
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__animoHelpers = api; } catch (e) {}
  if (typeof document === 'undefined') return;

  /* ================= Capa DOM (todo con guards) ================= */

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function app() {
    try { return global.__rpmApp || null; } catch (e) { return null; }
  }

  function toast(msg) {
    try {
      var a = app();
      if (a && typeof a.toast === 'function') { a.toast(msg); return; }
    } catch (e) {}
    try {
      var el = $('toast');
      if (el) {
        el.textContent = msg;
        el.classList.add('show');
        setTimeout(function () { el.classList.remove('show'); }, 3200);
      }
    } catch (e) {}
  }

  function getTracks() {
    try {
      var a = app();
      if (a && typeof a.getTracks === 'function') {
        var list = a.getTracks();
        if (Array.isArray(list)) return list;
      }
    } catch (e) {}
    return null;
  }

  function openMoodsView() {
    try {
      var tab = document.querySelector('.view-tab[data-view="moods"]');
      if (tab) { tab.click(); return true; }
      var view = $('viewMoods');
      if (view) { view.style.display = ''; return true; }
    } catch (e) {}
    return false;
  }

  function openPlaylistsView() {
    try {
      var tab = document.querySelector('.view-tab[data-view="playlists"]');
      if (tab) { tab.click(); return true; }
    } catch (e) {}
    return false;
  }

  var current = null; /* último buildMoodPlaylist generado (o null) */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function setStatus(msg) {
    var st = $('animoStatus');
    if (st) st.textContent = msg;
  }

  function renderPreview(result) {
    var list = $('animoPreview');
    var saveBtn = $('btnAnimoSave');
    if (!list) return;
    list.innerHTML = '';
    if (!result || !result.tracks.length) {
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    result.tracks.forEach(function (t, i) {
      var li = el('li');
      var rank = el('span', 'animo-rank', String(i + 1));
      var main = el('div', 'animo-prev-main');
      main.appendChild(el('div', 'animo-prev-t',
        (t.title || 'Sin título') + (t.artist ? ' — ' + t.artist : '')));
      var bar = el('div', 'animo-bar');
      var fill = el('div', 'animo-bar-fill');
      fill.style.width = Math.max(3, t.score) + '%';
      bar.appendChild(fill);
      main.appendChild(bar);
      li.appendChild(rank);
      li.appendChild(main);
      li.appendChild(el('span', 'animo-prev-score', t.score + ' pts'));
      list.appendChild(li);
    });
    if (saveBtn) saveBtn.disabled = false;
  }

  function generate(moodId) {
    var mood = moodById(moodId);
    if (!mood) return;
    try {
      document.querySelectorAll('.animo-mood-btn').forEach(function (b) {
        var on = b.getAttribute('data-mood') === moodId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    } catch (e) {}
    var tracks = getTracks();
    if (!tracks) {
      current = null; renderPreview(null);
      setStatus('La biblioteca no está lista todavía. Espera a que cargue y vuelve a intentarlo.');
      return;
    }
    if (!tracks.length) {
      current = null; renderPreview(null);
      setStatus('Añade canciones primero: la biblioteca está vacía.');
      return;
    }
    var result;
    try {
      result = buildMoodPlaylist(tracks, moodId);
    } catch (e) {
      current = null; renderPreview(null);
      setStatus('No se pudo generar la lista. Inténtalo de nuevo.');
      return;
    }
    current = result;
    if (result.analyzed === 0) {
      renderPreview(null);
      setStatus('Ninguna canción tiene datos de análisis (energía/BPM): sin analizar no se puede saber a qué ánimo encaja cada una. Pulsa «Analizar biblioteca» arriba y vuelve aquí cuando termine. No se generó ninguna lista.');
      return;
    }
    if (!result.tracks.length) {
      renderPreview(null);
      setStatus('Ninguna canción llega al mínimo de ' + result.minScore + ' puntos para «' + mood.label + '» (' + result.analyzed + ' analizadas). Prueba con otro ánimo o analiza más canciones.');
      return;
    }
    renderPreview(result);
    var msg = result.tracks.length + (result.tracks.length === 1 ? ' canción' : ' canciones') +
      ' para «' + mood.label + '» (de ' + result.analyzed + ' analizadas' +
      (result.unanalyzed ? ', ' + result.unanalyzed + ' sin analizar quedan fuera' : '') +
      (result.disliked ? ', ' + result.disliked + ' con dislike quedan fuera' : '') + ').';
    if (result.qualified < result.maxTracks && result.analyzed > result.tracks.length) {
      msg += ' Son pocas: solo ' + result.qualified + ' llegan al mínimo de ' + result.minScore + ' puntos.';
    }
    setStatus(msg + ' Revisa la lista y pulsa «Guardar como playlist».');
  }

  function saveCurrent() {
    if (!current || !current.tracks.length) {
      toast('Elige primero un ánimo para generar la lista.');
      return;
    }
    var a = app();
    if (!a) { toast('La biblioteca no está lista todavía.'); return; }
    var mood = moodById(current.moodId);
    var name = 'Ánimo · ' + mood.label;
    var ids = current.tracks.map(function (t) { return t.id; });
    var btn = $('btnAnimoSave');
    if (btn) btn.disabled = true;
    saveAsPlaylist(a, name, ids).then(function (pl) {
      toast('Playlist «' + pl.name + '» creada con ' + pl.trackIds.length +
        (pl.trackIds.length === 1 ? ' canción' : ' canciones'));
      setStatus('Playlist «' + pl.name + '» guardada con ' + pl.trackIds.length +
        (pl.trackIds.length === 1 ? ' canción' : ' canciones') +
        '. La tienes en la vista Playlists, como cualquier otra playlist.');
      openPlaylistsView();
    }).catch(function () {
      toast('No se pudo guardar la playlist. Inténtalo de nuevo.');
      if (btn) btn.disabled = false;
    });
  }

  function wireLauncher() {
    var btn = $('btnAnimo');
    if (!btn) {
      /* Si el cableado HTML no añadió el botón, se crea solo junto a
         «Sincronizar» / «Tu año en música»: la vista sigue existiendo. */
      var wrappedBtn = $('btnWrapped') || $('btnSync');
      if (wrappedBtn && wrappedBtn.parentNode) {
        btn = document.createElement('button');
        btn.className = 'btn small';
        btn.id = 'btnAnimo';
        btn.type = 'button';
        btn.textContent = '🎵 Playlist por ánimo';
        wrappedBtn.parentNode.insertBefore(btn, wrappedBtn.nextSibling);
      } else return;
    }
    if (btn.getAttribute('data-animo-wired')) return;
    btn.setAttribute('data-animo-wired', '1');
    btn.addEventListener('click', function () {
      try {
        openMoodsView();
        var panel = $('animoPanel');
        if (panel && panel.scrollIntoView) {
          setTimeout(function () {
            try { panel.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
          }, 80);
        }
      } catch (e) {}
    });
  }

  function mount() {
    if ($('animoPanel')) return true;
    var grid = $('moodGrid');
    var anchor = grid || $('viewMoods');
    if (!anchor) return false;
    var panel = document.createElement('section');
    panel.id = 'animoPanel';
    panel.className = 'animo-panel';
    panel.setAttribute('aria-label', 'Playlist por estado de ánimo');
    var h = el('h3', null, '🎵 Playlist por estado de ánimo');
    panel.appendChild(h);
    panel.appendChild(el('p', 'animo-desc',
      'Elige un ánimo y la app arma una lista con las canciones que mejor encajan, según el análisis que ya tiene de cada una (BPM, energía, brillo, ambiente y tonalidad). La lista se guarda como una playlist normal.'));
    var row = el('div', 'animo-moods');
    MOODS.forEach(function (m) {
      var b = el('button', 'animo-mood-btn', m.emoji + ' ' + m.label);
      b.type = 'button';
      b.setAttribute('data-mood', m.id);
      b.setAttribute('aria-pressed', 'false');
      b.title = m.desc;
      b.addEventListener('click', function () { try { generate(m.id); } catch (e) {} });
      row.appendChild(b);
    });
    panel.appendChild(row);
    var status = el('p', 'animo-status', '');
    status.id = 'animoStatus';
    status.setAttribute('role', 'status');
    panel.appendChild(status);
    var list = el('ol', 'animo-preview');
    list.id = 'animoPreview';
    panel.appendChild(list);
    var actions = el('div', 'animo-actions');
    var saveBtn = el('button', 'btn small primary', '💾 Guardar como playlist');
    saveBtn.id = 'btnAnimoSave';
    saveBtn.type = 'button';
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', function () { try { saveCurrent(); } catch (e) {} });
    actions.appendChild(saveBtn);
    panel.appendChild(actions);
    try {
      if (grid && grid.parentNode) grid.parentNode.insertBefore(panel, grid.nextSibling);
      else anchor.appendChild(panel);
    } catch (e) { return false; }
    /* Aviso inicial honesto sobre cobertura, sin generar nada. */
    try {
      var tracks = getTracks();
      if (tracks) {
        var cov = coverage(tracks);
        setStatus(!tracks.length
          ? 'Añade canciones primero: la biblioteca está vacía.'
          : (cov.analyzed === 0
            ? 'Ninguna canción tiene datos de análisis todavía. Pulsa «Analizar biblioteca» arriba y vuelve aquí cuando termine.'
            : cov.analyzed + ' de ' + cov.total + ' canciones analizadas. Elige un ánimo para generar su lista.'));
      } else {
        setStatus('Elige un ánimo para generar su lista.');
      }
    } catch (e) {}
    return true;
  }

  function init() {
    try {
      wireLauncher();
      if (!mount()) {
        /* La vista Ambientes puede montarse tarde: reintentar unas
           veces sin molestar; si no aparece, no se rompe nada. */
        var tries = 0;
        var tick = function () {
          tries++;
          if (mount()) return;
          wireLauncher();
          if (tries < 20) setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
      }
      global.__rpmAnimo = {
        version: VERSION, open: openMoodsView, generate: generate,
        saveCurrent: saveCurrent, scoreTrack: scoreTrack,
        buildMoodPlaylist: buildMoodPlaylist, coverage: coverage,
        saveAsPlaylist: saveAsPlaylist, MOODS: MOODS
      };
    } catch (e) { /* Fallar al cargar no debe romper la app. */ }
  }

  /* Auto-inyección del CSS (mismo patrón que dj.js / cast.js): el
     <link> en index.html es lo recomendado; si falta, el JS lo añade. */
  try {
    var hasCss = false;
    try {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) {
        if ((links[i].getAttribute('href') || '').indexOf('animo.css') >= 0) { hasCss = true; break; }
      }
    } catch (e) {}
    if (!hasCss) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = './animo.css';
      (document.head || document.documentElement).appendChild(link);
    }
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(typeof window !== 'undefined' ? window : this);
