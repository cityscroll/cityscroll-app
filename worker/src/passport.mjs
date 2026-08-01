// PASSPort Public contracts + RFx edge materialization.
//
// Daily cron downloads the portal's JavaScript data dumps, parses them into D1
// (passport_contracts / passport_rfx), and lifecycle compute joins City Record PINs
// to EPINs from those tables. Clients only hit GET /contract-lifecycle — no live
// PASSPort fetch from the browser.

import {
  CONTRACT_DATA_URL,
  RFX_DATA_URL,
  parseContractsDump,
  parseRfxDump,
} from "./lib/passport_parse.mjs";
import { joinPinToEpin, normId, stripOneSuffix } from "./lib/passport_join.mjs";
import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./lib/source_records.mjs";

const BATCH = 80;
export const PASSPORT_SOURCE_RECORD_DUAL_WRITE_FLAG = "PASSPORT_SOURCE_RECORD_DUAL_WRITE";

/** Allowed table names for SQL interpolation (never user input). */
const PASSPORT_TABLES = new Set(["passport_contracts", "passport_rfx"]);

/**
 * Idempotent schema ensure for the three PASSPort tables.
 * Production deploys apply migrations via wrangler; this is the safety net so a
 * missed migration cannot turn every lifecycle lookup into a silent "error".
 * CREATE TABLE IF NOT EXISTS is cheap when tables already exist.
 */
