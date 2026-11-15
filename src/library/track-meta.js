/**
 * track-meta.js — 3.0.0, fase 1
 *
 * EXTRAÍDO de index.html v2.9.1 (sin cambiar su comportamiento):
 *  - La proyección de metadatos por canción que usa exportBackup()
 *    (index.html, ~líneas 6438-6470): es exactamente lo que el respaldo
 *    JSON v10 guarda por pista, sin el audio.
 *  - Las reglas de saneado que usa loadLibrary() al leer de IndexedDB
 *    (~líneas 3010-3050): rating solo like/dislike, estrellas 0-3, etc.
 *
 * Este módulo es PURO: no toca el DOM ni IndexedDB, por eso se puede
 * probar con Node. Es la base de la sincronización: una canción se
 * identifica y se compara por sus metadatos, nunca por su blob.
 *
 * Novedad 3.0.0: `updatedAt` (milisegundos, Date.now()).
 *  - En 2.9.1 las pistas NO tienen updatedAt; la migración a DB v3 lo
 *    rellena con `addedAt` (ver PLAN-3.0.0.md, §5).
 *  - Hasta que la app lo escriba, updatedAt cae a addedAt y el sync
 *    sigue funcionando, solo con menos precisión en los conflictos.
 */

// Campos que viajan en un respaldo / paquete de sync por cada canción.
// Copia fiel de la proyección de exportBackup() en 2.9.1, más updatedAt.
export const TRACK_META_FIELDS = [
  'id', 'name', 'rating', 'title', 'artist', 'album',
  'normDb', 'volAdj', 'abLoop', 'bookmarks', 'silence',
  'genre', 'year', 'tags', 'memSpeed', 'memEq',
  'bpm', 'bpmManual', 'audioHash', 'stars', 'kind',
  'energy', 'brightness', 'mood', 'musicalKey', 'keyName',
  'isAudiobook', 'abPos', 'chapters', 'peaks',
  'trackNo', 'sampleRate', 'channels',
  // 3.0.0:
  'updatedAt',
];

const NUM_OR_NULL = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Identidad estable de una canción entre dispositivos.
 * 1) audioHash (huella de la grabación, ya existe en 2.9.1) si la hay:
 *    el mismo archivo en otro dispositivo es LA MISMA canción aunque
 *    tenga otro id local (los id son 't' + fecha + azar, distintos por
 *    dispositivo) o esté en otra carpeta.
 * 2) Sin huella: nombre + tamaño (+ duración redondeada si la hay).
 * Nunca se usa solo el id local como identidad de sync.
 */
export function trackKey(track) {
  if (!track || typeof track !== 'object') return null;
  if (typeof track.audioHash === 'string' && track.audioHash) {
    return 'hash:' + track.audioHash;
  }
  const name = typeof track.name === 'string' ? track.name : '';
  const size = typeof track.size === 'number' ? track.size : 0;
  const dur = typeof track.duration === 'number' && track.duration > 0
    ? Math.round(track.duration) : 0;
  if (!name && !size) return null;
  return 'file:' + name + '|' + size + '|' + dur;
}

/**
 * Proyección de una pista a solo metadatos (extraída de exportBackup()).
 * Quita a propósito: blob, url (object URL de la sesión), coverUrl y
 * coverBlob. El audio y la portada viajan aparte en el paquete, por
 * archivos, nunca dentro del JSON.
 */
export function trackMetaForExport(track) {
  if (!track || typeof track !== 'object') return null;
  return {
    id: track.id,
    name: track.name,
    rating: (track.rating === 'like' || track.rating === 'dislike') ? track.rating : null,
    title: track.title,
    artist: track.artist,
    album: track.album,
    normDb: NUM_OR_NULL(track.normDb),
    volAdj: NUM_OR_NULL(track.volAdj) ?? 0,
    abLoop: track.abLoop || null,
    bookmarks: Array.isArray(track.bookmarks) ? track.bookmarks : [],
    silence: track.silence || null,
    genre: track.genre || '',
    year: track.year || '',
    tags: Array.isArray(track.tags) ? track.tags : [],
    memSpeed: NUM_OR_NULL(track.memSpeed),
    memEq: Array.isArray(track.memEq) ? track.memEq : null,
    bpm: NUM_OR_NULL(track.bpm),
    bpmManual: !!track.bpmManual,
    audioHash: (typeof track.audioHash === 'string' && track.audioHash) ? track.audioHash : null,
    stars: clampStars(track.stars),
    kind: track.kind === 'video' ? 'video' : 'audio',
    energy: NUM_OR_NULL(track.energy),
    brightness: NUM_OR_NULL(track.brightness),
    mood: track.mood || null,
    musicalKey: track.musicalKey || null,
    keyName: track.keyName || null,
    isAudiobook: !!track.isAudiobook,
    abPos: NUM_OR_NULL(track.abPos) ?? 0,
    chapters: (Array.isArray(track.chapters) && track.chapters.length) ? track.chapters : null,
    peaks: Array.isArray(track.peaks) ? track.peaks : null,
    trackNo: NUM_OR_NULL(track.trackNo),
    sampleRate: NUM_OR_NULL(track.sampleRate),
    channels: NUM_OR_NULL(track.channels),
    // 3.0.0: marca de último cambio; sin ella se usa addedAt (ver effectiveUpdatedAt).
    updatedAt: effectiveUpdatedAt(track),
  };
}

/** Estrellas 0-3, igual que clampStars() de index.html. */
export function clampStars(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 3) return 3;
  return n;
}

/** Último cambio de una pista; en datos 2.9.1 sin updatedAt, cae a addedAt. */
export function effectiveUpdatedAt(track) {
  if (track && typeof track.updatedAt === 'number' && Number.isFinite(track.updatedAt)) {
    return track.updatedAt;
  }
  if (track && typeof track.addedAt === 'number' && Number.isFinite(track.addedAt)) {
    return track.addedAt;
  }
  return 0;
}

/** Copia de una pista con updatedAt = now. Lo usará la app al guardar
 *  cualquier cambio por canción (idbPatch / idbPatchSoon) en la 3.0.0. */
export function touchTrack(track, now = Date.now()) {
  return { ...track, updatedAt: now };
}

/** Saneado de metadatos que llegan de otro dispositivo (reglas de
 *  loadLibrary() en 2.9.1, adaptadas). Devuelve null si no es una pista válida. */
export function normalizeTrackMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const meta = trackMetaForExport(raw);
  // trackMetaForExport ya sanea rating/estrellas/tipo; aquí solo se
  // refuerzan los campos que la UI usa para ordenar y filtrar.
  meta.title = typeof meta.title === 'string' && meta.title ? meta.title : meta.name;
  meta.artist = typeof meta.artist === 'string' ? meta.artist : '';
  meta.album = typeof meta.album === 'string' ? meta.album : '';
  if (meta.mood !== null && !['fiesta', 'relajado', 'energia', 'concentracion'].includes(meta.mood)) {
    meta.mood = null;
  }
  if (meta.musicalKey !== null && !/^\d{1,2}[AB]$/.test(meta.musicalKey)) meta.musicalKey = null;
  return meta;
}

/** ¿Tiene este objeto la forma mínima de una pista sincronizable? */
export function isValidTrackMeta(raw) {
  return normalizeTrackMeta(raw) !== null;
}
