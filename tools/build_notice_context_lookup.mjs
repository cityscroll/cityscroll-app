#!/usr/bin/env node

/**
 * Materialize the bounded facts used by Notice context cards.
 *
 * Notice detail pages must not scan the resident money snapshot on the
 * browser's readiness path. This lookup keeps the source vintage and the
 * exact aggregates needed by the existing copy, while leaving the source
 * snapshot as the authoritative input.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "site/data/money_resident_snapshot.json");
const OUTPUT = join(ROOT, "site/data/notice_context_lookup.json");
const MONEY_HONESTY_CAP = 10_000_000_000;
const DAY_MS = 86_400_000;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function awardRow(row) {
  const amount = Number(row?.contract_amount);
  return row?.type_of_notice_description === "Award"
    && Number.isFinite(amount)
    && amount > 0
    && amount < MONEY_HONESTY_CAP;
}

function buildAgencyFacts(rows, asOf) {
  const yearCut = asOf - 365 * DAY_MS;
  const byAgency = new Map();
  for (const row of rows) {
    const agency = clean(row?.agency_name);
    if (!agency) continue;
    const facts = byAgency.get(agency) || {
      solicitationWindows: [],
      awards: [],
    };
    const start = timestamp(row?.start_date);
    const due = timestamp(row?.due_date);
    if (row?.type_of_notice_description === "Solicitation" && start != null && due != null) {
      const days = Math.round((due - start) / DAY_MS);
      if (days > 0 && days < 400 && facts.solicitationWindows.length < 200) {
        facts.solicitationWindows.push(days);
      }
    }
    if (awardRow(row) && start != null && start > yearCut) facts.awards.push(row);
    byAgency.set(agency, facts);
  }
  const result = new Map();
  for (const [agency, facts] of byAgency) {
    const windows = [...facts.solicitationWindows].sort((left, right) => left - right);
    const awards = facts.awards;
    result.set(agency, {
      agency_ad_median_days: windows.length >= 8 ? windows[Math.floor(windows.length / 2)] : null,
      agency_ad_sample_count: windows.length,
      agency_award_count_12m: awards.length,
      agency_award_total_12m: awards.reduce((sum, row) => sum + Number(row.contract_amount || 0), 0),
      awards: awards.slice(),
    });
  }
  return result;
}

export function buildNoticeContextLookup(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const sourceGeneratedAt = snapshot?.generated_at || null;
  const sourceTimestamp = timestamp(sourceGeneratedAt) ?? 0;
  const agencyFacts = buildAgencyFacts(rows, sourceTimestamp);
  const byNotice = {};
  const ninetyDayCut = sourceTimestamp - 90 * DAY_MS;

  for (const row of rows) {
    const id = clean(row?.request_id);
    if (!id) continue;
    const agency = agencyFacts.get(clean(row?.agency_name));
    const awards = agency?.awards || [];
    const amount = Number(row?.contract_amount);
    const vendor = clean(row?.vendor_name);
    const vendorAwards = vendor
      ? awards.filter((candidate) => clean(candidate?.vendor_name) === vendor)
      : [];
    const vendorRecentAwards = vendorAwards.filter((candidate) => {
      const start = timestamp(candidate?.start_date);
      return start != null && start > ninetyDayCut;
    });
    const atOrBelow = awardRow(row) && Number.isFinite(amount)
      ? awards.filter((candidate) => Number(candidate.contract_amount) <= amount).length
      : 0;
    byNotice[id] = {
      agency_ad_median_days: agency?.agency_ad_median_days ?? null,
      agency_ad_sample_count: agency?.agency_ad_sample_count || 0,
      agency_award_count_12m: agency?.agency_award_count_12m || 0,
      agency_award_total_12m: agency?.agency_award_total_12m || 0,
      agency_awards_at_or_below: atOrBelow,
      vendor_award_count_90d: vendorRecentAwards.length,
      vendor_award_total_12m: vendorAwards.reduce((sum, candidate) => sum + Number(candidate.contract_amount || 0), 0),
    };
  }

  return {
    schema_version: 1,
    delivery_tier: "resident-snapshot",
    source: "site/data/money_resident_snapshot.json",
    source_generated_at: sourceGeneratedAt,
    count: Object.keys(byNotice).length,
    by_notice: byNotice,
  };
}

async function main() {
  const snapshot = JSON.parse(await readFile(INPUT, "utf8"));
  const rendered = `${JSON.stringify(buildNoticeContextLookup(snapshot), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(OUTPUT, "utf8").catch(() => null), rendered,
      "site/data/notice_context_lookup.json is stale; rebuild with node tools/build_notice_context_lookup.mjs");
  } else {
    await writeFile(OUTPUT, rendered);
    process.stdout.write(`wrote ${OUTPUT}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
