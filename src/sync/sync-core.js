/**
 * sync-core.js — 3.0.0, fase 1
 *
 * Motor de fusión de la sincronización del reproductor. PURO: no toca
 * el DOM, ni IndexedDB, ni la red. Recibe estados locales y remotos
 * (metadatos + banderas de audio) y devuelve el estado fusionado y un
 * informe de qué cambió, para que la UI lo muestre ANTES de aplicar
 * nada. Se prueba con Node (ver test/sync-core.test.mjs).
 *
 * Diseño completo en PLAN-3.0.0.md. Reglas que implementa:
 *  1. Identidad por audioHash (o nombre+tamaño), nunca por id local.
 *  2. Último cambio gana POR CANCIÓN (updatedAt; sin él, addedAt).
 *  3. Nada se borra sin avisar: los borrados son "tumbas" (tombstones)
 *     y solo se aplican con confirmación explícita del usuario.
 *  4. Una canción sin audio en ningún lado NO se pierde: queda como
 *     "pendiente de audio" y se re-vincula al re-añadir el archivo.
 *  5. Empate de updatedAt con metadatos distintos = conflicto: gana
 *     lo local y queda registrado, nunca se elige en silencio.
 */
import { trackKey, normalizeTrackMeta, effectiveUpdatedAt } from '../library/track-meta.js';

export const SYNC_KIND = 'reproductor-sync';
export const SYNC_PACKAGE_VERSION = 1;
/** Extensión del paquete completo de sync (ZIP, ver PLAN §3). */
export const SYNC_PACKAGE_EXT = '.rpmbak';

