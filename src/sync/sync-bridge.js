/**
 * sync-bridge.js — 3.0.0, fase 3
 *
 * Puente entre la app (window.__rpmApp, expuesto por app/index.html)
 * y los módulos de sync de las fases 1 y 2. Es el ÚNICO sitio que
 * conoce a la vez la app y el sync: package-io y sync-ui no tocan
 * IndexedDB ni el DOM de la app, y la app no conoce el formato
 * .rpmbak. Si este módulo falla al cargar, la app sigue como en
 * 2.9.1: el botón "Sincronizar" solo avisa (ver el cableado en
 * app/index.html) y nada más cambia.
 *
 * Contrato que la app expone como window.__rpmApp (definido al final
 * del IIFE de app/index.html):
 *   idbAll() / idbPut(rec) / idbDelete(id) / idbGet(id) — registros
 *     completos de 'tracks' (con blob y coverBlob).
 *   idbMetaGet(key) / idbMetaSet(key, value) — almacén 'meta'.
 *   getSyncMeta() / setSyncMeta(meta) / ensureDeviceId() /
 *     markSynced() / recordDeletion(key, deletedAt)
 *   getPackState() — el packState guardado (playlists, historial…).
 *   applyPackState(state) — aplica un packState fusionado a la app
 *     en memoria y lo guarda (saveState + render).
 *   getTracks() — pistas en memoria (para títulos legibles).
 *   getTrackBlob(t) — blob de una pista (por si hiciera falta).
 *   readLyrics() / writeLyrics(map) — letras de localStorage.
 *   trackKey(t) — identidad de sync de una pista.
 *   reloadLibrary() — relee IndexedDB y repinta (tras aplicar).
 *   render() / toast(msg)
 *
 * Uso en el navegador (módulo, se auto-inicia al cargar):
 *   <script type="module" src="./src/sync/sync-bridge.js"></script>
 * Uso en pruebas (Node): createSyncBridge(appFalsa) con un objeto
 * que implemente el contrato de arriba con un Map en memoria.
 */
import { trackKey as trackKeyOf, trackMetaForExport } from '../library/track-meta.js';
import {
  buildSyncPackage, readSyncPackage, previewMerge, buildApplyOps,
} from './package-io.js';
import { createSyncUI } from './sync-ui.js';

// Campos que viajan en un metadato de paquete y que se escriben en el
// registro de IndexedDB. La carpeta (folder) NO viaja: es la ruta del
// archivo en el dispositivo de origen y el otro no la tiene; una pista
// importada queda con folder '' (limitación documentada en PLAN §6).
const RECORD_META_FIELDS = [
  'id', 'name', 'title', 'artist', 'album', 'duration', 'size', 'type',
  'addedAt', 'updatedAt', 'rating', 'stars', 'genre', 'year', 'tags',
  'memSpeed', 'memEq', 'folder', 'abLoop', 'bookmarks', 'silence',
  'bpm', 'bpmManual', 'audioHash', 'kind', 'energy', 'brightness',
  'mood', 'musicalKey', 'keyName', 'isAudiobook', 'abPos', 'chapters',
  'peaks', 'trackNo', 'sampleRate', 'channels', 'normDb', 'volAdj',
];

/**
 * Construye el registro de IndexedDB para una pista fusionada.
 * base: registro local existente (para conservar blob/portada y los
 * campos que el paquete no trae) o null si es pista nueva.
 * meta: metadatos fusionados del paquete (proyección de sync).
 * blob/cover: Blob nuevo, null (sin audio: pendiente) o la cadena
 * 'keep-local' (conservar el blob que ya hay).
 */
export function recordFromMeta(meta, blob, cover, base) {
  const rec = { ...(base || {}) };
  RECORD_META_FIELDS.forEach((k) => {
    if (meta && meta[k] !== undefined) rec[k] = meta[k];
  });
  if (typeof rec.addedAt !== 'number') rec.addedAt = Date.now();
  if (typeof rec.updatedAt !== 'number') rec.updatedAt = rec.addedAt;
  if (typeof rec.folder !== 'string') rec.folder = '';
  rec.blob = blob === 'keep-local' ? (base ? base.blob : null) : (blob || null);
  rec.coverBlob = cover === 'keep-local' ? (base ? base.coverBlob : null) : (cover || null);
  return rec;
}

