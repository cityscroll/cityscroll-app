/**
 * The Desk repair queue — one repair opportunity per repeated condition.
 *
 * `tools/repair_observations.mjs` records what was observed: one structured
 * record per (source, scope, condition). That is the right grain for evidence
 * and the wrong grain for work. An adapter that cannot retrieve six boards is
 * six observations and ONE repair, and an operator reading six rows has to
 * re-derive that fact by eye every pass.
 *
 * This module is the second grain. It folds observations into ISSUES keyed by
 * the thing a repair would change — the source contract, the condition, and the
 * adapter that produced it — and carries, per issue, the affected-scope count,
 * how recently it was seen, the evidence that first recorded it, its owner, any
 * existing engineering record, and any resolution receipt.
 *
 * Four properties carry the contract:
 *
 *  - **Identity is the repair, not the sentence.** `repairIssueKey` digests the
 *    source contract, the condition, and the adapter and nothing else. A
 *    reworded condition detail, a new last-seen timestamp, another affected
 *    board, or a fresh code revision all fold into the issue that already
 *    exists. A different source, condition, or adapter does not.
 *  - **Work state and evidence state are separate.** Only the `repair`
 *    disposition is engineering work. Expected absence and source-policy
 *    limitation are carried as their own states so that an operator can see the
 *    condition was evaluated without it entering a work queue, and resolved and
 *    regressed are distinguished so a repair that came back does not read as a
 *    new one.
 *  - **A finding is a candidate until a person says otherwise.** Nothing in
 *    this module can promote an issue past `candidate`. Only the reviewed
 *    register — a committed file a card producer edits — records that the
 *    deduplication was verified, which existing record owns the repair, and
 *    which receipt resolved it.
 *  - **Failure is a state, not a silence.** If the observation inputs are not
 *    available, the queue reports `unavailable` with the reason. An empty
 *    queue and an unread queue are different answers and must never render the
 *    same way.
 *
 * Nothing here is served. The queue rides the same derived, gitignored desk
 * artifact the observation set does, so it inherits that access boundary rather
 * than inventing a route, a credential, or a store of its own.
 */

import { createHash } from "node:crypto";

import {
  REPAIR_DISPOSITIONS,
  REPAIR_OBSERVATION_CONDITIONS,
  mergeRepairObservations,
} from "./repair_observations.mjs";

export const REPAIR_QUEUE_SCHEMA = "cityscroll.repair_queue.v1";
export const REPAIR_QUEUE_REGISTER_SCHEMA = "cityscroll.repair_queue_register.v1";
export const REPAIR_QUEUE_REGISTER_PATH = "data/repair-queue-register.v1.json";

/**
 * The five states the card separates. `repair-candidate` and `regressed` are
 * the only ones that describe outstanding engineering work; the other three
 * record that a condition was evaluated and needs no repair right now.
 */
export const REPAIR_QUEUE_STATES = Object.freeze([
  "repair-candidate",
  "regressed",
  "expected-absence",
  "source-policy-limitation",
  "resolved",
]);

/** States whose rows are outstanding engineering work. */
export const REPAIR_QUEUE_WORK_STATES = Object.freeze(["repair-candidate", "regressed"]);

/**
 * Deduplication verification is a human act. A finding enters as `candidate`
 * and only the reviewed register can move it, so an automated pass can never
 * assert that two symptoms are the same repair.
 */
export const REPAIR_QUEUE_VERIFICATION_STATES = Object.freeze(["candidate", "deduplication-verified"]);

/** Human labels for the desk. Operator prose about a repair, never about a publisher. */
export const REPAIR_QUEUE_STATE_LABELS = Object.freeze({
  "repair-candidate": "Repair candidate",
  regressed: "Regressed",
  "expected-absence": "Expected absence",
  "source-policy-limitation": "Source policy limitation",
  resolved: "Resolved",
});

/**
 * A reference that leaves this repository has to be reachable by someone who
 * only has the repository. An owner-only backstage locator and a local
 * filesystem path are both unreadable there, so the register refuses them
 * rather than rendering a link that dead-ends for everyone but its author.
 */
