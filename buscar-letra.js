/* Buscar por fragmento de letra para Reproductor de Música — v3.8.0.
   Módulo aparte: NO toca index.html, lyrics.js ni la lógica de
   reproducción. Se engancha solo por DOM a lo que ya existe en la app:
     .lib-tools (línea ~1304 de app/index.html), junto a #search,
     window.__rpmApp.getTracks() (línea ~12762),
     #trackList (línea ~1433, filas li[data-track-id], línea 3671)
     y la pestaña [data-view="library"] (línea ~1343).

   Qué hace:
   - Un botón "♪ Letra" junto al buscador #search. Al pulsarlo abre
     su propia caja de búsqueda (no toca #search: ni su valor, ni su
     placeholder, ni su filtro; el buscador existente sigue buscando
     solo por título/artista/álbum/archivo, como siempre).
   - Recorre TODAS las claves 'reproductor-letras:*' de localStorage
     y busca el fragmento dentro de la letra guardada. Lee
     localStorage DIRECTAMENTE: funciona aunque lyrics.js no haya
     cargado o haya fallado, y aunque la letra viniera de un .lrc
     externo o de una USLT/SYLT incrustada (embedded-lyrics.js
     guarda en esa misma clave).
   - La búsqueda es insensible a mayúsculas y acentos. OJO: el
     norm() de lyrics.js solo pasa a minúsculas y colapsa espacios,
     NO quita acentos; la insensibilidad a acentos la hace ESTE
     módulo (normBuscar, NFD + quitar diacríticos), igual que el
     normSearchText() de la app (línea ~3224 de index.html). Por
     eso "cancion" encuentra "canción", y "nino" encuentra "niño"
     (NFD descompone la ñ en n + tilde, igual que en #search).
   - Cada resultado muestra título y artista, y el fragmento
     resaltado con <mark> en su contexto. Clic en un resultado =
     clic en su fila real de #trackList (la app hace el resto:
     cola, crossfade, etc.). Si la fila no está visible (hay un
     filtro en #search o se está en otra vista), se limpia #search,
     se vuelve a la vista Biblioteca y se reintenta a los 250 ms
     (mismo patrón que tarareo.js). No hay otra forma de
     reproducir: __rpmApp no expone un playTrack().
   - Letras huérfanas: si una letra guardada ya no tiene canción
     en la biblioteca (canción borrada), se muestra igual, con su
     título/artista tal como quedaron en la clave (en minúsculas,
     porque así los guarda norm()), pero sin botón de reproducir.
   - Las claves 'reproductor-letras-traduccion:*' y
     'reproductor-letras-acordes:*' NO se buscan: son traducciones
     y acordes, no la letra. Solo el prefijo exacto
     'reproductor-letras:'.
   - Las marcas de tiempo LRC ([00:12.34], [offset:...] y
     metadatos [ti:...] etc.) se quitan antes de buscar y de
     mostrar el fragmento, así que no estorban ni aparecen.

   Sin letras guardadas, el panel lo dice y no falla. Sin
   localStorage (modo privado que lo bloquee), lo dice y no falla.
   Si un elemento de la app no existe, el módulo no hace nada.

   FAIL-SAFE: todo el init y cada acción van en try/catch; si
   buscar-letra.js no carga, la app queda byte-idéntica.

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./buscar-letra.css">
     <script src="./buscar-letra.js"></script>
   Pruebas Node: node --test buscar-letra.test.mjs
   Prueba desde la consola:
     window.__rpmBuscarLetra.search('fragmento de letra')
     window.__rpmBuscarLetra.state() */