/**
 * Fusión de letras (aproximación documentada en SYNC-UI.md §3):
 * el motor de sync no guarda updatedAt por letra, así que gana la
 * del paquete si el paquete es más nuevo que el último sync, o si
 * la letra no existe en local. En cualquier otro caso se conserva
 * la local.
 */
export function mergeLyrics(localLyrics, remoteLyrics, remoteExportedAt, lastSyncAt) {
  const out = { ...(localLyrics || {}) };
  const remoteMs = Date.parse(remoteExportedAt || '') || 0;
  Object.keys(remoteLyrics || {}).forEach((k) => {
    if (!(k in out) || remoteMs > (lastSyncAt || 0)) out[k] = remoteLyrics[k];
  });
  return out;
}

/**
 * Colisión de ids al importar: buildApplyOps conserva el id remoto
 * de las pistas nuevas porque las playlists lo referencian. Si ese
 * id ya existe en local para OTRA canción (prácticamente imposible:
 * 't' + fecha + azar), se genera un id nuevo y se reescribe en las
 * playlists fusionadas antes de escribir nada.
 * Devuelve las operaciones (las reescribe in situ).
 */
export function resolveIdCollisions(ops, localById) {
  const renamed = new Map(); // id remoto -> id nuevo
  ops.forEach((op) => {
    if (op.op !== 'put') return;
    const owner = localById.get(op.localId);
    if (owner && owner !== op.key) {
      const fresh = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      renamed.set(op.localId, fresh);
      op.localId = fresh;
      if (op.meta) op.meta = { ...op.meta, id: fresh };
    }
  });
  if (renamed.size) {
    ops.forEach((op) => {
      if (op.op !== 'state' || !op.state || !Array.isArray(op.state.playlists)) return;
      op.state.playlists.forEach((p) => {
        if (!p || !Array.isArray(p.trackIds)) return;
        p.trackIds = p.trackIds.map((id) => renamed.get(id) || id);
      });
    });
  }
  return ops;
}

function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/**
 * Crea el bridge de sync sobre una app que cumpla el contrato de
 * arriba. Lanza un Error claro si falta algo imprescindible: la UI
 * no debe construirse sobre un bridge a medias.
 */
