/**
 * smart-lists.js — listas inteligentes (extraído de index.html, 3.3.0)
 *
 * EXTRAÍDO SIN CAMBIAR LA LÓGICA de app/index.html:
 *  - Líneas 6280-6289: SMART_LISTS (las 8 listas de fábrica).
 *  - Líneas 6296-6328: computeSmartBase (el cálculo de cada lista).
 *  - Líneas 11808-11813: lastPlayedMap (última reproducción por canción).
 *  - Líneas 11814-11834: computeForgotten (lista «Olvidadas»).
 *
 * QUÉ ES: el cálculo PURO de las listas inteligentes. No toca el DOM,
 * ni reproduce nada, ni guarda estado: dada una biblioteca y unos
 * contadores, devuelve la lista de canciones. Por eso se puede probar
 * con Node (ver test/smart-lists.test.mjs).
 *
 * LA ÚNICA ADAPTACIÓN (sin cambio de comportamiento): el monolito lee
 * sus variables del cierre del IIFE (tracks, playCounts, playHistory,
 * statsLog, customSmart) y dos funciones vecinas (isBlocked,
 * computeCustomSmart). Un archivo aparte no puede ver ese cierre, así
 * que computeSmartBase recibe TODO eso como un segundo argumento, ctx:
 *
 *   computeSmartBase(id, {
 *     tracks, playCounts, playHistory, statsLog, customSmart,
 *     isBlocked,          // función (t) -> bool, queda en index.html
 *     computeCustomSmart, // función (def) -> [tracks], queda en index.html
 *     now                // opcional; por defecto Date.now()
 *   })
 *
 * En index.html queda UN adaptador de 1 línea (la propia computeSmart,
 * líneas 6290-6295) que construye ese ctx desde el cierre, y otro de
 * 1 línea para lastPlayedMap (líneas 11808-11813). Todos los demás
 * usos —renderSmart, playSmart, updateForgottenCount, los botones—
 * llaman a computeSmart(id) como siempre y no cambian. Ver WIRING.md.
 *
 * QUÉ QUEDA EN index.html, A PROPÓSITO:
 *  - computeSmart (adaptador + «sin repetir» vía applyCooldownTracks).
 *  - renderSmart / playSmart / updateDiscoverCount / updateForgottenCount
 *    (DOM y reproducción; no son extraíbles sin reescribir la app).
 *  - smartDefById (líneas 9628-9640): mezcla SMART_LISTS con las
 *    listas propias (customSmart) Y con describeCustomSmart, que depende
 *    del motor de reglas (csField, csOps, describeRule). Sacarla
 *    obligaría a sacar también el motor de reglas: fuera de alcance.
 *  - isBlocked / computeCustomSmart / applyCooldownTracks / cooldownIdSet
 *    (dependen del estado del perfil, de las reglas y de settings).
 *  - lastPlayedMap como adaptador de 1 línea: cooldownIdSet (línea
 *    12486) la llama sin argumentos, así que el nombre sin argumentos
 *    debe seguir existiendo dentro del IIFE.
 *
 * POR QUÉ ESTE ARCHIVO DEBE CARGARSE ANTES QUE EL <script> EN LÍNEA
 * DE index.html (ver WIRING.md §1): computeSmart se llama de forma
 * SÍNCRONA durante el arranque — updateForgottenCount() en la línea
 * 12462 es una sentencia de nivel superior del IIFE, y render() del
 * init también puede llegar a computeSmart vía updateDiscoverCount.
 * Un <script src> clásico DESPUÉS del inline llegaría tarde. Al
 * cargarse ANTES, este módulo deja SMART_LISTS y computeSmartBase como
 * globales y el IIFE los resuelve por la cadena de ámbito, exactamente
 * igual que resolvía sus propias declaraciones.
 *
 * COMPATIBILIDAD: script clásico (no ES module), mismo estilo ES5 con
 * var/function que el monolito, para que el código extraído sea
 * literalmente el mismo. Expone además window.RpmSmart y, para Node,
 * module.exports (patrón de cast.js 3.1.0).
 *
 * DEFENSAS MÍNIMAS (solo ante ctx incompleto, algo que en la app no
 * ocurre porque el adaptador siempre lo pasa completo): tracks ausente
 * se trata como lista vacía, playCounts ausente como {}, isBlocked
 * ausente como «nada bloqueado», computeCustomSmart ausente como
 * «lista propia vacía». Con el ctx completo, el resultado es idéntico
 * al del monolito (verificado por diferencial, WIRING.md §5).
 */

