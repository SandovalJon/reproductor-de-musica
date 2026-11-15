/* Rediseño total de la interfaz (v4.0.0) — módulo aparte.
   NO toca el código de index.html: la app es un IIFE y settings /
   toast NO son globales, así que este módulo convive con ella solo
   por DOM, por el atributo html[data-rpm-redisenio] y por variables
   CSS (redisenio.css).

   QUÉ HACE
   - Cara nueva para toda la app: paleta moderna clara y oscura,
     radios mayores, más aire (espaciado), cabecera y reproductor
     renovados, tarjetas de canciones y secciones con aspecto moderno.
     Misma biblioteca, mismos ajustes y mismas funciones: solo cambia
     la presentación.
   - Conmutador en Ajustes · Apariencia ("Diseño moderno",
     #btnRedisenio): guarda la preferencia en localStorage (clave
     'reproductor-redisenio', 'on'/'off') y la aplica al cargar.
   - Por defecto ACTIVADO en 4.0.0: sin valor guardado, el rediseño
     está encendido. Apagarlo vuelve al aspecto clásico.
   - El acento elegido por el usuario (puntos de color, tema
     dinámico, temas Neón/Atardecer/Bosque) NO se toca: el rediseño
     redefine fondo, superficies, texto, líneas, sombras y radios,
     pero deja --accent/--accent-dark/--accent-soft en manos de la
     app. Con un tema rpm activo, su paleta (variables en línea)
     sigue mandando sobre la base del rediseño; el resto del
     rediseño (radios, espaciado, tarjetas, cabecera, reproductor)
     se aplica igual.

   CONVIVENCIA CON LO QUE YA EXISTE (leer antes de tocar nada)
   - El rediseño vive bajo html[data-rpm-redisenio="on"]: todas las
     reglas de redisenio.css llevan ese prefijo, así que con el
     atributo en "off" (o ausente) la app es byte-idéntica a la
     clásica. No se toca ningún id ni ninguna estructura que usen
     otros módulos.
   - Las variables de redisenio.css usan el selector
     html:root[data-rpm-redisenio="on"] (especificidad 0,2,1), que
     gana a html[data-theme="dark"] / html[data-theme="light"] del
     <style> de index.html sin importar el orden de los <link>.
     El modo oscuro automático (sin data-theme, sigue al sistema)
     se cubre con una media query prefers-color-scheme.
   - La única regla con !important es el degradado del
     .cover-fallback, porque la app lo pone en línea (style="...").
   - El botón #btnRedisenio es un toggle-pill como #btnDynTheme /
     #btnLargeText, en el grupo "Apariencia" del panel "Sonido y
     temporizador". Su estado inicial en el HTML es Activado, que
     es el valor por defecto; este módulo lo corrige al cargar si
     el usuario lo había apagado.

   FAIL-SAFE: cualquier error, localStorage bloqueado o DOM ausente
   deja la app con su aspecto clásico sin romperse: todo el init
   va en try/catch y nunca se escribe fuera del atributo
   data-rpm-redisenio ni del botón propio. Si redisenio.js no
   carga, redisenio.css no tiene efecto porque el atributo nunca
   se pone en "on". */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'reproductor-redisenio';
  var ATTR = 'data-rpm-redisenio';
  var BTN_ID = 'btnRedisenio';
  var STATE_ID = 'redisenioState';

  /* Valor guardado ('on'/'off') -> true/false; cualquier otra cosa
     (null, vacío, basura) -> null (sin preferencia: manda el
     valor por defecto, activado). */
  function parseStored(value) {
    if (value === 'on') return true;
    if (value === 'off') return false;
    return null;
  }

  /* Preferencia efectiva: lo guardado si existe; si no, activado
     (por defecto en 4.0.0). */
  function resolveEnabled(storedValue) {
    var parsed = parseStored(storedValue);
    return parsed === null ? true : parsed;
  }

  function toggleEnabled(current) {
    return !current;
  }

  function stateLabel(enabled) {
    return enabled ? 'Activado' : 'Apagado';
  }

  /* Aplica el estado al documento: atributo en <html> (lo que
     enciende/apaga todo redisenio.css) y estado visual del botón
     en Ajustes. `doc` es document (o un doble en tests). Devuelve
     el estado aplicado. No lanza si falta algo. */
  function applyToDocument(doc, enabled) {
    try {
      var root = doc && doc.documentElement;
      if (root && root.setAttribute) {
        root.setAttribute(ATTR, enabled ? 'on' : 'off');
      }
      var btn = doc && doc.getElementById ? doc.getElementById(BTN_ID) : null;
      if (btn) {
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('on', !!enabled);
        if (btn.setAttribute) btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        var st = doc.getElementById(STATE_ID);
        if (st) st.textContent = stateLabel(enabled);
      }
    } catch (e) { /* fail-safe: sin rediseño, la app sigue clásica */ }
    return enabled;
  }

  function loadStored(storage) {
    try {
      if (storage && storage.getItem) return storage.getItem(STORAGE_KEY);
    } catch (e) { /* localStorage bloqueado: manda el defecto */ }
    return null;
  }

  function saveStored(storage, enabled) {
    try {
      if (storage && storage.setItem) storage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    } catch (e) { /* localStorage bloqueado: el cambio solo vive en sesión */ }
  }

  function isEnabled(doc) {
    try {
      var root = doc && doc.documentElement;
      if (root && root.getAttribute) return root.getAttribute(ATTR) === 'on';
    } catch (e) {}
    return false;
  }

  function init() {
    try {
      var storage = null;
      try { storage = global.localStorage; } catch (e) { storage = null; }
      var enabled = resolveEnabled(loadStored(storage));
      var doc = (typeof document !== 'undefined') ? document : null;
      if (!doc) return;
      applyToDocument(doc, enabled);
      var btn = doc.getElementById(BTN_ID);
      if (btn && btn.addEventListener) {
        btn.addEventListener('click', function () {
          try {
            var current = isEnabled(doc);
            var next = toggleEnabled(current);
            saveStored(storage, next);
            applyToDocument(doc, next);
          } catch (e) { /* fail-safe: el clic nunca rompe la app */ }
        });
      }
    } catch (e) { /* fail-safe: sin rediseño, la app sigue clásica */ }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    ATTR: ATTR,
    BTN_ID: BTN_ID,
    STATE_ID: STATE_ID,
    parseStored: parseStored,
    resolveEnabled: resolveEnabled,
    toggleEnabled: toggleEnabled,
    stateLabel: stateLabel,
    applyToDocument: applyToDocument,
    loadStored: loadStored,
    saveStored: saveStored,
    isEnabled: isEnabled
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmRedisenio = api; } catch (e) { /* consola: window.__rpmRedisenio */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