export function createSyncBridge(app) {
  if (!app || typeof app !== 'object') {
    throw new Error('sync-bridge necesita la app (window.__rpmApp).');
  }
  const need = [
    'idbAll', 'idbPut', 'idbDelete', 'idbGet', 'idbMetaGet', 'idbMetaSet',
    'getSyncMeta', 'ensureDeviceId', 'markSynced', 'recordDeletion',
    'getPackState', 'applyPackState', 'readLyrics', 'writeLyrics',
    'trackKey', 'getTracks', 'reloadLibrary', 'toast',
  ];
  const missing = need.filter((m) => typeof app[m] !== 'function');
  if (missing.length) {
    throw new Error('A la app le faltan para el sync: ' + missing.join(', '));
  }

  // La vista previa vigente: la UI llama a preview() y luego a
  // applyMerge() sobre la MISMA vista previa, así que el bridge
  // guarda el paquete leído para volver a fusionar con las tumbas
  // ya filtradas por la confirmación del usuario.
  let lastPreview = null; // { localState, remote }

  async function localRecords() {
    return (await app.idbAll()) || [];
  }

  async function getLocalState() {
    const records = await localRecords();
    const syncMeta = await app.getSyncMeta();
    const packState = (await app.getPackState()) || {};
    return {
      tracks: records.map((r) => {
        const meta = trackMetaForExport(r) || {};
        meta.hasAudio = !!r.blob;
        meta.size = typeof r.size === 'number' ? r.size : null;
        meta.duration = typeof r.duration === 'number' ? r.duration : null;
        meta.addedAt = typeof r.addedAt === 'number' ? r.addedAt : meta.updatedAt;
        meta.type = typeof r.type === 'string' ? r.type : '';
        return meta;
      }),
      playlists: packState.playlists || [],
      customSmart: packState.customSmart || [],
      queue: packState.queue || [],
      history: packState.history || [],
      counts: packState.counts || {},
      statsLog: packState.statsLog || [],
      profiles: packState.profiles || [],
      settings: packState.settings || null,
      stateUpdatedAt: syncMeta.stateUpdatedAt || 0,
      lastSyncAt: syncMeta.lastSyncAt || 0,
    };
  }

  const bridge = {
    async getLastSyncInfo() {
      const meta = await app.getSyncMeta();
      const records = await localRecords();
      return {
        lastSyncAt: meta.lastSyncAt || 0,
        deviceId: meta.deviceId || null,
        trackCount: records.length,
      };
    },

    async estimateExport(incremental) {
      const meta = await app.getSyncMeta();
      const since = incremental ? (meta.lastSyncAt || 0) : 0;
      const records = await localRecords();
      let audioCount = 0;
      let totalBytes = 0;
      records.forEach((r) => {
        const changed = (typeof r.updatedAt === 'number' ? r.updatedAt : (r.addedAt || 0)) > since;
        if (changed && r.blob) {
          audioCount++;
          totalBytes += r.blob.size || 0;
          if (r.coverBlob) totalBytes += r.coverBlob.size || 0;
        }
      });
      return { trackCount: records.length, audioCount, totalBytes };
    },

    async exportPackage(incremental) {
      const syncMeta = await app.getSyncMeta();
      const deviceId = await app.ensureDeviceId();
      const since = incremental ? (syncMeta.lastSyncAt || 0) : 0;
      const records = await localRecords();
      const packState = (await app.getPackState()) || {};
      const built = await buildSyncPackage({
        tracks: records,
        getBlob: (r) => Promise.resolve(r.blob || null),
        getCoverBlob: (r) => Promise.resolve(r.coverBlob || null),
        state: {
          ...packState,
          lyrics: app.readLyrics(),
          deletions: syncMeta.deletions || [],
          stateUpdatedAt: syncMeta.stateUpdatedAt || 0,
        },
        deviceId,
        since,
      });
      await app.markSynced();
      return { blob: built.blob, fileName: built.fileName };
    },

    async readPackage(file) {
      return readSyncPackage(file);
    },

    async getLocalState() {
      return getLocalState();
    },

    preview(localState, remote) {
      const out = previewMerge(localState, remote);
      lastPreview = { localState, remote, preview: out };
      return out;
    },

    async applyMerge(preview, opts = {}) {
      if (!lastPreview || lastPreview.preview !== preview) {
        throw new Error('Sin vista previa vigente: importa el paquete antes de aplicar.');
      }
      const { localState, remote } = lastPreview;
      const confirmed = new Set(opts.confirmDeletionKeys || []);
      const filteredRemote = {
        ...remote,
        meta: {
          ...remote.meta,
          deletions: (remote.meta.deletions || []).filter((d) => confirmed.has(d.key)),
        },
      };
      // Volver a fusionar con las tumbas confirmadas: es la misma
      // fusión que la vista previa, solo cambia qué borrados aplican.
      const again = previewMerge(localState, filteredRemote, { confirmDeletions: true });
      const localByKey = new Map();
      const localById = new Map();
      (localState.tracks || []).forEach((t) => {
        const k = trackKeyOf(t);
        if (!k) return;
        localByKey.set(k, { id: t.id, hasAudio: t.hasAudio !== false });
        localById.set(t.id, k);
      });
      const ops = resolveIdCollisions(
        buildApplyOps(again.merged, localByKey, remote.audios, remote.covers),
        localById,
      );

      let applied = 0;
      for (const op of ops) {
        if (op.op === 'delete') {
          await app.idbDelete(op.localId);
          // La tumba propaga el borrado a un tercer dispositivo.
          const tomb = (remote.meta.deletions || []).find((d) => d.key === op.key);
          await app.recordDeletion(op.key, tomb ? tomb.deletedAt : Date.now());
          applied++;
        } else if (op.op === 'put') {
          const base = op.audio === 'keep-local' || op.cover === 'keep-local'
            ? await app.idbGet(op.localId) : null;
          const rec = recordFromMeta(op.meta, op.audio, op.cover, base);
          await app.idbPut(rec);
          applied++;
        } else if (op.op === 'state') {
          await app.applyPackState(op.state);
          applied++;
        }
      }

      // Letras: fusión por clave (ver mergeLyrics). No forma parte de
      // las operaciones porque viven en localStorage, no en IndexedDB.
      const syncMeta = await app.getSyncMeta();
      const mergedLyrics = mergeLyrics(
        app.readLyrics(), remote.meta.lyrics || {},
        remote.meta.exportedAt, syncMeta.lastSyncAt,
      );
      app.writeLyrics(mergedLyrics);

      // Solo si TODO terminó bien: el próximo export incremental
      // vuelve a llevar lo que no se aplicó.
      await app.markSynced();
      lastPreview = null;
      return { applied, deletions: (again.report.appliedDeletions || []).length };
    },

    titleForKey(key) {
      const inMemory = (app.getTracks() || []).find((t) => app.trackKey(t) === key);
      if (inMemory) return inMemory.title || inMemory.name || key;
      const remoteTracks = (lastPreview && lastPreview.remote && lastPreview.remote.meta.tracks) || [];
      const remote = remoteTracks.find((t) => trackKeyOf(t) === key);
      if (remote) return remote.title || remote.name || key;
      return key;
    },

    async onApplied() {
      try {
        await app.reloadLibrary();
      } catch (e) {
        // Si la recarga en caliente falla, recargar la página es el
        // plan B: la biblioteca ya está escrita en IndexedDB.
        if (typeof location !== 'undefined') location.reload();
      }
      if (typeof app.render === 'function') app.render();
    },

    toast(msg) {
      app.toast(msg);
    },
  };
  return bridge;
}

