#!/usr/bin/env node

/**
 * Check the consequential documentation claims, and hand the result to the
 * review flow that already exists.
 *
 * Facts are not derived here. The release and infrastructure facts come from
 * tools/release_infrastructure_facts.mjs, the collection and publication facts
 * from tools/collection_boundary_facts.mjs, and the resident-read facts from the
 * policy and debt manifests that tools/no_live_external_reads.mjs enforces. This
 * module only indexes those values so a registry entry can name one of them by
 * path, and applies the bounded claim registry to the covered documents.
 *
 * The covered-document inventory is generated at check time from the registry;
 * no whole-repository aggregate is committed for it.
 *
 *   node tools/documentation_drift_review.mjs            # print the observation
 *   node tools/documentation_drift_review.mjs --check    # fail on a contradicted claim
 *   node tools/documentation_drift_review.mjs --report --checked-at=2026-09-07
 *   node tools/documentation_drift_review.mjs --rehearse --state-dir=<dir>
 *
 * --check reads no clock. --report and --rehearse require an explicit
 * --checked-at, because a build timestamp is not an editorial review date.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReleaseInfrastructureFacts } from "./release_infrastructure_facts.mjs";
import { buildCollectionBoundaryFacts } from "./collection_boundary_facts.mjs";
import {
  BLOCKING_FINDING_TYPES,
  DOCUMENTATION_CLAIM_REGISTRY_SCHEMA,
  observeDocumentationClaims,
} from "./documentation_claim_observer.mjs";
import { persistScheduleResult, replayOutbox } from "./external_schedule_outbox.mjs";
import { readdir, rm } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DOCUMENTATION_REVIEW_SCHEMA = "cityscroll.documentation_drift_review.v1";
export const DOCUMENTATION_REVIEW_METHOD = "documentation_claim_observer_v1";

/** The job identity the existing outbox conventions key deduplication on. */
export const DOCUMENTATION_REVIEW_JOB_ID = "documentation-drift-review";

export const CLAIM_REGISTRY_PATH = "architecture/documentation-claims.json";
export const FROZEN_CASE_PATH = "architecture/backtests/documentation-claim-drift.json";
export const RESIDENT_READ_POLICY_PATH = "architecture/resident-read-policy.json";
export const RESIDENT_READ_DEBT_PATH = "architecture/no-live-external-debt.json";
export const RESIDENT_READ_GATE = "tools/no_live_external_reads.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/;

