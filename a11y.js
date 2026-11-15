/* Accesibilidad y móvil (v3.3.0) — módulo aparte.
   No toca el código de index.html: se engancha solo al DOM que ya
   existe (mismo patrón que lyrics.js, mejoras.js, temas.js y
   atajos.js: IIFE fail-safe, scripts al final del body; si el
   módulo falla o no carga, la app sigue funcionando igual).

   HECHOS VERIFICADOS EN app/index.html (3.3.0, léase antes de tocar
   este archivo):
   - NO hay skip-link (grep de "skip-link"/"Saltar al reproductor":
     solo "Saltar silencios", un ajuste distinto). La sección del
     reproductor es <section class="player-card"
     aria-label="Reproductor"> (línea 831) y NO tiene id: este
     módulo le asigna id="player" + tabindex="-1" por DOM y el
     skip-link apunta a #player. Si una versión futura ya le pone
     id, el módulo usa ese id (no lo pisa).
   - Controles principales YA con aria-label (no se duplican):
     #btnPlay "Reproducir" (línea 953; la app ya lo cambia a
     "Pausar" al sonar, líneas 5027/5040, por eso aquí NO se toca),
     #btnPrev "Canción anterior", #btnNext "Canción siguiente",
     #btnShuffle "Activar aleatorio", #btnRepeat "Modo de
     repetición", #btnMute "Silenciar", #volume "Volumen", #seek
     "Progreso de la canción" (input[type=range]: el rol slider es
     implícito, no se añade role="slider" redundante).
   - #viewTabs YA tiene role="tablist" aria-label="Vistas" y cada
     .view-tab role="tab" + aria-selected, que la app ya actualiza
     (línea 3598). No se toca.
   - HUECO REAL: #search (línea 1288, type="search") solo tiene
     placeholder, sin aria-label ni <label for>. Es el ÚNICO
     control principal sin nombre accesible: el módulo le pone el
     aria-label con el texto de su placeholder, solo si sigue sin
     tenerlo (needsAriaLabel). #btnLike/#btnDislike no necesitan
     aria-label: su nombre viene de su texto visible ("Me gusta" /
     "No me gusta").
   - FOCO: index.html pone outline:none en .search-box input
     (línea 269), .modal input/textarea (497/630) y .preset-row
     input[type=text] (633), con solo un cambio de border-color en
     :focus; no hay ninguna regla :focus-visible (grep: 0). Por
     eso a11y.css usa selectores con especificidad mayor que esas
     reglas (p. ej. .app .search-box input:focus-visible) para que
     el contorno gane aunque el <link> vaya antes del <style> de
     index.html. No se toca el diseño: solo outline + offset.
   - TÁCTIL en móvil: .controls .icon-btn ya es 52 px y .play-btn
     78 px a TODOS los anchos (líneas ~790-796, fuera de cualquier
     @media), así que reproducir/anterior/siguiente ya cumplen.
     Por debajo de 44 px quedan: #btnMute (style en línea
     width:34px;height:34px, línea 972 — solo se vence con
     !important), .secondary-row .icon-btn 38 px, .star-btn 38 px,
     #seek 28 px (en .seek-wrap de 28 px), #volume 18 px, el
     buscador ~41 px y #viewTabs .view-tab ~44,5 px (al límite).
     a11y.css los sube a 44 px solo en <=480 px (cubre 360-390 px);
     el tamaño visual del pulgar de los sliders no cambia, solo
     crece su zona táctil.
   - MOVIMIENTO REDUCIDO: index.html ya apaga .eq, .rec-dot y
     .subview/.player-body con prefers-reduced-motion, y temas.js
     no añade rpm-cover-in/rpm-list-in cuando está activo
     (animationsEnabled/reducedMotion, líneas 189-210, 338, 363) y
     temas.css tiene su propio bloque. El hueco es visual.js: su
     glow (#rpmVisualGlow, transition opacity .6s en visual.css)
     NO tiene regla de movimiento reducido. Este módulo añade la
     red de seguridad CSS + quita las clases de animación de
     temas si la preferencia cambia en caliente.

   FAIL-SAFE: cualquier error, elemento ausente o API ausente hace
   que el módulo no haga nada. La app queda byte-idéntica con o sin
   este módulo. */
