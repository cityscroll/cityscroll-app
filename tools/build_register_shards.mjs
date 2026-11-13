#!/usr/bin/env node
/**
 * Build committed static shards for IRS EO BMF NY, NYS DOL contractor registry,
 * and NYC SCA prequalified firms.
 *
 *   node tools/build_register_shards.mjs --register all --from-acquired
 *   node tools/build_register_shards.mjs --register irs --from-csv PATH
 *   node tools/build_register_shards.mjs --register dol --from-json PATH
 *   node tools/build_register_shards.mjs --register dol --from-soda
 *   node tools/build_register_shards.mjs --register sca --from-json PATH
 *   node tools/build_register_shards.mjs --register sca --from-soda
 *   node tools/build_register_shards.mjs --check
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeIrsCsv, IRS_FILE_URL } from "../entity_resolution/registers/irs_eo_bmf.mjs";
import {
  DOL_RESOURCE_URL,
  DOL_SOURCE_URL,
  SCA_RESOURCE_URL,
  SCA_SOURCE_URL,
  normalizeDolRow,
  normalizeScaRows,
} from "../entity_resolution/registers/table_registers.mjs";
import {
  REGISTER_LOOKUP_IDS,
  decideRegisterPublish,
  registerBucket,
  sha256Hex,
  stableStringify,
} from "../warehouse/lib/register_lookups.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACQUIRED_IRS = path.join(ROOT, ".artifacts", "first-class-inputs", "irs-eo-bmf-ny", "eo_ny.csv");
const SITE = path.join(ROOT, "site", "data");

const CONFIG = {
  irs: {
    id: REGISTER_LOOKUP_IDS.irs_eo_bmf_ny,
    dir: path.join(SITE, "irs_eo_bmf_ny"),
    buckets: 64,
    source_url: IRS_FILE_URL,
    canary_rows: [
      { EIN: "263419217", NAME: "VINCENT NASTA FOUNDATION INC" },
    ],
  },
  dol: {
    id: REGISTER_LOOKUP_IDS.nys_dol_contractor_registry,
    dir: path.join(SITE, "nys_dol_contractor_registry"),
    buckets: 64,
    source_url: DOL_SOURCE_URL,
    resource_url: DOL_RESOURCE_URL,
    canary_rows: [
      { certificate_number: "24-637Y9-CR", business_name: "ZHN CONTRACTING CORPORATION" },
    ],
  },
  sca: {
    id: REGISTER_LOOKUP_IDS.nyc_sca_prequalified_firms,
    dir: path.join(SITE, "nyc_sca_prequalified_firms"),
    buckets: 16,
    source_url: SCA_SOURCE_URL,
    resource_url: SCA_RESOURCE_URL,
    canary_rows: [
      { prequalified_vendor_name: "A + Choice Construction Inc." },
    ],
  },
};

const REGISTER_ALIASES = Object.freeze({
  all: "all",
  irs: "irs",
  irs_eo_bmf_ny: "irs",
  dol: "dol",
  nys_dol_contractor_registry: "dol",
  sca: "sca",
  nyc_sca_prequalified_firms: "sca",
});

function parseArgs(argv) {
  const out = {
    check: false,
    register: "all",
    fromCsv: null,
    fromJson: null,
    fromAcquired: false,
    fromSoda: false,
    receipt: null,
    collectedAt: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--from-acquired") out.fromAcquired = true;
    // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
    else if (a === "--from-soda") out.fromSoda = true;
    else if (a === "--register") out.register = argv[++i];
    else if (a === "--from-csv") out.fromCsv = argv[++i];
    else if (a === "--from-json") out.fromJson = argv[++i];
    else if (a === "--receipt") out.receipt = argv[++i];
    else if (a === "--collected-at") out.collectedAt = argv[++i];
  }
  return out;
}

const SODA_PAGE = 50_000;

async function fetchSodaRows(resourceUrl, { fetchImpl = fetch } = {}) {
  const rows = [];
  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({
      $limit: String(SODA_PAGE),
      $offset: String(page * SODA_PAGE),
    });
    // determinism-lint: allow external-data live SODA path only for --from-soda rematerialization
    const res = await fetchImpl(`${resourceUrl}?${params}`);
    if (!res.ok) {
      // determinism-lint: allow external-data live SODA path only for --from-soda rematerialization
      throw new Error(`SODA ${res.status} during --from-soda materialization for ${resourceUrl}`);
    }
    const pageRows = await res.json();
    if (!Array.isArray(pageRows)) {
      throw new Error(`SODA returned a non-array response for ${resourceUrl}`);
    }
    rows.push(...pageRows);
    if (pageRows.length < SODA_PAGE) break;
  }
  return rows;
}

function resolveRegisterKey(name) {
  const key = REGISTER_ALIASES[name];
  if (!key) throw new Error(`unknown register ${name}`);
  return key;
}

function writeAtomic(file, text) {
  // determinism-lint: allow write non-check materialization output
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // determinism-lint: allow write non-check materialization output
  writeFileSync(tmp, text);
  // determinism-lint: allow write non-check materialization output
  renameSync(tmp, file);
}

function shardFileName(kind, bucket, buckets) {
  const width = buckets <= 16 ? 1 : 2;
  const id = String(bucket).padStart(width, kind === "hex" ? 0 : width);
  // bucket already hex-padded from registerBucket
  return `${kind}-${bucket}.json`;
}

function compactStringify(value) {
  return `${JSON.stringify(value)}\n`;
}

function buildShardDoc({ register, kind, bucket, collected_at, source_url, records, columnar = null }) {
  const body = columnar
    ? {
      schema: "cityscroll.register_shard.v1",
      register,
      kind,
      bucket,
      collected_at,
      source_url,
      row_count: columnar.rows.length,
      columns: columnar.columns,
      rows: columnar.rows,
    }
    : {
      schema: "cityscroll.register_shard.v1",
      register,
      kind,
      bucket,
      collected_at,
      source_url,
      row_count: records.length,
      records,
    };
  const text = compactStringify(body);
  return { body, text, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
}

function loadManifest(dir) {
  const p = path.join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function materializeBuckets(records, { register, collected_at, source_url, buckets }) {
  const idBuckets = new Map();
  const stemBuckets = new Map();
  const width = buckets <= 16 ? 1 : 2;
  for (let i = 0; i < buckets; i++) {
    const b = i.toString(16).padStart(width, "0");
    idBuckets.set(b, []);
    stemBuckets.set(b, []);
  }
  for (const rec of records) {
    const idKey = registerBucket(String(rec.register_record_id || ""), buckets);
    idBuckets.get(idKey).push(rec);
    const stemKey = registerBucket(String(rec.name_stem || ""), buckets);
    // stem shard stores thin index entries
    stemBuckets.get(stemKey).push({
      register_record_id: rec.register_record_id,
      name: rec.name,
      name_stem: rec.name_stem,
      entity_class: rec.entity_class,
      entity_type: rec.entity_type,
      aliases: rec.published?.aliases || [],
    });
  }
  const idKind = "id";
  const stemKind = "stem";
  // IRS uses ein- instead of id-
  const idPrefix = register === REGISTER_LOOKUP_IDS.irs_eo_bmf_ny ? "ein" : "id";
  const shards = [];
  const irsColumnar = register === REGISTER_LOOKUP_IDS.irs_eo_bmf_ny;
  for (const [bucket, rows] of idBuckets) {
    let built;
    if (irsColumnar) {
      const columns = rows[0] ? Object.keys(rows[0].raw) : [];
      const colloidal = {
        columns,
        rows: rows.map((rec) => columns.map((c) => rec.raw[c] ?? "")),
      };
      // Keep register_record_id / name_stem / entity_class beside columnar raw for lookup.
      // Compact: store parallel meta arrays.
      built = buildShardDoc({
        register, kind: idPrefix, bucket, collected_at, source_url, records: [],
        columnar: {
          columns: ["register_record_id", "name", "name_stem", "entity_class", "entity_type", ...columns],
          rows: rows.map((rec) => [
            rec.register_record_id, rec.name, rec.name_stem, rec.entity_class, rec.entity_type,
            ...columns.map((c) => rec.raw[c] ?? ""),
          ]),
        },
      });
    } else {
      // Drop bulky raw duplication for DOL/SCA id shards: keep published + flags + ids.
      const slim = rows.map((rec) => ({
        register: rec.register,
        register_record_id: rec.register_record_id,
        name: rec.name,
        name_stem: rec.name_stem,
        entity_class: rec.entity_class,
        entity_type: rec.entity_type,
        address: rec.address,
        status: rec.status,
        status_basis: rec.status_basis,
        source_url: rec.source_url,
        collected_at: rec.collected_at,
        queried_at: rec.queried_at,
        flags: rec.flags,
        published: rec.published,
        raw: rec.raw,
      }));
      built = buildShardDoc({
        register, kind: idPrefix, bucket, collected_at, source_url, records: slim,
      });
    }
    shards.push({
      path: `${idPrefix}-${bucket}.json`,
      kind: idPrefix,
      bucket,
      rows: rows.length,
      bytes: built.bytes,
      sha256: built.sha256,
      text: built.text,
    });
  }
  for (const [bucket, rows] of stemBuckets) {
    const built = buildShardDoc({
      register, kind: stemKind, bucket, collected_at, source_url, records: rows,
    });
    shards.push({
      path: `${stemKind}-${bucket}.json`,
      kind: stemKind,
      bucket,
      rows: rows.length,
      bytes: built.bytes,
      sha256: built.sha256,
      text: built.text,
    });
  }
  return shards;
}

function writeRegister({ cfg, records, collected_at, source_row_count = null, source_receipt = null }) {
  const previous = loadManifest(cfg.dir);
  const decision = decideRegisterPublish({
    register: cfg.id,
    previous,
    next: { row_count: records.length },
    ok: true,
  });
  if (decision.action !== "publish") {
    return { ok: false, retained: true, reason: decision.reason, previous };
  }
  const shards = materializeBuckets(records, {
    register: cfg.id,
    collected_at,
    source_url: cfg.source_url,
    buckets: cfg.buckets,
  });
  // determinism-lint: allow write non-check materialization output
  mkdirSync(cfg.dir, { recursive: true });
  // Remove stale shard files not in the new set
  const keep = new Set(["manifest.json", ...shards.map((s) => s.path)]);
  if (existsSync(cfg.dir)) {
    for (const name of readdirSync(cfg.dir)) {
      if (!keep.has(name) && name.endsWith(".json")) {
        // determinism-lint: allow write non-check materialization output
        rmSync(path.join(cfg.dir, name), { force: true });
      }
    }
  }
  for (const shard of shards) {
    writeAtomic(path.join(cfg.dir, shard.path), shard.text);
  }
  const manifest = {
    schema: "cityscroll.register_shards_manifest.v1",
    register: cfg.id,
    collected_at,
    source_url: cfg.source_url,
    row_count: records.length,
    source_row_count,
    source_receipt,
    bucket_count: cfg.buckets,
    canary_rows: cfg.canary_rows || [],
    shards: shards.map(({ path: p, kind, bucket, rows, bytes, sha256 }) => ({
      path: p, kind, bucket, rows, bytes, sha256,
    })),
  };
  writeAtomic(path.join(cfg.dir, "manifest.json"), stableStringify(manifest));
  return { ok: true, retained: false, manifest };
}

function buildIrs(csvPath, collected_at) {
  const text = readFileSync(csvPath, "utf8");
  const out = normalizeIrsCsv(text, { collected_at });
  if (!out.ok) throw new Error(`IRS normalize failed: ${(out.problems || []).join("; ")}`);
  return writeRegister({
    cfg: CONFIG.irs,
    records: out.records,
    collected_at,
    source_row_count: out.row_count,
    source_receipt: {
      bytes: Buffer.byteLength(text),
      sha256: sha256Hex(text),
      row_count: out.row_count,
    },
  });
}

function buildDol(jsonPath, collected_at) {
  const rows = JSON.parse(readFileSync(jsonPath, "utf8"));
  if (!Array.isArray(rows)) throw new Error("DOL input is not an array");
  const records = rows.map((r) => normalizeDolRow(r, { collected_at }));
  return writeRegister({
    cfg: CONFIG.dol,
    records,
    collected_at,
    source_row_count: rows.length,
    source_receipt: { row_count: rows.length, source_url: DOL_RESOURCE_URL },
  });
}

function buildSca(jsonPath, collected_at) {
  const rows = JSON.parse(readFileSync(jsonPath, "utf8"));
  if (!Array.isArray(rows)) throw new Error("SCA input is not an array");
  const records = normalizeScaRows(rows, { collected_at });
  return writeRegister({
    cfg: CONFIG.sca,
    records,
    collected_at,
    source_row_count: rows.length,
    source_receipt: { row_count: rows.length, firm_records: records.length, source_url: SCA_RESOURCE_URL },
  });
}

function checkRegister(cfg) {
  const manifest = loadManifest(cfg.dir);
  if (!manifest) return { ok: false, problems: [`missing manifest for ${cfg.id}`] };
  const problems = [];
  if (manifest.register !== cfg.id) problems.push("register mismatch");
  if (manifest.schema !== "cityscroll.register_shards_manifest.v1") problems.push("bad schema");
  if (!Array.isArray(manifest.shards) || manifest.shards.length !== cfg.buckets * 2) {
    problems.push(`expected ${cfg.buckets * 2} shards, got ${manifest.shards?.length}`);
  }
  let rows = 0;
  for (const shard of manifest.shards || []) {
    const file = path.join(cfg.dir, shard.path);
    if (!existsSync(file)) {
      problems.push(`missing shard ${shard.path}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const digest = sha256Hex(text);
    if (digest !== shard.sha256) problems.push(`sha256 drift ${shard.path}`);
    if (Buffer.byteLength(text) !== shard.bytes) problems.push(`byte drift ${shard.path}`);
    const doc = JSON.parse(text);
    const count = Array.isArray(doc.records) ? doc.records.length : (doc.rows?.length ?? -1);
    if (doc.row_count !== count) problems.push(`row_count mismatch ${shard.path}`);
    if (shard.kind !== "stem") rows += doc.row_count;
  }
  if (rows !== manifest.row_count) problems.push(`manifest row_count ${manifest.row_count} != id-shard sum ${rows}`);
  const decision = decideRegisterPublish({
    register: cfg.id,
    previous: null,
    next: { row_count: manifest.row_count },
    ok: problems.length === 0,
  });
  if (decision.action !== "publish") problems.push(decision.reason);
  return { ok: problems.length === 0, problems, row_count: manifest.row_count };
}

function runCheck() {
  const results = {};
  let ok = true;
  for (const key of Object.keys(CONFIG)) {
    const r = checkRegister(CONFIG[key]);
    results[key] = r;
    if (!r.ok) ok = false;
  }
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.check) {
    runCheck();
    return;
  }
  let collected_at = args.collectedAt || null;
  if (!collected_at && args.receipt && existsSync(args.receipt)) {
    try {
      collected_at = JSON.parse(readFileSync(args.receipt, "utf8")).collected_at || null;
    } catch {
      collected_at = null;
    }
  }
  // determinism-lint: allow clock acquisition receipt timestamp only outside --check
  collected_at = collected_at || new Date().toISOString();
  const requested = args.register === "all" ? ["irs", "dol", "sca"] : [resolveRegisterKey(args.register)];
  const scratch = process.env.FM_TASK_SCRATCH
    ? path.join(process.env.FM_TASK_SCRATCH, "registers")
    : null;
  const summary = {};
  for (const t of requested) {
    if (!CONFIG[t]) throw new Error(`unknown register ${t}`);
    if (t === "irs") {
      const csv = args.fromCsv
        || (args.fromAcquired && ACQUIRED_IRS)
        || (scratch && path.join(scratch, "eo_ny.csv"))
        || ACQUIRED_IRS;
      if (!existsSync(csv)) throw new Error(`IRS csv missing: ${csv}`);
      summary.irs = buildIrs(csv, collected_at);
    } else if (t === "dol") {
      if (args.fromSoda) {
        const rows = await fetchSodaRows(DOL_RESOURCE_URL);
        const tmp = path.join(ROOT, ".artifacts", "first-class-inputs", "nys-dol-contractor-registry", "rows.json");
        // determinism-lint: allow write non-check materialization output
        mkdirSync(path.dirname(tmp), { recursive: true });
        // determinism-lint: allow write non-check materialization output
        writeFileSync(tmp, `${JSON.stringify(rows)}\n`);
        summary.dol = buildDol(tmp, collected_at);
      } else {
        const json = args.fromJson
          || (scratch && path.join(scratch, "dol.json"));
        if (!json || !existsSync(json)) {
          // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
          throw new Error("DOL JSON missing (pass --from-json, --from-soda, or set FM_TASK_SCRATCH/registers/dol.json)");
        }
        summary.dol = buildDol(json, collected_at);
      }
    } else if (t === "sca") {
      if (args.fromSoda) {
        const rows = await fetchSodaRows(SCA_RESOURCE_URL);
        const tmp = path.join(ROOT, ".artifacts", "first-class-inputs", "nyc-sca-prequalified-firms", "rows.json");
        // determinism-lint: allow write non-check materialization output
        mkdirSync(path.dirname(tmp), { recursive: true });
        // determinism-lint: allow write non-check materialization output
        writeFileSync(tmp, `${JSON.stringify(rows)}\n`);
        summary.sca = buildSca(tmp, collected_at);
      } else {
        const json = args.fromJson
          || (scratch && path.join(scratch, "sca.json"));
        if (!json || !existsSync(json)) {
          // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
          throw new Error("SCA JSON missing (pass --from-json, --from-soda, or set FM_TASK_SCRATCH/registers/sca.json)");
        }
        summary.sca = buildSca(json, collected_at);
      }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((s) => !s.ok)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