function readText(path, rootDir = ROOT) {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function readJson(path, rootDir = ROOT) {
  return JSON.parse(readText(path, rootDir));
}

export function loadClaimRegistry(rootDir = ROOT) {
  const registry = readJson(CLAIM_REGISTRY_PATH, rootDir);
  if (registry.schema !== DOCUMENTATION_CLAIM_REGISTRY_SCHEMA) {
    throw new Error(`unexpected claim registry schema: ${registry.schema}`);
  }
  if (!Array.isArray(registry.claims) || registry.claims.length === 0) {
    throw new Error("the claim registry must carry at least one claim");
  }
  return registry;
}

/**
 * The covered-document set, generated from the registry at check time. A claim
 * may only name a document the registry declares, so coverage stays bounded and
 * a new document is a reviewed registry change rather than a silent widening.
 */
export function coveredDocuments(registry) {
  const declared = new Set(registry.documents || []);
  for (const claim of registry.claims) {
    for (const document of claim.documents || []) {
      if (!declared.has(document)) {
        throw new Error(`claim ${claim.id} covers ${document}, which the registry does not declare`);
      }
    }
  }
  return [...declared].sort();
}

/**
 * Resident-read facts, read from the two committed manifests that
 * tools/no_live_external_reads.mjs enforces. Only the routes and entry ids are
 * projected: nothing here re-derives, re-dates, or re-scopes the debt, and no
 * entry or expiry is read as a decision about whether a departure is acceptable.
 */
export function buildResidentReadFacts(rootDir = ROOT) {
  const policy = readJson(RESIDENT_READ_POLICY_PATH, rootDir);
  const debt = readJson(RESIDENT_READ_DEBT_PATH, rootDir);
  const entries = Array.isArray(debt.entries) ? debt.entries : [];
  const routes = [...new Set(entries.map((entry) => entry.route).filter(Boolean))].sort();
  return {
    invariant: policy.invariant ?? null,
    gate: RESIDENT_READ_GATE,
    manifest: RESIDENT_READ_DEBT_PATH,
    open_debt_entries: entries.map((entry) => entry.id).filter(Boolean).sort(),
    open_debt_routes: routes,
    declared_debt_routes: [...(policy.first_party_routes?.temporary_debt ?? [])].sort(),
  };
}

/**
 * Index the derived binding rows by binding name so a registry entry can name
 * one by path. This is a projection of the existing deriver's output, not a
 * second reading of the Wrangler configuration.
 */
function bindingActivity(releaseFacts) {
  return Object.fromEntries((releaseFacts.bindings || [])
    .filter((binding) => binding?.name)
    .map((binding) => [binding.name, binding.active === true]));
}

export function collectDocumentationFacts(rootDir = ROOT) {
  const releaseInfrastructure = buildReleaseInfrastructureFacts({ rootDir });
  return {
    release_infrastructure: {
      ...releaseInfrastructure,
      binding_active: bindingActivity(releaseInfrastructure),
    },
    collection_boundary: buildCollectionBoundaryFacts(rootDir),
    resident_read: buildResidentReadFacts(rootDir),
  };
}

export function loadCoveredDocuments(registry, rootDir = ROOT) {
  return Object.fromEntries(coveredDocuments(registry).map((path) => [path, readText(path, rootDir)]));
}

/** Observe the working tree. No clock, no network, no publisher read. */
export function observeRepository({ rootDir = ROOT } = {}) {
  const registry = loadClaimRegistry(rootDir);
  return observeDocumentationClaims({
    documents: loadCoveredDocuments(registry, rootDir),
    facts: collectDocumentationFacts(rootDir),
    claims: registry.claims,
  });
}

/**
 * Project the current observation for the frozen backtest set. The spec carries
 * nothing but the intent to read the live tree, so a re-narrowed registry or a
 * changed configuration shows up as a failing replay rather than a quiet pass.
 */
export function projectCurrentDocumentationObservation(spec = {}) {
  const rootDir = spec.root ? resolve(ROOT, spec.root) : ROOT;
  const registry = loadClaimRegistry(rootDir);
  return {
    documents: loadCoveredDocuments(registry, rootDir),
    facts: collectDocumentationFacts(rootDir),
    claims: registry.claims,
  };
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

/**
 * The evidence a repeated run is compared on. Line numbers are excluded, so an
 * unrelated edit above a claim does not present a standing finding as new; the
 * claim registry digest and the read fact values are included, so a changed
 * claim owner or a changed source fact does invalidate the review.
 */
export function reviewEvidence(report) {
  return sortDeep({
    schema: report.schema,
    method: report.method,
    claims_digest: report.claims_digest,
    facts_digest: report.facts_digest,
    covered_documents: report.covered_documents,
    findings: report.findings.map((item) => ({
      finding_id: item.finding_id,
      type: item.type,
      claim_id: item.claim_id,
      document: item.document,
      excerpt: item.excerpt,
      expected: item.expected,
      observed: item.observed,
      source: item.source,
    })),
  });
}

export function hashReviewEvidence(report) {
  return sha256Hex(JSON.stringify(reviewEvidence(report)));
}

export function documentationReviewEventId(runKey) {
  return sha256Hex(`${DOCUMENTATION_REVIEW_JOB_ID}\n${runKey}`).slice(0, 32);
}

/**
 * Build one review report from an observation. Every date and identifier is an
 * argument; there is no ambient time here.
 */
export function buildDocumentationReviewReport({
  observation,
  checkedAt = null,
  observedCommit = null,
  runKey = null,
  coveredDocuments: covered = null,
} = {}) {
  if (!observation) throw new Error("buildDocumentationReviewReport needs an observation");
  if (!ISO_DATE.test(String(checkedAt ?? ""))) {
    throw new Error("--checked-at=YYYY-MM-DD is required; this lane never reads a clock");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(String(observedCommit ?? ""))) {
    throw new Error("buildDocumentationReviewReport needs observedCommit as a revision id");
  }
  const key = String(runKey ?? checkedAt);
  if (!RUN_KEY.test(key)) throw new Error("the run key must be one the outbox can key on");

  const findings = observation.findings.map((item) => ({ ...item }));
  const report = {
    schema: DOCUMENTATION_REVIEW_SCHEMA,
    method: DOCUMENTATION_REVIEW_METHOD,
    job_id: DOCUMENTATION_REVIEW_JOB_ID,
    run_key: key,
    event_id: documentationReviewEventId(key),
    checked_at: checkedAt,
    observed_commit: String(observedCommit).toLowerCase(),
    status: observation.status,
    covered_documents: covered ?? [],
    claims_digest: observation.claims_digest,
    facts_digest: observation.facts_digest,
    uncovered_documents: observation.uncovered_documents,
    findings,
    finding_ids: findings.map((item) => item.finding_id),
    counts: observation.counts,
  };
  report.content_hash = hashReviewEvidence(report);
  return report;
}

/**
 * What changed between two runs. The review owner raises only what is new, which
 * is why an unchanged replay produces no repeated work item, and why a finding
 * that comes back later comes back under the identity it had before.
 */
export function documentationReviewDelta(previous, current) {
  const before = new Set(Array.isArray(previous?.finding_ids) ? previous.finding_ids : []);
  const after = new Map((current?.findings ?? []).map((item) => [item.finding_id, item]));
  return {
    new_ids: [...after.keys()].filter((id) => !before.has(id)).sort(),
    persisting_ids: [...after.keys()].filter((id) => before.has(id)).sort(),
    resolved_ids: [...before].filter((id) => !after.has(id)).sort(),
  };
}

const NO_MUTATION_CLIENT = Object.freeze({
  listIssues: () => { throw new Error("documentation review rehearsal must not reach a remote"); },
  listComments: () => { throw new Error("documentation review rehearsal must not reach a remote"); },
  createIssue: () => { throw new Error("documentation review rehearsal must not reach a remote"); },
  createComment: () => { throw new Error("documentation review rehearsal must not reach a remote"); },
  updateIssue: () => { throw new Error("documentation review rehearsal must not reach a remote"); },
});

/**
 * Hand one report to the shared outbox with an intent of `none`, so the
 * deduplication and replay behaviour can be proved without opening, commenting
 * on, or closing anything. The client throws on any mutation, so a clean replay
 * is itself the proof that nothing outward was touched.
 */
export async function rehearseDocumentationReview({ stateDir, report, previous = null }) {
  const delta = documentationReviewDelta(previous, report);
  const { event } = await persistScheduleResult({
    stateDir,
    jobId: DOCUMENTATION_REVIEW_JOB_ID,
    runKey: report.run_key,
    result: {
      observed_at: `${report.checked_at}T00:00:00Z`,
      status: report.status,
      content_hash: report.content_hash,
      counts: report.counts,
    },
    issue: { mode: "none" },
  });
  const replay = await replayOutbox({ stateDir, github: NO_MUTATION_CLIENT });
  return { event, replay, delta };
}

/**
 * Rehearse the whole lineage a review consumer has to survive: a first
 * occurrence, an unchanged replay of the same scheduled slot, an unchanged
 * replay in the next slot, a resolution, and a recurrence.
 *
 * The stages run over the frozen audited fixture and its corrected control, not
 * over the working tree, so the receipt is reproducible from the repository
 * alone and does not move when an unrelated document is edited. Every date is an
 * explicit argument and the outbox intent is `none`, so nothing outward is
 * touched.
 */
export const REHEARSAL_STAGES = Object.freeze([
  { stage: "first-occurrence", run_key: "2026-09-07", fixture: "drifted" },
  { stage: "unchanged-replay-same-slot", run_key: "2026-09-07", fixture: "drifted" },
  { stage: "unchanged-replay-next-slot", run_key: "2026-09-08", fixture: "drifted" },
  { stage: "resolution", run_key: "2026-09-09", fixture: "corrected" },
  { stage: "recurrence", run_key: "2026-09-10", fixture: "drifted" },
]);

export const REHEARSAL_COMMIT = "0000000000000000000000000000000000000000";

export function frozenRehearsalObservations(rootDir = ROOT) {
  const frozen = readJson(FROZEN_CASE_PATH, rootDir);
  const claims = loadClaimRegistry(rootDir).claims;
  const corrected = frozen.controls?.["corrected-documents"];
  if (!corrected) throw new Error(`${FROZEN_CASE_PATH} has no corrected-documents control to resolve against`);
  return {
    drifted: observeDocumentationClaims({ ...frozen.collapsed, claims }),
    corrected: observeDocumentationClaims({ ...corrected, claims }),
  };
}

export async function rehearseConsumerLineage({ stateDir, rootDir = ROOT }) {
  const observations = frozenRehearsalObservations(rootDir);
  const covered = coveredDocuments(loadClaimRegistry(rootDir));
  const stages = [];
  let previous = null;
  let firstOccurrenceIds = null;

  for (const step of REHEARSAL_STAGES) {
    const report = buildDocumentationReviewReport({
      observation: observations[step.fixture],
      checkedAt: step.run_key,
      observedCommit: REHEARSAL_COMMIT,
      runKey: step.run_key,
      coveredDocuments: covered,
    });
    const { event, replay, delta } = await rehearseDocumentationReview({ stateDir, report, previous });
    const outbox = (await readdir(join(stateDir, "outbox"))).filter((name) => name.endsWith(".json"));
    stages.push({
      stage: step.stage,
      fixture: step.fixture,
      run_key: report.run_key,
      event_id: event.event_id,
      report_status: report.status,
      content_hash: report.content_hash,
      finding_count: report.findings.length,
      new_findings: delta.new_ids.length,
      unchanged_findings: delta.persisting_ids.length,
      resolved_findings: delta.resolved_ids.length,
      outbox_events: outbox.length,
      outbox_intent: event.issue.mode,
      replay_status: replay.status,
      replay_errors: replay.errors,
    });
    if (step.stage === "first-occurrence") firstOccurrenceIds = delta.new_ids;
    if (step.stage === "recurrence") {
      stages[stages.length - 1].recurs_under_first_occurrence_identity =
        delta.new_ids.join("|") === (firstOccurrenceIds || []).join("|");
    }
    previous = report;
  }

  return {
    schema: "cityscroll.documentation_drift_review_rehearsal.v1",
    job_id: DOCUMENTATION_REVIEW_JOB_ID,
    source: FROZEN_CASE_PATH,
    consumer: {
      mechanism: "tools/external_schedule_outbox.mjs",
      intent: "none",
      note: (
        "The shared outbox is the deduplicating consumer reachable from this repository. "
        + "The review desk that decides on an assembled batch is not in this repository, so the "
        + "handoff into it is rehearsed here and stays open until that side can be exercised."
      ),
    },
    stages,
  };
}

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const pair = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (pair) { flags[pair[1]] = pair[2]; continue; }
    const bare = /^--([a-z-]+)$/.exec(arg);
    if (bare) { flags[bare[1]] = true; continue; }
    throw new Error(`unrecognized argument ${JSON.stringify(arg)}`);
  }
  return flags;
}

