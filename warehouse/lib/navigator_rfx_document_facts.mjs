/**
 * Deterministic, page-cited reading for recognized PASSPort solicitation templates.
 *
 * The rules deliberately recognize a narrow template/version pair. An unknown
 * document produces one explicit abstention and no positive requirement. OCR
 * and model inference are outside this module; page text and extraction quality
 * continue to come from the publisher-neutral document-processing interface.
 */
import { EVIDENCE_ROLES, STANDING_LABELS } from "../../site/procurement_contract_substance_contract.mjs";
import { sha256Hex } from "./document_processing.mjs";

export const NAVIGATOR_DOCUMENT_FACTS_VERSION = "navigator_rfx_document_facts.v1";
export const NAVIGATOR_DOCUMENT_FACTS_ONTOLOGY_VERSION = "procurement_document_facts.v1";

const CONTRACT_TEMPLATE = "parks_supply_service_contract.v7-3-25";
const OPENING_TEMPLATE = "parks_bid_opening_notice.v1";

const CONTRACT_ROLES = Object.freeze([
  "bid_form",
  "bond_insurance",
  "eligibility_evidence",
  "labor_compliance",
  "participation_plan",
  "proposed_agreement",
  "scope_specification",
  "solicitation_instructions",
]);

const CONTRACT_SECTIONS = Object.freeze([
  ["cover", "Cover and submission channel", ["solicitation_instructions"], "solicitation", 1, 1, "BIDS ARE TO BE SUBMITTED VIA PASSPort"],
  ["schedule-a-reference", "Schedule A: reference item requirements", ["bond_insurance", "eligibility_evidence", "labor_compliance"], "solicitation", 2, 4, "REFERENCE ITEM REQUIREMENTS"],
  ["schedule-a-insurance", "Schedule A: insurance types and limits", ["bond_insurance"], "solicitation", 5, 10, "Types of Insurance"],
  ["insurance-certificates", "Certificates of insurance and broker certification", ["bond_insurance", "bid_form"], "solicitation", 11, 12, "CERTIFICATES OF"],
  ["notice-vendex-fee", "Notice: VENDEX name-check fee", ["solicitation_instructions"], "solicitation", 13, 13, "Procurement Policy Board Rule 2-08(f)(2)"],
  ["notice-subcontractor-reporting", "Notice to bidders: subcontractor reporting", ["labor_compliance"], "solicitation", 14, 14, "NOTICE TO BIDDERS"],
  ["mwbe-notice", "M/WBE participation notice", ["participation_plan"], "solicitation", 15, 24, "PARTICIPATION BY MINORITY"],
  ["notices-whistleblower-doi", "Notices: whistleblower protection and DOI reporting", ["labor_compliance"], "solicitation", 25, 28, "NOTICE TO BIDDERS, PROPOSERS"],
  ["essta-rider", "Earned Safe and Sick Time Act contract rider", ["labor_compliance"], "solicitation", 29, 34, "CONTRACT RIDER"],
  ["bid-book", "Part I: bid book (terms, conditions, affirmations)", ["solicitation_instructions", "bid_form"], "solicitation", 35, 51, "PART I – BID BOOK"],
  ["general-specifications", "Part I-D: general specifications", ["scope_specification"], "solicitation", 52, 66, "GENERAL SPECIFICATIONS"],
  ["agreement", "Part II: supply and service contract (proposed terms)", ["proposed_agreement"], "proposed", 67, 141, "SUPPLY AND SERVICE CONTRACT"],
  ["prevailing-wage-schedule", "Comptroller's prevailing wage schedule (reference)", ["labor_compliance"], "solicitation", 142, 237, "PREVAILING WAGE SCHEDULE"],
].map(([id, label, roles, standing, first, last, anchor]) => Object.freeze({
  id,
  label,
  roles: Object.freeze(roles),
  standing,
  pdf_pages: Object.freeze([first, last]),
  anchor,
})));

