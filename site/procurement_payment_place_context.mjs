/**
 * Exact-contract payment evidence and notice-attributed place facts for
 * canonical procurement detail.
 *
 * Payments come from the materialized contract-lifecycle population (the same
 * D1 exact-contract rows the notice Follow-the-Dollars path reads). Place facts
 * join only through an accepted notice↔contract relation. An analytics spending
 * miss in another population is not treated as the absence of these payments.
 */

import { lifecyclePaymentRowsHTML } from "./payment_rows_ui.mjs";

export const PROCUREMENT_CONTRACT_LIFECYCLE_MATERIALIZATION_SCHEMA =
  "cityscroll.procurement_contract_lifecycle_materialization.v1";
export const PROCUREMENT_PLACE_FACTS_MATERIALIZATION_SCHEMA =
  "cityscroll.procurement_place_facts_materialization.v1";

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(number);
}

function lifecycleMaterializationAccepted(materialization) {
  return Boolean(
    materialization
    && materialization.schema === PROCUREMENT_CONTRACT_LIFECYCLE_MATERIALIZATION_SCHEMA
    && materialization.policy?.exact_contract_payment_population === true
    && materialization.policy?.analytics_spending_miss_is_not_lifecycle_absence === true
    && Array.isArray(materialization.rows),
  );
}

function placeMaterializationAccepted(materialization) {
  return Boolean(
    materialization
    && materialization.schema === PROCUREMENT_PLACE_FACTS_MATERIALIZATION_SCHEMA
    && materialization.policy?.join_only_through_accepted_notice_contract_relation === true
    && Array.isArray(materialization.rows),
  );
}

function contractIdsFromObject(object = {}) {
  const ids = new Set(
    (Array.isArray(object?.identity_keys?.contract_ids) ? object.identity_keys.contract_ids : [])
      .map((value) => text(value)?.toUpperCase())
      .filter(Boolean),
  );
  const procurementId = text(object?.procurement_id);
  const match = procurementId?.match(/^procurement:contract:(.+)$/i);
  if (match?.[1]) ids.add(match[1].toUpperCase());
  return ids;
}

function objectObservationRefs(object = {}) {
  return new Set(
    (Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : [])
      .map((value) => text(value))
      .filter(Boolean),
  );
}

function observationsForObject(object = {}, observations = []) {
  const refs = objectObservationRefs(object);
  if (!refs.size) return [];
  return (Array.isArray(observations) ? observations : []).filter((observation) => (
    refs.has(text(observation?.source_observation_ref))
  ));
}

