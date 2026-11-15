/* Temas y animaciones (v3.2.0) — módulo aparte.
   NO toca el código de index.html: la app es un IIFE y applyTheme /
   settings / toast NO son globales, así que este módulo convive con
   ella solo por DOM y por variables CSS.

   QUÉ HACE
   - 3 temas nuevos elegibles desde el #themeSelect que ya existe:
     Neón, Atardecer y Bosque, además de Automático / Claro / Oscuro.
     Se guardan en html[data-rpm-theme] + variables CSS en línea.
   - Transiciones suaves al cambiar de tema.
   - Animación sutil de entrada en la portada (#coverWrap / #coverImg)
     y en la lista (#trackList) al cambiar de canción.
   - El tema elegido se guarda en localStorage (clave
     'reproductor-tema-rpm') y se recuerda al reabrir.
   - Respeta prefers-reduced-motion: sin animaciones ni transiciones.

   CONVIVENCIA CON LO QUE YA EXISTE (leer antes de tocar nada)
   - data-theme (auto/claro/oscuro) NO se toca: el tema rpm es una
     capa encima. Sus variables van en línea (style.setProperty), que
     es lo mismo que ya hacen applyTheme() y applyDynTheme().
   - El listener 'change' propio de la app en #themeSelect solo acepta
     light/dark y convierte el resto en 'auto'. Por eso este módulo
     escucha 'change' en FASE DE CAPTURA sobre document: si el valor
     es neon/sunset/forest hace stopPropagation() y la app nunca lo ve.
     Si el valor es auto/light/dark, deja pasar el evento (la app hace
     lo suyo) y este módulo solo apaga su tema (vuelve a 'default').
   - applyTheme() escribe --accent/--accent-dark/--accent-soft en
     línea y pisaría el acento del tema rpm. Un MutationObserver sobre
     el atributo style de <html> lo vuelve a poner (solo si el tema
     dinámico NO está activo). Así sobrevive a cambiar de acento, de
     tema claro/oscuro y al cambio de tema del sistema.
   - Tema dinámico (dynTheme): si está activo, SU acento manda. El
     módulo lo detecta por #btnDynTheme[aria-pressed] y en ese caso
     aplica la base del tema rpm (fondo, superficies, texto) pero NO
     toca --accent*. Al apagar el dinámico, applyTheme() restaura el
     acento base y el observador vuelve a poner el acento rpm.
   - Color de acento (puntos de color): con un tema rpm activo, el
     acento lo fija el tema; los puntos no tienen efecto visible hasta
     volver a Automático / Claro / Oscuro. El acento base elegido se
     recuerda (snapshot) y se restaura al volver a 'default'.
   - Si el módulo falla al cargar, la app sigue igual: todo el init
     va en try/catch y nunca se toca el DOM de la app salvo añadir
     clases/atributos y el <link> de temas.css si falta.

   FAIL-SAFE: cualquier error, localStorage bloqueado o DOM ausente
   deja la app byte-idéntica a como estaba sin este módulo. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'reproductor-tema-rpm';
  var ATTR = 'data-rpm-theme';
  var RPM_IDS = ['neon', 'sunset', 'forest'];
  var APP_IDS = ['auto', 'light', 'dark'];
  var ACCENT_VARS = ['--accent', '--accent-dark', '--accent-soft'];
  /* Todas las variables que define un tema rpm (las mismas en los 3).
     --green no está: la app no lo redefine en oscuro y se deja como está. */
  var THEME_VARS = [
    '--bg', '--bg-2', '--surface', '--surface-2', '--surface-3',
    '--text', '--muted', '--muted-2', '--line',
    '--accent', '--accent-dark', '--accent-soft',
    '--shadow', '--shadow-sm'
  ];

  /* Paletas. 'default' = sin tema rpm (manda data-theme / :root).
     Los valores de --accent* DEBEN coincidir con los del mismo tema
     en temas.css (hay un test que lo comprueba). */
  var THEMES = {
    'default': { name: 'Predeterminado', label: 'Tema de la app', vars: null },
    neon: {
      name: 'Neón', label: 'Tema Neón',
      vars: {
        '--bg': '#0A0A16', '--bg-2': '#101022',
        '--surface': '#151528', '--surface-2': '#1C1C33', '--surface-3': '#262640',
        '--text': '#EDF2FF', '--muted': '#9AA3C7', '--muted-2': '#6E7699',
        '--line': '#2A2A4A',
        '--accent': '#00E5FF', '--accent-dark': '#00B8D4', '--accent-soft': '#123B46',
        '--shadow': '0 16px 40px rgba(0,0,0,.5), 0 2px 10px rgba(0,0,0,.35)',
        '--shadow-sm': '0 6px 18px rgba(0,0,0,.4)'
      }
    },
    sunset: {
      name: 'Atardecer', label: 'Tema Atardecer',
      vars: {
        '--bg': '#FDF1E3', '--bg-2': '#F9E4CF',
        '--surface': '#FFF9F1', '--surface-2': '#FDEFE0', '--surface-3': '#F6DFC8',
        '--text': '#2E1B12', '--muted': '#7A5C4A', '--muted-2': '#A68A76',
        '--line': '#EDD9C4',
        '--accent': '#FF6B35', '--accent-dark': '#D94F1E', '--accent-soft': '#FFE0D2',
        '--shadow': '0 12px 32px rgba(60,30,10,.12), 0 2px 8px rgba(60,30,10,.07)',
        '--shadow-sm': '0 4px 14px rgba(60,30,10,.09)'
      }
    },
    forest: {
      name: 'Bosque', label: 'Tema Bosque',
      vars: {
        '--bg': '#0D1B12', '--bg-2': '#122619',
        '--surface': '#16291C', '--surface-2': '#1C3324', '--surface-3': '#24402E',
        '--text': '#E9F4EC', '--muted': '#9DB8A6', '--muted-2': '#6E8A78',
        '--line': '#243B2D',
        '--accent': '#4ADE80', '--accent-dark': '#22C55E', '--accent-soft': '#173B26',
        '--shadow': '0 16px 40px rgba(0,0,0,.5), 0 2px 10px rgba(0,0,0,.35)',
        '--shadow-sm': '0 6px 18px rgba(0,0,0,.4)'
      }
    }
  };

  /* ---- Partes puras (probadas en Node, sin DOM) ---- */

  function isValidThemeId(id) {
    return id === 'default' || RPM_IDS.indexOf(id) !== -1;
  }

  /* Cualquier valor raro (null, número, 'Neon', 'neón', '') -> 'default'. */
  function normalizeThemeId(value) {
    if (typeof value !== 'string') return 'default';
    var v = value.trim();
    return isValidThemeId(v) ? v : 'default';
  }

  function themeLabel(id) {
    var t = THEMES[normalizeThemeId(id)];
    return t ? t.label : 'Tema de la app';
  }

  /* Qué hace el módulo con un valor del #themeSelect.
     rpm -> lo gestiona este módulo (la app no debe verlo).
     app -> lo gestiona la app; el módulo solo apaga su tema.
     ignore -> valor desconocido: no se toca nada. */
  function decideSelectChange(value) {
    if (typeof value !== 'string') return { kind: 'ignore', id: 'default' };
    var v = value.trim();
    if (RPM_IDS.indexOf(v) !== -1) return { kind: 'rpm', id: v };
    if (APP_IDS.indexOf(v) !== -1) return { kind: 'app', id: v };
    return { kind: 'ignore', id: 'default' };
  }

  /* Valor que debe mostrar el #themeSelect: el tema rpm si hay uno,
     si no el tema de la app (auto/light/dark) que se recuerde. */
  function resolveSelectValue(rpmId, lastAppTheme) {
    var rpm = normalizeThemeId(rpmId);
    if (rpm !== 'default') return rpm;
    if (typeof lastAppTheme === 'string' && APP_IDS.indexOf(lastAppTheme.trim()) !== -1) {
      return lastAppTheme.trim();
    }
    return 'auto';
  }

  /* Solo las 3 variables de acento de un tema (las que applyTheme y
     applyDynTheme pisan en línea). null para 'default'. */
  function accentVarsOf(id) {
    var t = THEMES[normalizeThemeId(id)];
    if (!t || !t.vars) return null;
    return {
      '--accent': t.vars['--accent'],
      '--accent-dark': t.vars['--accent-dark'],
      '--accent-soft': t.vars['--accent-soft']
    };
  }

  function loadTheme(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return 'default';
      return normalizeThemeId(storage.getItem(STORAGE_KEY));
    } catch (e) {
      return 'default'; /* localStorage bloqueado: tema de la app */
    }
  }

  /* true si se guardó, false si el almacén falló (sin lanzar). */
  function saveTheme(storage, id) {
    try {
      if (!storage || typeof storage.setItem !== 'function') return false;
      storage.setItem(STORAGE_KEY, normalizeThemeId(id));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ¿Está el tema dinámico según la carátula activo? Se lee del DOM:
     #btnDynTheme[aria-pressed] manda; si no existe, el texto
     #dynThemeState ('Activado'). Sin DOM -> false. */
  function isDynThemeActive(ariaPressed, stateText) {
    if (ariaPressed === true || ariaPressed === 'true') return true;
    if (typeof stateText === 'string' && stateText.trim() === 'Activado') return true;
    return false;
  }

  function animationsEnabled(reducedMotion) {
    return !reducedMotion;
  }

  /* ---- Parte de navegador (nunca se ejecuta en Node) ---- */

  var current = 'default';
  var lastAppTheme = 'auto';
  /* Acento base de la app (el que puso applyTheme) ANTES de que el
     tema rpm lo pisara: se restaura al volver a 'default'. */
  var baseAccent = { '--accent': '', '--accent-dark': '', '--accent-soft': '' };
  var lastCoverAnim = 0;
  var lastListAnim = 0;
  var toastTimer = null;
  var listTimer = null;

  function $(id) { return document.getElementById(id); }

  function reducedMotion() {
    try {
      return !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function isDynActiveNow() {
    try {
      var b = $('btnDynTheme');
      var st = $('dynThemeState');
      return isDynThemeActive(
        b ? b.getAttribute('aria-pressed') : null,
        st ? st.textContent : null
      );
    } catch (e) { return false; }
  }

  function readInlineAccent() {
    var out = {};
    try {
      var root = document.documentElement;
      ACCENT_VARS.forEach(function (v) {
        out[v] = (root.style.getPropertyValue(v) || '').trim();
      });
    } catch (e) { /* sin root escribible: snapshot vacío */ }
    return out;
  }

  function snapshotBaseAccent() {
    baseAccent = readInlineAccent();
  }

  /* Escribe las variables del tema en línea. Con tema dinámico activo
     NO se tocan las 3 de acento (el acento dinámico manda). */
  function applyThemeVars(id) {
    var root = document.documentElement;
    var theme = THEMES[id];
    if (!theme || !theme.vars) {
      try { root.removeAttribute(ATTR); } catch (e) {}
      THEME_VARS.forEach(function (v) {
        try {
          if (ACCENT_VARS.indexOf(v) !== -1) {
            if (baseAccent[v]) root.style.setProperty(v, baseAccent[v]);
            else root.style.removeProperty(v);
          } else {
            root.style.removeProperty(v);
          }
        } catch (e) { /* variable no escribible: se ignora */ }
      });
      return;
    }
    try { root.setAttribute(ATTR, id); } catch (e) {}
    var dyn = isDynActiveNow();
    Object.keys(theme.vars).forEach(function (v) {
      try {
        if (dyn && ACCENT_VARS.indexOf(v) !== -1) return; /* manda el dinámico */
        root.style.setProperty(v, theme.vars[v]);
      } catch (e) { /* variable no escribible: se ignora */ }
    });
  }

  /* El observador de style llama aquí: applyTheme()/applyDynTheme()
     acaban de reescribir --accent* en línea.
     - Tema rpm 'default': el acento ya es de la app/dinámico; solo se
       actualiza el snapshot para un futuro regreso a 'default'.
     - Tema rpm activo + dinámico ON: no se toca nada (manda el dinámico).
     - Tema rpm activo + dinámico OFF: se vuelve a poner el acento rpm.
     Solo se escribe si el valor actual difiere (evita bucles). */
  function restoreRpmAccentIfNeeded() {
    try {
      if (current === 'default') { snapshotBaseAccent(); return; }
      if (isDynActiveNow()) return;
      var want = accentVarsOf(current);
      if (!want) return;
      var root = document.documentElement;
      var now = readInlineAccent();
      ACCENT_VARS.forEach(function (v) {
        if (now[v] !== want[v]) root.style.setProperty(v, want[v]);
      });
    } catch (e) { /* fail-safe: el acento se queda como esté */ }
  }

  function syncSelect() {
    try {
      var sel = $('themeSelect');
      if (sel) sel.value = resolveSelectValue(current, lastAppTheme);
    } catch (e) { /* sin select no hay nada que sincronizar */ }
  }

  /* Toast propio reutilizando el #toast de la app (misma clase .show,
     mismo tiempo de 3200 ms). Si no existe, no pasa nada. */
  function showToast(msg) {
    try {
      var el = $('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        try { el.classList.remove('show'); } catch (e) {}
      }, 3200);
    } catch (e) { /* sin toast no se rompe nada */ }
  }

  function setTheme(id, opts) {
    var silent = !!(opts && opts.silent);
    var next = normalizeThemeId(id);
    current = next;
    try { applyThemeVars(next); } catch (e) {}
    try {
      if (typeof localStorage !== 'undefined') saveTheme(localStorage, next);
    } catch (e) {}
    syncSelect();
    if (!silent) showToast(themeLabel(next));
  }

  /* Igual que lyrics.js / cast.js: el módulo trae su propio CSS si
     WIRING.md no añadió el <link> en index.html. */
  function ensureCss() {
    try {
      if (document.querySelector('link[href="./temas.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './temas.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el tema sigue aplicando vars en línea */ }
  }

  /* ---- Animaciones ---- */

  function playCoverAnimation() {
    if (!animationsEnabled(reducedMotion())) return;
    var now = Date.now();
    if (now - lastCoverAnim < 250) return; /* título+portada llegan juntos */
    lastCoverAnim = now;
    try {
      var wrap = $('coverWrap');
      if (!wrap) return;
      wrap.classList.remove('rpm-cover-in');
      void wrap.offsetWidth; /* reflow: permite relanzar la animación */
      wrap.classList.add('rpm-cover-in');
      var done = function () {
        try { wrap.classList.remove('rpm-cover-in'); } catch (e) {}
      };
      /* Un solo listener por animación: se guarda en el elemento para
         poder quitar el anterior antes de añadir el nuevo. */
      try {
        if (wrap._rpmDone) wrap.removeEventListener('animationend', wrap._rpmDone);
        wrap._rpmDone = done;
        wrap.addEventListener('animationend', done);
      } catch (e) {}
      setTimeout(done, 900); /* por si animationend no llega */
    } catch (e) { /* sin portada no hay animación */ }
  }

  function playListAnimation() {
    if (!animationsEnabled(reducedMotion())) return;
    var now = Date.now();
    if (now - lastListAnim < 400) return; /* renderList reconstruye a menudo */
    lastListAnim = now;
    try {
      var list = $('trackList');
      if (!list) return;
      list.classList.add('rpm-list-in');
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(function () {
        try { list.classList.remove('rpm-list-in'); } catch (e) {}
      }, 650);
    } catch (e) { /* sin lista no hay animación */ }
  }

  function init() {
    try {
      ensureCss();

      /* El init de la app ya corrió (este script va después del
         <script> principal): el select ya vale settings.theme. */
      try {
        var sel0 = $('themeSelect');
        if (sel0) {
          var d0 = decideSelectChange(sel0.value);
          if (d0.kind === 'app') lastAppTheme = d0.id;
        }
      } catch (e) {}

      /* Snapshot del acento base ANTES de aplicar el tema guardado. */
      snapshotBaseAccent();

      var stored = 'default';
      try {
        if (typeof localStorage !== 'undefined') stored = loadTheme(localStorage);
      } catch (e) { stored = 'default'; }
      current = normalizeThemeId(stored);
      try { applyThemeVars(current); } catch (e) {}
      syncSelect();

      /* 1) Captura: los valores rpm no deben llegar al listener de la
         app (que los convertiría en 'auto'). */
      try {
        document.addEventListener('change', function (ev) {
          try {
            var t = ev.target;
            if (!t || t.id !== 'themeSelect') return;
            var d = decideSelectChange(t.value);
            if (d.kind === 'rpm') {
              ev.stopPropagation();
              if (typeof ev.preventDefault === 'function') ev.preventDefault();
              setTheme(d.id);
            }
          } catch (e) { /* cambio no gestionado: la app sigue igual */ }
        }, true);
      } catch (e) {}

      /* 2) Burbuja (respaldo + valores de la app): corre DESPUÉS del
         listener de la app. auto/light/dark -> apaga el tema rpm en
         silencio (la app ya mostró su toast). Un valor rpm aquí solo
         llega si la captura no lo paró (p. ej. evento sin burbuja). */
      try {
        var sel = $('themeSelect');
        if (sel) {
          sel.addEventListener('change', function () {
            try {
              var d = decideSelectChange(sel.value);
              if (d.kind === 'app') {
                lastAppTheme = d.id;
                setTheme('default', { silent: true });
              } else if (d.kind === 'rpm') {
                setTheme(d.id);
              }
            } catch (e) { /* la app ya hizo lo suyo */ }
          });
        }
      } catch (e) {}

      /* 3) Puntos de acento: syncThemeUI() de la app resetea el select
         a settings.theme; se vuelve a poner el valor rpm. */
      try {
        var dots = $('accentDots');
        if (dots) dots.addEventListener('click', function () { syncSelect(); });
      } catch (e) {}

      /* 4) Observador del style de <html>: applyTheme()/applyDynTheme()
         reescriben --accent* en línea; se restaura el acento rpm (o se
         actualiza el snapshot si el tema rpm está apagado). */
      try {
        if (typeof MutationObserver !== 'undefined') {
          var styleObs = new MutationObserver(function () {
            restoreRpmAccentIfNeeded();
          });
          styleObs.observe(document.documentElement, {
            attributes: true, attributeFilter: ['style']
          });
        }
      } catch (e) {}

      /* 5) Animación de portada al cambiar de canción: la app cambia
         #coverImg[src] y #nowTitle[textContent] en el mismo cambio. */
      try {
        if (typeof MutationObserver !== 'undefined') {
          var coverObs = new MutationObserver(function () { playCoverAnimation(); });
          var img = $('coverImg');
          if (img) coverObs.observe(img, { attributes: true, attributeFilter: ['src'] });
          var title = $('nowTitle');
          if (title) coverObs.observe(title, { childList: true, characterData: true, subtree: true });
          var list = $('trackList');
          if (list) {
            var listObs = new MutationObserver(function () { playListAnimation(); });
            listObs.observe(list, { childList: true });
          }
        }
      } catch (e) {}
    } catch (e) { /* fail-safe: sin temas, la app sigue funcionando */ }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    RPM_IDS: RPM_IDS,
    APP_IDS: APP_IDS,
    ACCENT_VARS: ACCENT_VARS,
    THEME_VARS: THEME_VARS,
    THEMES: THEMES,
    isValidThemeId: isValidThemeId,
    normalizeThemeId: normalizeThemeId,
    themeLabel: themeLabel,
    decideSelectChange: decideSelectChange,
    resolveSelectValue: resolveSelectValue,
    accentVarsOf: accentVarsOf,
    loadTheme: loadTheme,
    saveTheme: saveTheme,
    isDynThemeActive: isDynThemeActive,
    animationsEnabled: animationsEnabled
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmThemes = api; } catch (e) { /* consola: window.__rpmThemes */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