const OPENING_EVENTS = Object.freeze([
  {
    id: "response-deadline",
    type: "response_deadline",
    local: "2026-11-09T14:00:00",
    timezone: "America/New_York",
    pdf_page: 1,
    excerpt: "Bids are due by Novem ber 9th, 2026 @ 2:00PM .",
  },
  {
    id: "bid-opening",
    type: "bid_opening",
    local: "2026-11-09T15:00:00",
    timezone: "America/New_York",
    mode: "remote (Microsoft Teams); in-person prohibited",
    pdf_page: 1,
    excerpt: "The Bid Opening will be conducted via Microsoft Teams at 3:00PM on November 9t h, 2026 . In-person",
  },
]);

const FACT_RULES = Object.freeze([
  ["opening-logon-test", "event_notice", "Teams logon test window", "informational", "2:45 PM on the opening day", "stated courtesy window", "not a deadline", 1, "opening_text", "open the Microsoft TEAMS portal at 2:45PM"],
  ["questions-channel", "event_notice", "Where to ask questions", "informational", "PASSPort “Discussion with Buyer” forum", "stated instruction", "no question deadline is stated", 1, "opening_text", "All questions must be submitted in the “ Discussion with Buyer ” forum in PASSPort ."],
  ["bid-bond", "bond_insurance", "Bid bond", "not_applicable", null, "N/A box marked", null, 2, "schedule_a_checkbox", "Bid Bond ☒N/A or ☐__% of Total Bid Price"],
  ["bid-security", "bond_insurance", "Bid security", "not_applicable", null, "N/A box marked", null, 2, "schedule_a_checkbox", "Bid Bond ☒N/A or ☐__% of Total Bid Price ☒ N/A or ☐___% of Total Bid Price"],
  ["performance-bond", "bond_insurance", "Performance bond", "not_applicable", null, "N/A box marked", null, 2, "schedule_a_checkbox", "Performance Bond ☒N/A or ☐"],
  ["payment-bond", "bond_insurance", "Payment bond", "not_applicable", null, "N/A box marked", null, 2, "schedule_a_checkbox", "Payment Bond ☒N/A or ☐"],
  ["retained-percentage", "bond_insurance", "Retained percentage", "not_applicable", null, "N/A box marked", null, 3, "schedule_a_checkbox", "Retained Percentage ☒N/A ☐___%"],
  ["maintenance-guaranty-security", "bond_insurance", "Maintenance and guaranty security", "conflicting", null, "both N/A and an alternative are marked", null, 3, "schedule_a_checkbox", "Security ☒N/A ☒ ___% of Total Contract Amount"],
  ["guaranty-period", "bond_insurance", "Guaranty period", "required", "1 Year(s)", "N/A unmarked; value entered", null, 3, "schedule_a_checkbox", "Guaranty Period ☐N/A or 1 Year(s)"],
  ["partial-payment", "pricing_schedule", "Partial payment", "informational", "Will Be Allowed", "contract term marked", null, 3, "schedule_a_checkbox", "Partial Payment ☒ Will Be Allowed ☐ Will Not Be Allowed"],
  ["labor-law", "labor_compliance", "Labor law and living wage requirements", "required", "New York Labor Law § 220 (prevailing wage)", "one option marked", null, 4, "schedule_a_checkbox", "☐N/A ☒NY LABOR LAW 220 ☐NY Labor Law 230 ☐Living Wage", { anticipated_trades: ["Field Engineer", "Electrician", "Plumber"] }],
  ["insurance-commercial-general-liability", "bond_insurance", "Commercial General Liability", "required", ["$ 1,000,000.00 per occurrence", "$ 2,000,000.00 aggregate"], "marked box means required (page 5 legend)", null, 5, "schedule_a_insurance_checkbox", "☒Comm ercial General Liability", { article: "Art. 15(II)(A)" }],
  ["insurance-workers-compensation", "bond_insurance", "Workers’ Compensation", "required", ["Statutory"], "marked box means required (page 5 legend)", null, 6, "schedule_a_insurance_checkbox", "☒Work ers’ Compensat ion", { article: "Art. 15(I)" }],
  ["insurance-disability-benefits", "bond_insurance", "Disability Benefits Insurance", "required", ["Statutory"], "marked box means required (page 5 legend)", null, 6, "schedule_a_insurance_checkbox", "☒Disabi lity Benefits Insurance", { article: "Art. 15(I)" }],
  ["insurance-employers-liability", "bond_insurance", "Employers’ Liability", "required", ["Statutory"], "marked box means required (page 5 legend)", null, 6, "schedule_a_insurance_checkbox", "☒Employers’ Liability", { article: "Art. 15(I)" }],
  ["insurance-jones-act", "bond_insurance", "Jones Act", "not_applicable", null, "box unmarked", null, 6, "schedule_a_insurance_checkbox", "☐Jones Act", { article: "Art. 15(II)(F)" }],
  ["insurance-longshore-harbor-workers", "bond_insurance", "U.S. Longshoremen’s and Harbor", "not_applicable", null, "box unmarked", null, 6, "schedule_a_insurance_checkbox", "☐U.S. Longshoremen’s and Harbor", { article: "Art. 15(II)(F)" }],
  ["insurance-commercial-auto-liability", "bond_insurance", "Commercial Auto Liability", "required", ["$1,000,000.00 per accident combined single limit"], "marked box means required (page 5 legend)", null, 6, "schedule_a_insurance_checkbox", "☒ Comme rcial Auto Liability", { article: "Art. 15(II)(B)" }],
  ["insurance-contractors-pollution-liability", "bond_insurance", "Contractors Pollution Liability", "not_applicable", null, "box unmarked", null, 7, "schedule_a_insurance_checkbox", "☐Contractors Pollution Liability", { article: "Art. 15(II)(F)" }],
  ["insurance-marine-protection-indemnity", "bond_insurance", "Marine Protection and Indemnity", "not_applicable", null, "box unmarked", null, 8, "schedule_a_insurance_checkbox", "☐ Marine Protect ion and Indemnity", { article: "Art. 15(II)(F)" }],
  ["insurance-hull-machinery", "bond_insurance", "Hull and Machinery Insurance", "not_applicable", null, "box unmarked", null, 8, "schedule_a_insurance_checkbox", "☐ Hull and Machine ry Insurance", { article: "Art. 15(II)(F)" }],
  ["insurance-marine-pollution-liability", "bond_insurance", "Marine Pollution Liability", "not_applicable", null, "box unmarked", null, 8, "schedule_a_insurance_checkbox", "☐ Marine Pollution Liability", { article: "Art. 15(II)(F)" }],
  ["insurance-professional-liability", "bond_insurance", "Professional Liability Insurance", "not_applicable", null, "box unmarked", null, 8, "schedule_a_insurance_checkbox", "☐ Professional Liability Insurance", { article: "Art. 15(II)(C)" }],
  ["insurance-personal-property", "bond_insurance", "Personal Property Insurance", "not_applicable", null, "box unmarked", null, 9, "schedule_a_insurance_checkbox", "☐ Personal Prop erty Insurance", { article: "Art. 15(II)(F)" }],
  ["experience-three-years", "eligibility_evidence", "Contractor experience", "required", "At least 3 years testing, maintaining and repairing the named systems", "stated requirement", "joint venture: at least one member meets it", 2, "schedule_a_text", "at least 3 years of experience"],
  ["client-references", "eligibility_evidence", "Client references", "required", "Names and contacts of at least two client organizations", "stated requirement", "before award, not with the bid", 2, "schedule_a_text", "Prior to award, the Contractor must submit the names and contact information of at least two (2) client organizations"],
  ["mwbe-waiver-deadline", "participation_plan", "M/WBE goal waiver request", "conditional", "7 calendar days before bids are due", "stated rule", "only if participation goals are set on Schedule B, which this book does not contain", 19, "participation_notice_text", "no later than seven (7) calendar days prior to the date and time the bids"],
  ["mwbe-goals", "participation_plan", "M/WBE participation goals", "unknown", null, "goals are set on Schedule B; Schedule B is not in this document", null, 16, "participation_notice_text", "are set forth on Schedule B, Part 1"],
  ["submission-channel", "solicitation_instructions", "How to submit", "required", "PASSPort only; no paper bids", "stated instruction", null, 1, "cover_text", "BIDS ARE TO BE SUBMITTED VIA PASSPort – the City’s digital Procurement and Sourcing Solutions Portal NO PAPER BIDS WILL BE ACCEPTED!"],
]);

