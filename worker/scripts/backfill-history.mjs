#!/usr/bin/env node
// ONE-TIME migration: seed the permanent daily-history counters (`hist:digest:<day>`,
// `hist:nl_search:<day>`) that power the /stats "over time" chart, from whatever
// short-window counters were still live in KV when this ran — `sendcount:<day>` (digests,
// 40-day TTL) and `nl:<day>` (searches, 2-day TTL). Those are the only two sources that
// turned out to hold recoverable day-by-day history; see the PR description for the full
// inventory (subscription records have a createdAt but too few subs to chart; the
// D1 database holds no usage data; Cloudflare's own request analytics has no per-route
// breakdown, so it can't honestly stand in for "digests sent" or "searches asked").
//
// Idempotent: a hist:<metric>:<day> key that already exists is left alone, and "today" is
// never touched (today's count belongs to the live counters this same deploy starts writing
// going forward — backfilling it too would double it). Rerunning this is always safe and,
// once every recoverable day has been seeded, a no-op.
//
// Run once against production: `node worker/scripts/backfill-history.mjs`.
// Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) with workers_kv:write on this account.

import { execFileSync } from "node:child_process";
import { STATS_TTL } from "../src/lib/stats.mjs";

const ALERT_STATE_ID = "451ce64e616b49b6837682e75cb07756";
const NL_METER_ID = "f410ee870b954e2980ee646312704014";

// ttlDays gates whether gap days between the earliest recovered day and today can be safely
// written as a confirmed zero (source counter's own retention window still covers the whole
// gap, so "no key" can only mean "genuinely nothing happened") vs. left unrecorded (the
// source's retention window is shorter than the gap, so a missing key might just mean the
// real count already expired — a gap here means "unknown," not "zero").
const SOURCES = [
  // sendcount:<day>, 40-day TTL (see alerts.mjs) — comfortably covers the whole recoverable
  // window, so digest gaps are safe to zero-fill.
  { metric: "digest", namespaceId: ALERT_STATE_ID, sourcePrefix: "sendcount:", ttlDays: STATS_TTL / 86400 },
  // nl:<day>, 2-day TTL (see nl.mjs) — a gap could just as easily be an already-expired real
  // count as a real zero, so nl_search gaps are left unrecorded, never zero-filled.
  { metric: "nl_search", namespaceId: NL_METER_ID, sourcePrefix: "nl:", ttlDays: 172800 / 86400 },
];

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function kvGet(key, namespaceId) {
  try {
    return wrangler(["kv", "key", "get", key, "--namespace-id", namespaceId, "--remote"]).trim();
  } catch {
    return null; // missing key — wrangler exits non-zero
  }
}

function kvPut(key, value, namespaceId) {
  wrangler(["kv", "key", "put", key, value, "--namespace-id", namespaceId, "--remote"]);
}

function kvListDays(prefix, namespaceId) {
  const raw = wrangler(["kv", "key", "list", "--namespace-id", namespaceId, "--remote", "--prefix", prefix]);
  return JSON.parse(raw)
    .map((k) => k.name.slice(prefix.length))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

export function allDaysInRange(start, endExclusive) {
  const out = [];
  let d = start;
  while (d < endExclusive) {
    out.push(d);
    d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  }
  return out;
}

function backfillMetric({ metric, namespaceId, sourcePrefix, ttlDays }, today) {
  console.log(`\n== ${metric} ==`);
  const foundDays = kvListDays(sourcePrefix, namespaceId).filter((day) => day < today);
  const oldest = foundDays.sort()[0];
  // Safe to zero-fill only if the source's own TTL comfortably covers the full gap from the
  // earliest recovered day to today — otherwise a missing day could just be an
  // already-expired real count, not a real zero.
  const canZeroFill = oldest != null && ttlDays > daysBetween(oldest, today);
  const days = canZeroFill ? allDaysInRange(oldest, today) : foundDays;
  if (oldest != null && !canZeroFill) {
    console.log(`  gap days NOT zero-filled: source TTL (${ttlDays}d) is shorter than the ${daysBetween(oldest, today)}d window since the earliest recovered day — a missing day could be a lost real count, not a true zero.`);
  }

  let seeded = 0, skipped = 0, unreadable = 0;
  for (const day of days) {
    const histKey = `hist:${metric}:${day}`;
    if (kvGet(histKey, namespaceId) !== null) { skipped++; continue; }
    const raw = kvGet(`${sourcePrefix}${day}`, namespaceId);
    const n = raw === null ? 0 : parseInt(raw, 10); // present in days[] via zero-fill, but no source key → confirmed zero
    if (!Number.isFinite(n)) { unreadable++; console.log(`  skip ${day}: unreadable source value ${JSON.stringify(raw)}`); continue; }
    kvPut(histKey, String(n), namespaceId);
    console.log(`  seeded ${day} = ${n}`);
    seeded++;
  }
  console.log(`${metric}: seeded ${seeded}, already present ${skipped}, unreadable ${unreadable} (days considered: ${days.length}, zero-fill: ${canZeroFill})`);

  const eraKey = `hist:era:${metric}`;
  if (kvGet(eraKey, namespaceId) === null) {
    kvPut(eraKey, today, namespaceId);
    console.log(`  era boundary set to ${today} (first day counted live)`);
  } else {
    console.log(`  era boundary already set — leaving it alone`);
  }
}

function run() {
  const today = todayUTC();
  for (const source of SOURCES) backfillMetric(source, today);
}

// Only run against real KV when invoked directly (`node backfill-history.mjs`), not when a
// test imports this module for its pure date-math helpers.
if (import.meta.url === `file://${process.argv[1]}`) run();
