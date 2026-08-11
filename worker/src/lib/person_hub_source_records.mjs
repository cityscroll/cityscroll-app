// Immutable person-hub constellation observations for entity-resolution replay.
// Host-side builders materialize public person hub + influence lookups; when
// dual-write is enabled the raw publisher SODA rows are retained independently
// under stable source keys.
// Shadow only: public person/official pages do not read these rows.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const PERSON_HUB_SOURCE_RECORD_DUAL_WRITE_FLAG =
  "PERSON_HUB_SOURCE_RECORD_DUAL_WRITE";

export const NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM = "nyc_council_members";
export const CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM = "city_clerk_elobbyist";
export const CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM = "cfb_campaign_contributions";

/** D1 batch size for observation inserts (bound statements stay under request limits). */
export const PERSON_HUB_SOURCE_RECORD_BATCH = 40;

function normPart(value, fallback = "unknown") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function readFirst(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === 0 || value === false) return value;
    if (value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

/**
 * Publisher-stable identity for one Council Members term row (uvw5-9znb).
 * Shape: council-member:<council_member_id>:<term_start>
 */
export function councilMemberSourceSystemId(row) {
  const personId = normPart(
    readFirst(row, ["council_member_id", "person_id", "PersonId"]),
    "no-person-id",
  );
  const termStart = normPart(
    readFirst(row, ["term_start", "termStart"]),
    "no-term-start",
  ).slice(0, 10);
  return `council-member:${personId}:${termStart}`;
}

/**
 * Publisher-stable identity for one eLobbyist registration/target row (fmf3-knd8).
 * Shape: lobby-reg:<registration_id>:<client>:<lobbyist>:<report_year>:<targets_hash>
 *
 * Targets text is hashed so multi-target rows under one registration stay distinct
 * without storing a giant free-text key.
 */
export function elobbyistSourceSystemId(row) {
  const reg = normPart(
    readFirst(row, ["registration_id", "registrationId"]),
    "no-registration-id",
  );
  const client = normPart(readFirst(row, ["client_name", "clientName"]), "no-client")
    .toUpperCase()
    .slice(0, 80);
  const lobbyist = normPart(
    readFirst(row, ["lobbyist_name", "lobbyistName"]),
    "no-lobbyist",
  )
    .toUpperCase()
    .slice(0, 80);
  const year = normPart(readFirst(row, ["report_year", "reportYear"]), "noyear");
  const targets = String(
    readFirst(row, ["lobbyist_targets", "lobbyistTargets"]) || "",
  );
  const targetsHash = simpleHash(targets).slice(0, 12);
  return `lobby-reg:${reg}:${client}:${lobbyist}:${year}:${targetsHash}`;
}

/**
 * Publisher-stable identity for one CFB contribution row (rjkp-yttg).
 * Shape: cfb-contrib:<recipid>:<donor>:<election>:<amount>:<officecd>
 *
 * CFB lacks a stable transaction id on the public sample columns; this composite
 * keeps multi-donor days distinct without inventing an id.
 */
export function cfbContributionSourceSystemId(row) {
  const recip = normPart(readFirst(row, ["recipid", "recipId"]), "no-recipid");
  const donor = normPart(readFirst(row, ["name", "donor_name", "donorName"]), "no-donor")
    .toUpperCase()
    .slice(0, 80);
  const election = normPart(readFirst(row, ["election"]), "no-election");
  const amount = Number.isFinite(Number(row?.amnt ?? row?.amount))
    ? String(Number(row.amnt ?? row.amount))
    : normPart(row?.amnt ?? row?.amount, "0");
  const office = normPart(readFirst(row, ["officecd", "office_cd"]), "no-office");
  return `cfb-contrib:${recip}:${donor}:${election}:${amount}:${office}`;
}

/** Tiny non-crypto hash for source-key tails (stable across runtimes). */
export function simpleHash(text) {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function writeStreamChunks(env, insert, sourceSystem, idFn, rows, ingestedAt) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return { source_system: sourceSystem, written: 0, skipped: "empty", failed: false };
  }

  let written = 0;
  try {
    for (let i = 0; i < list.length; i += PERSON_HUB_SOURCE_RECORD_BATCH) {
      const chunk = list.slice(i, i + PERSON_HUB_SOURCE_RECORD_BATCH);
      const stmts = await Promise.all(chunk.map(async (row) => {
        const snapshot = { ...row };
        return insert.bind(
          sourceSystem,
          idFn(row),
          await computeSourceRecordHash(snapshot),
          JSON.stringify(snapshot),
          JSON.stringify(snapshot),
          ingestedAt,
        );
      }));
      await env.DB.batch(stmts);
      written += chunk.length;
    }
    return { source_system: sourceSystem, written, skipped: null, failed: false };
  } catch (err) {
    const message = String(err?.message || err || "batch-failed");
    console.error(
      "person-hub source_records dual-write failed:",
      sourceSystem,
      `written_before_fail=${written}`,
      message,
    );
    return {
      source_system: sourceSystem,
      written,
      skipped: null,
      failed: true,
      error: message,
    };
  }
}

/**
 * Fail-soft dual-write of raw person-hub constellation rows into source_records.
 * Never throws; never blocks public person hub materialization.
 * Streams are isolated so one failed bag cannot zero another stream's writes.
 *
 * @param {object} env
 * @param {{
 *   councilMembers?: object[],
 *   elobbyist?: object[],
 *   cfbContributions?: object[],
 * }} bags
 * @param {string} [ingestedAt]
 */
export async function dualWritePersonHubObservations(env, bags = {}, ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, PERSON_HUB_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off", failed: false, streams: [] };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db", failed: false, streams: [] };

  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema", failed: false, streams: [] };
  }

  const streamDefs = [
    {
      sourceSystem: NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM,
      rows: bags.councilMembers,
      idFn: councilMemberSourceSystemId,
    },
    {
      sourceSystem: CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM,
      rows: bags.elobbyist,
      idFn: elobbyistSourceSystemId,
    },
    {
      sourceSystem: CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM,
      rows: bags.cfbContributions,
      idFn: cfbContributionSourceSystemId,
    },
  ];

  const at = ingestedAt || new Date().toISOString();
  const streams = [];
  for (const def of streamDefs) {
    // Isolate each stream so a single bag failure cannot roll back others.
    // eslint-disable-next-line no-await-in-loop
    const result = await writeStreamChunks(env, insert, def.sourceSystem, def.idFn, def.rows, at);
    streams.push(result);
  }

  const written = streams.reduce((sum, s) => sum + (s.written || 0), 0);
  const failed = streams.some((s) => s.failed);
  const allEmpty = streams.every((s) => s.skipped === "empty" || s.written === 0);
  let skipped = null;
  if (!written && !failed && allEmpty) skipped = "empty";
  if (!written && failed) skipped = "failed";

  if (failed) {
    console.error(
      "person-hub source_records dual-write summary:",
      JSON.stringify({ written, failed, streams }),
    );
  }

  return { written, skipped, failed, streams };
}
