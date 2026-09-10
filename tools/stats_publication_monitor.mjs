#!/usr/bin/env node
/**
 * An independent watch on the promise that a daily search-use snapshot gets published.
 *
 * The publisher already reports on itself: the scheduled refresh returns whether it verified a
 * projection, and the public summary carries the instant it was last verified. That is exactly
 * the evidence a frozen publisher keeps producing. A refresh can succeed every day, stamp a new
 * verified instant every day, and still be folding the same receipts into nothing — and every
 * self-report would read healthy while the trend stopped moving.
 *
 * So this evaluator uses none of it as evidence of success. It computes the day that should have
 * been published from its own clock, then asks two questions the publisher cannot answer for
 * itself: is that day in the stored dated series, and has the newest stored day advanced. A
 * publisher that reports a fresh verification while the newest day sits behind the promise is
 * named as frozen, which is the failure the self-report is structurally unable to see. Days
 * before measurement began are not promised: they are not_measured, never missing.
 *
 * Everything here is pure. The runner supplies the two observations; this file reads no
 * network, no store, and no credential.
 *
 *   node tools/stats_publication_monitor.mjs --observation <path> --now <instant>
 *
 * The observations carry counts, days and instants only. No query, reader, receipt or
 * identity crosses into a finding, because a finding becomes a public issue body.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { SEARCH_ACTIVITY_RETENTION_DAYS } from "../capabilities/search_activity.mjs";

export const STATS_PUBLICATION_MONITOR_SCHEMA = "cityscroll.stats_publication_finding.v1";

/** The job identity the shared outbox keys deduplication on. */
export const STATS_PUBLICATION_JOB_ID = "stats-daily-snapshot-monitor";

/**
 * One identity, for the life of the condition. Repeated observations update this issue rather
 * than opening another, and the marker keeps the match working even if the title is edited
 * by hand on the way past.
 */
export const STATS_PUBLICATION_ISSUE_TITLE = "Daily search-use snapshot was not published";
export const STATS_UNPUBLISHED_ISSUE_TITLE = "Daily search-use summary has not been published yet";
export const STATS_PUBLICATION_ISSUE_MARKER = "cityscroll-stats-daily-snapshot";

/** The stages a failure can be at, most specific first. A stage outside this set is a defect. */
export const STATS_PUBLICATION_FAILING_STAGES = Object.freeze([
  "observation-unavailable",
  "publisher-not-yet-delivered",
  "missing-daily-aggregate",
  "frozen-publisher",
  "divergent-aggregate",
  "stale-verification",
]);

/**
 * How late the promise may be before it is a failure.
 *
 * A day closes at midnight UTC and the cycle that publishes it runs after that, so the grace
 * has to cover a normal daily run plus a missed one. Verification is allowed to be a little
 * older still, because a snapshot that names the days it covers is less current with age
 * rather than untrue.
 */