const TOC_ABSTENTIONS = Object.freeze([
  ["pre-bid-conference", "Pre-Bid Conference (Optional)"],
  ["site-visit", "Site Visit"],
  ["bid-security-toc", "Bid Sec urity"],
  ["performance-bond-toc", "Performance Bond"],
]);

const ABSTENTION_ROLES = Object.freeze({
  "pre-bid-conference": "solicitation_instructions",
  "site-visit": "solicitation_instructions",
  "bid-security-toc": "bond_insurance",
  "performance-bond-toc": "bond_insurance",
});

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function pageIndex(pages = []) {
  return new Map((Array.isArray(pages) ? pages : []).map((page) => [page.page_number, {
    ...page,
    normalized_text: normalizedText(page.text),
  }]));
}

function citation(excerpt) {
  return {
    excerpt: excerpt ?? null,
    excerpt_sha256: excerpt == null ? null : sha256Hex(excerpt),
  };
}

function recognizeTemplate({ document = {}, pages = [], pageCount = null } = {}) {
  const index = pageIndex(pages);
  const first = index.get(1)?.normalized_text || "";
  if (pageCount === 1
    && first.includes("ATTENTION ALL PROSPECTIVE BIDDERS")
    && first.includes("84627B0012")
    && first.includes("Maintenance and Repair of Automated Logic WebCTRL and Carrier")
    && first.includes("Bid Due Date")
    && first.includes("Bid Opening")) {
    return OPENING_TEMPLATE;
  }
  const second = index.get(2)?.normalized_text || "";
  if (pageCount === 237
    && /V\.\s*7-3-25/.test(first)
    && first.includes("PIN # 84627B0012")
    && first.includes("BIDS ARE TO BE SUBMITTED VIA PASSPort")
    && second.includes("SUPPLY AND SERVICE CONTRACT")
    && second.includes("SCHEDULE A")
    && second.includes("REFERENCE ITEM REQUIREMENTS")) {
    return CONTRACT_TEMPLATE;
  }
  return null;
}

