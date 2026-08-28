/**
 * Measurement-only projection for CB-MONEY-07.
 *
 * It treats a retained payment's immutable transaction_id as the stable delta
 * key and groups those observations into board/calendar-month digest windows.
 * It does not read a live source, create subscriptions, or emit alerts.
 */

export const COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_SCHEMA =
  "cityscroll.community_board_money_follow_feasibility.v1";
export const COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_VERSION = 1;
export const DEFAULT_MEANINGFUL_PAYMENT_COUNT = 3;
export const DEFAULT_MEANINGFUL_MONTHLY_AMOUNT = 5000;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function text(value) {
  return String(value ?? "").trim() || null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cents(value) {
  const number = finite(value);
  return number == null ? null : Math.round(number * 100);
}

function dollars(value) {
  return value == null ? null : Number((value / 100).toFixed(2));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function distribution(values, { amount = false } = {}) {
  const numbers = values.filter(Number.isFinite);
  if (!numbers.length) {
    return { count: 0, min: null, p25: null, median: null, p75: null, p90: null, max: null, mean: null };
  }
  const convert = (value) => amount ? dollars(value) : round(value);
  return {
    count: numbers.length,
    min: convert(Math.min(...numbers)),
    p25: convert(quantile(numbers, 0.25)),
    median: convert(quantile(numbers, 0.5)),
    p75: convert(quantile(numbers, 0.75)),
    p90: convert(quantile(numbers, 0.9)),
    max: convert(Math.max(...numbers)),
    mean: convert(numbers.reduce((sum, value) => sum + value, 0) / numbers.length),
  };
}

function sourceVintageOf(paymentArtifact) {
  return paymentArtifact?.source?.source_vintage || {
    observed_at: paymentArtifact?.source?.observed_at ?? null,
    payment_issue_date_through: paymentArtifact?.source?.source_data_through ?? null,
  };
}

function monthOf(issueDate) {
  const day = text(issueDate);
  return day && ISO_DAY_RE.test(day) ? day.slice(0, 7) : null;
}

function monthRange(firstMonth, lastMonth) {
  if (!firstMonth || !lastMonth || !MONTH_RE.test(firstMonth) || !MONTH_RE.test(lastMonth)) return [];
  const [firstYear, firstNumber] = firstMonth.split("-").map(Number);
  const [lastYear, lastNumber] = lastMonth.split("-").map(Number);
  const first = firstYear * 12 + firstNumber - 1;
  const last = lastYear * 12 + lastNumber - 1;
  if (last < first || last - first > 120) return [];
  return Array.from({ length: last - first + 1 }, (_, offset) => {
    const serial = first + offset;
    const year = Math.floor(serial / 12);
    const month = String((serial % 12) + 1).padStart(2, "0");
    return `${year}-${month}`;
  });
}

function stableObservationId(observation) {
  return text(observation?.transaction_id) || text(observation?.source_observation_ref);
}

function topPayee(payees) {
  return [...payees.entries()]
    .sort((left, right) => right[1].amount_cents - left[1].amount_cents || left[0].localeCompare(right[0]))[0] || null;
}

function boardMonthSummary(group, threshold) {
  const payee = topPayee(group.payees);
  const meaningful = group.payment_count >= threshold.payment_count
    || group.amount_cents >= threshold.monthly_amount_cents;
  return {
    board_id: group.board_id,
    month: group.month,
    payment_count: group.payment_count,
    posted_payment_amount: dollars(group.amount_cents),
    distinct_payee_count: group.payees.size,
    largest_new_payee: payee ? {
      payee_name: payee[0],
      posted_payment_amount: dollars(payee[1].amount_cents),
      payment_count: payee[1].payment_count,
    } : null,
    meaningful_activity: meaningful,
    source_observation_count: group.observation_ids.size,
  };
}

function ratio(numerator, denominator) {
  return denominator ? round(numerator / denominator, 4) : null;
}

/**
 * Measure the retained CB-MONEY-02 observations without selecting a follow
 * implementation. The input is expected to be the committed payment read
 * model, whose observations already carry exact identity and provenance.
 */
export function measureCommunityBoardMoneyFollowFeasibility(paymentArtifact, {
  meaningfulPaymentCount = DEFAULT_MEANINGFUL_PAYMENT_COUNT,
  meaningfulMonthlyAmount = DEFAULT_MEANINGFUL_MONTHLY_AMOUNT,
} = {}) {
  const rows = Array.isArray(paymentArtifact?.rows) ? paymentArtifact.rows : [];
  const threshold = {
    payment_count: Math.max(1, Math.round(Number(meaningfulPaymentCount) || DEFAULT_MEANINGFUL_PAYMENT_COUNT)),
    monthly_amount_cents: Math.max(0, Math.round((Number(meaningfulMonthlyAmount) || DEFAULT_MEANINGFUL_MONTHLY_AMOUNT) * 100)),
  };
  const groups = new Map();
  const seen = new Set();
  const individualPaymentCents = [];
  const issueDateValues = [];
  let duplicateObservationIdsSuppressed = 0;
  const invalidObservations = [];

  for (const row of rows) {
    if (row?.coverage_status === "identity_unobserved") continue;
    const boardId = text(row?.board_id);
    for (const observation of Array.isArray(row?.observations) ? row.observations : []) {
      const id = stableObservationId(observation);
      const month = monthOf(observation?.issue_date);
      const amount = cents(observation?.check_amount);
      if (!boardId || !id || !month || amount == null || !text(observation?.payee_name)) {
        invalidObservations.push({ board_id: boardId, transaction_id: id, issue_date: text(observation?.issue_date) });
        continue;
      }
      if (seen.has(id)) {
        duplicateObservationIdsSuppressed += 1;
        continue;
      }
      seen.add(id);
      individualPaymentCents.push(amount);
      issueDateValues.push(text(observation.issue_date));
      const key = `${boardId}\u0000${month}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          board_id: boardId,
          month,
          payment_count: 0,
          amount_cents: 0,
          payees: new Map(),
          observation_ids: new Set(),
        };
        groups.set(key, group);
      }
      group.payment_count += 1;
      group.amount_cents += amount;
      group.observation_ids.add(id);
      const payee = text(observation.payee_name);
      const current = group.payees.get(payee) || { amount_cents: 0, payment_count: 0 };
      current.amount_cents += amount;
      current.payment_count += 1;
      group.payees.set(payee, current);
    }
  }

  const sourceVintage = sourceVintageOf(paymentArtifact);
  const measuredGroups = [...groups.values()]
    .sort((left, right) => left.month.localeCompare(right.month) || left.board_id.localeCompare(right.board_id));
  const observedBoardIds = [...new Set(measuredGroups.map((group) => group.board_id))].sort();
  const activeMonths = [...new Set(measuredGroups.map((group) => group.month))].sort();
  const months = monthRange(activeMonths[0], activeMonths.at(-1));
  const boardMonths = measuredGroups.map((group) => boardMonthSummary(group, threshold));
  const possibleBoardMonths = observedBoardIds.length * months.length;
  const zeroPaymentBoardMonths = Math.max(0, possibleBoardMonths - boardMonths.length);
  const meaningfulGroups = boardMonths.filter((group) => group.meaningful_activity);
  const allAmountCents = measuredGroups.reduce((sum, group) => sum + group.amount_cents, 0);
  const allPayments = measuredGroups.reduce((sum, group) => sum + group.payment_count, 0);
  const monthSummaries = months.map((month) => {
    const monthGroups = boardMonths.filter((group) => group.month === month);
    return {
      month,
      active_board_count: monthGroups.length,
      payment_count: monthGroups.reduce((sum, group) => sum + group.payment_count, 0),
      posted_payment_amount: monthGroups.reduce((sum, group) => sum + group.posted_payment_amount, 0),
      meaningful_board_count: monthGroups.filter((group) => group.meaningful_activity).length,
    };
  });

  const boardSummaries = observedBoardIds.map((boardId) => {
    const boardGroups = boardMonths.filter((group) => group.board_id === boardId);
    const paymentCount = boardGroups.reduce((sum, group) => sum + group.payment_count, 0);
    const amount = boardGroups.reduce((sum, group) => sum + group.posted_payment_amount, 0);
    return {
      board_id: boardId,
      source_months: months.length,
      active_months: boardGroups.length,
      zero_payment_months: Math.max(0, months.length - boardGroups.length),
      payment_count: paymentCount,
      posted_payment_amount: round(amount),
      average_payments_per_calendar_month: ratio(paymentCount, months.length),
      average_payments_per_active_month: ratio(paymentCount, boardGroups.length),
      meaningful_digest_months: boardGroups.filter((group) => group.meaningful_activity).length,
    };
  });

  const sourceDataThrough = text(paymentArtifact?.source?.source_data_through)
    || text(sourceVintage.payment_issue_date_through)
    || null;
  const sourceSnapshotOnly = !sourceVintage.observed_at;
  return {
    schema: COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_SCHEMA,
    version: COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_VERSION,
    workstream_card: "CB-MONEY-07",
    status: "stop_without_shipping_follow_feature",
    source: {
      artifact: "site/data/community_board_payment_actuals.json",
      receipt: "warehouse/receipts/proof/community_board_payment_actuals_latest.json",
      schema: paymentArtifact?.schema || null,
      version: paymentArtifact?.version || null,
      generated_at: paymentArtifact?.generated_at || null,
      source_system: paymentArtifact?.source?.source_system || null,
      source_contract: paymentArtifact?.source?.source_contract || null,
      publisher: paymentArtifact?.source?.publisher || null,
      endpoint: paymentArtifact?.source?.endpoint || null,
      source_vintage: sourceVintage,
      source_data_through: sourceDataThrough,
      issue_date_range: {
        first: [...issueDateValues].sort()[0] || null,
        last: [...issueDateValues].sort().at(-1) || null,
      },
    },
    sample: {
      method: "all_observed_specific_board_identities_in_CB-MONEY-02",
      sampled_board_count: observedBoardIds.length,
      sampled_board_ids: observedBoardIds,
      fiscal_years: paymentArtifact?.fiscal_years || [],
      board_month_window: months,
      board_month_count_possible: possibleBoardMonths,
      active_board_month_count: boardMonths.length,
      zero_payment_board_month_count: zeroPaymentBoardMonths,
    },
    stable_payment_deltas: {
      key: "transaction_id (fallback: source_observation_ref)",
      within_snapshot: {
        status: invalidObservations.length || duplicateObservationIdsSuppressed ? "bounded_with_suppression" : "stable",
        retained_unique_payment_count: seen.size,
        duplicate_observation_ids_suppressed: duplicateObservationIdsSuppressed,
        invalid_observation_count: invalidObservations.length,
        calendar_month_definition: "issue_date YYYY-MM; each retained transaction_id contributes once to its board/month bucket",
      },
      cross_refresh: {
        status: sourceSnapshotOnly ? "unavailable" : "not_measured",
        reason: sourceSnapshotOnly
          ? "CB-MONEY-02 has one retained source snapshot and observed_at is null; a prior snapshot or watermark is required to establish refresh deltas."
          : "This receipt measures one retained snapshot; refresh comparison is outside this run.",
      },
    },
    measurement: {
      candidate_payment_count: paymentArtifact?.payment_population?.candidate_rows ?? null,
      retained_payment_count: allPayments,
      retained_posted_payment_amount: dollars(allAmountCents),
      source_population_duplicate_rows_suppressed: paymentArtifact?.payment_population?.duplicate_rows_suppressed ?? null,
      source_observation_references: seen.size,
      invalid_observations: invalidObservations,
      payment_frequency: {
        per_active_board_month: distribution(boardMonths.map((group) => group.payment_count)),
        per_calendar_board_month: {
          count: possibleBoardMonths,
          mean: ratio(allPayments, possibleBoardMonths),
          active_month_rate: ratio(boardMonths.length, possibleBoardMonths),
        },
        by_board: boardSummaries,
      },
      payment_amount_distribution: {
        individual_payment: distribution(individualPaymentCents, { amount: true }),
        board_month_total: distribution(measuredGroups.map((group) => group.amount_cents), { amount: true }),
      },
      board_months: boardMonths,
      month_summaries: monthSummaries,
    },
    candidate_digest: {
      grouping: "one digest occasion per board per calendar month",
      cadence: "monthly",
      meaningful_activity_threshold: {
        rule: `at least ${threshold.payment_count} payments OR at least $${(threshold.monthly_amount_cents / 100).toFixed(2)} in the board/month bucket`,
        payment_count: threshold.payment_count,
        monthly_amount: dollars(threshold.monthly_amount_cents),
        basis: "rounded candidate threshold informed by board/month frequency and total-amount distributions; candidate only until a second source snapshot establishes refresh deltas",
      },
      qualifying_board_month_count: meaningfulGroups.length,
      qualifying_payment_count: meaningfulGroups.reduce((sum, group) => sum + group.payment_count, 0),
      qualifying_amount: round(meaningfulGroups.reduce((sum, group) => sum + group.posted_payment_amount, 0)),
      qualifying_share_of_active_board_months: ratio(meaningfulGroups.length, boardMonths.length),
      qualifying_share_of_retained_payments: ratio(meaningfulGroups.reduce((sum, group) => sum + group.payment_count, 0), allPayments),
      qualifying_share_of_retained_amount: ratio(meaningfulGroups.reduce((sum, group) => sum + group.posted_payment_amount, 0), dollars(allAmountCents)),
      raw_payment_alerts_per_active_board_month: ratio(allPayments, boardMonths.length),
      maximum_digest_occasions_per_board_month: 1,
      largest_new_payee: "exact payee aggregation within the board/month bucket; no descriptive or geographic assignment",
      example_shape: "CB15 posted N new payments totaling $X this month. Largest new payee: NAME ($Y).",
      raw_every_payment_alerts: "rejected",
    },
    noise_assessment: {
      classification: "raw_payment_alerts_too_noisy_for_resident_delivery",
      evidence: "A retained payment snapshot contains multiple payments per active board/month; a monthly board-level digest bounds delivery to at most one occasion per board/month.",
      conclusion: "Use a bounded digest candidate, never one alert per payment; do not promote the candidate until refresh deltas are available.",
    },
    existing_watch_action_seam: {
      status: "seam_exists_but_payment_replay_is_not_implemented",
      subscription_envelope: "worker/src/lib/subscriptions.mjs::buildSubscription",
      query_replay: "worker/src/lib/compile.mjs::compileSub + rowsForCompiledQuery",
      delivery_and_diff: "worker/src/alerts.mjs existing subscription digest and per-subscription diff",
      current_board_watch: "site/app/alerts.mjs communityboard watch currently maps to lens=meetings with an exact communityBoard filter",
      missing_piece: "The current money compiler replays City Record procurement notices; it does not read site/data/community_board_payment_actuals.json or maintain a payment snapshot watermark.",
      reuse_plan: "If a later retained snapshot pair earns the feature, carry an exact board identity and source watermark through the existing subscription envelope and render one monthly digest section; do not create a Community-Board-specific subscription stack.",
      procurement_lifecycle_changed: false,
    },
    decision: {
      follow_feature_shipped: false,
      stop_reason: "Stable cross-refresh payment deltas are unavailable from the single CB-MONEY-02 snapshot, so this card records measurement and a bounded candidate only.",
      next_evidence_required: "Retain a second CB-MONEY-02 snapshot with the same source boundary and compare immutable transaction_id sets before implementing replay.",
    },
  };
}

export function validateCommunityBoardMoneyFollowFeasibility(receipt) {
  const errors = [];
  if (receipt?.schema !== COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_SCHEMA) errors.push("schema mismatch");
  if (receipt?.version !== COMMUNITY_BOARD_MONEY_FOLLOW_FEASIBILITY_VERSION) errors.push("version mismatch");
  if (receipt?.workstream_card !== "CB-MONEY-07") errors.push("workstream card mismatch");
  if (receipt?.status !== "stop_without_shipping_follow_feature") errors.push("unexpected status");
  if (!receipt?.source?.source_vintage) errors.push("source vintage missing");
  if (!receipt?.stable_payment_deltas?.key) errors.push("stable delta key missing");
  if (receipt?.candidate_digest?.raw_every_payment_alerts !== "rejected") errors.push("raw alerts not rejected");
  if (receipt?.existing_watch_action_seam?.procurement_lifecycle_changed !== false) errors.push("procurement lifecycle change not guarded");
  if (receipt?.decision?.follow_feature_shipped !== false) errors.push("follow feature unexpectedly shipped");
  if (!Array.isArray(receipt?.measurement?.board_months)) errors.push("board/month measurement missing");
  if (!Array.isArray(receipt?.measurement?.month_summaries)) errors.push("month measurement missing");
  return { ok: errors.length === 0, errors };
}
