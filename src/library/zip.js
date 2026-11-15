/**
 * zip.js — 3.0.0, fase 2
 *
 * ZIP sin librerías, método *store* (sin compresión), en los dos sentidos.
 *
 * ESCRITOR: extraído de index.html v2.9.1 (`buildZipBlob`, ~líneas
 * 8486-8535), sin cambiar su comportamiento: cabeceras locales +
 * directorio central + EOCD, CRC-32, nombres en UTF-8. La app ya lo
 * usa para exportar playlists; aquí vive como módulo para que el
 * paquete .rpmbak lo reutilice.
 *
 * LECTOR: nuevo en la fase 2. Solo entiende método *store* (0): es
 * todo lo que el escritor produce y todo lo que el paquete de sync
 * necesita. Un ZIP con compresión (método 8, el habitual de otros
 * programas) se rechaza con un error claro, nunca se intenta
 * descomprimir a medias. Verifica el CRC-32 de cada entrada.
 *
 * Módulo PURO salvo `Blob` (disponible en navegador y en Node 18+):
 * no toca el DOM ni IndexedDB. Se prueba con Node (test/zip.test.mjs).
 */

// ---------- CRC-32 (igual que en index.html v2.9.1) ----------

let CRC_TABLE = null;

export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------- Escritor (extraído de index.html v2.9.1) ----------

/**
 * Construye un ZIP *store* a partir de entradas.
 * Cada entrada: { name, blob } (Blob, como en la app) o
 * { name, data } (Uint8Array / ArrayBuffer, cómodo en pruebas).
 * Devuelve un Blob 'application/zip'.
 */
export async function buildZipBlob(entries) {
  const files = [];
  for (const en of entries || []) {
    let data;
    if (en.data) {
      data = en.data instanceof Uint8Array ? en.data : new Uint8Array(en.data);
    } else if (en.blob) {
      data = new Uint8Array(await en.blob.arrayBuffer());
    } else {
      throw new Error('Entrada ZIP sin blob ni data: ' + en.name);
    }
    files.push({ name: en.name, data });
  }
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  const pushBytes = (u) => { chunks.push(u); offset += u.length; };
  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const localOffset = offset;
    pushBytes(new Uint8Array([].concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0))));
    pushBytes(nameBytes);
    pushBytes(f.data);
    central.push({ nameBytes, crc, size, offset: localOffset });
  });
  const centralStart = offset;
  central.forEach((c) => {
    pushBytes(new Uint8Array([].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset))));
    pushBytes(c.nameBytes);
  });
  const centralSize = offset - centralStart;
  pushBytes(new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0))));
  return new Blob(chunks, { type: 'application/zip' });
}

// ---------- Lector (nuevo, fase 2; solo método store) ----------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error('Se esperaba un ArrayBuffer o Uint8Array.');
}

function u16le(view, off) { return view.getUint16(off, true); }
function u32le(view, off) { return view.getUint32(off, true); }

/**
 * Lee un ZIP *store* y devuelve sus entradas en orden:
 * [{ name, data: Uint8Array }].
 * Acepta Blob, ArrayBuffer o Uint8Array.
 * Rechaza: archivos que no son ZIP, ZIP64, entradas comprimidas
 * (método != 0), cabeceras truncadas y CRC que no coincide.
 * No descomprime nada: solo corta los datos tal como están guardados.
 */
export async function readZipStore(input) {
  let bytes;
  if (input && typeof input.arrayBuffer === 'function') {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else {
    bytes = asBytes(input);
  }
  return parseZipStore(bytes);
}

export function parseZipStore(bytes) {
  bytes = asBytes(bytes);
  if (bytes.length < 22) throw new Error('El archivo es demasiado pequeño para ser un ZIP.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD: buscar la firma en los últimos 64 KB + 22 bytes.
  const scanStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (u32le(view, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No es un archivo ZIP válido (no se encontró el final del directorio central).');
  const totalEntries = u16le(view, eocd + 10);
  const cdSize = u32le(view, eocd + 12);
  const cdOffset = u32le(view, eocd + 16);
  if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 no soportado por el lector de sync.');
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new Error('El directorio central del ZIP está truncado.');
  }

  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > bytes.length || u32le(view, p) !== SIG_CENTRAL) {
      throw new Error('El directorio central del ZIP está corrupto (entrada ' + i + ').');
    }
    const flags = u16le(view, p + 8);
    const method = u16le(view, p + 10);
    const crc = u32le(view, p + 16);
    const compSize = u32le(view, p + 20);
    const size = u32le(view, p + 24);
    const nameLen = u16le(view, p + 28);
    const extraLen = u16le(view, p + 30);
    const commentLen = u16le(view, p + 32);
    const localOffset = u32le(view, p + 42);
    if (compSize === 0xFFFFFFFF || size === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      throw new Error('ZIP64 no soportado por el lector de sync.');
    }
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (method !== METHOD_STORE) {
      throw new Error('La entrada "' + name + '" usa compresión (método ' + method +
        '); el paquete de sync solo admite archivos guardados sin comprimir.');
    }
    // Cabecera local: firma + 22 bytes de campos + nombre + extra.
    if (localOffset + 30 > bytes.length || u32le(view, localOffset) !== SIG_LOCAL) {
      throw new Error('La cabecera local de "' + name + '" está corrupta.');
    }
    const localNameLen = u16le(view, localOffset + 26);
    const localExtraLen = u16le(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    // Si la entrada lleva descriptor de datos (bit 3), los tamaños de la
    // cabecera local son 0: se usan los del directorio central.
    void flags;
    if (dataStart + compSize > bytes.length) {
      throw new Error('Los datos de "' + name + '" están truncados.');
    }
    const data = bytes.slice(dataStart, dataStart + compSize);
    if (data.length !== size) {
      throw new Error('El tamaño de "' + name + '" no coincide con el directorio central.');
    }
    if (crc32(data) !== crc) {
      throw new Error('El CRC de "' + name + '" no coincide: el archivo puede estar corrupto.');
    }
    entries.push({ name, data });
  }
  return entries;
}
