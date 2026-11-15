/* drive.js — Respaldo en Google Drive (reproductor-de-musica v3.9.0, módulo aparte)
 *
 * Qué hace: guarda el respaldo de la app en el Google Drive DEL USUARIO
 * y permite ver, descargar y borrar (a la papelera) esos respaldos.
 * Todo es opcional y nada se sube sin que el usuario pulse «Subir»
 * explícitamente.
 *
 * HONESTIDAD, léeme primero:
 * - La app NO tiene Client ID ni clave de API de Google propios, así
 *   que este módulo NO puede funcionar «sin configurar nada». El
 *   usuario tiene que crear su propio Client ID OAuth (tipo «Aplicación
 *   web») en Google Cloud Console; el panel explica los pasos y el
 *   módulo guarda ese Client ID en localStorage (solo el ID, nunca un
 *   secreto: un Client ID de tipo web no lleva secreto en este flujo).
 * - Sin Client ID configurado, el botón abre el panel, explica qué
 *   falta y NO intenta subir nada ni falla.
 * - Google Identity Services (GIS) se carga SOLO cuando el usuario
 *   pulsa «Conectar con Google», desde accounts.google.com. El token
 *   de acceso vive solo en memoria (nunca en localStorage) y caduca
 *   en ~1 hora; si caduca, el módulo pide reconectar.
 * - Permiso pedido: https://www.googleapis.com/auth/drive.file
 *   (solo archivos creados por esta app). El módulo NO ve ni toca el
 *   resto del Drive del usuario.
 * - El .rpmbak se reutiliza tal cual lo construye el sync de la app:
 *   si window.__rpmSync.exportPackage existe, se usa (es el mismo
 *   buildSyncPackage de app/src/sync/package-io.js, sin duplicarlo).
 *   Si no existe, el respaldo es un JSON construido con
 *   __rpmApp.getPackState() + getSyncMeta() (+ metadatos de pistas si
 *   __rpmApp.getTracks está disponible). Ese JSON NO es idéntico al
 *   «Exportar respaldo» de la app: lleva playlists, ajustes,
 *   historial, contadores y perfiles, y los metadatos de pistas solo
 *   si getTracks está disponible; nunca lleva audios, igual que el
 *   respaldo JSON de la app.
 * - Restaurar: «Descargar» baja el archivo al dispositivo; para
 *   aplicarlo hay que usar la app: un .rpmbak se importa con
 *   «Sincronizar» → «Importar paquete (.rpmbak)», y un JSON con
 *   «Importar respaldo». Este módulo NO aplica respaldos por su cuenta.
 *
 * Cómo se engancha (sin tocar el IIFE de la app): script clásico, como
 * compartir.js. Solo usa window.__rpmApp (getPackState / getSyncMeta /
 * toast) y, si existe, window.__rpmSync.exportPackage. Si el módulo
 * falla al cargar, la app sigue funcionando: todo el init va en
 * try/catch y el botón solo se añade si existe #btnSync. Ver WIRING.md.
 */
