/**
 * package-io.js — 3.0.0, fase 2
 *
 * Construye y lee el paquete de sync `.rpmbak` (ZIP método *store*,
 * ver PLAN-3.0.0.md, §1.3):
 *
 *   manifest.json  { kind, version, app, exportedAt, deviceId,
 *                    trackCount, audioCount, totalBytes, incremental, since }
 *   meta.json      { kind, version, deviceId, exportedAt, incremental, since,
 *                    tracks: [metadatos + size/duration/addedAt/type/hasAudio],
 *                    playlists, customSmart, queue, history, counts, statsLog,
 *                    profiles, settings, stateUpdatedAt, seriesSpeed,
 *                    lyrics, deletions: [{ key, deletedAt }] }
 *   audios/<clave>.<ext>          (clave = audioHash, o id local si no hay)
 *   audios/covers/<clave>.<ext>   (solo si la pista trae coverBlob)
 *
 * Este módulo NO toca IndexedDB ni el DOM: quien exporta le pasa
 * los datos y dos funciones (`getBlob`, `getCoverBlob`) que leen el
 * audio de donde viva (en la app, `getTrackBlob()` de index.html);
 * quien importa recibe mapas de bytes y decide cómo guardarlos.
 * Así se puede probar con Node usando Blobs falsos.
 *
 * Regla de audio en el paquete incremental: los metadatos viajan
 * siempre completos (pesan poco); los audios solo de las pistas
 * con `updatedAt` posterior a `since` (o todas, si no hay `since`).
 * Una pista nueva en el otro dispositivo sin su audio queda como
 * "pendiente de audio": nunca se descarta (ver sync-core.js).
 *
 * Nada de lo que hay aquí APLICA cambios: `previewMerge()` fusiona
 * en memoria y devuelve el resumen; `buildApplyOps()` convierte
 * esa fusión en una lista de operaciones que el cableado (fase 3)
 * ejecuta solo tras la confirmación del usuario en la UI.
 */
import { trackMetaForExport, trackKey, effectiveUpdatedAt } from '../library/track-meta.js';
import {
  SYNC_KIND, SYNC_PACKAGE_VERSION, SYNC_PACKAGE_EXT,
  validatePackage, mergeState, summarizeMerge, buildManifest,
} from './sync-core.js';
import { buildZipBlob, readZipStore } from '../library/zip.js';

export { SYNC_KIND, SYNC_PACKAGE_VERSION, SYNC_PACKAGE_EXT };

const AUDIO_DIR = 'audios/';
const COVER_DIR = 'audios/covers/';
const MANIFEST_NAME = 'manifest.json';
const META_NAME = 'meta.json';

function safeExt(name, fallback = 'bin') {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : fallback;
}

function extForType(type, fallback) {
  const t = String(type || '').toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('flac')) return 'flac';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('wav') || t.includes('x-wav')) return 'wav';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  if (t.includes('webm')) return 'webm';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  return fallback;
}

/** Clave de archivo de una pista: su huella, o su id si no la tiene. */
export function audioKeyFor(meta) {
  if (meta && typeof meta.audioHash === 'string' && meta.audioHash) return meta.audioHash;
  return meta && typeof meta.id === 'string' ? meta.id : null;
}

/** Nombre del audio dentro del ZIP, p. ej. audios/<hash>.mp3 */
export function audioFileName(meta) {
  const key = audioKeyFor(meta);
  if (!key) return null;
  const ext = extForType(meta && meta.type, safeExt(meta && meta.name, 'mp3'));
  return AUDIO_DIR + key + '.' + ext;
}

export function coverFileName(meta, coverBlob) {
  const key = audioKeyFor(meta);
  if (!key) return null;
  const ext = extForType(coverBlob && coverBlob.type, 'jpg');
  return COVER_DIR + key + '.' + ext;
}

/**
 * Metadatos de una pista tal como viajan en meta.json. Es la
 * proyección de trackMetaForExport() MÁS los campos que el sync
 * necesita y el respaldo v10 no guardaba: size, duration, addedAt
 * y type (la identidad sin huella es nombre+tamaño+duración, y
 * updatedAt cae a addedAt). `hasAudio` dice si el paquete trae
 * el blob de esta pista.
 */
