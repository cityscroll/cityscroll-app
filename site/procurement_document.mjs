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
import { passportPublicOfficialSource } from "../worker/src/lib/passport_parse.mjs";
import { snapshotsForPublicAmount } from "./checkbook_passport_corroboration.mjs";
import { renderCrossSourceEvidenceReceipt } from "./cross_source_evidence_receipt.mjs";
import {
  buildCrossSourceCoverageLedger,
  renderCrossSourceCoverageLedger,
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

const CHECKBOOK_SMART_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";
const CHECKBOOK_CONTRACT_SEARCH = "https://www.checkbooknyc.com/contract_search";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function formatAmount(value) {
  const raw = clean(value);
  if (!raw) return null;
  const number = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(number) ? `$${number.toLocaleString("en-US")}` : raw;
}

function factsFor(object, observations) {
  const index = new Map((Array.isArray(observations) ? observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
  const observed = (object?.source_observation_refs || []).map((ref) => index.get(ref)).filter(Boolean);
  const rows = snapshotsForPublicAmount(object, observed);
  const vendorRows = observed
    .filter((entry) => !(entry.source_system === "passport_public_rfx"
      && String(entry.snapshot?.rfx_status || "").trim().toLowerCase() === "selections made"))
    .map((entry) => entry.snapshot || {});
  const firstIn = (sourceRows, ...fields) => {
    for (const row of sourceRows) for (const field of fields) {
      const value = clean(row?.[field]);
      if (value) return value;
    }
    return null;
  };
  const first = (...fields) => firstIn(rows, ...fields);
  return {
    title: first("short_title", "title", "description")
      || `Contract ${object?.identity_keys?.contract_ids?.[0] || object?.identity_keys?.epins?.[0] || "record"}`,
    agency: first("agency_name", "agency"),
    vendor: firstIn(vendorRows, "vendor_name", "vendor", "prime_vendor", "payee_name"),
    amount: formatAmount(first("contract_amount", "award_amount", "current_amount", "current", "amount", "check_amount")),
    contractNumber: first("contract_number", "transaction_number", "contract_id"),
    awardDate: first("award_date"),
    method: first("selection_method_description", "procurement_method"),
    program: first("program"),
    industry: first("industry"),
    start_date: first("start", "start_date", "contract_start_date"),
    end_date: first("end", "end_date", "contract_end_date"),
    startDate: first("start_date", "start", "issue_date", "date"),
    endDate: first("end_date", "end", "contract_end_date", "due_date", "closing_date", "opening_date"),
    officialUrl: first("official_url", "official_source_url", "source_url"),
  };
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

function checkbookOfficialSource(object, rows) {
  const snapshots = rows.map((entry) => entry?.snapshot).filter(Boolean);
  const first = (...fields) => {
    for (const row of snapshots) for (const field of fields) {
      const value = clean(row?.[field], 80);
      if (value) return value;
    }
    return null;
  };
  const agid = first("agid", "original_agreement_id");
  const direct = first("official_url", "source_url");
  if (direct) return { href: direct, label: "Checkbook NYC" };
  const contractId = object?.identity_keys?.contract_ids?.[0] || first("id", "contract_id", "contractId", "prime_contract_id");
  const vendor = first("vendor", "vendor_name", "prime_vendor", "payee_name");
  if (/^\d+$/.test(agid || "")) {
    const codeMatch = String(contractId || "").trim().match(/^([A-Za-z]+)(\d)/);
    const code = codeMatch ? `${codeMatch[1]}${codeMatch[2]}`.toUpperCase() : "CT1";
    return {
      href: `https://www.checkbooknyc.com/contract_details/agid/${encodeURIComponent(agid)}/doctype/${encodeURIComponent(code)}`,
      label: "Checkbook NYC",
    };
  }
  const term = contractId || vendor;
  if (term) {
    return {
      href: `${CHECKBOOK_SMART_SEARCH}?search_term=${encodeURIComponent(term)}`,
      label: "Search Checkbook NYC",
    };
  }
  return { href: CHECKBOOK_CONTRACT_SEARCH, label: "Checkbook NYC" };
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
export function procurementOfficialSourceItems(object = {}, observations = []) {
  const rows = observationRows(object, observations);
  const systems = new Set(rows.map((entry) => String(entry.source_system || "").toLowerCase()));
  for (const ref of object?.source_observation_refs || []) {
    const system = String(ref).split(":")[0]?.toLowerCase();
    if (system) systems.add(system);
  }
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
  if (systems.has("passport_public_contracts")) {
    add(passportPublicOfficialSource("contract"));
  }
  if (systems.has("passport_public_rfx")) {
    const rfx = rows.find((entry) => entry.source_system === "passport_public_rfx");
    add(passportPublicOfficialSource("rfx", rfx?.snapshot || {}));
  }
  if (systems.has("checkbook_contracts") || systems.has("checkbook_nycha_contracts") || systems.has("checkbook_spending")) {
    add(checkbookOfficialSource(object, rows.filter((entry) =>
      entry.source_system === "checkbook_contracts" || entry.source_system === "checkbook_nycha_contracts" || entry.source_system === "checkbook_spending")));
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
    official_source_items: procurementOfficialSourceItems(object, observations),
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
} = {}) {
  const id = clean(object?.procurement_id, 320);
  if (!id.startsWith("procurement:")) return null;
  const facts = factsFor(object, observations);
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
  const factRows = [
    ["Agency", facts.agency], ["Vendor", facts.vendor], ["Amount", facts.amount], ["Award date", facts.awardDate],
    ["Contract number", facts.contractNumber], ["Method", facts.method],
    ["Program", facts.program], ["Industry", facts.industry],
    ["Start date", facts.start_date || facts.startDate], ["End date", facts.end_date || facts.endDate],
    ["Contract ID", object?.identity_keys?.contract_ids?.[0]], ["PIN / EPIN", object?.identity_keys?.epins?.[0]],
    ["Contract Reporter number", object?.identity_keys?.contract_reporter_numbers?.[0]],
    ["Solicitation", object?.identity_keys?.solicitation_ids?.[0]], ["Event", object?.identity_keys?.event_ids?.[0]],
  ].filter(([, value]) => value).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  const sourceItems = procurementOfficialSourceItems(object, observations);
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
  const canonical = procurementCanonicalHref(object);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(facts.title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(canonical)}">${renderCivicDocumentAssets("/")}${opportunityMonth ? '<link rel="stylesheet" href="/compact_calendar.css" data-route-style="compact_calendar.css">' : ""}${opportunityMonth ? renderCalendarEventPreviewScript("/") : ""}${pursuitSnapshotHtml ? '<link rel="stylesheet" href="/procurement_pursuit_snapshot.css" data-route-style="procurement_pursuit_snapshot.css">' : ""}${relatedContextHtml ? '<link rel="stylesheet" href="/procurement_related_context.css" data-route-style="procurement_related_context.css">' : ""}${projectContextHtml ? '<link rel="stylesheet" href="/procurement_project_context.css" data-route-style="procurement_project_context.css">' : ""}<script type="module" src="/report_issue.mjs"></script></head>
<body>${renderCivicDocumentMast({ current: "browse" })}<main class="node-document" data-civic-object-kind="procurement" data-procurement-id="${esc(id)}">
${renderNodeBack({ href: "/browse/contracts/?mode=award", label: "Back to contracts", currentHref })}
<header class="node-hero"><p class="ftype">Procurement</p><h1>${esc(facts.title)}</h1></header>
${pursuitSnapshotHtml}
${projectContextHtml}
${relatedContextHtml}
${projectContextInspect ? `<script type="application/json" data-project-context-inspect="1">${procurementJsonScriptPayload({ summary: projectContextInspect })}</script>` : ""}
${procurementActions(object, facts)}
${renderCrossSourceEvidenceReceipt(object?.cross_source_evidence_receipt)}
${renderNodeSection({ heading: "Contract facts", body: factRows ? `<dl class="node-facts">${factRows}</dl>` : "" })}
${renderProcurementInstitutionRoles(object, observations)}
${renderCrossSourceCoverageLedger(object?.cross_source_coverage_ledger || buildCrossSourceCoverageLedger({
  object,
  observations,
  sourceStatus,
  sourceCoverage,
  lookups,
  aboResidual,
  crosswalk,
  registeredContractCoverage,
  kind: "procurement",
}))}
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
${renderNodeProvenance({ heading: sourceItems.length ? "Official records" : "", sourceItems })}
${renderNodeSection({
  heading: "What these official records do not carry",
  headingId: "procurement-handoff-access",
  extraClass: "procurement-handoff-access",
  body: handoffCopyHtml,
})}
</main>${renderNodeFooter({})}</body></html>`;
  return gateNodePageRender(html);
}
