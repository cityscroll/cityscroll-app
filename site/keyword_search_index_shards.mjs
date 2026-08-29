import { createHash } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gzipSync,
  gunzipSync,
} from "node:zlib";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export const KEYWORD_SEARCH_INDEX_SHARD_SCHEMA = "cityscroll.keyword_search_index_shard.v1";
export const KEYWORD_SEARCH_INDEX_SHARD_RECEIPT_SCHEMA = "cityscroll.keyword_search_index_shard_receipt.v1";
export const KEYWORD_SEARCH_INDEX_SHARD_DIR = "worker/src/data/keyword_search_index_shards";

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function keywordSearchIndexFingerprint(index) {
  return sha256(Buffer.from(JSON.stringify(canonical(index)), "utf8"));
}

function shardName(family) {
  return `${family}.json`;
}

function compressedPath(family, extension) {
  return `${shardName(family)}.${extension}`;
}

function brotli(value) {
  return brotliCompressSync(value, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
  });
}

function shardBody(familyId, family) {
  return {
    schema: KEYWORD_SEARCH_INDEX_SHARD_SCHEMA,
    version: 1,
    family: familyId,
    source: family?.source || null,
    as_of: family?.as_of || null,
    source_row_count: Number(family?.source_row_count) || 0,
    indexed_count: Number(family?.indexed_count) || 0,
    coverage: Array.isArray(family?.coverage) ? family.coverage : [],
    documents: Array.isArray(family?.documents) ? family.documents : [],
  };
}

function shardPayload(familyId, family) {
  const body = shardBody(familyId, family);
  const bodyBytes = serialized(body);
  return {
    ...body,
    receipt: {
      schema: KEYWORD_SEARCH_INDEX_SHARD_RECEIPT_SCHEMA,
      family: familyId,
      document_count: body.documents.length,
      content_sha256: sha256(bodyBytes),
      content_bytes: bodyBytes.byteLength,
    },
  };
}

function logicalIndexFromManifest(manifest, shards) {
  const families = Object.fromEntries(shards.map((shard) => [
    shard.family,
    {
      source: shard.source,
      as_of: shard.as_of,
      source_row_count: shard.source_row_count,
      indexed_count: shard.indexed_count,
      coverage: shard.coverage,
      documents: shard.documents,
    },
  ]));
  return {
    schema: manifest.schema,
    generated_at: manifest.generated_at,
    match_mode: manifest.match_mode,
    families,
    build_receipt: manifest.build_receipt,
    coherence_receipt: manifest.coherence_receipt,
  };
}

export function buildKeywordSearchIndexShardArtifacts(index) {
  const logicalBytes = serialized(index);
  const shards = Object.entries(index?.families || {}).map(([familyId, family]) => {
    const payload = shardPayload(familyId, family);
    const content = serialized(payload);
    const gzip = gzipSync(content);
    const br = brotli(content);
    return {
      family: familyId,
      payload,
      content,
      gzip,
      brotli: br,
      descriptor: {
        family: familyId,
        path: compressedPath(familyId, "br"),
        gzip_path: compressedPath(familyId, "gz"),
        document_count: payload.documents.length,
        uncompressed_bytes: content.byteLength,
        gzip_bytes: gzip.byteLength,
        brotli_bytes: br.byteLength,
        sha256: sha256(content),
        gzip_sha256: sha256(gzip),
        brotli_sha256: sha256(br),
        receipt_sha256: payload.receipt.content_sha256,
      },
    };
  });
  const manifest = {
    schema: index?.schema || null,
    version: 1,
    generated_at: index?.generated_at || null,
    match_mode: index?.match_mode || null,
    representation: "family-sharded-compressed",
    shard_schema: KEYWORD_SEARCH_INDEX_SHARD_SCHEMA,
    logical_index: {
      sha256: keywordSearchIndexFingerprint(index),
      bytes: logicalBytes.byteLength,
      family_count: shards.length,
      document_count: shards.reduce((sum, shard) => sum + shard.payload.documents.length, 0),
    },
    build_receipt: index?.build_receipt || null,
    coherence_receipt: index?.coherence_receipt || null,
    shards: shards.map((shard) => shard.descriptor),
  };
  return { manifest, shards, logical: index };
}

