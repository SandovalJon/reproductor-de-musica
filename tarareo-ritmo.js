/* Buscar por tarareo mejorado (ritmo) para Reproductor de Música — v4.3.0.
   Módulo aparte: NO toca app/ ni la lógica de reproducción.
   Se engancha solo por DOM a lo que ya existe en la app:
     window.__rpmApp.getTracks() (línea ~12756 de app/index.html),
     #search, #trackList (filas con data-track-id) y la pestaña
     [data-view="library"], igual que tarareo.js.

   Qué añade sobre el tarareo actual (tarareo.js, v3.7.0):
   - El tarareo actual compara solo BPM estimado y tonalidad
     probable contra el bpm y el musicalKey analizados de cada
     canción. Este módulo añade una tercera pata: el RITMO, es
     decir, el patrón de duraciones entre inicios de nota (onsets)
     del tarareo, normalizado por tempo, comparado con la rejilla
     de pulsos que implica el BPM analizado de cada canción.
   - Cómo se compara el ritmo: los intervalos entre inicios del
     tarareo se pasan a pulsos (intervalo × BPM/60) y se mide lo
     bien que cae cada uno sobre la rejilla de subdivisiones
     habituales (semicorchea, corchea, negra, negra con puntillo,
     blanca…). Un tarareo a tempo mitad o doble de la canción
     sigue cayendo sobre la rejilla (corcheas/blancas): el ajuste
     rítmico es relativo al tempo y la diferencia de tempo la
     penaliza aparte la parte de BPM, como antes.
   - Puntuación 0-100: BPM 35% + tonalidad 35% + ritmo 30%. Si no
     hay datos de ritmo (menos de 3 inicios de nota) la parte de
     ritmo es null y los pesos se renormalizan a BPM/tonalidad: el
     resultado es el mismo que daría tarareo.js solo. Si no hay
     BPM ni tonalidad tarareados, el ritmo es el 100%.
   - La app NO guarda ningún patrón rítmico por canción (no hay
     onsets, beats ni rejilla almacenados: solo bpm, musicalKey,
     energy, duration y silence de recorte). Por eso el lado
     canción del ritmo es la rejilla regular que implica su BPM,
     no un patrón guardado: no se inventa ningún dato. La función
     patternSimilarity queda como utilidad pura (y testeada) para
     el día en que el analizador guarde patrones por canción; hoy
     NO se usa en la puntuación porque no hay nada contra lo que
     compararla. El panel lo dice claro.
   - La melodía exacta NO se compara: igual que en tarareo.js, la
     app no guarda melodías de las canciones. El panel lo dice
     claro: es una coincidencia APROXIMADA por ritmo, BPM y
     tonalidad.

   Dependencia: reutiliza la grabación y la detección de tono de
   tarareo.js (window.__rpmTarareo: detectPitch,
   notesFromFrequencies, estimateBpmFromOnsets, humKeysFromNotes)
   en vez de duplicar la autocorrelación. Si tarareo.js no está
   cargado, el botón lo dice y no hace nada más: la app sigue
   igual. La grabación (MediaRecorder, 6 s) y el panel son propios
   de este módulo; el tarareo actual no se toca ni se rompe.
   Reproducir un candidato = click en su fila real de #trackList.

   Sin datos de análisis en una canción (sin bpm ni musicalKey),
   esa canción no se inventa: se excluye del ranking y se cuenta
   como "sin datos", igual que en tarareo.js.

   FAIL-SAFE: todo el init y cada acción van en try/catch; si
   tarareo-ritmo.js no carga, la app queda byte-idéntica.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./tarareo-ritmo.css">
     <script src="./tarareo-ritmo.js"></script>
   Pruebas Node: node --test tarareo-ritmo.test.mjs
   Prueba desde la consola:
     window.__rpmTarareoRitmo.state()
     window.__rpmTarareoRitmo.start() / window.__rpmTarareoRitmo.stop()
     window.__rpmTarareoRitmo.rank({ bpm: 120, keys: ['8B', '8A'],
       starts: [0, 0.5, 1, 1.5, 2] }, window.__rpmApp.getTracks()) */