export function packageTrackMeta(track, hasAudio) {
  const meta = trackMetaForExport(track);
  if (!meta) return null;
  meta.size = (typeof track.size === 'number' && Number.isFinite(track.size)) ? track.size : null;
  meta.duration = (typeof track.duration === 'number' && Number.isFinite(track.duration))
    ? track.duration : null;
  meta.addedAt = (typeof track.addedAt === 'number' && Number.isFinite(track.addedAt))
    ? track.addedAt : effectiveUpdatedAt(track);
  meta.type = typeof track.type === 'string' ? track.type : '';
  meta.hasAudio = hasAudio !== false;
  return meta;
}

/** Nombre de archivo sugerido para el paquete exportado. */
export function packageFileName(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return 'reproductor-sync-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + SYNC_PACKAGE_EXT;
}

/**
 * Construye el paquete .rpmbak.
 * tracks: registros completos de la biblioteca (con blob accesible
 *   vía getBlob). state: { playlists, customSmart, queue, history,
 *   counts, statsLog, profiles, settings, stateUpdatedAt,
 *   seriesSpeed, lyrics, deletions } (los campos que falten se
 *   tratan como vacíos).
 * getBlob(track) -> Blob|null, getCoverBlob(track) -> Blob|null.
 * since: milisegundos; solo viajan los audios de pistas con
 *   updatedAt > since. Sin since (0/null) viajan todos (completo).
 * Devuelve { blob, fileName, manifest, meta, audioCount, totalBytes }.
 */
export async function buildSyncPackage(opts) {
  const {
    tracks = [], getBlob, getCoverBlob, state = {},
    deviceId, since = 0, now = Date.now(),
  } = opts || {};
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('buildSyncPackage necesita deviceId (ver ensureDeviceId en db.js).');
  }
  const exportedAt = new Date(now).toISOString();
  const incremental = !!since;
  const entries = [];
  const metas = [];
  let audioCount = 0;
  let totalBytes = 0;

  for (const track of tracks) {
    const blob = getBlob ? await getBlob(track) : null;
    const changedSince = effectiveUpdatedAt(track) > since;
    const includeAudio = !!blob && (!incremental || changedSince);
    const meta = packageTrackMeta(track, includeAudio);
    if (!meta) continue;
    metas.push(meta);
    if (includeAudio) {
      const name = audioFileName(meta);
      entries.push({ name, blob });
      audioCount++;
      totalBytes += blob.size || 0;
      const cover = getCoverBlob ? await getCoverBlob(track) : null;
      if (cover) {
        entries.push({ name: coverFileName(meta, cover), blob: cover });
        totalBytes += cover.size || 0;
      }
    }
  }

  const meta = {
    kind: SYNC_KIND,
    version: SYNC_PACKAGE_VERSION,
    app: 'reproductor-de-musica',
    deviceId,
    exportedAt,
    incremental,
    since: since || 0,
    tracks: metas,
    playlists: Array.isArray(state.playlists) ? state.playlists : [],
    customSmart: Array.isArray(state.customSmart) ? state.customSmart : [],
    queue: Array.isArray(state.queue) ? state.queue : [],
    history: Array.isArray(state.history) ? state.history : [],
    counts: (state.counts && typeof state.counts === 'object') ? state.counts : {},
    statsLog: Array.isArray(state.statsLog) ? state.statsLog : [],
    profiles: (state.profiles && typeof state.profiles === 'object') ? state.profiles : null,
    settings: (state.settings && typeof state.settings === 'object') ? state.settings : null,
    stateUpdatedAt: (typeof state.stateUpdatedAt === 'number') ? state.stateUpdatedAt : 0,
    seriesSpeed: (state.seriesSpeed && typeof state.seriesSpeed === 'object') ? state.seriesSpeed : {},
    lyrics: (state.lyrics && typeof state.lyrics === 'object') ? state.lyrics : {},
    deletions: Array.isArray(state.deletions) ? state.deletions : [],
  };
  const check = validatePackage(meta);
  if (!check.ok) throw new Error('No se pudo construir el paquete: ' + check.errors.join(' '));

  const manifest = {
    ...buildManifest({ deviceId, trackCount: metas.length, audioCount, totalBytes }),
    incremental,
    since: since || 0,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  totalBytes += metaBytes.length + manifestBytes.length;
  manifest.totalBytes = totalBytes;
  entries.unshift({ name: META_NAME, data: metaBytes });
  entries.unshift({ name: MANIFEST_NAME, data: new TextEncoder().encode(JSON.stringify(manifest)) });

  const blob = await buildZipBlob(entries);
  return { blob, fileName: packageFileName(now), manifest, meta, audioCount, totalBytes };
}

