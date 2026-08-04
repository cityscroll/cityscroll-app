#!/usr/bin/env node
/**
 * Materialize site/data/land_upcoming_hearings.json from published ZAP hearing evidence.
 *
 * Production path (--live): list sell-facing land projects from Open Data
 * (hgx4-8ukb), polite-fetch each project from the ZAP API, extract hearing
 * disposition venue / livestream / datetime plus accepted meeting milestones,
 * then keep only upcoming rows. Never pads with synthetic demo rows.
 *
 * Offline path (--fixture): committed test fixtures under
 * test/fixtures/zap_hearing_logistics/ only (for unit characterization).
 *
 *   node tools/build_land_upcoming_hearings.mjs --live
 *   node tools/build_land_upcoming_hearings.mjs --fixture
 *   node tools/build_land_upcoming_hearings.mjs --check
 *   node tools/build_land_upcoming_hearings.mjs --live --limit 20
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LAND_HEARING_SWEEP_STATUSES,
  materializationRowsFromZapApiPayload,
  buildUpcomingHearingsSnapshot,
  buildMaterializationReceipt,
  detectSyntheticUpcomingHearings,
  isSyntheticHearingRow,
} from "./lib/land_upcoming_hearings.mjs";
import {
  ZAP_API_BASE,
  ZAP_SODA_PROJECTS,
  parseZapApiProject,
} from "../worker/src/lib/zap_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/land_upcoming_hearings.json");
const RECEIPT = join(
  ROOT,
  "warehouse/receipts/proof/land_upcoming_hearings_latest.json",
);
const FIX_DIR = join(ROOT, "test/fixtures/zap_hearing_logistics");
const SODA_BASE = "https://data.cityofnewyork.us/resource";
const USER_AGENT =
  "CityScroll land-upcoming-hearings/1.0 (+https://cityscroll.org; civic precompute)";
/** Floor for live ZAP API cadence (ms) — matches polite host-side collectors. */
const MIN_POLITE_DELAY_MS = 300;
const DEFAULT_POLITE_DELAY_MS = 350;
const DEFAULT_MAX_PROJECTS = 500;

function parseArgs(argv) {
  const out = {
    check: false,
    live: false,
    fixture: false,
    limit: null,
    delayMs: DEFAULT_POLITE_DELAY_MS,
    today: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--live") out.live = true;
    else if (a === "--fixture") out.fixture = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--polite-delay-ms") out.delayMs = Number(argv[++i]);
    else if (a === "--today") out.today = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.live && out.fixture) {
    throw new Error("use either --live or --fixture, not both");
  }
  if (out.live && Number(out.delayMs) < MIN_POLITE_DELAY_MS) {
    throw new Error(`live ZAP cadence must be at least ${MIN_POLITE_DELAY_MS} ms`);
  }
  return out;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function emptyMilestoneReview() {
  return {
    published_meeting_dates_evaluated: 0,
    hearing_shaped_candidates_reviewed: 0,
    accepted_by_class: {},
    reviewed_false_positive_sample: [],
  };
}

function mergeMilestoneReview(target, next) {
  target.published_meeting_dates_evaluated += next?.published_meeting_dates_evaluated || 0;
  target.hearing_shaped_candidates_reviewed += next?.hearing_shaped_candidates_reviewed || 0;
  for (const [eventClass, count] of Object.entries(next?.accepted_by_class || {})) {
    target.accepted_by_class[eventClass] = (target.accepted_by_class[eventClass] || 0) + count;
  }
  for (const row of next?.reviewed_false_positive_sample || []) {
    const key = `${row.project_id}|${row.source_title}|${row.meeting_date}`;
    if (target.reviewed_false_positive_sample.some((item) => (
      `${item.project_id}|${item.source_title}|${item.meeting_date}` === key
    ))) continue;
    if (target.reviewed_false_positive_sample.length >= 12) break;
    target.reviewed_false_positive_sample.push(row);
  }
  return target;
}

async function fetchJson(url, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List sell-facing project_ids (+ borough/name/status) from Open Data SODA.
 * Fail-soft per status so one query outage still yields others.
 */
export async function listActiveLandProjects({
  fetchImpl = fetchJson,
  statuses = LAND_HEARING_SWEEP_STATUSES,
  max = DEFAULT_MAX_PROJECTS,
} = {}) {
  const cap = Math.max(1, Math.min(Number(max) || DEFAULT_MAX_PROJECTS, 1000));
  const ordered = [];
  const seen = new Set();

  for (const status of statuses) {
    if (ordered.length >= cap) break;
    const remaining = cap - ordered.length;
    const where = `public_status='${String(status).replace(/'/g, "''")}'`;
    const url =
      `${SODA_BASE}/${ZAP_SODA_PROJECTS}.json`
      + `?$select=project_id,project_name,public_status,borough,current_milestone_date`
      + `&$where=${encodeURIComponent(where)}`
      + `&$order=current_milestone_date DESC`
      + `&$limit=${remaining}`;
    let rows = [];
    try {
      rows = await fetchImpl(url, { timeoutMs: 20000 });
    } catch (e) {
      console.warn(`SODA list failed for status=${status}: ${e.message || e}`);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = String(row.project_id || "").trim();
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id)) continue;
      const key = id.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push({
        project_id: id,
        project_name: row.project_name || null,
        public_status: row.public_status || status,
        borough: row.borough || null,
      });
      if (ordered.length >= cap) break;
    }
  }
  return ordered;
}

