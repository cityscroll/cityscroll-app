import {
  gateNodePageRender,
  renderCalendarEventPreviewScript,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import {
  buildContractReportTarget,
  buildContractVendorRelationshipReportTarget,
  reportIssueAction,
} from "./report_issue.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { procurementCanonicalHref } from "./procurement_object_contract.mjs";
import { renderProcurementObjectCoverageHtml } from "./procurement_coverage_labels.mjs";
import { snapshotsForPublicAmount } from "./checkbook_passport_corroboration.mjs";
import { renderCrossSourceEvidenceReceipt } from "./cross_source_evidence_receipt.mjs";
import {
  buildCrossSourceCoverageLedger,
  projectCoverageForReaders,
  renderCoverageClaimCaveats,
  renderCoverageReaderProjection,
} from "./cross_source_coverage_ledger.mjs";
import { renderProcurementProcessEvents } from "./procurement_process_events.mjs";
import { resolveNycEdcDevelopmentRoles } from "./civic_institution_development_roles.mjs";
import {
  INSTITUTION_RECORD_CAPACITIES,
  institutionDisplayName,
} from "./civic_institution_record_capacity.mjs";
import {
  opportunityMonthHTML,
  procurementOpportunityOccurrences,
} from "./opportunity_calendar.mjs";
import {
  opportunityWindowDisplayLine,
  procurementOpportunityWindow,
} from "./procurement_opportunity_window.mjs";
import { extractSolicitationProcurementMethod } from "./solicitation_procurement_method.mjs";
import { buildSolicitationMwbeView } from "./mwbe_goal_surface.mjs";
import { buildPursuitSnapshot, renderPursuitSnapshotHtml } from "./procurement_pursuit_snapshot.mjs";
import { buyerHistoryComparisonFromSolicitation } from "./buyer_history_pursuit_comparison.mjs";
import { buildRelatedProcurementContext, renderRelatedProcurementContextHtml } from "./procurement_related_context.mjs";
import {
  buildProjectContextView,
  projectContextInspectSummary,
  renderProjectContextHtml,
} from "./procurement_project_context.mjs";
import { buildProcurementHandoffCopy, renderProcurementHandoffCopyHtml } from "./procurement_handoff_copy.mjs";
import { projectProcurementFacts } from "./procurement_fact_projection.mjs";
import { entityChipHTML, entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { procurementSourceLinkItems } from "./procurement_source_links.mjs";
import { buildSiteLifecycleContext, renderSiteLifecycleContext } from "./site_lifecycle_context.mjs";
import siteLifecycleShard from "./data/site_lifecycle/0000.json" with { type: "json" };
import siteLifecycleReverse from "./data/site_lifecycle/reverse.json" with { type: "json" };
import {
  contractLifecycleForProcurement,
  filterPaymentCoverageCaveats,
  paymentEvidenceFromLifecycle,
  placeFactsForProcurement,
  renderProcurementPaymentEvidenceHtml,
  renderProcurementPlaceFactsHtml,
} from "./procurement_payment_place_context.mjs";
import procurementContractLifecycleMaterialization from "./data/procurement_contract_lifecycle.json" with { type: "json" };
import procurementPlaceFactsMaterialization from "./data/procurement_place_facts.json" with { type: "json" };


function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const DEFAULT_SITE_LIFECYCLE = {
  schema: "cityscroll.site_lifecycle.v1",
  parcels: Object.fromEntries((siteLifecycleShard.rows || []).map((row) => [row.parcel_id, row])),
  members: siteLifecycleReverse.members || {},
};

function formatAmount(value) {
  const raw = clean(value);
  if (!raw) return null;
  const number = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(number) ? `$${number.toLocaleString("en-US")}` : raw;
}

function factsFor(object, observations) {
  const byRef = new Map((Array.isArray(observations) ? observations : [])
    .filter(Boolean).map((entry) => [entry?.source_observation_ref, entry]));
  const observed = (object?.source_observation_refs || [])
    .map((ref) => byRef.get(ref)).filter(Boolean);
  const projection = projectProcurementFacts(object, observed);
  const projected = projection.facts;
  const officialUrl = observed.map((entry) => entry?.snapshot || {})
    .map((row) => clean(row.official_url || row.official_source_url || row.source_url))
    .find(Boolean) || null;
  return {
    ...projected,
    amount: formatAmount(projected.amount),
    originalAmount: formatAmount(projected.originalAmount),
    currentAmount: formatAmount(projected.currentAmount),
    actionAmount: formatAmount(projected.actionAmount),
    paidAmount: formatAmount(projected.paidAmount),
    encumberedAmount: formatAmount(projected.encumberedAmount),
    baseAmount: formatAmount(projected.baseAmount),
    officialUrl,
    entries: projection.entries,
  };
}

/** Return an exact internal search continuation for a retained identifier. */
export function procurementIdentifierSearchHref(value) {
  const raw = String(value ?? "");
  if (!raw.trim() || /[<>\u0000-\u001f\u007f]/.test(raw)) return null;
  const identifier = clean(raw, 320);
  return identifier ? `/search/?q=${encodeURIComponent(identifier)}` : null;
}

function factEntry(facts, kind) {
  return (facts.entries || []).find((entry) => entry.kind === kind) || null;
}

function procurementFactValue(facts, kind, value, object) {
  const label = String(value ?? "");
  if (!label) return "";
  const entry = factEntry(facts, kind);
  if (kind === "agency" || kind === "vendor") {
    const ref = entityRouteRef(kind, label);
    if (!ref) return esc(label);
    const href = entityHref({ ref, label });
    if (!href) return esc(label);
    return entityChipHTML({
      ref,
      label,
      link_confidence: "strong",
      relation: kind === "agency" ? "contracting agency" : "contractor",
    }, {
      source: {
        kind: "procurement",
        id: object?.procurement_id || "",
        name: "Procurement",
      },
    });
  }
  const identifierKinds = new Set([
    "canonical_contract_id", "pin_epin", "contract_reporter_number", "solicitation_id", "event_id",
  ]);
  if (identifierKinds.has(kind)) {
    const href = procurementIdentifierSearchHref(label);
    return href ? `<a class="ui-constellation-link procurement-identifier-link" href="${esc(href)}" data-search-key="${esc(label)}">${esc(label)}</a>` : esc(label);
  }
  if (["notice_publication_date", "registration_date", "award_date"].includes(kind) && entry?.date_basis) {
    return `${esc(entry.value || label)} <span class="procurement-date-basis" data-date-basis="${esc(entry.date_basis)}">(basis: ${esc(entry.date_basis)})</span>`;
  }
  return esc(entry?.value || label);
}

export function procurementContractWatchHref(procurementId) {
  const id = clean(procurementId, 320);
  if (!id.startsWith("procurement:")) return null;
  return followingUrlFromWatch({
    lens: "money",
    filter: { procurement_id: id, noticeType: "award" },
    freq: "daily",
  }, { base: "/following" });
}

export function procurementVendorFollowHref(vendor) {
  const name = clean(vendor, 120);
  if (!name) return null;
  return followingUrlFromWatch({
    lens: "entity",
    filter: { kind: "vendor", name },
    freq: "daily",
  }, { base: "/following" });
}

function procurementActions(object, facts) {
  const watchHref = procurementContractWatchHref(object?.procurement_id);
  const vendorHref = procurementVendorFollowHref(facts.vendor);
  const items = [];
  if (watchHref) {
    items.push({
      kind: "link",
      label: "Watch this contract",
      href: watchHref,
      primary: true,
      className: "civic-object-action",
      attrs: { "data-procurement-watch": object.procurement_id },
    });
  }
  if (vendorHref) {
    items.push({
      kind: "link",
      label: "Follow this vendor",
      href: vendorHref,
      className: "civic-object-action",
      attrs: { "data-follow": "vendor", "data-name": facts.vendor },
    });
  }
  const reportTarget = buildContractVendorRelationshipReportTarget(object, facts)
    || buildContractReportTarget(object, facts);
  items.push(reportIssueAction(reportTarget));
  return items.length ? renderNodeActions(items, { ariaLabel: "Document actions", extraClass: "civic-object-actions" }) : "";
}

function stageList(object) {
  const stages = Array.isArray(object?.stages) ? object.stages : [];
  return stages.length
    ? `<ol class="node-fact-list">${stages.map((entry) => `<li><strong>${esc(clean(entry.stage).replaceAll("_", " "))}</strong></li>`).join("")}</ol>`
    : "";
}

function observationRows(object, observations) {
  const index = new Map((Array.isArray(observations) ? observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
  return (object?.source_observation_refs || []).map((ref) => index.get(ref)).filter(Boolean);
}

/**
 * Card "PPD-07" (procurement-pursuit-decision): the latest moment this
 * product observed the matter, read from the record's own observations. This
 * is deliberately not a clock reading -- the handoff copy beneath the official
 * records tells a vendor when the matter was last seen, and a clock would tell
 * them a stale record is fresh.
 */
function lastObservedAtFor(object, observations) {
  let latest = "";
  for (const row of observationRows(object, observations)) {
    for (const value of [row?.ingested_at, row?.snapshot?.retrieval_timestamp, row?.snapshot?.retrieved_at]) {
      const stamp = clean(value, 40);
      if (stamp && stamp > latest) latest = stamp;
    }
  }
  return latest || null;
}

function nativeOfficialSources(rows) {
  return rows
    .filter((entry) => ["nys_contract_reporter", "mta_current_opportunities", "mta_bid_results"].includes(entry.source_system))
    .map((entry) => ({
      href: clean(entry.snapshot?.official_url || entry.snapshot?.source_url, 500),
      label: entry.source_system === "nys_contract_reporter" ? "NYS Contract Reporter" : "MTA official record",
    }))
    .filter((item) => item.href);
}

function mtaOfficialSource(entry) {
  const row = entry?.snapshot || {};
  const system = String(entry?.source_system || "").toLowerCase();
  if (system === "mta_cd_awards") {
    return {
      href: clean(row.official_source_url, 500) || "https://www.mta.info/agency/construction-and-development/contracting/recent-awards",
      label: "MTA Construction & Development recent awards",
    };
  }
  if (system === "mta_annual_contracts") {
    return {
      href: clean(row.official_source_url, 500) || "https://data.ny.gov/Transportation/MTA-Procurements-Beginning-2018/twsw-2mqa",
      label: "MTA Procurements · NY Open Data",
    };
  }
  return null;
}

/**
 * Resident official-source links for a procurement object.
 * PASSPort Public has no per-contract page; the contracts browse portal is
 * the public source. Checkbook search is labeled as search unless a
 * contract-detail agid is present.
 */
export function procurementOfficialSourceItems(object = {}, observations = [], { lookupReceipt = null } = {}) {
  const rows = observationRows(object, observations);
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const href = clean(item?.href, 500);
    const label = clean(item?.label, 80);
    if (!href || !label) return;
    const key = `${href}\0${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ href, label });
  };

  for (const href of object?.compatibility?.city_record_notice_hrefs || []) {
    add({ href, label: "City Record notice" });
  }
  for (const descriptor of procurementSourceLinkItems(object, observations, { lookupReceipt })) {
    if (descriptor.source_system === "city_record") continue;
    const label = descriptor.search_href
      ? "Search Checkbook NYC"
      : descriptor.source_system === "passport_public_contracts"
        ? "PASSPort Public contracts"
        : descriptor.official_label || "Open official record";
    add({ href: descriptor.official_href || descriptor.search_href, label });
  }
  for (const item of nativeOfficialSources(rows)) add(item);
  for (const row of rows) {
    const source = mtaOfficialSource(row);
    if (source) add(source);
  }
  return items;
}

/**
 * Who the institutions on this contract are, and in what capacity.
 *
 * The reader is on one record. What they need is which body received this
 * contract and which body awarded it, said plainly and linked — not two
 * canonical identifiers and a relation name. The capacities come from the same
 * accepted role edges the institution profiles use, so the record page and the
 * profile can never describe the same contract differently.
 */
export function renderProcurementInstitutionRoles(object = {}, observations = []) {
  const resolved = resolveNycEdcDevelopmentRoles({
    procurement: object,
    procurementObservations: observations,
  });
  const contractor = resolved.accepted.find((edge) => edge.relation_id === "contractor_on");
  const contracted = resolved.accepted.find((edge) => edge.relation_id === "contracted_by");
  if (!contractor && !contracted) return "";
  const party = (edge, capacityId, canonicalId) => {
    if (!edge || !canonicalId) return "";
    const capacity = Object.values(INSTITUTION_RECORD_CAPACITIES)
      .find((entry) => entry.capacity_id === capacityId);
    const name = institutionDisplayName(canonicalId);
    const evidence = [
      edge.provenance?.source_field && edge.provenance?.source_value
        ? `${edge.provenance.source_field}: “${edge.provenance.source_value}”`
        : "",
      edge.provenance?.source_system ? `Source ${edge.provenance.source_system}` : "",
    ].filter(Boolean).join(" · ");
    return `<li class="node-record procurement-institution-role"
      data-role-relation="${esc(edge.relation_id)}"
      data-record-capacity="${esc(capacityId)}"
      data-institution="${esc(canonicalId)}"
      data-role-linking="1">
      <div class="node-record-main"><span class="agency-record-capacity-badge">${esc(capacity?.label || capacityId)}</span> <a class="ui-constellation-link" href="/agencies/${esc(canonicalId)}/">${esc(name)}</a></div>
      <p class="node-muted">${esc(capacity ? capacity.sentence(name) : "")}</p>
      ${evidence ? `<span class="muted node-muted">${esc(evidence)}</span>` : ""}
    </li>`;
  };
  const rows = [
    party(contractor, "contractor", contractor?.subject_canonical_id),
    party(contracted, "contracting_agency", contracted?.subject_canonical_id),
  ].filter(Boolean).join("");
  if (!rows) return "";
  return renderNodeSection({
    heading: "Institution roles",
    headingId: "procurement-institution-roles-heading",
    extraClass: "procurement-institution-roles",
    attrs: { id: "procurement-institution-roles" },
    body: `<p class="node-muted">These two institutions are different bodies in different capacities on this one contract. Receiving this contract is not authority to award one.</p>
      <ul class="node-record-list">${rows}</ul>`,
  });
}

// Card 2: the same derivation browse and alerts consume, paired for display
// with the existing rule-derived response floor. A procurement that never
// carried a PASSPort RFx or City Record observation at all (an award, a
// contract-history-only object) gets no section — not even an "unavailable"
// line — matching the existing rule that non-solicitation objects never pick
// up solicitation-shaped affordances. A solicitation that did carry one of
// those observations but couldn't form a complete boundary still surfaces
// explicitly as "Window unavailable" rather than silently vanishing, per the
// workstream's not-observed-must-never-read-as-no principle; per rule 3, that
// state never gets a floor comparison.
function opportunityWindowSectionBody(object, observations, window) {
  if (!window.available && window.reason === "no_qualifying_observation") return "";
  if (!window.available) return `<p class="opportunity-window-line">${esc(window.label)}</p>`;
  const cityRecordRow = observationRows(object, observations)
    .find((entry) => entry.source_system === "city_record")?.snapshot || null;
  const method = cityRecordRow ? extractSolicitationProcurementMethod(cityRecordRow) : null;
  const line = opportunityWindowDisplayLine(window, method?.response_floor || null);
  const cite = method?.response_floor?.rule_cite
    ? `<p class="opportunity-window-rule-cite">Rule floor source: ${esc(method.response_floor.rule_cite)}</p>`
    : "";
  return `<p class="opportunity-window-line">${esc(line)}</p>${cite}`;
}

// Card 3 (procurement-pursuit-decision): a native-source object never carries
// a City-Record-shaped notice type, so readiness for it is a deliberate,
// explicit signal built from its own source system + observation_type rather
// than an inferred absence of that field. mta_bid_results is excluded on
// purpose -- a bid-opening result is already past the point of pursuit.
const NATIVE_SOLICITATION_SOURCES = new Set(["nys_contract_reporter", "mta_current_opportunities"]);
const AWARD_LIKE_RFX_STATUS = /award|selection/i;
const SOLICITATION_NOTICE_TYPE = /solicitation/i;
const AWARD_LIKE_NOTICE_TYPE = /award/i;

function pursuitStageSignal(rows) {
  let solicitation = false;
  let nativeSparse = false;
  for (const entry of rows) {
    const system = String(entry.source_system || "").toLowerCase();
    const snap = entry.snapshot || {};
    if (system === "passport_public_rfx" && !AWARD_LIKE_RFX_STATUS.test(String(snap.rfx_status || ""))) {
      solicitation = true;
    }
    if (system === "city_record") {
      const type = String(snap.type_of_notice_description || "");
      if (SOLICITATION_NOTICE_TYPE.test(type) && !AWARD_LIKE_NOTICE_TYPE.test(type)) solicitation = true;
    }
    if (NATIVE_SOLICITATION_SOURCES.has(system) && String(snap.observation_type || "").toLowerCase() === "opportunity") {
      nativeSparse = true;
    }
  }
  return { solicitation, nativeSparse };
}

/**
 * Build the pursuit snapshot for a canonical procurement object, reusing
 * every fact this page already computed (title/agency/amount via `facts`,
 * the Card 2 opportunity window, the shared opportunity-calendar occurrence
 * bundle, the M/WBE and official-source surfaces) rather than a second
 * extraction pass. Returns null when pursuit is not meaningful here (an
 * award, a contract-history-only object, a bid-opening result).
 *
 * `preferenceMatch` (card "PPD-05") is a caller-supplied explainMatch()
 * result -- this page never computes a vendor's preference match itself, the
 * same override contract relatedContextCandidates already uses below.
 */
function pursuitSnapshotFor(object, observations, facts, window, occurrences, preferenceMatch) {
  const rows = observationRows(object, observations);
  const stage = pursuitStageSignal(rows);
  if (!stage.solicitation && !stage.nativeSparse) return null;

  const cityRecordRow = rows.find((entry) => entry.source_system === "city_record")?.snapshot || null;
  const rfxRow = rows.find((entry) => entry.source_system === "passport_public_rfx")?.snapshot || null;
  const nativeRow = rows.find((entry) => NATIVE_SOLICITATION_SOURCES.has(String(entry.source_system || "").toLowerCase()))?.snapshot || null;

  const method = cityRecordRow ? extractSolicitationProcurementMethod(cityRecordRow) : null;
  const mwbeView = cityRecordRow ? buildSolicitationMwbeView(cityRecordRow, method) : null;

  const importantDates = (Array.isArray(occurrences) ? occurrences : [])
    .filter((occurrence) => occurrence && typeof occurrence === "object")
    .map((occurrence) => ({ title: occurrence.title, date: occurrence.date, starts_at: occurrence.starts_at }));

  const numericAmount = facts.amount ? Number(String(facts.amount).replace(/[$,]/g, "")) : NaN;
  const amountOpt = Number.isFinite(numericAmount) && numericAmount > 0
    ? { value: numericAmount, status: "observed" }
    : undefined;
  const buyerHistoryComparison = buyerHistoryComparisonFromSolicitation({
    request_id: cityRecordRow?.request_id,
    agency_name: cityRecordRow?.agency_name || facts.agency,
    category_description: cityRecordRow?.category_description,
    selection_method_description: cityRecordRow?.selection_method_description || facts.method,
    contract_amount: cityRecordRow?.contract_amount,
  }, {
    amount: Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : null,
  });

  const epin = object?.identity_keys?.epins?.[0] || rfxRow?.epin || cityRecordRow?.pin || null;
  const sourceStatusLabel = rfxRow?.rfx_status || cityRecordRow?.type_of_notice_description
    || nativeRow?.source_values?.status || nativeRow?.status || null;

  const pursuitRow = {
    short_title: facts.title,
    agency_name: facts.agency,
    type_of_notice_description: stage.solicitation ? "Solicitation" : undefined,
    due_date: window?.due_date || null,
    contact_name: cityRecordRow?.contact_name || null,
    contact_phone: cityRecordRow?.contact_phone || null,
    email: cityRecordRow?.email || null,
    address_to_request: cityRecordRow?.address_to_request || null,
    street_address_1: cityRecordRow?.street_address_1 || null,
    selection_method_description: facts.method || null,
    epin,
  };

  return buildPursuitSnapshot(pursuitRow, {
    nativeSolicitationStage: stage.nativeSparse && !stage.solicitation,
    amount: amountOpt,
    opportunity_window: window,
    important_dates: importantDates,
    procurement_method: method,
    mwbe_view: mwbeView,
    official_source_items: procurementOfficialSourceItems(object, observations, { lookupReceipt: object?.procurement_source_lookup_receipt }),
    source_status_label: sourceStatusLabel,
    cityscroll_url: `https://cityscroll.org${procurementCanonicalHref(object)}`,
    preference_match: preferenceMatch || null,
    buyer_history_href: buyerHistoryComparison.href,
  });
}

// Card 4 (procurement-pursuit-decision): related procurement context beneath
// the pursuit snapshot -- an exact-identity chain and a resemblance-only
// group, plus an amount benchmark reusing the existing small-population
// policy unchanged (see procurement_related_context.mjs). This page never
// invents a cross-object lookup of its own: candidate history records and
// the amount-benchmark comparison population are caller-supplied via opts
// (relatedContextCandidates, relatedContextPopulationAmounts), the same
// override contract every other optional section on this page already uses.
// Absent that input, this renders nothing -- never a fabricated "no history
// found" claim.
function relatedProcurementContextFor(object, facts, pursuitSnapshot, opts) {
  if (!pursuitSnapshot) return null;
  const candidates = Array.isArray(opts?.relatedContextCandidates) ? opts.relatedContextCandidates : [];
  const populationAmounts = Array.isArray(opts?.relatedContextPopulationAmounts) ? opts.relatedContextPopulationAmounts : [];
  if (!candidates.length && !populationAmounts.length) return null;
  const numericAmount = facts.amount ? Number(String(facts.amount).replace(/[$,]/g, "")) : NaN;
  const subject = {
    id: object?.procurement_id || null,
    contract_id: object?.identity_keys?.contract_ids?.[0] || null,
    epin: object?.identity_keys?.epins?.[0] || null,
    pin: object?.identity_keys?.epins?.[0] || null,
    agency_name: facts.agency,
    short_title: facts.title,
    amount: Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : null,
  };
  return buildRelatedProcurementContext({ subject, candidates, populationAmounts });
}

// Inline JSON destined for a <script> element: the closing-tag sequence and the
// two line separators JSON leaves bare are escaped so the payload cannot end
// its own element or break the parse.
function procurementJsonScriptPayload(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Wider-project context beneath the pursuit snapshot: the capital project the
// notice's own published project code belongs to. The relation is materialized
// during acquisition; this page reads the materialized rows and never matches
// anything itself, the same caller-supplied contract relatedContextCandidates
// already uses. Absent that input, or absent a relation for this notice, the
// section renders nothing rather than an empty panel.
function procurementProjectContextFor(object, observations, pursuitSnapshot, materialization) {
  if (!pursuitSnapshot || !materialization) return null;
  const rows = observationRows(object, observations);
  const cityRecordRow = rows.find((entry) => entry.source_system === "city_record")?.snapshot || null;
  const requestId = cityRecordRow?.request_id
    || rows.find((entry) => entry.source_system === "city_record")?.source_system_id
    || null;
  if (!requestId) return null;
  return buildProjectContextView(materialization, { request_id: requestId }, {
    officialNotice: pursuitSnapshot.official_action?.official_notice || null,
  });
}

export function renderProcurementDocument(object = {}, observations = [], {
  currentHref = "",
  sourceStatus = {},
  sourceCoverage,
  lookups = {},
  aboResidual,
  crosswalk = null,
  registeredContractCoverage = null,
  today = null,
  relatedContextCandidates = null,
  relatedContextPopulationAmounts = null,
  projectContextMaterialization = null,
  preferenceMatch = null,
  accessClassification = null,
  siteLifecycleMaterialization = DEFAULT_SITE_LIFECYCLE,
  lookupReceipt = object?.procurement_source_lookup_receipt || null,
  contractLifecycleMaterialization = procurementContractLifecycleMaterialization,
  placeFactsMaterialization = procurementPlaceFactsMaterialization,
} = {}) {
  const id = clean(object?.procurement_id, 320);
  if (!id.startsWith("procurement:")) return null;
  const lifecycle = contractLifecycleForProcurement(
    object,
    observations,
    contractLifecycleMaterialization,
  );
  const paymentEvidence = paymentEvidenceFromLifecycle(lifecycle);
  const placeFacts = placeFactsForProcurement(
    object,
    observations,
    placeFactsMaterialization,
  );
  const facts = factsFor(object, observations);
  if (paymentEvidence) {
    if (paymentEvidence.total_spent != null && !facts.paidAmount) {
      facts.paidAmount = formatAmount(paymentEvidence.total_spent);
    }
    if (paymentEvidence.original_amount != null && !facts.originalAmount) {
      facts.originalAmount = formatAmount(paymentEvidence.original_amount);
    }
    if (paymentEvidence.current_amount != null && !facts.currentAmount) {
      facts.currentAmount = formatAmount(paymentEvidence.current_amount);
    }
    if (paymentEvidence.start_date && !facts.start_date && !facts.startDate) {
      facts.start_date = paymentEvidence.start_date;
      facts.startDate = paymentEvidence.start_date;
    }
    if (paymentEvidence.end_date && !facts.end_date && !facts.endDate) {
      facts.end_date = paymentEvidence.end_date;
      facts.endDate = paymentEvidence.end_date;
    }
  }
  const occurrences = procurementOpportunityOccurrences(object, observations).occurrences;
  // One compact opportunity month (conference / questions / proposal dates)
  // ahead of the observed-event detail. Sparse bundles and an unsupplied day
  // render nothing; the long lifecycle stays in the sections below.
  const opportunityMonth = opportunityMonthHTML(occurrences, { today: clean(today, 10) || null });
  const opportunityWindow = procurementOpportunityWindow(object, observations);
  // Card 3: a compact pursuit snapshot near the top of solicitation-stage
  // detail, composed from the same facts/window/occurrences/M-WBE/official-
  // source surfaces this page already renders below. Null (never a section)
  // for anything that is not at solicitation stage, per the same rule the
  // existing calendar and window sections already follow.
  const pursuitSnapshot = pursuitSnapshotFor(object, observations, facts, opportunityWindow, occurrences, preferenceMatch);
  const pursuitSnapshotHtml = renderPursuitSnapshotHtml(pursuitSnapshot);
  const relatedContext = relatedProcurementContextFor(object, facts, pursuitSnapshot, {
    relatedContextCandidates,
    relatedContextPopulationAmounts,
  });
  const relatedContextHtml = renderRelatedProcurementContextHtml(relatedContext);
  const projectContext = procurementProjectContextFor(object, observations, pursuitSnapshot, projectContextMaterialization);
  const projectContextHtml = renderProjectContextHtml(projectContext);
  // The same section, reduced to one line, for the in-place event inspection on
  // this page. Serialized as inert JSON the shared preview binder reads: no
  // fetch, no second copy of the relation, and nothing to load at read time.
  const projectContextInspect = projectContext ? projectContextInspectSummary(projectContext) : null;
  const siteLifecycleContext = buildSiteLifecycleContext(siteLifecycleMaterialization, {
    subjectId: id,
    surface: "procurement",
  });
  const siteLifecycleContextHtml = renderSiteLifecycleContext(siteLifecycleContext);
  const factRows = [
    ["Agency", facts.agency, "agency"], ["Vendor", facts.vendor, "vendor"], ["Amount", facts.amount],
    ["Original contract amount", facts.originalAmount], ["Current contract total", facts.currentAmount],
    ["Action amount", facts.actionAmount], ["Paid amount", facts.paidAmount], ["Encumbered amount", facts.encumberedAmount],
    ["Award date", facts.awardDate, "award_date"], ["Award-notice publication", facts.noticePublicationDate, "notice_publication_date"],
    ["PASSPort contract number", facts.contractNumber], ["Method", facts.method], ["Contract type", facts.contractType],
    ["Program", facts.program], ["Industry", facts.industry],
    ["Contract start", facts.start_date || facts.startDate], ["Contract end", facts.end_date || facts.endDate],
    ["Registration date", facts.registrationDate, "registration_date"],
    ["Contract ID", object?.identity_keys?.contract_ids?.[0] || facts.canonicalContractId, "canonical_contract_id"],
    ["PIN / EPIN", object?.identity_keys?.epins?.[0] || facts.pinEpin, "pin_epin"],
    ["Contract Reporter number", object?.identity_keys?.contract_reporter_numbers?.[0], "contract_reporter_number"],
    ["Solicitation", object?.identity_keys?.solicitation_ids?.[0], "solicitation_id"],
    ["Event", object?.identity_keys?.event_ids?.[0], "event_id"],
  ].filter(([, value]) => value).map(([label, value, kind]) => `<div><dt>${esc(label)}</dt><dd>${kind ? procurementFactValue(facts, kind, value, object) : esc(value)}</dd></div>`).join("");
  const sourceItems = procurementOfficialSourceItems(object, observations, { lookupReceipt });
  const coverageLedger = object?.cross_source_coverage_ledger || buildCrossSourceCoverageLedger({
    object,
    observations,
    sourceStatus,
    sourceCoverage,
    lookups,
    lookupReceipt,
    aboResidual,
    crosswalk,
    registeredContractCoverage,
    kind: "procurement",
  });
  const coverageReaderBase = projectCoverageForReaders(coverageLedger);
  const coverageReader = coverageReaderBase
    ? {
      ...coverageReaderBase,
      claim_caveats: Object.freeze(filterPaymentCoverageCaveats(
        coverageReaderBase.claim_caveats,
        paymentEvidence,
      )),
    }
    : null;
  const claimCaveatsHtml = renderCoverageClaimCaveats(coverageReader);
  const placeFactsHtml = renderProcurementPlaceFactsHtml(placeFacts);
  const paymentEvidenceHtml = renderProcurementPaymentEvidenceHtml(paymentEvidence);
  const representedOfficialHrefs = new Set((coverageLedger?.sources || [])
    .flatMap((source) => [source.record_href, source.official_href, source.search_href].filter(Boolean)));
  const uniqueSourceItems = sourceItems.filter((item) => !representedOfficialHrefs.has(item.href));
  // Card "PPD-07": where the access classification says a field is reachable
  // only after signing in, or is carried by no public source this product
  // observes, say so beside the official-record handoff rather than leaving a
  // vendor to discover it at the portal. Caller-supplied, like every other
  // optional section on this page: absent that input this renders nothing.
  const handoffCopyHtml = renderProcurementHandoffCopyHtml(
    accessClassification
      ? buildProcurementHandoffCopy(accessClassification, { record: { last_observed_at: lastObservedAtFor(object, observations) } })
      : null,
  );
  const factsBody = [
    factRows ? `<dl class="node-facts">${factRows}</dl>` : "",
    claimCaveatsHtml,
  ].filter(Boolean).join("");
  const canonical = procurementCanonicalHref(object);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(facts.title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(canonical)}">${renderCivicDocumentAssets("/")}${opportunityMonth ? '<link rel="stylesheet" href="/compact_calendar.css" data-route-style="compact_calendar.css">' : ""}${opportunityMonth ? renderCalendarEventPreviewScript("/") : ""}${pursuitSnapshotHtml ? '<link rel="stylesheet" href="/procurement_pursuit_snapshot.css" data-route-style="procurement_pursuit_snapshot.css">' : ""}${relatedContextHtml ? '<link rel="stylesheet" href="/procurement_related_context.css" data-route-style="procurement_related_context.css">' : ""}${projectContextHtml ? '<link rel="stylesheet" href="/procurement_project_context.css" data-route-style="procurement_project_context.css">' : ""}${coverageReader ? '<link rel="stylesheet" href="/coverage_reader_projection.css" data-route-style="coverage_reader_projection.css">' : ""}<script type="module" src="/report_issue.mjs"></script></head>
<body>${renderCivicDocumentMast({ current: "browse" })}<main class="node-document" data-civic-object-kind="procurement" data-procurement-id="${esc(id)}">
${renderNodeBack({ href: "/browse/contracts/?mode=award", label: "Back to contracts", currentHref })}
<header class="node-hero"><p class="ftype">Procurement</p><h1>${esc(facts.title)}</h1></header>
${pursuitSnapshotHtml}
${projectContextHtml}
${siteLifecycleContextHtml}
${relatedContextHtml}
${projectContextInspect ? `<script type="application/json" data-project-context-inspect="1">${procurementJsonScriptPayload({ summary: projectContextInspect })}</script>` : ""}
${procurementActions(object, facts)}
${renderCrossSourceEvidenceReceipt(object?.cross_source_evidence_receipt)}
${placeFactsHtml}
${renderNodeSection({ heading: "Contract facts", body: factsBody })}
${paymentEvidenceHtml}
${renderProcurementInstitutionRoles(object, observations)}
${renderProcurementObjectCoverageHtml(object, observations)}
${renderNodeSection({
  heading: "Opportunity window",
  headingId: "procurement-opportunity-window",
  extraClass: "procurement-opportunity-window",
  attrs: { id: "procurement-opportunity-window" },
  body: opportunityWindowSectionBody(object, observations, opportunityWindow),
})}
${renderNodeSection({
  heading: "Opportunity dates",
  headingId: "procurement-opportunity-month",
  extraClass: "procurement-opportunity-calendar",
  attrs: { id: "procurement-opportunity-month" },
  body: opportunityMonth,
})}
${renderNodeSection({
  heading: "Observed events",
  headingId: "procurement-process",
  extraClass: "procurement-process",
  body: renderProcurementProcessEvents(object?.process_events),
})}
${renderNodeSection({
  heading: "Observed stages",
  body: Array.isArray(object?.process_events) && object.process_events.length ? "" : stageList(object),
})}
${renderCoverageReaderProjection(coverageReader)}
${renderNodeProvenance({ heading: uniqueSourceItems.length ? "Official records" : "", sourceItems: uniqueSourceItems })}
${renderNodeSection({
  heading: "What these official records do not carry",
  headingId: "procurement-handoff-access",
  extraClass: "procurement-handoff-access",
  body: handoffCopyHtml,
})}
</main>${renderNodeFooter({})}</body></html>`;
  return gateNodePageRender(html);
}
