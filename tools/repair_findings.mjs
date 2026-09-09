/**
 * Monitor findings, in the one shape the repair queue can key on.
 *
 * The scheduled monitors already say precisely what broke: which source
 * contract went stale, which rehearsal came back degraded, which scheduled slot
 * left no result. Until now that knowledge reached exactly one place — a GitHub
 * issue a person reads — so every repeat of a condition the loop already knew
 * about waited on somebody to notice it again.
 *
 * This module is the translation layer. It turns a monitor's own result into
 * zero or more FINDINGS, each carrying a stable signature, and into RECOVERY
 * SCOPES that say which findings of that shape are no longer happening. The
 * queue keys on the signature, so a condition that repeats folds into the item
 * that already exists rather than opening a second one.
 *
 * Three properties carry the contract:
 *
 *  - **The signature is the identity, and it is readable.** `monitor:<monitor
 *    id>:<failure class>[:<subject>]` — the monitor that observed it, the class
 *    of failure, and the contract, rehearsal or slot it is about. A digest
 *    would dedupe just as well and would tell a dispatcher nothing; the whole
 *    point of a deterministic repair rail is that the item says which playbook
 *    applies.
 *  - **Recovery is stated as a scope, never as a list of survivors.** A healthy
 *    monitor run knows what is still failing; it does not know what was failing
 *    yesterday. So a run reports the scope it just evaluated and the subjects
 *    still failing inside it, and the queue closes everything else in that
 *    scope. A monitor that recovers completely therefore closes its items
 *    without having to remember them.
 *  - **A finding describes; it never instructs.** Text is bounded and redacted
 *    here, before it leaves the host, and no field of a finding is ever read as
 *    something to run. The playbooks act; the queue only ever describes.
 */

export const REPAIR_FINDING_SCHEMA = "cityscroll.repair-monitor-finding.v1";
export const REPAIR_SIGNATURE_PREFIX = "monitor";
export const REPAIR_SIGNATURE_LIMIT = 128;
export const REPAIR_FINDING_TEXT_LIMIT = 200;
export const REPAIR_FINDING_COUNT = 5;
/** Bounded so one pathological cycle cannot grow the heartbeat without limit. */
export const REPAIR_FINDING_LIMIT = 25;
export const REPAIR_RECOVERY_SCOPE_LIMIT = 25;
export const REPAIR_RECOVERY_SUBJECT_LIMIT = 100;

/**
 * The closed failure vocabulary. A class is what decides whether a playbook
 * exists, so it is a reviewable constant rather than free text derived from a
 * publisher's error message.
 */
