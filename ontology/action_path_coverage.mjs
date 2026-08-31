/**
 * Bounded Civic Action Path coverage measurement.
 *
 * This is an evidence scorecard over Action Path v0, exact continuation replay,
 * and source-qualified Community Board participation. It does not invent a
 * second action vocabulary and it does not treat button density, unknown
 * values, or stale sources as coverage.
 */

export const ACTION_PATH_COVERAGE_SCHEMA = "cityscroll.action_path_coverage.v1";
export const ACTION_PATH_COVERAGE_METHOD = "action_path_coverage_v1";
export const ACTION_PATH_COVERAGE_VERSION = 1;
export const ACTION_PATH_COVERAGE_DIMENSION = "action-path";

export const ACTION_PATH_COVERAGE_CLASSIFICATIONS = Object.freeze([
  "no_action",
  "action_only",
  "target_unknown",
  "continuation_unknown",
  "continuation_not_replayable",
  "grounded_path",
  "stale_opportunity",
]);

export const VALUE_BASES = Object.freeze(["measured", "derived", "estimated", "unknown"]);

const FORBIDDEN_PROXY = /button density|button_count|all DOT rules|all DOT hearings|citywide policy|synthetic action coverage/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 2_000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function labeledValue(value, basis) {
  if (value == null || value === "") {
    return freezeDeep({ value: null, basis: "unknown" });
  }
  if (!VALUE_BASES.includes(basis)) {
    throw new TypeError(`unsupported value basis: ${basis}`);
  }
  return freezeDeep({ value, basis });
}

export function labeledRatio(numerator, denominator) {
  const num = Number(numerator);
  const den = Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
    return labeledValue(null, "unknown");
  }
  return labeledValue(Number((num / den).toFixed(6)), "derived");
}

function truthy(value) {
  return value === true;
}

/**
 * Classify one retained action-path sample. Opportunity, target, continuation,
 * and replay stay separate; a missing action is a valid class.
 */
export function classifyActionPathCoverageRow(row = {}) {
  const actionPresent = truthy(row.action_present);
  const actionAvailable = truthy(row.action_available);
  const targetStatus = text(row.target_status, 40) || "missing";
  const continuationStatus = text(row.continuation_status, 40) || "none";
  const continuationProposed = truthy(row.continuation_proposed);
  const stale = truthy(row.opportunity_stale);
  const claimedCurrent = truthy(row.opportunity_claimed_current);

  if (stale && (claimedCurrent || actionAvailable || truthy(row.application_cta))) {
    return "stale_opportunity";
  }
  if (!actionPresent || !actionAvailable) return "no_action";
  if (targetStatus !== "grounded") return "target_unknown";
  if (continuationProposed && continuationStatus === "not_replayable") {
    return "continuation_not_replayable";
  }
  if (continuationStatus === "unknown") return "continuation_unknown";
  if (continuationStatus === "grounded") return "grounded_path";
  return "action_only";
}

function entityKey(row) {
  return `${text(row.entity_ref, 240) || row.id}@${text(row.as_of, 40) || ""}`;
}

function countBy(rows, fn) {
  return rows.reduce((total, row) => total + (fn(row) ? 1 : 0), 0);
}

/**
 * Measure grounded actionability, exact replay, current opportunity, and
 * application-source currency from retained sample rows.
 */
