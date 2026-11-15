/* Media Session: huecos de la implementación de index.html — módulo aparte (v3.8.0).
   No toca index.html ni reescribe la app: se engancha solo al <audio id="audio">,
   al <video id="videoEl"> y a #nowTitle / #nowArtist, que ya existen en la app.

   Lo que la app YA hace bien (verificado en app/index.html, NO se duplica aquí):
   - updateMediaSession() (~l.5438): metadata (título/artista/álbum/portada),
     playbackState y handlers play/pause/previoustrack/nexttrack/seekbackward/
     seekforward/seekto/stop. Se llama desde renderNow() (~l.3613), y renderNow()
     corre también en los eventos 'play' y 'pause' del audio (l.5025-5044), así que
     playbackState SÍ se actualiza al pausar/reanudar, no solo al cambiar de canción.
   - updateMsPosition() (~l.5423): setPositionState en cada 'timeupdate' mientras
     suena (l.5002-5010), con throttle de 500 ms. La posición durante la
     reproducción ya está cubierta.

   Huecos reales que completa este módulo (todos verificados en el código):
   G1. Buscar en pausa deja la posición congelada en la pantalla de bloqueo.
       No hay ningún listener de 'seeked' / 'seeking' en la app (grep: 0), y
       buscar desde el deslizador (l.5066-5067), las flechas ←/→ (l.5398-5399),
       un marcador (l.7233), un capítulo (l.10750) o los ±15/30 s de audiolibro
       (l.10772) solo asigna audio.currentTime sin refrescar la posición. En
       pausa no hay 'timeupdate' que lo corrija. Solo el handler 'seekto' de
       MediaSession refrescaba (l.5470). -> listener 'seeked' que fuerza el
       refresco de la posición.
   G2. Cambiar la velocidad en pausa deja playbackRate obsoleto en la posición.
       setSpeed() (l.5580-5594) pone playbackRate en los tres decks sin refrescar
       nada; no hay listener de 'ratechange' (grep: 0). -> listener 'ratechange'.
   G3. Si la duración aún no se conocía al cambiar de pista, la posición nunca
       se publica. updateMsPosition() abandona si !dur (l.5429), y el handler
       'loadedmetadata' (l.5011-5021) actualiza el total en pantalla pero no la
       posición de MediaSession; en pausa no llega ningún 'timeupdate' posterior.
       -> listeners 'loadedmetadata' y 'durationchange'.
   G4. Falta chapter info. La app TIENE capítulos (CHAP de ID3, l.2909-2910, por
       pista en l.3122/3191, con su lista en la interfaz) pero nunca los pasa a
       MediaMetadata (grep 'chapterInfo': 0). MediaMetadataInit.chapterInfo
       existe, solo en Chrome 127+. -> se reaplica la metadata con chapterInfo
       después de que la app la escriba, sin reconstruir título/artista/álbum.
   G5. Al vaciar la biblioteca o borrar la última canción, la metadata vieja
       queda en la pantalla de bloqueo. renderNow() sin pista hace early return
       (l.3573-3595) sin limpiar MediaSession (grep 'metadata = null' y
       "playbackState = 'none'": 0); clearAll() (l.4976) y el borrado de la
       pista actual dejan tracks=[] y currentId=null y llaman a render().
       -> al detectar el título vacío, metadata=null y playbackState='none'.
   G6. (Solo documentado, NO se arregla desde aquí) El handler 'seekby' de la
       app (l.5472-5474) lee d.seekTime, pero según el estándar W3C los seeks
       relativos usan seekOffset (seekTime es solo de 'seekto'), y 'seekby' ni
       siquiera está en el enum MediaSessionAction (play, pause, seekbackward,
       seekforward, previoustrack, nexttrack, skipad, stop, seekto, ...). Por
       WebIDL un valor de enum inválido lanza TypeError, lo que abortaría el
       resto del try de updateMediaSession(): el handler 'stop' (l.5475) y el
       updateMsPosition() final (l.5477-5478) no llegarían a ejecutarse nunca.
       Eso NO está verificado en un Chrome real (ver WIRING.md). El arreglo es
       borrar el bloque 'seekby' en index.html; este módulo NO instala 'seekby'
       ni 'stop' para no duplicar ni tapar el handler de la app.

   Limitaciones honestas (ver WIRING.md):
   - Durante el crossfade, el deck activo puede ser audioB, un <audio> creado
     con createElement y nunca insertado en el DOM: este módulo no puede
     escucharlo. En ese rato la posición la sigue manteniendo el bindDeck de
     la propia app; el módulo no pelea con ella.
   - chapterInfo solo existe en Chrome 127+; en el resto el módulo no hace nada.
   - Sin navigator.mediaSession, el módulo no hace nada y no falla.

   Uso: ver WIRING.md (copiar el archivo + 2 líneas). Sin CSS: no hay UI. */