(function (global) {
  'use strict';

  /* ================= Constantes ================= */

  var LYRICS_PREFIX = 'reproductor-letras:';
  var KEY_SEP = ' — '; // em dash con espacios, igual que keyFor() en lyrics.js
  var MIN_LEN = 2; // fragmento mínimo (ya normalizado) para buscar
  var DEBOUNCE_MS = 150;
  var MAX_RESULTS = 50; // se muestran 50; el total se cuenta aparte
  var SNIPPET_CTX = 45; // caracteres de contexto a cada lado del hallazgo
  var RETRY_MS = 250; // reintento del clic tras limpiar el filtro

  /* ================= Núcleo puro (probable en Node) ================= */

  /* Normalización de búsqueda: minúsculas, sin acentos (NFD +
     quitar diacríticos U+0300–U+036F), espacios colapsados.
     Igual que normSearchText() de la app; a diferencia del
     norm() de lyrics.js, que no quita acentos. */
  function normBuscar(s) {
    var t = String(s || '').toLowerCase();
    if (typeof t.normalize === 'function') {
      t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  /* Quita las marcas LRC de un texto guardado, para buscar y
     mostrar solo la letra: [mm:ss.xx] en línea, [offset:...] y
     líneas que son solo metadatos [ti:|ar:|al:|by:|length:]. */
  function stripLrc(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/^\uFEFF/, '');
      if (/^\[(ti|ar|al|by|length|#):/i.test(line)) return;
      line = line
        .replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '')
        .replace(/\[offset:\s*[+-]?\d+\s*\]/gi, '')
        .trim();
      if (line) out.push(line);
    });
    return out.join('\n');
  }

  /* Descompone una clave de localStorage en { title, artist }.
     Devuelve null si no es una clave de letra (prefijo distinto,
     sin separador, o título vacío). El título/artista salen tal
     como los guardó lyrics.js: normalizados (minúsculas, espacios
     colapsados), CON acentos. El separador se busca por la ÚLTIMA
     ocurrencia, por si el título contiene ' — '. */
  function parseLyricKey(key) {
    if (typeof key !== 'string') return null;
    if (key.indexOf(LYRICS_PREFIX) !== 0) return null;
    var rest = key.slice(LYRICS_PREFIX.length);
    var i = rest.lastIndexOf(KEY_SEP);
    if (i <= 0) return null;
    var title = rest.slice(0, i);
    var artist = rest.slice(i + KEY_SEP.length);
    if (!title) return null;
    return { title: title, artist: artist };
  }

  /* Lee todas las letras de un storage (localStorage o un falso
     en tests). Nunca lanza: si el storage falla, devuelve [].
     Cada entrada: { key, title, artist, raw, plain }, donde plain
     es la letra sin marcas LRC. */
  function collectLyrics(storage) {
    var out = [];
    try {
      if (!storage || typeof storage.length !== 'number') return out;
      for (var i = 0; i < storage.length; i++) {
        var k = null, v = null;
        try { k = storage.key(i); } catch (e) { continue; }
        var parsed = parseLyricKey(k);
        if (!parsed) continue;
        try { v = storage.getItem(k); } catch (e) { continue; }
        if (typeof v !== 'string' || !v) continue;
        out.push({
          key: k, title: parsed.title, artist: parsed.artist,
          raw: v, plain: stripLrc(v)
        });
      }
    } catch (e) { /* storage roto: sin letras, sin fallo */ }
    return out;
  }

  /* Normaliza un texto y devuelve el mapa índice-normalizado ->
     índice-original, para poder resaltar el hallazgo en el texto
     original (con sus acentos y mayúsculas). Un carácter original
     puede dar 0 (marca combinante suelta), 1 o más caracteres
     normalizados; el mapa apunta cada uno a su índice original.
     Los huecos de espacios se colapsan a un solo ' ' (igual que
     normBuscar) y se recortan al principio y al final, para que
     la consulta normalizada coincida con este texto normalizado.
     NO se usa normBuscar() por carácter: este colapsa y recorta,
     así que un espacio solo daría '' y el mapa se desplazaría. */
  function normWithMap(text) {
    var norm = '', map = [];
    var s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var n = ch.toLowerCase();
      if (typeof n.normalize === 'function') {
        n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
      if (/^\s$/.test(n)) {
        // Hueco: un solo ' ', y solo entre caracteres (no al inicio).
        if (norm.length && norm.charAt(norm.length - 1) !== ' ') {
          norm += ' '; map.push(i);
        }
        continue;
      }
      if (!n) continue; // marca combinante suelta
      for (var j = 0; j < n.length; j++) { norm += n.charAt(j); map.push(i); }
    }
    // Recorte final: quita el ' ' de cierre, si lo hay.
    if (norm.charAt(norm.length - 1) === ' ') {
      norm = norm.slice(0, -1);
      map.pop();
    }
    return { norm: norm, map: map };
  }

  /* Fragmento con contexto alrededor del primer hallazgo.
     Devuelve { before, match, after } en el texto ORIGINAL (con
     acentos y mayúsculas), con '…' si se recortó por algún lado.
     Si no hay hallazgo, devuelve null. */
  function snippetFor(plain, normQuery) {
    if (!normQuery) return null;
    var m = normWithMap(plain);
    var at = m.norm.indexOf(normQuery);
    if (at < 0) return null;
    var startOrig = m.map[at];
    var endPos = at + normQuery.length;
    var endOrig = endPos < m.map.length ? m.map[endPos] : plain.length;
    var start = startOrig, end = endOrig;
    // Contexto, recortado por límite de palabra cuando se puede.
    var ctxStart = Math.max(0, startOrig - SNIPPET_CTX);
    if (ctxStart > 0) {
      var sp = plain.lastIndexOf(' ', startOrig - 1);
      if (sp >= ctxStart) ctxStart = sp + 1;
      else if (plain.indexOf(' ', ctxStart) > ctxStart &&
               plain.indexOf(' ', ctxStart) < startOrig) {
        ctxStart = plain.indexOf(' ', ctxStart) + 1;
      }
    }
    var ctxEnd = Math.min(plain.length, endOrig + SNIPPET_CTX);
    if (ctxEnd < plain.length) {
      var sp2 = plain.indexOf(' ', endOrig);
      if (sp2 > 0 && sp2 <= ctxEnd) ctxEnd = sp2;
      else if (plain.lastIndexOf(' ', ctxEnd) > endOrig) {
        ctxEnd = plain.lastIndexOf(' ', ctxEnd);
      }
    }
    var before = plain.slice(ctxStart, start);
    var match = plain.slice(start, end);
    var after = plain.slice(end, ctxEnd);
    if (ctxStart > 0) before = '…' + before;
    if (ctxEnd < plain.length) after = after + '…';
    return { before: before, match: match, after: after };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Fragmento ya escapado, con el hallazgo en <mark>. */
  function highlightSnippet(snippet) {
    if (!snippet) return '';
    return escapeHtml(snippet.before) +
      '<mark>' + escapeHtml(snippet.match) + '</mark>' +
      escapeHtml(snippet.after);
  }

  /* Busca un fragmento en las entradas recogidas.
     Devuelve { query, normQuery, total, shown, searched, results },
     donde cada resultado es { entry, track, snippet, matchAt }
     (matchAt: posición del hallazgo en la letra normalizada, para
     ordenar: primero el hallazgo más temprano, luego título A–Z).
     tracks es opcional: si se pasa (getTracks()), cada resultado
     lleva su pista real o null si la letra es huérfana. */
  function searchLyrics(query, entries, tracks) {
    var normQuery = normBuscar(query);
    var res = {
      query: String(query == null ? '' : query),
      normQuery: normQuery, total: 0, shown: 0,
      searched: (entries || []).length, results: []
    };
    if (!normQuery || normQuery.length < MIN_LEN) return res;
    var found = [];
    (entries || []).forEach(function (entry) {
      if (!entry || typeof entry.plain !== 'string') return;
      var m = normWithMap(entry.plain);
      var at = m.norm.indexOf(normQuery);
      if (at < 0) return;
      found.push({
        entry: entry,
        track: findTrackFor(entry, tracks),
        snippet: snippetFor(entry.plain, normQuery),
        matchAt: at
      });
    });
    found.sort(function (a, b) {
      if (a.matchAt !== b.matchAt) return a.matchAt - b.matchAt;
      var ta = normBuscar(a.entry.title), tb = normBuscar(b.entry.title);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
    res.total = found.length;
    res.results = found.slice(0, MAX_RESULTS);
    res.shown = res.results.length;
    return res;
  }

  /* Empareja una letra guardada con su pista de la biblioteca,
     por título y artista normalizados (sin acentos ni mayúsculas).
     Si la clave no trae artista, basta el título. El título de la
     pista puede venir en t.title o, en su defecto, en t.name
     (nombre de archivo). Devuelve la pista o null. */
  function findTrackFor(entry, tracks) {
    if (!entry || !tracks || !tracks.length) return null;
    var nt = normBuscar(entry.title), na = normBuscar(entry.artist);
    if (!nt) return null;
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t) continue;
      if (normBuscar(t.title || t.name || '') !== nt) continue;
      if (na && normBuscar(t.artist || '') !== na) continue;
      return t;
    }
    return null;
  }

  /* ================= Pegamento con el navegador ================= */

  function $(id) { return document.getElementById(id); }

  function getStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    } catch (e) { /* sin storage */ }
    return null;
  }

  function getTracks() {
    try {
      var app = (typeof window !== 'undefined') ? window.__rpmApp : null;
      if (app && typeof app.getTracks === 'function') return app.getTracks() || [];
    } catch (e) { /* sin biblioteca */ }
    return [];
  }

  /* Reproduce una pista haciendo clic en su fila real de
     #trackList. Si la fila no está visible, limpia #search, vuelve
     a la vista Biblioteca y reintenta una vez a los 250 ms.
     Devuelve true si el clic se hizo, false si la fila no apareció
     (p. ej. la pista ya no está en la biblioteca). */
  function playTrack(track) {
    if (!track || !track.id) return false;
    try {
      var row = document.querySelector('#trackList [data-track-id="' + track.id + '"]');
      if (row) { row.click(); return true; }
      var searchEl = $('search');
      if (searchEl && searchEl.value) {
        searchEl.value = '';
        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var tab = document.querySelector('#viewTabs [data-view="library"]');
      if (tab) tab.click();
      setTimeout(function () {
        try {
          var row2 = document.querySelector('#trackList [data-track-id="' + track.id + '"]');
          if (row2) row2.click();
        } catch (e) { /* el reintento nunca debe romper la app */ }
      }, RETRY_MS);
      return true;
    } catch (e) { return false; }
  }

  function ensureCss() {
    try {
      if (document.querySelector('link[href="./buscar-letra.css"]')) return;
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = './buscar-letra.css';
      document.head.appendChild(css);
    } catch (e) { /* sin CSS el panel funciona, solo se ve sin estilo */ }
  }

  var els = {};
  var debounceTimer = null;
  var lastEntries = null; // caché de la última lectura, para state()

  function renderResults(res) {
    var list = els.results, status = els.status;
    if (!list || !status) return;
    list.innerHTML = '';
    if (!getStorage()) {
      status.textContent = 'No se puede leer el almacenamiento local en este navegador, así que no se pueden buscar letras.';
      return;
    }
    if (!res) {
      status.textContent = lastEntries && lastEntries.length
        ? lastEntries.length + (lastEntries.length === 1 ? ' letra guardada. Escribe un fragmento para buscar dentro de ella.' : ' letras guardadas. Escribe un fragmento para buscar dentro de ellas.')
        : 'Aún no hay letras guardadas en este dispositivo. Carga un .lrc, pega una letra o reproduce una canción con letra incrustada y aparecerá aquí.';
      return;
    }
    if (res.normQuery.length < MIN_LEN) {
      status.textContent = 'Escribe al menos ' + MIN_LEN + ' letras.';
      return;
    }
    if (!res.total) {
      status.textContent = 'Sin coincidencias para «' + res.query + '» en ' +
        res.searched + (res.searched === 1 ? ' letra.' : ' letras.');
      return;
    }
    status.textContent = res.total + (res.total === 1 ? ' coincidencia' : ' coincidencias') +
      ' en ' + res.searched + (res.searched === 1 ? ' letra' : ' letras') +
      (res.total > res.shown ? ' (se muestran ' + res.shown + ')' : '') + '. Toca una para reproducirla.';
    res.results.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'rpm-buscar-letra-result';
      var track = r.track;
      var title = track ? (track.title || track.name || r.entry.title) : r.entry.title;
      var artist = track ? (track.artist || '') : r.entry.artist;
      if (track) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rpm-buscar-letra-item';
        var head = document.createElement('span');
        head.className = 'rpm-buscar-letra-head';
        head.textContent = artist ? title + ' — ' + artist : title;
        var snip = document.createElement('span');
        snip.className = 'rpm-buscar-letra-snippet';
        snip.innerHTML = highlightSnippet(r.snippet);
        btn.appendChild(head);
        btn.appendChild(snip);
        btn.addEventListener('click', function () { playTrack(track); });
        li.appendChild(btn);
      } else {
        var div = document.createElement('div');
        div.className = 'rpm-buscar-letra-item rpm-buscar-letra-orphan';
        var head2 = document.createElement('span');
        head2.className = 'rpm-buscar-letra-head';
        head2.textContent = artist ? title + ' — ' + artist : title;
        var snip2 = document.createElement('span');
        snip2.className = 'rpm-buscar-letra-snippet';
        snip2.innerHTML = highlightSnippet(r.snippet);
        var note = document.createElement('span');
        note.className = 'rpm-buscar-letra-note';
        note.textContent = 'Esta canción ya no está en la biblioteca, así que no se puede reproducir.';
        div.appendChild(head2);
        div.appendChild(snip2);
        div.appendChild(note);
        li.appendChild(div);
      }
      list.appendChild(li);
    });
  }

  function runSearch() {
    try {
      var q = els.input ? els.input.value : '';
      var entries = collectLyrics(getStorage());
      lastEntries = entries;
      renderResults(searchLyrics(q, entries, getTracks()));
    } catch (e) {
      try { if (els.status) els.status.textContent = 'La búsqueda falló. Inténtalo de nuevo.'; } catch (e2) {}
    }
  }

  function buildUI() {
    try {
      if ($('rpmBuscarLetraBtn')) return;
      var tools = document.querySelector('.lib-tools');
      if (!tools) return; // sin ancla: no hacer nada, la app sigue igual
      ensureCss();

      var btn = document.createElement('button');
      btn.id = 'rpmBuscarLetraBtn';
      btn.type = 'button';
      btn.className = 'rpm-buscar-letra-btn';
      btn.textContent = '♪ Letra';
      btn.title = 'Buscar por fragmento de letra';
      btn.setAttribute('aria-label', 'Buscar por fragmento de letra');
      btn.setAttribute('aria-expanded', 'false');
      tools.appendChild(btn);

      var panel = document.createElement('div');
      panel.id = 'rpmBuscarLetraPanel';
      panel.className = 'rpm-buscar-letra-panel';
      panel.innerHTML =
        '<div class="rpm-buscar-letra-head-row">' +
          '<strong>Buscar en las letras</strong>' +
          '<button type="button" id="rpmBuscarLetraClose" class="rpm-buscar-letra-close" aria-label="Cerrar">✕</button>' +
        '</div>' +
        '<input type="search" id="rpmBuscarLetraInput" class="rpm-buscar-letra-input" ' +
          'placeholder="Escribe un fragmento de letra…" autocomplete="off" aria-label="Fragmento de letra" />' +
        '<p class="rpm-buscar-letra-status" id="rpmBuscarLetraStatus" role="status"></p>' +
        '<ul class="rpm-buscar-letra-list" id="rpmBuscarLetraResults"></ul>';
      // Justo después de la fila del buscador, dentro de .lib-head.
      if (tools.parentNode) tools.parentNode.insertBefore(panel, tools.nextSibling);
      else document.body.appendChild(panel);

      els = {
        btn: btn, panel: panel,
        input: $('rpmBuscarLetraInput'),
        status: $('rpmBuscarLetraStatus'),
        results: $('rpmBuscarLetraResults')
      };

      function setOpen(open) {
        panel.classList.toggle('on', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          lastEntries = collectLyrics(getStorage());
          renderResults(null);
          if (els.input) els.input.focus();
        }
      }
      btn.addEventListener('click', function () {
        setOpen(!panel.classList.contains('on'));
      });
      $('rpmBuscarLetraClose').addEventListener('click', function () { setOpen(false); });
      if (els.input) {
        els.input.addEventListener('input', function () {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
        });
        els.input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') setOpen(false);
        });
      }
    } catch (e) { /* el init nunca debe romper la app */ }
  }

  /* ================= Exportación (Node + consola) ================= */

  var api = {
    normBuscar: normBuscar,
    stripLrc: stripLrc,
    parseLyricKey: parseLyricKey,
    collectLyrics: collectLyrics,
    normWithMap: normWithMap,
    snippetFor: snippetFor,
    escapeHtml: escapeHtml,
    highlightSnippet: highlightSnippet,
    searchLyrics: searchLyrics,
    findTrackFor: findTrackFor,
    playTrack: playTrack,
    LYRICS_PREFIX: LYRICS_PREFIX,
    KEY_SEP: KEY_SEP,
    MIN_LEN: MIN_LEN,
    MAX_RESULTS: MAX_RESULTS,
    /* Búsqueda directa con el storage real (navegador). */
    search: function (query) {
      return searchLyrics(query, collectLyrics(getStorage()), getTracks());
    },
    state: function () {
      var entries = lastEntries || collectLyrics(getStorage());
      return {
        hasStorage: !!getStorage(),
        lyricsCount: entries.length,
        tracksCount: getTracks().length,
        panelOpen: !!(els.panel && els.panel.classList.contains('on'))
      };
    }
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  try { global.__rpmBuscarLetra = api; } catch (e) { /* consola: sin window (Node) */ }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
    else buildUI();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
