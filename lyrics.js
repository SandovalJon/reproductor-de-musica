/* Letras sincronizadas (LRC) para Reproductor de Música — módulo aparte.
   No toca el código de index.html: se engancha solo al <audio id="audio">
   y a #nowTitle / #nowArtist que ya existen en la app.
   Uso: carga un archivo .lrc con el mismo nombre de la canción, o pega
   la letra con tiempos [mm:ss.xx]. Se guarda por canción en localStorage. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function keyFor() {
    var t = $('nowTitle') ? $('nowTitle').textContent : '';
    var a = $('nowArtist') ? $('nowArtist').textContent : '';
    return 'reproductor-letras:' + norm(t) + ' — ' + norm(a);
  }

  /* Parser LRC: [00:12.34] texto, varias marcas por línea, [offset:+500] */
  function parseLRC(text) {
    var lines = [], offset = 0, plain = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/^\uFEFF/, '');
      var mOff = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
      if (mOff) { offset = parseInt(mOff[1], 10) || 0; return; }
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      var times = [], rest = line;
      var m;
      var re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
      while ((m = re.exec(line)) !== null) {
        var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        var frac = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0;
        times.push(sec + frac);
      }
      rest = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      if (times.length) {
        times.forEach(function (t) { lines.push({ t: t + offset / 1000, text: rest || '♪' }); });
      } else if (rest) { plain.push(rest); }
    });
    lines.sort(function (a, b) { return a.t - b.t; });
    if (!lines.length && plain.length) {
      return { synced: false, lines: plain.map(function (p) { return { t: 0, text: p }; }) };
    }
    return { synced: lines.length > 0, lines: lines };
  }

  var state = { data: null, current: -1, autoScroll: true };

  function renderList() {
    var box = $('lyricsLines'); if (!box) return;
    box.innerHTML = '';
    if (!state.data || !state.data.lines.length) {
      box.innerHTML = '<p class="lyrics-empty">Sin letra para esta canción.<br>Carga un archivo .lrc o pega la letra con tiempos.</p>';
      return;
    }
    state.data.lines.forEach(function (ln, i) {
      var div = document.createElement('button');
      div.type = 'button';
      div.className = 'lyrics-line';
      div.textContent = ln.text;
      div.setAttribute('data-i', String(i));
      div.addEventListener('click', function () {
        var audio = $('audio'); if (!audio) return;
        audio.currentTime = ln.t;
        if (audio.paused) audio.play().catch(function () {});
      });
      box.appendChild(div);
    });
    state.current = -1;
    sync();
  }

  function sync() {
    if (!state.data || !state.data.synced) return;
    var audio = $('audio'); if (!audio) return;
    var t = audio.currentTime || 0, idx = -1;
    for (var i = 0; i < state.data.lines.length; i++) {
      if (state.data.lines[i].t <= t + 0.05) idx = i; else break;
    }
    if (idx === state.current) return;
    state.current = idx;
    var box = $('lyricsLines'); if (!box) return;
    var prev = box.querySelector('.lyrics-line.active');
    if (prev) prev.classList.remove('active');
    if (idx >= 0) {
      var el = box.children[idx];
      if (el) {
        el.classList.add('active');
        if (state.autoScroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function loadForCurrentTrack() {
    var raw = null;
    try { raw = localStorage.getItem(keyFor()); } catch (e) { raw = null; }
    state.data = raw ? parseLRC(raw) : null;
    var title = $('lyricsTitle');
    if (title) title.textContent = ($('nowTitle') ? $('nowTitle').textContent : '') || 'Sin canción';
    renderList();
  }

  function save(text) {
    try { localStorage.setItem(keyFor(), text); } catch (e) {}
    state.data = parseLRC(text);
    renderList();
  }

  function buildUI() {
    if ($('lyricsBtn')) return;
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = './lyrics.css';
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.id = 'lyricsBtn'; btn.type = 'button';
    btn.textContent = '♪ Letras';
    btn.title = 'Ver la letra sincronizada de la canción actual';
    btn.addEventListener('click', function () {
      var p = $('lyricsPanel');
      if (p) { p.classList.toggle('open'); if (p.classList.contains('open')) loadForCurrentTrack(); }
    });
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'lyricsPanel';
    panel.innerHTML =
      '<div class="lyrics-head">' +
        '<div><strong id="lyricsTitle">Sin canción</strong><span>Letra sincronizada (LRC)</span></div>' +
        '<button type="button" id="lyricsClose" aria-label="Cerrar">✕</button>' +
      '</div>' +
      '<div class="lyrics-actions">' +
        '<label class="lyrics-file">Cargar .lrc<input type="file" id="lyricsFile" accept=".lrc,.txt" hidden></label>' +
        '<button type="button" id="lyricsPaste">Pegar letra</button>' +
        '<button type="button" id="lyricsClear">Quitar</button>' +
        '<label class="lyrics-scroll"><input type="checkbox" id="lyricsAuto" checked> Seguir</label>' +
      '</div>' +
      '<textarea id="lyricsPasteBox" placeholder="[00:05.00] Primera línea&#10;[00:10.00] Segunda línea" hidden></textarea>' +
      '<button type="button" id="lyricsSavePaste" hidden>Guardar letra</button>' +
      '<div id="lyricsLines" class="lyrics-lines"></div>';
    document.body.appendChild(panel);

    $('lyricsClose').addEventListener('click', function () { panel.classList.remove('open'); });
    $('lyricsFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { save(String(r.result || '')); };
      r.readAsText(f);
      e.target.value = '';
    });
    $('lyricsPaste').addEventListener('click', function () {
      var b = $('lyricsPasteBox'), s = $('lyricsSavePaste');
      var show = b.hidden; b.hidden = !show; s.hidden = !show;
      if (show) b.focus();
    });
    $('lyricsSavePaste').addEventListener('click', function () {
      save($('lyricsPasteBox').value);
      $('lyricsPasteBox').hidden = true; $('lyricsSavePaste').hidden = true;
    });
    $('lyricsClear').addEventListener('click', function () {
      try { localStorage.removeItem(keyFor()); } catch (e) {}
      state.data = null; renderList();
    });
    $('lyricsAuto').addEventListener('change', function (e) { state.autoScroll = e.target.checked; });

    var audio = $('audio');
    if (audio) audio.addEventListener('timeupdate', sync);
    // Detectar cambio de canción por el título que ya muestra la app.
    var last = '';
    setInterval(function () {
      var t = ($('nowTitle') ? $('nowTitle').textContent : '') + '|' + ($('nowArtist') ? $('nowArtist').textContent : '');
      if (t !== last) { last = t; if ($('lyricsPanel') && $('lyricsPanel').classList.contains('open')) loadForCurrentTrack(); }
    }, 600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();

  // Para probar el parser desde la consola: window.__lyricsParse(text)
  window.__lyricsParse = parseLRC;
})();