/**
 * Entrada del navegador: crea el bridge sobre window.__rpmApp,
 * expone window.__rpmSync y window.__rpmSyncUI, y engancha el botón
 * #btnSync. Devuelve el bridge o null si la app no está lista o el
 * sync no se pudo crear: en ese caso la app sigue funcionando sin
 * sync (el botón avisa, ver app/index.html).
 */
export function initSyncBridge(app) {
  const theApp = app || (typeof window !== 'undefined' ? window.__rpmApp : null);
  if (!theApp) return null;
  let bridge;
  try {
    bridge = createSyncBridge(theApp);
  } catch (e) {
    return null;
  }
  if (typeof window !== 'undefined') window.__rpmSync = bridge;
  let ui = null;
  try {
    ui = createSyncUI(bridge);
    if (typeof window !== 'undefined') window.__rpmSyncUI = ui;
  } catch (e) {
    ui = null;
  }
  // El CSS del modal, cargado como hace mejoras.js con el suyo: si
  // no carga, el modal sigue funcionando con el estilo base de la app.
  if (typeof document !== 'undefined' && !document.querySelector('link[data-rpm-sync-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './src/sync/sync-ui.css';
    link.setAttribute('data-rpm-sync-css', '1');
    document.head.appendChild(link);
  }
  if (typeof document !== 'undefined') {
    const btn = document.getElementById('btnSync');
    if (btn) {
      btn.addEventListener('click', () => {
        if (ui) ui.open();
        else theApp.toast('La sincronización no se pudo cargar. Recarga la app e inténtalo de nuevo.');
      });
    }
  }
  return bridge;
}

// Auto-inicio al cargar el módulo en el navegador. En Node
// (pruebas) no hay window y no se hace nada. El script clásico de
// la app ya corrió cuando este módulo se ejecuta (los módulos son
// diferidos), así que window.__rpmApp debería existir; el sondeo
// corto es solo por si el orden de carga cambia.
if (typeof window !== 'undefined') {
  let tries = 0;
  const tick = () => {
    if (window.__rpmApp) {
      initSyncBridge(window.__rpmApp);
      return;
    }
    tries++;
    if (tries < 30) setTimeout(tick, 100);
  };
  tick();
}
