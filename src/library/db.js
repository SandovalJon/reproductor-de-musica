/**
 * db.js — 3.0.0, fase 2
 *
 * Capa de datos del reproductor, extraída de index.html v2.9.1
 * (sección IndexedDB, ~líneas 2465-2660, y `idbPatch`/`idbPatchSoon`,
 * ~5868 y ~7532), con la migración a DB v3.
 *
 * Nombres, almacenes y comportamiento de la v2.9.1 se conservan
 * exactos: DB 'reproductor-musica-local', almacenes 'tracks'
 * (keyPath 'id') y 'meta' (keyPath 'key'). La 2.9.1 sigue leyendo
 * una DB v3: los campos nuevos se ignoran, así que volver atrás
 * es posible.
 *
 * Novedad 3.0.0 — migración v2 → v3 (ver PLAN-3.0.0.md, §5):
 *  - Cada pista gana `updatedAt` (= `addedAt` si no lo tenía).
 *  - Cada playlist gana `updatedAt` (momento de la migración).
 *  - En `meta` aparece `syncMeta`: { deviceId, lastSyncAt,
 *    stateUpdatedAt, deletions: [{ key, deletedAt }] }.
 *  - Nada se borra en la migración.
 *
 * Regla de escritura de `updatedAt` (diseño de la fase 2, para el
 * cableado de la fase 3): todo cambio por canción pasa por
 * `patchTrack()` / `patchTrackSoon()`, que estampan `updatedAt`
 * automáticamente. `idbPatch()` queda como primitiva interna: no
 * se llama directamente desde el código nuevo. Los borrados reales
 * se registran con `recordDeletion()` ANTES de `idbDelete()`; el
 * punto de enganche en index.html es `commitPendingDelete()`
 * (~línea 9220, donde hoy se llama a `idbDelete(entry.id)` tras
 * los 8 segundos de deshacer).
 *
 * Las funciones puras de migración se prueban con Node
 * (test/db-migration.test.mjs). `openDB()` y los helpers de
 * IndexedDB solo existen en el navegador: en Node, `indexedDB`
 * no está definido y `openDB()` rechaza, como la v2.9.1.
 */

export const DB_NAME = 'reproductor-musica-local';
export const DB_VER = 3;
export const DB_VER_PREV = 2;
export const STORE = 'tracks';
export const META = 'meta';
export const SYNC_META_KEY = 'syncMeta';
export const PACK_STATE_KEY = 'packState';
/** Tumbas de borrado que se conservan por dispositivo (las más nuevas). */
export const MAX_DELETIONS = 500;

// ---------- Migración v2 → v3 (pura, probada con Node) ----------

/** syncMeta vacío, con los tipos que el resto del código espera. */
export function defaultSyncMeta() {
  return { deviceId: null, lastSyncAt: 0, stateUpdatedAt: 0, deletions: [] };
}

/**
 * Migra un registro de pista v2 a v3. No toca nada más: si ya tiene
 * un updatedAt válido, se conserva (la migración es idempotente).
 * Devuelve { record, changed }.
 */
export function migrateTrackRecord(rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return { record: rec, changed: false };
  if (typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt)) {
    return { record: rec, changed: false };
  }
  const addedAt = (typeof rec.addedAt === 'number' && Number.isFinite(rec.addedAt))
    ? rec.addedAt : now;
  return { record: { ...rec, updatedAt: addedAt }, changed: true };
}

/**
 * Migra el packState v2 a v3: playlists con updatedAt y syncMeta.
 * Devuelve { state, changed }. Un packState vacío o ausente se
 * convierte en el mínimo válido (la app 2.9.1 lo rellena igual).
 */
export function migratePackState(state, now = Date.now()) {
  const s = (state && typeof state === 'object') ? { ...state } : {};
  let changed = false;
  if (Array.isArray(s.playlists)) {
    s.playlists = s.playlists.map((p) => {
      if (!p || typeof p !== 'object') return p;
      if (typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt)) return p;
      changed = true;
      return { ...p, updatedAt: now };
    });
  }
  if (!s.syncMeta || typeof s.syncMeta !== 'object') {
    s.syncMeta = defaultSyncMeta();
    changed = true;
  } else {
    const m = { ...defaultSyncMeta(), ...s.syncMeta };
    if (!Array.isArray(m.deletions)) m.deletions = [];
    if (JSON.stringify(m) !== JSON.stringify(s.syncMeta)) changed = true;
    s.syncMeta = m;
  }
  return { state: s, changed };
}