// ---------- Lectura ----------

function parseJsonEntry(entry, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(entry.data));
  } catch (e) {
    throw new Error('El archivo ' + label + ' del paquete no es JSON válido.');
  }
}

/**
 * Lee un .rpmbak (Blob, ArrayBuffer o Uint8Array) y devuelve
 * { manifest, meta, audios, covers, warnings }.
 * audios/covers son Map<clave, Uint8Array> (clave = audioHash o id).
 * Lanza un Error con mensaje en español si el paquete no es válido.
 */
export async function readSyncPackage(input) {
  const entries = await readZipStore(input);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get(MANIFEST_NAME);
  const metaEntry = byName.get(META_NAME);
  if (!manifestEntry) throw new Error('El paquete no trae manifest.json: no es un paquete de sync.');
  if (!metaEntry) throw new Error('El paquete no trae meta.json: no es un paquete de sync.');
  const manifest = parseJsonEntry(manifestEntry, 'manifest.json');
  const meta = parseJsonEntry(metaEntry, 'meta.json');
  if (manifest.kind !== SYNC_KIND || manifest.version !== SYNC_PACKAGE_VERSION) {
    throw new Error('El manifiesto del paquete no es de este reproductor o su versión no es compatible.');
  }
  const check = validatePackage(meta);
  if (!check.ok) throw new Error('El paquete no es válido: ' + check.errors.join(' '));
  if (manifest.deviceId && meta.deviceId && manifest.deviceId !== meta.deviceId) {
    throw new Error('El manifiesto y los metadatos del paquete dicen venir de dispositivos distintos.');
  }

  const audios = new Map();
  const covers = new Map();
  const warnings = [];
  for (const e of entries) {
    if (e.name.startsWith(COVER_DIR)) {
      const base = e.name.slice(COVER_DIR.length).replace(/\.[A-Za-z0-9]{1,5}$/, '');
      if (base) covers.set(base, e.data);
    } else if (e.name.startsWith(AUDIO_DIR)) {
      const base = e.name.slice(AUDIO_DIR.length).replace(/\.[A-Za-z0-9]{1,5}$/, '');
      if (base) audios.set(base, e.data);
    } else if (e.name !== MANIFEST_NAME && e.name !== META_NAME) {
      warnings.push('Entrada ignorada en el paquete: ' + e.name);
    }
  }
  return { manifest, meta, audios, covers, warnings };
}

/** Audio (Uint8Array) de una pista dentro de un paquete leído, o null. */
export function audioForTrack(metaTrack, audios) {
  if (!metaTrack || !audios) return null;
  const key = audioKeyFor(metaTrack);
  if (key && audios.has(key)) return audios.get(key);
  if (metaTrack.id && audios.has(metaTrack.id)) return audios.get(metaTrack.id);
  return null;
}

export function coverForTrack(metaTrack, covers) {
  if (!metaTrack || !covers) return null;
  const key = audioKeyFor(metaTrack);
  if (key && covers.has(key)) return covers.get(key);
  if (metaTrack.id && covers.has(metaTrack.id)) return covers.get(metaTrack.id);
  return null;
}

// ---------- Vista previa (fusión en memoria, sin aplicar nada) ----------

/**
 * Fusiona el estado local con el de un paquete ya leído, en memoria.
 * localState: { tracks, playlists, customSmart, queue, history,
 *   counts, statsLog, profiles, settings, stateUpdatedAt, lastSyncAt }.
 * remote: lo que devuelve readSyncPackage(). confirmDeletions debe
 *   ser false aquí (la UI lo pone a true solo tras la confirmación).
 * Devuelve { merged, report, summary } con el informe de sync-core.
 */