/* Las 8 listas inteligentes de fábrica (copia literal, líneas 6280-6289). */
var SMART_LISTS = [
  { id: 'best', name: 'Mejor calificadas', desc: 'Canciones con like (y con 3 estrellas donde esa calificación existe).', emptyText: 'Todavía no tienes canciones con like. Marca “Me gusta” en las que quieras guardar aquí.' },
  { id: 'most', name: 'Más escuchadas', desc: 'Las que más veces han sonado en este dispositivo, primero las de más arriba.', emptyText: 'Aún no hay reproducciones registradas. Cuando escuches canciones, las más repetidas aparecerán aquí.' },
  { id: 'never', name: 'Nunca escuchadas', desc: 'Canciones de tu biblioteca que todavía no han sonado ni una vez.', emptyText: 'Ya escuchaste todo al menos una vez. Nada pendiente por descubrir aquí.' },
  { id: 'recent', name: 'Recién agregadas', desc: 'Lo último que entró a tu biblioteca, lo más nuevo primero.', emptyText: 'Tu biblioteca está vacía. Añade canciones y aparecerán aquí.' },
  { id: 'discover', name: 'Descubrir', desc: 'Mezcla automática: primero las que nunca o casi nunca has escuchado, revueltas con tus mejor calificadas.', emptyText: 'Tu biblioteca está vacía. Añade canciones y esta mezcla se armará sola.' },
  { id: 'calm', name: 'Energía tranquila', desc: 'Canciones con ritmo bajo detectado (menos de 100 BPM), de la más calmada a la menos.', emptyText: 'Todavía no hay canciones tranquilas detectadas. Analiza el ritmo (BPM) de tu biblioteca con el botón «Analizar ritmo (BPM) de la biblioteca».' },
  { id: 'intense', name: 'Energía intensa', desc: 'Canciones con ritmo alto detectado (120 BPM o más), de la más intensa a la menos.', emptyText: 'Todavía no hay canciones intensas detectadas. Analiza el ritmo (BPM) de tu biblioteca con el botón «Analizar ritmo (BPM) de la biblioteca».' },
  { id: 'forgotten', name: 'Olvidadas', desc: 'Canciones con like o entre las más escuchadas que no suenan desde hace 90 días o más, ordenadas por más tiempo sin sonar.', emptyText: 'Nada olvidado por aquí: tus favoritas han sonado en los últimos 90 días, o todavía no tienes favoritas con historial de escucha.' }
];

/* Última reproducción conocida de cada canción (copia literal, 11808-11813).
 * playHistory va de más reciente a más antigua, así que la primera
 * entrada de cada id es la última vez que sonó; statsLog solo sube el
 * valor si trae una fecha posterior. */
function lastPlayedMap(playHistory, statsLog) {
  var map = {};
  (Array.isArray(playHistory) ? playHistory : []).forEach(function (h) { if (h && h.id && typeof h.at === 'number' && !(h.id in map)) map[h.id] = h.at; });
  (Array.isArray(statsLog) ? statsLog : []).forEach(function (e) { if (e && e.id && typeof e.at === 'number' && (!(e.id in map) || e.at > map[e.id])) map[e.id] = e.at; });
  return map;
}

/* Lista inteligente «Olvidadas» (copia literal, 11814-11834).
 * now es inyectable solo para probar el límite de 90 días; en la app
 * el adaptador no lo pasa y vale Date.now(), como en el monolito. */
function computeForgotten(tracks, playCounts, playHistory, statsLog, now) {
  var list = Array.isArray(tracks) ? tracks : [];
  var counts = (playCounts && typeof playCounts === 'object') ? playCounts : {};
  var limit = ((typeof now === 'number' && isFinite(now)) ? now : Date.now()) - 90 * 86400000;
  var lp = lastPlayedMap(playHistory, statsLog);
  // «Entre las más escuchadas»: las 25 con más reproducciones (mínimo 3).
  var topSet = {};
  list.filter(function (t) { return (counts[t.id] || 0) >= 3; })
    .sort(function (a, b) { return (counts[b.id] || 0) - (counts[a.id] || 0); })
    .slice(0, 25)
    .forEach(function (t) { topSet[t.id] = 1; });
  function lastOf(t) {
    if (typeof lp[t.id] === 'number') return lp[t.id];
    if ((counts[t.id] || 0) > 0) return t.addedAt || 0; // sonó, pero su fecha salió del historial recortado
    return null; // nunca sonó: eso es «Nunca escuchadas», no «Olvidadas»
  }
  return list.filter(function (t) {
    var fav = t.rating === 'like' || (typeof t.stars === 'number' && t.stars >= 3) || !!topSet[t.id];
    if (!fav) return false;
    var last = lastOf(t);
    return last != null && last <= limit;
  }).sort(function (a, b) { return lastOf(a) - lastOf(b); }); // la que más tiempo lleva sin sonar, primero
}