/** Conserva solo las tumbas más nuevas, hasta MAX_DELETIONS. */
export function pruneDeletions(deletions, limit = MAX_DELETIONS) {
  const list = (Array.isArray(deletions) ? deletions : [])
    .filter((d) => d && typeof d.key === 'string' && typeof d.deletedAt === 'number')
    .sort((a, b) => b.deletedAt - a.deletedAt);
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push({ key: d.key, deletedAt: d.deletedAt });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Añade (o actualiza, si ya existía con fecha más vieja) la tumba
 * de una canción borrada. Pura: no escribe en IndexedDB.
 */
export function recordDeletionInMeta(syncMeta, key, deletedAt = Date.now()) {
  const meta = { ...defaultSyncMeta(), ...(syncMeta || {}) };
  const rest = (meta.deletions || []).filter((d) => d.key !== key);
  rest.push({ key, deletedAt });
  meta.deletions = pruneDeletions(rest);
  return meta;
}

// ---------- IndexedDB (navegador; extraído de index.html v2.9.1) ----------

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function () {
      const db = req.result;
      const oldVersion = req.oldVersion || 0;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      // Migración v2 → v3: se hace dentro de la transacción de
      // actualización, con los almacenes que ya existen. Es idempotente:
      // volver a abrir no cambia nada que ya tenga updatedAt.
      if (oldVersion < 3) {
        try {
          const tx = req.transaction;
          const trackStore = tx.objectStore(STORE);
          const allReq = trackStore.getAll();
          allReq.onsuccess = function () {
            (allReq.result || []).forEach((rec) => {
              const { record, changed } = migrateTrackRecord(rec);
              if (changed) trackStore.put(record);
            });
          };
          const metaStore = tx.objectStore(META);
          const stateReq = metaStore.get(PACK_STATE_KEY);
          stateReq.onsuccess = function () {
            const row = stateReq.result;
            const { state, changed } = migratePackState(row ? row.value : null);
            if (changed) metaStore.put({ key: PACK_STATE_KEY, value: state });
          };
        } catch (e) { /* la migración no debe impedir abrir la DB */ }
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return dbPromise;
}

function idbMetaGet(key) {
  return openDB().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get(key);
      req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
      req.onerror = function () { resolve(null); };
    } catch (e) { resolve(null); }
  })).catch(() => null);
}

function idbMetaSet(key, value) {
  return openDB().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(META, 'readwrite');
      tx.objectStore(META).put({ key, value });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    } catch (e) { resolve(); }
  })).catch(() => {});
}

function idbAll() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  }));
}

function idbPut(rec) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  })).catch(() => { /* almacenamiento lleno / no disponible */ });
}

function idbDelete(id) {
  return openDB().then((db) => new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { resolve(); };
  })).catch(() => {});
}

function idbGet(id) {
  return openDB().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { resolve(null); };
    } catch (e) { resolve(null); }
  })).catch(() => null);
}

/**
 * Primitiva interna (igual que en v2.9.1): aplica campos a un
 * registro sin tocar updatedAt. El código nuevo NO la llama
 * directamente: usa patchTrack() / patchTrackSoon().
 */
function idbPatch(id, fields) {
  return openDB().then((db) => new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = function () {
        const rec = getReq.result;
        if (rec) {
          Object.keys(fields).forEach((k) => { rec[k] = fields[k]; });
          store.put(rec);
        }
      };
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    } catch (e) { resolve(); }
  })).catch(() => {});
}

// ---------- Escritura con updatedAt (el punto único, 3.0.0) ----------

/**
 * Aplica campos a una pista y estampa updatedAt = now. Es el ÚNICO
 * camino que el código nuevo usa para cambiar una pista: así el
 * sync sabe siempre cuándo cambió cada canción. `fields` nunca debe
 * traer su propio updatedAt (si lo trae, se ignora y manda `now`).
 */
function patchTrack(id, fields, now = Date.now()) {
  const f = { ...(fields || {}) };
  delete f.updatedAt;
  f.updatedAt = now;
  return idbPatch(id, f);
}

const patchSoonTimers = {};
/** Como idbPatchSoon de la v2.9.1, pero estampando updatedAt al aplicar. */
function patchTrackSoon(id, fields) {
  let slot = patchSoonTimers[id];
  if (!slot) slot = patchSoonTimers[id] = { fields: {}, timer: null };
  Object.keys(fields || {}).forEach((k) => { if (k !== 'updatedAt') slot.fields[k] = fields[k]; });
  clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    const f = slot.fields;
    slot.fields = {};
    patchTrack(id, f);
  }, 450);
}

// ---------- syncMeta: identidad del dispositivo y tumbas ----------

function getSyncMeta() {
  return idbMetaGet(SYNC_META_KEY).then((m) => ({ ...defaultSyncMeta(), ...(m || {}) }));
}

function setSyncMeta(meta) {
  return idbMetaSet(SYNC_META_KEY, { ...defaultSyncMeta(), ...(meta || {}) });
}

function newDeviceId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* cae al generador manual */ }
  return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Devuelve el deviceId de este dispositivo, generándolo y guardándolo
 * la primera vez. Nunca se inventa un id distinto en cada llamada.
 */
async function ensureDeviceId() {
  const meta = await getSyncMeta();
  if (typeof meta.deviceId === 'string' && meta.deviceId) return meta.deviceId;
  meta.deviceId = newDeviceId();
  await setSyncMeta(meta);
  return meta.deviceId;
}

/** Marca el estado (ajustes, playlists…) como cambiado ahora. */
async function touchState(now = Date.now()) {
  const meta = await getSyncMeta();
  meta.stateUpdatedAt = now;
  await setSyncMeta(meta);
  return meta;
}

/** Marca el momento del último sync aplicado/exportado. */
async function markSynced(now = Date.now()) {
  const meta = await getSyncMeta();
  meta.lastSyncAt = now;
  await setSyncMeta(meta);
  return meta;
}

/**
 * Registra el borrado de una canción (por su trackKey, no por su id
 * local) ANTES de borrar el registro. Llamar desde el enganche de
 * commitPendingDelete() en index.html, no desde idbDelete().
 */
async function recordDeletion(key, deletedAt = Date.now()) {
  const meta = await getSyncMeta();
  const next = recordDeletionInMeta(meta, key, deletedAt);
  await setSyncMeta(next);
  return next;
}

export {
  openDB, idbAll, idbPut, idbDelete, idbGet, idbMetaGet, idbMetaSet,
  idbPatch, patchTrack, patchTrackSoon,
  getSyncMeta, setSyncMeta, ensureDeviceId, touchState, markSynced, recordDeletion,
};
