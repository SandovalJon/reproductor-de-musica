/* Historial de versiones / Qué hay de nuevo — Reproductor de Música v4.3.4.
   Módulo aparte: NO toca index.html ni ningún otro módulo. Se engancha
   solo a lo que ya existe en la app:
     - window.APP_VERSION (var global del script principal de
       index.html, 2 declaraciones: líneas ~2334 y ~9136) o, si no
       está disponible, el texto de #appVersionNote (Ajustes, línea
       ~1401; también se escribe en el pie del reproductor).
     - #btnCheckUpdate (Ajustes > fila de actualización): junto a él
       se crea el botón "📰 Qué hay de nuevo" para volver a ver el
       panel en cualquier momento.
     - .modal-overlay / .modal (CSS que ya trae la app, líneas
       ~520-521): el modal reutiliza esas clases, no inventa su
       propio sistema de modales.
   y guarda la última versión vista con clave propia en localStorage:
     'reproductor-novedades:ultima-version-vista'

   Qué hace:
   - Al cargar, compara APP_VERSION con la última versión vista.
     Si es una actualización (versión mayor que la última vista),
     muestra una vez el modal "🎉 Qué hay de nuevo en la vX.Y.Z"
     con los cambios de esa versión. Al cerrarlo se guarda la
     versión como vista y no vuelve a aparecer hasta la siguiente
     actualización.
   - En la primera visita (sin versión guardada) NO muestra nada:
     no hay versión anterior con la que comparar; guarda la actual
     en silencio. Si la versión baja (downgrade) tampoco muestra
     nada y actualiza la guardada en silencio.
   - El modal tiene un botón "Ver historial completo" que lista
     TODAS las versiones con sus cambios, y el botón de Ajustes
     "📰 Qué hay de nuevo" reabre el panel cuando el usuario quiera.
   - Los cambios salen del changelog REAL (app/README.md, líneas
     "vX.Y.Z: ..."). El texto del changelog va incrustado en
     CHANGELOG_TEXT, copiado literal del README a fecha de este
     módulo, y se parsea en ejecución con parseChangelog(): si una
     versión no tiene entrada en el changelog, NO se le inventa
     ninguna — el modal lo dice claro ("Esta versión no tiene
     entrada en el historial de cambios") y el historial la omite.
     Además, al cargar, el módulo intenta leer './README.md' por
     fetch y, si lo consigue y trae entradas, sustituye el historial
     incrustado por el parseado del archivo real. Si el fetch falla
     (file://, sin conexión, sin README), sigue con el incrustado;
     si no hay changelog en absoluto, muestra un aviso y no falla.
   - A prueba de fallos: cualquier error aquí dentro se traga y la
     app sigue funcionando. Todo el texto de los cambios se inserta
     con textContent (nunca innerHTML con datos del changelog).

   Uso en la app (ver WIRING.md):
     <link rel="stylesheet" href="./novedades.css">
     <script src="./novedades.js"></script>
     (después de mediasession.js, antes del <script type="module">
     de sync-bridge.js)
   Pruebas Node: node --test novedades.test.mjs
   Prueba desde la consola:
     window.__novedadesShow()          // abrir el panel de la versión actual
     window.__novedadesHistory()       // abrir el historial completo
     window.__novedadesLastSeen()      // última versión vista o null
     window.__novedadesVersion()       // versión actual detectada o null
     window.__novedadesCheck()         // volver a comprobar si toca mostrar
*/
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Clave y changelog incrustado (copia literal de app/README.md).
     Fuente: líneas "vX.Y.Z: ..." del README a fecha de la 4.3.2.
     Al publicar una versión nueva, el integrador añade su línea
     aquí (o basta con que esté en el README, porque el fetch de
     './README.md' la recogerá solo).
     ------------------------------------------------------------------ */
  var LAST_SEEN_KEY = 'reproductor-novedades:ultima-version-vista';

  var CHANGELOG_TEXT = [
    'v4.3.4: el botón «Carpeta» vuelve a abrir el selector de carpeta también en Android, como antes de la 4.3.3 (al usuario sí le funcionaba elegir carpetas); si el selector no devuelve archivos, avisa y sugiere «Añadir canciones».',
    'v4.3.3: arreglo de la subida en Android con el botón «Carpeta»: en Android no se puede elegir una carpeta completa, así que el botón abre directamente el selector de canciones y avisa; si el selector no devuelve archivos, ya no se queda en silencio.',
    'v4.3.2: arreglo de la subida en Android para archivos sin extensión ni tipo (WhatsApp/Drive): se detecta el audio por sus bytes iniciales (MP3, FLAC, WAV, OGG, M4A, AAC) y se avisa al momento lo que llega del selector.',
    'v4.3.1: arreglo de la subida en Android (si una canción falla al cargar ya no se rompe el lote en silencio: las demás se añaden igual y se avisa cuáles fallaron; un archivo con metadatos raros se añade con su nombre como título).',
    'v4.3.0: buscar por tarareo mejorado (compara también el ritmo contra la rejilla de pulsos del BPM analizado; aproximado, la melodía no se compara nota a nota).',
    'v4.3.0: acordes en karaoke (tus acordes encima de cada línea, junto a la letra y su traducción; sin acordes guardados, el karaoke se ve como siempre).',
    'v4.3.0: modo lectura de letras (la letra completa como un libro, con letra grande y sin distracciones; se sale con ✕ o Esc).',
    'v4.3.0: Wrapped como video (tu año en música en WebM vertical de ~12 s, con tus tops animados, generado en local; sin datos no genera nada).',
    'v4.2.0: portada animada con la música (la portada late con el ritmo usando el analizador que ya existe; se puede apagar y respeta el movimiento reducido).',
    'v4.2.0: modo coche simplificado (voz manos libres al entrar, anuncio por voz de la canción que suena y botones extragrandes; al salir, todo vuelve a lo normal).',
    'v4.2.0: compartir canción con letra (imagen PNG local con portada, letra y tu nota, o texto plano, por Web Share; nunca comparte el audio).',
    'v4.2.0: recordatorio de respaldo (avisa cuando pasan los días de "Cada" desde la última copia JSON o .rpmbak, con posponer 7 días y opción de desactivarlo; una vez por apertura, nunca dos días seguidos).',
    'v4.1.0: letras traducidas en karaoke (la traducción línea por línea junto a la original, usando las traducciones que ya guardas; sin traducción, el karaoke se ve como siempre).',
    'v4.1.0: estadísticas por artista dentro de "Tu año en música" (artistas más escuchados, con horas, canciones y racha; solo con los datos de escucha que la app ya guarda).',
    'v4.1.0: modo fiesta con votos en la escucha conjunta (los participantes proponen y votan la siguiente canción por el mismo canal WebRTC; gana la más votada).',
    'v4.1.0: historial de versiones con "Qué hay de nuevo" al actualizar (los cambios salen del changelog del README, sin inventar ninguno).',
    'v4.0.0: rediseño total de la interfaz (nueva paleta, tipografía y espaciado; cabecera, reproductor, tarjetas de canciones y secciones con aspecto moderno), activable y desactivable en Ajustes · Apariencia (por defecto activado; el aspecto clásico sigue disponible).',
    'v4.0.0: sincronización automática en la nube (opcional, desactivada por defecto; usa tu Google Drive con tu propio Client ID, cada 15/30/60 min, con el mismo .rpmbak y las mismas reglas de fusión; nunca aplica un borrado sin avisar).',
    'v4.0.0: modo DJ en vivo (cola en vivo con peticiones y reorden, sobre la mezcla automática DJ y el crossfade que ya existen).',
    'v4.0.0: el monolito empieza a partirse en módulos: el motor de búsqueda tolerante y las utilidades puras de formato y texto (duraciones, tamaños, fechas, géneros ID3, comparación de versiones) viven ahora en `src/core/search.js` y `src/core/format.js`, con la app funcionando igual que antes.',
    'v2.9.0: letras sincronizadas (LRC) y mejoras del estado vacío, filtros y móvil.',
    'v2.9.1: corrección del botón de secciones en móvil.',
    'v3.0.0: sincronización entre dispositivos por paquete .rpmbak (sin cuenta ni servidor), con migración de la base de datos a v3.',
    'v3.1.0: letras incrustadas USLT/SYLT del MP3, fuentes autoalojadas (100% offline), envío a Chromecast (RemotePlayback) y carpetas persistentes con File System Access API.',
    'v3.2.0: temas nuevos (Neón, Atardecer, Bosque) con transiciones y animaciones, visualizador con modos Combo y Anillos + fondo con el color de la portada, y atajos nuevos (J/K, 1-9, F) con doble toque central en la portada para play/pausa.',
    'v3.3.0: accesibilidad (skip-link, foco visible, aria, objetivos táctiles de 44 px, movimiento reducido), modo karaoke a pantalla completa con la letra sincronizada, estadísticas tipo Wrapped (tops del año, minutos, racha, copiar resumen) y extracción del ecualizador y las listas inteligentes a módulos aparte.',
    'v3.4.0: despertador con fade-in y posponer 10 min (solo con la app abierta), compartir playlist por enlace con QR y marcado tiene/falta, traducciones de letras línea por línea (también en karaoke, viajan en el .rpmbak) y mini reproductor flotante arrastrable.',
    'v3.5.0: modo enfoque con Pomodoro (25/5 min, descanso largo, aviso sonoro), control por voz en español, Wrapped como imagen PNG y importar playlist desde Spotify (por texto, emparejada con la biblioteca local).',
    'v3.6.0: mezcla automática estilo DJ (enciende juntos crossfade y modo DJ, con BPM de actual y siguiente), acordes de guitarra línea por línea sobre la letra (viajan en el .rpmbak), luces al ritmo en modo fiesta y línea de tiempo de escucha con calendario y racha.',
    'v3.9.0: escucha conjunta sincronizada por WebRTC (código manual, sin servidor), playlist por estado de ánimo, respaldo opcional en Google Drive (con tu propio Client ID) y sonidos para dormir generados en local.',
    'v3.8.0: controles en pantalla bloqueada (MediaSession: huecos tapados, posición en pausa, chapter info, limpieza al vaciar), buscar por fragmento de letra, exportar biblioteca y cola como .m3u, y notas personales por canción que viajan en el .rpmbak.',
    'v3.7.0: buscar por tarareo (micrófono, contorno de notas comparado por BPM y tonalidad, aproximado), modo pantalla limpia (solo portada, título y controles), compartir la canción que suena por WhatsApp (texto y portada si el dispositivo lo permite) y sonido por salida mejorado (detección de audífonos/bocina sobre los perfiles que ya tenía la app).'
  ].join('\n');

  /* ------------------------------------------------------------------
     Lógica pura (sin DOM): es lo que cubren las pruebas Node.
     ------------------------------------------------------------------ */

  /* Normaliza "v4.0.0" / " 4.0.0 " -> "4.0.0". null si no es una
     versión semver válida (1-3 números separados por puntos). */
  function normalizeVersion(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().replace(/^[vV]/, '');
    if (!/^\d+(\.\d+){0,2}$/.test(s)) return null;
    return s;
  }

  /* Compara dos versiones normalizadas. -1 / 0 / 1.
     "3.10.0" > "3.9.0" (comparación numérica, no alfabética);
     "4.0" se trata como "4.0.0". */
  function cmpVersion(a, b) {
    var pa = String(a).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < 3; i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /* Parsea un texto de changelog con líneas "vX.Y.Z: cambio".
     Devuelve [{version, changes:[...]}] ordenado de más reciente a
     más antigua por semver. Las líneas que no encajan se ignoran;
     varias líneas de la misma versión se acumulan en orden.
     OJO: el README trae la 3.9.0 antes que la 3.8.0 y la 3.7.0, así
     que el orden de salida lo decide cmpVersion, no el del texto. */
  function parseChangelog(text) {
    var byVersion = {};
    var order = [];
    if (typeof text !== 'string') return [];
    text.split(/\r?\n/).forEach(function (line) {
      var m = /^\s*v?(\d+(?:\.\d+){1,2})\s*:\s*(.+?)\s*$/.exec(line);
      if (!m) return;
      var version = normalizeVersion(m[1]);
      var change = m[2].trim();
      if (!version || !change) return;
      if (!byVersion[version]) { byVersion[version] = []; order.push(version); }
      byVersion[version].push(change);
    });
    order.sort(function (a, b) { return cmpVersion(b, a); });
    return order.map(function (v) { return { version: v, changes: byVersion[v] }; });
  }

  /* Entrada del historial para una versión, o null si no la hay. */
  function getEntry(history, version) {
    var v = normalizeVersion(version);
    if (!v || !Array.isArray(history)) return null;
    for (var i = 0; i < history.length; i++) {
      if (history[i] && history[i].version === v) return history[i];
    }
    return null;
  }

  /* Cambios de una versión: [] si no tiene entrada (sin inventar). */
  function getChangesFor(history, version) {
    var entry = getEntry(history, version);
    return entry ? entry.changes.slice() : [];
  }

  /* ¿Toca mostrar el "Qué hay de nuevo" al pasar de lastSeen a
     current? Solo si current es una versión válida MAYOR que una
     última vista válida. Primera visita (lastSeen null/vacío),
     misma versión, downgrade o versión inválida -> false. */
  function shouldShowWhatsNew(current, lastSeen) {
    var cur = normalizeVersion(current);
    var seen = normalizeVersion(lastSeen);
    if (!cur || !seen) return false;
    if (cur === seen) return false;
    return cmpVersion(cur, seen) > 0;
  }

  function loadLastSeen(storage) {
    try {
      if (!storage) return null;
      var v = storage.getItem(LAST_SEEN_KEY);
      return normalizeVersion(v);
    } catch (e) { return null; }
  }

  function saveLastSeen(storage, version) {
    try {
      if (!storage) return false;
      var v = normalizeVersion(version);
      if (!v) return false;
      storage.setItem(LAST_SEEN_KEY, v);
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------
     Parte de navegador (DOM). Todo dentro de try/catch: si algo
     falla, la app sigue igual.
     ------------------------------------------------------------------ */
  var state = {
    history: parseChangelog(CHANGELOG_TEXT),
    currentVersion: null,
    modal: null,
    whatsNewView: null,
    historyView: null,
    titleEl: null,
    historyBtn: null,
    built: false,
    checked: false
  };

  function getCurrentVersion() {
    try {
      if (typeof window !== 'undefined' && window.APP_VERSION) {
        var v = normalizeVersion(window.APP_VERSION);
        if (v) return v;
      }
      if (typeof document !== 'undefined') {
        var el = document.getElementById('appVersionNote');
        if (el && el.textContent) {
          var v2 = normalizeVersion(el.textContent);
          if (v2) return v2;
        }
      }
    } catch (e) {}
    return null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* Construye el modal una sola vez (reutiliza .modal-overlay y
     .modal de la app; el CSS propio solo afina el interior). */
  function buildModal() {
    if (state.built || typeof document === 'undefined') return;
    var overlay = el('div', 'modal-overlay novedades-overlay');
    overlay.id = 'novedadesModal';
    overlay.setAttribute('aria-hidden', 'true');
    var modal = el('div', 'modal novedades-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'novedadesTitle');

    var title = el('h2', 'novedades-title');
    title.id = 'novedadesTitle';
    modal.appendChild(title);

    var whatsNew = el('div', 'novedades-view');
    whatsNew.id = 'novedadesWhatsNewView';
    modal.appendChild(whatsNew);

    var historyView = el('div', 'novedades-view novedades-history');
    historyView.id = 'novedadesHistoryView';
    historyView.hidden = true;
    modal.appendChild(historyView);

    var actions = el('div', 'modal-actions novedades-actions');
    var historyBtn = el('button', 'btn small', 'Ver historial completo');
    historyBtn.id = 'novedadesHistoryBtn';
    historyBtn.type = 'button';
    var closeBtn = el('button', 'btn small', 'Entendido');
    closeBtn.id = 'novedadesCloseBtn';
    closeBtn.type = 'button';
    actions.appendChild(historyBtn);
    actions.appendChild(closeBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    historyBtn.addEventListener('click', function () {
      try { toggleHistory(); } catch (e) {}
    });
    closeBtn.addEventListener('click', function () {
      try { closeModal(true); } catch (e) {}
    });
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) { try { closeModal(true); } catch (e) {} }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay.classList.contains('on')) {
        try { closeModal(true); } catch (e) {}
      }
    });

    state.modal = overlay;
    state.whatsNewView = whatsNew;
    state.historyView = historyView;
    state.titleEl = title;
    state.historyBtn = historyBtn;
    state.built = true;
  }

  /* Rellena la vista "Qué hay de nuevo" para una versión. Sin
     entrada en el changelog: aviso, sin inventar cambios. */
  function renderWhatsNew(version) {
    state.titleEl.textContent = '🎉 Qué hay de nuevo en la v' + version;
    var view = state.whatsNewView;
    while (view.firstChild) view.removeChild(view.firstChild);
    var changes = getChangesFor(state.history, version);
    if (changes.length === 0) {
      view.appendChild(el('p', 'novedades-note',
        'Esta versión no tiene entrada en el historial de cambios.'));
    } else {
      var ul = el('ul', 'novedades-list');
      changes.forEach(function (c) {
        ul.appendChild(el('li', null, c));
      });
      view.appendChild(ul);
    }
    var hint = el('p', 'novedades-note',
      'Pulsa «Ver historial completo» para ver qué cambió en cada versión anterior.');
    view.appendChild(hint);
    state.historyView.hidden = true;
    view.hidden = false;
    state.historyBtn.textContent = 'Ver historial completo';
  }

  /* Rellena la vista de historial completo. Sin changelog: aviso. */
  function renderHistory() {
    state.titleEl.textContent = '📜 Historial de versiones';
    var view = state.historyView;
    while (view.firstChild) view.removeChild(view.firstChild);
    if (!state.history || state.history.length === 0) {
      view.appendChild(el('p', 'novedades-note',
        'No hay historial de cambios disponible.'));
    } else {
      state.history.forEach(function (entry) {
        var block = el('div', 'novedades-version');
        block.appendChild(el('h3', null, 'v' + entry.version));
        var ul = el('ul', 'novedades-list');
        entry.changes.forEach(function (c) {
          ul.appendChild(el('li', null, c));
        });
        block.appendChild(ul);
        view.appendChild(block);
      });
    }
    state.whatsNewView.hidden = true;
    view.hidden = false;
    state.historyBtn.textContent = 'Volver a «Qué hay de nuevo»';
  }

  function toggleHistory() {
    if (state.historyView.hidden) renderHistory();
    else if (state.currentVersion) renderWhatsNew(state.currentVersion);
  }

  function openModal() {
    buildModal();
    if (!state.modal) return;
    state.modal.classList.add('on');
    state.modal.setAttribute('aria-hidden', 'false');
    var closeBtn = document.getElementById('novedadesCloseBtn');
    if (closeBtn) { try { closeBtn.focus(); } catch (e) {} }
  }

  /* Cerrar marca la versión actual como vista: no vuelve a aparecer
     hasta la siguiente actualización. */
  function closeModal(markSeen) {
    if (!state.modal) return;
    state.modal.classList.remove('on');
    state.modal.setAttribute('aria-hidden', 'true');
    if (markSeen && state.currentVersion) {
      try { saveLastSeen(localStorage, state.currentVersion); } catch (e) {}
    }
  }

  /* Abre el panel de la versión actual (o la que se pida). */
  function showWhatsNew(version) {
    var v = normalizeVersion(version) || state.currentVersion;
    if (!v) return false;
    state.currentVersion = v;
    renderWhatsNew(v);
    openModal();
    return true;
  }

  function showHistory() {
    buildModal();
    if (!state.modal) return false;
    renderHistory();
    openModal();
    return true;
  }

  /* Comprobación al cargar: primera visita -> guardar en silencio;
     actualización -> mostrar; resto -> nada. */
  function checkForUpdate() {
    if (state.checked) return false;
    state.checked = true;
    var current = getCurrentVersion();
    if (!current) return false;
    state.currentVersion = current;
    var lastSeen;
    try { lastSeen = loadLastSeen(localStorage); } catch (e) { lastSeen = null; }
    if (!lastSeen) {
      try { saveLastSeen(localStorage, current); } catch (e) {}
      return false;
    }
    if (shouldShowWhatsNew(current, lastSeen)) {
      showWhatsNew(current);
      return true;
    }
    if (normalizeVersion(lastSeen) && cmpVersion(current, lastSeen) < 0) {
      try { saveLastSeen(localStorage, current); } catch (e) {}
    }
    return false;
  }

  /* Botón "📰 Qué hay de nuevo" junto a "Actualizar app" en Ajustes
     (#btnCheckUpdate). Si ese botón no existe, se intenta junto a
     #updateStatus; si tampoco, no se crea nada y no falla. */
  function addSettingsButton() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('novedadesBtn')) return;
    var anchor = document.getElementById('btnCheckUpdate');
    var btn = el('button', 'btn small', '📰 Qué hay de nuevo');
    btn.id = 'novedadesBtn';
    btn.type = 'button';
    btn.addEventListener('click', function () {
      try {
        if (state.currentVersion) showWhatsNew(state.currentVersion);
        else showHistory();
      } catch (e) {}
    });
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      return;
    }
    var status = document.getElementById('updateStatus');
    if (status && status.parentNode) status.parentNode.appendChild(btn);
  }

  /* Intenta sustituir el historial incrustado por el del README
     real. Si el fetch falla o no trae entradas, se queda el
     incrustado. No bloquea nada: es solo una mejora. */
  function refreshFromReadme() {
    try {
      if (typeof fetch !== 'function') return;
      fetch('./README.md').then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      }).then(function (text) {
        if (!text) return;
        var parsed = parseChangelog(text);
        if (parsed.length > 0) state.history = parsed;
      }).catch(function () {});
    } catch (e) {}
  }

  function init() {
    try {
      buildModal();
      addSettingsButton();
      checkForUpdate();
      refreshFromReadme();
    } catch (e) {}
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* API pública (consola y, si el integrador lo quiere, otros
     módulos). La lógica pura también se exporta para Node. */
  var api = {
    LAST_SEEN_KEY: LAST_SEEN_KEY,
    CHANGELOG_TEXT: CHANGELOG_TEXT,
    normalizeVersion: normalizeVersion,
    cmpVersion: cmpVersion,
    parseChangelog: parseChangelog,
    getEntry: getEntry,
    getChangesFor: getChangesFor,
    shouldShowWhatsNew: shouldShowWhatsNew,
    loadLastSeen: loadLastSeen,
    saveLastSeen: saveLastSeen,
    showWhatsNew: showWhatsNew,
    showHistory: showHistory,
    closeModal: closeModal,
    checkForUpdate: checkForUpdate,
    getHistory: function () { return state.history.slice(); },
    getCurrentVersion: getCurrentVersion
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.__novedadesShow = function (version) {
      try { return showWhatsNew(version); } catch (e) { return false; }
    };
    window.__novedadesHistory = function () {
      try { return showHistory(); } catch (e) { return false; }
    };
    window.__novedadesLastSeen = function () {
      try { return loadLastSeen(localStorage); } catch (e) { return null; }
    };
    window.__novedadesVersion = function () {
      try { return getCurrentVersion(); } catch (e) { return null; }
    };
    window.__novedadesCheck = function () {
      try { state.checked = false; return checkForUpdate(); } catch (e) { return false; }
    };
    window.__novedadesMarkSeen = function (version) {
      try { return saveLastSeen(localStorage, version || state.currentVersion); } catch (e) { return false; }
    };
  }
})();
