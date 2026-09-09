/**
 * The repair playbooks: a committed registry of scripted, idempotent remedies.
 *
 * The repair rail's queue has always been able to lease an item. What it had no
 * way to do was FIX one, so every finding — however mechanical — waited on a
 * person. This registry is the missing half, and it is deliberately a registry
 * rather than a general-purpose agent: a playbook is selected by the finding's
 * signature, does one scripted thing, and proves the condition cleared by
 * re-running the monitor's own check for that item. No model is asked anything,
 * so a repair costs nothing and behaves the same way every time.
 *
 * Four rules hold the registry honest.
 *
 *  - **The identity that runs this rail may read and it may run local commands.
 *    It may not change the repository.** The scheduler's App identity carries
 *    Issues: write and Metadata: read. So a remedy that would need a commit, a
 *    pull request, or a workflow run is not a remedy here at all: it is a
 *    JUDGMENT, reported with the exact change or grant that would close it.
 *    Nothing in a playbook may widen that boundary from the inside.
 *  - **A missing playbook is judgment, never failure.** Failure means a remedy
 *    was tried and did not work, which is retryable. A signature nothing
 *    matches has had nothing tried, so it goes straight to a person with its
 *    class named rather than burning three attempts first.
 *  - **Verification is the monitor's own check, not the playbook's opinion.**
 *    Every remedy ends by re-running the check that produced the finding,
 *    scoped to the one subject. A playbook cannot report a repair it did not
 *    prove.
 *  - **The item describes; the playbook acts.** A playbook reads the signature
 *    and nothing else from the leased item. No field of a queue record is ever
 *    interpolated into a command, and the registry — not the item — decides
 *    what runs.
 *
 * Everything a playbook may touch arrives as a `context`, so each one is
 * exercised against stubs in `test/repair_playbooks.test.mjs` without a
 * publisher, a scheduler host, or a checkout.
 */

import { parseRepairSignature, sourceContractFailureClass } from "./repair_findings.mjs";

export const REPAIR_PLAYBOOK_REGISTRY_SCHEMA = "cityscroll.repair-playbook-registry.v1";

/**
 * The whole dispatch has to finish inside the cycle's ten-minute bound, so the
 * registry's own ceiling sits a minute below it: an overrun is then the
 * dispatcher's own bounded judgment rather than the runner killing the process
 * and losing the receipt.
 */
export const REPAIR_DISPATCH_BUDGET_MS = 9 * 60 * 1000;
/** How long the upstream playbook waits before its single retry. */
export const UPSTREAM_BACKOFF_MS = 60 * 1000;

export const REPAIR_OUTCOMES = Object.freeze(["repaired", "judgment", "failed", "deferred"]);

/**
 * The classes deliberately left to a person, and why. A class listed here has
 * no deterministic local remedy: it needs an editorial decision, a repository
 * change, or a credential nobody may mint from inside a repair.
 */
export const REPAIR_JUDGMENT_CLASSES = Object.freeze({
  "source-contract-schema-drift": "the publisher changed the shape of the data, so the fix is a change to this repository's reader or its declared required fields",
  "publication-cycle-stalled": "the desk publication cycle is a separate producer; restarting it from inside a monitor's repair would hide which of the two is actually stalled",
  "digest-shadow-credential": "the rehearsal's admin credential is missing or rejected, and minting or rotating a credential is never inside a repair's scope",
  "digest-shadow-degraded": "the rehearsal built something the redlines refused; what to do about the content is an editorial decision, not a mechanical one",
  "action-link-degraded": "an outbound action link changed on the publisher's side; choosing a replacement destination is an editorial decision",
  "stats-snapshot-missing": "the daily snapshot did not publish, and the remedy is a change to the publication path in this repository",
});

const SECOND = 1000;