export async function ensurePassportSchema(env) {
  if (!env?.DB) return { ok: false, reason: "no-db" };
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS passport_contracts (
        epin            TEXT NOT NULL,
        epin_norm       TEXT NOT NULL,
        ctr_id          TEXT,
        contract_id     TEXT,
        title           TEXT,
        agency          TEXT,
        vendor          TEXT,
        status          TEXT,
        procurement_method TEXT,
        contract_type   TEXT,
        award_amount    REAL,
        current_amount  REAL,
        paid_amount     REAL,
        start_date      TEXT,
        end_date        TEXT,
        registration_date TEXT,
        payload         TEXT,
        ingested_at     TEXT NOT NULL,
        PRIMARY KEY (epin_norm, ctr_id)
      )`),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_passport_contracts_epin ON passport_contracts(epin_norm)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_passport_contracts_status ON passport_contracts(status)",
    ),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS passport_rfx (
        epin            TEXT NOT NULL,
        epin_norm       TEXT NOT NULL,
        rfp_id          TEXT,
        procurement_name TEXT,
        agency          TEXT,
        rfx_status      TEXT,
        release_date    TEXT,
        due_date        TEXT,
        procurement_method TEXT,
        main_commodity  TEXT,
        industry        TEXT,
        payload         TEXT,
        ingested_at     TEXT NOT NULL,
        PRIMARY KEY (epin_norm, rfp_id)
      )`),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_passport_rfx_epin ON passport_rfx(epin_norm)",
    ),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS passport_ingest_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`),
  ]);
  return { ok: true };
}

export async function ingestPassportPublic(env) {
  if (!env.DB) return { ok: false, reason: "no-db" };

  // Ensure tables exist before DELETE/INSERT (missed remote migration → empty error storm).
  try {
    await ensurePassportSchema(env);
  } catch (e) {
    console.error("passport schema ensure failed:", String(e?.message || e));
    return { ok: false, reason: "schema-ensure-failed" };
  }

  const [ctrRes, rfxRes] = await Promise.all([
    fetch(CONTRACT_DATA_URL, { redirect: "follow" }),
    fetch(RFX_DATA_URL, { redirect: "follow" }),
  ]);
  if (!ctrRes.ok) return { ok: false, reason: `contracts-http-${ctrRes.status}` };
  if (!rfxRes.ok) return { ok: false, reason: `rfx-http-${rfxRes.status}` };

  const [ctrText, rfxText] = await Promise.all([ctrRes.text(), rfxRes.text()]);
  const contracts = parseContractsDump(ctrText);
  const rfx = parseRfxDump(rfxText);
  if (!contracts.length) return { ok: false, reason: "contracts-empty" };
  if (!rfx.length) return { ok: false, reason: "rfx-empty" };

  const ingestedAt = new Date().toISOString();
  let sourceRecordInsert = null;
  if (sourceRecordDualWriteEnabled(env, PASSPORT_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    try {
      sourceRecordInsert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
    } catch {
      // A missing observation schema must not block PASSPort materialization.
    }
  }
  const lastModified = {
    contracts: ctrRes.headers.get("last-modified") || null,
    rfx: rfxRes.headers.get("last-modified") || null,
  };

  await env.DB.prepare("DELETE FROM passport_contracts").run();
  await env.DB.prepare("DELETE FROM passport_rfx").run();

  for (let i = 0; i < contracts.length; i += BATCH) {
    const chunk = contracts.slice(i, i + BATCH);
    const stmts = chunk.map((c) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO passport_contracts
          (epin, epin_norm, ctr_id, contract_id, title, agency, vendor, status,
           procurement_method, contract_type, award_amount, current_amount, paid_amount,
           start_date, end_date, registration_date, payload, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        c.epin,
        c.epin_norm,
        c.ctr_id || c.epin_norm,
        c.contract_id,
        c.title,
        c.agency,
        c.vendor,
        c.status,
        c.procurement_method,
        c.contract_type,
        c.award_amount,
        c.current_amount,
        c.paid_amount,
        c.start_date,
        c.end_date,
        c.registration_date,
        JSON.stringify(c),
        ingestedAt,
      ),
    );
    await env.DB.batch(stmts);
    if (sourceRecordInsert) {
      try {
        const sourceStmts = await Promise.all(chunk.map(async (contract) =>
          sourceRecordInsert.bind(
            "passport_public_contracts",
            passportSourceSystemId("contract", contract),
            await computeSourceRecordHash(contract),
            JSON.stringify(contract),
            JSON.stringify(contract),
            ingestedAt,
          )));
        await env.DB.batch(sourceStmts);
      } catch {
        // Observation shadow writes must never block PASSPort materialization.
      }
    }
  }

  for (let i = 0; i < rfx.length; i += BATCH) {
    const chunk = rfx.slice(i, i + BATCH);
    const stmts = chunk.map((r) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO passport_rfx
          (epin, epin_norm, rfp_id, procurement_name, agency, rfx_status,
           release_date, due_date, procurement_method, main_commodity, industry,
           payload, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        r.epin,
        r.epin_norm,
        r.rfp_id || r.epin_norm,
        r.procurement_name,
        r.agency,
        r.rfx_status,
        r.release_date,
        r.due_date,
        r.procurement_method,
        r.main_commodity,
        r.industry,
        JSON.stringify(r),
        ingestedAt,
      ),
    );
    await env.DB.batch(stmts);
    if (sourceRecordInsert) {
      try {
        const sourceStmts = await Promise.all(chunk.map(async (record) =>
          sourceRecordInsert.bind(
            "passport_public_rfx",
            passportSourceSystemId("rfx", record),
            await computeSourceRecordHash(record),
            JSON.stringify(record),
            JSON.stringify(record),
            ingestedAt,
          )));
        await env.DB.batch(sourceStmts);
      } catch {
        // Observation shadow writes must never block PASSPort materialization.
      }
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO passport_ingest_meta (key, value) VALUES (?, ?)",
    ).bind("ingested_at", ingestedAt),
    env.DB.prepare(
      "INSERT OR REPLACE INTO passport_ingest_meta (key, value) VALUES (?, ?)",
    ).bind("contract_rows", String(contracts.length)),
    env.DB.prepare(
      "INSERT OR REPLACE INTO passport_ingest_meta (key, value) VALUES (?, ?)",
    ).bind("rfx_rows", String(rfx.length)),
    env.DB.prepare(
      "INSERT OR REPLACE INTO passport_ingest_meta (key, value) VALUES (?, ?)",
    ).bind("last_modified", JSON.stringify(lastModified)),
  ]);

  return {
    ok: true,
    contracts: contracts.length,
    rfx: rfx.length,
    ingested_at: ingestedAt,
    last_modified: lastModified,
  };
}

/** Publisher-stable source key matching each PASSPort materialization primary key. */
export function passportSourceSystemId(kind, record) {
  const epin = String(record?.epin_norm || normId(record?.epin) || "").trim();
  if (kind === "contract") {
    return `contract:${epin}:${String(record?.ctr_id || epin).trim()}`;
  }
  if (kind === "rfx") {
    return `rfx:${epin}:${String(record?.rfp_id || epin).trim()}`;
  }
  throw new Error(`unknown PASSPort observation kind: ${kind}`);
}

function payloadsFrom(rows) {
  return (rows?.results || []).map((r) => {
    try { return JSON.parse(r.payload); } catch { return null; }
  }).filter(Boolean);
}

/**
 * SQL-backed EPIN lookup for one PIN. Tries exact → strip-suffix → pin-prefix-of-epin
 * → epin-prefix-of-pin (len ≥ 10, remainder digits or letter+digits) without loading
 * the full EPIN corpus into memory.
 */
async function resolveTableForPin(env, table, pin) {
  if (!PASSPORT_TABLES.has(table)) {
    throw new Error(`invalid passport table: ${table}`);
  }
  const p = normId(pin);
  if (!p) return { rows: [], join: null };

  // 1) exact
  let res = await env.DB.prepare(
    `SELECT payload, epin_norm FROM ${table} WHERE epin_norm = ? LIMIT 25`,
  ).bind(p).all();
  if (res.results?.length) {
    return { rows: payloadsFrom(res), join: { method: "exact", epin: p } };
  }

  // 2) strip one (or two) trailing suffixes from PIN
  let stripped = stripOneSuffix(p);
  if (stripped) {
    res = await env.DB.prepare(
      `SELECT payload, epin_norm FROM ${table} WHERE epin_norm = ? LIMIT 25`,
    ).bind(stripped).all();
    if (res.results?.length) {
      return { rows: payloadsFrom(res), join: { method: "pin_strip_suffix", epin: stripped } };
    }
    const stripped2 = stripOneSuffix(stripped);
    if (stripped2) {
      res = await env.DB.prepare(
        `SELECT payload, epin_norm FROM ${table} WHERE epin_norm = ? LIMIT 25`,
      ).bind(stripped2).all();
      if (res.results?.length) {
        return { rows: payloadsFrom(res), join: { method: "pin_strip_suffix", epin: stripped2 } };
      }
    }
  }

  // 3) PIN is prefix of EPIN (short notice PIN → longer PASSPort EPIN)
  if (p.length >= 10) {
    res = await env.DB.prepare(
      `SELECT payload, epin_norm FROM ${table}
        WHERE epin_norm LIKE ? AND length(epin_norm) > ?
        LIMIT 25`,
    ).bind(`${p}%`, p.length).all();
    const filtered = (res.results || []).filter((row) => {
      const rest = String(row.epin_norm).slice(p.length);
      return !rest || /^\d+$/.test(rest) || /^[A-Z]\d{2,4}$/.test(rest);
    });
    if (filtered.length) {
      return {
        rows: payloadsFrom({ results: filtered }),
        join: { method: "pin_prefix_of_epin", epin: filtered[0].epin_norm },
      };
    }
  }

  // 4) EPIN is prefix of PIN — candidate EPINs are prefixes of p with len ≥ 10
  const prefixCandidates = [];
  for (let L = Math.min(p.length - 1, 20); L >= 10; L--) {
    const rest = p.slice(L);
    if (/^\d+$/.test(rest) || /^[A-Z]\d{2,4}$/.test(rest)) {
      prefixCandidates.push(p.slice(0, L));
    }
  }
  if (prefixCandidates.length) {
    // Prefer longest prefix (first in list)
    for (const cand of prefixCandidates) {
      res = await env.DB.prepare(
        `SELECT payload, epin_norm FROM ${table} WHERE epin_norm = ? LIMIT 25`,
      ).bind(cand).all();
      if (res.results?.length) {
        return {
          rows: payloadsFrom(res),
          join: { method: "epin_prefix_of_pin", epin: cand },
        };
      }
    }
  }

  return { rows: [], join: null };
}

function classifyLookupError(err) {
  const msg = String(err?.message || err || "");
  // D1 / SQLite missing-table shapes seen in the field.
  if (/no such table/i.test(msg) || /passport_(contracts|rfx)/i.test(msg) && /not found|does not exist/i.test(msg)) {
    return "schema_missing";
  }
  return "query_failed";
}

/**
 * Look up PASSPort rows for a City Record PIN using strict EPIN join strategies.
 *
 * Three-state honesty (same family as payment_state in Checkbook lifecycle):
 *   - ok: query succeeded (rows may still be empty → genuine unmatched)
 *   - error: D1/query failure → panel must show unavailable, never confident empty
 *   - skipped: no DB or no PIN
 */
export async function lookupPassportForPin(env, pin) {
  if (!env.DB || !pin) {
    return {
      contracts: [],
      rfx: [],
      contractJoin: null,
      rfxJoin: null,
      lookupStatus: { contracts: "skipped", rfx: "skipped" },
    };
  }

  try {
    // Self-heal missing tables once per lookup path so a deploy without migrations
    // degrades to empty-ok (source coverage) rather than operational error forever.
    await ensurePassportSchema(env);
  } catch (e) {
    console.error("passport lookup schema ensure failed:", String(e?.message || e));
    return {
      contracts: [],
      rfx: [],
      contractJoin: null,
      rfxJoin: null,
      lookupStatus: { contracts: "error", rfx: "error" },
      lookupError: "schema_ensure_failed",
    };
  }

  try {
    const [ctr, rfx] = await Promise.all([
      resolveTableForPin(env, "passport_contracts", pin),
      resolveTableForPin(env, "passport_rfx", pin),
    ]);
    return {
      contracts: ctr.rows,
      rfx: rfx.rows,
      contractJoin: ctr.join,
      rfxJoin: rfx.join,
      lookupStatus: { contracts: "ok", rfx: "ok" },
    };
  } catch (e) {
    const kind = classifyLookupError(e);
    console.error("passport lookup failed:", kind, String(e?.message || e));
    return {
      contracts: [],
      rfx: [],
      contractJoin: null,
      rfxJoin: null,
      lookupStatus: { contracts: "error", rfx: "error" },
      lookupError: kind,
    };
  }
}

// Re-export pure join helpers for tests / other modules.
export { joinPinToEpin, normId };
