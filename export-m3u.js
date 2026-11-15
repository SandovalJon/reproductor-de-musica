/* export-m3u.js — Exportar biblioteca y cola como .m3u (reproductor-de-musica v3.8.0, módulo aparte)
 *
 * Qué hace: añade SOLO lo que la app no tiene — exportar la biblioteca
 * completa y la cola de reproducción como .m3u — y enriquece el formato
 * con lo que el exportador actual pierde. NO toca los botones existentes
 * #btnPlM3u (playlist, index.html ~l.1455/6500) ni #btnSmartM3u (lista
 * inteligente, ~l.1576/6369): esos siguen usando exportM3U() de la app.
 *
 * Verificación de la ida y vuelta (leído en app/index.html, no inventado;
 * reproducido en export-m3u.test.mjs con una transcripción literal del
 * exportador de la app):
 *   - Exportador actual, exportM3U(name, list) ~l.6489-6498:
 *       #EXTM3U
 *       #EXTINF:<segundos>,<artista> - <título>
 *       <t.name>                       (nombre de archivo, tal cual)
 *     NO escribe #PLAYLIST: ni #EXTALB ni género.
 *   - Importador actual, parseM3U ~l.7983-7999 + matchM3UEntry ~l.8000-8027
 *     + importM3UFile ~l.8028-8052:
 *       · SÍ entiende #PLAYLIST: (l.7993) pero el exportador nunca lo
 *         escribe: el nombre de la playlist sobrevive solo vía el nombre
 *         del archivo (exportM3U lo deriva del nombre de la playlist).
 *         Si el usuario renombra el .m3u, la playlist importada pierde
 *         su nombre. HUECO REAL 1.
 *       · Ignora #EXTALB y la duración del #EXTINF: el emparejado es por
 *         nombre de archivo exacto (insensible a mayúsculas) -> por
 *         raíz del nombre (cleanName, l.2936) -> por título+artista del
 *         #EXTINF -> por título solo. La duración y el álbum se
 *         recuperan de la pista local emparejada, así que en la app no
 *         se pierden... salvo que la pista NO esté en la biblioteca:
 *         entonces la entrada se descarta entera (missing) y con ella
 *         álbum, duración y género. Para otros reproductores el álbum
 *         y el género sí se pierden siempre. HUECO REAL 2.
 *       · importM3UFile elimina duplicados (seen, l.8035-8038): una
 *         playlist con la misma canción dos veces se reimporta con una
 *         sola copia. No se puede corregir desde este módulo sin tocar
 *         la app: queda documentado en WIRING.md. HUECO REAL 3.
 *       · El exportador escribe título/artista en crudo: un título con
 *         salto de línea rompería el archivo (una línea extra que el
 *         parser tomaría por una ruta). HUECO REAL 4 (defensivo).
 *   - Lo que SÍ es redondo hoy: exportar playlist/lista inteligente y
 *     reimportar el .m3u en la misma app empareja todas las pistas por
 *     nombre de archivo, en orden, con título y artista del #EXTINF
 *     como respaldo si el archivo se renombró. El encargo original
 *     («falta exportar .m3u») era falso: la ida y vuelta ya existe.
 *
 * Formato enriquecido de este módulo (compatible hacia atrás: el
 * importador de la app lo lee igual, porque ignora las líneas # que
 * no conoce):
 *   #EXTM3U
 *   #PLAYLIST:<nombre de la lista>     <- lo que el importador ya entiende
 *   #EXTALB:<álbum>                    <- por pista, solo si tiene álbum
 *   #EXTINF:<segundos>,<artista> - <título>
 *   <nombre de archivo>
 * Todos los campos de texto se sanean de \r y \n antes de escribirse.
 * El género no tiene etiqueta #EXT estándar que la app entienda, así
 * que NO se inventa una: el género se pierde en .m3u (queda en el
 * respaldo JSON de la app). Ver WIRING.md.
 *
 * Enganche (sin tocar el IIFE de la app): script clásico, como
 * lyrics.js / wrapped.js. Lee biblioteca y cola SOLO a través de
 * window.__rpmApp (getTracks / getPackState / toast, ya expuestos por
 * app/index.html l.12753-12771) y descarga con un <a> propio (downloadFile
 * vive dentro del IIFE y no está expuesto). Si el módulo falla al cargar,
 * la app sigue funcionando: todo el init va en try/catch y los botones
 * solo se añaden si existen sus anclas (#btnImportM3u, #queueActions).
 * Sin CSS propio: reutiliza las clases .btn .small de la app.
 *
 * Fuentes de datos (verificadas en app/index.html):
 *   - Pista: {id, name, title, artist, album, duration (segundos)}.
 *   - Cola: packState.queue = [trackId, ...] en orden (saveState l.2653,
 *     guardado con debounce de 150 ms: la cola leída puede ir hasta
 *     ~150 ms por detrás del último cambio; ver WIRING.md).
 *   - Biblioteca: __rpmApp.getTracks() devuelve el array `tracks` en
 *     el orden de la biblioteca.
 */
