/**
 * eq.js — matemáticas del ecualizador (extraído de index.html, 3.3.0)
 *
 * EXTRAÍDO SIN CAMBIAR LA LÓGICA de app/index.html:
 *  - Líneas 4203-4229: EQ_OLD_FREQS, EQ_FREQS, clampDb, eqTo10.
 *  - Líneas 5541-5548: EQ_PRESETS_5, EQ_PRESETS, EQ_LABELS, fmtDb.
 *
 * QUÉ ES: la parte PURA del EQ. No toca el DOM, ni el AudioContext,
 * ni settings, ni ninguna canción. Por eso se puede probar con Node
 * (ver test/eq.test.mjs) y por eso es la extracción más segura del
 * monolito: lo que queda en index.html (ensureVisualizer, buildEqRows,
 * syncEqUI, applyEqValues, currentEqValues, applyEq, genreEqValuesFor)
 * sigue leyendo los mismos nombres y no cambia ni una línea de uso.
 *
 * POR QUÉ ESTE ARCHIVO DEBE CARGARSE ANTES QUE EL <script> EN LÍNEA
 * DE index.html (ver WIRING.md §1): el IIFE de la app usa eqTo10 y
 * EQ_PRESETS de forma SÍNCRONA al arrancar — EQ_PRESETS se construye
 * en la línea 5546 durante la ejecución del IIFE, y buildEqRows() (que
 * usa EQ_LABELS y fmtDb) corre en el init. Un <script src> clásico
 * DESPUÉS del inline llegaría tarde. Al cargarse ANTES, este módulo
 * deja los nombres como globales (window.eqTo10, window.EQ_PRESETS…)
 * y el IIFE los resuelve por la cadena de ámbito, exactamente igual
 * que resolvía sus propias declaraciones. Sin este orden, la app
 * rompería al arrancar (ReferenceError en la línea 5546).
 *
 * COMPATIBILIDAD: script clásico (no ES module), mismo estilo ES5 con
 * var/function que el monolito, para que el código extraído sea
 * literalmente el mismo. Expone además el espacio de nombres
 * window.RpmEq y, para Node, module.exports (patrón de cast.js 3.1.0).
 *
 * SI EL ARCHIVO FALTA: la app falla ALTO al arrancar (no en silencio),
 * así que la verificación del WIRING (§5) lo detecta de inmediato.
 */

/* Frecuencias (Hz) de las 5 bandas históricas y de las 10 actuales. */
var EQ_OLD_FREQS = [60, 250, 1000, 4000, 12000];
var EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/* Etiquetas de las 10 bandas, en el mismo orden que EQ_FREQS. */
var EQ_LABELS = ['31 Hz', '62 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'];

/* Curvas históricas de 5 bandas de los presets de fábrica. */
var EQ_PRESETS_5 = { flat: [0, 0, 0, 0, 0], bass: [6, 4, 1, 0, 1], treble: [-1, 0, 1, 4, 6], pop: [-1, 2, 4, 2, 0], rock: [5, 2, -1, 3, 5], vocal: [-2, 0, 3, 4, 2] };

function clampDb(v) { v = parseFloat(v); return isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0; }

// Pack 9: ecualizador de 10 bandas octavales. La conversión 5→10 interpola
// sobre la curva en escala logarítmica de frecuencia: cada banda nueva toma
// el valor interpolado entre las dos bandas viejas que la rodean (y fuera
// del rango viejo, el valor de la banda vieja más cercana). Así, lo que el
// usuario ya tenía ajustado —EQ global, presets y memoria por canción—
// suena prácticamente igual, ahora con el doble de precisión.
function eqTo10(vals) {
  if (!Array.isArray(vals)) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (vals.length === 10) return vals.map(clampDb);
  if (vals.length !== 5) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var old = vals.map(clampDb);
  return EQ_FREQS.map(function (f) {
    if (f <= EQ_OLD_FREQS[0]) return old[0];
    if (f >= EQ_OLD_FREQS[EQ_OLD_FREQS.length - 1]) return old[old.length - 1];
    for (var i = 0; i < EQ_OLD_FREQS.length - 1; i++) {
      var f0 = EQ_OLD_FREQS[i], f1 = EQ_OLD_FREQS[i + 1];
      if (f >= f0 && f <= f1) {
        var t = Math.log(f / f0) / Math.log(f1 / f0);
        return Math.round((old[i] + (old[i + 1] - old[i]) * t) * 10) / 10;
      }
    }
    return old[old.length - 1];
  });
}

// Pack 9: los presets de fábrica se definen con su curva histórica de 5
// bandas y se convierten a 10 con la misma interpolación que convierte los
// datos del usuario, para que sigan sonando a lo mismo.
var EQ_PRESETS = {};
Object.keys(EQ_PRESETS_5).forEach(function (k) { EQ_PRESETS[k] = eqTo10(EQ_PRESETS_5[k]); });

function fmtDb(v) { return (v > 0 ? '+' : '') + v + ' dB'; }

(function (global) {
  'use strict';

  var api = {
    EQ_OLD_FREQS: EQ_OLD_FREQS,
    EQ_FREQS: EQ_FREQS,
    EQ_LABELS: EQ_LABELS,
    EQ_PRESETS_5: EQ_PRESETS_5,
    EQ_PRESETS: EQ_PRESETS,
    clampDb: clampDb,
    eqTo10: eqTo10,
    fmtDb: fmtDb
  };

  // Espacio de nombres (vía preferida para código nuevo).
  try { global.RpmEq = api; } catch (e) { /* sin global: solo module.exports */ }

  // Globales simples: son los nombres que el IIFE de index.html ya usa
  // (eqTo10, EQ_PRESETS, fmtDb…). Deben existir ANTES de que el
  // <script> en línea se ejecute (ver cabecera y WIRING.md §1).
  try {
    global.EQ_OLD_FREQS = EQ_OLD_FREQS;
    global.EQ_FREQS = EQ_FREQS;
    global.EQ_LABELS = EQ_LABELS;
    global.EQ_PRESETS_5 = EQ_PRESETS_5;
    global.EQ_PRESETS = EQ_PRESETS;
    global.clampDb = clampDb;
    global.eqTo10 = eqTo10;
    global.fmtDb = fmtDb;
  } catch (e) { /* sin global: solo module.exports */ }

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