(function (global) {
  'use strict';

  /* ---- Constantes ---- */
  var SKIP_LINK_ID = 'a11ySkipLink';
  var PLAYER_ID = 'player';
  var SKIP_LINK_TEXT = 'Saltar al reproductor';
  var MIN_TOUCH_PX = 44;
  var ANIMATION_CLASSES = ['rpm-cover-in', 'rpm-list-in'];

  /* Único hueco de nombre accesible entre los controles principales
     (verificado arriba): #search. La etiqueta es su propio
     placeholder, para que el lector de pantalla diga lo mismo que
     ve el usuario. Cualquier otro control que en el futuro pierda
     su nombre se añade aquí, nunca con un setAttribute a ciegas. */
  var CONTROL_LABELS = {
    search: 'Busca por título, artista, álbum o archivo'
  };

  /* Controles principales cuyo nombre accesible ya existe en
     index.html y que el módulo NO toca (documentado, no aplicado):
     btnPlay, btnPrev, btnNext, btnShuffle, btnRepeat, btnMute,
     volume, seek. Los tests comprueban que siguen ahí. */
  var CONTROL_IDS = [
    'btnPlay', 'btnPrev', 'btnNext', 'btnShuffle', 'btnRepeat',
    'btnMute', 'volume', 'seek', 'search'
  ];

  /* Selectores que a11y.css debe llevar a >=44 px en móvil
     (<=480 px). Los tests cruzan esta lista con el CSS. */
  var TOUCH_SELECTORS = [
    '#btnMute',
    '.secondary-row .icon-btn',
    '.star-btn',
    '#seek',
    '#volume',
    '.search-box input',
    '#viewTabs .view-tab',
    '.btn.small',
    '.chip',
    '.toggle-pill'
  ];

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  /* ¿Le falta nombre accesible a este control? desc:
     {ariaLabel, ariaLabelledby, text, title} (cadenas o null).
     Basta con que exista UNO de ellos: no se añade nada si ya
     tiene nombre por cualquier vía (así nunca se duplica). */
  function needsAriaLabel(desc) {
    if (!desc) return true;
    var fields = [desc.ariaLabel, desc.ariaLabelledby, desc.text, desc.title];
    for (var i = 0; i < fields.length; i++) {
      var v = fields[i];
      if (typeof v === 'string' && v.trim() !== '') return false;
    }
    return true;
  }

  /* Etiqueta que el módulo pondría a un control, o null si no le
     toca ninguna (porque ya tiene nombre o no es un hueco conocido). */
  function labelForControl(id) {
    if (!id || !Object.prototype.hasOwnProperty.call(CONTROL_LABELS, id)) return null;
    return CONTROL_LABELS[id];
  }

  /* Id del destino del skip-link: el que ya tenga la sección del
     reproductor, o 'player' si no tiene ninguno (el módulo se lo
     asigna por DOM). */
  function playerTargetId(sectionId) {
    if (typeof sectionId === 'string' && sectionId.trim() !== '') return sectionId.trim();
    return PLAYER_ID;
  }

  function shouldAssignPlayerId(sectionId) {
    return !(typeof sectionId === 'string' && sectionId.trim() !== '');
  }

  function skipLinkHrefFor(targetId) {
    return '#' + playerTargetId(targetId);
  }

  /* Clases de animación de temas.js que hay que quitar cuando el
     movimiento reducido está activo. Devuelve una copia sin ellas;
     classNames es un array de nombres de clase. */
  function stripAnimationClasses(classNames) {
    if (!classNames) return [];
    var out = [];
    for (var i = 0; i < classNames.length; i++) {
      if (ANIMATION_CLASSES.indexOf(classNames[i]) === -1) out.push(classNames[i]);
    }
    return out;
  }

  /* ¿Está activo el movimiento reducido? matches es el .matches de
     matchMedia('(prefers-reduced-motion: reduce)'). */
  function reducedMotionOn(matches) {
    return !!matches;
  }

  /* ---- Parte DOM (solo corre en el navegador) ---- */

  function $(id) { return document.getElementById(id); }

  /* Describe un elemento real con el formato que entiende
     needsAriaLabel, sin inventar nada: solo lee atributos/texto. */
  function describeEl(el) {
    try {
      return {
        ariaLabel: el.getAttribute('aria-label'),
        ariaLabelledby: el.getAttribute('aria-labelledby'),
        text: el.textContent,
        title: el.getAttribute('title')
      };
    } catch (e) {
      return { ariaLabel: null, ariaLabelledby: null, text: null, title: null };
    }
  }

  /* La sección del reproductor como destino del skip-link. Le pone
     id="player" y tabindex="-1" solo si le faltan (para que pueda
     recibir el foco por programa sin entrar en el orden de Tab).
     Si la sección no existe, usa #coverWrap como respaldo. */
  function ensurePlayerTarget() {
    try {
      var target = document.querySelector('section.player-card');
      if (!target) target = $('coverWrap');
      if (!target) return null;
      if (shouldAssignPlayerId(target.id)) target.id = PLAYER_ID;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      return target;
    } catch (e) {
      return null;
    }
  }

  /* Skip-link "Saltar al reproductor" como primer hijo de <body>
     (primer Tab de la página). Con data-a11y-skip-link para no
     duplicarlo si el módulo se carga dos veces. Al activarlo mueve
     el foco al reproductor, no solo el scroll. */
  function injectSkipLink() {
    try {
      if ($('a11ySkipLink') || document.querySelector('[data-a11y-skip-link]')) return null;
      var target = ensurePlayerTarget();
      if (!target) return null;
      var a = document.createElement('a');
      a.id = SKIP_LINK_ID;
      a.className = 'a11y-skip-link';
      a.setAttribute('data-a11y-skip-link', '1');
      a.href = skipLinkHrefFor(target.id);
      a.textContent = SKIP_LINK_TEXT;
      a.addEventListener('click', function (ev) {
        try {
          ev.preventDefault();
          target.focus();
        } catch (e) {
          try { target.scrollIntoView(); } catch (err) {}
        }
      });
      var body = document.body;
      if (!body) return null;
      if (body.firstChild) body.insertBefore(a, body.firstChild);
      else body.appendChild(a);
      return a;
    } catch (e) {
      return null;
    }
  }

  /* Pone aria-label solo donde falta (CONTROL_LABELS): si el
     control ya tiene nombre por cualquier vía, no se toca. */
  function fixAriaLabels() {
    try {
      var ids = Object.keys(CONTROL_LABELS);
      for (var i = 0; i < ids.length; i++) {
        var el = $(ids[i]);
        if (!el) continue;
        var label = labelForControl(ids[i]);
        if (label == null) continue;
        if (needsAriaLabel(describeEl(el))) {
          el.setAttribute('aria-label', label);
        }
      }
    } catch (e) {}
  }

  /* Movimiento reducido: marca <html data-a11y-reduced-motion> y
     quita las clases de animación de temas si está activo. Se
     llama al cargar y cada vez que cambia la preferencia. */
  function applyReducedMotion(mq) {
    var on = reducedMotionOn(mq && mq.matches);
    try {
      if (on) document.documentElement.setAttribute('data-a11y-reduced-motion', 'true');
      else document.documentElement.removeAttribute('data-a11y-reduced-motion');
    } catch (e) {}
    if (on) {
      try {
        var els = document.querySelectorAll('.rpm-cover-in, .rpm-list-in');
        for (var i = 0; i < els.length; i++) {
          var cls = stripAnimationClasses(els[i].className.split(/\s+/));
          els[i].className = cls.join(' ');
        }
      } catch (e) {}
    }
    return on;
  }

  function initReducedMotion() {
    try {
      if (!window.matchMedia) return;
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (!mq) return;
      applyReducedMotion(mq);
      if (mq.addEventListener) mq.addEventListener('change', function () { applyReducedMotion(mq); });
      else if (mq.addListener) mq.addListener(function () { applyReducedMotion(mq); });
    } catch (e) {}
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./a11y.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './a11y.css';
      document.head.appendChild(css);
    } catch (e) {}
  }

  function init() {
    try {
      ensureCss();
      injectSkipLink();
      fixAriaLabels();
      initReducedMotion();
    } catch (e) { /* fail-safe: accesibilidad desactivada, app intacta */ }
  }

  var api = {
    SKIP_LINK_ID: SKIP_LINK_ID,
    PLAYER_ID: PLAYER_ID,
    SKIP_LINK_TEXT: SKIP_LINK_TEXT,
    MIN_TOUCH_PX: MIN_TOUCH_PX,
    ANIMATION_CLASSES: ANIMATION_CLASSES,
    CONTROL_LABELS: CONTROL_LABELS,
    CONTROL_IDS: CONTROL_IDS,
    TOUCH_SELECTORS: TOUCH_SELECTORS,
    needsAriaLabel: needsAriaLabel,
    labelForControl: labelForControl,
    playerTargetId: playerTargetId,
    shouldAssignPlayerId: shouldAssignPlayerId,
    skipLinkHrefFor: skipLinkHrefFor,
    stripAnimationClasses: stripAnimationClasses,
    reducedMotionOn: reducedMotionOn
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__a11yHelpers = api; } catch (e) {}

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