export function previewMerge(localState, remote, opts = {}) {
  const remoteTracks = (remote.meta.tracks || []).map((t) => ({ ...t }));
  // hasAudio real: solo cuenta el audio que de verdad trae el paquete
  // o el que ya existe en este dispositivo. Si no lo trae nadie, la
  // pista remota nueva queda pendiente de audio (ver sync-core.js).
  const localByKey = new Map();
  (localState.tracks || []).forEach((t) => {
    const k = trackKey(t);
    if (k) localByKey.set(k, t);
  });
  remoteTracks.forEach((t) => {
    const inPackage = !!audioForTrack(t, remote.audios);
    const inLocal = localByKey.has(trackKey(t));
    t.hasAudio = inPackage || inLocal;
  });
  const remoteState = {
    ...remote.meta,
    tracks: remoteTracks,
    profiles: remote.meta.profiles && Array.isArray(remote.meta.profiles.list)
      ? remote.meta.profiles.list : remote.meta.profiles,
  };
  const merged = mergeState(localState || {}, remoteState, {
    confirmDeletions: opts.confirmDeletions === true,
    remoteDeletions: remote.meta.deletions || [],
  });
  return { merged, report: merged.report, summary: summarizeMerge(merged.report) };
}

// ---------- Plan de aplicación (puro; el cableado lo ejecuta) ----------

/**
 * Convierte una fusión ya confirmada en operaciones concretas.
 * mergedTracks: merged.tracks de previewMerge (con confirmDeletions
 *   ya aplicado). localByKey: Map<trackKey, { id, hasAudio }> del
 *   estado local antes de fusionar. audios/covers: mapas del paquete.
 * Devuelve [{ op, ... }] en este orden: borrados, pistas nuevas o
 * actualizadas, y al final { op: 'state', state } con playlists,
 * historial, contadores, ajustes y perfiles fusionados.
 *  - { op:'put', localId, meta, audio: Blob|null, cover: Blob|null,
 *      pendingAudio: bool } — audio null + pendingAudio true = la
 *    pista queda en la biblioteca sin archivo (se re-vincula sola
 *    al re-añadirlo por huella). audio 'keep-local' = conservar el
 *    blob que ya hay en este dispositivo.
 *  - { op:'delete', localId, key }
 * El llamador (db.js / cableado de fase 3) ejecuta las operaciones
 * contra IndexedDB y actualiza lastSyncAt solo si todas terminan.
 */
export function buildApplyOps(merged, localByKey, audios, covers) {
  const ops = [];
  const mergedTracks = merged.tracks || [];
  const mergedByKey = new Map();
  mergedTracks.forEach((m) => { const k = trackKey(m); if (k) mergedByKey.set(k, m); });

  (merged.report.appliedDeletions || []).forEach((key) => {
    const local = localByKey.get(key);
    if (local && local.id) ops.push({ op: 'delete', key, localId: local.id });
  });

  mergedTracks.forEach((m) => {
    const key = trackKey(m);
    if (!key) return;
    const local = localByKey.get(key);
    const remoteAudio = audioForTrack(m, audios);
    const remoteCover = coverForTrack(m, covers);
    if (!local) {
      // Pista nueva: conserva el id remoto (las playlists lo
      // referencian así) salvo colisión con un id local distinto,
      // que el cableado detecta y reescribe antes de escribir.
      ops.push({
        op: 'put', key, localId: m.id, meta: m,
        audio: remoteAudio ? new Blob([remoteAudio], { type: m.type || 'audio/mpeg' }) : null,
        cover: remoteCover ? new Blob([remoteCover], { type: 'image/jpeg' }) : null,
        pendingAudio: !remoteAudio,
      });
    } else if ((merged.report.updated || []).includes(key)) {
      ops.push({
        op: 'put', key, localId: local.id, meta: { ...m, id: local.id },
        audio: remoteAudio ? new Blob([remoteAudio], { type: m.type || local.type || 'audio/mpeg' }) : 'keep-local',
        cover: remoteCover ? new Blob([remoteCover], { type: 'image/jpeg' }) : 'keep-local',
        pendingAudio: !remoteAudio && !local.hasAudio,
      });
    }
    // Sin cambios: no hay operación (la pista queda como está).
  });

  ops.push({
    op: 'state',
    state: {
      playlists: merged.playlists,
      queue: merged.queue,
      history: merged.history,
      counts: merged.counts,
      statsLog: merged.statsLog,
      customSmart: merged.customSmart,
      settings: merged.settings,
      settingsConflict: merged.settingsConflict,
      profiles: merged.profiles,
      seriesSpeed: merged.seriesSpeed,
    },
  });
  return ops;
}
