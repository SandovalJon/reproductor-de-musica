/**
 * search.js — motor de búsqueda tolerante (extraído de index.html, 4.0.0)
 *
 * EXTRAÍDO SIN CAMBIAR LA LÓGICA de app/index.html (código literal, solo
 * sin los 2 espacios de sangría del IIFE):
 *  - Líneas 3232-3234: normSearchText.
 *  - Líneas 3235-3252: editDist.
 *  - Líneas 3253-3259: searchDataOf.
 *  - Líneas 3260-3274: termMatchesTrack.
 *  - Líneas 3275-3281: trackMatchesSearch.
 * (Pack de mejoras 2: búsqueda tolerante — ignora acentos, tolera errores
 * leves de escritura en palabras largas, busca por nombre de archivo y
 * entiende combinaciones "artista álbum" en una sola búsqueda.)
 *
 * QUÉ ES: el núcleo PURO de la búsqueda. No toca el DOM ni el estado de
 * la app: cada función solo depende de sus argumentos. searchDataOf guarda
 * su caché en la propia canción (t._sf), no en el cierre del IIFE, así
 * que funciona igual fuera de él. Por eso se puede probar con Node
 * (ver test/search.test.mjs), incluidos casos diferenciales contra el
 * comportamiento original.
 *
 * EN INDEX.HTML QUEDAN ADAPTADORES de una línea por función (misma firma,
 * mismo nombre), que delegan en window.RpmSearch y, si el módulo no
 * cargó, usan un modo degradado (subcadena sin acentos ni difusa, ver
 * WIRING.md §2). Ningún uso cambia: visibleTracks() y los demás usos
 * siguen llamando a trackMatchesSearch / normSearchText como antes.
 *
 * POR QUÉ SOLO ESPACIO DE NOMBRES (sin globales simples como eq.js):
 * buscar-letra.js y otros módulos ya duplican estas ideas con nombres
 * propios (normBuscar); dejar globales simples ampliaría la superficie
 * de colisión con futuros scripts. El adaptador dentro del IIFE llama a
 * RpmSearch.*, que nadie pisa.
 *
 * CARGA ANTES DEL <script> EN LÍNEA (ver WIRING.md §1): el IIFE usa
 * trackMatchesSearch de forma SÍNCRONA al arrancar (visibleTracks corre
 * en el init vía render()). Un <script src> clásico DESPUÉS del inline
 * llegaría tarde.
 *
 * COMPATIBILIDAD: script clásico (no ES module), mismo estilo ES5 con
 * var/function que el monolito, para que el código extraído sea
 * literalmente el mismo. Expone window.RpmSearch y, para Node,
 * module.exports (patrón de eq.js 3.3.0).
 */
(function(global){
'use strict';

function normSearchText(s){
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
function editDist(a, b){
  var la = a.length, lb = b.length;
  if(Math.abs(la - lb) > 2) return 99;
  var prev = [], cur = [], i, j, tmp;
  for(j = 0; j <= lb; j++) prev[j] = j;
  for(i = 1; i <= la; i++){
    cur[0] = i;
    var best = cur[0];
    for(j = 1; j <= lb; j++){
      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if(cur[j] < best) best = cur[j];
    }
    if(best > 2) return 99;
    tmp = prev; prev = cur; cur = tmp;
  }
  return prev[lb];
}
function searchDataOf(t){
  if(t._sf) return t._sf;
  var fields = [t.title, t.artist, t.album, t.name, t.genre, t.year, (t.tags || []).join(' ')].map(normSearchText);
  var words = (fields[0] + ' ' + fields[1] + ' ' + fields[2] + ' ' + fields[3]).split(' ').filter(function(w){ return w.length >= 3; });
  t._sf = { fields: fields, words: words };
  return t._sf;
}
function termMatchesTrack(term, data){
  var i;
  for(i = 0; i < data.fields.length; i++){
    if(data.fields[i].indexOf(term) >= 0) return true;
  }
  // Coincidencia difusa solo sobre las palabras de título/artista/álbum/archivo
  if(term.length >= 4){
    var maxDist = term.length >= 7 ? 2 : 1;
    for(i = 0; i < data.words.length; i++){
      var w = data.words[i];
      if(Math.abs(w.length - term.length) <= maxDist && editDist(term, w) <= maxDist) return true;
    }
  }
  return false;
}
function trackMatchesSearch(t, terms){
  var data = searchDataOf(t);
  for(var i = 0; i < terms.length; i++){
    if(!termMatchesTrack(terms[i], data)) return false;
  }
  return true;
}
/* ---- API pública ---- */
var api = {
  normSearchText: normSearchText,
  editDist: editDist,
  searchDataOf: searchDataOf,
  termMatchesTrack: termMatchesTrack,
  trackMatchesSearch: trackMatchesSearch
};

  // Espacio de nombres (vía preferida para código nuevo). A propósito NO
  // se dejan globales simples: ver cabecera (nombres gemelos en otros
  // scripts clásicos que cargarían después y los pisarían).
  try { global.RpmSearch = api; } catch (e) { /* sin global: solo module.exports */ }

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
