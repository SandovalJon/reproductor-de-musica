/**
 * folders.js — 3.1.0, carpetas persistentes (File System Access API)
 *
 * Una carpeta del disco queda "vinculada": la app recuerda su
 * FileSystemDirectoryHandle en IndexedDB y, al abrir, vuelve a
 * revisar la carpeta y añade solo los audios nuevos. Nada sale del
 * equipo y ningún blob se guarda en IndexedDB por este módulo.
 *
 * HECHOS VERIFICADOS EN app/index.html (3.0.0, léase antes de tocar
 * este archivo):
 * - La app vive en un IIFE cerrado: addFiles/processFile NO se pueden
 *   llamar desde fuera. La única puerta de entrada es el input oculto
 *   #fileInput (línea ~2234): `fileInput.addEventListener('change',
 *   function(){ addFiles(fileInput.files); })` (línea ~5172).
 *   Este módulo entrega los archivos nuevos por esa vía: construye
 *   un DataTransfer, le añade los File, lo asigna a #fileInput y
 *   dispara 'change'. La app ejecuta entonces su propio addFiles().
 * - addFiles/processFile NO eliminan duplicados al importar:
 *   processFile (~3025) siempre crea una pista nueva (salvo
 *   re-vincular un registro "pendiente de audio" del sync, por
 *   nombre+tamaño, vía findPendingRecord). La detección de
 *   duplicadas solo existe como VISTA (dupGroups ~7030: mismo
 *   título+artista ±2 s, mismo tamaño+duración, o audioHash
 *   similar con duración ±2 s). Por eso el emparejamiento de este
 *   módulo (nombre+tamaño, y audioHash exacto si viene dado) es
 *   LA ÚNICA protección contra duplicados en la importación.
 * - window.__rpmApp (línea ~12808) expone getTracks(),
 *   getTrackBlob(), reloadLibrary(), render() y toast().
 * - AUDIO_EXT de la app (línea ~2949): mp3 wav flac ogg oga m4a
 *   m4b m4r aac opus weba webm aif aiff mp4 3gp wma. Esta lista se
 *   copia aquí tal cual; si la app la cambia, hay que cambiarla
 *   también aquí (ver WIRING.md).
 * - La app ya tiene #btnAddTop (~816, en .top-actions junto a
 *   #btnFolder, el selector de carpeta de una sola vez) y
 *   #btnAddEmpty (~1398). El botón de este módulo se inserta
 *   DESPUÉS de #btnAddTop (ancla documentada en initUI).
 * - processFile lee `file.webkitRelativePath || file._dropPath`
 *   (~3075) para el campo `folder` de la pista; el drag&drop ya
 *   usa esa misma convención (_dropPath, ~5328). Este módulo
 *   pone _dropPath = ruta relativa dentro de la carpeta vinculada
 *   para que la pista nueva conserve su carpeta.
 *
 * POR QUÉ NO SE CALCULA NINGÚN HASH DEL ARCHIVO:
 * el audioHash de la app NO es un hash del contenido: es una huella
 * perceptiva (computeAudioHash ~7145: decodifica el audio y resume
 * 24 segmentos RMS/pico). Un SHA-256 del archivo nunca coincidiría
 * con él, así que calcularlo sería gastar CPU para nada. El
 * emparejamiento en el navegador es por nombre+tamaño; la segunda
 * pasada por audioHash de matchFilesToTracks solo actúa si quien
 * llama ya trae un audioHash (p. ej. en pruebas, o si la app lo
 * expone en el futuro).
 *
 * SIN SOPORTE = SIN CAMBIOS: si window.showDirectoryPicker no
 * existe, este IIFE termina sin tocar el DOM ni la app. No se
 * muestra botón, ni aviso, ni estado "Sin soporte": el botón
 * oculto evita ruido en navegadores (Firefox, Safari) donde la
 * función no existe. Decisión documentada, no un olvido.
 *
 * PERMISOS: el handle guardado sobrevive al cierre del navegador,
 * pero el permiso de lectura puede caducar. Al arrancar se intenta
 * queryPermission() y luego requestPermission() (sin gesto, el
 * navegador lo deniega sin mostrar nada, como prevé la tarea);
 * si no hay permiso, el botón queda en "Carpeta: <nombre> ·
 * Reconectar" con el aviso "Toca Reconectar para permitir el
 * acceso" y se espera al clic del usuario. NUNCA se reintentan
 * permisos en bucle. Con gesto (clic en Reconectar), el prompt
 * sí puede mostrarse.
 *
 * IndexedDB propia: base 'reproductor-carpetas', almacén
 * 'handles', clave 'music-folder', valor {handle, name, linkedAt}.
 * El FileSystemDirectoryHandle es estructurable-clonable y se
 * guarda tal cual. No se guardan blobs ni rutas absolutas.
 *
 * Uso en el navegador (script clásico, se auto-inicia al cargar):
 *   <script src="./src/folders/folders.js"></script>
 * Uso en pruebas (Node): require('./folders.js') expone las
 * funciones puras { AUDIO_EXTS, isAudioFileName,
 * matchFilesToTracks, walkDirectoryHandle }. En Node no hay
 * window y no se hace nada más.
 */