export function measureActionPathCoverage(rowsInput = []) {
  const rows = (Array.isArray(rowsInput) ? rowsInput : []).map((row, index) => {
    const classified = {
      ...row,
      id: text(row.id, 160) || `row-${index + 1}`,
      classification: classifyActionPathCoverageRow(row),
    };
    return freezeDeep(classified);
  });

  const actionsSampled = rows.filter((row) => row.counts_as_action !== false);
  const actionsWithGroundedTarget = countBy(
    actionsSampled,
    (row) => row.action_present && row.target_status === "grounded",
  );
  const actionsWithGroundedContinuation = countBy(
    actionsSampled,
    (row) => row.action_present && row.continuation_status === "grounded",
  );
  const continuationsProposed = rows.filter((row) => row.continuation_proposed);
  const continuationsExactlyReplayable = countBy(
    continuationsProposed,
    (row) => row.continuation_replayable === true && row.exact_replay === true,
  );

  const entities = new Map();
  for (const row of rows) {
    const key = entityKey(row);
    const current = Boolean(
      row.action_available
      && row.opportunity_stale !== true
      && row.classification !== "stale_opportunity"
      && row.classification !== "no_action",
    );
    const prior = entities.get(key) || { current: false };
    entities.set(key, { current: prior.current || current });
  }

  const applicationCtas = rows.filter((row) => row.application_cta === true);
  const currentApplicationCtas = countBy(
    applicationCtas,
    (row) => row.application_source_current === true,
  );

  const classifications = Object.fromEntries(
    ACTION_PATH_COVERAGE_CLASSIFICATIONS.map((name) => [
      name,
      rows.filter((row) => row.classification === name).map((row) => row.id),
    ]),
  );

  const crossBoard = countBy(rows, (row) => row.cross_board_inference === true);
  const broadFallback = rows.some((row) => row.broad_fallback === true);
  const synthetic = rows.some((row) => row.synthetic_action === true);
  const unknownAsZero = false;

  const metrics = {
    actions_sampled: labeledValue(actionsSampled.length, "measured"),
    actions_with_grounded_target: labeledValue(actionsWithGroundedTarget, "measured"),
    actions_with_grounded_continuation: labeledValue(actionsWithGroundedContinuation, "measured"),
    continuations_proposed: labeledValue(continuationsProposed.length, "measured"),
    continuations_exactly_replayable: labeledValue(continuationsExactlyReplayable, "measured"),
    entities_sampled: labeledValue(entities.size, "measured"),
    entities_with_current_action: labeledValue(
      [...entities.values()].filter((row) => row.current).length,
      "measured",
    ),
    application_ctas: labeledValue(applicationCtas.length, "measured"),
    current_application_ctas_with_current_source: labeledValue(currentApplicationCtas, "measured"),
    cross_board_inference_violations: labeledValue(crossBoard, "measured"),
    grounded_target_rate: labeledRatio(actionsWithGroundedTarget, actionsSampled.length),
    grounded_continuation_rate: labeledRatio(actionsWithGroundedContinuation, actionsSampled.length),
    exact_replay_rate: labeledRatio(continuationsExactlyReplayable, continuationsProposed.length),
    current_action_rate: labeledRatio(
      [...entities.values()].filter((row) => row.current).length,
      entities.size,
    ),
    current_application_cta_rate: labeledRatio(currentApplicationCtas, applicationCtas.length),
  };

  return freezeDeep({
    schema: ACTION_PATH_COVERAGE_SCHEMA,
    method: ACTION_PATH_COVERAGE_METHOD,
    version: ACTION_PATH_COVERAGE_VERSION,
    dimension: ACTION_PATH_COVERAGE_DIMENSION,
    stopping_rule: true,
    reward_button_density: false,
    unknown_as_zero: unknownAsZero,
    metrics,
    classifications,
    rows: rows.map((row) => ({
      id: row.id,
      family: row.family || null,
      entity_ref: row.entity_ref || null,
      as_of: row.as_of || null,
      classification: row.classification,
      action_type: row.action_type || null,
      target_ref: row.target_ref || null,
      continuation_ref: row.continuation_ref || null,
      exact_replay: row.exact_replay === true,
      application_cta: row.application_cta === true,
      cross_board_inference: row.cross_board_inference === true,
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
    })),
    gate: {
      cross_board_inference_violations: crossBoard,
      broad_fallback: broadFallback,
      synthetic_action_reward: synthetic,
      unknown_as_zero: unknownAsZero,
      reward_button_density: false,
    },
  });
}