export function writeKeywordSearchIndexShardArtifacts(artifacts, outputDir) {
  const dir = typeof outputDir === "string" ? outputDir : fileURLToPath(outputDir);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.json\.(?:br|gz)$/.test(entry.name)) rmSync(join(dir, entry.name));
  }
  writeFileSync(join(dir, "manifest.json"), serialized(artifacts.manifest));
  for (const shard of artifacts.shards) {
    writeFileSync(join(dir, shard.descriptor.path), shard.brotli);
    writeFileSync(join(dir, shard.descriptor.gzip_path), shard.gzip);
  }
}

function manifestPath(pathOrDir) {
  const raw = pathOrDir instanceof URL ? fileURLToPath(pathOrDir) : String(pathOrDir);
  const absolute = isAbsolute(raw) ? raw : resolve(raw);
  return absolute.endsWith("manifest.json") ? absolute : join(absolute, "manifest.json");
}

export function readKeywordSearchIndexShardManifest(pathOrDir) {
  const path = manifestPath(pathOrDir);
  if (!existsSync(path)) throw new Error(`keyword search shard manifest missing: ${path}`);
  return { path, dir: dirname(path), manifest: JSON.parse(readFileSync(path, "utf8")) };
}

function readCompressedShard(dir, descriptor) {
  const brPath = join(dir, descriptor.path);
  const gzipPath = join(dir, descriptor.gzip_path);
  let compressed;
  let content;
  if (existsSync(brPath)) {
    compressed = readFileSync(brPath);
    if (sha256(compressed) !== descriptor.brotli_sha256) {
      throw new Error(`keyword search Brotli shard hash mismatch: ${descriptor.family}`);
    }
    content = brotliDecompressSync(compressed);
  } else if (existsSync(gzipPath)) {
    compressed = readFileSync(gzipPath);
    if (sha256(compressed) !== descriptor.gzip_sha256) {
      throw new Error(`keyword search gzip shard hash mismatch: ${descriptor.family}`);
    }
    content = gunzipSync(compressed);
  } else {
    throw new Error(`keyword search shard missing: ${descriptor.family}`);
  }
  if (content.byteLength !== descriptor.uncompressed_bytes || sha256(content) !== descriptor.sha256) {
    throw new Error(`keyword search shard content mismatch: ${descriptor.family}`);
  }
  const shard = JSON.parse(content.toString("utf8"));
  const { receipt, ...body } = shard;
  if (
    shard.schema !== KEYWORD_SEARCH_INDEX_SHARD_SCHEMA
    || shard.family !== descriptor.family
    || receipt?.schema !== KEYWORD_SEARCH_INDEX_SHARD_RECEIPT_SCHEMA
    || receipt.family !== descriptor.family
    || receipt.document_count !== shard.documents?.length
    || receipt.content_sha256 !== sha256(serialized(body))
    || receipt.content_bytes !== serialized(body).byteLength
  ) {
    throw new Error(`keyword search shard receipt mismatch: ${descriptor.family}`);
  }
  return shard;
}

export function readKeywordSearchIndexFromShards(pathOrDir) {
  const { dir, manifest } = readKeywordSearchIndexShardManifest(pathOrDir);
  if (manifest.representation !== "family-sharded-compressed") {
    throw new Error("keyword search shard manifest has unsupported representation");
  }
  const shards = (manifest.shards || []).map((descriptor) => readCompressedShard(dir, descriptor));
  const index = logicalIndexFromManifest(manifest, shards);
  const logicalBytes = serialized(index);
  if (keywordSearchIndexFingerprint(index) !== manifest.logical_index?.sha256) {
    throw new Error("keyword search source/index mismatch: shard union is stale");
  }
  return index;
}

export function readKeywordSearchIndexShard(pathOrDir, descriptor) {
  const { dir } = readKeywordSearchIndexShardManifest(pathOrDir);
  return readCompressedShard(dir, descriptor);
}

export function combineKeywordSearchIndexShards(manifest, shards) {
  return logicalIndexFromManifest(manifest, shards);
}