function noticeRequestIdsFromObject(object = {}, observations = []) {
  const ids = new Set();
  for (const href of object?.compatibility?.city_record_notice_hrefs || []) {
    const match = String(href).match(/\/notices\/([^/?#]+)/);
    if (match?.[1]) {
      try { ids.add(decodeURIComponent(match[1])); } catch { ids.add(match[1]); }
    }
  }
  for (const ref of objectObservationRefs(object)) {
    const match = String(ref).match(/^city_record:(.+)$/);
    if (match?.[1]) ids.add(match[1]);
  }
  // Only observations that belong to this object may contribute notice ids.
  // Shard payloads carry many contracts' observations in one array.
  for (const observation of observationsForObject(object, observations)) {
    const system = String(observation?.source_system || "").toLowerCase();
    if (!["city_record", "city_record_procurement", "crol"].includes(system)) continue;
    const snapshot = observation?.snapshot && typeof observation.snapshot === "object"
      ? observation.snapshot
      : {};
    const requestId = text(snapshot.request_id || observation.source_system_id);
    if (requestId) ids.add(requestId);
  }
  return ids;
}

function timelineStage(lifecycle, stage) {
  return (Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [])
    .find((entry) => entry?.stage === stage) || null;
}

function lifecycleContractId(lifecycle) {
  const registered = timelineStage(lifecycle, "registered");
  const payment = timelineStage(lifecycle, "payment");
  return text(
    registered?.detail?.contract_id
    || payment?.detail?.contract_id
    || lifecycle?.subject_refs?.contract?.replace(/^contract:/i, "")
    || lifecycle?.checkbook_acquisition?.contract_id,
  )?.toUpperCase() || null;
}

function lifecycleNoticeId(lifecycle) {
  const award = timelineStage(lifecycle, "award");
  return text(
    award?.detail?.request_id
    || lifecycle?.id
    || lifecycle?.subject_refs?.notice?.replace(/^notice:/i, ""),
  );
}

/** True when the lifecycle carries matched exact-contract payment evidence. */
export function hasExactContractPaymentEvidence(lifecycle) {
  const payment = timelineStage(lifecycle, "payment");
  if (!payment || payment.status !== "matched") return false;
  const detail = payment.detail || {};
  return Number(detail.total_payments) > 0
    || (Number.isFinite(Number(detail.total_spent)) && Number(detail.total_spent) > 0)
    || (Array.isArray(detail.payment_rows) && detail.payment_rows.length > 0);
}

/**
 * Resolve the exact-contract lifecycle for one City Record notice id.
 * Used by the notice route so its payment summary shares the same
 * materialization the canonical procurement route reads.
 */
export function contractLifecycleForNotice(
  requestId,
  materialization = null,
) {
  const id = text(requestId);
  if (!id || !lifecycleMaterializationAccepted(materialization)) return null;
  const rows = materialization.rows.filter((row) => row && typeof row === "object");
  return rows.find((row) => lifecycleNoticeId(row) === id) || null;
}

/**
 * Resolve the exact-contract lifecycle for one procurement object.
 * Prefers an already-attached object.lifecycle, then the materialization row
 * keyed by exact contract id. Notice-id fallback only applies when the notice
 * is already an accepted relation on this object.
 */
export function contractLifecycleForProcurement(
  object = {},
  observations = [],
  materialization = null,
) {
  if (object?.lifecycle && typeof object.lifecycle === "object") {
    const attachedId = lifecycleContractId(object.lifecycle);
    const contractIds = contractIdsFromObject(object);
    if (!attachedId || contractIds.has(attachedId)) return object.lifecycle;
  }
  if (!lifecycleMaterializationAccepted(materialization)) return null;
  const contractIds = contractIdsFromObject(object);
  const noticeIds = noticeRequestIdsFromObject(object, observations);
  const rows = materialization.rows.filter((row) => row && typeof row === "object");
  const byContract = rows.find((row) => {
    const id = lifecycleContractId(row);
    return id && contractIds.has(id);
  });
  if (byContract) return byContract;
  if (!contractIds.size) return null;
  return rows.find((row) => {
    const noticeId = lifecycleNoticeId(row);
    const rowContractId = lifecycleContractId(row);
    return noticeId
      && noticeIds.has(noticeId)
      && rowContractId
      && contractIds.has(rowContractId);
  }) || null;
}

/**
 * Extract a facility address and unit count from City Record notice prose.
 * Returns null when the publisher text does not carry both facts.
 */
export function extractNoticeFacilityPlace(rawText) {
  const cleaned = String(rawText ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const match = cleaned.match(
    /Located at\s+(.+?),\s*(Bronx|Brooklyn|Manhattan|Queens|Staten Island)(?:,\s*NY(?:\s+\d{5}(?:-\d{4})?)?)?\s*;\s*(\d+)\s*units?\b/i,
  );
  if (!match) return null;
  const street = text(match[1]);
  const borough = text(match[2]);
  const units = Number(match[3]);
  if (!street || !borough || !Number.isFinite(units)) return null;
  return {
    address: `${street}, ${borough}`,
    units,
  };
}

function acceptedNoticeRelation(object, observations, requestId) {
  const id = text(requestId);
  if (!id) return false;
  return noticeRequestIdsFromObject(object, observations).has(id);
}

/**
 * Place facts for one procurement, only through an accepted notice relation.
 */
export function placeFactsForProcurement(
  object = {},
  observations = [],
  materialization = null,
) {
  const facts = [];
  if (placeMaterializationAccepted(materialization)) {
    for (const row of materialization.rows) {
      const requestId = text(row?.request_id);
      if (!acceptedNoticeRelation(object, observations, requestId)) continue;
      const address = text(row.address);
      const units = Number(row.units);
      if (!address || !Number.isFinite(units)) continue;
      facts.push(Object.freeze({
        address,
        units,
        request_id: requestId,
        source_system: text(row.source_system) || "city_record",
        evidence_role: text(row.evidence_role) || "facility_service_site",
        attribution_label: text(row.attribution_label) || `Notice ${requestId}`,
        notice_href: text(row.notice_href) || `/notices/${encodeURIComponent(requestId)}`,
        official_href: text(row.official_href)
          || `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`,
        source_observation_ref: text(row.source_observation_ref) || `city_record:${requestId}`,
        join_basis: "accepted_notice_contract_relation",
      }));
    }
  }

  if (!facts.length) {
    for (const observation of observationsForObject(object, observations)) {
      const system = String(observation?.source_system || "").toLowerCase();
      if (!["city_record", "city_record_procurement", "crol"].includes(system)) continue;
      const snapshot = observation?.snapshot && typeof observation.snapshot === "object"
        ? observation.snapshot
        : {};
      const requestId = text(snapshot.request_id || observation.source_system_id);
      if (!acceptedNoticeRelation(object, observations, requestId)) continue;
      const extracted = extractNoticeFacilityPlace(
        snapshot.additional_description_1
        || snapshot.additional_description_2
        || snapshot.additional_description_3
        || "",
      );
      if (!extracted) continue;
      facts.push(Object.freeze({
        address: extracted.address,
        units: extracted.units,
        request_id: requestId,
        source_system: "city_record",
        evidence_role: "facility_service_site",
        attribution_label: `Notice ${requestId}`,
        notice_href: `/notices/${encodeURIComponent(requestId)}`,
        official_href: `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`,
        source_observation_ref: text(observation.source_observation_ref) || `city_record:${requestId}`,
        join_basis: "accepted_notice_contract_relation",
      }));
    }
  }

  return Object.freeze(facts);
}

/** Compact payment evidence view from one lifecycle payload. */
export function paymentEvidenceFromLifecycle(lifecycle) {
  if (!hasExactContractPaymentEvidence(lifecycle)) return null;
  const payment = timelineStage(lifecycle, "payment");
  const registered = timelineStage(lifecycle, "registered");
  const detail = payment?.detail || {};
  const acquisition = lifecycle?.checkbook_acquisition || null;
  const rows = Array.isArray(detail.payment_rows) ? detail.payment_rows : [];
  return Object.freeze({
    contract_id: lifecycleContractId(lifecycle),
    notice_id: lifecycleNoticeId(lifecycle),
    total_payments: Number(detail.total_payments) || rows.length,
    total_spent: Number.isFinite(Number(detail.total_spent)) ? Number(detail.total_spent) : null,
    latest_payment_date: text(detail.latest_payment_date || payment?.date),
    latest_payment_amount: Number.isFinite(Number(detail.latest_payment_amount))
      ? Number(detail.latest_payment_amount)
      : null,
    payment_rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    payment_rows_shown: Number(detail.payment_rows_shown) || rows.length,
    payment_rows_capped: detail.payment_rows_capped === true,
    payment_state: text(detail.payment_state) || "paid",
    original_amount: Number.isFinite(Number(registered?.detail?.original_amount))
      ? Number(registered.detail.original_amount)
      : null,
    current_amount: Number.isFinite(Number(registered?.detail?.current_amount))
      ? Number(registered.detail.current_amount)
      : null,
    start_date: text(registered?.detail?.start_date),
    end_date: text(registered?.detail?.end_date),
    registration_date: text(registered?.detail?.registration_date || registered?.date),
    acquisition_observed_at: text(acquisition?.observed_at),
    payment_as_of: text(acquisition?.payment_as_of || detail.latest_payment_date || payment?.date),
    payment_population: text(acquisition?.payment_population) || "exact contract_id spending rows",
    checkbook_search_href: lifecycleContractId(lifecycle)
      ? `https://www.checkbooknyc.com/smart_search/citywide?search_term=${encodeURIComponent(lifecycleContractId(lifecycle))}`
      : null,
  });
}

function formatDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return text(value);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function renderProcurementPlaceFactsHtml(placeFacts = []) {
  const rows = Array.isArray(placeFacts) ? placeFacts.filter(Boolean) : [];
  if (!rows.length) return "";
  const items = rows.map((fact) => {
    const attribution = fact.notice_href
      ? `<a href="${esc(fact.notice_href)}">${esc(fact.attribution_label || `Notice ${fact.request_id}`)}</a>`
      : esc(fact.attribution_label || `Notice ${fact.request_id}`);
    const official = fact.official_href
      ? ` · <a href="${esc(fact.official_href)}" rel="noopener noreferrer">Official source</a>`
      : "";
    return `<li data-place-request-id="${esc(fact.request_id)}" data-place-role="${esc(fact.evidence_role)}"><strong>${esc(fact.address)}</strong> · ${esc(String(fact.units))} units<span class="procurement-place-attribution"> · Source ${attribution}${official}</span></li>`;
  }).join("");
  return `<section class="node-section node-card procurement-place-facts" data-procurement-place-facts="1" aria-labelledby="procurement-place-heading"><h2 id="procurement-place-heading">Facility</h2><ul class="procurement-place-list">${items}</ul></section>`;
}

function alternatePaidObservationRows(alternatePaidObservations = []) {
  return (Array.isArray(alternatePaidObservations) ? alternatePaidObservations : [])
    .filter((entry) => entry && finiteAmount(entry.value) != null)
    .map((entry) => {
      const amount = money(entry.value);
      const source = text(entry.source_system) || "retained source";
      const vintage = text(entry.observation_vintage);
      const vintageBit = vintage ? ` · source vintage ${esc(vintage)}` : "";
      return `<div><dt>Retained ${esc(source)} paid amount</dt><dd data-retained-paid-amount="${esc(String(entry.value))}" data-retained-paid-source="${esc(source)}"${vintage ? ` data-retained-paid-vintage="${esc(vintage)}"` : ""}${entry.source_observation_ref ? ` data-retained-paid-ref="${esc(entry.source_observation_ref)}"` : ""}>${esc(amount)}${vintageBit}</dd></div>`;
    })
    .join("");
}

export function renderProcurementPaymentEvidenceHtml(evidence, {
  alternatePaidObservations = [],
} = {}) {
  if (!evidence) return "";
  // Explicit finite check so an honest zero still renders; do not use truthiness.
  const spentNumber = finiteAmount(evidence.total_spent);
  const spent = spentNumber == null ? null : money(spentNumber);
  const latestAmount = money(evidence.latest_payment_amount);
  const latestDate = formatDay(evidence.latest_payment_date);
  const summaryBits = [
    Number.isFinite(evidence.total_payments)
      ? `<div><dt>Payments on this contract</dt><dd data-payment-total-count="${esc(String(evidence.total_payments))}">${esc(String(evidence.total_payments))}</dd></div>`
      : "",
    spent != null
      ? `<div><dt>Amount paid</dt><dd data-payment-total-spent="${esc(String(spentNumber))}">${esc(spent)}</dd></div>`
      : "",
    latestDate && latestAmount
      ? `<div><dt>Latest payment</dt><dd data-latest-payment-date="${esc(latestDate)}" data-latest-payment-amount="${esc(String(evidence.latest_payment_amount))}">${esc(latestDate)} for ${esc(latestAmount)}</dd></div>`
      : "",
  ].filter(Boolean).join("");
  const retainedRows = alternatePaidObservationRows(alternatePaidObservations);
  const sourceDetails = [
    evidence.payment_population
      ? `<div><dt>Payment population</dt><dd>${esc(evidence.payment_population)}</dd></div>`
      : "",
    evidence.acquisition_observed_at
      ? `<div><dt>Source acquisition</dt><dd data-payment-acquisition-at="${esc(evidence.acquisition_observed_at)}">${esc(evidence.acquisition_observed_at)}</dd></div>`
      : "",
    evidence.payment_as_of
      ? `<div><dt>Payment vintage</dt><dd data-payment-as-of="${esc(evidence.payment_as_of)}">${esc(evidence.payment_as_of)}</dd></div>`
      : "",
    evidence.checkbook_search_href
      ? `<div><dt>Payment source</dt><dd><a href="${esc(evidence.checkbook_search_href)}" rel="noopener noreferrer">Open Checkbook for this contract</a></dd></div>`
      : "",
    retainedRows,
  ].filter(Boolean).join("");
  const rowsHtml = lifecyclePaymentRowsHTML({
    payment_rows: evidence.payment_rows,
    payment_rows_capped: evidence.payment_rows_capped,
    payment_rows_shown: evidence.payment_rows_shown,
    total_payments: evidence.total_payments,
  }, { money, fdate: formatDay, clean: text });
  const ceilingNote = `<p class="note procurement-payment-ceiling-note">The contract's authorized amount is a commitment ceiling, not an amount still owed. Authorized minus paid is not remaining liability.</p>`;
  return `<section class="node-section node-card procurement-payment-evidence" data-procurement-payment-evidence="1" data-payment-rows-capped="${evidence.payment_rows_capped ? "true" : "false"}" aria-labelledby="procurement-payment-heading"><h2 id="procurement-payment-heading">Contract payments</h2>${summaryBits ? `<dl class="node-facts">${summaryBits}</dl>` : ""}${ceilingNote}${rowsHtml}${sourceDetails ? `<details class="procurement-payment-source-details"><summary>Payment source details</summary><dl class="node-facts">${sourceDetails}</dl></details>` : ""}</section>`;
}

/**
 * Drop analytics-spending "no match" paid-amount caveats when exact-contract
 * lifecycle payments are already shown for the same contract.
 */
export function filterPaymentCoverageCaveats(claimCaveats = [], evidence = null) {
  if (!evidence || !Array.isArray(claimCaveats) || !claimCaveats.length) {
    return Array.isArray(claimCaveats) ? claimCaveats : [];
  }
  return claimCaveats.filter((caveat) => !(
    caveat?.claim === "paid_amount"
    && caveat?.state === "checked-no-match"
    && String(caveat?.source_system || "").includes("checkbook_spending")
  ));
}

function finiteAmount(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function observationVintage(entry = {}) {
  return text(
    entry.observation_vintage
    || entry.source_vintage
    || entry.ingested_at
    || entry.observed_at
    || entry.acquired_at
    || null,
  );
}

function paidScopeKey(entry = {}) {
  return text(entry.source_system) || "unknown";
}

/**
 * Among retained paid observations in one comparable scope, prefer the newer
 * dated observation. Absent or incomparable dates keep source-priority order
 * already present in `entries` — never max-value selection or invented dates.
 */
function chooseRetainedPaid(entries = []) {
  const paid = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.kind === "paid_amount" && finiteAmount(entry.value) != null);
  if (!paid.length) return null;

  const byScope = new Map();
  for (const entry of paid) {
    const key = paidScopeKey(entry);
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(entry);
  }

  // Prefer the first scope in entry order (source-priority sorted upstream).
  // Within a scope, a strictly newer vintage wins when both sides are dated.
  const firstScope = paidScopeKey(paid[0]);
  const scoped = byScope.get(firstScope) || [paid[0]];
  let chosen = scoped[0];
  for (const candidate of scoped.slice(1)) {
    const left = observationVintage(chosen);
    const right = observationVintage(candidate);
    if (left && right && right > left) chosen = candidate;
  }
  return chosen;
}

/**
 * Resolve one scoped cumulative paid summary shared by the headline fact cell
 * and the payment section. Exact-contract lifecycle evidence wins when present
 * (including an explicit zero). Retained publisher paid observations stay as
 * attributable alternates with their original vintages. Encumbered is never
 * replaced by paid.
 */
export function resolveScopedPaymentSummary({
  paidEntries = [],
  paymentEvidence = null,
  encumberedAmount = null,
} = {}) {
  const retained = (Array.isArray(paidEntries) ? paidEntries : [])
    .filter((entry) => entry && entry.kind === "paid_amount" && finiteAmount(entry.value) != null)
    .map((entry) => Object.freeze({
      value: finiteAmount(entry.value),
      source_system: text(entry.source_system),
      source_observation_ref: text(entry.source_observation_ref),
      source_field: text(entry.source_field),
      observation_vintage: observationVintage(entry),
    }));

  const lifecycleSpent = paymentEvidence ? finiteAmount(paymentEvidence.total_spent) : null;
  const hasLifecyclePaid = paymentEvidence != null && lifecycleSpent != null;

  let paidAmount = null;
  let primary = null;
  if (hasLifecyclePaid) {
    paidAmount = lifecycleSpent;
    primary = Object.freeze({
      scope: "exact_contract_lifecycle",
      value: lifecycleSpent,
      population: text(paymentEvidence.payment_population) || "exact contract_id spending rows",
      acquisition_observed_at: text(paymentEvidence.acquisition_observed_at),
      payment_as_of: text(paymentEvidence.payment_as_of),
      total_payments: Number.isFinite(Number(paymentEvidence.total_payments))
        ? Number(paymentEvidence.total_payments)
        : null,
    });
  } else {
    const chosen = chooseRetainedPaid(paidEntries);
    if (chosen) {
      paidAmount = finiteAmount(chosen.value);
      primary = Object.freeze({
        scope: "retained_source_observation",
        value: paidAmount,
        source_system: text(chosen.source_system),
        source_observation_ref: text(chosen.source_observation_ref),
        source_field: text(chosen.source_field),
        observation_vintage: observationVintage(chosen),
      });
    }
  }

  const alternatePaidObservations = Object.freeze(
    retained.filter((entry) => {
      if (paidAmount == null) return true;
      if (hasLifecyclePaid) return true;
      if (entry.value !== paidAmount) return true;
      if (primary?.source_observation_ref && entry.source_observation_ref !== primary.source_observation_ref) {
        return true;
      }
      return false;
    }),
  );

  return Object.freeze({
    paidAmount,
    encumberedAmount: finiteAmount(encumberedAmount),
    primary,
    alternatePaidObservations,
    paymentEvidence: paymentEvidence || null,
  });
}

/**
 * When exact-contract lifecycle payments are shown, keep an analytics spending
 * lookup miss as a miss — never rewrite it as a match — but scope and date the
 * source row so it cannot be read as "no payments on this contract".
 */
export function reconcilePaymentCoverageProjection(coverageReader = null, paymentEvidence = null) {
  if (!coverageReader) return null;
  const claimCaveats = Object.freeze(filterPaymentCoverageCaveats(
    coverageReader.claim_caveats,
    paymentEvidence,
  ));
  const hasLifecyclePayments = Boolean(
    paymentEvidence
    && (
      (Number.isFinite(Number(paymentEvidence.total_payments)) && Number(paymentEvidence.total_payments) > 0)
      || finiteAmount(paymentEvidence.total_spent) != null
      || (Array.isArray(paymentEvidence.payment_rows) && paymentEvidence.payment_rows.length > 0)
    ),
  );
  const sources = Object.freeze((Array.isArray(coverageReader.sources) ? coverageReader.sources : []).map((source) => {
    if (!hasLifecyclePayments) return source;
    if (source?.source_system !== "checkbook_spending") return source;
    if (source?.state !== "checked-no-match") return source;
    const dated = text(source.observation_context);
    const scopedLabel = "No exact match in analytics spending lookup";
    const scopedContext = dated
      ? `${dated} · separate analytics population, not exact-contract payments`
      : "Separate analytics population, not exact-contract payments";
    return Object.freeze({
      ...source,
      state_label: scopedLabel,
      observation_context: scopedContext,
      payment_population_scope: "analytics_spending_lookup",
    });
  }));
  return Object.freeze({
    ...coverageReader,
    sources,
    claim_caveats: claimCaveats,
  });
}