function renderFinding(item) {
  return `${item.type} ${item.claim_id} ${item.document}:${item.line} — ${item.excerpt}`
    + `\n    owner: ${item.source.path}${item.source.locator ? ` (${item.source.locator})` : ""}`;
}

async function main(argv) {
  const flags = parseArgs(argv);
  const registry = loadClaimRegistry();
  const covered = coveredDocuments(registry);
  const observation = observeRepository();

  if (flags["rehearse-lineage"]) {
    const stateDir = join(ROOT, typeof flags["state-dir"] === "string"
      ? flags["state-dir"]
      : ".artifacts/documentation-drift-review/lineage");
    // A rehearsal starts from an empty consumer state, or "first occurrence"
    // would be whatever a previous run left behind.
    // determinism-lint: allow write --rehearse-lineage is an explicit non-check mode; --check never reaches this branch
    await rm(stateDir, { recursive: true, force: true });
    const receipt = await rehearseConsumerLineage({ stateDir });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (typeof flags.out === "string") {
      // determinism-lint: allow write the receipt goes only where --out names, and --check accepts no --out
      await mkdir(dirname(join(ROOT, flags.out)), { recursive: true });
      // determinism-lint: allow write the receipt goes only where --out names, and --check accepts no --out
      await writeFile(join(ROOT, flags.out), text, "utf8");
      process.stdout.write(`Wrote ${flags.out}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (flags.report || flags.rehearse) {
    const report = buildDocumentationReviewReport({
      observation,
      checkedAt: typeof flags["checked-at"] === "string" ? flags["checked-at"] : null,
      observedCommit: typeof flags["observed-commit"] === "string" ? flags["observed-commit"] : null,
      runKey: typeof flags["run-key"] === "string" ? flags["run-key"] : null,
      coveredDocuments: covered,
    });
    if (flags.rehearse) {
      const stateDir = join(ROOT, typeof flags["state-dir"] === "string"
        ? flags["state-dir"]
        : ".artifacts/documentation-drift-review/state");
      const previousPath = join(stateDir, "previous-report.json");
      const previous = existsSync(previousPath)
        ? JSON.parse(await readFile(previousPath, "utf8"))
        : null;
      const { event, replay, delta } = await rehearseDocumentationReview({ stateDir, report, previous });
      // determinism-lint: allow write --rehearse carries prior-run state in the gitignored .artifacts tree
      await mkdir(dirname(previousPath), { recursive: true });
      // determinism-lint: allow write --rehearse carries prior-run state in the gitignored .artifacts tree
      await writeFile(previousPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(
        `Documentation review rehearsed: event ${event.event_id}, ${delta.new_ids.length} new, `
        + `${delta.persisting_ids.length} unchanged, ${delta.resolved_ids.length} resolved, `
        + `replay ${replay.status}\n`,
      );
      return 0;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (!flags.check) {
    process.stdout.write(`${JSON.stringify({ covered_documents: covered, ...observation }, null, 2)}\n`);
    return 0;
  }

  const blocking = observation.findings.filter((item) => item.blocking);
  const review = observation.findings.filter((item) => !item.blocking);
  for (const item of blocking) process.stderr.write(`documentation-drift: ${renderFinding(item)}\n`);
  // Review obligations are printed on every run, including a run with no
  // contradiction, so a passing check is never read as a completed review.
  for (const item of review) {
    process.stdout.write(
      `documentation-review-needed: ${item.claim_id} ${item.document}:${item.line} — ${item.excerpt}`
      + `\n    adjudicated by: ${item.expected?.adjudicated_by ?? "an owner"}\n`,
    );
  }
  process.stdout.write(
    `Documentation claims: ${covered.length} documents, ${registry.claims.length} claims, `
    + `${blocking.length} contradicted (${BLOCKING_FINDING_TYPES.join("/")}), `
    + `${review.length} awaiting review — status ${observation.status}\n`,
  );
  return blocking.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