function eventFromRule(rule, index) {
  const text = index.get(rule.pdf_page)?.normalized_text || "";
  if (!text.includes(rule.excerpt)) return null;
  const base = {
    id: rule.id,
    type: rule.type,
    local: rule.local,
    timezone: rule.timezone,
  };
  if (rule.mode) base.mode = rule.mode;
  return Object.freeze({ ...base, pdf_page: rule.pdf_page, ...citation(rule.excerpt) });
}

function factFromRule(rule, index) {
  const [id, role, subject, applicability, value, basis, condition, pdfPage, ruleName, excerpt, extras = {}] = rule;
  const text = index.get(pdfPage)?.normalized_text || "";
  if (!text.includes(excerpt)) return null;
  const fact = { id, role, subject };
  if (extras.article) fact.article = extras.article;
  Object.assign(fact, { applicability, value, basis, condition, pdf_page: pdfPage, rule: ruleName });
  if (extras.anticipated_trades) fact.anticipated_trades = Object.freeze([...extras.anticipated_trades]);
  return Object.freeze({ ...fact, ...citation(excerpt) });
}

function unknownInsuranceFact(index) {
  const text = index.get(10)?.normalized_text || "";
  const count = (text.match(/\[OTH ER\]/g) || []).length;
  if (count !== 2) return null;
  return Object.freeze({
    id: "insurance-unlabelled-p10",
    role: "bond_insurance",
    subject: "Checkbox without a recoverable label",
    applicability: "unknown",
    value: null,
    basis: "2 box(es) whose label is not in the text layer",
    condition: "inspect the PDF page",
    pdf_page: 10,
    rule: "schedule_a_insurance_checkbox",
    ...citation(null),
  });
}