/** Un paquete válido: metadatos + estado, con su manifiesto. */
export function validatePackage(pkg) {
  const errors = [];
  if (!pkg || typeof pkg !== 'object') errors.push('El paquete no es un objeto.');
  else {
    if (pkg.kind !== SYNC_KIND) errors.push('kind incorrecto: se esperaba "' + SYNC_KIND + '".');
    if (pkg.version !== SYNC_PACKAGE_VERSION) errors.push('version no soportada: ' + pkg.version + '.');
    if (!pkg.deviceId || typeof pkg.deviceId !== 'string') errors.push('Falta deviceId.');
    if (!pkg.exportedAt || Number.isNaN(Date.parse(pkg.exportedAt))) errors.push('exportedAt inválido.');
    if (!Array.isArray(pkg.tracks)) errors.push('tracks debe ser una lista.');
    else {
      pkg.tracks.forEach((t, i) => {
        if (!normalizeTrackMeta(t)) errors.push('tracks[' + i + '] no es una pista válida.');
      });
    }
    if (pkg.state && typeof pkg.state !== 'object') errors.push('state debe ser un objeto.');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Fusiona pistas locales con remotas.
 * localTracks / remoteTracks: metadatos (trackMetaForExport). Cada
 * metadato remoto puede llevar `hasAudio: true/false` (¿el paquete
 * trae el blob de esa canción?). Lo local se asume con audio si la
 * pista existe en la biblioteca (el llamador pasa hasAudio si lo sabe).
 * opts: { now, confirmDeletions, remoteDeletions: [{key, deletedAt}] }
 */
export function mergeTracks(localTracks, remoteTracks, opts = {}) {
  const now = opts.now || Date.now();
  const byKey = new Map();
  const merged = [];
  const result = {
    tracks: merged, added: [], updated: [], unchanged: [],
    conflicts: [], pendingAudio: [], skippedDeletions: [], appliedDeletions: [],
  };

  (localTracks || []).forEach((raw) => {
    const meta = normalizeTrackMeta(raw);
    if (!meta) return;
    const key = trackKey(meta);
    if (!key) return;
    // Fase 3: una pista local pendiente de audio (hasAudio: false,
    // importada antes sin su archivo) no se marca como si lo tuviera.
    // Sin el campo, se asume que sí (comportamiento de la fase 1).
    const entry = { meta, key, hasAudio: raw.hasAudio !== false };
    byKey.set(key, entry);
    merged.push(entry);
  });

  (remoteTracks || []).forEach((raw) => {
    const meta = normalizeTrackMeta(raw);
    if (!meta) return;
    const key = trackKey(meta);
    if (!key) return;
    const hasAudio = raw.hasAudio !== false; // el paquete dice si trae el audio
    const local = byKey.get(key);
    if (!local) {
      const entry = { meta: { ...meta, updatedAt: effectiveUpdatedAt(meta) }, key, hasAudio };
      byKey.set(key, entry);
      merged.push(entry);
      result.added.push(key);
      if (!hasAudio) result.pendingAudio.push(key);
      return;
    }
    const localAt = effectiveUpdatedAt(local.meta);
    const remoteAt = effectiveUpdatedAt(meta);
    if (remoteAt > localAt) {
      // Gana lo remoto, pero el audio local NO se pierde: si el paquete
      // no trae el blob, la pista queda con el blob local.
      const keepAudio = local.hasAudio;
      local.meta = { ...meta, updatedAt: remoteAt };
      local.hasAudio = keepAudio || hasAudio;
      result.updated.push(key);
      if (!local.hasAudio) result.pendingAudio.push(key);
    } else if (remoteAt === localAt && JSON.stringify(stripVolatile(meta)) !== JSON.stringify(stripVolatile(local.meta))) {
      result.conflicts.push({ key, kept: 'local', localAt, remoteAt });
      result.unchanged.push(key);
      // Fase 3: en conflicto también puede quedar pendiente de audio
      // si ningún lado trae el archivo (antes solo se marcaba en la
      // rama sin conflicto).
      if (!local.hasAudio && !hasAudio) result.pendingAudio.push(key);
    } else {
      result.unchanged.push(key);
      if (!local.hasAudio && !hasAudio) result.pendingAudio.push(key);
    }
  });

  // Borrados: solo con confirmación y solo si el borrado es más nuevo
  // que el último cambio de la pista. Si no, se informa y se conserva.
  (opts.remoteDeletions || []).forEach((del) => {
    const entry = byKey.get(del.key);
    if (!entry) return; // ya no existe aquí: nada que hacer
    const localAt = effectiveUpdatedAt(entry.meta);
    if (del.deletedAt > localAt && opts.confirmDeletions === true) {
      const idx = merged.indexOf(entry);
      if (idx >= 0) merged.splice(idx, 1);
      byKey.delete(del.key);
      result.appliedDeletions.push(del.key);
    } else {
      result.skippedDeletions.push({ key: del.key, deletedAt: del.deletedAt, localAt });
    }
  });

  result.tracks = merged.map((e) => e.meta);
  void now;
  return result;
}

/** Quita updatedAt de la comparación de igualdad (ya se comparó aparte). */
function stripVolatile(meta) {
  const copy = { ...meta };
  delete copy.updatedAt;
  return copy;
}

/**
 * Fusiona playlists: unión por id; los trackIds se unen (primero los
 * locales en su orden, luego los nuevos remotos); el nombre lo decide
 * el updatedAt más nuevo (las playlists 2.9.1 no lo tienen: en ese
 * caso gana lo local y se unen solo las canciones).
 */
export function mergePlaylists(localPlaylists, remotePlaylists) {
  const byId = new Map();
  const merged = [];
  (localPlaylists || []).forEach((p) => {
    if (!p || !p.id || !Array.isArray(p.trackIds)) return;
    const copy = { ...p, trackIds: [...p.trackIds] };
    byId.set(p.id, copy);
    merged.push(copy);
  });
  (remotePlaylists || []).forEach((p) => {
    if (!p || !p.id || !Array.isArray(p.trackIds)) return;
    const local = byId.get(p.id);
    if (!local) {
      const copy = { ...p, trackIds: [...p.trackIds] };
      byId.set(p.id, copy);
      merged.push(copy);
      return;
    }
    const remoteAt = typeof p.updatedAt === 'number' ? p.updatedAt : 0;
    const localAt = typeof local.updatedAt === 'number' ? local.updatedAt : 0;
    if (remoteAt > localAt && typeof p.name === 'string' && p.name) local.name = p.name;
    p.trackIds.forEach((id) => { if (!local.trackIds.includes(id)) local.trackIds.push(id); });
  });
  return merged;
}

/** Historial: unión sin duplicados (misma canción + mismo instante),
 *  más reciente primero, tope 100 como en 2.9.1. */
export function mergeHistory(localHistory, remoteHistory, cap = 100) {
  const seen = new Set();
  const merged = [];
  const all = [...(localHistory || []), ...(remoteHistory || [])];
  all.forEach((h) => {
    if (!h || typeof h !== 'object') return;
    const stamp = h.at ?? h.time ?? h.playedAt ?? h.date ?? '';
    const k = String(h.id ?? '') + '|' + String(stamp);
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(h);
  });
  merged.sort((a, b) => {
    const ta = a.at ?? a.time ?? a.playedAt ?? a.date ?? 0;
    const tb = b.at ?? b.time ?? b.playedAt ?? b.date ?? 0;
    return (tb || 0) - (ta || 0);
  });
  return merged.slice(0, cap);
}

/** Contadores de reproducciones: gana el mayor por canción. */
export function mergeCounts(localCounts, remoteCounts) {
  const out = { ...(localCounts || {}) };
  Object.keys(remoteCounts || {}).forEach((id) => {
    const r = Number(remoteCounts[id]) || 0;
    const l = Number(out[id]) || 0;
    out[id] = Math.max(l, r);
  });
  return out;
}

/**
 * Unión genérica por id para listas sin canciones (listas inteligentes,
 * perfiles): no se inventan campos; el nombre lo decide el updatedAt
 * más nuevo y el resto de campos se conserva del lado ganador.
 */
export function mergeById(localList, remoteList) {
  const byId = new Map();
  const merged = [];
  (localList || []).forEach((item) => {
    if (!item || !item.id) return;
    const copy = { ...item };
    byId.set(item.id, copy);
    merged.push(copy);
  });
  (remoteList || []).forEach((item) => {
    if (!item || !item.id) return;
    const local = byId.get(item.id);
    if (!local) {
      const copy = { ...item };
      byId.set(item.id, copy);
      merged.push(copy);
      return;
    }
    const remoteAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
    const localAt = typeof local.updatedAt === 'number' ? local.updatedAt : 0;
    if (remoteAt > localAt) {
      Object.keys(item).forEach((k) => { local[k] = item[k]; });
    }
  });
  return merged;
}

/**
 * Fusión completa de estados (packState): pistas, playlists, historial,
 * contadores, listas inteligentes, perfiles y ajustes.
 * Ajustes: último estado gana COMPLETO (por stateUpdatedAt); si los dos
 * lados cambiaron desde el último sync y no hay marca de tiempo, se
 * conserva lo local y se reporta el conflicto para que el usuario elija.
 */
export function mergeState(localState, remoteState, opts = {}) {
  const local = localState || {};
  const remote = remoteState || {};
  const tracks = mergeTracks(local.tracks || [], remote.tracks || [], opts);
  const settingsConflict =
    (typeof local.stateUpdatedAt === 'number' && typeof remote.stateUpdatedAt === 'number' &&
      local.stateUpdatedAt !== remote.stateUpdatedAt &&
      typeof local.lastSyncAt === 'number' && typeof remote.lastSyncAt === 'number' &&
      local.stateUpdatedAt > local.lastSyncAt && remote.stateUpdatedAt > remote.lastSyncAt);
  let settings = local.settings || {};
  if (remote.settings) {
    if (typeof remote.stateUpdatedAt === 'number' && typeof local.stateUpdatedAt === 'number') {
      if (remote.stateUpdatedAt > local.stateUpdatedAt) settings = remote.settings;
    } else if (!local.settings) {
      settings = remote.settings;
    }
  }
  const customSmart = mergeById(local.customSmart, remote.customSmart);
  return {
    tracks: tracks.tracks,
    playlists: mergePlaylists(local.playlists, remote.playlists),
    queue: local.queue || [],
    history: mergeHistory(local.history, remote.history),
    counts: mergeCounts(local.counts, remote.counts),
    statsLog: mergeHistory(local.statsLog, remote.statsLog, 1500),
    customSmart,
    settings,
    settingsConflict,
    profiles: mergeById(local.profiles, remote.profiles)
      .map((p) => ({ id: p.id, name: p.name })),
    seriesSpeed: { ...(remote.seriesSpeed || {}), ...(local.seriesSpeed || {}) },
    report: {
      addedTracks: tracks.added.length,
      updatedTracks: tracks.updated.length,
      // Fase 2: buildApplyOps necesita las CLAVES, no solo los
      // contadores, para saber qué pistas escribir en IndexedDB.
      added: tracks.added,
      updated: tracks.updated,
      conflicts: tracks.conflicts,
      pendingAudio: tracks.pendingAudio,
      skippedDeletions: tracks.skippedDeletions,
      appliedDeletions: tracks.appliedDeletions,
    },
  };
}

/** Manifiesto del paquete .rpmbak (el ZIP lleva manifest.json + meta.json
 *  + audios/<clave>.<ext>). deviceId lo genera quien exporta
 *  (crypto.randomUUID) y se guarda en localStorage, nunca se inventa aquí. */
export function buildManifest({ deviceId, trackCount, audioCount, totalBytes }) {
  return {
    kind: SYNC_KIND,
    version: SYNC_PACKAGE_VERSION,
    app: 'reproductor-de-musica',
    exportedAt: new Date().toISOString(),
    deviceId,
    trackCount: trackCount || 0,
    audioCount: audioCount || 0,
    totalBytes: totalBytes || 0,
  };
}

/** Resumen en español para la pantalla de confirmación antes de aplicar. */
export function summarizeMerge(report) {
  const lines = [];
  lines.push(`${report.addedTracks} canciones nuevas, ${report.updatedTracks} actualizadas.`);
  if (report.pendingAudio.length) {
    lines.push(`${report.pendingAudio.length} quedan pendientes de audio: están en la lista pero sin archivo en ningún dispositivo; re-añade el archivo y se vinculan solas.`);
  }
  if (report.conflicts.length) {
    lines.push(`${report.conflicts.length} conflictos con la misma fecha de cambio: se conservó lo de este dispositivo.`);
  }
  if (report.skippedDeletions.length) {
    lines.push(`${report.skippedDeletions.length} borrados del otro dispositivo NO se aplicaron para no perder nada.`);
  }
  if (report.appliedDeletions.length) {
    lines.push(`${report.appliedDeletions.length} borrados confirmados y aplicados.`);
  }
  return lines;
}