/* Cálculo de una lista inteligente (copia literal, 6296-6328, con el
 * estado del IIFE recibido en ctx en vez de leído del cierre). */
function computeSmartBase(id, ctx) {
  ctx = ctx || {};
  var tracks = Array.isArray(ctx.tracks) ? ctx.tracks : [];
  var playCounts = (ctx.playCounts && typeof ctx.playCounts === 'object') ? ctx.playCounts : {};
  var customSmart = Array.isArray(ctx.customSmart) ? ctx.customSmart : [];
  var isBlocked = (typeof ctx.isBlocked === 'function') ? ctx.isBlocked : function () { return false; };
  var computeCustomSmart = (typeof ctx.computeCustomSmart === 'function') ? ctx.computeCustomSmart : function () { return []; };
  // Pack 13: lo bloqueado (artista/álbum) queda fuera de TODAS las listas
  // inteligentes y automáticas, igual que fuera del aleatorio/DJ/radio.
  var nb = function (t) { return !isBlocked(t); };
  if (typeof id === 'string' && id.indexOf('cs:') === 0) {
    var csd = null;
    for (var ci = 0; ci < customSmart.length; ci++) { if (customSmart[ci].id === id) csd = customSmart[ci]; }
    return (csd ? computeCustomSmart(csd) : []).filter(nb);
  }
  if (id === 'discover') {
    var fresh = tracks.filter(function (t) { return !(playCounts[t.id] > 0); });
    var rare = tracks.filter(function (t) { var c = playCounts[t.id] || 0; return c >= 1 && c <= 2; })
      .sort(function (a, b) { return (playCounts[a.id] || 0) - (playCounts[b.id] || 0); });
    var pool = fresh.concat(rare);
    var inPool = {}; pool.forEach(function (t) { inPool[t.id] = 1; });
    var bestP = tracks.filter(function (t) { return !inPool[t.id] && (t.rating === 'like' || (typeof t.stars === 'number' && t.stars >= 3)); });
    var outD = [], bi = 0;
    pool.forEach(function (t, i) {
      outD.push(t);
      if ((i + 1) % 3 === 0 && bi < bestP.length) outD.push(bestP[bi++]);
    });
    while (bi < bestP.length) outD.push(bestP[bi++]);
    return outD.filter(nb).slice(0, 60);
  }
  if (id === 'calm') return tracks.filter(function (t) { return typeof t.bpm === 'number' && t.bpm > 0 && t.bpm < 100; }).sort(function (a, b) { return a.bpm - b.bpm; }).filter(nb);
  if (id === 'intense') return tracks.filter(function (t) { return typeof t.bpm === 'number' && t.bpm >= 120; }).sort(function (a, b) { return b.bpm - a.bpm; }).filter(nb);
  if (id === 'best') return tracks.filter(function (t) { return t.rating === 'like' || (typeof t.stars === 'number' && t.stars >= 3); }).filter(nb);
  if (id === 'most') return tracks.filter(function (t) { return (playCounts[t.id] || 0) > 0; })
    .sort(function (a, b) { return (playCounts[b.id] || 0) - (playCounts[a.id] || 0); }).slice(0, 50).filter(nb);
  if (id === 'never') return tracks.filter(function (t) { return !(playCounts[t.id] > 0); }).filter(nb);
  if (id === 'forgotten') return computeForgotten(tracks, playCounts, ctx.playHistory, ctx.statsLog, ctx.now).filter(nb); // Pack 12 + Pack 13
  return tracks.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); }).slice(0, 50).filter(nb);
}

(function (global) {
  'use strict';

  var api = {
    SMART_LISTS: SMART_LISTS,
    lastPlayedMap: lastPlayedMap,
    computeForgotten: computeForgotten,
    computeSmartBase: computeSmartBase
  };

  // Espacio de nombres (vía preferida para código nuevo).
  try { global.RpmSmart = api; } catch (e) { /* sin global: solo module.exports */ }

  // Globales simples: son los nombres que el IIFE de index.html ya usa
  // (SMART_LISTS en renderSmart/smartDefById; computeSmartBase en el
  // adaptador computeSmart). Deben existir ANTES de que el <script> en
  // línea se ejecute (ver cabecera y WIRING.md §1). lastPlayedMap y
  // computeForgotten NO se exponen como globales: en index.html
  // lastPlayedMap sigue siendo el adaptador sin argumentos y
  // computeForgotten solo se usa dentro de computeSmartBase.
  try {
    global.SMART_LISTS = SMART_LISTS;
    global.computeSmartBase = computeSmartBase;
  } catch (e) { /* sin global: solo module.exports */ }

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
