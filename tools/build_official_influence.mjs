#!/usr/bin/env node
/**
 * Measure and materialize official influence edges:
 *   - eLobbyist (fmf3-knd8) Org → Lobbyist → Official
 *   - CFB contributions (rjkp-yttg) Donor → Official recipient
 *
 * Flywheel gates: usefulness ≥ 30% and reviewed precision ≥ 95%.
 *
 *   node tools/build_official_influence.mjs
 *   node tools/build_official_influence.mjs --fixture
 *   node tools/build_official_influence.mjs --check
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  measureLobbyTargetJoin,
  buildLobbyInfluenceLookup,
  measureCfbRecipientJoin,
  buildCfbInfluenceLookup,
} from "../site/official_influence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = path.join(ROOT, "site/data/person_hub_lookup.json");
const LOBBY_OUT = path.join(ROOT, "site/data/official_lobby_influence_lookup.json");
const CFB_OUT = path.join(ROOT, "site/data/official_cfb_influence_lookup.json");
const RECEIPT_DIR = path.join(ROOT, "site/data/person_hub_sources/verification_receipts");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/person_hub");
const UA = "CityScroll/1.0 (+https://cityscroll.org; official-influence measure)";

const LOBBY_SODA = "https://data.cityofnewyork.us/resource/fmf3-knd8.json";
const CFB_SODA = "https://data.cityofnewyork.us/resource/rjkp-yttg.json";

// Kill-sample sizes: large enough for rate stability, small enough for CI/fixture.
const LOBBY_KILL_LIMIT = 2000;
const CFB_KILL_LIMIT = 5000;
const LOBBY_MATERIALIZE_LIMIT = 8000;
const CFB_MATERIALIZE_LIMIT = 12000;

function parseArgs(argv) {
  const out = { check: false, fixture: false };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a === "--fixture") out.fixture = true;
  }
  return out;
}

async function sodaPage(base, { where, select, order, limit, offset }) {
  const params = new URLSearchParams();
  if (where) params.set("$where", where);
  if (select) params.set("$select", select);
  if (order) params.set("$order", order);
  params.set("$limit", String(limit));
  if (offset) params.set("$offset", String(offset));
  const url = `${base}?${params}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SODA HTTP ${res.status} for ${base}`);
  return res.json();
}

async function sodaCollect(base, opts, maxRows) {
  const rows = [];
  let offset = 0;
  const page = Math.min(1000, maxRows);
  while (rows.length < maxRows) {
    const batch = await sodaPage(base, {
      ...opts,
      limit: page,
      offset,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < page) break;
    offset += page;
  }
  return rows.slice(0, maxRows);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function receiptDate() {
  return new Date().toISOString().slice(0, 10);
}

function mainCheck() {
  for (const file of [LOBBY_OUT, CFB_OUT, HUB]) {
    if (!existsSync(file)) {
      console.error(`missing ${path.relative(ROOT, file)}`);
      process.exit(1);
    }
  }
  const lobby = JSON.parse(readFileSync(LOBBY_OUT, "utf8"));
  const cfb = JSON.parse(readFileSync(CFB_OUT, "utf8"));
  const hub = JSON.parse(readFileSync(HUB, "utf8"));
  if (!hub.gate?.promoted) {
    console.error("person hub must be promoted before influence checks");
    process.exit(1);
  }
  if (!lobby.gate || lobby.measurement?.usefulness == null) {
    console.error("lobby influence missing measurement");
    process.exit(1);
  }
  if (!cfb.gate || cfb.measurement?.usefulness == null) {
    console.error("cfb influence missing measurement");
    process.exit(1);
  }
  // When promoted, expect demo Marte to have at least one edge path available in corpus,
  // but do not require every official to appear in the kill sample.
  console.log(
    `official_influence ok lobby_promoted=${lobby.gate.promoted} `
    + `lobby_use=${lobby.measurement.usefulness} lobby_prec=${lobby.measurement.precision} `
    + `cfb_promoted=${cfb.gate.promoted} cfb_use=${cfb.measurement.usefulness} `
    + `lobby_edges=${lobby.edge_count} cfb_edges=${cfb.edge_count}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    mainCheck();
    return;
  }

  if (!existsSync(HUB)) {
    throw new Error("person hub missing — run node tools/build_person_hub.mjs first");
  }
  const hub = JSON.parse(readFileSync(HUB, "utf8"));
  const observedOn = receiptDate();
  const retrievedAt = new Date().toISOString();

  let lobbyRows;
  let cfbRows;
  if (args.fixture) {
    lobbyRows = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "elobbyist_sample.json"), "utf8"));
    cfbRows = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "cfb_sample.json"), "utf8"));
  } else {
    lobbyRows = await sodaCollect(
      LOBBY_SODA,
      {
        where: "report_year>='2020' AND lobbyist_targets IS NOT NULL",
        select: "client_name,lobbyist_name,lobbyist_targets,compensation_total,report_year,registration_id",
        order: "report_year DESC",
      },
      LOBBY_MATERIALIZE_LIMIT,
    );
    cfbRows = await sodaCollect(
      CFB_SODA,
      {
        where: "election>='2021' AND officecd='5'",
        select: "name,recipid,recipname,candfirst,amnt,election,date,officecd",
        order: "date DESC",
      },
      CFB_MATERIALIZE_LIMIT,
    );
  }

  const lobbyKill = lobbyRows.slice(0, LOBBY_KILL_LIMIT);
  const cfbKill = cfbRows.slice(0, CFB_KILL_LIMIT);

  const lobbyMeasure = measureLobbyTargetJoin(lobbyKill, hub);
  const cfbMeasure = measureCfbRecipientJoin(cfbKill, hub);

  const lobbyLookup = buildLobbyInfluenceLookup({
    lobbyRows: lobbyMeasure.gate.promoted ? lobbyRows : lobbyKill,
    personHubLookup: hub,
    measurement: lobbyMeasure,
    retrievedAt,
  });
  const cfbLookup = buildCfbInfluenceLookup({
    cfbRows: cfbMeasure.gate.promoted ? cfbRows : cfbKill,
    personHubLookup: hub,
    measurement: cfbMeasure,
    retrievedAt,
  });

  writeJson(LOBBY_OUT, lobbyLookup);
  writeJson(CFB_OUT, cfbLookup);

  const receipt = {
    schema: "cityscroll.person_hub_influence_receipt.v1",
    observed_on: observedOn,
    observed_at_utc: retrievedAt,
    sources: {
      person_hub: "uvw5-9znb",
      elobbyist: "fmf3-knd8",
      campaign_contributions: "rjkp-yttg",
    },
    person_hub: {
      person_count: hub.person_count,
      vote_corpus_join_rate: hub.join?.vote_corpus_join_rate,
      demo_pass: hub.gate?.demo_person_id_pass,
      promoted: hub.gate?.promoted,
    },
    lobby: {
      kill_sample_rows: lobbyKill.length,
      person_shaped_mentions: lobbyMeasure.person_shaped_mentions,
      joined_mentions: lobbyMeasure.joined_mentions,
      usefulness: lobbyMeasure.usefulness,
      precision: lobbyMeasure.precision,
      reviewed_sample_size: lobbyMeasure.reviewed_sample_size,
      gate: lobbyMeasure.gate,
      edge_count: lobbyLookup.edge_count,
      person_count: lobbyLookup.person_count || 0,
      reviewed: lobbyMeasure.reviewed.filter((r) => r.label === "same" || r.label === "reject").slice(0, 40),
    },
    cfb: {
      kill_sample_rows: cfbKill.length,
      distinct_recipients: cfbMeasure.distinct_recipients,
      joined_recipients: cfbMeasure.joined_recipients,
      usefulness: cfbMeasure.usefulness,
      precision: cfbMeasure.precision,
      reviewed_sample_size: cfbMeasure.reviewed_sample_size,
      gate: cfbMeasure.gate,
      edge_count: cfbLookup.edge_count,
      person_count: cfbLookup.person_count || 0,
      reviewed: cfbMeasure.reviewed.slice(0, 40),
    },
    verdict: {
      person_hub: hub.gate?.promoted ? "SHIP person identity family" : "STOP person hub",
      lobby: lobbyMeasure.gate.promoted
        ? "SHIP lobby edges (usefulness and precision cleared)"
        : "STOP lobby edges — below usefulness or precision gate",
      cfb: cfbMeasure.gate.promoted
        ? "SHIP CFB recipient edges (usefulness and precision cleared)"
        : "STOP CFB edges — below usefulness or precision gate",
      official_constellation:
        "Vote retention event gate (≥30 distinct roll-call events) is independent; person hub does not force constellation promotion.",
    },
  };
  writeJson(
    path.join(RECEIPT_DIR, `person_hub_influence_${observedOn}.json`),
    receipt,
  );

  console.log(JSON.stringify({
    lobby_usefulness: lobbyMeasure.usefulness,
    lobby_precision: lobbyMeasure.precision,
    lobby_promoted: lobbyMeasure.gate.promoted,
    lobby_edges: lobbyLookup.edge_count,
    cfb_usefulness: cfbMeasure.usefulness,
    cfb_precision: cfbMeasure.precision,
    cfb_promoted: cfbMeasure.gate.promoted,
    cfb_edges: cfbLookup.edge_count,
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
