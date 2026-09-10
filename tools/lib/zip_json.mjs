import { deflateRawSync, inflateRawSync } from "node:zlib";

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function writeU16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeU32(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.toString("ascii", offset, offset + 4) !== "PK\x05\x06") continue;
    const commentLength = u16(buffer, offset + 20);
    if (offset + 22 + commentLength !== buffer.length) continue;
    return {
      entries: u16(buffer, offset + 10),
      cdOffset: u32(buffer, offset + 16),
    };
  }
  return null;
}

/**
 * Read one JSON file out of a zip buffer by exact path or basename.
 * Supports STORE and DEFLATE, including GitHub artifact zips that set the
 * data-descriptor flag on local headers.
 */
export function extractNamedJsonFromZip(bytes, wantedName) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const eocd = findEocd(buffer);
  if (!eocd) throw new Error("zip end of central directory not found");
  const wanted = String(wantedName).replace(/\\/g, "/");
  const wantedBase = wanted.split("/").pop();
  let offset = eocd.cdOffset;
  for (let index = 0; index < eocd.entries; index += 1) {
    if (buffer.toString("ascii", offset, offset + 4) !== "PK\x01\x02") {
      throw new Error("invalid zip central directory");
    }
    const method = u16(buffer, offset + 10);
    const compressedSize = u32(buffer, offset + 20);
    const nameLen = u16(buffer, offset + 28);
    const extraLen = u16(buffer, offset + 30);
    const commentLen = u16(buffer, offset + 32);
    const localOffset = u32(buffer, offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen).replace(/\\/g, "/");
    offset += 46 + nameLen + extraLen + commentLen;
    const base = name.split("/").pop();
    if (name !== wanted && name.endsWith(`/${wanted}`) === false && base !== wantedBase) continue;
    if (buffer.toString("ascii", localOffset, localOffset + 4) !== "PK\x03\x04") {
      throw new Error(`invalid zip local header for ${name}`);
    }
    const localNameLen = u16(buffer, localOffset + 26);
    const localExtraLen = u16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    return JSON.parse(data.toString("utf8"));
  }
  return null;
}

/** Build a DEFLATE zip of JSON files for hermetic tests. */
export function zipJsonFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name), "utf8");
    const raw = Buffer.from(`${JSON.stringify(file.json, null, 2)}\n`, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.write("PK\x03\x04", 0);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0);
    writeU16(local, 8, 8);
    writeU32(local, 14, crc);
    writeU32(local, 18, compressed.length);
    writeU32(local, 22, raw.length);
    writeU16(local, 26, name.length);
    writeU16(local, 28, 0);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.write("PK\x01\x02", 0);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, 0);
    writeU16(central, 10, 8);
    writeU32(central, 16, crc);
    writeU32(central, 20, compressed.length);
    writeU32(central, 24, raw.length);
    writeU16(central, 28, name.length);
    writeU16(central, 32, 0);
    writeU16(central, 34, 0);
    writeU16(central, 36, 0);
    writeU32(central, 38, 0);
    writeU32(central, 42, offset);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\x05\x06", 0);
  writeU16(eocd, 8, files.length);
  writeU16(eocd, 10, files.length);
  writeU32(eocd, 12, centralBytes.length);
  writeU32(eocd, 16, localBytes.length);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}