function contractProjection(index) {
  const facts = FACT_RULES.slice(2).map((rule) => factFromRule(rule, index)).filter(Boolean);
  const unknownInsurance = unknownInsuranceFact(index);
  facts.splice(22, 0, ...(unknownInsurance ? [unknownInsurance] : []));

  const tocText = index.get(36)?.normalized_text || "";
  const abstentions = TOC_ABSTENTIONS.flatMap(([id, excerpt]) => (
    tocText.includes(excerpt)
      ? [Object.freeze({
        id,
        pdf_page: 36,
        reason: "table-of-contents heading; keyword is not a requirement",
        creates_task: false,
        ...citation(excerpt),
      })]
      : []
  ));

  return {
    recognized_template: CONTRACT_TEMPLATE,
    roles: CONTRACT_ROLES,
    standing: "solicitation",
    evidence_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
    standing_label: STANDING_LABELS.ADVERTISED,
    container: true,
    unsectioned_pages: Object.freeze([]),
    sections: CONTRACT_SECTIONS,
    events: Object.freeze([]),
    facts: Object.freeze(facts),
    abstentions: Object.freeze(abstentions),
  };
}

function openingProjection(index) {
  return {
    recognized_template: OPENING_TEMPLATE,
    roles: Object.freeze(["event_notice"]),
    standing: "solicitation",
    evidence_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
    standing_label: STANDING_LABELS.ADVERTISED,
    container: false,
    unsectioned_pages: Object.freeze([]),
    sections: Object.freeze([]),
    events: Object.freeze(OPENING_EVENTS.map((rule) => eventFromRule(rule, index)).filter(Boolean)),
    facts: Object.freeze(FACT_RULES.slice(0, 2).map((rule) => factFromRule(rule, index)).filter(Boolean)),
    abstentions: Object.freeze([]),
  };
}

/** Read one extracted document without OCR, models, or publisher requests. */
export function readNavigatorDocumentFacts({ document = {}, pages = [], pageCount = document.page_count ?? null } = {}) {
  const index = pageIndex(pages);
  const recognizedTemplate = recognizeTemplate({ document, pages, pageCount });
  const projection = recognizedTemplate === CONTRACT_TEMPLATE
    ? contractProjection(index)
    : recognizedTemplate === OPENING_TEMPLATE
      ? openingProjection(index)
      : {
        recognized_template: null,
        roles: Object.freeze([]),
        standing: null,
        evidence_role: null,
        standing_label: null,
        container: false,
        unsectioned_pages: Object.freeze([]),
        sections: Object.freeze([]),
        events: Object.freeze([]),
        facts: Object.freeze([]),
        abstentions: Object.freeze([Object.freeze({
          id: "unrecognized-template",
          pdf_page: null,
          reason: "document template is not recognized; no positive facts emitted",
          creates_task: false,
          ...citation(null),
        })]),
      };
  return Object.freeze(projection);
}

function projectionCacheKey(extractionKey = {}) {
  return JSON.stringify([
    extractionKey.sha256,
    extractionKey.extractor,
    extractionKey.pdf_library,
    extractionKey.ontology_version,
    NAVIGATOR_DOCUMENT_FACTS_ONTOLOGY_VERSION,
    NAVIGATOR_DOCUMENT_FACTS_VERSION,
  ]);
}

function ensureFactsState(state) {
  if (!(state.fact_projections instanceof Map)) state.fact_projections = new Map();
  if (!Number.isInteger(state.fact_projection_runs)) state.fact_projection_runs = 0;
  if (!Number.isInteger(state.fact_cache_hits)) state.fact_cache_hits = 0;
}

function roleMetrics(projection) {
  const counts = new Map();
  for (const fact of projection.facts) {
    const current = counts.get(fact.role) || { role: fact.role, fact_count: 0, required_count: 0, abstention_count: 0 };
    current.fact_count += 1;
    if (fact.applicability === "required") current.required_count += 1;
    counts.set(fact.role, current);
  }
  for (const abstention of projection.abstentions) {
    const role = ABSTENTION_ROLES[abstention.id] || "unclassified";
    const current = counts.get(role) || { role, fact_count: 0, required_count: 0, abstention_count: 0 };
    current.abstention_count += 1;
    counts.set(role, current);
  }
  return Object.freeze([...counts.values()]
    .map((row) => Object.freeze({ ...row, denominator: row.fact_count + row.abstention_count }))
    .sort((left, right) => left.role.localeCompare(right.role)));
}