/**
 * Polite sequential ZAP API sweep → hearing logistics rows.
 */
export async function sweepHearingLogistics(projects, {
  fetchImpl = fetchJson,
  delayMs = DEFAULT_POLITE_DELAY_MS,
  onProgress = null,
} = {}) {
  const all = [];
  const milestoneReview = emptyMilestoneReview();
  let fetched = 0;
  let failed = 0;
  for (let i = 0; i < projects.length; i++) {
    const meta = projects[i];
    const url = `${ZAP_API_BASE}/projects/${encodeURIComponent(meta.project_id)}`;
    try {
      const payload = await fetchImpl(url, { timeoutMs: 25000 });
      const result = materializationRowsFromZapApiPayload(payload, meta);
      all.push(...result.hearings);
      mergeMilestoneReview(milestoneReview, result.milestone_review);
      fetched += 1;
    } catch (e) {
      failed += 1;
      console.warn(`ZAP fetch failed ${meta.project_id}: ${e.message || e}`);
    }
    if (typeof onProgress === "function" && ((i + 1) % 20 === 0 || i + 1 === projects.length)) {
      onProgress({ index: i + 1, total: projects.length, fetched, failed, hearings: all.length });
    }
    if (i + 1 < projects.length && delayMs > 0) await wait(delayMs);
  }
  return {
    hearings: all,
    projects_fetched: fetched,
    projects_failed: failed,
    milestone_review: milestoneReview,
  };
}

/**
 * Offline fixture path — only files under test/fixtures/zap_hearing_logistics.
 * Never invents synthetic future rows.
 */
export function loadFixtureHearings({ fixtureDir = FIX_DIR } = {}) {
  return loadFixtureMaterialization({ fixtureDir }).hearings;
}