(function (global) {
  'use strict';

  // ---------- Partes puras (probadas en Node) ----------

  // Misma lista que AUDIO_EXT en app/index.html ~2949.
  var AUDIO_EXTS = [
    'mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'm4b', 'm4r', 'aac',
    'opus', 'weba', 'webm', 'aif', 'aiff', 'mp4', '3gp', 'wma',
  ];
  var AUDIO_EXT_RE = new RegExp(
    '\\.(' + AUDIO_EXTS.join('|') + ')$', 'i',
  );

  /** true si el nombre de archivo tiene una extensión de audio. */
  function isAudioFileName(name) {
    return !!name && AUDIO_EXT_RE.test(String(name));
  }

  /**
   * Empareja archivos de la carpeta con pistas de la biblioteca.
   * files:  [{name, size, audioHash?}]  (audioHash opcional)
   * tracks: [{name, size, audioHash?}]  (de __rpmApp.getTracks())
   * Devuelve { already: [...], added: [...] } con los mismos objetos
   * de `files` que recibió.
   *
   * 1ª pasada: nombre+tamaño exactos. Es la que usa el navegador
   *    (los File del walk no traen audioHash).
   * 2ª pasada: audioHash exacto (===), solo para archivos que lo
   *    traigan y pistas que lo tengan. Cubre el caso "mismo audio,
   *    nombre cambiado".
   * Resto: nuevos.
   *
   * Decisión deliberada: la búsqueda es por CONJUNTO, no por
   * consumo. Si dos archivos en subcarpetas distintas tienen el
   * mismo nombre Y el mismo tamaño que una sola pista, AMBOS se
   * marcan "ya en biblioteca". Añadir el segundo crearía una pista
   * duplicada (la app no elimina duplicados al importar) y perder
   * una copia idéntica es el error seguro; la vista "Duplicadas"
   * de la app los trataría como el mismo archivo de todos modos.
   */
  function matchFilesToTracks(files, tracks) {
    var list = Array.isArray(files) ? files : [];
    var lib = Array.isArray(tracks) ? tracks : [];
    var byNameSize = {};
    var byHash = {};
    lib.forEach(function (t) {
      if (!t) return;
      if (typeof t.name === 'string' && typeof t.size === 'number') {
        byNameSize[t.name + '|' + t.size] = true;
      }
      if (typeof t.audioHash === 'string' && t.audioHash) {
        byHash[t.audioHash] = true;
      }
    });
    var already = [];
    var added = [];
    list.forEach(function (f) {
      if (!f) return;
      var hit = false;
      if (typeof f.name === 'string' && typeof f.size === 'number') {
        hit = !!byNameSize[f.name + '|' + f.size];
      }
      if (!hit && typeof f.audioHash === 'string' && f.audioHash) {
        hit = !!byHash[f.audioHash];
      }
      if (hit) already.push(f);
      else added.push(f);
    });
    return { already: already, added: added };
  }

  function isHiddenName(name) {
    return typeof name === 'string' && name.charAt(0) === '.';
  }

  /**
   * Recorre un FileSystemDirectoryHandle (o un árbol falso con la
   * misma forma: {kind, name, values(), getFile()} para pruebas).
   * Devuelve Promise<{ files: [{file, path}], skipped: number }>:
   * - files: solo audios por extensión; `path` es la ruta relativa
   *   dentro de la carpeta vinculada, con '/' (para _dropPath).
   * - skipped: entradas que no se pudieron leer (se sigue con el
   *   resto; un archivo roto no aborta el recorrido).
   * Se saltan archivos y carpetas ocultos (nombre que empieza por
   * '.'): no se entra en carpetas ocultas.
   */
  async function walkDirectoryHandle(dirHandle, basePath) {
    var out = [];
    var skipped = 0;
    var base = basePath || '';
    async function walk(dir, prefix) {
      var entries;
      try {
        entries = dir.values();
      } catch (e) {
        skipped++;
        return;
      }
      try {
        for await (var entry of entries) {
          if (!entry || isHiddenName(entry.name)) continue;
          var rel = prefix ? prefix + '/' + entry.name : entry.name;
          if (entry.kind === 'directory') {
            await walk(entry, rel);
          } else if (entry.kind === 'file') {
            if (!isAudioFileName(entry.name)) continue;
            try {
              var file = await entry.getFile();
              if (file) out.push({ file: file, path: rel });
              else skipped++;
            } catch (e) {
              skipped++;
            }
          }
        }
      } catch (e) {
        // values() falló a mitad: lo leído hasta ahora se conserva.
        skipped++;
      }
    }
    if (dirHandle && dirHandle.kind === 'directory') {
      await walk(dirHandle, base);
    }
    return { files: out, skipped: skipped };
  }

  // Exportar las partes puras para Node y para depuración.
  var api = {
    AUDIO_EXTS: AUDIO_EXTS,
    isAudioFileName: isAudioFileName,
    matchFilesToTracks: matchFilesToTracks,
    walkDirectoryHandle: walkDirectoryHandle,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.__rpmFoldersPure = api;
  }

  // ---------- Parte de navegador (nada de esto corre en Node) ----------

  // Sin soporte de File System Access API: no hacer ABSOLUTAMENTE
  // nada (ni UI, ni listeners, ni IndexedDB). La app queda igual.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof window.showDirectoryPicker !== 'function') return;

  var DB_NAME = 'reproductor-carpetas';
  var STORE = 'handles';
  var KEY = 'music-folder';

  var app = null; // window.__rpmApp, cuando esté listo
  var btn = null; // botón "Vincular carpeta" / "Carpeta: …"
  var statusEl = null;
  var scanning = false;
  var linkedName = null; // nombre de la carpeta vinculada, si la hay
  var needsPermission = false;

  function toast(msg) {
    try {
      if (app && typeof app.toast === 'function') app.toast(msg);
    } catch (e) { /* el aviso es opcional; nunca romper por él */ }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
    if (btn && text) btn.title = text;
  }

  function setButton() {
    if (!btn) return;
    btn.disabled = scanning;
    if (scanning) {
      btn.textContent = 'Revisando carpeta…';
      return;
    }
    if (linkedName) {
      btn.textContent = 'Carpeta: ' + linkedName + ' · Reconectar';
    } else {
      btn.textContent = 'Vincular carpeta';
    }
  }

  // ---------- IndexedDB propia (solo el handle, nunca blobs) ----------

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE);
          }
        } catch (e) { /* crear el almacén es opcional si ya existe */ }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB')); };
      req.onblocked = function () { reject(new Error('IndexedDB bloqueada')); };
    });
  }

  function idbTx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(STORE, mode);
          var store = tx.objectStore(STORE);
          var req = fn(store);
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error('IndexedDB')); };
        } catch (e) {
          reject(e);
        } finally {
          try { db.close(); } catch (e) {}
        }
      });
    });
  }

  function loadStoredHandle() {
    return idbTx('readonly', function (s) { return s.get(KEY); })
      .then(function (rec) {
        if (rec && rec.handle) return rec;
        return null;
      })
      .catch(function () { return null; });
  }

  function saveStoredHandle(handle, name) {
    return idbTx('readwrite', function (s) {
      return s.put({ handle: handle, name: name, linkedAt: Date.now() }, KEY);
    });
  }

  function clearStoredHandle() {
    return idbTx('readwrite', function (s) { return s.delete(KEY); })
      .catch(function () {});
  }

  // ---------- Permisos ----------

  function queryPermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve('prompt');
    }
    try {
      return Promise.resolve(handle.queryPermission({ mode: 'read' }))
        .catch(function () { return 'prompt'; });
    } catch (e) {
      return Promise.resolve('prompt');
    }
  }

  function requestPermission(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') {
      return Promise.resolve('denied');
    }
    try {
      return Promise.resolve(handle.requestPermission({ mode: 'read' }))
        .catch(function () { return 'denied'; });
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  /**
   * Al arrancar (sin gesto): permiso silencioso si ya estaba dado;
   * si no, se intenta requestPermission() una sola vez — sin gesto
   * el navegador lo deniega sin mostrar nada — y se queda en
   * "necesita permiso" esperando el clic. Nunca se reintenta solo.
   * Con gesto (clic en Reconectar): requestPermission() sí puede
   * mostrar el aviso del navegador.
   */
  function ensurePermission(handle, interactive) {
    return queryPermission(handle).then(function (state) {
      if (state === 'granted') return true;
      if (state === 'denied' && !interactive) return false;
      return requestPermission(handle).then(function (res) {
        return res === 'granted';
      });
    });
  }

  // ---------- Entrega a la app por su propio #fileInput ----------

  function handOffToApp(newFiles) {
    var fileInput = document.getElementById('fileInput');
    if (!fileInput) {
      toast('No encontré el selector de archivos de la app. Recarga e inténtalo de nuevo.');
      return false;
    }
    if (typeof DataTransfer === 'undefined') {
      toast('Este navegador no permite pasar los archivos a la app. Añádelos con «Añadir canciones».');
      return false;
    }
    try {
      var dt = new DataTransfer();
      newFiles.forEach(function (item) {
        var f = item.file;
        try { f._dropPath = item.path; } catch (e) {}
        dt.items.add(f);
      });
      fileInput.value = '';
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      toast('No se pudieron pasar los archivos a la app. Añádelos con «Añadir canciones».');
      return false;
    }
  }

  // ---------- Rescan ----------

  function rescan(handle) {
    if (scanning) return Promise.resolve(null);
    if (!handle) return Promise.resolve(null);
    scanning = true;
    setButton();
    setStatus('Revisando carpeta…');
    return walkDirectoryHandle(handle).then(function (walked) {
      var tracks = [];
      try {
        tracks = (app.getTracks && app.getTracks()) || [];
      } catch (e) {
        tracks = [];
      }
      var found = walked.files.map(function (item) {
        return {
          name: item.file.name,
          size: item.file.size,
          audioHash: (typeof item.file.audioHash === 'string') ? item.file.audioHash : undefined,
          _item: item,
        };
      });
      var matched = matchFilesToTracks(found, tracks);
      var summary = matched.already.length + ' ya en biblioteca, ' +
        matched.added.length + ' nuevas añadidas';
      if (walked.files.length === 0) {
        setStatus('La carpeta no tiene archivos de audio.');
        toast('La carpeta vinculada no tiene archivos de audio.');
        return { already: 0, added: 0, skipped: walked.skipped };
      }
      if (walked.skipped) summary += ' · ' + walked.skipped + ' no se pudieron leer';
      setStatus(summary);
      toast(summary);
      if (matched.added.length) {
        // Solo los nuevos van a la app; su propio addFiles() vuelve
        // a filtrar por tipo y crea las pistas (sin duplicar lo que
        // ya estaba, porque aquí ya se excluyó).
        handOffToApp(matched.added.map(function (f) { return f._item; }));
      }
      return {
        already: matched.already.length,
        added: matched.added.length,
        skipped: walked.skipped,
      };
    }).catch(function (e) {
      // La carpeta ya no existe o se perdió el acceso: olvidar el
      // enlace es reversible (vincular de nuevo es un clic) y evita
      // quedarse atascado en un handle muerto.
      if (e && (e.name === 'NotFoundError' || e.name === 'InvalidStateError')) {
        clearStoredHandle();
        linkedName = null;
        needsPermission = false;
        setButton();
        setStatus('La carpeta vinculada ya no existe. Vincula otra carpeta.');
        toast('La carpeta vinculada ya no existe. Vincula otra carpeta.');
        return { already: 0, added: 0, skipped: 0, missing: true };
      }
      setStatus('No se pudo revisar la carpeta.');
      toast('No se pudo revisar la carpeta vinculada.');
      return { already: 0, added: 0, skipped: 0 };
    });
  }

  // El reseteo de `scanning` va en rescanGuarded, para que ocurra
  // siempre, falle o no el rescan.
  function rescanGuarded(handle) {
    return rescan(handle).then(function (r) {
      scanning = false;
      setButton();
      return r;
    }).catch(function () {
      scanning = false;
      setButton();
      return null;
    });
  }

  // ---------- Vincular / Reconectar ----------

  function linkNewFolder() {
    var handle;
    var name;
    try {
      return window.showDirectoryPicker({ mode: 'read' }).then(function (h) {
        handle = h;
        name = h.name || 'Carpeta';
        return saveStoredHandle(handle, name).catch(function () {
          // Sin IndexedDB el enlace no persiste, pero la revisión
          // de esta vez sí se hace con el handle en memoria.
          toast('No se pudo guardar el enlace; la carpeta se revisará solo esta vez.');
        });
      }).then(function () {
        linkedName = name;
        needsPermission = false;
        setButton();
        return ensurePermission(handle, true);
      }).then(function (ok) {
        if (!ok) {
          needsPermission = true;
          setButton();
          setStatus('Toca Reconectar para permitir el acceso');
          toast('Toca Reconectar para permitir el acceso');
          return null;
        }
        return rescanGuarded(handle);
      }).catch(function (e) {
        // El usuario cerró el selector (AbortError) no es un error:
        // simplemente no se vincula nada.
        if (e && e.name === 'AbortError') return null;
        toast('No se pudo vincular la carpeta.');
        return null;
      });
    } catch (e) {
      toast('No se pudo vincular la carpeta.');
      return Promise.resolve(null);
    }
  }

  function onButtonClick() {
    if (scanning) return;
    loadStoredHandle().then(function (rec) {
      if (!rec || !rec.handle) {
        return linkNewFolder();
      }
      linkedName = rec.name || rec.handle.name || 'Carpeta';
      setButton();
      return ensurePermission(rec.handle, true).then(function (ok) {
        if (!ok) {
          needsPermission = true;
          setButton();
          setStatus('Toca Reconectar para permitir el acceso');
          toast('Toca Reconectar para permitir el acceso');
          return null;
        }
        needsPermission = false;
        return rescanGuarded(rec.handle);
      }).catch(function (e) {
        // Handle guardado pero inválido (p. ej. NotFoundError al
        // pedir permiso): abrir el selector para vincular otra.
        if (e && (e.name === 'NotFoundError' || e.name === 'InvalidStateError')) {
          clearStoredHandle();
          linkedName = null;
          setButton();
          toast('La carpeta vinculada ya no existe. Elige otra carpeta.');
          return linkNewFolder();
        }
        toast('No se pudo revisar la carpeta vinculada.');
        return null;
      });
    });
  }

  // ---------- Arranque automático ----------

  function autoStart() {
    loadStoredHandle().then(function (rec) {
      if (!rec || !rec.handle) return;
      linkedName = rec.name || rec.handle.name || 'Carpeta';
      setButton();
      return ensurePermission(rec.handle, false).then(function (ok) {
        if (!ok) {
          needsPermission = true;
          setButton();
          setStatus('Toca Reconectar para permitir el acceso');
          toast('Toca Reconectar para permitir el acceso');
          return;
        }
        needsPermission = false;
        return rescanGuarded(rec.handle);
      });
    }).catch(function () {
      // Sin enlace guardado o sin permiso: la app sigue igual.
    });
  }

  // ---------- UI ----------

  function initUI() {
    if (document.getElementById('rpmFolderBtn')) return; // ya inyectado
    var anchor = document.getElementById('btnAddTop');
    if (!anchor || !anchor.parentNode) {
      // Sin ancla estable no se inyecta nada: mejor sin botón que
      // un botón en un sitio impredecible.
      return;
    }
    var wrap = document.createElement('span');
    wrap.className = 'rpm-folder';
    wrap.id = 'rpmFolderWrap';

    btn = document.createElement('button');
    btn.className = 'btn rpm-folder-btn';
    btn.id = 'rpmFolderBtn';
    btn.type = 'button';
    btn.textContent = 'Vincular carpeta';
    btn.addEventListener('click', onButtonClick);

    statusEl = document.createElement('span');
    statusEl.className = 'rpm-folder-status';
    statusEl.id = 'rpmFolderStatus';
    statusEl.setAttribute('role', 'status');

    wrap.appendChild(btn);
    wrap.appendChild(statusEl);
    // ANCLA: justo después de #btnAddTop, dentro de .top-actions,
    // junto a #btnFolder (selector de carpeta de una sola vez) y
    // #btnUpdate. Si #btnAddTop cambia de sitio, el botón se mueve
    // con él; si desaparece, no se inyecta nada.
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);

    setButton();
    autoStart();
  }

  // ---------- Arranque del módulo ----------

  // window.__rpmApp lo expone el IIFE de la app (script inline
  // anterior a este), así que normalmente ya existe; el sondeo es
  // el mismo patrón que sync-bridge.js por si cambia el orden.
  var tries = 0;
  (function tick() {
    if (window.__rpmApp) {
      app = window.__rpmApp;
      initUI();
      return;
    }
    tries++;
    if (tries < 30) setTimeout(tick, 100);
  })();

  if (global) {
    global.__rpmFolders = {
      matchFilesToTracks: matchFilesToTracks,
      isAudioFileName: isAudioFileName,
      walkDirectoryHandle: walkDirectoryHandle,
      link: linkNewFolder,
      rescan: function () {
        return loadStoredHandle().then(function (rec) {
          if (!rec || !rec.handle) return null;
          return ensurePermission(rec.handle, true).then(function (ok) {
            return ok ? rescanGuarded(rec.handle) : null;
          });
        });
      },
      unlink: function () {
        return clearStoredHandle().then(function () {
          linkedName = null;
          needsPermission = false;
          setButton();
          setStatus('');
        });
      },
      getState: function () {
        return {
          linkedName: linkedName,
          needsPermission: needsPermission,
          scanning: scanning,
          supported: true,
        };
      },
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