(function () {
  'use strict';

  var POSITION_THROTTLE_MS = 500;
  var EMPTY_TITLE = 'Ninguna canción seleccionada';
  var RETRY_MS = 1500;

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /* --- Lógica pura (probada en Node, sin DOM) --- */

  // Posición dentro de [0, duración]; sin duración válida, 0.
  function clampPosition(position, duration) {
    var p = isFiniteNumber(position) ? position : 0;
    if (!isFiniteNumber(duration) || duration <= 0) return 0;
    return Math.min(Math.max(0, p), duration);
  }

  // Estado para setPositionState, o null si aún no hay duración conocida (G3:
  // es el mismo early-return que hace updateMsPosition() en la app).
  function buildPositionState(media) {
    var m = media || {};
    if (!isFiniteNumber(m.duration) || !m.duration) return null;
    return {
      duration: m.duration,
      playbackRate: isFiniteNumber(m.playbackRate) && m.playbackRate > 0 ? m.playbackRate : 1,
      position: clampPosition(m.currentTime, m.duration),
    };
  }

  // Mismo throttle de 500 ms que updateMsPosition() en la app. Los eventos
  // discretos (seeked, ratechange, ...) fuerzan el refresco: son los huecos
  // G1/G2/G3, y no tiene sentido esperar al siguiente 'timeupdate' que en
  // pausa no llega nunca.
  function shouldRefreshPosition(nowMs, lastMs, force) {
    if (force) return true;
    if (!isFiniteNumber(nowMs) || !isFiniteNumber(lastMs)) return true;
    return nowMs - lastMs >= POSITION_THROTTLE_MS;
  }

  // Capítulos de la app ({title, start} en segundos) a chapterInfo
  // ({title, startTime}): válidos, ordenados, sin duplicados de inicio y
  // recortados a la duración cuando se conoce. Sin capítulos válidos -> [].
  function normalizeChapters(chapters, duration) {
    var list = Array.isArray(chapters) ? chapters : [];
    var seen = {};
    var out = [];
    list.forEach(function (c) {
      if (!c || !isFiniteNumber(c.start) || c.start < 0) return;
      if (isFiniteNumber(duration) && duration > 0 && c.start >= duration) return;
      var key = String(c.start);
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        title: (typeof c.title === 'string' && c.title.trim()) ? c.title.slice(0, 80) : 'Capítulo',
        startTime: c.start,
      });
    });
    out.sort(function (a, b) { return a.startTime - b.startTime; });
    return out;
  }

  // Índice del capítulo que contiene la posición, o -1 si no hay capítulos
  // o la posición está antes del primero.
  function resolveChapterIndex(chapters, position) {
    var list = Array.isArray(chapters) ? chapters : [];
    if (!list.length || !isFiniteNumber(position)) return -1;
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].startTime <= position) idx = i; else break;
    }
    return idx;
  }

  // Misma coincidencia por título/artista que usa lyrics.js (DOM -> pista).
  function matchTrackByTitleArtist(tracks, title, artist) {
    var list = Array.isArray(tracks) ? tracks : [];
    var t = norm(title), a = norm(artist);
    if (!t) return null;
    for (var i = 0; i < list.length; i++) {
      var tr = list[i];
      if (!tr) continue;
      if (norm(tr.title) === t && (!a || norm(tr.artist) === a || norm(tr.name) === a)) return tr;
    }
    return null;
  }

  // El texto exacto que renderNow() escribe cuando no hay pista (l.3575).
  function isEmptyNowTitle(text) {
    return String(text || '').trim() === EMPTY_TITLE;
  }

  function resolvePlaybackState(paused) {
    return paused ? 'paused' : 'playing';
  }

  // ¿Soporta este navegador chapterInfo? Se prueba construyendo de verdad:
  // en Chrome <127 el constructor ignora el campo y al leerlo sale vacío.
  function chapterInfoSupported(MediaMetadataCtor) {
    try {
      if (typeof MediaMetadataCtor !== 'function') return false;
      var probe = new MediaMetadataCtor({
        title: 'x',
        chapterInfo: [{ title: 'C1', startTime: 0 }],
      });
      var info = probe && probe.chapterInfo;
      return Array.isArray(info) && info.length === 1;
    } catch (e) {
      return false;
    }
  }

  // ¿De qué elemento sale la posición? Estados {hasSrc, duration, paused}.
  // Regla: entre los que tienen duración conocida, manda el que suena; si
  // ninguno suena, el primero con duración (posición en pausa, G1/G3); si
  // ninguno tiene duración, el primero con fuente. -1 si no hay nada.
  function pickMediaIndex(states) {
    var list = Array.isArray(states) ? states : [];
    var fallback = -1;
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      if (!s.hasSrc) continue;
      if (fallback < 0) fallback = i;
      if (isFiniteNumber(s.duration) && s.duration > 0) {
        if (!s.paused) return i;
        if (fallback < 0 || !isFiniteNumber(list[fallback].duration)) fallback = i;
      }
    }
    // Segundo pase: si el fallback era solo "con fuente" pero hay otro con
    // duración en pausa, ese manda.
    for (var j = 0; j < list.length; j++) {
      var s2 = list[j] || {};
      if (s2.hasSrc && isFiniteNumber(s2.duration) && s2.duration > 0) return j;
    }
    return fallback;
  }

  /* --- Cableado al navegador (todo en try/catch, nunca rompe la app) --- */

  var lastRefreshMs = 0;
  var lastTrackKey = '';
  var lastChaptersKey = '';
  var clearedStale = false;
  var chapterSupport = null;
  var started = false;

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function mediaSession() {
    try {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
      return navigator.mediaSession;
    } catch (e) { return null; }
  }
  function snapshot(el) {
    if (!el) return { hasSrc: false, duration: NaN, currentTime: 0, playbackRate: 1, paused: true };
    var src = false;
    try { src = !!(el.currentSrc || el.src); } catch (e) { src = false; }
    return {
      hasSrc: src,
      duration: el.duration,
      currentTime: el.currentTime || 0,
      playbackRate: el.playbackRate || 1,
      paused: el.paused !== false,
    };
  }
  function activeMedia() {
    var els = [];
    var a = $('audio'); if (a) els.push(a);
    var v = $('videoEl'); if (v) els.push(v);
    if (!els.length) return null;
    var states = els.map(snapshot);
    var idx = pickMediaIndex(states);
    if (idx < 0) return els[0];
    return els[idx];
  }

  // Refresca SOLO la posición (G1/G2/G3). No toca metadata ni handlers: eso
  // es de la app. Devuelve true si llamó a setPositionState.
  function refreshPosition(force) {
    var ms = mediaSession();
    if (!ms || typeof ms.setPositionState !== 'function') return false;
    var now = Date.now();
    if (!shouldRefreshPosition(now, lastRefreshMs, !!force)) return false;
    var el = activeMedia();
    if (!el) return false;
    var state = buildPositionState(snapshot(el));
    if (!state) return false;
    try {
      ms.setPositionState(state);
      lastRefreshMs = now;
      return true;
    } catch (e) { return false; }
  }

  function currentTrackKey() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return norm(t) + '|' + norm(a);
  }

  // Reaplica la metadata que la app acaba de escribir, añadiendo chapterInfo
  // (G4). Lee título/artista/álbum/portada de la metadata actual: no
  // reconstruye nada de la app, solo añade los capítulos. Si el navegador no
  // soporta chapterInfo o la pista no tiene capítulos, no toca nada.
  function applyChapters() {
    var ms = mediaSession();
    if (!ms || !ms.metadata) return false;
    if (typeof window === 'undefined' || typeof window.MediaMetadata !== 'function') return false;
    if (chapterSupport === null) chapterSupport = chapterInfoSupported(window.MediaMetadata);
    if (!chapterSupport) return false;
    var titleEl = $('nowTitle'), artistEl = $('nowArtist');
    var title = titleEl ? titleEl.textContent : '';
    var artist = artistEl ? artistEl.textContent : '';
    if (isEmptyNowTitle(title)) return false;
    var tracks = null;
    try {
      tracks = (window.__rpmApp && typeof window.__rpmApp.getTracks === 'function')
        ? window.__rpmApp.getTracks() : null;
    } catch (e) { tracks = null; }
    var track = matchTrackByTitleArtist(tracks, title, artist);
    if (!track || !Array.isArray(track.chapters) || !track.chapters.length) return false;
    var el = activeMedia();
    var dur = el ? snapshot(el).duration : (isFiniteNumber(track.duration) ? track.duration : NaN);
    var chapters = normalizeChapters(track.chapters, dur);
    if (!chapters.length) return false;
    var key = norm(title) + '|' + norm(artist) + '|' + chapters.map(function (c) {
      return c.title + '@' + c.startTime;
    }).join(',');
    if (key === lastChaptersKey) return false; // ya aplicado, no reescribir
    try {
      var cur = ms.metadata;
      ms.metadata = new window.MediaMetadata({
        title: cur.title || title,
        artist: cur.artist || artist || '',
        album: cur.album || '',
        artwork: cur.artwork || [],
        chapterInfo: chapters,
      });
      lastChaptersKey = key;
      return true;
    } catch (e) { return false; }
  }

  // Sin pista no hay nada que mostrar en la pantalla de bloqueo (G5).
  function clearStale() {
    var ms = mediaSession();
    if (!ms) return false;
    if (clearedStale) return false;
    try {
      if (ms.metadata) ms.metadata = null;
    } catch (e) {}
    try { ms.playbackState = 'none'; } catch (e) {}
    clearedStale = true;
    lastTrackKey = '';
    lastChaptersKey = '';
    return true;
  }

  // Cambio de pista detectado por #nowTitle (la app lo reescribe en cada
  // renderNow, después de llamar a updateMediaSession): refresca la posición
  // —que el 'seekby' sospechoso puede haber impedido refrescar en la app
  // (G6)— y reaplica los capítulos. Con la misma pista no se reescribe nada.
  function onTrackChange() {
    var titleEl = $('nowTitle');
    var title = titleEl ? titleEl.textContent : '';
    if (isEmptyNowTitle(title)) { clearStale(); return; }
    clearedStale = false;
    var key = currentTrackKey();
    if (key === lastTrackKey) return;
    lastTrackKey = key;
    refreshPosition(true);
    applyChapters();
  }

  function bindMediaEvents() {
    var els = [];
    var a = $('audio'); if (a) els.push(a);
    var v = $('videoEl'); if (v) els.push(v);
    els.forEach(function (el) {
      // G1: buscar (también en pausa, cuando no hay 'timeupdate').
      el.addEventListener('seeked', function () { refreshPosition(true); });
      // G2: cambiar la velocidad (también en pausa).
      el.addEventListener('ratechange', function () { refreshPosition(true); });
      // G3: la duración aparece tarde (metadata del archivo).
      el.addEventListener('loadedmetadata', function () { refreshPosition(true); });
      el.addEventListener('durationchange', function () { refreshPosition(true); });
    });
  }

  function observeTrackChanges() {
    var titleEl = $('nowTitle');
    if (!titleEl || typeof MutationObserver === 'undefined') return false;
    try {
      var obs = new MutationObserver(function () { onTrackChange(); });
      obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
      return true;
    } catch (e) { return false; }
  }

  function init() {
    if (started) return false;
    started = true;
    var ms = mediaSession();
    if (!ms) return false; // sin MediaSession: no hacer nada y no fallar
    if (!$('audio')) return false;
    bindMediaEvents();
    observeTrackChanges();
    onTrackChange();
    // La biblioteca carga de forma asíncrona (IndexedDB): si la pista y su
    // metadata aparecen después de este init, el observer lo caza; este
    // reintento cubre el caso en que ya estaban antes del observer.
    setTimeout(function () { onTrackChange(); }, RETRY_MS);
    return true;
  }

  function state() {
    var el = null;
    try { el = activeMedia(); } catch (e) { el = null; }
    var snap = el ? snapshot(el) : null;
    var chapters = [];
    try {
      var tracks = (window.__rpmApp && typeof window.__rpmApp.getTracks === 'function')
        ? window.__rpmApp.getTracks() : null;
      var tr = matchTrackByTitleArtist(
        tracks,
        $('nowTitle') ? $('nowTitle').textContent : '',
        $('nowArtist') ? $('nowArtist').textContent : ''
      );
      if (tr) chapters = normalizeChapters(tr.chapters, snap ? snap.duration : NaN);
    } catch (e) {}
    return {
      supported: !!mediaSession(),
      chapterInfoSupported: chapterSupport,
      lastTrackKey: lastTrackKey,
      lastChaptersKey: lastChaptersKey,
      clearedStale: clearedStale,
      media: snap,
      chapters: chapters,
      currentChapterIndex: resolveChapterIndex(chapters, snap ? snap.currentTime : 0),
    };
  }

  var api = {
    POSITION_THROTTLE_MS: POSITION_THROTTLE_MS,
    EMPTY_TITLE: EMPTY_TITLE,
    clampPosition: clampPosition,
    buildPositionState: buildPositionState,
    shouldRefreshPosition: shouldRefreshPosition,
    normalizeChapters: normalizeChapters,
    resolveChapterIndex: resolveChapterIndex,
    matchTrackByTitleArtist: matchTrackByTitleArtist,
    isEmptyNowTitle: isEmptyNowTitle,
    resolvePlaybackState: resolvePlaybackState,
    chapterInfoSupported: chapterInfoSupported,
    pickMediaIndex: pickMediaIndex,
    refreshPosition: refreshPosition,
    applyChapters: applyChapters,
    clearStale: clearStale,
    onTrackChange: onTrackChange,
    init: init,
    state: state,
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    window.__rpmMediaSession = api;
    window.__rpmMediaSessionState = state;
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
