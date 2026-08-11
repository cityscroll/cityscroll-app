#!/usr/bin/env node
/**
 * Host-side person-hub constellation retention — immutable source_records-shaped
 * snapshots for Council Members, eLobbyist, and CFB contributions.
 *
 *   node tools/retain_person_hub_source_records.mjs --from-fixture
 *   node tools/retain_person_hub_source_records.mjs --from-fixture --publish
 *   node tools/retain_person_hub_source_records.mjs --check
 *
 * Live SODA pulls are available without --from-fixture (polite paging). Product
 * person hub + influence materializations remain the public reader path; this
 * job only retains publisher rows and measures the hub join.
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
  retainPersonHubConstellation,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/person_hub_source_records.mjs";
import { buildPersonHubLookup } from "../site/person_hub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/person_hub");
const HUB_PATH = path.join(ROOT, "site/data/person_hub_lookup.json");
const STAGE = path.join(ROOT, "warehouse/raw/person-hub-source-records");
const DEFAULT_RECEIPT = path.join(STAGE, "receipt.json");
const DEFAULT_SOURCE_RECORDS = path.join(STAGE, "source_records.jsonl");
const PUBLIC_PROOF = path.join(
  ROOT,
  "warehouse/receipts/proof/person_hub_source_records_latest.json",
);
const VERIFICATION_RECEIPT = path.join(
  ROOT,
  "site/data/person_hub_sources/verification_receipts/person_hub_source_records_2026-08-11.json",
);

const COUNCIL_SODA = "https://data.cityofnewyork.us/resource/uvw5-9znb.json";
const LOBBY_SODA = "https://data.cityofnewyork.us/resource/fmf3-knd8.json";
const CFB_SODA = "https://data.cityofnewyork.us/resource/rjkp-yttg.json";
const UA = "CityScroll/1.0 (+https://cityscroll.org; person-hub source-record retention)";

const LOBBY_KILL_LIMIT = 2000;
const CFB_KILL_LIMIT = 5000;

function parseArgs(argv) {
  const out = {
    fromFixture: false,
    publish: false,
    check: false,
    stageDir: STAGE,
    receipt: DEFAULT_RECEIPT,
    sourceRecords: DEFAULT_SOURCE_RECORDS,
    verificationReceipt: VERIFICATION_RECEIPT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from-fixture") out.fromFixture = true;
    else if (a === "--publish") out.publish = true;
    else if (a === "--check") out.check = true;
    else if (a === "--stage-dir") out.stageDir = path.resolve(argv[++i]);
    else if (a === "--receipt") out.receipt = path.resolve(argv[++i]);
    else if (a === "--source-records") out.sourceRecords = path.resolve(argv[++i]);
    else if (a === "--verification-receipt") {
      out.verificationReceipt = path.resolve(argv[++i]);
    }
  }
  return out;
}

async function sodaCollect(base, { where, order, maxRows }) {
  const rows = [];
  let offset = 0;
  const page = Math.min(1000, maxRows);
  while (rows.length < maxRows) {
    const params = new URLSearchParams();
    if (where) params.set("$where", where);
    if (order) params.set("$order", order);
    params.set("$limit", String(page));
    params.set("$offset", String(offset));
    const res = await fetch(`${base}?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`SODA HTTP ${res.status} for ${base}`);
    const batch = await res.json();
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

function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${(Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(r)).join("\n")}${rows?.length ? "\n" : ""}`,
  );
}

function loadHub() {
  if (!existsSync(HUB_PATH)) return null;
  return JSON.parse(readFileSync(HUB_PATH, "utf8"));
}

function mainCheck(args) {
  if (!existsSync(args.verificationReceipt)) {
    console.error(`missing verification receipt ${path.relative(ROOT, args.verificationReceipt)}`);
    process.exit(1);
  }
  const receipt = JSON.parse(readFileSync(args.verificationReceipt, "utf8"));
  if (!receipt.gates?.materialize) {
    console.error("person-hub source_records gates did not materialize");
    process.exit(1);
  }
  for (const key of ["council", "lobby", "cfb"]) {
    const u = receipt.streams?.[key]?.usefulness?.rate;
    const p = receipt.streams?.[key]?.precision?.rate;
    if (!(u >= USEFULNESS_FLOOR) || !(p >= PRECISION_FLOOR)) {
      console.error(`stream ${key} below gate usefulness=${u} precision=${p}`);
      process.exit(1);
    }
  }
  console.log(
    `person_hub_source_records ok materialize=true `
    + `council=${receipt.streams.council.usefulness.rate} `
    + `lobby=${receipt.streams.lobby.usefulness.rate} `
    + `cfb=${receipt.streams.cfb.usefulness.rate} `
    + `retained=${receipt.counts?.source_records}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    mainCheck(args);
    return;
  }

  let councilRows;
  let lobbyRows;
  let cfbRows;
  let retrievedAt = new Date().toISOString();
  let mode = "live";

  if (args.fromFixture) {
    mode = "fixture";
    retrievedAt = "fixture";
    councilRows = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, "council_members.json"), "utf8"),
    );
    lobbyRows = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, "elobbyist_sample.json"), "utf8"),
    );
    cfbRows = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, "cfb_sample.json"), "utf8"),
    );
  } else {
    councilRows = await sodaCollect(COUNCIL_SODA, {
      order: "council_member_id,term_start",
      maxRows: 5000,
    });
    lobbyRows = await sodaCollect(LOBBY_SODA, {
      order: "registration_id",
      maxRows: LOBBY_KILL_LIMIT,
    });
    cfbRows = await sodaCollect(CFB_SODA, {
      where: "officecd='5'",
      order: "recipid,name",
      maxRows: CFB_KILL_LIMIT,
    });
  }

  const hub = loadHub() || buildPersonHubLookup(councilRows);
  const result = retainPersonHubConstellation({
    councilRows,
    lobbyRows,
    cfbRows,
    personHubLookup: hub,
    ingestedAt: retrievedAt === "fixture" ? "2026-08-11T20:00:00.000Z" : retrievedAt,
  });

  const observedOn = "2026-08-11";
  const verification = {
    schema: "cityscroll.person_hub_source_records_verification.v1",
    observed_on: observedOn,
    observed_at_utc: retrievedAt === "fixture"
      ? "2026-08-11T20:00:00.000Z"
      : new Date().toISOString(),
    mode,
    sources: {
      person_hub: "uvw5-9znb",
      elobbyist: "fmf3-knd8",
      campaign_contributions: "rjkp-yttg",
    },
    kill_sample: {
      council_input_rows: result.council.counts.input_rows,
      lobby_input_rows: result.lobby.counts.input_rows,
      cfb_input_rows: result.cfb.counts.input_rows,
      strategy: mode === "fixture"
        ? "committed person_hub fixtures (council_members / elobbyist_sample / cfb_sample)"
        : "live SODA: full Council Members page; eLobbyist first 2000; CFB officecd=5 first 5000",
    },
    streams: {
      council: {
        retained: result.counts.council_retained,
        usefulness: result.measurements.council.usefulness,
        precision: result.measurements.council.precision,
        gates: result.measurements.council.gates,
      },
      lobby: {
        retained: result.counts.lobby_retained,
        usefulness: result.measurements.lobby.usefulness,
        precision: result.measurements.lobby.precision,
        gates: result.measurements.lobby.gates,
      },
      cfb: {
        retained: result.counts.cfb_retained,
        usefulness: result.measurements.cfb.usefulness,
        precision: result.measurements.cfb.precision,
        gates: result.measurements.cfb.gates,
      },
    },
    counts: result.counts,
    gates: {
      usefulness_floor: USEFULNESS_FLOOR,
      precision_floor: PRECISION_FLOOR,
      usefulness_cleared: result.gates.materialize,
      precision_cleared: result.gates.materialize,
      materialize: result.gates.materialize,
    },
    materialize: result.gates.materialize,
    notes: [
      "Retention keeps individual publisher rows as source_records-shaped snapshots.",
      "Council Members join is exact council_member_id = Legistar PersonId.",
      "eLobbyist and CFB joins reuse exact unique person-name keys (no fuzzy invent).",
      "Public person hub and influence lookups remain the reader path; dual-write is shadow-only.",
    ],
  };

  mkdirSync(args.stageDir, { recursive: true });
  writeJson(args.receipt, {
    ...verification,
    stage: path.relative(ROOT, args.stageDir),
  });
  writeJsonl(args.sourceRecords, result.source_records);

  if (args.publish || result.gates.materialize) {
    writeJson(args.verificationReceipt, verification);
    writeJson(PUBLIC_PROOF, {
      schema: "cityscroll.person_hub_source_records_proof.v1",
      observed_on: observedOn,
      materialize: result.gates.materialize,
      counts: result.counts,
      streams: {
        council_usefulness: result.measurements.council.usefulness.rate,
        lobby_usefulness: result.measurements.lobby.usefulness.rate,
        cfb_usefulness: result.measurements.cfb.usefulness.rate,
        council_precision: result.measurements.council.precision.rate,
        lobby_precision: result.measurements.lobby.precision.rate,
        cfb_precision: result.measurements.cfb.precision.rate,
      },
      verification_receipt: path.relative(ROOT, args.verificationReceipt),
    });
  }

  if (!result.gates.materialize) {
    console.error(
      "person-hub source_records below gate; retained rows staged but coverage not promoted",
    );
    console.error(JSON.stringify(result.gates, null, 2));
    process.exitCode = 2;
  }

  console.log(
    `person_hub_source_records retained=${result.counts.source_records} `
    + `council=${result.measurements.council.usefulness.rate}/`
    + `${result.measurements.council.precision.rate} `
    + `lobby=${result.measurements.lobby.usefulness.rate}/`
    + `${result.measurements.lobby.precision.rate} `
    + `cfb=${result.measurements.cfb.usefulness.rate}/`
    + `${result.measurements.cfb.precision.rate} `
    + `materialize=${result.gates.materialize}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
