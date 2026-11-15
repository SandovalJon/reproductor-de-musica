/**
 * format.js — utilidades puras de formato y texto (extraído de index.html, 4.0.0)
 *
 * EXTRAÍDO SIN CAMBIAR LA LÓGICA de app/index.html (código literal, solo
 * sin los 2 espacios de sangría del IIFE):
 *  - Líneas 2471-2479: PALETTE y colorFor.
 *  - Líneas 2480-2486: fmtTime. Líneas 2487-2492: fmtSize.
 *  - Líneas 2818-2829: ID3_GENRES y cleanGenre.
 *  - Líneas 2944-2946: cleanName.
 *  - Líneas 3967-3977: fmtWhen.
 *  - Líneas 6904-6909: fmtMins, dayStart, weekStart.
 *  - Líneas 7000-7002: normStr.
 *  - Líneas 9160-9165: cmpVersion.
 *
 * QUÉ ES: la parte PURA de formato. No toca el DOM, ni IndexedDB, ni el
 * audio, ni settings, ni ninguna canción: cada función solo depende de sus
 * argumentos (y, en el caso de colorFor/cleanGenre, de las tablas PALETTE /
 * ID3_GENRES que viajan en este mismo archivo). Por eso se puede probar
 * con Node (ver test/format.test.mjs).
 *
 * EN INDEX.HTML QUEDAN ADAPTADORES de una línea por función (misma firma,
 * mismo nombre), que delegan en window.RpmFormat y, si el módulo no cargó,
 * devuelven un valor degradado seguro (ver WIRING.md §2). Ningún uso
 * cambia: las ~70 llamadas a fmtTime, fmtSize, fmtWhen, fmtMins,
 * dayStart, weekStart, cmpVersion, colorFor, cleanGenre, cleanName y
 * normStr siguen leyendo los mismos nombres dentro del IIFE.
 *
 * POR QUÉ SOLO ESPACIO DE NOMBRES (sin globales simples como eq.js):
 * varios de estos nombres YA existen como funciones propias en otros
 * scripts clásicos que cargan DESPUÉS del inline y los sobreescribirían:
 * karaoke.js define su propio fmtTime (distinto: sin horas, "65:00" en
 * vez de "1:05:00"), timeline.js y wrapped.js definen su propio dayStart,
 * export-m3u.js define su propio cleanName y su propio normStr. Si este
 * módulo dejara un fmtTime global, karaoke.js lo pisaría al cargar y
 * todas las duraciones >= 1 h de la app pasarían a mostrarse mal.
 * El adaptador dentro del IIFE llama a RpmFormat.fmtTime, que nadie pisa.
 *
 * CARGA ANTES DEL <script> EN LÍNEA (ver WIRING.md §1): el IIFE usa
 * estas funciones de forma SÍNCRONA al arrancar (renderStats/render usan
 * fmtTime en el init; visibleTracks usa la búsqueda; checkForUpdate usa
 * cmpVersion). Un <script src> clásico DESPUÉS del inline llegaría
 * tarde. Al cargarse ANTES, el namespace ya existe cuando el IIFE corre.
 *
 * COMPATIBILIDAD: script clásico (no ES module), mismo estilo ES5 con
 * var/function que el monolito, para que el código extraído sea
 * literalmente el mismo. Expone window.RpmFormat y, para Node,
 * module.exports (patrón de eq.js 3.3.0).
 */
(function(global){
'use strict';

var PALETTE = [
  ['#3A2A1A','#E94E1B'], ['#12261E','#1F9D66'], ['#1D2440','#4F7CFF'], ['#33182E','#C94F9E'],
  ['#0F2B33','#1AA6A0'], ['#31220F','#E8A51B'], ['#241A3A','#7B5CFF'], ['#2E1414','#E05252'],
  ['#14261A','#6DBE45'], ['#2A1E12','#D07A2D']
];
function colorFor(str){
  var h=0; for(var i=0;i<str.length;i++){ h=(h*31 + str.charCodeAt(i))>>>0; }
  return PALETTE[h % PALETTE.length];
}

function fmtTime(sec){
  if(!isFinite(sec) || sec==null || sec<0) return '0:00';
  sec = Math.floor(sec);
  var m = Math.floor(sec/60), s = sec%60;
  if(m>=60){ var hh=Math.floor(m/60); return hh+':'+String(m%60).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
  return m+':'+String(s).padStart(2,'0');
}

function fmtSize(bytes){
  if(!bytes && bytes!==0) return '';
  if(bytes<1024) return bytes+' B';
  if(bytes<1024*1024) return (bytes/1024).toFixed(0)+' KB';
  return (bytes/(1024*1024)).toFixed(1)+' MB';
}

var ID3_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychadelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];
function cleanGenre(g){
  g = (g || '').trim();
  if(!g) return '';
  var m = /^\((\d+)\)\s*(.*)$/.exec(g);
  if(m){
    if(m[2]) return m[2].trim();
    return ID3_GENRES[parseInt(m[1], 10)] || '';
  }
  if(/^\d+$/.test(g)) return ID3_GENRES[parseInt(g, 10)] || '';
  return g;
}

function cleanName(name){
  return name.replace(/\.[^.]+$/,'').replace(/[_]+/g,' ').replace(/\s+/g,' ').trim();
}

function fmtWhen(ts){
  try{
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString()===now.toDateString();
    var time = d.toLocaleTimeString('es', {hour:'2-digit', minute:'2-digit'});
    if(sameDay) return 'Hoy · '+time;
    var y = new Date(now); y.setDate(now.getDate()-1);
    if(d.toDateString()===y.toDateString()) return 'Ayer · '+time;
    return d.toLocaleDateString('es', {day:'numeric', month:'short'}) + ' · ' + time;
  }catch(e){ return ''; }
}

function fmtMins(sec){
  if(sec >= 3600) return (sec/3600).toFixed(1).replace('.', ',') + ' h';
  return Math.round(sec/60) + ' min';
}
function dayStart(ts){ var d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function weekStart(ts){ var d = new Date(dayStart(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

function normStr(s){
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function cmpVersion(a, b){
  var pa = a.split('.').map(function(x){ return parseInt(x, 10) || 0; });
  var pb = b.split('.').map(function(x){ return parseInt(x, 10) || 0; });
  for(var i = 0; i < 3; i++){ if(pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1; }
  return 0;
}
/* ---- API pública ---- */
var api = {
  PALETTE: PALETTE,
  ID3_GENRES: ID3_GENRES,
  colorFor: colorFor,
  fmtTime: fmtTime,
  fmtSize: fmtSize,
  fmtWhen: fmtWhen,
  fmtMins: fmtMins,
  dayStart: dayStart,
  weekStart: weekStart,
  normStr: normStr,
  cleanGenre: cleanGenre,
  cleanName: cleanName,
  cmpVersion: cmpVersion
};

  // Espacio de nombres (vía preferida para código nuevo). A propósito NO
  // se dejan globales simples: ver cabecera (nombres gemelos en otros
  // scripts clásicos que cargarían después y los pisarían).
  try { global.RpmFormat = api; } catch (e) { /* sin global: solo module.exports */ }

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
