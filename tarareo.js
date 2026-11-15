/* Buscar por tarareo para Reproductor de Música — v3.7.0.
   Módulo aparte: NO toca index.html ni la lógica de reproducción.
   Se engancha solo por DOM a lo que ya existe en la app:
     window.__rpmApp.getTracks() (línea ~12760 de app/index.html),
     #search (línea 1307), #trackList (línea 1429, filas con
     data-track-id, línea 3671) y la pestaña [data-view="library"].

   Qué hace:
   - Un botón de micrófono 🎤 junto al buscador (#search). Al
     pulsarlo pide permiso de micrófono y graba ~6 s de tarareo
     (un segundo toque detiene antes). Nunca graba en segundo plano.
   - Detecta el tono de cada tramo por autocorrelación
     (detectPitch, pura y testeable en Node) y construye el contorno
     de notas tarareadas, que se muestra al usuario.
   - Compara el tarareo con la biblioteca SOLO con lo que se puede
     medir: el BPM estimado de los cambios de nota y la tonalidad
     probable (clase de tono más frecuente → códigos Camelot mayor
     y menor), contra el bpm y el musicalKey (Camelot, formato
     ^\d{1,2}[AB]$, igual que la app) que la app ya analizó por
     canción. La energía analizada de cada canción se MUESTRA como
     dato, pero NO entra en la puntuación: el volumen del tarareo
     no es comparable con la energía analizada de una pista.
   - NO compara melodías nota a nota: la app no guarda melodías de
     las canciones, así que no hay nada contra lo que comparar el
     contorno. El panel lo dice claro: es una coincidencia
     APROXIMADA por ritmo y tonalidad, no una identificación.
   - Reproducir un candidato = hacer click en su fila real de
     #trackList (la app hace el resto: cola, crossfade, etc.).
     Si la fila no está visible (búsqueda activa), limpia #search,
     vuelve a la vista Biblioteca y reintenta.

   Sin micrófono (sin permiso, sin soporte, sin micrófono) lo dice
   y no falla. Sin canciones analizadas (sin bpm ni musicalKey en
   ninguna pista) lo dice. Si un elemento de la app no existe, el
   módulo no hace nada: la app sigue igual.

   FAIL-SAFE: todo el init y cada acción van en try/catch; si
   tarareo.js no carga, la app queda byte-idéntica.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./tarareo.css">
     <script src="./tarareo.js"></script>
   Pruebas Node: node --test tarareo.test.mjs
   Prueba desde la consola:
     window.__rpmTarareo.state()
     window.__rpmTarareo.start() / window.__rpmTarareo.stop()
     window.__rpmTarareo.rank({ bpm: 120, keys: ['8B', '8A'] },
       window.__rpmApp.getTracks()) */