function clamp(value, limit = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isoDay(value) {
  return typeof value === "string" && value ? value.slice(0, 10) : "not recorded";
}

function outcome(kind, summary, verification = null) {
  return { outcome: kind, summary: clamp(summary), verification };
}

function ageDays(from, to) {
  const start = Date.parse(from || "");
  const end = Date.parse(to || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.floor((end - start) / 86_400_000);
}

/**
 * The command that would re-acquire a source contract's evidence. It is the
 * contract's own declared acquisition entry point: the first tool named in its
 * `code_references`, which is the thing a person would run by hand. A contract
 * that declares no tool has no acquisition command to name, and the summary
 * says exactly that rather than inventing one.
 */
export function acquisitionCommand(contract) {
  const reference = (Array.isArray(contract?.code_references) ? contract.code_references : [])
    .map((row) => String(row?.path || ""))
    .find((path) => path.startsWith("tools/") && path.endsWith(".mjs"));
  return reference ? `node ${reference}` : null;
}

/* ------------------------------------------------------------------------- */
/* (a) A source contract whose evidence has gone stale.                       */
/* ------------------------------------------------------------------------- */

/**
 * The live verifier already measures both clocks and says which side is behind,
 * so this reads its finding rather than probing the publisher a second time.
 * Two implementations of "which clock is stale" would eventually disagree, and
 * the one the monitor uses is the one the issue was opened on.
 */
function bothClocks(finding) {
  const publisher = isoDay(finding?.publisher_updated_at);
  const retained = isoDay(finding?.retained_vintage_at);
  return `publisher updated_at ${publisher}, retained vintage ${retained}`;
}

async function sourceContractStale(context) {
  const subject = context.subject;
  if (!subject) return outcome("judgment", "the finding names no source contract, so no acquisition can be identified for it");
  const registry = await context.contracts.load();
  const contract = (registry?.contracts || []).find((row) => row?.id === subject) || null;
  if (!contract) {
    return outcome("judgment", `no source contract is registered as ${subject}, so the finding names something this repository does not acquire`);
  }

  // The monitor's own check, first. It settles whether the condition is still
  // there and, when it is not, hands back the two clocks that say why.
  const before = await context.contracts.verifyLive(contract);
  if (before.ok) {
    return outcome("repaired", `${subject}: the contract verifies again without a local remedy — ${before.detail}`, before);
  }
  const finding = before.finding || null;
  const command = acquisitionCommand(contract);
  if (!finding || finding.classification !== "stale") {
    return outcome("judgment", `${subject}: the live check no longer reports staleness but ${before.detail}. That is a different fault from the one queued, so it needs a decision rather than an acquisition.`, before);
  }
  const dates = bothClocks(finding);

  // Which side is behind decides whether any acquisition could help, and the
  // verifier already determined it from both clocks.
  if (finding.stale_side === "publisher") {
    return outcome("judgment", `${subject}: the publisher is the stale side — it has not published in ${finding.publisher_age_days} days against a limit of ${finding.limit_days}, and our retained snapshot is already at or after its clock. No acquisition can refresh it: decide whether the declared limit still matches the publisher's cadence or the source has been retired — ${dates}.`, before);
  }
  if (finding.stale_side !== "acquisition") {
    return outcome("judgment", `${subject}: the contract declares no retained vintage, so neither side can be shown as the stale one and there is nothing to re-acquire against. Declare a retained vintage on the contract, or record why this source has none — ${dates}.`, before);
  }

  // Our acquisition is behind. Evidence retained as a file in this repository
  // can only be refreshed by a repository change, which this identity may not
  // make; evidence that is host state can be re-acquired here.
  const artifact = finding.retained_vintage_artifact || null;
  if (artifact && await context.repository.isTracked(artifact)) {
    return outcome("judgment", `${subject}: our acquisition is the stale side and the retained evidence is the repository file ${artifact}, so landing the publisher's latest needs a repository change this identity cannot make. Run ${command || "the contract's acquisition path"} and commit the result — ${dates}.`, before);
  }
  if (!command) {
    return outcome("judgment", `${subject}: our acquisition is the stale side but the contract declares no acquisition tool, so there is nothing deterministic to run. Name one on the contract's code_references, or record why the source is refreshed by hand — ${dates}.`, before);
  }

  // Host state: the acquisition path is the scheduled slot that writes this
  // host's acquisition receipts. Re-running it is idempotent and it is the only
  // local thing that can move the clock.
  const job = await context.schedule.job(context.monitor);
  if (!job) {
    return outcome("judgment", `${subject}: no scheduled job is registered as ${context.monitor}, so the acquisition path cannot be re-run from here — ${dates}.`, before);
  }
  await context.schedule.runJob(job, { now: context.now });
  const verification = await context.contracts.verifyLive(contract);
  if (verification.ok) {
    return outcome("repaired", `${subject}: re-ran the acquisition path and the contract now verifies — ${verification.detail}.`, verification);
  }
  return outcome("failed", `${subject}: re-ran the acquisition path and the contract still does not verify — ${verification.detail}.`, verification);
}

/* ------------------------------------------------------------------------- */
/* (b) A scheduled slot that was due and recorded nothing.                    */
/* ------------------------------------------------------------------------- */

async function missedSlot(context) {
  const slotKey = context.subject;
  if (!slotKey) return outcome("judgment", "the finding names no scheduled slot, so there is nothing to re-run");
  const job = await context.schedule.job(context.monitor);
  if (!job) {
    return outcome("judgment", `no scheduled job is registered as ${context.monitor}, so the ${slotKey} slot cannot be re-run; the finding names a monitor this cycle no longer carries`);
  }
  if (await context.schedule.hasResult(context.monitor, slotKey)) {
    // Another cycle already recorded it. Nothing to do, and the verification is
    // the recorded result rather than this playbook's word for it.
    return outcome("repaired", `the ${slotKey} slot already has a recorded result, so nothing was re-run`, { ok: true, detail: "a recorded result already exists for the slot" });
  }
  // The original slot key, so the re-run lands in the slot that was missed
  // rather than opening a second one. Re-running an already-recorded slot is
  // idempotent for the same reason.
  await context.schedule.runJob(job, { runKey: slotKey, now: context.now });
  const recorded = await context.schedule.hasResult(context.monitor, slotKey);
  if (recorded) {
    return outcome("repaired", `re-ran the ${context.monitor} ${slotKey} slot under its original key and the result is recorded`, { ok: true, detail: "the slot now has a recorded result" });
  }
  return outcome("failed", `re-ran the ${context.monitor} ${slotKey} slot and no result was recorded`, { ok: false, detail: "the slot still has no recorded result" });
}

/* ------------------------------------------------------------------------- */
/* (c) A digest rehearsal that failed on an upstream error.                   */
/* ------------------------------------------------------------------------- */

async function digestShadowUpstream(context) {
  const job = await context.schedule.job(context.monitor);
  if (!job) {
    return outcome("judgment", `no scheduled job is registered as ${context.monitor}, so the rehearsal cannot be re-run from here`);
  }
  // One bounded backoff and one retry. A transient upstream is exactly what a
  // retry is for; further checks wait for the next scheduled observation.
  await context.sleep(UPSTREAM_BACKOFF_MS);
  const rerun = await context.schedule.runJob(job, { now: context.now });
  const result = rerun?.result || {};
  if (result.status === "healthy") {
    return outcome("repaired", "re-ran the digest rehearsal after a bounded backoff and it reported READY", { ok: true, detail: "the rehearsal reported READY" });
  }
  const upstream = context.upstreamEvidence(result);
  if (upstream) {
    return outcome("deferred", `waiting-upstream: the digest rehearsal was re-run after a ${Math.round(UPSTREAM_BACKOFF_MS / SECOND)}s backoff and the upstream is still failing (${upstream}). The next scheduled observation will recheck it; owner escalation waits for a persistent outage.`, { ok: false, detail: upstream });
  }
  return outcome("failed", `re-ran the digest rehearsal after a bounded backoff and it reported ${result.summary?.status || result.degraded_reason || "a degraded rehearsal"}`, { ok: false, detail: clamp(result.degraded_reason || "the rehearsal is still degraded", 120) });
}

/* ------------------------------------------------------------------------- */
/* (d) A freshness watchdog that reports a source's evidence stale.           */
/* ------------------------------------------------------------------------- */

/** Recheck an unreachable publisher using the source monitor's own classifier. */
async function sourceContractOutage(context) {
  const subject = context.subject;
  const registry = await context.contracts.load();
  const contract = (registry?.contracts || []).find((row) => row?.id === subject);
  if (!contract) return outcome("judgment", "the outage names no registered source contract, so no publisher check can be selected");
  const verification = await context.contracts.verifyLive(contract);
  if (verification.ok) return outcome("repaired", `${subject}: the publisher answers normally again — ${verification.detail}`, verification);
  if (sourceContractFailureClass(verification.detail) === "source-contract-outage") {
    return outcome("deferred", `waiting-upstream: ${subject}: ${verification.detail}. The next scheduled observation will recheck the publisher.`, verification);
  }
  return outcome("judgment", `${subject}: the publisher check now reports a different condition — ${verification.detail}`, verification);
}

async function freshnessStale(context) {
  const subject = context.subject;
  if (!subject) return outcome("judgment", "the finding names no source contract, so no publication path can be identified for it");
  const before = await context.freshness.evaluate(subject, { now: context.now });
  if (!before) {
    return outcome("judgment", `no freshness observation is available for ${subject}, so whether its evidence advanced cannot be established from here`);
  }
  if (before.status === "CURRENT") {
    return outcome("repaired", `${subject}: the freshness watchdog reads CURRENT again; the publication path advanced on its own and nothing was re-run`, { ok: true, detail: "the watchdog reads CURRENT" });
  }
  const reasons = Array.isArray(before.reason_codes) ? before.reason_codes : [];
  const path = context.freshness.publicationPath(reasons);
  if (!path) {
    // Deliberately not "the path ran and did not advance": there is no path.
    // The registry states which scheduled jobs publish acquisition receipts,
    // and a reason with none of them behind it says why rather than naming a
    // check-only job that would run, succeed, and change nothing.
    const why = context.freshness.pathAbsentReason?.(reasons) || null;
    return outcome("judgment", `${subject}: the freshness watchdog is stale for ${reasons.join(", ") || "no recorded reason"}, and no scheduled publication path is registered for that reason${why ? ` — ${why}` : ""}. What should have advanced has to be decided rather than inferred.`);
  }
  const job = await context.schedule.job(path);
  if (!job) {
    return outcome("judgment", `${subject}: the evidence publication path is ${path}, which this cycle does not carry as a scheduled job, so it cannot be re-run from here — re-run it where it is scheduled or record why it no longer is`);
  }
  // Whether the path's own receipt advanced decides which of the two faults
  // this is: a path that has not run is one to re-run, and a path that ran and
  // still left the evidence stale is a defect in the path rather than a missed
  // slot.
  const receipt = await context.schedule.latestResult(path);
  const receiptAge = ageDays(receipt?.observed_at, context.now.toISOString());
  const advanced = receipt && receiptAge != null && receiptAge <= 1;
  if (advanced) {
    return outcome("judgment", `${subject}: the evidence publication path ${path} last recorded a result at ${clamp(receipt.observed_at, 40)} and the watchdog still reads STALE for ${reasons.join(", ") || "no recorded reason"}. The path is running and is not advancing this source's evidence, which is a change to the publication path rather than a missed run.`, { ok: false, detail: "the publication path ran and the evidence did not advance" });
  }
  await context.schedule.runJob(job, { now: context.now });
  const after = await context.freshness.evaluate(subject, { now: context.now });
  if (after?.status === "CURRENT") {
    return outcome("repaired", `${subject}: re-ran the evidence publication path ${path} and the freshness watchdog now reads CURRENT`, { ok: true, detail: "the watchdog reads CURRENT" });
  }
  return outcome("failed", `${subject}: re-ran the evidence publication path ${path} and the freshness watchdog still reads ${after?.status || "an unavailable status"} for ${(after?.reason_codes || reasons).join(", ") || "no recorded reason"}`, { ok: false, detail: "the watchdog still reads stale" });
}

/**
 * The registry. Order is irrelevant: selection is exact on the monitor and the
 * failure class, so two playbooks can never both claim one signature.
 */
export const REPAIR_PLAYBOOKS = Object.freeze([
  Object.freeze({
    id: "source-contract-outage",
    monitor: "source-contracts-live",
    failure_class: "source-contract-outage",
    budget_ms: 3 * 60 * SECOND,
    precondition: "the finding names a registered source contract whose publisher was unreachable",
    remedy: "recheck the publisher once with the source-contract monitor",
    verification: "the live source-contract check passes again",
    judgment_when: "the contract is no longer registered or the check reports a different condition",
    deferred_when: "the publisher check still reports an outage",
    run: sourceContractOutage,
  }),
  Object.freeze({
    id: "source-contract-stale",
    monitor: "source-contracts-live",
    failure_class: "source-contract-stale",
    budget_ms: 3 * 60 * SECOND,
    precondition: "the contract is registered, and the live check names our acquisition as the stale side rather than the publisher",
    remedy: "where the retained evidence is host state, re-run the contract's acquisition path once",
    verification: "re-run the live source-contract check for that one contract",
    judgment_when: "the publisher is the stale side, no retained vintage is declared, the retained evidence is a repository file, or the contract declares no acquisition tool",
    run: sourceContractStale,
  }),
  Object.freeze({
    id: "missed-slot",
    monitor: null,
    failure_class: "missed-slot",
    budget_ms: 5 * 60 * SECOND,
    precondition: "the monitor is still a registered scheduled job and the slot has no recorded result",
    remedy: "re-run the slot once under its original slot key",
    verification: "the slot has a recorded result afterwards",
    judgment_when: "the finding names a monitor this cycle no longer carries",
    run: missedSlot,
  }),
  Object.freeze({
    id: "digest-shadow-upstream",
    monitor: "digest-shadow-monitor",
    failure_class: "digest-shadow-upstream",
    budget_ms: 5 * 60 * SECOND,
    precondition: "the digest rehearsal is still a registered scheduled job",
    remedy: "wait a bounded backoff, then re-run the rehearsal once",
    verification: "the re-run rehearsal reports READY",
    judgment_when: "the rehearsal is no longer registered; continued upstream failures are deferred",
    deferred_when: "the upstream is still failing after the bounded retry",
    run: digestShadowUpstream,
  }),
  Object.freeze({
    id: "freshness-stale",
    monitor: "source-freshness-watchdog",
    failure_class: "freshness-stale",
    budget_ms: 5 * 60 * SECOND,
    precondition: "a scheduled publication path that publishes acquisition receipts is registered for the watchdog's reason, and its own receipt has not advanced",
    remedy: "re-run that publication path's scheduled command once",
    verification: "re-run the freshness watchdog for that one source contract",
    judgment_when: "the publication path ran recently and the evidence still did not advance, or no scheduled path is registered for the reason — for which the summary names why there is none rather than reporting a run that never happened",
    run: freshnessStale,
  }),
]);

/**
 * Select the playbook for a signature. A playbook that declares a monitor
 * matches only that monitor; one that declares none — a missed slot can happen
 * to any of them — matches on the failure class alone.
 */
export function selectRepairPlaybook(signature) {
  const parsed = parseRepairSignature(signature);
  if (!parsed) return { playbook: null, parsed: null, reason: "the signature is not in the monitor:class[:subject] form this rail keys on" };
  const playbook = REPAIR_PLAYBOOKS.find((row) => row.failure_class === parsed.failure_class
    && (row.monitor == null || row.monitor === parsed.monitor)) || null;
  if (playbook) return { playbook, parsed, reason: null };
  const declared = REPAIR_JUDGMENT_CLASSES[parsed.failure_class];
  return {
    playbook: null,
    parsed,
    reason: declared
      ? `${parsed.failure_class} is deliberately left to a person: ${declared}`
      : `no playbook is registered for ${parsed.failure_class} from ${parsed.monitor}, and the class is not one the registry has deliberately left to a person`,
  };
}

/** The registry as data, for the documentation table and its parity check. */
export function repairPlaybookRegistry() {
  return {
    schema: REPAIR_PLAYBOOK_REGISTRY_SCHEMA,
    dispatch_budget_ms: REPAIR_DISPATCH_BUDGET_MS,
    playbooks: REPAIR_PLAYBOOKS.map((row) => ({
      id: row.id,
      monitor: row.monitor,
      failure_class: row.failure_class,
      budget_ms: row.budget_ms,
      precondition: row.precondition,
      remedy: row.remedy,
      verification: row.verification,
      judgment_when: row.judgment_when,
      ...(row.deferred_when ? { deferred_when: row.deferred_when } : {}),
    })),
    judgment_classes: Object.entries(REPAIR_JUDGMENT_CLASSES).map(([failure_class, reason]) => ({ failure_class, reason })),
  };
}
