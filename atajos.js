/* Atajos de teclado y gestos nuevos (v3.2.0) — módulo aparte.
   No toca el código de index.html: se engancha solo al DOM que ya
   existe (#audio, #btnPlay/#btnNext/#btnPrev, #coverWrap, #kbdModal).

   HECHOS VERIFICADOS EN app/index.html (3.2.0, léase antes de tocar
   este archivo):
   - La app vive en un IIFE cerrado (línea 2242 `(function(){` ...
     línea 12834 `})();`). togglePlay/next/prev/audio/seekBy NO son
     globales y NO se pueden llamar desde fuera; window.__rpmApp
     (línea ~12807) expone solo idb*, patchTrack, getTracks, toast,
     render, etc. Por eso este módulo actúa POR DOM, como mejoras.js
     y cast.js: #btnPlay.click() ejecuta el togglePlay de la app,
     #btnNext.click() ejecuta next(false)+play, #btnPrev.click()
     ejecuta prev()+play, y el salto se hace con audio.currentTime
     (la misma fórmula que las flechas ←/→ del handler existente).
     Un click() en #btnPlay deshabilitado (sin canción, o con
     dislike) no hace nada: el guarda de la app sigue mandando.
   - Atajos YA existentes, handler principal línea ~5376
     (document keydown): Espacio, ←/→ ±10 s, ↑/↓ volumen, ? ayuda,
     N siguiente, P anterior, M silencio, L like, D dislike. La
     tecla L está ocupada por like: por eso NO se usa J/L para
     saltar. J/K/F/1-9 NO aparecen en ningún keydown de index.html
     (verificado con grep de ev.key): están libres.
   - El handler existente ignora atajos con Ctrl/Meta/Alt, con foco
     en INPUT/TEXTAREA/SELECT o contentEditable, y con la ayuda
     (#kbdModal) abierta. Este módulo aplica exactamente las mismas
     tres reglas (shouldIgnoreKeyboard).
   - GESTO SWIPE YA EXISTE (líneas 8188-8207, Pack 4): addSwipe
     sobre #coverWrap y #partyCoverWrap, umbral 55 px y dominancia
     horizontal 1.4x, izquierda = siguiente, derecha = anterior.
     Este módulo NO vuelve a cablearlo (un segundo listener
     dispararía next()/prev() dos veces). classifySwipe() documenta
     y prueba esa misma regla, por si la app la retira algún día.
   - DOBLE TOQUE YA EXISTE (líneas ~11840-11883): doble toque en la
     portada salta ∓10 s según el tercio (izquierdo −10 s, derecho
     +10 s, con flash −10 s/+10 s); el tercio CENTRAL no hace nada.
     Por eso el doble toque play/pausa de este módulo actúa SOLO en
     el tercio central: no pisa el salto existente. Umbrales
     espejo de los existentes: segundo toque <330 ms y <90 px del
     primero, movimiento ≤12 px (si se mueve más, manda el swipe).
   - Pantalla completa: solo existe en modo Fiesta (línea ~7641) y
     modo Coche (línea ~8114), sobre sus propios elementos. No hay
     atajo F global: no choca con nada.
   - #coverWrap contiene #coverImg, #videoEl, #viz, #seekFlashL/R
     y #playingBadge; no hay botones dentro. Aun así el doble toque
     ignora BUTTON/A/INPUT por si el HTML cambia, y se apaga con la
     clase 'video-on' (modo vídeo, línea ~10701).

   FAIL-SAFE: cualquier error, elemento ausente o API ausente hace
   que el módulo no haga nada. La app queda byte-idéntica con o sin
   este módulo: si atajos.js no carga, los atajos viejos, el swipe y
   el doble toque ±10 s siguen funcionando igual. */