(function (global) {
  'use strict';

  /* ================= Constantes ================= */

  var RECORD_MS = 6000;          // segundos de tarareo por pulsación
  var FRAME_MS = 100;            // un tono cada 100 ms
  var FRAME_SIZE = 2048;         // muestras por ventana de autocorrelación
  var FREQ_MIN = 80;             // Hz: por debajo es ruido/grave no vocal
  var FREQ_MAX = 1000;           // Hz: por encima no es tarareo
  var MIN_RMS = 0.008;           // RMS mínimo absoluto para considerar voz
  var MIN_NOTES = 3;             // notas distintas mínimas para puntuar
  var TOP_N = 5;                 // candidatos que se muestran
  var PANEL_MS = 0;              // el panel se queda hasta cerrarlo
  var BPM_MIN = 40, BPM_MAX = 240;
  var KEY_AMBIGUITY_CAP = 0.75;  // la tonalidad tarareada es mayor/menor
                                 // ambigua: su peso nunca llega a 1

  /* ================= Núcleo puro (probable en Node) ================= */

  /* Autocorrelación normalizada con interpolación parabólica.
     samples: Float32Array (o Array) mono. Devuelve la frecuencia
     fundamental en Hz, o null si no hay tono claro (silencio,
     ruido, muestra demasiado corta). Rango 80-1000 Hz. */
  function detectPitch(samples, sampleRate) {
    if (!samples || !sampleRate || sampleRate <= 0) return null;
    var n = samples.length;
    if (n < FRAME_SIZE) return null;
    var minLag = Math.max(1, Math.floor(sampleRate / FREQ_MAX));
    var maxLag = Math.min(Math.floor(sampleRate / FREQ_MIN), n - 1);
    if (maxLag <= minLag) return null;
    // Energía: sin señal no hay tono.
    var rms = 0, i, lag, sum;
    for (i = 0; i < n; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / n);
    if (!(rms > MIN_RMS)) return null;
    // Autocorrelación normalizada por el lag 0 (energía total).
    var c0 = 0;
    for (i = 0; i < n; i++) c0 += samples[i] * samples[i];
    if (c0 <= 0) return null;
    var bestLag = -1, bestVal = -Infinity;
    for (lag = minLag; lag <= maxLag; lag++) {
      sum = 0;
      for (i = 0; i + lag < n; i++) sum += samples[i] * samples[i + lag];
      var v = sum / c0;
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    // Un tono real tiene correlación alta; ruido/silencio no.
    if (bestLag < 0 || bestVal < 0.5) return null;
    // Interpolación parabólica alrededor del pico (medio lag de precisión).
    var y0 = 0, y1 = bestVal, y2 = 0;
    if (bestLag > minLag && bestLag < maxLag) {
      var s0 = 0, s2 = 0;
      for (i = 0; i + bestLag - 1 < n; i++) s0 += samples[i] * samples[i + bestLag - 1];
      for (i = 0; i + bestLag + 1 < n; i++) s2 += samples[i] * samples[i + bestLag + 1];
      y0 = s0 / c0; y2 = s2 / c0;
      var denom = (y0 - 2 * y1 + y2);
      if (denom !== 0) {
        var shift = 0.5 * (y0 - y2) / denom;
        if (isFinite(shift) && Math.abs(shift) <= 1) bestLag = bestLag + shift;
      }
    }
    var freq = sampleRate / bestLag;
    if (!isFinite(freq) || freq < FREQ_MIN || freq > FREQ_MAX) return null;
    return freq;
  }

  /* Frecuencia -> nota MIDI (69 = A4 = 440 Hz). */
  function freqToMidi(freq) {
    if (typeof freq !== 'number' || !isFinite(freq) || freq <= 0) return null;
    return Math.round(69 + 12 * Math.log2(freq / 440));
  }

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  /* MIDI -> nombre, p. ej. 69 -> "A4", 60 -> "C4". */
  function midiToNoteName(midi) {
    if (typeof midi !== 'number' || !isFinite(midi)) return null;
    var m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  /* Frecuencia -> { midi, name, pc } (pc = clase de tono 0-11, C=0)
     o null si no es una frecuencia válida. */
  function freqToNote(freq) {
    var midi = freqToMidi(freq);
    if (midi === null) return null;
    return { midi: midi, name: midiToNoteName(midi), pc: ((midi % 12) + 12) % 12 };
  }

  /* Frecuencias por tramo (con null en los tramos sin tono) ->
     contorno de notas: colapsa tramos consecutivos con la misma
     nota y anota el instante de inicio de cada nota.
     Entrada: [{ t: segundos, freq: Hz|null }]. Salida:
     [{ midi, name, pc, start, frames }] (frames = nº de tramos). */
  function notesFromFrequencies(frames) {
    var notes = [];
    var cur = null;
    (frames || []).forEach(function (f) {
      if (!f || typeof f.freq !== 'number' || !isFinite(f.freq) || f.freq <= 0) {
        cur = null;
        return;
      }
      var note = freqToNote(f.freq);
      if (!note) { cur = null; return; }
      if (cur && cur.midi === note.midi) { cur.frames++; return; }
      cur = { midi: note.midi, name: note.name, pc: note.pc, start: f.t, frames: 1 };
      notes.push(cur);
    });
    return notes;
  }

  /* Contorno normalizado: intervalos en semitonos respecto a la
     primera nota (transposición-invariante). [0, +2, -1, ...].
     Es lo que se muestra al usuario; NO se compara con las
     canciones porque la app no guarda sus melodías. */
  function normalizeContour(notes) {
    if (!notes || !notes.length) return [];
    var base = notes[0].midi;
    return notes.map(function (n) { return n.midi - base; });
  }

  /* Instantes de inicio de nota -> BPM estimado: la mediana del
     intervalo entre inicios (un tarareo suele cambiar de nota a
     ritmo de pulso). null con <3 inicios o fuera de 40-240 BPM. */
  function estimateBpmFromOnsets(starts) {
    if (!starts || starts.length < 3) return null;
    var gaps = [];
    for (var i = 1; i < starts.length; i++) {
      var g = starts[i] - starts[i - 1];
      if (g > 0) gaps.push(g);
    }
    if (gaps.length < 2) return null;
    gaps.sort(function (a, b) { return a - b; });
    var med = gaps.length % 2
      ? gaps[(gaps.length - 1) / 2]
      : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
    if (!(med > 0)) return null;
    var bpm = 60 / med;
    if (bpm < BPM_MIN || bpm > BPM_MAX) return null;
    return Math.round(bpm);
  }

  /* Histograma de clases de tono (0-11) ponderado por duración. */
  function pitchClassHistogram(notes) {
    var h = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    (notes || []).forEach(function (n) {
      if (n && typeof n.pc === 'number') h[n.pc] += (n.frames || 1);
    });
    return h;
  }

  /* Clase de tono más frecuente (la tónica probable) o null. */
  function tonicPitchClass(notes) {
    var h = pitchClassHistogram(notes);
    var best = -1, bestPc = null;
    for (var pc = 0; pc < 12; pc++) {
      if (h[pc] > best) { best = h[pc]; bestPc = pc; }
    }
    return best > 0 ? bestPc : null;
  }

  /* Camelot para una tónica: mayor (B) o menor (A). La rueda Camelot
     de mayores: C=8B G=9B D=10B A=11B E=12B B=1B F#=2B Db=3B Ab=4B
     Eb=5B Bb=6B F=7B. La de menores es la relativa (3 semitonos
     por debajo): A=8A E=9A B=10A F#=11A C#=12A G#=1A D#=2A A#=3A
     F=4A C=5A G=6A D=7A. */
  var MAJOR_CAMELOT = { 0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7 };
  function camelotForPitchClass(pc, mode) {
    if (typeof pc !== 'number' || pc < 0 || pc > 11) return null;
    if (mode === 'major') return MAJOR_CAMELOT[pc] + 'B';
    if (mode === 'minor') return MAJOR_CAMELOT[(pc + 3) % 12] + 'A';
    return null;
  }

  /* Tónica tarareada -> códigos Camelot candidatos [mayor, menor].
     Ambiguo por construcción: tararear no dice si es mayor o menor. */
  function humKeysFromNotes(notes) {
    var pc = tonicPitchClass(notes);
    if (pc === null) return [];
    return [camelotForPitchClass(pc, 'major'), camelotForPitchClass(pc, 'minor')];
  }

  /* "8A" -> { n: 8, l: "A" } o null. Mismo formato que la app
     (parseCamelot, línea ~10256 de app/index.html). */
  function parseCamelot(code) {
    var m = /^(\d{1,2})([AB])$/.exec(code || '');
    return m ? { n: parseInt(m[1], 10), l: m[2] } : null;
  }

  /* Cercanía armónica 0-1 entre dos códigos Camelot, con la misma
     escala que el DJ de la app: misma tonalidad 1, ±1 en la rueda
     (misma letra) 0.75, relativa mayor/menor 0.6, ±1 con otra letra
     0.35, resto 0. */
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

  /* Cercanía de BPM 0-1: 1 si coincide, cae linealmente hasta 0
     con un 50% de diferencia relativa. */
  function bpmScore(trackBpm, humBpm) {
    if (typeof trackBpm !== 'number' || !(trackBpm > 0) ||
        typeof humBpm !== 'number' || !(humBpm > 0)) return null;
    var rel = Math.abs(trackBpm - humBpm) / humBpm;
    return Math.max(0, 1 - rel / 0.5);
  }

  /* Puntuación 0-100 de una canción para un tarareo.
     hum: { bpm: number|null, keys: [Camelot...] }.
     Solo entran BPM y tonalidad; la energía NO puntúa (ver cabecera).
     Si solo hay un dato, ese dato es el 100% de la puntuación.
     Sin ningún dato comparable: null (canción no analizada). */
  function scoreCandidate(hum, track) {
    if (!hum || !track) return null;
    var parts = { bpm: null, key: null };
    var weights = { bpm: 0, key: 0 };
    var b = bpmScore(track.bpm, hum.bpm);
    if (b !== null) { parts.bpm = b; weights.bpm = 0.5; }
    if (hum.keys && hum.keys.length && track.musicalKey) {
      var k = 0;
      hum.keys.forEach(function (hk) {
        k = Math.max(k, camelotScore(hk, track.musicalKey));
      });
      // La tonalidad tarareada es mayor/menor ambigua: tope 0.75.
      k = Math.min(k, KEY_AMBIGUITY_CAP);
      parts.key = k; weights.key = 0.5;
    }
    var w = weights.bpm + weights.key;
    if (w === 0) return null;
    var score = (parts.bpm !== null ? parts.bpm * weights.bpm : 0) +
                (parts.key !== null ? parts.key * weights.key : 0);
    return { score: Math.round((score / w) * 100), parts: parts };
  }

  /* Ordena las canciones analizadas por parecido al tarareo.
     Devuelve { candidates: [{track, score, parts}], analyzed: n,
     total: n, unanalyzed: n }. Solo entran canciones con bpm o
     musicalKey; las demás se cuentan como sin analizar. */
  function rankCandidates(hum, tracks, limit) {
    var list = [];
    var analyzed = 0, total = 0;
    (tracks || []).forEach(function (t) {
      if (!t) return;
      total++;
      var hasData = (typeof t.bpm === 'number' && t.bpm > 0) || !!t.musicalKey;
      if (!hasData) return;
      analyzed++;
      var s = scoreCandidate(hum, t);
      if (s) list.push({ track: t, score: s.score, parts: s.parts });
    });
    list.sort(function (a, b) { return b.score - a.score; });
    var n = (typeof limit === 'number' && limit > 0) ? limit : TOP_N;
    return { candidates: list.slice(0, n), analyzed: analyzed, total: total, unanalyzed: total - analyzed };
  }

  /* Energía analizada (0-1) -> etiqueta legible. Solo se muestra. */
  function energyLabel(energy) {
    if (typeof energy !== 'number' || !isFinite(energy)) return 'sin analizar';
    if (energy >= 0.66) return 'alta';
    if (energy >= 0.33) return 'media';
    return 'baja';
  }

  /* Texto del tarareo detectado para mostrarlo al usuario. */
  function humSummary(notes, bpm, keys) {
    var names = (notes || []).map(function (n) { return n.name; }).join(' ');
    var parts = [];
    if (names) parts.push('Notas: ' + names);
    parts.push(bpm ? ('Ritmo: ~' + bpm + ' BPM') : 'Ritmo: no se pudo estimar');
    parts.push(keys && keys.length
      ? ('Tonalidad probable: ' + keys.join(' o ') + ' (aproximada)')
      : 'Tonalidad: no se pudo estimar');
    return parts.join(' · ');
  }

  var APPROX_NOTE = 'Coincidencia aproximada: comparamos solo el ritmo tarareado y la tonalidad probable con el BPM y la tonalidad Camelot que la app ya analizó. La app no guarda melodías de las canciones, así que la melodía tarareada no se compara nota a nota.';

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

  function isSupported() {
    try {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
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
      if (document.querySelector('link[href="./tarareo.css"]')) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './tarareo.css';
      document.head.appendChild(link);
    } catch (e) { /* sin CSS el botón sigue funcionando */ }
  }

  function setStatus(text) {
    try {
      var pill = $('rpmTarareoStatus');
      if (!pill) return;
      if (!text) { pill.textContent = ''; pill.classList.remove('on'); return; }
      pill.textContent = text;
      pill.classList.add('on');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(function () { setStatus(''); }, 4000);
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
     biblioteca. Si la fila no está visible (búsqueda/filtro activo),
     limpia #search, vuelve a la vista Biblioteca y reintenta. */
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
    var html = '<div class="rpm-tarareo-head"><strong>🎤 Tarareo</strong>' +
      '<button type="button" class="rpm-tarareo-close" aria-label="Cerrar resultados">✕</button></div>' +
      '<p class="rpm-tarareo-hum">' + esc(humSummary(notes, hum.bpm, hum.keys)) + '</p>' +
      '<p class="rpm-tarareo-note">' + esc(APPROX_NOTE) + '</p>';
    if (!ranked.total) {
      html += '<p class="rpm-tarareo-empty">Tu biblioteca está vacía. Añade canciones primero.</p>';
    } else if (!ranked.analyzed) {
      html += '<p class="rpm-tarareo-empty">No hay canciones analizadas todavía: ninguna tiene BPM ni tonalidad detectados. Usa «Analizar» en la biblioteca y vuelve a intentarlo.</p>';
    } else if (!ranked.candidates.length) {
      html += '<p class="rpm-tarareo-empty">No se pudo puntuar ninguna canción con este tarareo.</p>';
    } else {
      html += '<ol class="rpm-tarareo-list">';
      ranked.candidates.forEach(function (c, i) {
        var t = c.track;
        var why = [];
        if (c.parts.bpm !== null) why.push(typeof t.bpm === 'number' ? (t.bpm + ' BPM') : '');
        if (c.parts.key !== null && t.musicalKey) why.push('tonalidad ' + t.musicalKey);
        html += '<li class="rpm-tarareo-item">' +
          '<button type="button" class="rpm-tarareo-play" data-track-id="' + esc(t.id) + '">' +
          '<span class="rpm-tarareo-rank">' + (i + 1) + '</span>' +
          '<span class="rpm-tarareo-titles"><span class="rpm-tarareo-title">' + esc(t.title || 'Sin título') + '</span>' +
          '<span class="rpm-tarareo-sub">' + esc(t.artist || 'Sin artista') +
          (why.length ? ' · ' + esc(why.filter(Boolean).join(' · ')) : '') +
          ' · energía ' + esc(energyLabel(t.energy)) + '</span></span>' +
          '<span class="rpm-tarareo-score">' + c.score + '%</span>' +
          '<span class="rpm-tarareo-play-label">▶</span>' +
          '</button></li>';
      });
      html += '</ol>';
      if (ranked.unanalyzed > 0) {
        html += '<p class="rpm-tarareo-note">' + ranked.unanalyzed + ' de ' + ranked.total +
          ' canciones no tienen BPM ni tonalidad analizados y no se compararon.</p>';
      }
    }
    showPanel(html);
    try {
      var close = panelEl.querySelector('.rpm-tarareo-close');
      if (close) close.addEventListener('click', hidePanel);
      Array.prototype.forEach.call(panelEl.querySelectorAll('.rpm-tarareo-play'), function (b) {
        b.addEventListener('click', function () {
          playTrackById(b.getAttribute('data-track-id'));
        });
      });
    } catch (e) { /* nada */ }
  }

  /* Analiza el audio grabado: tono por tramo -> notas -> BPM y
     tonalidad probable -> candidatos. Todo en el dispositivo. */
  function analyzeAudio(arrayBuffer) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    return ctx.decodeAudioData(arrayBuffer).then(function (buf) {
      var data = buf.getChannelData(0);
      var sr = buf.sampleRate;
      var hop = Math.floor(sr * FRAME_MS / 1000);
      var frames = [];
      for (var start = 0; start + FRAME_SIZE <= data.length; start += hop) {
        var frame = data.subarray(start, start + FRAME_SIZE);
        frames.push({ t: start / sr, freq: detectPitch(frame, sr) });
      }
      var notes = notesFromFrequencies(frames);
      var bpm = estimateBpmFromOnsets(notes.map(function (n) { return n.start; }));
      var keys = humKeysFromNotes(notes);
      try { ctx.close(); } catch (e) { /* nada */ }
      return { notes: notes, bpm: bpm, keys: keys };
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
      btnEl.textContent = '🎤';
    }
  }

  function finishRecording(blob) {
    stopStream();
    setStatus('Analizando tu tarareo…');
    blob.arrayBuffer().then(function (ab) { return analyzeAudio(ab); }).then(function (res) {
      if (!res) { setStatus('No se pudo analizar el audio. Inténtalo de nuevo.'); return; }
      if (!res.notes.length || res.notes.length < MIN_NOTES) {
        setStatus('No se distinguieron notas. Tararea más fuerte y más claro.');
        return;
      }
      var hum = { bpm: res.bpm, keys: res.keys };
      var ranked = rankCandidates(hum, getTracks(), TOP_N);
      renderResults(res.notes, hum, ranked);
      setStatus(ranked.candidates.length
        ? ('Tarareo analizado: ' + ranked.candidates.length + ' candidatos.')
        : 'Tarareo analizado, sin candidatos.');
    }).catch(function () {
      setStatus('No se pudo analizar el audio. Inténtalo de nuevo.');
    });
  }

  function startListening() {
    if (recording) { stopListening(); return; }
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
      if ($('rpmTarareoBtn')) { btnEl = $('rpmTarareoBtn'); }
      else {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'rpmTarareoBtn';
        btn.className = 'rpm-tarareo-btn';
        btn.textContent = '🎤';
        btn.setAttribute('aria-label', 'Buscar por tarareo: pulsa y tararea una canción');
        btn.setAttribute('aria-pressed', 'false');
        if (!isSupported()) btn.classList.add('rpm-tarareo-unsupported');
        // Junto al buscador; si no existe, junto al reproductor; si
        // tampoco, al final del body. Nunca rompe nada si falta.
        var search = $('search');
        var anchor = null;
        if (search && search.closest) anchor = search.closest('.lib-tools') || search.parentElement;
        if (anchor) anchor.appendChild(btn);
        else {
          var secondary = document.querySelector('.secondary-row');
          if (secondary) secondary.appendChild(btn);
          else if (document.body) document.body.appendChild(btn);
          else return;
        }
        btnEl = btn;
      }
      btnEl.addEventListener('click', startListening);
      // Panel de resultados, después de .lib-tools (junto al buscador).
      if (!$('rpmTarareoPanel')) {
        var panel = document.createElement('div');
        panel.id = 'rpmTarareoPanel';
        panel.className = 'rpm-tarareo-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Resultados de buscar por tarareo');
        var libTools = document.querySelector('.lib-tools');
        if (libTools && libTools.parentElement) libTools.parentElement.insertBefore(panel, libTools.nextSibling);
        else if (document.body) document.body.appendChild(panel);
        panelEl = panel;
      } else panelEl = $('rpmTarareoPanel');
      // Píldora de estado (misma idea que voz.js).
      if (!$('rpmTarareoStatus')) {
        var pill = document.createElement('div');
        pill.id = 'rpmTarareoStatus';
        pill.className = 'rpm-tarareo-status';
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        document.body.appendChild(pill);
      }
    } catch (e) { /* el módulo falla silencioso: la app sigue igual */ }
  }

  /* ================= Exportación (Node + consola) ================= */

  var api = {
    detectPitch: detectPitch,
    freqToMidi: freqToMidi,
    midiToNoteName: midiToNoteName,
    freqToNote: freqToNote,
    notesFromFrequencies: notesFromFrequencies,
    normalizeContour: normalizeContour,
    estimateBpmFromOnsets: estimateBpmFromOnsets,
    pitchClassHistogram: pitchClassHistogram,
    tonicPitchClass: tonicPitchClass,
    camelotForPitchClass: camelotForPitchClass,
    humKeysFromNotes: humKeysFromNotes,
    parseCamelot: parseCamelot,
    camelotScore: camelotScore,
    bpmScore: bpmScore,
    scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates,
    energyLabel: energyLabel,
    humSummary: humSummary,
    APPROX_NOTE: APPROX_NOTE,
    RECORD_MS: RECORD_MS,
    TOP_N: TOP_N,
    MIN_NOTES: MIN_NOTES
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try {
    global.__rpmTarareo = api;
    global.__rpmTarareoStart = startListening;
    global.__rpmTarareoStop = stopListening;
    global.__rpmTarareoState = function () {
      return { supported: isSupported(), recording: recording };
    };
  } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
