/* Mezcla automática DJ — capa fina sobre el crossfade y el Modo DJ
   que YA existen en la app (v3.6.0).
   ---------------------------------------------------------------
   HECHO VERIFICADO EN app/index.html (NO duplicar):
   - Crossfade: #btnCrossfade (toggle-pill, aria-pressed), #crossfadeRange
     min=2 max=12 value=6, #crossfadeOut ("6 s"), settings.crossfade /
     settings.crossfadeSec (líneas ~1076-1078, 2337-2338, 5646-5655).
     maybeCrossfade() dispara el fundido cuando quedan crossfadeSec s.
   - "Mezclar ahora": #btnMixNow (jugador) y #btnMixNow2 (panel Sonido);
     fundido puntual de 3 s aunque el crossfade esté apagado.
   - Modo DJ: #btnDjToggle / #djState / #djStatus (líneas ~1506-1509),
     djPickNext() elige la próxima por cercanía de BPM (rel <= 0.15 =
     buena), compatibilidad Camelot, likes/estrellas y sin repetir en
     sesión; la transición usa el crossfade o un fundido corto propio
     del DJ (2 s, startCrossfade(djId, 2) en el avance).
   - BPM: se calcula por pista (estimateBpm/analyzeBpm) y se guarda en
     track.bpm (null si no hay) con track.bpmManual; se ve en la lista
     como "· 123 BPM". La app expone window.__rpmApp.getTracks().
   - APP_VERSION en app/index.html: '3.5.0' (2 ocurrencias); sw.js
     CACHE 'reproductor-musica-3.5.0'. Este módulo es para la 3.6.0.

   LO QUE HACE ESTE MÓDULO (y nada más):
   - Un único interruptor "🎧 Mezcla automática DJ" que enciende JUNTOS
     el crossfade y el Modo DJ existentes haciendo .click() sobre sus
     botones reales (así corren los handlers de la app: saveState,
     toast, syncCrossfadeUI, updateDjUI). Al apagar, restaura lo que
     el usuario tenía antes (si tenía solo uno, vuelve a solo uno).
   - Un panel pequeño con el BPM actual y el de la siguiente, y un aviso
     si el salto de BPM es grande. NUNCA inventa BPM: solo usa el BPM
     ya guardado por pista (vía __rpmApp.getTracks() o, como fallback,
     el texto "· N BPM" que la propia app pinta en el DOM). Sin BPM,
     dice "Sin BPM".
   - Atajo − / + que mueve el #crossfadeRange EXISTENTE (no crea otro
     slider): fija su value y dispara su evento 'input', así la app
     actualiza settings.crossfadeSec, #crossfadeOut y guarda el estado.

   FAIL-SAFE: todo por detección de elementos con guards. Si faltan
   #btnCrossfade o #btnDjToggle (versión distinta), el módulo no monta
   nada y no rompe la app. Cada acceso al DOM va en try/catch. Si el
   script falla al cargar, la app sigue igual: sin este módulo, el
   crossfade y el Modo DJ manuales funcionan exactamente como antes.
   Vanilla JS, sin dependencias. */