const PRIVATE_REFERENCE = new RegExp([
  "^(?:file|", ["backstage", ""].join(""), "):",
  "|^/Users/|^/var/folders/|^/tmp/|^/private/|^[A-Za-z]:\\\\",
  "|^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::|/|$)",
].join(""), "i");

const PUBLIC_REFERENCE = /^https:\/\/[^\s"'<>]+$/;

const UNIT_SEPARATOR = "\u001f";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const MAX_TEXT = 240;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value, max = MAX_TEXT) {
  if (value == null) return null;
  const out = String(value).replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function instant(value) {
  const text = clean(value, 40);
  if (!text || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The stable issue identity: what a repair would change. Wording, recency,
 * affected-scope count, code revision and evidence are deliberately absent, so
 * a second pass over the same broken adapter folds into the issue that already
 * exists instead of opening a new one.
 */
export function repairIssueKey({ source_contract_id = "", condition = "", adapter = null } = {}) {
  return sha256([
    REPAIR_QUEUE_SCHEMA,
    clean(source_contract_id, 120) || "",
    clean(condition, 80) || "",
    clean(adapter, 80) || "",
  ].join(UNIT_SEPARATOR));
}

/** The ingestion outcome the queue was built from. */
export function repairQueueIngestion({ available = true, reason = null, missing_inputs = [] } = {}) {
  return {
    available: available === true,
    reason: available === true ? null : clean(reason, 300) || "repair observations were not read",
    missing_inputs: [...new Set((Array.isArray(missing_inputs) ? missing_inputs : [])
      .map((path) => clean(path, 300))
      .filter(Boolean))].sort(),
  };
}

function referenceFindings(value, at) {
  const text = clean(value, 500);
  if (!text) return [`${at} is empty`];
  if (PRIVATE_REFERENCE.test(text)) return [`${at} is an owner-only or local reference`];
  if (!PUBLIC_REFERENCE.test(text)) return [`${at} is not a stable https reference`];
  return [];
}

/**
 * Validate the reviewed register. It is edited by hand, it is the only thing
 * that can promote a finding past `candidate`, and every reference on it is
 * rendered as a link, so it is checked rather than trusted.
 */
export function validateRepairQueueRegister(register) {
  const findings = [];
  if (register?.schema !== REPAIR_QUEUE_REGISTER_SCHEMA) findings.push("register schema is not the repair-queue register schema");
  const issues = Array.isArray(register?.issues) ? register.issues : null;
  if (!issues) {
    findings.push("register issues must be an array");
    return findings;
  }
  const seen = new Set();
  issues.forEach((issue, index) => {
    const at = `issues[${index}]`;
    const key = clean(issue?.issue_key, 80);
    if (!/^[a-f0-9]{64}$/.test(String(key || ""))) findings.push(`${at}.issue_key is not a sha256 digest`);
    if (key && seen.has(key)) findings.push(`${at}.issue_key is registered twice`);
    if (key) seen.add(key);
    const identity = issue?.identity || {};
    if (!REPAIR_OBSERVATION_CONDITIONS[clean(identity.condition, 80)]) {
      findings.push(`${at}.identity.condition is outside the closed condition vocabulary`);
    }
    // The readable identity is an echo of the key, not a second source of
    // truth. Re-deriving it here means a hand edit to one and not the other is
    // a failure rather than a silently mismatched row.
    if (key && repairIssueKey(identity) !== key) findings.push(`${at}.identity does not derive ${at}.issue_key`);
    for (const [field, reference] of [
      ["engineering_card", issue?.engineering_card?.reference],
      ["resolution_receipt", issue?.resolution_receipt?.reference],
    ]) {
      if (reference == null) continue;
      findings.push(...referenceFindings(reference, `${at}.${field}.reference`));
    }
    if (issue?.resolution_receipt && !instant(issue.resolution_receipt.at)) {
      findings.push(`${at}.resolution_receipt.at is not an instant`);
    }
    if (issue?.deduplication_verified && !instant(issue.deduplication_verified.at)) {
      findings.push(`${at}.deduplication_verified.at is not an instant`);
    }
  });
  return findings;
}

function registerIndex(register) {
  const rows = new Map();
  for (const issue of Array.isArray(register?.issues) ? register.issues : []) {
    const key = clean(issue?.issue_key, 80);
    if (key) rows.set(key, issue);
  }
  return rows;
}

function observationRow(observation) {
  return {
    fingerprint: observation.fingerprint,
    scope_id: observation.scope?.id || null,
    body_id: observation.scope?.body_id || null,
    role: observation.scope?.role || null,
    affected_record_count: observation.scope?.affected_record_count ?? 0,
    detail_code: observation.condition?.detail_code || null,
    origin_url: observation.source?.origin_url || null,
    publisher: observation.owner?.publisher || null,
    first_observed_at: observation.first_observed_at || null,
    last_observed_at: observation.last_observed_at || null,
    observation_count: Number.isInteger(observation.observation_count) ? observation.observation_count : 1,
    evidence: {
      locator: observation.evidence?.locator || null,
      receipt_ref: observation.evidence?.receipt_ref || null,
      receipt_status: observation.evidence?.receipt_status || null,
      fetch_status: observation.evidence?.fetch_status || null,
      examples: Array.isArray(observation.evidence?.examples) ? observation.evidence.examples : [],
    },
    retained: observation.resolved === true,
  };
}

/**
 * The state machine.
 *
 * A condition currently observed takes its disposition's state, unless a person
 * has already recorded a resolution receipt for it — then seeing it again is a
 * REGRESSION, which is a different fact from a first sighting and reads
 * differently on the desk. A condition with a resolution receipt that is no
 * longer observed is `resolved`. Nothing else can produce `resolved`: the queue
 * never decides on its own that a repair is finished.
 */
function issueState({ disposition, observed, resolutionReceipt }) {
  if (resolutionReceipt) return observed ? "regressed" : "resolved";
  if (disposition === "repair") return "repair-candidate";
  if (disposition === "expected-absence") return "expected-absence";
  return "source-policy-limitation";
}

/**
 * Fold observations into issues.
 *
 * `previousObservations` is optional and is only a way to compare two passes in
 * hand: the committed build passes none, so the artifact is a pure function of
 * the current pass and the reviewed register and re-running it cannot move a
 * number.
 */
export function buildRepairQueue({
  observations = [],
  previousObservations = [],
  register = null,
  observedAt = null,
  sourceVintage = null,
  ingestion = { available: true },
} = {}) {
  const state = repairQueueIngestion(ingestion);
  const registerFindings = register ? validateRepairQueueRegister(register) : [];
  if (registerFindings.length) throw new Error(`repair-queue register rejected: ${registerFindings.join("; ")}`);
  const registered = registerIndex(register);
  const counts = Object.fromEntries(REPAIR_QUEUE_STATES.map((row) => [row, 0]));

  if (!state.available) {
    // An unread queue is not an empty queue. Counts are withheld rather than
    // reported as zero, so nothing downstream can render an all-clear from a
    // failure.
    return {
      schema: REPAIR_QUEUE_SCHEMA,
      status: "unavailable",
      visibility: "private",
      consumer: "authenticated desk",
      observed_at: instant(observedAt),
      source_vintage: instant(sourceVintage),
      ingestion: state,
      states: REPAIR_QUEUE_STATES,
      counts: null,
      issue_count: null,
      open_work_count: null,
      issues: [],
    };
  }

  const merged = mergeRepairObservations(previousObservations, observations, { observedAt });
  const groups = new Map();
  for (const observation of merged) {
    const condition = observation?.condition?.id;
    if (!condition) continue;
    const identity = {
      source_contract_id: observation.source?.contract_id || null,
      condition,
      adapter: observation.source?.adapter || null,
    };
    const key = repairIssueKey(identity);
    const group = groups.get(key) || { key, identity, rows: [] };
    group.rows.push(observation);
    groups.set(key, group);
  }

  // Registered issues that this pass did not observe still belong on the desk:
  // that is precisely what `resolved` means, and dropping them would erase the
  // receipt that closed them.
  for (const [key, issue] of registered) {
    if (!groups.has(key) && issue?.resolution_receipt) {
      groups.set(key, { key, identity: issue.identity || {}, rows: [] });
    }
  }

  const issues = [...groups.values()].map((group) => {
    const live = group.rows.filter((row) => row.resolved !== true);
    const observed = live.length > 0;
    const entry = registered.get(group.key) || null;
    const conditionEntry = REPAIR_OBSERVATION_CONDITIONS[group.identity.condition] || null;
    const disposition = conditionEntry?.disposition || group.rows[0]?.condition?.disposition || null;
    const rows = group.rows.map(observationRow).sort((left, right) => compare(left.scope_id, right.scope_id)
      || compare(left.fingerprint, right.fingerprint));
    const firstObserved = rows.map((row) => row.first_observed_at).filter(Boolean).sort()[0] || null;
    const lastObserved = rows.map((row) => row.last_observed_at).filter(Boolean).sort().at(-1) || null;
    // The evidence that RECORDED the issue, not the newest sighting of it: an
    // operator opening a group wants the receipt the condition came from.
    const original = rows.slice().sort((left, right) => compare(left.first_observed_at || "", right.first_observed_at || "")
      || compare(left.fingerprint, right.fingerprint))[0] || null;
    const owner = group.rows[0]?.owner || {};
    return {
      issue_key: group.key,
      identity: group.identity,
      state: issueState({ disposition, observed, resolutionReceipt: entry?.resolution_receipt || null }),
      disposition,
      detail: conditionEntry?.detail || null,
      affected_scopes: live.length,
      retained_scopes: rows.length - live.length,
      affected_records: live.reduce((total, row) => total + (row.scope?.affected_record_count || 0), 0),
      observation_count: rows.reduce((total, row) => total + row.observation_count, 0),
      first_observed_at: firstObserved,
      last_observed_at: lastObserved,
      owner: {
        source_contract_id: owner.source_contract_id || group.identity.source_contract_id || null,
        publishers: [...new Set(rows.map((row) => row.publisher).filter(Boolean))].sort(),
        code_paths: Array.isArray(owner.code_paths) ? owner.code_paths : [],
      },
      revision: group.rows[0]?.revision || { source_vintage: null, code_revision: null },
      original_evidence: original ? original.evidence : null,
      verification: entry?.deduplication_verified ? "deduplication-verified" : "candidate",
      deduplication_verified: entry?.deduplication_verified || null,
      engineering_card: entry?.engineering_card || null,
      resolution_receipt: entry?.resolution_receipt || null,
      observations: rows,
    };
  }).sort((left, right) => REPAIR_QUEUE_STATES.indexOf(left.state) - REPAIR_QUEUE_STATES.indexOf(right.state)
    || right.affected_scopes - left.affected_scopes
    || compare(left.identity.condition || "", right.identity.condition || "")
    || compare(String(left.identity.adapter), String(right.identity.adapter))
    || compare(left.issue_key, right.issue_key));

  for (const issue of issues) counts[issue.state] += 1;
  return {
    schema: REPAIR_QUEUE_SCHEMA,
    status: "available",
    visibility: "private",
    consumer: "authenticated desk",
    observed_at: instant(observedAt),
    source_vintage: instant(sourceVintage),
    ingestion: state,
    states: REPAIR_QUEUE_STATES,
    counts,
    issue_count: issues.length,
    open_work_count: issues.filter((issue) => REPAIR_QUEUE_WORK_STATES.includes(issue.state)).length,
    issues,
  };
}

/** Every disposition maps onto a state, so a new condition cannot fall through. */
export function repairQueueStateForDisposition(disposition) {
  if (!REPAIR_DISPOSITIONS.includes(disposition)) throw new Error(`unknown repair disposition: ${disposition}`);
  return issueState({ disposition, observed: true, resolutionReceipt: null });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function reference(row, fallback) {
  if (!row?.reference) return fallback;
  const label = esc(row.label || row.reference);
  return `<a href="${esc(row.reference)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function scopeRows(issue) {
  return issue.observations.map((row) => `<tr${row.retained ? ' class="retained-scope"' : ""}>
      <th scope="row">${esc(row.scope_id)}${row.retained ? ' <span class="queue-flag">no longer observed</span>' : ""}</th>
      <td>${esc(row.role || "not recorded")}</td>
      <td>${esc(row.publisher || "not recorded")}</td>
      <td>${esc(row.detail_code || "not recorded")}</td>
      <td>${esc(row.last_observed_at || "not recorded")}</td>
      <td class="queue-evidence">${esc(row.evidence.locator || "not recorded")}${row.evidence.receipt_ref ? `<small>${esc(row.evidence.receipt_ref)}</small>` : ""}${row.evidence.fetch_status ? `<small>fetch ${esc(row.evidence.fetch_status)}</small>` : ""}</td>
    </tr>`).join("\n");
}

/**
 * One expandable row per issue. The summary carries what decides whether to
 * open it — state, scope count, recency, whether a person has verified the
 * grouping — and the body carries the owner, the existing record, the
 * resolution receipt, the evidence that first recorded the condition, and every
 * affected scope. Expansion is a `details` element, so the detail is reachable
 * with the keyboard and present for assistive technology before any script runs.
 */
export function renderRepairQueueIssue(issue) {
  const label = REPAIR_QUEUE_STATE_LABELS[issue.state] || issue.state;
  const search = [
    issue.identity.condition, issue.identity.adapter, issue.identity.source_contract_id,
    issue.state, issue.verification, issue.detail,
    ...issue.owner.publishers, ...issue.observations.map((row) => row.scope_id),
  ].filter(Boolean).join(" ").toLowerCase();
  const codePaths = issue.owner.code_paths.length
    ? `<ul>${issue.owner.code_paths.map((path) => `<li><code>${esc(path)}</code></li>`).join("")}</ul>`
    : "<p>No owning code path is declared on the source contract.</p>";
  const publishers = issue.owner.publishers.length
    ? issue.owner.publishers.map(esc).join(", ")
    : "Not recorded";
  const evidence = issue.original_evidence
    ? `<dl class="queue-detail"><dt>Locator</dt><dd><code>${esc(issue.original_evidence.locator || "not recorded")}</code></dd><dt>Receipt</dt><dd>${esc(issue.original_evidence.receipt_ref || "not recorded")}</dd><dt>Receipt status</dt><dd>${esc(issue.original_evidence.receipt_status || "not recorded")}</dd><dt>First observed</dt><dd>${esc(issue.first_observed_at || "not recorded")}</dd></dl>`
    : "<p>No observation evidence is retained for this issue.</p>";
  const verified = issue.deduplication_verified
    ? `Verified ${esc(issue.deduplication_verified.at)} by ${esc(issue.deduplication_verified.by || "the source-contract owner")}${issue.deduplication_verified.basis ? ` — ${esc(issue.deduplication_verified.basis)}` : ""}`
    : "Candidate. Grouping is derived from source contract, condition and adapter and has not been verified by the record’s producer.";
  const receipt = issue.resolution_receipt
    ? `<dl class="queue-detail"><dt>Resolved</dt><dd>${esc(issue.resolution_receipt.at)}</dd><dt>Outcome</dt><dd>${esc(issue.resolution_receipt.outcome || "not recorded")}</dd><dt>Reference</dt><dd>${reference(issue.resolution_receipt, "Not recorded")}</dd></dl>`
    : "<p>No resolution receipt is recorded.</p>";
  return `<details class="queue-issue" data-repair-issue="${esc(issue.issue_key)}" data-repair-state="${esc(issue.state)}" data-repair-verification="${esc(issue.verification)}" data-search="${esc(search)}">
    <summary>
      <span class="queue-state queue-state-${esc(issue.state)}">${esc(label)}</span>
      <span class="queue-title">${esc(issue.identity.condition)}<small>${esc(issue.identity.adapter || "no adapter declared")} · ${esc(issue.identity.source_contract_id || "no source contract")}</small></span>
      <span class="queue-scope">${issue.affected_scopes} affected scope${issue.affected_scopes === 1 ? "" : "s"}${issue.retained_scopes ? ` · ${issue.retained_scopes} retained` : ""}</span>
      <span class="queue-seen">Last seen ${esc(issue.last_observed_at || "not recorded")}</span>
      <span class="queue-verification queue-verification-${esc(issue.verification)}">${issue.verification === "deduplication-verified" ? "Deduplication verified" : "Candidate"}</span>
    </summary>
    <div class="queue-body">
      <p class="queue-lede">${esc(issue.detail || "No condition detail is recorded.")}</p>
      <h3>Owner</h3><p>${publishers}<br><small>source contract ${esc(issue.owner.source_contract_id || "not recorded")} · code revision ${esc(issue.revision?.code_revision || "not recorded")}</small></p>${codePaths}
      <h3>Existing engineering record</h3><p>${reference(issue.engineering_card, "No existing record is linked to this issue.")}</p>
      <h3>Deduplication</h3><p>${verified}</p>
      <h3>Resolution receipt</h3>${receipt}
      <h3>Original evidence</h3>${evidence}
      <h3>Affected scopes</h3>
      <div class="queue-table-wrap" tabindex="0" role="region" aria-label="Affected scopes for ${esc(issue.identity.condition)} via ${esc(issue.identity.adapter || "no adapter")}"><table><thead><tr><th>Scope</th><th>Role</th><th>Publisher</th><th>Detail code</th><th>Last seen</th><th>Evidence</th></tr></thead><tbody>
${scopeRows(issue)}
      </tbody></table></div>
    </div>
  </details>`;
}

/**
 * The desk section. An unavailable ingestion renders as an explicit failure
 * with its reason and the inputs it could not read — never as an empty queue,
 * which would read as an all-clear the pass did not earn.
 */
export function renderRepairQueueSection(queue) {
  if (queue?.status !== "available") {
    const missing = queue?.ingestion?.missing_inputs?.length
      ? `<ul>${queue.ingestion.missing_inputs.map((path) => `<li><code>${esc(path)}</code></li>`).join("")}</ul>`
      : "";
    return `<section class="repair-view" id="repairView" hidden aria-labelledby="repairHeading">
  <h2 id="repairHeading">Repair queue</h2>
  <div class="queue-unavailable" role="status"><strong>Repair queue unavailable.</strong> ${esc(queue?.ingestion?.reason || "repair observations were not read")}. This is not an all-clear: no condition was evaluated in this pass.${missing}</div>
</section>`;
  }
  const pills = queue.states
    .map((state) => `<span class="pill queue-count queue-state-${esc(state)}">${queue.counts[state]} ${esc(REPAIR_QUEUE_STATE_LABELS[state] || state)}</span>`)
    .join("");
  const options = queue.states
    .map((state) => `<option value="${esc(state)}">${esc(REPAIR_QUEUE_STATE_LABELS[state] || state)}</option>`)
    .join("");
  const issues = queue.issues.length
    ? queue.issues.map(renderRepairQueueIssue).join("\n")
    : `<p class="queue-empty">Every registered condition was evaluated and none produced an observation in this pass. Ingestion reported ${esc(queue.ingestion.available ? "available" : "unavailable")}, so this is a measured empty queue rather than an unread one.</p>`;
  return `<section class="repair-view" id="repairView" hidden aria-labelledby="repairHeading">
  <h2 id="repairHeading">Repair queue</h2>
  <p class="queue-lede">One row per repair, not one per symptom: observations are grouped by the source contract, condition and adapter a repair would change. Only repair candidates and regressions are engineering work; expected absence and source-policy limitation record that a condition was evaluated and correctly needs no repair. Grouping stays a candidate until the record’s producer verifies it.</p>
  <div class="meta">${pills}<span class="pill">${queue.open_work_count} open repair${queue.open_work_count === 1 ? "" : "s"}</span><span class="pill">Observed ${esc(queue.observed_at || "not recorded")}</span></div>
  <div class="controls">
    <label for="repairState">Filter by state</label>
    <select id="repairState"><option value="">All states</option>${options}</select>
  </div>
  <div class="queue-list" id="repairList">
${issues}
  </div>
  <p class="foot">Derived from committed source receipts and materialized source states through <code>tools/repair_observations.mjs</code>. Deduplication verification, existing-record links and resolution receipts come from the reviewed register at <code>${esc(REPAIR_QUEUE_REGISTER_PATH)}</code>; nothing on this view is served, and no field of it may reach a public response.</p>
</section>`;
}