(function (global) {
  'use strict';

  var VERSION = '1.1.0';
  var LS_CLIENT_ID = 'rpm-drive-client-id';
  var LS_LAST_UPLOAD = 'rpm-drive-last-upload';
  var GIS_URL = 'https://accounts.google.com/gsi/client';
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  var DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

  /* ================= Lógica pura (probada en Node) ================= */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    var v = n;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(v % 1024 === 0 ? 0 : 1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
    return (v / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  // Un Client ID OAuth de Google (tipo web) tiene esta forma:
  //   <solo dígitos>-<letras, dígitos, guiones y guiones bajos>.apps.googleusercontent.com
  // Ejemplo: 123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com
  // NO es una clave de API (esas empiezan por «AIza») ni un secreto.
  function validateClientId(id) {
    if (id == null) return { ok: false, error: 'Falta el Client ID.' };
    var s = String(id).trim();
    if (!s) return { ok: false, error: 'Falta el Client ID.' };
    if (/\s/.test(s)) return { ok: false, error: 'El Client ID no puede tener espacios.' };
    if (s.indexOf('AIza') === 0) {
      return { ok: false, error: 'Eso es una clave de API (empieza por «AIza»), no un Client ID OAuth.' };
    }
    if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(s)) {
      return { ok: false, error: 'Ese Client ID no tiene el formato de Google: <números>-<texto>.apps.googleusercontent.com' };
    }
    return { ok: true, clientId: s };
  }

  // Mismo nombre que packageFileName() de app/src/sync/package-io.js
  // (reproductor-sync-AAAA-MM-DD.rpmbak) para el .rpmbak; el JSON lleva
  // fecha para no confundir una copia con otra en Drive.
  function buildBackupFileName(kind, now) {
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (kind === 'json') return 'respaldo-reproductor-' + stamp + '.json';
    return 'reproductor-sync-' + stamp + '.rpmbak';
  }

  function guessMimeType(fileName) {
    var n = String(fileName || '').toLowerCase();
    if (n.slice(-7) === '.rpmbak') return 'application/zip';
    if (n.slice(-5) === '.json') return 'application/json';
    return 'application/octet-stream';
  }

  function isBackupFileName(name) {
    if (typeof name !== 'string') return false;
    var n = name.toLowerCase();
    if (n.slice(-7) === '.rpmbak') return true;
    if (n.indexOf('respaldo-reproductor') === 0 && n.slice(-5) === '.json') return true;
    return false;
  }

  // Respaldo JSON de reserva (solo si no hay __rpmSync para el .rpmbak).
  // packState: lo que devuelve __rpmApp.getPackState(). tracks: lo que
  // devuelve __rpmApp.getTracks() si existe (metadatos, nunca audios).
  function buildJsonBackup(packState, syncMeta, tracks, now) {
    var ps = (packState && typeof packState === 'object') ? packState : {};
    var sm = (syncMeta && typeof syncMeta === 'object') ? syncMeta : {};
    var exportedAt = new Date(now == null ? Date.now() : now).toISOString();
    var trackMeta = null;
    if (Array.isArray(tracks)) {
      trackMeta = tracks.map(function (t) {
        if (!t || typeof t !== 'object') return null;
        return {
          id: t.id || null, name: t.name || null,
          title: t.title || t.name || null, artist: t.artist || '',
          album: t.album || '', rating: t.rating || null,
          stars: (typeof t.stars === 'number' ? t.stars : null),
          audioHash: (typeof t.audioHash === 'string' ? t.audioHash : null),
          duration: (typeof t.duration === 'number' ? t.duration : null),
        };
      }).filter(Boolean);
    }
    var data = {
      app: 'reproductor-de-musica', kind: 'respaldo-drive', version: 1,
      exportedAt: exportedAt,
      note: 'Respaldo JSON guardado en Google Drive por el módulo drive (v3.9.0). ' +
        'No incluye archivos de audio. Para restaurarlo, descárgalo y usa «Importar respaldo» en la app.',
      playlists: ps.playlists || [],
      customSmart: ps.customSmart || [],
      queue: ps.queue || [],
      history: ps.history || [],
      counts: ps.counts || {},
      statsLog: ps.statsLog || [],
      profiles: ps.profiles || null,
      activeProfileId: ps.activeProfileId || null,
      profileStore: ps.profileStore || null,
      settings: ps.settings || null,
      tracks: trackMeta,
      syncMeta: { deviceId: sm.deviceId || null, lastSyncAt: sm.lastSyncAt || 0 },
    };
    var fileName = buildBackupFileName('json', now == null ? Date.now() : now);
    return { fileName: fileName, text: JSON.stringify(data, null, 2), mimeType: 'application/json' };
  }

  /* ---------- Cuerpo multipart para la subida a Drive ---------- */

  function textToBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(bytes);
  }

  function concatBytes(parts) {
    var total = 0, i;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  function randomBoundary() {
    var s = '';
    try {
      var a = new Uint8Array(16);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(a);
        for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
        return 'rpm-drive-' + s;
      }
    } catch (e) {}
    return 'rpm-drive-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // metadata: {name, mimeType}. fileData: Uint8Array o string (UTF-8).
  // boundary: opcional (para pruebas deterministas); si no se pasa, aleatorio.
  // Devuelve {body: Uint8Array, contentType, boundary}.
  // Formato multipart/related exigido por la subida multipart de Drive:
  //   --boundary\r\n Content-Type: application/json; charset=UTF-8\r\n\r\n
  //   {"name":...,"mimeType":...}\r\n
  //   --boundary\r\n Content-Type: <mime>\r\n\r\n
  //   <bytes del archivo>\r\n --boundary--
  function buildMultipartBody(metadata, fileData, boundary) {
    if (!metadata || typeof metadata.name !== 'string' || !metadata.name) {
      throw new Error('buildMultipartBody necesita metadata con name.');
    }
    var b = boundary || randomBoundary();
    var bytes = (typeof fileData === 'string')
      ? textToBytes(fileData)
      : (fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData || []));
    var metaJson = JSON.stringify({ name: metadata.name, mimeType: metadata.mimeType || 'application/octet-stream' });
    var head = textToBytes(
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metaJson + '\r\n' +
      '--' + b + '\r\nContent-Type: ' + (metadata.mimeType || 'application/octet-stream') + '\r\n\r\n');
    var tail = textToBytes('\r\n--' + b + '--');
    return { body: concatBytes([head, bytes, tail]), contentType: 'multipart/related; boundary=' + b, boundary: b };
  }

  /* ---------- Respuestas de la API de Drive ---------- */

  // Lista de archivos (GET /drive/v3/files). data: JSON ya parseado.
  // Devuelve {ok, files:[{id,name,mimeType,size,modifiedTime}]}; las
  // entradas sin id o sin nombre se descartan, no rompen la lista.
  function parseDriveFileList(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'La respuesta de Drive no trae una lista de archivos.' };
    }
    if (!Array.isArray(data.files)) {
      return { ok: false, error: 'La respuesta de Drive no trae una lista de archivos.' };
    }
    var files = [];
    data.files.forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      if (typeof f.id !== 'string' || !f.id) return;
      if (typeof f.name !== 'string' || !f.name) return;
      files.push({
        id: f.id, name: f.name,
        mimeType: (typeof f.mimeType === 'string' ? f.mimeType : ''),
        size: (typeof f.size === 'string' && /^\d+$/.test(f.size) ? Number(f.size) : null),
        modifiedTime: (typeof f.modifiedTime === 'string' ? f.modifiedTime : null),
      });
    });
    return { ok: true, files: files };
  }

  // Respuesta de files.create (subida). Devuelve {ok, id, name}.
  function parseDriveUploadResponse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'Drive no devolvió los datos del archivo subido.' };
    }
    if (data.error && typeof data.error === 'object') {
      var m = typeof data.error.message === 'string' ? data.error.message : '';
      return { ok: false, error: 'Drive rechazó la subida' + (m ? ': ' + m : '.') };
    }
    if (typeof data.id !== 'string' || !data.id) {
      return { ok: false, error: 'Drive no devolvió el id del archivo subido.' };
    }
    return { ok: true, id: data.id, name: (typeof data.name === 'string' ? data.name : '') };
  }

  // Mensaje en español para un fallo HTTP de la API de Drive.
  // body: texto de la respuesta o JSON ya parseado (opcional).
  function parseDriveError(status, body) {
    var detail = '';
    try {
      var obj = (typeof body === 'string') ? JSON.parse(body) : body;
      if (obj && obj.error && typeof obj.error.message === 'string' && obj.error.message) {
        detail = obj.error.message;
      }
    } catch (e) {}
    var s = Number(status) || 0;
    if (s === 401) return 'Google dice que la sesión caducó (401). Pulsa «Conectar con Google» de nuevo.' + (detail ? ' Detalle: ' + detail : '');
    if (s === 403) return 'Google no permite esta acción (403). Revisa que el Client ID tenga la API de Google Drive activada y que la cuenta sea la misma.' + (detail ? ' Detalle: ' + detail : '');
    if (s === 404) return 'Ese archivo ya no está en Drive (404). Actualiza la lista.' + (detail ? ' Detalle: ' + detail : '');
    if (s === 429) return 'Google está limitando las peticiones (429). Espera un rato e inténtalo de nuevo.';
    if (s >= 500) return 'Google Drive falló en su lado (' + s + '). Inténtalo más tarde.' + (detail ? ' Detalle: ' + detail : '');
    if (s) return 'Drive devolvió un error (' + s + ').' + (detail ? ' ' + detail : '');
    return 'No se pudo hablar con Google Drive. Revisa tu conexión.' + (detail ? ' ' + detail : '');
  }

  // Búsqueda de respaldos: solo archivos con nombre de respaldo de
  // esta app, sin contar la papelera. Los paréntesis importan: sin
  // ellos, «trashed = false» solo se aplicaría al segundo término.
  function buildDriveListQuery() {
    return "(name contains 'reproductor-sync-' or name contains 'respaldo-reproductor') and trashed = false";
  }

  /* ================= Parte de navegador (DOM) =================
   * Todo aquí es defensivo: si falta un elemento o la app aún no está
   * lista, el módulo no hace nada y la app sigue igual. */
  var doc = (typeof document !== 'undefined') ? document : null;
  var win = (typeof window !== 'undefined') ? window : global;

  var accessToken = null; // solo en memoria, nunca en localStorage
  var tokenClient = null;
  var gisLoading = null; // promesa en curso de cargar GIS, o null
  var driveModal = null;
  var lastUpload = null;

  function getApp() {
    try { return (typeof window !== 'undefined' && window.__rpmApp) || null; }
    catch (e) { return null; }
  }
  function getSyncBridge() {
    try { return (typeof window !== 'undefined' && window.__rpmSync) || null; }
    catch (e) { return null; }
  }
  function appToast(msg) {
    var app = getApp();
    if (app && typeof app.toast === 'function') { try { app.toast(msg); return; } catch (e) {} }
    if (!doc) return;
    var el = doc.getElementById('driveToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'driveToast'; el.className = 'drive-toast'; el.setAttribute('role', 'status');
      doc.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function lsGet(key) {
    try { return win.localStorage ? win.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { if (win.localStorage) win.localStorage.setItem(key, value); } catch (e) {}
  }
  function lsDel(key) {
    try { if (win.localStorage) win.localStorage.removeItem(key); } catch (e) {}
  }
  function getStoredClientId() {
    var raw = lsGet(LS_CLIENT_ID);
    if (!raw) return '';
    var v = validateClientId(raw);
    return v.ok ? v.clientId : '';
  }
  function loadLastUpload() {
    try { lastUpload = JSON.parse(lsGet(LS_LAST_UPLOAD) || 'null'); } catch (e) { lastUpload = null; }
    if (!lastUpload || typeof lastUpload !== 'object') lastUpload = null;
  }

  /* ---------- Google Identity Services (carga perezosa) ---------- */

  function loadGis() {
    if (win.google && win.google.accounts && win.google.accounts.oauth2) {
      return Promise.resolve(win.google);
    }
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (resolve, reject) {
      if (!doc) { reject(new Error('Sin documento.')); return; }
      var s = doc.createElement('script');
      s.src = GIS_URL;
      s.async = true;
      s.defer = true;
      s.onload = function () {
        if (win.google && win.google.accounts && win.google.accounts.oauth2) resolve(win.google);
        else reject(new Error('Google Identity Services no se cargó bien.'));
      };
      s.onerror = function () { reject(new Error('No se pudo cargar Google Identity Services. Revisa tu conexión.')); };
      doc.head.appendChild(s);
    });
    gisLoading.catch(function () { gisLoading = null; });
    return gisLoading;
  }

  // Pide un token nuevo con el Client ID guardado. Solo se llama desde
  // un gesto del usuario (pulsar Conectar o Subir).
  function requestAccessToken() {
    var v = validateClientId(getStoredClientId());
    if (!v.ok) return Promise.reject(new Error(v.error));
    return loadGis().then(function (google) {
      return new Promise(function (resolve, reject) {
        try {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: v.clientId,
            scope: DRIVE_SCOPE,
            callback: function (resp) {
              if (resp && resp.access_token) {
                accessToken = resp.access_token;
                resolve(accessToken);
              } else if (resp && resp.error) {
                reject(new Error('Google no dio acceso: ' + resp.error));
              } else {
                reject(new Error('Google no dio acceso.'));
              }
            },
            error_callback: function (err) {
              reject(new Error('Google no dio acceso' + (err && err.type ? ': ' + err.type : '.')));
            },
          });
          tokenClient.requestAccessToken({ prompt: '' });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  function driveFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + accessToken;
    return fetch(url, opts);
  }

  // Ejecuta fn() con token válido; si Drive dice 401, pide un token
  // nuevo una sola vez y reintenta. Sin token, pide conectar primero.
  function withToken(fn) {
    function attempt() { return fn(); }
    if (!accessToken) {
      return requestAccessToken().then(attempt);
    }
    return attempt().catch(function (err) {
      if (err && err.driveStatus === 401) {
        accessToken = null;
        return requestAccessToken().then(attempt);
      }
      throw err;
    });
  }
  function httpError(status, bodyText) {
    var err = new Error(parseDriveError(status, bodyText));
    err.driveStatus = status;
    return err;
  }

  /* ---------- Construir el respaldo (sin subir nada aún) ---------- */

  function buildBackupBlob() {
    var bridge = getSyncBridge();
    if (bridge && typeof bridge.exportPackage === 'function') {
      return bridge.exportPackage(false).then(function (res) {
        if (!res || !res.blob) throw new Error('El sync no devolvió el paquete .rpmbak.');
        return { blob: res.blob, fileName: res.fileName || buildBackupFileName('rpmbak'), kind: 'rpmbak' };
      });
    }
    // Reserva: JSON con lo que expone __rpmApp. Sin __rpmSync no hay
    // .rpmbak posible desde este módulo (package-io.js es un módulo ES
    // dentro de app/src/sync y no se duplica aquí).
    var app = getApp();
    if (!app || typeof app.getPackState !== 'function' || typeof app.getSyncMeta !== 'function') {
      return Promise.reject(new Error('La app aún no está lista para construir el respaldo.'));
    }
    var tracks = null;
    if (typeof app.getTracks === 'function') {
      try { tracks = app.getTracks() || []; } catch (e) { tracks = null; }
    }
    return Promise.all([app.getPackState(), app.getSyncMeta()]).then(function (parts) {
      var built = buildJsonBackup(parts[0], parts[1], tracks);
      return {
        blob: new Blob([built.text], { type: built.mimeType }),
        fileName: built.fileName, kind: 'json',
      };
    });
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* ---------- Acciones de Drive (todas con gesto del usuario) ---------- */

  function uploadBackup(statusEl) {
    if (!getStoredClientId()) {
      appToast('Primero guarda tu Client ID de Google (ver pasos arriba). Sin él no se puede subir nada.');
      return;
    }
    if (statusEl) statusEl.textContent = 'Preparando el respaldo…';
    buildBackupBlob().then(function (built) {
      if (statusEl) statusEl.textContent = 'Subiendo ' + built.fileName + ' a tu Drive…';
      return blobToBytes(built.blob).then(function (bytes) {
        var multi = buildMultipartBody(
          { name: built.fileName, mimeType: guessMimeType(built.fileName) }, bytes);
        return withToken(function () {
          return driveFetch(DRIVE_UPLOAD_URL, {
            method: 'POST',
            headers: { 'Content-Type': multi.contentType },
            body: multi.body,
          }).then(function (res) {
            return res.text().then(function (text) {
              if (!res.ok) throw httpError(res.status, text);
              var parsed;
              try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
              var out = parseDriveUploadResponse(parsed);
              if (!out.ok) throw new Error(out.error);
              return out;
            });
          });
        }).then(function (out) {
          lastUpload = { id: out.id, name: out.name || built.fileName, at: Date.now(), kind: built.kind };
          lsSet(LS_LAST_UPLOAD, JSON.stringify(lastUpload));
          if (statusEl) statusEl.textContent = 'Respaldo en Drive: ' + lastUpload.name;
          appToast('Respaldo subido a tu Google Drive: ' + lastUpload.name);
          renderDriveList();
          renderStatus();
        });
      });
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = '';
      appToast(err && err.message ? err.message : 'No se pudo subir el respaldo.');
    });
  }

  function listBackups(statusEl) {
    if (!getStoredClientId()) {
      appToast('Primero guarda tu Client ID de Google (ver pasos arriba).');
      return Promise.resolve([]);
    }
    if (statusEl) statusEl.textContent = 'Buscando respaldos en tu Drive…';
    var url = DRIVE_FILES_URL + '?q=' + encodeURIComponent(buildDriveListQuery()) +
      '&fields=' + encodeURIComponent('files(id,name,mimeType,size,modifiedTime)') +
      '&orderBy=' + encodeURIComponent('modifiedTime desc') +
      '&pageSize=20';
    return withToken(function () {
      return driveFetch(url).then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw httpError(res.status, text);
          var parsed;
          try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          var out = parseDriveFileList(parsed);
          if (!out.ok) throw new Error(out.error);
          return out.files;
        });
      });
    }).then(function (files) {
      if (statusEl) statusEl.textContent = files.length ? '' : 'No hay respaldos de esta app en tu Drive todavía.';
      renderDriveList(files);
      return files;
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = '';
      appToast(err && err.message ? err.message : 'No se pudo listar tu Drive.');
      return [];
    });
  }

  function downloadBackup(file, statusEl) {
    if (statusEl) statusEl.textContent = 'Descargando ' + file.name + '…';
    withToken(function () {
      return driveFetch(DRIVE_FILES_URL + '/' + encodeURIComponent(file.id) + '?alt=media')
        .then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw httpError(res.status, t); });
          return res.blob();
        });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = file.name;
      doc.body.appendChild(a); a.click();
      doc.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      if (statusEl) statusEl.textContent = '';
      var how = file.name.slice(-7).toLowerCase() === '.rpmbak'
        ? 'Para aplicarlo, usa «Sincronizar» → «Importar paquete (.rpmbak)» en la app.'
        : 'Para aplicarlo, usa «Importar respaldo» en la app.';
      appToast('Descargado: ' + file.name + '. ' + how);
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = '';
      appToast(err && err.message ? err.message : 'No se pudo descargar ese archivo.');
    });
  }

  function trashBackup(file, statusEl) {
    withToken(function () {
      return driveFetch(DRIVE_FILES_URL + '/' + encodeURIComponent(file.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw httpError(res.status, t); });
        return res.json();
      });
    }).then(function () {
      appToast('«' + file.name + '» se movió a la papelera de tu Drive (se puede recuperar desde drive.google.com).');
      listBackups(statusEl);
    }).catch(function (err) {
      appToast(err && err.message ? err.message : 'No se pudo mover ese archivo a la papelera.');
    });
  }


  /* ---------- API para la sincronización automática (nube.js, v4.0.0) ----------
   * Las mismas llamadas que usa el panel, pero sin DOM y sin descargar
   * a disco: nube.js las usa para leer y escribir LA copia de la nube
   * (el .rpmbak con nombre fijo). Reutilizan withToken/driveFetch/
   * buildMultipartBody/parseDrive* que ya existen arriba; no duplican
   * nada. No tocan lastUpload: eso es del respaldo manual. */

  // ¿Hay token en memoria en esta sesión?
  function isConnected() { return !!accessToken; }

  // Pide un token con el permiso ya concedido (sin mostrar nada si
  // el usuario ya dio el permiso en el panel de Drive). Rechaza si
  // no hay Client ID o Google no da acceso.
  function ensureConnected() { return requestAccessToken(); }

  // Consulta exacta por nombre (para la copia de la nube). Las
  // comillas simples del nombre se escapan como exige Drive.
  function buildDriveNameQuery(name) {
    var safe = String(name || '').replace(/'/g, "\\'");
    return "name = '" + safe + "' and trashed = false";
  }

  // Lista archivos con ese nombre exacto, los más recientes primero.
  function listFilesByName(name) {
    if (!String(name || '')) return Promise.resolve([]);
    var url = DRIVE_FILES_URL + '?q=' + encodeURIComponent(buildDriveNameQuery(name)) +
      '&fields=' + encodeURIComponent('files(id,name,mimeType,size,modifiedTime)') +
      '&orderBy=' + encodeURIComponent('modifiedTime desc') +
      '&pageSize=10';
    return withToken(function () {
      return driveFetch(url).then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw httpError(res.status, text);
          var parsed;
          try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          var out = parseDriveFileList(parsed);
          if (!out.ok) throw new Error(out.error);
          return out.files;
        });
      });
    });
  }

  // Descarga el contenido como Blob (para leer el .rpmbak), sin
  // bajarlo al dispositivo como hace downloadBackup().
  function downloadFileBlob(fileId) {
    if (!fileId) return Promise.reject(new Error('Falta el id del archivo en Drive.'));
    return withToken(function () {
      return driveFetch(DRIVE_FILES_URL + '/' + encodeURIComponent(fileId) + '?alt=media')
        .then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw httpError(res.status, t); });
          return res.blob();
        });
    });
  }

  // Sube un archivo nuevo (multipart, igual que el respaldo manual).
  function uploadFile(blob, fileName, mimeType) {
    if (!blob) return Promise.reject(new Error('No hay archivo que subir.'));
    if (!String(fileName || '')) return Promise.reject(new Error('Falta el nombre del archivo.'));
    return blobToBytes(blob).then(function (bytes) {
      var multi = buildMultipartBody(
        { name: fileName, mimeType: mimeType || guessMimeType(fileName) }, bytes);
      return withToken(function () {
        return driveFetch(DRIVE_UPLOAD_URL, {
          method: 'POST',
          headers: { 'Content-Type': multi.contentType },
          body: multi.body,
        }).then(function (res) {
          return res.text().then(function (text) {
            if (!res.ok) throw httpError(res.status, text);
            var parsed;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
            var out = parseDriveUploadResponse(parsed);
            if (!out.ok) throw new Error(out.error);
            return out;
          });
        });
      });
    });
  }

  // Sustituye el contenido de un archivo que ya existe (subida
  // media, PATCH). Así la copia de la nube es siempre el MISMO
  // archivo de Drive y no se acumulan copias con el mismo nombre.
  function updateFileContent(fileId, blob, mimeType) {
    if (!fileId) return Promise.reject(new Error('Falta el id del archivo en Drive.'));
    if (!blob) return Promise.reject(new Error('No hay archivo que subir.'));
    return blobToBytes(blob).then(function (bytes) {
      return withToken(function () {
        return driveFetch('https://www.googleapis.com/upload/drive/v3/files/' +
          encodeURIComponent(fileId) + '?uploadType=media', {
          method: 'PATCH',
          headers: { 'Content-Type': mimeType || 'application/octet-stream' },
          body: bytes,
        }).then(function (res) {
          return res.text().then(function (text) {
            if (!res.ok) throw httpError(res.status, text);
            var parsed;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
            var out = parseDriveUploadResponse(parsed);
            if (!out.ok) throw new Error(out.error);
            return out;
          });
        });
      });
    });
  }

  /* ---------- Panel (reusa .modal-overlay/.modal de la app) ---------- */

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var statusEl = null, listEl = null, clientInput = null, connectBtn = null;

  function renderStatus() {
    if (!statusEl) return;
    var hasId = !!getStoredClientId();
    var parts = [];
    parts.push(hasId ? '✓ Client ID guardado.' : '✗ Sin Client ID: sin él no se puede conectar ni subir nada.');
    parts.push(accessToken ? '✓ Conectado a Google (sesión actual).' : '○ Sin conectar con Google en esta sesión.');
    if (lastUpload) {
      var d = new Date(lastUpload.at);
      parts.push('Última subida: ' + lastUpload.name + ' (' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ').');
    }
    statusEl.textContent = parts.join(' ');
    if (connectBtn) connectBtn.disabled = !hasId;
  }

  function renderDriveList(files) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!files) return; // aún no se ha listado en esta apertura
    if (!files.length) {
      listEl.appendChild(el('p', 'drive-empty', 'No hay respaldos de esta app en tu Drive todavía.'));
      return;
    }
    files.forEach(function (f) {
      var row = el('div', 'drive-row');
      var main = el('div', 'drive-row-main');
      main.appendChild(el('span', 'drive-row-title', f.name));
      var meta = [];
      if (f.size != null) meta.push(formatBytes(f.size));
      if (f.modifiedTime) {
        try { meta.push(new Date(f.modifiedTime).toLocaleString()); } catch (e) {}
      }
      main.appendChild(el('span', 'drive-row-meta', meta.join(' · ') || 'Respaldo'));
      row.appendChild(main);
      var dl = el('button', 'btn small', 'Descargar');
      dl.type = 'button';
      dl.addEventListener('click', function () { downloadBackup(f, statusEl); });
      row.appendChild(dl);
      var tr = el('button', 'btn small', 'Papelera');
      tr.type = 'button';
      tr.addEventListener('click', function () {
        if (confirm('¿Mover «' + f.name + '» a la papelera de tu Drive? Se puede recuperar desde drive.google.com.')) {
          trashBackup(f, statusEl);
        }
      });
      row.appendChild(tr);
      listEl.appendChild(row);
    });
    listEl.appendChild(el('p', 'drive-note',
      'Descargar baja el archivo a este dispositivo. Para aplicarlo: un .rpmbak se importa con «Sincronizar» → «Importar paquete (.rpmbak)», y un JSON con «Importar respaldo».'));
  }

  function openDriveModal() {
    if (!doc) return;
    if (!driveModal) {
      var ov = el('div', 'modal-overlay drive-overlay');
      var box = el('div', 'modal drive-modal');
      ov.appendChild(box);
      ov.addEventListener('click', function (ev) { if (ev.target === ov) closeOverlay(ov); });
      doc.body.appendChild(ov);
      driveModal = { ov: ov, box: box };

      box.appendChild(el('h3', null, 'Respaldo en Google Drive'));
      box.appendChild(el('p', 'drive-sub',
        'Guarda una copia de tu biblioteca en TU Google Drive. Nada se sube solo: solo se sube cuando pulses «Subir respaldo a Drive». ' +
        'La app no tiene cuenta de Google propia, así que necesitas tu propio Client ID (gratis, 5 minutos, se explica abajo).'));
      statusEl = el('p', 'drive-status', '');
      box.appendChild(statusEl);

      var stepsTitle = el('h4', 'drive-h4', '1 · Crea tu Client ID (una sola vez)');
      box.appendChild(stepsTitle);
      var ol = el('ol', 'drive-steps');
      [
        'Abre Google Cloud Console → APIs y servicios → Credenciales.',
        'Si no tienes proyecto, crea uno (nombre libre, p. ej. «reproductor-musica»).',
        '«Crear credenciales» → «ID de cliente de OAuth» → tipo de aplicación «Aplicación web».',
        'En «Orígenes de JavaScript autorizados» añade la dirección desde la que abres la app (por ejemplo https://sandovaljon.github.io). En «URI de redirección» no hace falta nada para este flujo.',
        'Copia el «ID de cliente» (termina en .apps.googleusercontent.com) y pégalo abajo. No pegues el «Secreto de cliente»: este flujo no lo usa ni lo pide.',
      ].forEach(function (t) { ol.appendChild(el('li', null, t)); });
      box.appendChild(ol);
      var consoleLink = el('a', 'drive-link', 'Abrir Google Cloud Console → Credenciales');
      consoleLink.href = 'https://console.cloud.google.com/apis/credentials';
      consoleLink.target = '_blank';
      consoleLink.rel = 'noopener';
      box.appendChild(consoleLink);
      box.appendChild(el('p', 'drive-note',
        'Permiso que pedirá Google: «Ver y gestionar los archivos de Google Drive creados con esta app» (drive.file). ' +
        'El módulo solo puede ver los respaldos que él mismo sube, no el resto de tu Drive. ' +
        'El Client ID se guarda solo en este navegador (localStorage); el token de acceso solo vive en memoria y caduca en ~1 hora.'));

      box.appendChild(el('h4', 'drive-h4', '2 · Tu Client ID'));
      var row = el('div', 'drive-client-row');
      clientInput = el('input', 'drive-client-input');
      clientInput.type = 'text';
      clientInput.id = 'driveClientId';
      clientInput.placeholder = '123456789012-abc….apps.googleusercontent.com';
      clientInput.autocomplete = 'off';
      clientInput.spellcheck = false;
      clientInput.value = getStoredClientId();
      row.appendChild(clientInput);
      var saveBtn = el('button', 'btn small primary', 'Guardar Client ID');
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', function () {
        var v = validateClientId(clientInput.value);
        if (!v.ok) { appToast(v.error); return; }
        lsSet(LS_CLIENT_ID, v.clientId);
        appToast('Client ID guardado en este navegador.');
        renderStatus();
      });
      row.appendChild(saveBtn);
      var clearBtn = el('button', 'btn small', 'Borrar');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', function () {
        lsDel(LS_CLIENT_ID);
        accessToken = null;
        clientInput.value = '';
        appToast('Client ID borrado. Ya no se podrá conectar hasta guardar otro.');
        renderStatus();
      });
      row.appendChild(clearBtn);
      box.appendChild(row);

      box.appendChild(el('h4', 'drive-h4', '3 · Respaldos'));
      var actions = el('div', 'drive-actions');
      connectBtn = el('button', 'btn small', 'Conectar con Google');
      connectBtn.type = 'button';
      connectBtn.addEventListener('click', function () {
        if (!getStoredClientId()) { appToast('Primero guarda tu Client ID (paso 2).'); return; }
        statusEl.textContent = 'Conectando con Google…';
        requestAccessToken().then(function () {
          statusEl.textContent = '';
          appToast('Conectado a Google.');
          renderStatus();
        }).catch(function (err) {
          statusEl.textContent = '';
          appToast(err && err.message ? err.message : 'No se pudo conectar con Google.');
        });
      });
      actions.appendChild(connectBtn);
      var upBtn = el('button', 'btn small primary', 'Subir respaldo a Drive');
      upBtn.type = 'button';
      upBtn.addEventListener('click', function () { uploadBackup(statusEl); });
      actions.appendChild(upBtn);
      var listBtn = el('button', 'btn small', 'Ver respaldos en Drive');
      listBtn.type = 'button';
      listBtn.addEventListener('click', function () { listBackups(statusEl); });
      actions.appendChild(listBtn);
      box.appendChild(actions);
      box.appendChild(el('p', 'drive-note',
        'Qué se sube: si el sync está disponible, el paquete .rpmbak completo (con audios, igual que «Sincronizar» → Exportar). ' +
        'Si no, un JSON con playlists, ajustes, historial, contadores y perfiles (sin audios; metadatos de pistas solo si la app los expone).'));

      listEl = el('div', 'drive-list');
      box.appendChild(listEl);

      var closeRow = el('div', 'modal-actions drive-actions');
      var closeBtn = el('button', 'btn small', 'Cerrar');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', function () { closeOverlay(driveModal.ov); });
      closeRow.appendChild(closeBtn);
      box.appendChild(closeRow);
    }
    clientInput.value = getStoredClientId();
    loadLastUpload();
    renderStatus();
    renderDriveList(null);
    openOverlay(driveModal.ov);
  }

  function openOverlay(ov) { ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); }
  function closeOverlay(ov) { ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); }

  /* ---------- Botón «Drive» junto a «Sincronizar» ---------- */
  function ensureDriveButton() {
    if (!doc) return;
    var syncBtn = doc.getElementById('btnSync');
    if (!syncBtn) return;
    if (doc.getElementById('btnDrive')) return;
    var btn = el('button', 'btn small', '☁️ Drive');
    btn.id = 'btnDrive'; btn.type = 'button';
    btn.title = 'Guardar el respaldo en tu Google Drive (necesita tu propio Client ID de Google)';
    btn.addEventListener('click', openDriveModal);
    if (syncBtn.parentNode) syncBtn.parentNode.insertBefore(btn, syncBtn.nextSibling);
    else syncBtn.after(btn);
  }

  function init() {
    if (!doc) return;
    try {
      loadLastUpload();
      ensureDriveButton();
      doc.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && driveModal) closeOverlay(driveModal.ov);
      });
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[drive] desactivado por error en el inicio:', e);
      }
    }
  }

  /* ================= API pública ================= */
  var api = {
    VERSION: VERSION,
    DRIVE_SCOPE: DRIVE_SCOPE,
    GIS_URL: GIS_URL,
    validateClientId: validateClientId,
    buildBackupFileName: buildBackupFileName,
    buildJsonBackup: buildJsonBackup,
    buildMultipartBody: buildMultipartBody,
    parseDriveFileList: parseDriveFileList,
    parseDriveUploadResponse: parseDriveUploadResponse,
    parseDriveError: parseDriveError,
    buildDriveListQuery: buildDriveListQuery,
    isBackupFileName: isBackupFileName,
    formatBytes: formatBytes,
    guessMimeType: guessMimeType,
    getStoredClientId: getStoredClientId,
    isConnected: isConnected,
    ensureConnected: ensureConnected,
    buildDriveNameQuery: buildDriveNameQuery,
    listFilesByName: listFilesByName,
    downloadFileBlob: downloadFileBlob,
    uploadFile: uploadFile,
    updateFileContent: updateFileContent,
    openDriveModal: openDriveModal,
    init: init,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    try { global.__rpmDrive = api; } catch (e) {}
    if (doc) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
      else init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