(function (global) {
  'use strict';

  var VERSION = '3.6.0';
  var STORE_KEY = 'rpm-dj-auto:v1';
  var CF_MIN = 2, CF_MAX = 12, CF_DEFAULT = 6;
  /* Umbrales de salto de BPM. 0.15 = el umbral que la propia app usa en
     djPickNext() para considerar buena la cercanía de ritmo. */
  var JUMP_OK = 0.15, JUMP_BIG = 0.30;
  /* Fundido corto propio del DJ cuando el crossfade está apagado:
     la app usa startCrossfade(djId, 2) en el avance con DJ. */
  var DJ_SHORT_FADE_SEC = 2;

  /* ================= Partes puras (probadas en Node) ================= */

  /* BPM guardado por pista -> número válido o null. Acepta número, o
     texto de la app ("123 BPM", "· 123 BPM (manual)"). Nunca inventa:
     fuera de 30-300, vacío o no numérico -> null. */
  function parseBpm(input) {
    if (typeof input === 'number') {
      if (!isFinite(input) || input <= 0) return null;
      var n = Math.round(input);
      return (n >= 30 && n <= 300) ? n : null;
    }
    if (typeof input === 'string') {
      var m = input.match(/(\d{2,3})\s*BPM/i);
      if (!m) return null;
      var v = parseInt(m[1], 10);
      return (isFinite(v) && v >= 30 && v <= 300) ? v : null;
    }
    return null;
  }

  function formatBpm(bpm) {
    var v = parseBpm(bpm);
    return v === null ? 'Sin BPM' : v + ' BPM';
  }

  /* Diferencia entre BPM actual y siguiente, o null si falta alguno. */
  function bpmDiff(curBpm, nextBpm) {
    var c = parseBpm(curBpm), n = parseBpm(nextBpm);
    if (c === null || n === null) return null;
    return { diff: n - c, rel: Math.abs(n - c) / c, cur: c, next: n };
  }

  /* 'sin-datos' | 'suave' (<=15%, como el DJ de la app) |
     'moderado' (<=30%) | 'grande' (>30%). */
  function classifyBpmJump(curBpm, nextBpm) {
    var d = bpmDiff(curBpm, nextBpm);
    if (!d) return 'sin-datos';
    if (d.rel <= JUMP_OK) return 'suave';
    if (d.rel <= JUMP_BIG) return 'moderado';
    return 'grande';
  }

  function clampCrossfadeSec(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = (typeof fallback === 'number') ? fallback : CF_DEFAULT;
    return Math.max(CF_MIN, Math.min(CF_MAX, n));
  }

  /* Qué transición usará la app en el próximo cambio de canción.
     No decide nada nuevo: describe lo que la app ya hace. */
  function decideFade(opts) {
    opts = opts || {};
    var crossfadeOn = !!opts.crossfadeOn, djOn = !!opts.djOn;
    var sec = clampCrossfadeSec(opts.crossfadeSec, CF_DEFAULT);
    var jump = classifyBpmJump(opts.curBpm, opts.nextBpm);
    if (crossfadeOn) {
      return {
        mode: 'crossfade', seconds: sec,
        label: 'Crossfade de ' + sec + ' s',
        jump: jump,
        warning: jump === 'grande'
          ? 'Salto grande de BPM: el crossfade de ' + sec + ' s puede sonar brusco.'
          : (jump === 'moderado'
            ? 'Salto moderado de BPM: el crossfade lo suavizará.'
            : null)
      };
    }
    if (djOn) {
      return {
        mode: 'fundido-corto', seconds: DJ_SHORT_FADE_SEC,
        label: 'Fundido corto del DJ (' + DJ_SHORT_FADE_SEC + ' s)',
        jump: jump,
        warning: jump === 'grande'
          ? 'Salto grande de BPM: el fundido corto del DJ puede sonar brusco.'
          : (jump === 'moderado'
            ? 'Salto moderado de BPM.'
            : null)
      };
    }
    return {
      mode: 'ninguno', seconds: 0,
      label: 'Sin fundido (crossfade y DJ apagados)',
      jump: jump,
      warning: jump === 'grande' ? 'Salto grande de BPM y sin fundido: el cambio será un corte.' : null
    };
  }

  /* Plan para llegar a un estado deseado {crossfade, dj} desde el actual:
     {crossfade: true|false|null, dj: true|false|null}; null = ya está
     así, no hay que tocar ese botón. */
  function planTo(desired, current) {
    function need(want, have) {
      want = !!want; have = !!have;
      return want === have ? null : want;
    }
    return {
      crossfade: need(desired && desired.crossfade, current && current.crossfade),
      dj: need(desired && desired.dj, current && current.dj)
    };
  }

  /* Plan para encender la mezcla automática (los dos en true). */
  function planEnable(current) {
    return planTo({ crossfade: true, dj: true }, current);
  }

  /* Plan para restaurar lo que el usuario tenía antes de encenderla. */
  function planRestore(prev, current) {
    if (!prev) return { crossfade: null, dj: null };
    return planTo(prev, current);
  }

  /* Título de la siguiente canción desde los textos que la propia app
     pinta (#djNextText: "La próxima será «Título» de Artista · 123 BPM…";
     #djStatus: "Siguiente según DJ: Título · 8A"). Sin «» ni ":", null. */
  function parseNextTitle(text) {
    if (typeof text !== 'string' || !text) return null;
    var m = text.match(/«(.+?)»/);
    if (m) return m[1].trim() || null;
    var colon = text.indexOf(':');
    if (colon >= 0) {
      var rest = text.slice(colon + 1).trim()
        .replace(/\s*·\s*\d+\s*BPM.*$/i, '')
        .replace(/\s*·\s*\d{1,2}[AB]\b.*$/i, '').trim();
      return rest || null;
    }
    return null;
  }

  function normTitle(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /* Busca una pista por título (y artista si se da) en la lista que la
     app ya tiene. Devuelve la pista o null; nunca inventa BPM. */
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

  /* Todo lo que el panel muestra, en un solo objeto testeable. */
  function buildPanelState(input) {
    input = input || {};
    var fade = decideFade(input);
    var d = bpmDiff(input.curBpm, input.nextBpm);
    var jumpText;
    if (fade.jump === 'sin-datos') jumpText = 'Sin BPM en una o las dos canciones: el DJ elige sin referencia de ritmo.';
    else if (fade.jump === 'suave') jumpText = 'Salto suave (' + (d ? Math.round(d.rel * 100) : 0) + ' %).';
    else if (fade.jump === 'moderado') jumpText = 'Salto moderado (' + (d ? Math.round(d.rel * 100) : 0) + ' %): se notará el cambio de ritmo.';
    else jumpText = '⚠️ Salto grande de BPM (' + (d ? Math.round(d.rel * 100) : 0) + ' %): el cambio de ritmo se notará mucho.';
    return {
      curLabel: formatBpm(input.curBpm),
      nextLabel: formatBpm(input.nextBpm),
      jump: fade.jump,
      jumpText: jumpText,
      fadeLabel: fade.label,
      warning: fade.warning,
      crossfadeSec: clampCrossfadeSec(input.crossfadeSec, CF_DEFAULT)
    };
  }

  /* Exportar lo puro para Node (mismo patrón que cast.js). En el
     navegador, module no existe y no se exporta nada. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseBpm: parseBpm, formatBpm: formatBpm, bpmDiff: bpmDiff,
      classifyBpmJump: classifyBpmJump, clampCrossfadeSec: clampCrossfadeSec,
      decideFade: decideFade, planTo: planTo, planEnable: planEnable,
      planRestore: planRestore, parseNextTitle: parseNextTitle,
      findTrackByTitle: findTrackByTitle, buildPanelState: buildPanelState,
      CF_MIN: CF_MIN, CF_MAX: CF_MAX, CF_DEFAULT: CF_DEFAULT,
      DJ_SHORT_FADE_SEC: DJ_SHORT_FADE_SEC
    };
  }

  /* ================= Capa DOM (todo con guards) ================= */

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function readStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { on: false, prev: null };
      var o = JSON.parse(raw);
      return { on: !!o.on, prev: (o.prev && typeof o.prev === 'object') ? o.prev : null };
    } catch (e) { return { on: false, prev: null }; }
  }

  function writeStored(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ¿Está encendido un toggle-pill de la app? Orden: aria-pressed
     (lo que la app escribe), clase .on, texto del estado. */
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

  function getTracks() {
    try {
      var app = global.__rpmApp;
      if (app && typeof app.getTracks === 'function') {
        var list = app.getTracks();
        if (Array.isArray(list)) return list;
      }
    } catch (e) {}
    return null;
  }

  function textOf(el) {
    try { return (el && el.textContent) ? el.textContent : ''; } catch (e) { return ''; }
  }

  /* BPM actual: 1) pista en __rpmApp.getTracks() que coincida con el
     título/artista que muestra el reproductor; 2) fallback: el texto
     "· N BPM" de la fila .track.active de la lista. */
  function readCurrentBpm() {
    var title = textOf($('nowTitle')).trim();
    var artist = textOf($('nowArtist')).trim();
    var tracks = getTracks();
    if (tracks && title && title !== 'Ninguna canción seleccionada') {
      var tr = findTrackByTitle(tracks, title, artist);
      if (tr) return { bpm: parseBpm(tr.bpm), title: tr.title, manual: !!tr.bpmManual };
    }
    try {
      var row = document.querySelector('.track.active .track-sub');
      var bpm = parseBpm(textOf(row));
      if (bpm !== null) return { bpm: bpm, title: title || null, manual: /\(manual\)/i.test(textOf(row)) };
    } catch (e) {}
    return { bpm: null, title: title || null, manual: false };
  }

  /* BPM de la siguiente según el DJ: solo tiene sentido con el DJ
     encendido, que es cuando la app pinta #djNextText / #djStatus.
     1) título del texto -> pista en getTracks() -> su bpm guardado;
     2) fallback: el "· N BPM" del propio texto. */
  function readNextBpm() {
    var djText = textOf($('djNextText')) || textOf($('djStatus'));
    if (!djText) return { bpm: null, title: null };
    var title = parseNextTitle(djText);
    var tracks = getTracks();
    if (tracks && title) {
      var tr = findTrackByTitle(tracks, title, null);
      if (tr) return { bpm: parseBpm(tr.bpm), title: tr.title, manual: !!tr.bpmManual };
    }
    return { bpm: parseBpm(djText), title: title, manual: /\(manual\)/i.test(djText) };
  }

  function readCrossfadeSec() {
    var range = $('crossfadeRange');
    if (range) return clampCrossfadeSec(range.value, CF_DEFAULT);
    return clampCrossfadeSec(parseBpm(textOf($('crossfadeOut'))), CF_DEFAULT);
  }

  /* Mueve el #crossfadeRange EXISTENTE y dispara su 'input' para que
     la app actualice settings.crossfadeSec, #crossfadeOut y guarde. */
  function setCrossfadeSec(sec) {
    var range = $('crossfadeRange');
    if (!range) return false;
    try {
      var v = clampCrossfadeSec(sec, readCrossfadeSec());
      range.value = String(v);
      var ev;
      try { ev = new Event('input', { bubbles: true }); }
      catch (e) { ev = document.createEvent('Event'); ev.initEvent('input', true, true); }
      range.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }

  /* Enciende/apaga un control real de la app con .click(), solo si
     hace falta. Devuelve true si se pulsó. */
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

  function currentUnderlying() {
    return {
      crossfade: isToggleOn($('btnCrossfade'), $('crossfadeState')),
      dj: isToggleOn($('btnDjToggle'), $('djState'))
    };
  }

  var state = { on: false, prev: null };
  var els = null;

  function refresh() {
    if (!els) return;
    try {
      var under = currentUnderlying();
      /* Deriva: si el usuario apagó a mano el crossfade o el DJ mientras
         la mezcla automática estaba encendida, la mezcla ya no está
         completa: el interruptor se apaga solo, sin pulsar nada. */
      if (state.on && (!under.crossfade || !under.dj)) {
        state.on = false; state.prev = null; writeStored(state);
        if (els.status) els.status.textContent = 'El crossfade o el Modo DJ se cambió a mano: la mezcla automática quedó desactivada.';
      }
      var cur = readCurrentBpm();
      var nxt = under.dj ? readNextBpm() : { bpm: null, title: null };
      var view = buildPanelState({
        curBpm: cur.bpm, nextBpm: nxt.bpm,
        crossfadeOn: under.crossfade, djOn: under.dj,
        crossfadeSec: readCrossfadeSec()
      });
      if (els.toggle) {
        els.toggle.classList.toggle('on', state.on);
        els.toggle.setAttribute('aria-pressed', state.on ? 'true' : 'false');
        var label = els.toggle.querySelector('[data-dj-label]');
        if (label) label.textContent = state.on ? '🎧 Mezcla automática DJ: activada' : '🎧 Mezcla automática DJ';
      }
      if (els.curBpm) els.curBpm.textContent = view.curLabel + (cur.manual && cur.bpm !== null ? ' (manual)' : '');
      if (els.curTitle) els.curTitle.textContent = cur.title ? ' · ' + cur.title : '';
      if (els.nextBpm) els.nextBpm.textContent = under.dj ? view.nextLabel : '—';
      if (els.nextTitle) els.nextTitle.textContent = under.dj ? (nxt.title ? ' · ' + nxt.title : '') : '';
      if (els.jump) {
        els.jump.textContent = under.dj ? view.jumpText
          : 'Activa la mezcla automática para ver la siguiente según el DJ.';
        els.jump.className = 'dj-jump dj-jump-' + (under.dj ? view.jump : 'sin-datos');
      }
      if (els.fade) els.fade.textContent = 'Transición: ' + view.fadeLabel + '.';
      if (els.warn) {
        els.warn.textContent = view.warning || '';
        els.warn.style.display = view.warning ? '' : 'none';
      }
      if (els.cfSec) els.cfSec.textContent = view.crossfadeSec + ' s';
      if (els.cfRow) els.cfRow.style.display = $('crossfadeRange') ? '' : 'none';
      if (els.status && !state.on && (!under.crossfade || !under.dj)) {
        /* No pisar el aviso de deriva si acaba de ponerse. */
        if (!/cambió a mano/.test(els.status.textContent || '')) {
          els.status.textContent = state.prev
            ? 'Al apagar volverán el crossfade y el Modo DJ a como estaban.'
            : 'Enciende crossfade + Modo DJ juntos; al apagar, restaura lo que tenías.';
        }
      } else if (els.status && state.on) {
        els.status.textContent = 'Crossfade + Modo DJ encendidos juntos. La siguiente la elige el DJ por cercanía de BPM.';
      }
    } catch (e) { /* El panel nunca debe romper la app. */ }
  }

  function enableAuto() {
    var under = currentUnderlying();
    state.prev = { crossfade: under.crossfade, dj: under.dj };
    state.on = true;
    writeStored(state);
    setUnderlying('crossfade', true);
    setUnderlying('dj', true);
    refresh();
  }

  function disableAuto() {
    var plan = planRestore(state.prev, currentUnderlying());
    state.on = false;
    state.prev = null;
    writeStored(state);
    if (plan.crossfade !== null) setUnderlying('crossfade', plan.crossfade);
    if (plan.dj !== null) setUnderlying('dj', plan.dj);
    refresh();
  }

  function toggleAuto() {
    if (state.on) disableAuto(); else enableAuto();
  }

  function mount() {
    var btnCf = $('btnCrossfade'), btnDj = $('btnDjToggle');
    /* Sin crossfade o sin DJ en el DOM, el módulo no hace nada. */
    if (!btnCf || !btnDj) return false;
    if ($('djAutoPanel')) return true;
    /* Ancla: la fila del botón #btnMixNow del reproductor (línea ~981).
       Fallbacks: .player-body, el padre de #djNextBox, el panel Sonido. */
    var anchor = null;
    try {
      var mixNow = $('btnMixNow');
      if (mixNow && mixNow.parentElement) anchor = mixNow.parentElement;
      if (!anchor) anchor = document.querySelector('.player-body');
      if (!anchor) { var box = $('djNextBox'); if (box && box.parentElement) anchor = box.parentElement; }
      if (!anchor) anchor = document.querySelector('.sound-panel');
    } catch (e) { anchor = null; }
    if (!anchor) return false;

    var panel = document.createElement('section');
    panel.id = 'djAutoPanel';
    panel.className = 'dj-panel';
    panel.setAttribute('aria-label', 'Mezcla automática DJ');
    panel.innerHTML =
      '<button class="toggle-pill dj-auto-toggle" id="btnDjAuto" type="button" aria-pressed="false">' +
        '<span class="dot"></span><span data-dj-label>🎧 Mezcla automática DJ</span>' +
      '</button>' +
      '<p class="dj-status" id="djAutoStatus" role="status"></p>' +
      '<div class="dj-bpm-row"><span class="dj-bpm-k">Ahora:</span> ' +
        '<strong id="djCurBpm">Sin BPM</strong><span class="dj-bpm-t" id="djCurTitle"></span></div>' +
      '<div class="dj-bpm-row"><span class="dj-bpm-k">Siguiente (DJ):</span> ' +
        '<strong id="djNextBpm">—</strong><span class="dj-bpm-t" id="djNextTitle"></span></div>' +
      '<p class="dj-jump dj-jump-sin-datos" id="djJump"></p>' +
      '<p class="dj-fade" id="djFadeInfo"></p>' +
      '<p class="dj-warn" id="djJumpWarn" style="display:none" role="status"></p>' +
      '<div class="dj-cf-row" id="djCfRow">' +
        '<span class="dj-bpm-k">Crossfade:</span>' +
        '<button class="dj-step" id="djCfMinus" type="button" aria-label="Quitar un segundo de crossfade">−</button>' +
        '<output id="djCfSec" for="crossfadeRange">6 s</output>' +
        '<button class="dj-step" id="djCfPlus" type="button" aria-label="Añadir un segundo de crossfade">+</button>' +
        '<span class="dj-note">mueve el control de Sonido</span>' +
      '</div>';

    try {
      /* Insertar justo después de la fila de "Mezclar ahora" cuando el
         ancla es esa fila; si no, al final del ancla. */
      var mixNow = $('btnMixNow');
      if (mixNow && mixNow.parentElement === anchor) {
        anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      } else {
        anchor.appendChild(panel);
      }
    } catch (e) { return false; }

    els = {
      toggle: $('btnDjAuto'), status: $('djAutoStatus'),
      curBpm: $('djCurBpm'), curTitle: $('djCurTitle'),
      nextBpm: $('djNextBpm'), nextTitle: $('djNextTitle'),
      jump: $('djJump'), fade: $('djFadeInfo'), warn: $('djJumpWarn'),
      cfRow: $('djCfRow'), cfSec: $('djCfSec')
    };
    if (!els.toggle) return false;

    els.toggle.addEventListener('click', function () { try { toggleAuto(); } catch (e) {} });
    var minus = $('djCfMinus'), plus = $('djCfPlus');
    if (minus) minus.addEventListener('click', function () { setCrossfadeSec(readCrossfadeSec() - 1); refresh(); });
    if (plus) plus.addEventListener('click', function () { setCrossfadeSec(readCrossfadeSec() + 1); refresh(); });

    /* Refrescar cuando la app cambia de canción o de estado: la app
       reescribe #djStatus, #djNextText, #nowTitle y la lista al
       cambiar de pista; los botones avisan con click/input. */
    try {
      var obs = new MutationObserver(function () { refresh(); });
      ['djStatus', 'djNextText', 'nowTitle', 'crossfadeState', 'djState', 'trackList'].forEach(function (id) {
        var n = $(id);
        if (n && obs.observe) obs.observe(n, { childList: true, characterData: true, subtree: true });
      });
    } catch (e) {}
    ['btnNext', 'btnPrev', 'btnDjToggle', 'btnCrossfade', 'btnMixNow', 'btnMixNow2'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', function () { setTimeout(refresh, 60); });
    });
    var range = $('crossfadeRange');
    if (range) range.addEventListener('input', function () { refresh(); });
    return true;
  }

  function init() {
    try {
      if (!mount()) return;
      var stored = readStored();
      var under = currentUnderlying();
      /* Al recargar, la app ya restauró crossfade/djMode desde su
         packState: si la mezcla estaba encendida y ambos siguen
         encendidos, el interruptor se muestra encendido SIN pulsar
         nada. Si alguno ya no lo está, la mezcla quedó desactivada. */
      state.on = !!(stored.on && under.crossfade && under.dj);
      state.prev = state.on ? stored.prev : null;
      if (stored.on && !state.on) writeStored({ on: false, prev: null });
      refresh();
      global.__rpmDj = {
        version: VERSION, refresh: refresh, enable: enableAuto,
        disable: disableAuto, toggle: toggleAuto,
        isOn: function () { return state.on; },
        state: function () {
          return { on: state.on, prev: state.prev, underlying: currentUnderlying() };
        }
      };
    } catch (e) { /* Fallar al cargar no debe romper la app. */ }
  }

  /* Auto-inyección del CSS (mismo patrón que cast.js): el <link> en
     index.html es lo recomendado; si falta, el JS lo añade. */
  try {
    var hasCss = false;
    try {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) {
        if ((links[i].getAttribute('href') || '').indexOf('dj.css') >= 0) { hasCss = true; break; }
      }
    } catch (e) {}
    if (!hasCss) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = './dj.css';
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