export function actionPathCoverageFindings(receipt, { requireAllClasses = true } = {}) {
  const findings = [];
  if (!isRecord(receipt) || receipt.schema !== ACTION_PATH_COVERAGE_SCHEMA) {
    return [{ message: "coverage receipt is missing the action-path schema" }];
  }
  if (receipt.reward_button_density === true) {
    findings.push({ message: "coverage must not reward button density" });
  }
  if (receipt.unknown_as_zero === true) {
    findings.push({ message: "unknown values must not be coerced to zero" });
  }
  const metrics = receipt.metrics || {};
  for (const key of [
    "actions_sampled",
    "actions_with_grounded_target",
    "actions_with_grounded_continuation",
    "continuations_proposed",
    "continuations_exactly_replayable",
    "entities_sampled",
    "entities_with_current_action",
    "application_ctas",
    "current_application_ctas_with_current_source",
    "cross_board_inference_violations",
  ]) {
    const cell = metrics[key];
    if (!isRecord(cell) || cell.basis !== "measured" || typeof cell.value !== "number") {
      findings.push({ message: `${key} must be a measured denominator or numerator` });
    }
  }
  for (const key of [
    "grounded_target_rate",
    "grounded_continuation_rate",
    "exact_replay_rate",
    "current_action_rate",
    "current_application_cta_rate",
  ]) {
    const cell = metrics[key];
    if (!isRecord(cell) || !VALUE_BASES.includes(cell.basis)) {
      findings.push({ message: `${key} is missing a value basis` });
    }
    if (cell?.basis === "unknown" && cell.value === 0) {
      findings.push({ message: `${key} turned unknown into zero` });
    }
  }
  if (metrics.cross_board_inference_violations?.value !== 0) {
    findings.push({ message: "cross_board_inference_violations must be 0" });
  }
  if (receipt.gate?.broad_fallback === true) {
    findings.push({ message: "coverage used a broad board or DOT fallback" });
  }
  if (receipt.gate?.synthetic_action_reward === true) {
    findings.push({ message: "coverage rewarded a synthetic action" });
  }
  const blob = JSON.stringify(receipt);
  if (FORBIDDEN_PROXY.test(blob)) {
    findings.push({ message: "coverage infers completeness from a forbidden proxy" });
  }
  if (requireAllClasses) {
    for (const name of ACTION_PATH_COVERAGE_CLASSIFICATIONS) {
      if (!Array.isArray(receipt.classifications?.[name]) || receipt.classifications[name].length === 0) {
        findings.push({ message: `missing diagnostic class ${name}` });
      }
    }
  }
  return findings;
}

export function assertActionPathCoverageContract(receipt, options) {
  const findings = actionPathCoverageFindings(receipt, options);
  if (findings.length) {
    const error = new Error(findings.map((row) => row.message).join("; "));
    error.findings = findings;
    throw error;
  }
  return receipt;
}

export function renderActionPathCoverageMarkdown(receipt) {
  const m = receipt.metrics || {};
  const ratio = (numKey, denKey, rateKey) => {
    const num = m[numKey]?.value;
    const den = m[denKey]?.value;
    const rate = m[rateKey];
    const rateText = rate?.basis === "unknown" ? "unknown" : String(rate?.value);
    return `${num} / ${den} = ${rateText} (${rate?.basis || "unknown"})`;
  };
  const lines = [
    "# Action Path coverage",
    "",
    "This receipt measures grounded targets, grounded continuations, exact replay, current actions, and current application sources. Legitimate no-action civic objects remain valid. Button density is not a coverage target.",
    "",
    "## Ratios",
    "",
    `- actions_with_grounded_target / actions_sampled: ${ratio("actions_with_grounded_target", "actions_sampled", "grounded_target_rate")}`,
    `- actions_with_grounded_continuation / actions_sampled: ${ratio("actions_with_grounded_continuation", "actions_sampled", "grounded_continuation_rate")}`,
    `- continuations_exactly_replayable / continuations_proposed: ${ratio("continuations_exactly_replayable", "continuations_proposed", "exact_replay_rate")}`,
    `- entities_with_current_action / entities_sampled: ${ratio("entities_with_current_action", "entities_sampled", "current_action_rate")}`,
    `- current_application_ctas_with_current_source / application_ctas: ${ratio("current_application_ctas_with_current_source", "application_ctas", "current_application_cta_rate")}`,
    `- cross_board_inference_violations: ${m.cross_board_inference_violations?.value} (measured)`,
    "",
    "## Diagnostic classes",
    "",
  ];
  for (const name of ACTION_PATH_COVERAGE_CLASSIFICATIONS) {
    const ids = receipt.classifications?.[name] || [];
    lines.push(`- ${name} (${ids.length}): ${ids.join(", ") || "none"}`);
  }
  lines.push("", "## Sampled rows", "");
  for (const row of receipt.rows || []) {
    lines.push(`- ${row.id}: ${row.classification} entity=${row.entity_ref || "none"} action=${row.action_type || "none"} continuation=${row.continuation_ref || "none"} exact_replay=${row.exact_replay}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