export const REPAIR_FAILURE_CLASSES = Object.freeze([
  "source-contract-stale",
  "source-contract-outage",
  "source-contract-schema-drift",
  "freshness-stale",
  "publication-cycle-stalled",
  "digest-shadow-upstream",
  "digest-shadow-credential",
  "digest-shadow-degraded",
  "action-link-degraded",
  "stats-snapshot-missing",
  "missed-slot",
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const TOKEN_DISALLOWED = /[^A-Za-z0-9._-]+/g;

/**
 * Bounded, redacted prose. The same discipline the queue applies on the way in,
 * applied here as well, so nothing unbounded or credential-shaped is ever put
 * on the wire in the first place.
 */
export function sanitizeFindingText(value, limit = REPAIR_FINDING_TEXT_LIMIT) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted-credential]")
    .replace(/\b(?:authorization|token|api[_-]?key|apikey|secret|password|credential)\b\s*[:=]\s*\S+/gi, "[redacted-credential]")
    .replace(/([?&](?:token|s)=)[^&\s]+/gi, "$1[redacted]")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** One signature segment: an identifier, never a sentence and never a path. */
export function signatureToken(value, limit = 64) {
  return String(value ?? "")
    .replace(TOKEN_DISALLOWED, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit);
}

/**
 * The queue key. Readable on purpose: a dispatcher selects its playbook from
 * this string alone, and an operator reading the private queue can see what a
 * row is about without opening it.
 */
export function repairSignature({ monitor, failureClass, subject = null } = {}) {
  const monitorToken = signatureToken(monitor);
  const classToken = signatureToken(failureClass);
  if (!monitorToken || !classToken) return null;
  if (!REPAIR_FAILURE_CLASSES.includes(classToken)) return null;
  const subjectToken = subject == null ? "" : signatureToken(subject);
  const parts = [REPAIR_SIGNATURE_PREFIX, monitorToken, classToken];
  if (subjectToken) parts.push(subjectToken);
  const signature = parts.join(":");
  return signature.length <= REPAIR_SIGNATURE_LIMIT ? signature : null;
}

/** The scope prefix a recovery report closes: every signature under it. */
export function repairScopePrefix({ monitor, failureClass } = {}) {
  const monitorToken = signatureToken(monitor);
  const classToken = signatureToken(failureClass);
  if (!monitorToken || !classToken || !REPAIR_FAILURE_CLASSES.includes(classToken)) return null;
  return `${REPAIR_SIGNATURE_PREFIX}:${monitorToken}:${classToken}`;
}

/**
 * Read a signature back apart. The dispatcher does this and nothing else to
 * decide which playbook applies, so an unparseable signature is a decision for
 * a person rather than a guess.
 */
export function parseRepairSignature(signature) {
  const text = String(signature ?? "");
  if (text.length > REPAIR_SIGNATURE_LIMIT) return null;
  const parts = text.split(":");
  if (parts.length < 3 || parts.length > 4) return null;
  const [prefix, monitor, failureClass, subject = null] = parts;
  if (prefix !== REPAIR_SIGNATURE_PREFIX) return null;
  if (!monitor || signatureToken(monitor) !== monitor) return null;
  if (!REPAIR_FAILURE_CLASSES.includes(failureClass)) return null;
  if (subject != null && (!subject || signatureToken(subject) !== subject)) return null;
  return { monitor, failure_class: failureClass, subject };
}

function finding({ monitor, failureClass, subject = null, findings = [], observedAt = null }) {
  const signature = repairSignature({ monitor, failureClass, subject });
  if (!signature) return null;
  const text = (Array.isArray(findings) ? findings : [findings])
    .map((row) => sanitizeFindingText(row))
    .filter(Boolean)
    .slice(0, REPAIR_FINDING_COUNT);
  return {
    signature,
    guard: signatureToken(monitor, 80),
    stage: failureClass,
    findings: text.length ? text : [`${monitor} reported ${failureClass}`],
    last_seen: observedAt,
  };
}

function scope({ monitor, failureClass, stillFailing = [] }) {
  const prefix = repairScopePrefix({ monitor, failureClass });
  if (!prefix) return null;
  return {
    prefix,
    still_failing: [...new Set((Array.isArray(stillFailing) ? stillFailing : [])
      .map((value) => signatureToken(value))
      .filter(Boolean))]
      .sort()
      .slice(0, REPAIR_RECOVERY_SUBJECT_LIMIT),
  };
}

/**
 * The classification the source-contract monitor already performs, named as a
 * repair failure class. The monitor's own words decide it; nothing here
 * re-reads the publisher.
 */
export function sourceContractFailureClass(detail) {
  const text = String(detail ?? "");
  if (/stale/i.test(text)) return "source-contract-stale";
  if (/fetch failed|HTTP 5\d\d|ENOTFOUND|timed out|DNS/i.test(text)) return "source-contract-outage";
  return "source-contract-schema-drift";
}

/**
 * The upstream fault inside a degraded rehearsal, if there is one.
 *
 * The rehearsal answers the monitor with HTTP 200 and reports its own trouble
 * in redlines, so an upstream outage arrives as a `render_error` whose evidence
 * names a gateway status rather than as a status on the probe itself. Both
 * shapes are read here, and a rehearsal that failed for any other reason
 * reports nothing, which is what keeps a content redline out of the retry path.
 */
export function upstreamFailureEvidence(result) {
  // The runner identifies source incidents separately from digest redlines.
  if (result?.fault_domain === "upstream_source") return "the rehearsal reports an unavailable upstream source";
  const status = Number(result?.http_status);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return `upstream status ${status}`;
  const redlines = Array.isArray(result?.summary?.redlines) ? result.summary.redlines : [];
  for (const redline of redlines) {
    if (String(redline?.code || "") !== "render_error") continue;
    const evidence = sanitizeFindingText(redline?.evidence?.error, 120);
    if (!/\b5\d{2}\b/.test(evidence)) continue;
    const digest = sanitizeFindingText(redline?.digest_id, 60) || "an unnamed digest";
    return `render_error for ${digest} reports ${evidence}`;
  }
  return null;
}

/** The digest rehearsal's degraded reason, named as a repair failure class. */
export function digestShadowFailureClass(result) {
  const reason = String(result?.degraded_reason || "");
  if (reason === "admin-credential-missing" || reason === "admin-credential-rejected") return "digest-shadow-credential";
  if (upstreamFailureEvidence(result)) return "digest-shadow-upstream";
  return "digest-shadow-degraded";
}

const SOURCE_CONTRACT_CLASSES = Object.freeze([
  "source-contract-stale",
  "source-contract-outage",
  "source-contract-schema-drift",
]);

const DIGEST_SHADOW_CLASSES = Object.freeze([
  "digest-shadow-upstream",
  "digest-shadow-credential",
  "digest-shadow-degraded",
]);

function bound({ findings, recovered }) {
  return {
    findings: findings.filter(Boolean).slice(0, REPAIR_FINDING_LIMIT),
    recovered: recovered.filter(Boolean).slice(0, REPAIR_RECOVERY_SCOPE_LIMIT),
  };
}

/**
 * One monitor run in, findings and recovery scopes out.
 *
 * `output` is exactly what the cycle's job runner returned, so this reads the
 * monitor's own structured result rather than re-deriving a verdict from prose.
 */
export function monitorRepairFindings(job, output, { now = null } = {}) {
  const monitor = String(job?.id || "");
  const runner = String(job?.runner || "");
  const result = output?.result || {};
  const observedAt = result.observed_at || now || null;
  const findings = [];
  const recovered = [];
  const add = (row) => { if (row) findings.push(row); };
  const close = (row) => { if (row) recovered.push(row); };

  if (runner === "source-contracts") {
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const byClass = new Map(SOURCE_CONTRACT_CLASSES.map((name) => [name, []]));
    for (const failure of failures) {
      const failureClass = sourceContractFailureClass(failure?.detail);
      byClass.get(failureClass).push(String(failure?.id || ""));
      add(finding({
        monitor,
        failureClass,
        subject: failure?.id,
        findings: [`${failure?.id}: ${failure?.detail}`],
        observedAt,
      }));
    }
    // Every contract the registry carries was evaluated in this pass, so each
    // class is a closed scope: whatever is not still failing has recovered.
    for (const failureClass of SOURCE_CONTRACT_CLASSES) {
      close(scope({ monitor, failureClass, stillFailing: byClass.get(failureClass) }));
    }
    return bound({ findings, recovered });
  }

  if (runner === "source-freshness") {
    const stale = Array.isArray(result.stale_sources) ? result.stale_sources : [];
    for (const row of stale) {
      add(finding({
        monitor,
        failureClass: "freshness-stale",
        subject: row?.source_contract_id,
        findings: [`${row?.source_contract_id}: freshness watchdog is stale (${(row?.reasons || []).join(", ") || "no reason recorded"})`],
        observedAt,
      }));
    }
    close(scope({ monitor, failureClass: "freshness-stale", stillFailing: stale.map((row) => row?.source_contract_id) }));
    const cycle = result.publication_cycle || {};
    const cycleFindings = Array.isArray(cycle.findings) ? cycle.findings : [];
    if (cycleFindings.length) {
      add(finding({
        monitor,
        failureClass: "publication-cycle-stalled",
        subject: cycle.failing_stage || null,
        findings: cycleFindings,
        observedAt,
      }));
    }
    close(scope({
      monitor,
      failureClass: "publication-cycle-stalled",
      stillFailing: cycleFindings.length ? [cycle.failing_stage].filter(Boolean) : [],
    }));
    return bound({ findings, recovered });
  }

  if (runner === "digest-shadow") {
    const degraded = result.status !== "healthy";
    const failureClass = degraded ? digestShadowFailureClass(result) : null;
    if (degraded) {
      add(finding({
        monitor,
        failureClass,
        findings: [
          `the digest rehearsal reported ${result.summary?.status || "an unavailable rehearsal"}`,
          result.degraded_reason ? `degraded reason ${result.degraded_reason}` : null,
          upstreamFailureEvidence(result),
        ].filter(Boolean),
        observedAt,
      }));
    }
    for (const name of DIGEST_SHADOW_CLASSES) {
      close(scope({ monitor, failureClass: name, stillFailing: name === failureClass ? [monitor] : [] }));
    }
    return bound({ findings, recovered });
  }

  if (runner === "action-links") {
    const degraded = result.status !== "healthy";
    if (degraded) {
      add(finding({
        monitor,
        failureClass: "action-link-degraded",
        findings: [`the action-link audit found ${(result.summary?.degraded_patterns || []).length} degraded pattern(s)`],
        observedAt,
      }));
    }
    close(scope({ monitor, failureClass: "action-link-degraded", stillFailing: degraded ? [monitor] : [] }));
    return bound({ findings, recovered });
  }

  if (runner === "stats-daily-snapshot") {
    // Awaiting the first publication is sequencing, not a repair or judgment.
    // Recover the old fault scope too, so a prior misclassification can retire.
    const degraded = result.status !== "healthy" && result.failing_stage !== "publisher-not-yet-delivered";
    if (degraded) {
      add(finding({
        monitor,
        failureClass: "stats-snapshot-missing",
        subject: result.failing_stage || null,
        findings: [`the promised daily snapshot for ${result.promised_day || "the current day"} failed at ${result.failing_stage || "an unrecorded stage"}`],
        observedAt,
      }));
    }
    close(scope({
      monitor,
      failureClass: "stats-snapshot-missing",
      stillFailing: degraded ? [result.failing_stage].filter(Boolean) : [],
    }));
    return bound({ findings, recovered });
  }

  return bound({ findings, recovered });
}

/**
 * A scheduled slot the cycle attempted and that threw.
 *
 * Unlike every other condition on this rail, this is a fact about one moment
 * rather than a state that persists: the slot ledger accounts for it exactly
 * once and then advances past it, so no later cycle observes it again. That is
 * also why it carries NO recovery scope. A scope closes items a monitor has
 * stopped reporting, and a monitor stops reporting a missed slot immediately —
 * so a scope here would close the item on the very next cycle, before anything
 * had a chance to re-run it. The item is closed by its own dispatch instead:
 * the playbook's precondition reports it repaired the moment the slot has a
 * recorded result, whether this rail put it there or another cycle did.
 */
export function missedSlotFindings(job, slotKeys, { observedAt = null } = {}) {
  const monitor = String(job?.id || "");
  const findings = (Array.isArray(slotKeys) ? slotKeys : [])
    .map((slotKey) => finding({
      monitor,
      failureClass: "missed-slot",
      subject: slotKey,
      findings: [`the ${slotKey} slot was attempted and left no recorded result`],
      observedAt,
    }))
    .filter(Boolean);
  return bound({ findings, recovered: [] });
}

/** Merge many monitor runs into the one bounded payload a heartbeat carries. */
export function mergeRepairFindings(parts) {
  const findings = new Map();
  const recovered = new Map();
  for (const part of Array.isArray(parts) ? parts : []) {
    for (const row of part?.findings || []) findings.set(row.signature, row);
    for (const row of part?.recovered || []) {
      const prior = recovered.get(row.prefix);
      recovered.set(row.prefix, prior
        ? { prefix: row.prefix, still_failing: [...new Set([...prior.still_failing, ...row.still_failing])].sort() }
        : row);
    }
  }
  return bound({ findings: [...findings.values()], recovered: [...recovered.values()] });
}