/** Cache the deterministic reading by source hash, parser, library, and ontologies. */
export function projectNavigatorDocumentFacts({
  document,
  extraction,
  state,
  nowMilliseconds = () => performance.now(),
} = {}) {
  if (!extraction?.extraction_key) throw new Error("extraction.extraction_key is required");
  if (!state || typeof state !== "object") throw new Error("state is required");
  ensureFactsState(state);
  const cacheKey = projectionCacheKey(extraction.extraction_key);
  const started = nowMilliseconds();
  const cached = state.fact_projections.get(cacheKey);
  const projection = cached?.projection || readNavigatorDocumentFacts({
    document,
    pages: extraction.pages,
    pageCount: extraction.page_count,
  });
  const cacheHit = Boolean(cached);
  if (cacheHit) state.fact_cache_hits += 1;
  else state.fact_projection_runs += 1;
  const storedBytes = cached?.stored_bytes ?? Buffer.byteLength(JSON.stringify(projection));
  if (!cached) state.fact_projections.set(cacheKey, Object.freeze({ cache_key: cacheKey, projection, stored_bytes: storedBytes }));
  const latencyMs = Math.max(0, nowMilliseconds() - started);
  const receipt = Object.freeze({
    rules_version: NAVIGATOR_DOCUMENT_FACTS_VERSION,
    ontology_version: NAVIGATOR_DOCUMENT_FACTS_ONTOLOGY_VERSION,
    cache_key: cacheKey,
    cache_hit: cacheHit,
    latency_ms: latencyMs,
    stored_bytes: cacheHit ? 0 : storedBytes,
    projection_bytes: storedBytes,
    model_calls: 0,
    ocr_pages_selected: 0,
    section_count: projection.sections.length,
    event_count: projection.events.length,
    fact_count: projection.facts.length,
    abstention_count: projection.abstentions.length,
    per_role: roleMetrics(projection),
  });
  return Object.freeze({ projection, receipt });
}

/** Aggregate stable coverage and cost measurements for a manifest/build receipt. */
export function summarizeNavigatorDocumentFacts(rows = []) {
  const receipts = rows.map((row) => row.reading_receipt).filter(Boolean);
  const roles = new Map();
  for (const receipt of receipts) {
    for (const role of receipt.per_role || []) {
      const current = roles.get(role.role) || { role: role.role, fact_count: 0, required_count: 0, abstention_count: 0, denominator: 0 };
      for (const field of ["fact_count", "required_count", "abstention_count", "denominator"]) current[field] += role[field];
      roles.set(role.role, current);
    }
  }
  return Object.freeze({
    documents: rows.length,
    pages: rows.reduce((sum, row) => sum + (row.page_count || 0), 0),
    sectioned_pages: rows.reduce((sum, row) => (
      sum + (row.sections?.length && row.unsectioned_pages?.length === 0 ? (row.page_count || 0) : 0)
    ), 0),
    sections: rows.reduce((sum, row) => sum + (row.sections?.length || 0), 0),
    events: rows.reduce((sum, row) => sum + (row.events?.length || 0), 0),
    facts: rows.reduce((sum, row) => sum + (row.facts?.length || 0), 0),
    abstentions: rows.reduce((sum, row) => sum + (row.abstentions?.length || 0), 0),
    model_calls: receipts.reduce((sum, receipt) => sum + receipt.model_calls, 0),
    ocr_pages_selected: receipts.reduce((sum, receipt) => sum + receipt.ocr_pages_selected, 0),
    latency_ms: receipts.reduce((sum, receipt) => sum + receipt.latency_ms, 0),
    stored_bytes: receipts.reduce((sum, receipt) => sum + receipt.stored_bytes, 0),
    cache_hits: receipts.filter((receipt) => receipt.cache_hit).length,
    cache_misses: receipts.filter((receipt) => !receipt.cache_hit).length,
    per_role: Object.freeze([...roles.values()].sort((left, right) => left.role.localeCompare(right.role)).map(Object.freeze)),
  });
}