(function (global) {
  'use strict';

  /* ---- Constantes (espejo de las de index.html donde ya existen) ---- */
  var SEEK_STEP = 10;          /* segundos de J/K, igual que ←/→ */
  var SWIPE_THRESHOLD = 55;    /* px, igual que addSwipe en index.html */
  var SWIPE_RATIO = 1.4;       /* |dx| > |dy| * 1.4, igual que addSwipe */
  var DBL_TAP_MAX_MS = 330;    /* igual que el doble toque existente */
  var DBL_TAP_MAX_DIST = 90;   /* px entre los dos toques, igual que allí */
  var TAP_MAX_MOVE = 12;       /* px: si se mueve más, fue un deslizar */
  var TOUCH_DBLCLICK_GUARD_MS = 600; /* igual que lastTouchSeekAt allí */
  var FLASH_MS = 550;          /* igual que el flash −10 s/+10 s */

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  /* Tecla -> acción nueva. null = "no es nuestra" (incluidas TODAS
     las teclas ya usadas por la app: espacio, flechas, ?, N, P, M,
     L, D, Escape, Enter). Así el módulo nunca pisa un atajo viejo. */
  function keyAction(key) {
    if (key === 'j' || key === 'J') return { kind: 'seek', seconds: -SEEK_STEP };
    if (key === 'k' || key === 'K') return { kind: 'seek', seconds: SEEK_STEP };
    if (key === 'f' || key === 'F') return { kind: 'fullscreen' };
    if (typeof key === 'string' && key.length === 1 && key >= '1' && key <= '9') {
      return { kind: 'seekPercent', fraction: parseInt(key, 10) / 10 };
    }
    return null;
  }

  /* Posición destino de las teclas 1-9: dígito n -> n/10 de la
     duración. null si no hay duración válida (nada cargado, directo). */
  function seekPercentTarget(duration, digit) {
    if (!isFinite(duration) || !duration || duration <= 0) return null;
    if (typeof digit !== 'number' || digit < 1 || digit > 9) return null;
    return duration * (digit / 10);
  }

  /* Salto relativo con tope [0, duración], misma fórmula que las
     flechas ←/→ del handler existente. Sin duración válida, tope
     inferior 0 y sin tope superior. */
  function clampSeek(currentTime, delta, duration) {
    var t = (currentTime || 0) + delta;
    if (isFinite(duration) && duration > 0) t = Math.min(duration, Math.max(0, t));
    else t = Math.max(0, t);
    return t;
  }

  /* Decisión de swipe, ESPEJO EXACTO de addSwipe (index.html ~8198):
     |dx| > 55 y |dx| > |dy| * 1.4. Izquierda -> 'next' (siguiente),
     derecha -> 'prev' (anterior). null = no fue un swipe (toque,
     scroll vertical o deslizamiento corto). El módulo NO cablea
     el swipe porque ya está cableado; esta función solo documenta
     y prueba la regla. */
  function classifySwipe(dx, dy) {
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) {
      return dx < 0 ? 'next' : 'prev';
    }
    return null;
  }

  /* ¿Dos toques seguidos cuentan como doble toque? Espejo del
     doble toque existente: menos de 330 ms y menos de 90 px entre
     ambos toques. prev/cur: {t: ms, x: clientX}. */
  function isDoubleTap(prev, cur) {
    if (!prev || !cur) return false;
    return (cur.t - prev.t) < DBL_TAP_MAX_MS && Math.abs(cur.x - prev.x) < DBL_TAP_MAX_DIST;
  }

  /* ¿El dedo se movió demasiado para ser un toque? >12 px en
     cualquier eje: fue un deslizar (manda el swipe) o un scroll. */
  function movedTooMuch(dx, dy) {
    return Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE;
  }

  /* Tercio de la portada donde cayó el toque, espejo de seekTap:
     x < 1/3 izquierdo, x > 2/3 derecho, resto central. null sin
     ancho válido. */
  function coverThird(clientX, rectLeft, rectWidth) {
    if (!rectWidth || !isFinite(rectWidth) || rectWidth <= 0) return null;
    var x = (clientX - rectLeft) / rectWidth;
    if (x < 1 / 3) return 'left';
    if (x > 2 / 3) return 'right';
    return 'center';
  }

  /* Qué hace el doble toque según el tercio: solo el central es
     nuestro (play/pausa). Izquierdo/derecho ya son ∓10 s de la app. */
  function doubleTapZoneAction(third) {
    return third === 'center' ? 'toggle' : null;
  }

  /* ¿Se ignora este keydown? Espejo del handler existente (~5377):
     modificadores del navegador/sistema, foco en campo editable, o
     ayuda de atajos abierta. ev: {ctrlKey, metaKey, altKey, tag,
     isContentEditable, kbdModalOpen}. */
  function shouldIgnoreKeyboard(ev) {
    if (!ev) return true;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return true;
    var tag = ev.tag || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (ev.isContentEditable) return true;
    if (ev.kbdModalOpen) return true;
    return false;
  }

  /* ---- Parte DOM (solo corre en el navegador) ---- */

  function $(id) { return document.getElementById(id); }

  function clickBtn(id) {
    var b = $(id);
    if (!b || b.disabled) return false;
    try { b.click(); return true; } catch (e) { return false; }
  }

  function seekBy(sec) {
    var a = $('audio');
    if (!a) return;
    try { a.currentTime = clampSeek(a.currentTime, sec, a.duration); } catch (e) {}
  }

  function seekPercent(frac) {
    var a = $('audio');
    if (!a) return;
    var target = seekPercentTarget(a.duration, Math.round(frac * 10));
    if (target == null) return;
    try { a.currentTime = target; } catch (e) {}
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        var p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () {});
      } else if (document.documentElement.requestFullscreen) {
        var q = document.documentElement.requestFullscreen();
        if (q && q.catch) q.catch(function () {});
      }
    } catch (e) {}
  }

  function runKeyAction(action) {
    if (!action) return;
    if (action.kind === 'seek') seekBy(action.seconds);
    else if (action.kind === 'seekPercent') seekPercent(action.fraction);
    else if (action.kind === 'fullscreen') toggleFullscreen();
  }

  /* Añade las filas nuevas a la ayuda de atajos (#kbdModal .kbd-list)
     sin tocar index.html. Marcadas con data-atajos-row para no
     duplicarlas si el módulo se carga dos veces. */
  function injectHelpRows() {
    try {
      var list = document.querySelector('#kbdModal .kbd-list');
      if (!list || list.querySelector('[data-atajos-row]')) return;
      var rows = [
        ['Retroceder 10 segundos', '<kbd>J</kbd>'],
        ['Adelantar 10 segundos', '<kbd>K</kbd>'],
        ['Saltar al 10 % – 90 % de la canción', '<kbd>1</kbd> – <kbd>9</kbd>'],
        ['Pantalla completa', '<kbd>F</kbd>'],
        ['Doble toque en el centro de la portada: reproducir / pausar', ''],
        ['Deslizar sobre la portada: anterior / siguiente', '']
      ];
      rows.forEach(function (r) {
        var div = document.createElement('div');
        div.className = 'kbd-row';
        div.setAttribute('data-atajos-row', '1');
        var label = document.createElement('span');
        label.textContent = r[0];
        div.appendChild(label);
        if (r[1]) {
          var keys = document.createElement('span');
          keys.className = 'keys';
          keys.innerHTML = r[1];
          div.appendChild(keys);
        }
        list.appendChild(div);
      });
    } catch (e) {}
  }

  /* Doble toque en el tercio central de la portada -> play/pausa.
     Espejo del doble toque ±10 s existente: mismos umbrales, misma
     guarda anti-doble-disparo táctil/ratón (600 ms). */
  function initCoverDoubleTap() {
    var wrap = $('coverWrap');
    if (!wrap) return;

    /* Aviso visual breve (▶/⏸) en el centro, como el flash −10 s/+10 s. */
    var flash = null;
    try {
      flash = document.createElement('span');
      flash.className = 'atajos-flash';
      flash.setAttribute('aria-hidden', 'true');
      wrap.appendChild(flash);
    } catch (e) { flash = null; }
    var flashTimer = null;
    function showFlash() {
      if (!flash) return;
      try {
        var a = $('audio');
        flash.textContent = (a && a.paused) ? '▶' : '⏸';
        flash.classList.add('show');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(function () { flash.classList.remove('show'); }, FLASH_MS);
      } catch (e) {}
    }

    function isInteractiveTarget(t) {
      if (!t || !t.closest) return false;
      return !!t.closest('button, a, input, select, textarea');
    }

    function tryToggle(clientX) {
      if (wrap.classList.contains('video-on')) return; /* modo vídeo: fuera */
      var rect = wrap.getBoundingClientRect();
      if (doubleTapZoneAction(coverThird(clientX, rect.left, rect.width)) !== 'toggle') return;
      if (clickBtn('btnPlay')) showFlash();
    }

    var lastTouchToggleAt = 0;
    wrap.addEventListener('dblclick', function (e) {
      try {
        if (Date.now() - lastTouchToggleAt < TOUCH_DBLCLICK_GUARD_MS) return;
        if (isInteractiveTarget(e.target)) return;
        tryToggle(e.clientX);
      } catch (err) {}
    });

    var tapT = 0, tapX = 0, startX = null, startY = null;
    wrap.addEventListener('touchstart', function (e) {
      try {
        if (e.touches.length === 1) {
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
        }
      } catch (err) {}
    }, { passive: true });
    wrap.addEventListener('touchend', function (e) {
      try {
        if (startX == null) return;
        var cx = e.changedTouches[0].clientX;
        var dx = cx - startX, dy = e.changedTouches[0].clientY - startY;
        startX = null;
        if (movedTooMuch(dx, dy)) return; /* fue un deslizar: manda el swipe */
        if (isInteractiveTarget(e.target)) return;
        var now = Date.now();
        if (isDoubleTap({ t: tapT, x: tapX }, { t: now, x: cx })) {
          tapT = 0;
          lastTouchToggleAt = now;
          tryToggle(cx);
        } else {
          tapT = now;
          tapX = cx;
        }
      } catch (err) {}
    }, { passive: true });
  }

  function initKeyboard() {
    document.addEventListener('keydown', function (ev) {
      try {
        if (ev.repeat) return; /* como N/P/M/L/D: sin repetición al mantener */
        var modal = $('kbdModal');
        var tag = (ev.target && ev.target.tagName) || '';
        if (shouldIgnoreKeyboard({
          ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey,
          tag: tag,
          isContentEditable: !!(ev.target && ev.target.isContentEditable),
          kbdModalOpen: !!(modal && modal.classList.contains('on'))
        })) return;
        runKeyAction(keyAction(ev.key));
      } catch (e) {}
    });
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./atajos.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './atajos.css';
      document.head.appendChild(css);
    } catch (e) {}
  }

  function init() {
    try {
      ensureCss();
      initKeyboard();
      initCoverDoubleTap();
      injectHelpRows();
    } catch (e) { /* fail-safe: atajos desactivados, app intacta */ }
  }

  var api = {
    keyAction: keyAction,
    seekPercentTarget: seekPercentTarget,
    clampSeek: clampSeek,
    classifySwipe: classifySwipe,
    isDoubleTap: isDoubleTap,
    movedTooMuch: movedTooMuch,
    coverThird: coverThird,
    doubleTapZoneAction: doubleTapZoneAction,
    shouldIgnoreKeyboard: shouldIgnoreKeyboard,
    SEEK_STEP: SEEK_STEP,
    SWIPE_THRESHOLD: SWIPE_THRESHOLD,
    SWIPE_RATIO: SWIPE_RATIO,
    DBL_TAP_MAX_MS: DBL_TAP_MAX_MS,
    DBL_TAP_MAX_DIST: DBL_TAP_MAX_DIST,
    TAP_MAX_MOVE: TAP_MAX_MOVE
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__atajosHelpers = api; } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