/** Fixture equivalent of the live sweep, including bounded review measurements. */
export function loadFixtureMaterialization({ fixtureDir = FIX_DIR } = {}) {
  const out = [];
  const milestoneReview = emptyMilestoneReview();
  if (!existsSync(fixtureDir)) return { hearings: out, milestone_review: milestoneReview };
  const names = readdirSync(fixtureDir).filter((n) => n.endsWith(".json")).sort();
  for (const name of names) {
    const path = join(fixtureDir, name);
    let payload;
    try {
      payload = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const record = parseZapApiProject(payload);
    if (!record?.project_id) continue;
    // Borough from filename project id letter when Open Data meta is absent.
    const letter = (record.project_id.match(/^\d{4}([A-Z])/) || [])[1];
    const boroughFromId = {
      M: "Manhattan",
      X: "Bronx",
      K: "Brooklyn",
      Q: "Queens",
      R: "Staten Island",
      Y: "Citywide",
    }[letter] || null;
    const result = materializationRowsFromZapApiPayload(payload, {
      project_id: record.project_id,
      borough: boroughFromId,
    });
    out.push(...result.hearings);
    mergeMilestoneReview(milestoneReview, result.milestone_review);
  }
  // Strip any accidental synthetic markers if a fixture was mislabeled.
  return {
    hearings: out.filter((row) => !isSyntheticHearingRow(row)),
    milestone_review: milestoneReview,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCheck() {
  if (!existsSync(OUT)) {
    console.error("missing", OUT);
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(OUT, "utf8"));
  const detection = detectSyntheticUpcomingHearings(committed);
  if (!detection.ok) {
    console.error("land_upcoming_hearings detector findings:");
    for (const f of detection.findings) {
      console.error(" -", JSON.stringify(f));
    }
    process.exit(1);
  }
  // Materialization metadata should be present on post-job payloads.
  if (committed.materialization && committed.materialization.mode === "synthetic") {
    console.error("materialization.mode must not be synthetic");
    process.exit(1);
  }
  const n = committed.hearings.length;
  console.log(
    "ok land_upcoming_hearings",
    n,
    "mode=",
    committed.materialization?.mode || "legacy",
    detection.ok ? "detector=pass" : "detector=fail",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node tools/build_land_upcoming_hearings.mjs --live [--limit N] [--polite-delay-ms 350]
  node tools/build_land_upcoming_hearings.mjs --fixture [--today YYYY-MM-DD]
  node tools/build_land_upcoming_hearings.mjs --check`);
    return;
  }

  if (args.check && !args.live && !args.fixture) {
    runCheck();
    return;
  }

  if (!args.live && !args.fixture) {
    console.error(
      "refusing to write: pass --live (production materialization) or --fixture (tests only).",
    );
    process.exit(2);
  }

  const today = args.today || new Date().toISOString().slice(0, 10);
  let allHearings = [];
  let projectsListed = 0;
  let projectsFetched = 0;
  let projectsFailed = 0;
  let milestoneReview = emptyMilestoneReview();
  let mode = args.live ? "live" : "fixture";

  if (args.fixture) {
    const fixture = loadFixtureMaterialization();
    allHearings = fixture.hearings;
    milestoneReview = fixture.milestone_review;
    projectsListed = new Set(allHearings.map((h) => h.project_id).filter(Boolean)).size;
    projectsFetched = projectsListed;
  } else {
    const max = args.limit && Number.isFinite(args.limit) ? args.limit : DEFAULT_MAX_PROJECTS;
    console.log(
      `listing sell-facing ZAP projects (statuses=${LAND_HEARING_SWEEP_STATUSES.join("|")}, max=${max})…`,
    );
    const projects = await listActiveLandProjects({ max });
    projectsListed = projects.length;
    console.log(`listed ${projectsListed}; sweeping ZAP API (delay=${args.delayMs}ms)…`);
    const sweep = await sweepHearingLogistics(projects, {
      delayMs: args.delayMs,
      onProgress: ({ index, total, fetched, failed, hearings }) => {
        console.log(
          `  progress ${index}/${total} fetched=${fetched} failed=${failed} hearings=${hearings}`,
        );
      },
    });
    allHearings = sweep.hearings;
    projectsFetched = sweep.projects_fetched;
    projectsFailed = sweep.projects_failed;
    milestoneReview = sweep.milestone_review;
  }

  const snap = buildUpcomingHearingsSnapshot(allHearings, {
    today,
    mode,
    projects_listed: projectsListed,
    projects_fetched: projectsFetched,
    projects_failed: projectsFailed,
    statuses: LAND_HEARING_SWEEP_STATUSES.slice(),
    polite_delay_ms: args.live ? args.delayMs : null,
    milestone_review: milestoneReview,
  });

  const detection = detectSyntheticUpcomingHearings(snap);
  if (!detection.ok) {
    console.error("refusing to write synthetic/untraceable rows:");
    for (const f of detection.findings) console.error(" -", JSON.stringify(f));
    process.exit(1);
  }

  const receipt = buildMaterializationReceipt(snap, {
    out: "site/data/land_upcoming_hearings.json",
    fixture_scoped: mode === "fixture",
    milestone_review: milestoneReview,
  });

  if (args.dryRun) {
    console.log(JSON.stringify({ snapshot: snap, receipt }, null, 2));
    return;
  }

  writeJson(OUT, snap);
  writeJson(RECEIPT, receipt);
  console.log(
    "wrote",
    OUT,
    "hearings=",
    snap.hearings.length,
    "extracted=",
    allHearings.length,
    "mode=",
    mode,
  );
  console.log("wrote", RECEIPT);

  if (args.check) runCheck();
}

// Allow unit tests to import helpers without running main.
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
