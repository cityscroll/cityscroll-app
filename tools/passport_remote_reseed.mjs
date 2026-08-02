#!/usr/bin/env node
/**
 * Operator reseed for PASSPort Public product tables + dual-write source_records.
 *
 * Downloads the live portal dataJs dumps (reachable from a non-bot-blocked host),
 * then writes remote D1 via the Cloudflare API using the logged-in wrangler session.
 * Use when daily Worker ingest has stalled or dual-write observations are empty.
 *
 * Usage (from repo root, with wrangler logged in):
 *   node tools/passport_remote_reseed.mjs
 *   node tools/passport_remote_reseed.mjs --dry-run
 *   node tools/passport_remote_reseed.mjs --dual-write-only   # observations from existing product rows
 *
 * Credentials: CLOUDFLARE_API_TOKEN env, or a logged-in wrangler config.
 * Account + D1 ids default from worker/wrangler.toml (override with CF_ACCOUNT_ID /
 * CF_D1_DATABASE_ID).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CONTRACT_DATA_URL,
  RFX_DATA_URL,
  parseContractsDump,
  parseRfxDump,
} from "../worker/src/lib/passport_parse.mjs";
import { passportSourceSystemId } from "../worker/src/passport.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BATCH = 40;
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; CityScrollBot/1.0; +https://cityscroll.org; PASSPort Public reseed)",
  Accept: "application/javascript, text/javascript, */*;q=0.8",
};

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const DUAL_ONLY = args.has("--dual-write-only");

function loadWranglerIds() {
  const toml = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf8");
  const account =
    process.env.CF_ACCOUNT_ID
    || toml.match(/ANALYTICS_ACCOUNT_ID\s*=\s*"([^"]+)"/)?.[1]
    || null;
  const database =
    process.env.CF_D1_DATABASE_ID
    || toml.match(/database_id\s*=\s*"([^"]+)"/)?.[1]
    || null;
  if (!account || !database) {
    throw new Error("missing CF account or D1 database id (env or worker/wrangler.toml)");
  }
  return { account, database };
}

function loadToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    join(homedir(), ".wrangler/config/default.toml"),
    join(homedir(), ".config/.wrangler/config/default.toml"),
  ];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(/oauth_token\s*=\s*"([^"]+)"/) || text.match(/api_token\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch {
      /* try next */
    }
  }
  throw new Error("no Cloudflare API credential (set CLOUDFLARE_API_TOKEN or login with wrangler)");
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function contentHash(record) {
  // Match worker computeSourceRecordHash canonical JSON (sorted keys, recursive).
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(",")}}`;
  };
  return createHash("sha256").update(canonical(record)).digest("hex");
}

async function d1Query(ctx, sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ctx.account}/d1/database/${ctx.database}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!body.success) {
    const err = body.errors?.[0]?.message || JSON.stringify(body.errors || body);
    throw new Error(`D1 query failed: ${err}`);
  }
  return body.result?.[0] || {};
}

async function d1BatchSql(ctx, statements) {
  // D1 REST accepts one SQL string; join with semicolons for small batches.
  const sql = statements.join(";\n");
  return d1Query(ctx, sql);
}

async function writeMeta(ctx, pairs) {
  const stmts = pairs.map(
    ([k, v]) =>
      `INSERT OR REPLACE INTO passport_ingest_meta (key, value) VALUES (${sqlQuote(k)}, ${sqlQuote(v)})`,
  );
  await d1BatchSql(ctx, stmts);
}

function contractInsertSql(c, ingestedAt) {
  return `INSERT OR REPLACE INTO passport_contracts
    (epin, epin_norm, ctr_id, contract_id, title, agency, vendor, status,
     procurement_method, contract_type, award_amount, current_amount, paid_amount,
     start_date, end_date, registration_date, payload, ingested_at)
   VALUES (
     ${sqlQuote(c.epin)}, ${sqlQuote(c.epin_norm)}, ${sqlQuote(c.ctr_id || c.epin_norm)},
     ${sqlQuote(c.contract_id)}, ${sqlQuote(c.title)}, ${sqlQuote(c.agency)},
     ${sqlQuote(c.vendor)}, ${sqlQuote(c.status)}, ${sqlQuote(c.procurement_method)},
     ${sqlQuote(c.contract_type)}, ${sqlQuote(c.award_amount)}, ${sqlQuote(c.current_amount)},
     ${sqlQuote(c.paid_amount)}, ${sqlQuote(c.start_date)}, ${sqlQuote(c.end_date)},
     ${sqlQuote(c.registration_date)}, ${sqlQuote(JSON.stringify(c))}, ${sqlQuote(ingestedAt)}
   )`;
}

function rfxInsertSql(r, ingestedAt) {
  return `INSERT OR REPLACE INTO passport_rfx
    (epin, epin_norm, rfp_id, procurement_name, agency, rfx_status,
     release_date, due_date, procurement_method, main_commodity, industry,
     payload, ingested_at)
   VALUES (
     ${sqlQuote(r.epin)}, ${sqlQuote(r.epin_norm)}, ${sqlQuote(r.rfp_id || r.epin_norm)},
     ${sqlQuote(r.procurement_name)}, ${sqlQuote(r.agency)}, ${sqlQuote(r.rfx_status)},
     ${sqlQuote(r.release_date)}, ${sqlQuote(r.due_date)}, ${sqlQuote(r.procurement_method)},
     ${sqlQuote(r.main_commodity)}, ${sqlQuote(r.industry)},
     ${sqlQuote(JSON.stringify(r))}, ${sqlQuote(ingestedAt)}
   )`;
}

function sourceInsertSql(system, kind, record, ingestedAt) {
  const snap = JSON.stringify(record);
  return `INSERT OR IGNORE INTO source_records
    (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
   VALUES (
     ${sqlQuote(system)},
     ${sqlQuote(passportSourceSystemId(kind, record))},
     ${sqlQuote(contentHash(record))},
     ${sqlQuote(snap)},
     ${sqlQuote(snap)},
     ${sqlQuote(ingestedAt)}
   )`;
}

async function writeInBatches(ctx, statements, label) {
  let written = 0;
  for (let i = 0; i < statements.length; i += BATCH) {
    const chunk = statements.slice(i, i + BATCH);
    if (!DRY) await d1BatchSql(ctx, chunk);
    written += chunk.length;
    if (written % 2000 === 0 || written === statements.length) {
      console.log(`  ${label}: ${written}/${statements.length}`);
    }
  }
  return written;
}

async function dualWriteFromProduct(ctx, ingestedAt) {
  console.log("Dual-write from existing product payloads…");
  let offset = 0;
  let contracts = 0;
  let rfx = 0;

  async function drain(table, kind, system) {
    for (;;) {
      const res = await d1Query(
        ctx,
        `SELECT payload FROM ${table} ORDER BY rowid LIMIT ${BATCH} OFFSET ${offset}`,
      );
      const rows = res.results || [];
      if (!rows.length) break;
      const stmts = [];
      for (const row of rows) {
        let record;
        try {
          record = JSON.parse(row.payload);
        } catch {
          continue;
        }
        if (!record) continue;
        stmts.push(sourceInsertSql(system, kind, record, ingestedAt));
      }
      if (stmts.length && !DRY) await d1BatchSql(ctx, stmts);
      if (kind === "contract") contracts += stmts.length;
      else rfx += stmts.length;
      offset += rows.length;
      if (rows.length < BATCH) break;
      if ((contracts + rfx) % 2000 === 0) {
        console.log(`  dual-write progress contracts=${contracts} rfx=${rfx}`);
      }
    }
    offset = 0;
  }

  await drain("passport_contracts", "contract", "passport_public_contracts");
  await drain("passport_rfx", "rfx", "passport_public_rfx");
  if (!DRY) {
    await writeMeta(ctx, [
      ["dual_write_contracts", String(contracts)],
      ["dual_write_rfx", String(rfx)],
      ["dual_write_backfill_at", ingestedAt],
    ]);
  }
  return { contracts, rfx };
}

async function main() {
  const ids = loadWranglerIds();
  const ctx = { token: loadToken(), account: ids.account, database: ids.database };
  const ingestedAt = new Date().toISOString();
  console.log(`mode=${DRY ? "dry-run" : "write"} dual_only=${DUAL_ONLY} ingested_at=${ingestedAt}`);

  if (DUAL_ONLY) {
    const r = await dualWriteFromProduct(ctx, ingestedAt);
    console.log("done dual-write-only", r);
    return;
  }

  console.log("Fetching PASSPort dumps…");
  const [ctrRes, rfxRes] = await Promise.all([
    fetch(CONTRACT_DATA_URL, { redirect: "follow", headers: FETCH_HEADERS }),
    fetch(RFX_DATA_URL, { redirect: "follow", headers: FETCH_HEADERS }),
  ]);
  if (!ctrRes.ok) throw new Error(`contracts HTTP ${ctrRes.status}`);
  if (!rfxRes.ok) throw new Error(`rfx HTTP ${rfxRes.status}`);
  const [ctrText, rfxText] = await Promise.all([ctrRes.text(), rfxRes.text()]);
  const contracts = parseContractsDump(ctrText);
  const rfx = parseRfxDump(rfxText);
  console.log(`parsed contracts=${contracts.length} rfx=${rfx.length}`);
  if (!contracts.length || !rfx.length) throw new Error("empty parse");

  if (DRY) {
    console.log("dry-run: would DELETE+INSERT product tables and dual-write observations");
    return;
  }

  console.log("Clearing product tables…");
  await d1Query(ctx, "DELETE FROM passport_contracts");
  await d1Query(ctx, "DELETE FROM passport_rfx");

  console.log("Inserting contracts…");
  await writeInBatches(
    ctx,
    contracts.map((c) => contractInsertSql(c, ingestedAt)),
    "contracts",
  );
  console.log("Inserting rfx…");
  await writeInBatches(
    ctx,
    rfx.map((r) => rfxInsertSql(r, ingestedAt)),
    "rfx",
  );

  console.log("Dual-writing source_records…");
  const ctrObs = contracts.map((c) =>
    sourceInsertSql("passport_public_contracts", "contract", c, ingestedAt),
  );
  const rfxObs = rfx.map((r) =>
    sourceInsertSql("passport_public_rfx", "rfx", r, ingestedAt),
  );
  await writeInBatches(ctx, ctrObs, "source_contracts");
  await writeInBatches(ctx, rfxObs, "source_rfx");

  const lastModified = {
    contracts: ctrRes.headers.get("last-modified") || null,
    rfx: rfxRes.headers.get("last-modified") || null,
    source: "passport-remote-reseed",
  };
  await writeMeta(ctx, [
    ["ingested_at", ingestedAt],
    ["contract_rows", String(contracts.length)],
    ["rfx_rows", String(rfx.length)],
    ["last_modified", JSON.stringify(lastModified)],
    ["last_attempt_at", ingestedAt],
    ["last_ok", "true"],
    ["last_error", ""],
    ["dual_write_contracts", String(contracts.length)],
    ["dual_write_rfx", String(rfx.length)],
    ["dual_write_errors", "0"],
  ]);

  const check = await d1Query(
    ctx,
    `SELECT source_system, COUNT(*) AS n FROM source_records
     WHERE source_system LIKE 'passport%' GROUP BY source_system`,
  );
  const meta = await d1Query(
    ctx,
    "SELECT key, value FROM passport_ingest_meta WHERE key IN ('ingested_at','contract_rows','rfx_rows')",
  );
  console.log("source_records", check.results);
  console.log("meta", meta.results);
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