(function (g) {
  'use strict';

  /* ---------- Utilidades puras (probadas en Node) ---------- */

  // Quita \r y \n de un campo de texto: un salto de línea dentro de un
  // título/artista/álbum rompería el .m3u (el parser toma cada línea no-#
  // por una ruta). Los espacios se colapsan como hace cleanName().
  function sanitizeLine(s) {
    return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Misma regla que exportM3U() en la app (l.6496) para el nombre de archivo.
  function safeFileName(name) {
    return sanitizeLine(name).replace(/[^\wáéíóúñü -]+/gi, '').trim() || 'playlist';
  }

  // cleanName() de la app (l.2936-2938), literal: quita extensión,
  // '_' -> ' ', colapsa espacios.
  function cleanName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // normStr() de la app (l.6993-6995), literal: minúsculas, sin acentos,
  // espacios colapsados.
  function normStr(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Pistas que se pueden exportar: necesitan nombre de archivo (es la
  // ruta que escribe el .m3u y la primera clave de emparejado al importar).
  function filterExportable(tracks) {
    return (Array.isArray(tracks) ? tracks : []).filter(function (t) {
      return t && t.name && sanitizeLine(t.name);
    });
  }

  // Genera el texto .m3u enriquecido. opts: { includePlaylist: true,
  // includeAlbum: true } (ponerlos en false reproduce el formato exacto
  // de la app, útil para comparar en tests).
  // Devuelve '' si no hay pistas exportables.
  function buildM3U(name, tracks, opts) {
    var o = opts || {};
    var list = filterExportable(tracks);
    if (!list.length) return '';
    var lines = ['#EXTM3U'];
    if (o.includePlaylist !== false && name) lines.push('#PLAYLIST:' + sanitizeLine(name));
    list.forEach(function (t) {
      if (o.includeAlbum !== false && t.album) lines.push('#EXTALB:' + sanitizeLine(t.album));
      lines.push('#EXTINF:' + Math.round(t.duration || 0) + ',' +
        sanitizeLine((t.artist ? t.artist + ' - ' : '') + (t.title || t.name)));
      lines.push(sanitizeLine(t.name));
    });
    return lines.join('\n');
  }

  // Transcripción literal del exportador actual de la app (l.6491-6494),
  // SOLO para los tests de ida y vuelta: demuestra qué pierde el formato
  // de la app frente al enriquecido. No se usa en el navegador.
  function appFlavorM3U(tracks) {
    var lines = ['#EXTM3U'];
    filterExportable(tracks).forEach(function (t) {
      lines.push('#EXTINF:' + Math.round(t.duration || 0) + ',' + ((t.artist ? t.artist + ' - ' : '') + t.title));
      lines.push(t.name);
    });
    return lines.join('\n');
  }

  // Parser .m3u: superconjunto fiel del parseM3U de la app (l.7983-7999).
  // Añade: duración del #EXTINF y #EXTALB por entrada. Todo lo que la
  // app entiende se parsea igual (mismas claves, mismo orden).
  // Devuelve { entries: [{path, hint, album, duration}], title }.
  // duration: segundos enteros del #EXTINF, -1 si no venía o no era número.
  function parseM3U(text) {
    var entries = [], pendingTitle = '', pendingAlbum = '', pendingDuration = -1, listTitle = '';
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (line.indexOf('#EXTINF:') === 0) {
        var rest = line.slice(8);
        var comma = rest.indexOf(',');
        var secs = comma >= 0 ? parseInt(rest.slice(0, comma), 10) : NaN;
        pendingDuration = isNaN(secs) ? -1 : secs;
        pendingTitle = comma >= 0 ? rest.slice(comma + 1).trim() : '';
        return;
      }
      if (line.indexOf('#EXTALB:') === 0) { pendingAlbum = line.slice(8).trim(); return; }
      if (line.indexOf('#PLAYLIST:') === 0) { listTitle = line.slice(10).trim(); return; }
      if (line.charAt(0) === '#') return;
      entries.push({ path: line, hint: pendingTitle, album: pendingAlbum, duration: pendingDuration });
      pendingTitle = ''; pendingAlbum = ''; pendingDuration = -1;
    });
    return { entries: entries, title: listTitle };
  }

  // Emparejado de una entrada .m3u contra la biblioteca: port literal
  // del matchM3UEntry de la app (l.8000-8027), mismo orden y mismas reglas.
  function matchM3UEntry(e, tracks) {
    var list = Array.isArray(tracks) ? tracks : [];
    var base = String(e.path || '').split(/[\\/]/).pop() || '';
    var baseLow = base.toLowerCase();
    var t = list.find(function (x) { return String(x.name || '').toLowerCase() === baseLow; });
    if (t) return t;
    var stem = normStr(cleanName(base));
    if (stem) {
      t = list.find(function (x) { return normStr(cleanName(x.name || '')) === stem; });
      if (t) return t;
    }
    var hint = e.hint || cleanName(base);
    var parts = hint.split(' - ');
    var titlePart = parts.length > 1 ? parts.slice(1).join(' - ') : hint;
    var artistPart = parts.length > 1 ? parts[0] : '';
    if (titlePart) {
      t = list.find(function (x) {
        return normStr(x.title) === normStr(titlePart) &&
          (!artistPart || !x.artist || normStr(x.artist) === normStr(artistPart));
      });
      if (t) return t;
      t = list.find(function (x) { return normStr(x.title) === normStr(titlePart); });
      if (t) return t;
    }
    if (hint) {
      t = list.find(function (x) { return normStr(x.title) === normStr(hint); });
      if (t) return t;
    }
    return null;
  }

  // Simula lo que haría importM3UFile() con un texto .m3u: empareja cada
  // entrada y aplica su deduplicado (seen). Devuelve el resultado tal
  // como quedaría la playlist importada.
  function matchM3UList(parsed, tracks) {
    var ids = [], seen = {}, missing = [], duplicatesDropped = 0;
    (parsed.entries || []).forEach(function (e) {
      var t = matchM3UEntry(e, tracks);
      if (t) {
        if (!seen[t.id]) { seen[t.id] = 1; ids.push(t.id); }
        else duplicatesDropped++;
      } else missing.push(e.path);
    });
    return { ids: ids, matched: ids.length, missing: missing, duplicatesDropped: duplicatesDropped };
  }

  // Diagnóstico de ida y vuelta: dado un texto .m3u y la biblioteca,
  // dice qué pasaría al importarlo en la app (mismos criterios que
  // importM3UFile). Sirve para comprobar pérdidas sin abrir la app.
  function analyzeRoundTrip(m3uText, tracks) {
    var parsed = parseM3U(m3uText);
    var m = matchM3UList(parsed, tracks);
    return {
      title: parsed.title,
      total: parsed.entries.length,
      matched: m.matched,
      missing: m.missing,
      duplicatesDropped: m.duplicatesDropped,
      // La duración y el álbum del archivo NO se usan para emparejar:
      // la pista emparejada conserva los de la biblioteca. Solo se
      // pierden para las entradas sin coincidencia (que se descartan).
      ids: m.ids
    };
  }

  var api = {
    sanitizeLine: sanitizeLine,
    safeFileName: safeFileName,
    cleanName: cleanName,
    normStr: normStr,
    filterExportable: filterExportable,
    buildM3U: buildM3U,
    appFlavorM3U: appFlavorM3U,
    parseM3U: parseM3U,
    matchM3UEntry: matchM3UEntry,
    matchM3UList: matchM3UList,
    analyzeRoundTrip: analyzeRoundTrip
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { g.__exportM3uHelpers = api; } catch (e) { /* consola: window.__exportM3uHelpers */ }

  /* ---------- Parte de navegador (no corre en Node) ---------- */

  function app() { return g.__rpmApp || null; }
  function toast(msg) {
    try { var a = app(); if (a && a.toast) a.toast(msg); } catch (e) {}
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'audio/x-mpegurl' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 500);
  }

  function exportTracksAsM3U(name, tracks) {
    var text = buildM3U(name, tracks);
    if (!text) { toast('No hay canciones para exportar.'); return false; }
    downloadText(safeFileName(name) + '.m3u', text);
    toast('Biblioteca exportada en formato .m3u (' + filterExportable(tracks).length + ' canciones)');
    return true;
  }

  function exportLibrary() {
    var a = app();
    if (!a || !a.getTracks) { toast('La biblioteca no está lista todavía.'); return; }
    exportTracksAsM3U('Biblioteca', a.getTracks());
  }

  function exportQueue() {
    var a = app();
    if (!a || !a.getTracks || !a.getPackState) { toast('La cola no está lista todavía.'); return; }
    Promise.resolve(a.getPackState()).then(function (st) {
      var queueIds = (st && Array.isArray(st.queue)) ? st.queue : [];
      if (!queueIds.length) { toast('La cola está vacía: no hay nada que exportar.'); return; }
      var byId = {};
      a.getTracks().forEach(function (t) { byId[t.id] = t; });
      var tracks = queueIds.map(function (id) { return byId[id]; }).filter(Boolean);
      if (!tracks.length) { toast('Ninguna canción de la cola está en la biblioteca.'); return; }
      var text = buildM3U('Cola', tracks);
      downloadText('Cola.m3u', text);
      toast('Cola exportada en formato .m3u (' + tracks.length + ' canciones)');
    }).catch(function () { toast('No se pudo leer la cola.'); });
  }

  function addButton(anchor, id, label, onClick) {
    if (!anchor || document.getElementById(id)) return false;
    var b = document.createElement('button');
    b.className = 'btn small'; b.id = id; b.type = 'button'; b.textContent = label;
    b.addEventListener('click', onClick);
    anchor.appendChild(b);
    return true;
  }

  function wireButtons() {
    // Biblioteca: junto a «Importar lista .m3u» (viewPlaylists, l.1439):
    // es la misma familia de funciones y ahí sí hay barra de acciones.
    // La vista de biblioteca no tiene barra propia con id.
    var importBtn = document.getElementById('btnImportM3u');
    if (importBtn && importBtn.parentNode) {
      addButton(importBtn.parentNode, 'btnLibM3u', 'Exportar biblioteca .m3u', exportLibrary);
    }
    // Cola: barra de acciones de la cola (l.1481), junto a
    // «Guardar cola como playlist» y «Vaciar cola».
    var queueActions = document.getElementById('queueActions');
    if (queueActions) addButton(queueActions, 'btnQueueM3u', 'Exportar cola .m3u', exportQueue);
  }

  function init() {
    try {
      g.__rpmExportM3U = {
        buildM3U: buildM3U, parseM3U: parseM3U, matchM3UEntry: matchM3UEntry,
        analyzeRoundTrip: analyzeRoundTrip, exportLibrary: exportLibrary, exportQueue: exportQueue
      };
      if (typeof document === 'undefined') return;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireButtons);
      else wireButtons();
      // Por si el script carga antes que el DOM de la app: reintento corto.
      var tries = 0;
      var tick = function () {
        wireButtons();
        tries++;
        if (tries < 20 && !document.getElementById('btnLibM3u')) setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    } catch (e) { /* fail-safe: export-m3u desactivado, app intacta */ }
  }

  init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