(function (global) {
  'use strict';

  /* ================= Constantes ================= */

  var RECORD_MS = 6000;          // igual que tarareo.js
  var FRAME_MS = 100;            // un tono cada 100 ms (tarareo.js)
  var FRAME_SIZE = 2048;         // ventana de autocorrelación (tarareo.js)
  var MIN_NOTES = 3;             // notas mínimas para puntuar (tarareo.js)
  var TOP_N = 5;                 // candidatos que se muestran
  var BPM_MIN = 40, BPM_MAX = 240;
  var KEY_AMBIGUITY_CAP = 0.75;  // igual que tarareo.js
  var W_BPM = 0.35, W_KEY = 0.35, W_RHYTHM = 0.30;
  var RHYTHM_TOL = 0.25;         // error relativo a la rejilla que
                                 // deja un IOI en 0 (25%): un IOI a
                                 // mitad de camino entre dos valores
                                 // de la rejilla puntúa ~0.33
  /* Subdivisiones habituales en pulsos: semicorchea 0.25, corchea
     0.5, corchea con puntillo 0.75, negra 1, negra con puntillo
     1.5, blanca 2, blanca con puntillo 3, redonda 4. */
  var GRID = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

  /* ================= Núcleo puro (probable en Node) ================= */

  /* Mediana de un array de números, o null si está vacío. */
  function median(values) {
    if (!values || !values.length) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    var n = v.length;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /* Instantes de inicio de nota (segundos) -> intervalos entre
     inicios (IOIs) en segundos. Solo intervalos > 0; [] si hay
     menos de 2 inicios. */
  function ioisFromStarts(starts) {
    var iois = [];
    if (!starts) return iois;
    for (var i = 1; i < starts.length; i++) {
      var g = starts[i] - starts[i - 1];
      if (typeof g === 'number' && isFinite(g) && g > 0) iois.push(g);
    }
    return iois;
  }

  /* Patrón rítmico normalizado por tempo: cada IOI dividido por la
     mediana de los IOIs. Invariante al tempo: tararear la misma
     melodía al doble de velocidad da el mismo patrón
     ([1, 1, 0.5, 2, ...]). [] si hay menos de 2 IOIs. */
  function normalizeIois(iois) {
    if (!iois || iois.length < 2) return [];
    var med = median(iois);
    if (!med || !(med > 0)) return [];
    return iois.map(function (g) { return g / med; });
  }

  /* IOIs en segundos -> IOIs en pulsos para un BPM dado
     (pulsos = segundos × BPM / 60). [] si el BPM no es válido. */
  function ioisInBeats(iois, bpm) {
    if (!iois || typeof bpm !== 'number' || !(bpm > 0)) return [];
    return iois.map(function (g) { return g * bpm / 60; });
  }

  /* Valor de la rejilla más cercano a un IOI en pulsos y su error
     relativo: { value, relErr }. null si no es un número válido. */
  function quantizeIoi(beats) {
    if (typeof beats !== 'number' || !isFinite(beats) || !(beats > 0)) return null;
    var best = GRID[0], bestErr = Infinity;
    GRID.forEach(function (g) {
      var err = Math.abs(beats - g) / g;
      if (err < bestErr) { bestErr = err; best = g; }
    });
    return { value: best, relErr: bestErr };
  }

  /* Patrón rítmico de un tarareo para el BPM de una canción:
     { ioisBeats: [...], quantized: [...], relErrs: [...],
       meanErr: number } o null si no hay al menos 2 IOIs o el BPM
     no es válido. Es lo que se muestra al usuario ("1 · 1 · ½ ·
     2 pulsos") y la base de rhythmScore. */
  function rhythmPattern(starts, bpm) {
    var iois = ioisFromStarts(starts);
    if (iois.length < 2) return null;
    var beats = ioisInBeats(iois, bpm);
    if (!beats.length) return null;
    var quantized = [], relErrs = [];
    for (var i = 0; i < beats.length; i++) {
      var q = quantizeIoi(beats[i]);
      if (!q) return null;
      quantized.push(q.value);
      relErrs.push(q.relErr);
    }
    var meanErr = relErrs.reduce(function (a, b) { return a + b; }, 0) / relErrs.length;
    return { ioisBeats: beats, quantized: quantized, relErrs: relErrs, meanErr: meanErr };
  }

  /* Ajuste rítmico 0-1: lo bien que caen los inicios del tarareo
     sobre la rejilla de pulsos que implica el BPM de la canción.
     1 = todos los intervalos caen exactos sobre la rejilla;
     cada IOI puntúa max(0, 1 - relErr / RHYTHM_TOL) y se promedia.
     null si hay menos de 3 inicios (< 2 IOIs) o el BPM de la
     canción no es válido (esa canción no tiene con qué comparar
     el ritmo: no se inventa). */
  function rhythmScore(starts, trackBpm) {
    var pat = rhythmPattern(starts, trackBpm);
    if (!pat) return null;
    var sum = 0;
    pat.relErrs.forEach(function (e) {
      sum += Math.max(0, 1 - e / RHYTHM_TOL);
    });
    return sum / pat.relErrs.length;
  }

  /* Similitud coseno 0-1 entre dos patrones rítmicos normalizados
     (arrays de IOIs divididos por su mediana). Compara hasta la
     longitud del más corto; null si alguno tiene menos de 2
     valores o algún valor no es válido. UTILIDAD para el futuro:
     hoy la app no guarda patrones rítmicos por canción, así que
     NO se usa en la puntuación (no hay nada contra lo que
     comparar el patrón del tarareo); queda probada para cuando el
     analizador guarde onsets/beats por canción. */
  function patternSimilarity(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return null;
    var n = Math.min(a.length, b.length);
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < n; i++) {
      var x = a[i], y = b[i];
      if (typeof x !== 'number' || !isFinite(x) || x < 0 ||
          typeof y !== 'number' || !isFinite(y) || y < 0) return null;
      dot += x * y; na += x * x; nb += y * y;
    }
    if (na <= 0 || nb <= 0) return null;
    return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
  }

  /* "8A" -> { n: 8, l: "A" } o null. Mismo formato que la app y
     que tarareo.js (parseCamelot). */
  function parseCamelot(code) {
    var m = /^(\d{1,2})([AB])$/.exec(code || '');
    return m ? { n: parseInt(m[1], 10), l: m[2] } : null;
  }

  /* Cercanía armónica 0-1 entre dos códigos Camelot, con la misma
     escala que el DJ de la app y que tarareo.js: misma 1, ±1 en la
     rueda (misma letra) 0.75, relativa mayor/menor 0.6, ±1 con
     otra letra 0.35, resto 0. */
  function camelotScore(a, b) {
    var ka = parseCamelot(a), kb = parseCamelot(b);
    if (!ka || !kb) return 0;
    if (ka.n === kb.n && ka.l === kb.l) return 1;
    var d = Math.abs(ka.n - kb.n);
    d = Math.min(d, 12 - d); // la rueda es circular (12 -> 1)
    if (ka.l === kb.l && d === 1) return 0.75;
    if (ka.n === kb.n) return 0.6;
    if (d === 1) return 0.35;
    return 0;
  }

  /* Cercanía de BPM 0-1, igual que tarareo.js: 1 si coincide, cae
     linealmente hasta 0 con un 50% de diferencia relativa. null
     sin datos. */
  function bpmScore(trackBpm, humBpm) {
    if (typeof trackBpm !== 'number' || !(trackBpm > 0) ||
        typeof humBpm !== 'number' || !(humBpm > 0)) return null;
    var rel = Math.abs(trackBpm - humBpm) / humBpm;
    return Math.max(0, 1 - rel / 0.5);
  }

  /* Puntuación 0-100 de una canción para un tarareo con ritmo.
     hum: { bpm: number|null, keys: [Camelot...], starts: [seg...] }.
     Pesos: BPM 0.35 + tonalidad 0.35 + ritmo 0.30. Cada parte que
     no tiene datos es null y los pesos se renormalizan: sin
     ritmo, el resultado es el mismo que daría tarareo.js solo
     (BPM + tonalidad al 50/50); sin BPM ni tonalidad, el ritmo es
     el 100%. Sin ningún dato comparable: null (canción sin
     analizar: no se inventa). */
  function scoreCandidateRhythm(hum, track) {
    if (!hum || !track) return null;
    var parts = { bpm: null, key: null, rhythm: null };
    var weights = { bpm: 0, key: 0, rhythm: 0 };
    var b = bpmScore(track.bpm, hum.bpm);
    if (b !== null) { parts.bpm = b; weights.bpm = W_BPM; }
    if (hum.keys && hum.keys.length && track.musicalKey) {
      var k = 0;
      hum.keys.forEach(function (hk) {
        k = Math.max(k, camelotScore(hk, track.musicalKey));
      });
      k = Math.min(k, KEY_AMBIGUITY_CAP); // mayor/menor ambiguo
      parts.key = k; weights.key = W_KEY;
    }
    var r = rhythmScore(hum.starts, track.bpm);
    if (r !== null) { parts.rhythm = r; weights.rhythm = W_RHYTHM; }
    var w = weights.bpm + weights.key + weights.rhythm;
    if (w === 0) return null;
    var score = (parts.bpm !== null ? parts.bpm * weights.bpm : 0) +
                (parts.key !== null ? parts.key * weights.key : 0) +
                (parts.rhythm !== null ? parts.rhythm * weights.rhythm : 0);
    return { score: Math.round((score / w) * 100), parts: parts };
  }

  /* Ordena las canciones analizadas por parecido al tarareo con
     ritmo. Devuelve { candidates: [{track, score, parts}],
     analyzed: n, total: n, unanalyzed: n }. Solo entran canciones
     con bpm o musicalKey; las demás se cuentan como sin analizar
     y no se comparan. */
  function rankCandidatesRhythm(hum, tracks, limit) {
    var list = [];
    var analyzed = 0, total = 0;
    (tracks || []).forEach(function (t) {
      if (!t) return;
      total++;
      var hasData = (typeof t.bpm === 'number' && t.bpm > 0) || !!t.musicalKey;
      if (!hasData) return;
      analyzed++;
      var s = scoreCandidateRhythm(hum, t);
      if (s) list.push({ track: t, score: s.score, parts: s.parts });
    });
    list.sort(function (a, b) { return b.score - a.score; });
    var n = (typeof limit === 'number' && limit > 0) ? limit : TOP_N;
    return { candidates: list.slice(0, n), analyzed: analyzed, total: total, unanalyzed: total - analyzed };
  }

  /* Un IOI en pulsos -> fracción legible (¼ ½ ¾) o número. */
  function beatsLabel(v) {
    if (v === 0.25) return '¼';
    if (v === 0.5) return '½';
    if (v === 0.75) return '¾';
    return String(v);
  }

  /* Patrón rítmico para mostrar: "1 · 1 · ½ · 2 pulsos" (valores
     de la rejilla para el BPM de la canción) o null si no hay
     patrón que mostrar. Si se pasa un BPM, los valores son los
     del patrón cuantizado para ese BPM; sin BPM, los IOIs
     normalizados por tempo. */
  function rhythmPatternLabel(starts, bpm) {
    var iois = ioisFromStarts(starts);
    if (iois.length < 2) return null;
    if (typeof bpm === 'number' && bpm > 0) {
      var pat = rhythmPattern(starts, bpm);
      if (!pat) return null;
      return pat.quantized.map(beatsLabel).join(' · ') + ' pulsos';
    }
    return normalizeIois(iois).map(function (v) {
      return (Math.round(v * 100) / 100).toString();
    }).join(' · ') + ' (relativo al pulso tarareado)';
  }

  /* Texto del tarareo con ritmo para mostrarlo al usuario. */
  function humRhythmSummary(notes, bpm, keys, starts) {
    var parts = [];
    var names = (notes || []).map(function (n) { return n.name; }).join(' ');
    if (names) parts.push('Notas: ' + names);
    parts.push(bpm ? ('Ritmo: ~' + bpm + ' BPM') : 'Ritmo: no se pudo estimar');
    var pat = rhythmPatternLabel(starts, bpm);
    parts.push(pat ? ('Patrón: ' + pat) : 'Patrón: no se pudo estimar');
    parts.push(keys && keys.length
      ? ('Tonalidad probable: ' + keys.join(' o ') + ' (aproximada)')
      : 'Tonalidad: no se pudo estimar');
    return parts.join(' · ');
  }

  var APPROX_NOTE = 'Coincidencia aproximada: comparamos el patrón rítmico tarareado (duraciones entre notas, normalizadas por tempo) con la rejilla de pulsos que implica el BPM analizado de cada canción, además de su BPM y su tonalidad Camelot. La app no guarda melodías ni patrones rítmicos de las canciones, así que la melodía tarareada no se compara nota a nota y el ritmo se compara contra una rejilla regular, no contra el ritmo real de la canción.';

  /* ================= Parte de navegador (DOM / micrófono) ================= */

  var recording = false;
  var mediaStream = null;
  var mediaRecorder = null;
  var recordTimer = null;
  var panelEl = null;
  var btnEl = null;
  var statusTimer = null;

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  /* El módulo de tarareo base: sin él no hay detección de tono.
     Se lee en cada uso (no se cachea) por si carga después. */
  function tarareoBase() {
    try {
      return (typeof window !== 'undefined' && window.__rpmTarareo) || null;
    } catch (e) { return null; }
  }

  function isSupported() {
    try {
      return !!tarareoBase() &&
        !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
        !!(window.AudioContext || window.webkitAudioContext) &&
        typeof window.MediaRecorder !== 'undefined';
    } catch (e) { return false; }
  }

  function getTracks() {
    try {
      if (window.__rpmApp && typeof window.__rpmApp.getTracks === 'function') {
        var t = window.__rpmApp.getTracks();
        return Array.isArray(t) ? t : [];
      }
    } catch (e) { /* sin acceso a la biblioteca */ }
    return [];
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./tarareo-ritmo.css"]')) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './tarareo-ritmo.css';
      document.head.appendChild(link);
    } catch (e) { /* sin CSS el botón sigue funcionando */ }
  }

  function setStatus(text) {
    try {
      var pill = $('rpmTarareoRitmoStatus');
      if (!pill) return;
      if (!text) { pill.textContent = ''; pill.classList.remove('on'); return; }
      pill.textContent = text;
      pill.classList.add('on');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(function () { setStatus(''); }, 5000);
    } catch (e) { /* nada */ }
  }

  function showPanel(html) {
    try {
      if (!panelEl) return;
      panelEl.innerHTML = html;
      panelEl.classList.add('on');
      panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { /* nada */ }
  }

  function hidePanel() {
    try {
      if (panelEl) { panelEl.classList.remove('on'); panelEl.innerHTML = ''; }
    } catch (e) { /* nada */ }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Reproduce una canción haciendo click en su fila real de la
     biblioteca (misma lógica que tarareo.js). */
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
          else setStatus('No encontré esa canción en la lista visible.');
        } catch (e) { /* nada */ }
      }, 250);
      return true;
    } catch (e) { return false; }
  }

  function renderResults(notes, hum, ranked) {
    var html = '<div class="rpm-tarareo-ritmo-head"><strong>🎤♪ Tarareo por ritmo</strong>' +
      '<button type="button" class="rpm-tarareo-ritmo-close" aria-label="Cerrar resultados">✕</button></div>' +
      '<p class="rpm-tarareo-ritmo-hum">' + esc(humRhythmSummary(notes, hum.bpm, hum.keys, hum.starts)) + '</p>' +
      '<p class="rpm-tarareo-ritmo-note">' + esc(APPROX_NOTE) + '</p>';
    if (!ranked.total) {
      html += '<p class="rpm-tarareo-ritmo-empty">Tu biblioteca está vacía. Añade canciones primero.</p>';
    } else if (!ranked.analyzed) {
      html += '<p class="rpm-tarareo-ritmo-empty">No hay canciones analizadas todavía: ninguna tiene BPM ni tonalidad detectados. Usa «Analizar» en la biblioteca y vuelve a intentarlo.</p>';
    } else if (!ranked.candidates.length) {
      html += '<p class="rpm-tarareo-ritmo-empty">No se pudo puntuar ninguna canción con este tarareo.</p>';
    } else {
      html += '<ol class="rpm-tarareo-ritmo-list">';
      ranked.candidates.forEach(function (c, i) {
        var t = c.track;
        var why = [];
        if (c.parts.bpm !== null) why.push(typeof t.bpm === 'number' ? (t.bpm + ' BPM') : '');
        if (c.parts.key !== null && t.musicalKey) why.push('tonalidad ' + t.musicalKey);
        if (c.parts.rhythm !== null) why.push('ritmo ' + Math.round(c.parts.rhythm * 100) + '%');
        else why.push('ritmo: sin datos');
        html += '<li class="rpm-tarareo-ritmo-item">' +
          '<button type="button" class="rpm-tarareo-ritmo-play" data-track-id="' + esc(t.id) + '">' +
          '<span class="rpm-tarareo-ritmo-rank">' + (i + 1) + '</span>' +
          '<span class="rpm-tarareo-ritmo-titles"><span class="rpm-tarareo-ritmo-title">' + esc(t.title || 'Sin título') + '</span>' +
          '<span class="rpm-tarareo-ritmo-sub">' + esc(t.artist || 'Sin artista') +
          (why.length ? ' · ' + esc(why.filter(Boolean).join(' · ')) : '') + '</span></span>' +
          '<span class="rpm-tarareo-ritmo-score">' + c.score + '%</span>' +
          '<span class="rpm-tarareo-ritmo-play-label">▶</span>' +
          '</button></li>';
      });
      html += '</ol>';
      if (ranked.unanalyzed > 0) {
        html += '<p class="rpm-tarareo-ritmo-note">' + ranked.unanalyzed + ' de ' + ranked.total +
          ' canciones no tienen BPM ni tonalidad analizados y no se compararon.</p>';
      }
    }
    showPanel(html);
    try {
      var close = panelEl.querySelector('.rpm-tarareo-ritmo-close');
      if (close) close.addEventListener('click', hidePanel);
      Array.prototype.forEach.call(panelEl.querySelectorAll('.rpm-tarareo-ritmo-play'), function (b) {
        b.addEventListener('click', function () {
          playTrackById(b.getAttribute('data-track-id'));
        });
      });
    } catch (e) { /* nada */ }
  }

  /* Analiza el audio grabado reutilizando la detección de tono de
     tarareo.js: tono por tramo -> notas -> BPM, tonalidad probable
     e inicios de nota (para el patrón rítmico). Todo en el
     dispositivo. */
  function analyzeAudio(arrayBuffer) {
    var base = tarareoBase();
    if (!base) return Promise.resolve(null);
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    return ctx.decodeAudioData(arrayBuffer).then(function (buf) {
      var data = buf.getChannelData(0);
      var sr = buf.sampleRate;
      var hop = Math.floor(sr * FRAME_MS / 1000);
      var frames = [];
      for (var start = 0; start + FRAME_SIZE <= data.length; start += hop) {
        var frame = data.subarray(start, start + FRAME_SIZE);
        frames.push({ t: start / sr, freq: base.detectPitch(frame, sr) });
      }
      var notes = base.notesFromFrequencies(frames);
      var bpm = base.estimateBpmFromOnsets(notes.map(function (n) { return n.start; }));
      var keys = base.humKeysFromNotes(notes);
      var starts = notes.map(function (n) { return n.start; });
      try { ctx.close(); } catch (e) { /* nada */ }
      return { notes: notes, bpm: bpm, keys: keys, starts: starts };
    }).catch(function () {
      try { ctx.close(); } catch (e) { /* nada */ }
      return null;
    });
  }

  function stopStream() {
    try {
      if (mediaStream) mediaStream.getTracks().forEach(function (tr) { tr.stop(); });
    } catch (e) { /* nada */ }
    mediaStream = null;
    mediaRecorder = null;
    if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }
    recording = false;
    if (btnEl) {
      btnEl.classList.remove('listening');
      btnEl.setAttribute('aria-pressed', 'false');
      btnEl.textContent = '🎤♪';
    }
  }

  function finishRecording(blob) {
    stopStream();
    setStatus('Analizando el ritmo de tu tarareo…');
    blob.arrayBuffer().then(function (ab) { return analyzeAudio(ab); }).then(function (res) {
      if (!res) { setStatus('No se pudo analizar el audio. Inténtalo de nuevo.'); return; }
      if (!res.notes.length || res.notes.length < MIN_NOTES) {
        setStatus('No se distinguieron notas. Tararea más fuerte y más claro.');
        return;
      }
      var hum = { bpm: res.bpm, keys: res.keys, starts: res.starts };
      var ranked = rankCandidatesRhythm(hum, getTracks(), TOP_N);
      renderResults(res.notes, hum, ranked);
      setStatus(ranked.candidates.length
        ? ('Tarareo por ritmo analizado: ' + ranked.candidates.length + ' candidatos.')
        : 'Tarareo por ritmo analizado, sin candidatos.');
    }).catch(function () {
      setStatus('No se pudo analizar el audio. Inténtalo de nuevo.');
    });
  }

  function startListening() {
    if (recording) { stopListening(); return; }
    if (!tarareoBase()) {
      setStatus('El tarareo por ritmo necesita el módulo de tarareo (tarareo.js). Actívalo y vuelve a intentarlo.');
      return;
    }
    if (!isSupported()) {
      setStatus('Tu navegador no permite grabar con el micrófono aquí. Prueba en Chrome, Edge o Safari con HTTPS.');
      return;
    }
    var tracks = getTracks();
    if (!tracks.length) {
      setStatus('Tu biblioteca está vacía. Añade canciones primero.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      mediaStream = stream;
      var rec;
      try { rec = new MediaRecorder(stream); } catch (e) {
        stopStream();
        setStatus('Tu navegador no permite grabar con el micrófono aquí.');
        return;
      }
      mediaRecorder = rec;
      var chunks = [];
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () {
        var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        finishRecording(blob);
      };
      rec.onerror = function () {
        stopStream();
        setStatus('La grabación falló. Inténtalo de nuevo.');
      };
      try { rec.start(); } catch (e) {
        stopStream();
        setStatus('La grabación falló. Inténtalo de nuevo.');
        return;
      }
      recording = true;
      if (btnEl) {
        btnEl.classList.add('listening');
        btnEl.setAttribute('aria-pressed', 'true');
        btnEl.textContent = '■';
      }
      setStatus('Grabando… tararea ahora (6 s, toca ■ para parar).');
      recordTimer = setTimeout(function () {
        try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); }
        catch (e) { stopStream(); }
      }, RECORD_MS);
    }).catch(function (err) {
      stopStream();
      var name = (err && err.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('Permiso de micrófono denegado. Actívalo en el navegador e inténtalo de nuevo.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('No se encontró micrófono en este dispositivo.');
      } else if (name === 'NotReadableError') {
        setStatus('El micrófono está en uso por otra app. Ciérrala e inténtalo de nuevo.');
      } else {
        setStatus('No se pudo usar el micrófono. Inténtalo de nuevo.');
      }
    });
  }

  function stopListening() {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      else stopStream();
    } catch (e) { stopStream(); }
  }

  function init() {
    try {
      ensureCss();
      if ($('rpmTarareoRitmoBtn')) { btnEl = $('rpmTarareoRitmoBtn'); }
      else {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'rpmTarareoRitmoBtn';
        btn.className = 'rpm-tarareo-ritmo-btn';
        btn.textContent = '🎤♪';
        btn.setAttribute('aria-label', 'Buscar por tarareo por ritmo: pulsa y tararea una canción');
        btn.setAttribute('aria-pressed', 'false');
        if (!isSupported()) btn.classList.add('rpm-tarareo-ritmo-unsupported');
        // Junto al botón 🎤 de tarareo si existe; si no, junto al
        // buscador; si tampoco, al final del body. Nunca rompe nada.
        var anchor = $('rpmTarareoBtn');
        if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(btn, anchor.nextSibling);
        else {
          var search = $('search');
          var libTools = null;
          if (search && search.closest) libTools = search.closest('.lib-tools') || search.parentElement;
          if (libTools) libTools.appendChild(btn);
          else {
            var secondary = document.querySelector('.secondary-row');
            if (secondary) secondary.appendChild(btn);
            else if (document.body) document.body.appendChild(btn);
            else return;
          }
        }
        btnEl = btn;
      }
      btnEl.addEventListener('click', startListening);
      // Panel propio, junto al panel de tarareo si existe; si no,
      // después de .lib-tools; si tampoco, al final del body.
      if (!$('rpmTarareoRitmoPanel')) {
        var panel = document.createElement('div');
        panel.id = 'rpmTarareoRitmoPanel';
        panel.className = 'rpm-tarareo-ritmo-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Resultados de buscar por tarareo por ritmo');
        var tarareoPanel = $('rpmTarareoPanel');
        if (tarareoPanel && tarareoPanel.parentElement) {
          tarareoPanel.parentElement.insertBefore(panel, tarareoPanel.nextSibling);
        } else {
          var libTools2 = document.querySelector('.lib-tools');
          if (libTools2 && libTools2.parentElement) libTools2.parentElement.insertBefore(panel, libTools2.nextSibling);
          else if (document.body) document.body.appendChild(panel);
        }
        panelEl = panel;
      } else panelEl = $('rpmTarareoRitmoPanel');
      // Píldora de estado propia.
      if (!$('rpmTarareoRitmoStatus')) {
        var pill = document.createElement('div');
        pill.id = 'rpmTarareoRitmoStatus';
        pill.className = 'rpm-tarareo-ritmo-status';
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        document.body.appendChild(pill);
      }
    } catch (e) { /* el módulo falla silencioso: la app sigue igual */ }
  }

  /* ================= Exportación (Node + consola) ================= */

  var api = {
    median: median,
    ioisFromStarts: ioisFromStarts,
    normalizeIois: normalizeIois,
    ioisInBeats: ioisInBeats,
    quantizeIoi: quantizeIoi,
    rhythmPattern: rhythmPattern,
    rhythmScore: rhythmScore,
    patternSimilarity: patternSimilarity,
    parseCamelot: parseCamelot,
    camelotScore: camelotScore,
    bpmScore: bpmScore,
    scoreCandidateRhythm: scoreCandidateRhythm,
    rankCandidatesRhythm: rankCandidatesRhythm,
    rhythmPatternLabel: rhythmPatternLabel,
    humRhythmSummary: humRhythmSummary,
    APPROX_NOTE: APPROX_NOTE,
    GRID: GRID,
    RECORD_MS: RECORD_MS,
    TOP_N: TOP_N,
    MIN_NOTES: MIN_NOTES
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    global.__rpmTarareoRitmo = api;
    global.__rpmTarareoRitmoStart = startListening;
    global.__rpmTarareoRitmoStop = stopListening;
    global.__rpmTarareoRitmoState = function () {
      return { supported: isSupported(), recording: recording, tarareoBase: !!tarareoBase() };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
