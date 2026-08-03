#!/usr/bin/env node
/**
 * Repo-side policy helpers for oldest-first (elder) merge-slot reservation.
 *
 * The one-at-a-time merge-when-ready seat cap lives outside this repository
 * (see tools/merge_queue_policy.json notes). This module is the pure policy
 * surface the external seater should import or re-implement:
 *
 *   - when a ready PR exceeds elder_age_hours (or rebase churn threshold),
 *     reserve the next free seat for that PR
 *   - younger ready PRs must not take a seat while an eligible elder is waiting
 *
 * Usage:
 *   node tools/elder_merge_slot.mjs --check          # validate policy JSON shape
 *   node tools/elder_merge_slot.mjs --pick <prs.json> # pick next seat holder
 *
 * prs.json: [{ number, created_at, ready: true, age_hours?, rebase_count? }, ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");

export const DEFAULT_ELDER = {
  enabled: true,
  elder_age_hours: 6,
  rebase_churn_threshold: 3,
  reserve_next_slot_for_elder: true,
  note:
    "External merge-when-ready seater should call pickElderSeatHolder() before seating a younger PR.",
};

export function loadElderPolicy(policyPath = POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return { ...DEFAULT_ELDER, ...(policy.elder_slot || {}) };
}

/**
 * @param {Array<{ number: number, created_at?: string, ready?: boolean, age_hours?: number, rebase_count?: number }>} prs
 * @param {ReturnType<typeof loadElderPolicy>} [elder]
 * @param {number} [nowMs]
 * @returns {{ seat: object | null, reason: string, elders: object[] }}
 */
export function pickElderSeatHolder(prs, elder = DEFAULT_ELDER, nowMs = Date.now()) {
  if (!elder.enabled || !elder.reserve_next_slot_for_elder) {
    return { seat: null, reason: "elder reservation disabled", elders: [] };
  }
  const ready = (prs || []).filter((p) => p && p.ready !== false);
  const withAge = ready.map((p) => {
    let ageHours = p.age_hours;
    if (ageHours == null && p.created_at) {
      ageHours = (nowMs - new Date(p.created_at).getTime()) / 3_600_000;
    }
    return { ...p, age_hours: ageHours ?? 0, rebase_count: p.rebase_count ?? 0 };
  });
  const elders = withAge
    .filter(
      (p) =>
        p.age_hours >= elder.elder_age_hours ||
        p.rebase_count >= elder.rebase_churn_threshold,
    )
    .sort((a, b) => {
      // Oldest first (lower PR number is a stable tie-break when created_at ties).
      const byAge = (b.age_hours || 0) - (a.age_hours || 0);
      if (byAge !== 0) return byAge;
      return (a.number || 0) - (b.number || 0);
    });
  if (!elders.length) {
    return { seat: null, reason: "no elder above threshold", elders: [] };
  }
  return {
    seat: elders[0],
    reason: `reserve next seat for PR #${elders[0].number} (age_hours=${elders[0].age_hours}, rebase_count=${elders[0].rebase_count})`,
    elders,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check")) {
    const elder = loadElderPolicy();
    if (!elder.elder_age_hours || elder.elder_age_hours < 1) {
      console.error("elder_slot.elder_age_hours must be >= 1");
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, elder_slot: elder }, null, 2));
    return;
  }
  if (args[0] === "--pick") {
    const file = args[1];
    if (!file) {
      console.error("usage: node tools/elder_merge_slot.mjs --pick <prs.json>");
      process.exit(1);
    }
    const prs = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = pickElderSeatHolder(prs, loadElderPolicy());
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Usage:
  node tools/elder_merge_slot.mjs --check
  node tools/elder_merge_slot.mjs --pick prs.json`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