export const STATS_PUBLICATION_BUDGETS = Object.freeze({
  publication_grace_hours: 30,
  verification_max_age_hours: 48,
});

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function utcDay(ms) {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The day whose aggregate should exist by now: the most recent day that closed long enough
 * ago for a normal cycle, plus one missed cycle, to have published it.
 */
export function promisedSnapshotDay(now, budgets = STATS_PUBLICATION_BUDGETS) {
  const nowMs = new Date(now).getTime();
  return utcDay(nowMs - budgets.publication_grace_hours * HOUR_MS - DAY_MS);
}

function instantMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function lastClosedUtcDay(now) {
  const nowMs = new Date(now).getTime();
  return utcDay(Math.floor(nowMs / DAY_MS) * DAY_MS - DAY_MS);
}

/**
 * The first UTC day that can ever be stored: the later of measurement start and
 * the receipt-retention horizon. Days before this are not promised.
 */
export function publicationHorizonStart({
  now,
  measuredSince = null,
  receiptRetentionDays = SEARCH_ACTIVITY_RETENTION_DAYS,
} = {}) {
  const nowMs = new Date(now).getTime();
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const retentionDays = Number.isFinite(Number(receiptRetentionDays))
    ? Number(receiptRetentionDays)
    : SEARCH_ACTIVITY_RETENTION_DAYS;
  const retentionStart = utcDay(todayStart - retentionDays * DAY_MS);
  const measuredMs = instantMs(measuredSince);
  if (measuredMs === null) return retentionStart;
  const measuredDay = utcDay(measuredMs);
  return measuredDay > retentionStart ? measuredDay : retentionStart;
}

/**
 * Closed days that publication actually promised: from
 * max(measured_since, retention_start) through the last closed UTC day.
 */
export function promisedPublicationDays({
  now,
  measuredSince = null,
  receiptRetentionDays = SEARCH_ACTIVITY_RETENTION_DAYS,
} = {}) {
  const start = publicationHorizonStart({ now, measuredSince, receiptRetentionDays });
  const end = lastClosedUtcDay(now);
  if (!start || !end || start > end) return [];
  const days = [];
  for (let ms = Date.parse(`${start}T00:00:00.000Z`); ms <= Date.parse(`${end}T00:00:00.000Z`); ms += DAY_MS) {
    days.push(utcDay(ms));
  }
  return days;
}

/** A UTC day that ended before measurement began can never be stored. */
export function dayBeforeMeasurement(day, measuredSince) {
  const measuredMs = instantMs(measuredSince);
  if (measuredMs === null || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return false;
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS <= measuredMs;
}

function resolveMeasuredSince(observation = {}) {
  const lineage = observation.lineage || {};
  const published = observation.published || {};
  return lineage.measured_since || published.measurement?.measured_since || null;
}

/**
 * Evaluate one observation.
 *
 * `observation.lineage` is the dated series as the authenticated desk reports it, and
 * `observation.published` is what the public summary currently claims about its own freshness.
 * Either may be absent; an unreadable observation is reported as a check that could not run,
 * never as a publication failure, so an outage never reads as a missed snapshot.
 */
export function evaluateStatsPublication({ now, observation = {}, budgets = STATS_PUBLICATION_BUDGETS } = {}) {
  const observedAt = new Date(now).toISOString();
  const nowMs = new Date(now).getTime();
  const promised = promisedSnapshotDay(now, budgets);
  const findings = [];
  const notes = [];
  let failingStage = null;

  const lineage = observation.lineage || null;
  const published = observation.published || null;

  if (!lineage || lineage.available !== true) {
    return {
      schema: STATS_PUBLICATION_MONITOR_SCHEMA,
      observed_at: observedAt,
      promised_day: promised,
      ok: false,
      failing_stage: "observation-unavailable",
      findings: [`the dated aggregate series could not be read (${lineage?.unavailable_reason || "no observation"})`],
      notes: ["An unreadable check is not evidence that publication failed."],
      evidence: { newest_day: null, missing_days: [], verified_at: published?.refresh?.verified_at || null },
      budgets,
    };
  }

  const newestDay = lineage.newest_day || null;
  const verifiedMs = instantMs(published?.refresh?.verified_at);
  // Retention windows describe losses only after publication has begun. An empty
  // series before the first verification is a delivery state, not sixty missed days.
  if (newestDay === null && verifiedMs === null) {
    return {
      schema: STATS_PUBLICATION_MONITOR_SCHEMA,
      observed_at: observedAt,
      promised_day: null,
      ok: false,
      failing_stage: "publisher-not-yet-delivered",
      findings: ["The daily search-use summary has not been published yet. The producing work is the search-usage summary on the Stats page."],
      notes: [],
      evidence: { newest_day: null, verified_at: null, refresh_state: published?.refresh?.state || null },
      budgets,
    };
  }

  const measuredSince = resolveMeasuredSince(observation);
  const receiptRetentionDays = Number.isFinite(Number(lineage.receipt_retention_days))
    ? Number(lineage.receipt_retention_days)
    : SEARCH_ACTIVITY_RETENTION_DAYS;
  const horizonStart = publicationHorizonStart({ now, measuredSince, receiptRetentionDays });
  const promisedDays = promisedPublicationDays({ now, measuredSince, receiptRetentionDays });
  const rawMissing = Array.isArray(lineage.missing_days) ? lineage.missing_days : [];
  const rawBefore = Array.isArray(lineage.before_measurement) ? lineage.before_measurement : [];
  const rawUnrecoverable = Array.isArray(lineage.unrecoverable_days) ? lineage.unrecoverable_days : [];
  const beforeMeasurement = [...new Set([
    ...rawBefore,
    ...rawMissing.filter((day) => dayBeforeMeasurement(day, measuredSince)),
  ])].sort();
  const missing = rawMissing.filter((day) => !dayBeforeMeasurement(day, measuredSince));
  const unrecoverable = rawUnrecoverable.filter((day) => !dayBeforeMeasurement(day, measuredSince));
  const promisedInScope = promisedDays.includes(promised);
  const promisedMissing = promisedInScope && (
    missing.includes(promised) || (newestDay !== null && newestDay < promised) || newestDay === null
  );

  if (promisedMissing) {
    failingStage = "missing-daily-aggregate";
    findings.push(`no dated aggregate for ${promised}; the newest stored day is ${newestDay || "none"}`);
  }

  // The frozen case: the publisher says it verified recently, and the trend has not moved.
  // Stated separately because it is the one failure a self-report cannot see.
  const claimsFresh = published?.refresh?.state === "fresh" || published?.refresh?.state === "stale";
  if (promisedMissing && claimsFresh && verifiedMs !== null && nowMs - verifiedMs <= budgets.publication_grace_hours * HOUR_MS) {
    failingStage = "frozen-publisher";
    findings.push(
      `the published summary reports a verification at ${published.refresh.verified_at} while the newest dated day is still ${newestDay || "none"}`,
    );
  }

  const divergent = (lineage.reconciliation?.rows || []).filter((row) => row.state === "divergent").map((row) => row.day);
  if (divergent.length) {
    failingStage = failingStage || "divergent-aggregate";
    findings.push(`stored aggregate no longer matches the receipts for ${divergent.length} day(s): ${divergent.join(", ")}`);
  }

  if (verifiedMs === null) {
    failingStage = failingStage || "stale-verification";
    findings.push("the published summary names no verified instant");
  } else if (nowMs - verifiedMs > budgets.verification_max_age_hours * HOUR_MS) {
    failingStage = failingStage || "stale-verification";
    findings.push(`the published summary was last verified at ${published.refresh.verified_at}`);
  }

  const measuredMs = instantMs(measuredSince);
  if (measuredMs !== null) {
    notes.push(`Measurement began on ${utcDay(measuredMs)}; days before that are not measured.`);
  }
  if (beforeMeasurement.length) {
    notes.push(`${beforeMeasurement.length} day(s) fall before measurement began and are not measured, not missing.`);
  }
  if (unrecoverable.length) {
    // A gap older than the receipts is a permanent hole, not a thing a rerun can fix. It is a
    // note rather than a finding, because reopening a card every day for a day nobody can
    // recover is noise, not work.
    notes.push(`${unrecoverable.length} day(s) are missing from beyond the receipt retention horizon and cannot be recovered.`);
  }
  if (missing.length && !promisedMissing) {
    notes.push(`${missing.length} earlier day(s) are absent from the series and are reported as gaps, not as zeroes.`);
  }

  return {
    schema: STATS_PUBLICATION_MONITOR_SCHEMA,
    observed_at: observedAt,
    promised_day: promised,
    ok: failingStage === null,
    failing_stage: failingStage,
    findings,
    notes,
    evidence: {
      newest_day: newestDay,
      missing_days: missing,
      before_measurement: beforeMeasurement,
      unrecoverable_days: unrecoverable,
      measured_since: measuredSince,
      horizon_start: horizonStart,
      verified_at: published?.refresh?.verified_at || null,
      refresh_state: published?.refresh?.state || null,
    },
    budgets,
  };
}

/**
 * The issue body. Prose plus the observed clocks — no dimension of any reader's activity, and
 * no store, key or credential name, because this text is published on a public issue.
 */
export function statsPublicationIssueBody(finding) {
  // The stable marker travels in the body so a later observation of the same condition finds
  // the same card even if its title has been edited by hand.
  const marker = `<!-- ${STATS_PUBLICATION_ISSUE_MARKER} -->`;
  if (finding.ok) {
    const horizonStart = finding.evidence?.horizon_start;
    const promisedInScope = !horizonStart || !finding.promised_day || finding.promised_day >= horizonStart;
    return [
      promisedInScope
        ? `The daily search-use snapshot for ${finding.promised_day} is published.`
        : "The daily search-use snapshot is published.",
      `Newest stored day: ${finding.evidence.newest_day || "none"}.`,
      ...finding.notes,
      marker,
    ].join("\n");
  }
  if (finding.failing_stage === "publisher-not-yet-delivered") {
    return [`Stage: ${finding.failing_stage}.`, "", ...finding.findings, marker].join("\n");
  }
  return [
    `Stage: ${finding.failing_stage}.`,
    `Promised day: ${finding.promised_day}.`,
    `Newest stored day: ${finding.evidence.newest_day || "none"}.`,
    "",
    ...finding.findings.map((line) => `- ${line}`),
    ...(finding.notes.length ? ["", ...finding.notes] : []),
    marker,
  ].join("\n");
}

function arg(name, argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv) {
  const path = arg("--observation", argv);
  if (!path) {
    process.stderr.write("--observation <path to a captured observation> is required\n");
    return 1;
  }
  const now = arg("--now", argv);
  if (!now) {
    process.stderr.write("--now <instant> is required; this evaluator never reads a clock of its own\n");
    return 1;
  }
  const finding = evaluateStatsPublication({ now, observation: JSON.parse(readFileSync(path, "utf8")) });
  process.stdout.write(`${JSON.stringify(finding, null, 2)}\n`);
  return finding.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
