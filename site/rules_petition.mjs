/**
 * Source-qualified handoff for NYC Rules rulemaking petitions.
 *
 * This is an action-only workflow: CityScroll links to the official form and
 * guidance but never submits a petition or records a resident's submission.
 * Agency names are publishable only when an explicit resolved identity is
 * supplied by the caller. A missing official form or guidance page is not
 * proof that petitioning is unavailable.
 *
 * An exact petition target additionally needs applicable institution-procedure
 * evidence: a reviewed, source-backed petition procedure published for that
 * same institution. Identity resolution plus the City's generic petition form
 * establishes only general official guidance, which stays useful and clearly
 * general. Absence of procedure evidence is missing evidence, never a finding
 * that petitioning the institution is legally forbidden, and one institution's
 * procedure never grounds a target on another.
 */

export const RULEMAKING_PETITION_SCHEMA = "cityscroll.rulemaking_petition.v1";
export const RULEMAKING_PETITION_COVERAGE_SCHEMA = "cityscroll.rulemaking_petition_coverage.v1";
export const INSTITUTION_PETITION_PROCEDURE_SCHEMA = "cityscroll.institution_petition_procedures.v1";

export const PETITION_PROCEDURE_BASES = Object.freeze([
  "institution_procedure",
  "general_official_guidance",
  "unknown",
]);

export const PETITION_ACTION_TARGETS = Object.freeze([
  "exact_petition_target",
  "action_only_guidance",
  "target_unknown",
  "no_supported_workflow",
]);

export const NYC_RULES_PETITION_SOURCES = Object.freeze({
  page_url: "https://rules.cityofnewyork.us/petition-an-agency/",
  guidance_url: "https://rules.cityofnewyork.us/wp-content/uploads/2026/02/Guidance-for-Submitting-Rulemaking-Petitions-.docx",
  form_url: "https://rules.cityofnewyork.us/wp-content/uploads/2025/06/NYC-Rules-Petition-an-Agency-Form.docx",
  contact_lookup_url: "https://airtable.com/appXXXZ3RgQ13zI7H/shrXW87ArrarG2nhR/tblgmZIiEbu1FgklJ",
  response_source_url: "https://rules.cityofnewyork.us/petition-an-agency/",
});

export const PETITION_RESPONSE_DAYS = 60;

const DEFAULT_SOURCE_ROLES = Object.freeze({
  page_url: "petition_procedure",
  guidance_url: "petition_guidance",
  form_url: "petition_form",
  contact_lookup_url: "agency_contact_lookup",
  response_source_url: "petition_response_expectation",
  institution_procedure_url: "institution_petition_procedure",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function officialUrl(value, allowed = ["rules.cityofnewyork.us", "airtable.com"]) {
  const href = clean(value, 2_000);
  if (!/^https:\/\//i.test(href)) return null;
  try {
    const parsed = new URL(href);
    return allowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function sourceVintageFromUrl(url) {
  const href = clean(url, 2_000);
  const match = href.match(/\/uploads\/(\d{4})\/(\d{2})\//);
  return match ? `${match[1]}-${match[2]}` : null;
}

function sourceRecord(role, url) {
  const href = officialUrl(url) || null;
  return Object.freeze({
    role,
    url: href,
    source_url: href,
    source_system: "nyc_rules",
    basis: href ? "source_stated" : "unknown",
    source_vintage: sourceVintageFromUrl(href),
  });
}

function mergeOfficialSources(overrides) {
  const extra = overrides && typeof overrides === "object" ? overrides : {};
  return Object.freeze({
    page_url: extra.page_url === undefined ? NYC_RULES_PETITION_SOURCES.page_url : officialUrl(extra.page_url, ["rules.cityofnewyork.us"]),
    guidance_url: extra.guidance_url === undefined ? NYC_RULES_PETITION_SOURCES.guidance_url : officialUrl(extra.guidance_url, ["rules.cityofnewyork.us"]),
    form_url: extra.form_url === undefined ? NYC_RULES_PETITION_SOURCES.form_url : officialUrl(extra.form_url, ["rules.cityofnewyork.us"]),
    contact_lookup_url: extra.contact_lookup_url === undefined
      ? NYC_RULES_PETITION_SOURCES.contact_lookup_url
      : officialUrl(extra.contact_lookup_url),
    response_source_url: extra.response_source_url === undefined
      ? NYC_RULES_PETITION_SOURCES.response_source_url
      : officialUrl(extra.response_source_url, ["rules.cityofnewyork.us"]),
  });
}

function agencyResolution(input) {
  const value = input && typeof input === "object" ? input : null;
  const canonicalId = clean(value?.canonical_id || value?.agency_id, 120).replace(/^agency:id:/, "");
  const canonicalName = clean(value?.canonical_name || value?.agency_name || value?.name, 240);
  const sourceUrl = officialUrl(value?.source_url || value?.url, ["rules.cityofnewyork.us"]);
  const sourceSystem = clean(value?.source_system || value?.source, 80).toLowerCase();
  if (!value?.matched || !canonicalId || !canonicalName || sourceSystem !== "nyc_rules" || !sourceUrl) return null;
  return Object.freeze({
    matched: true,
    canonical_id: canonicalId,
    canonical_name: canonicalName,
    source_system: "nyc_rules",
    source_url: sourceUrl,
    basis: clean(value.basis, 160) || "explicit_cityscroll_nyc_rules_agency_resolution",
  });
}

function explicitContact(input) {
  const value = input && typeof input === "object" ? input : null;
  const sourceUrl = officialUrl(value?.source_url || value?.url);
  if (!value || !sourceUrl) return null;
  const email = clean(value.email, 240);
  const address = clean(value.address || value.mailing_address, 500);
  if (!email && !address) return null;
  return Object.freeze({
    email: email || null,
    address: address || null,
    source_url: sourceUrl,
    source_system: clean(value.source_system || value.source, 80) || "nyc_rules",
  });
}

/**
 * Normalize reviewed institution-procedure evidence.
 *
 * The evidence is applicable only when it names the *same* institution the
 * caller already resolved, states that it covers rulemaking petitions, names a
 * receiving body, and cites a published NYC Rules procedure. Anything short of
 * that returns null, which downgrades the surface to general official guidance
 * rather than asserting that petitioning is unavailable.
 */
function procedureEvidence(input, resolved) {
  const value = input && typeof input === "object" ? input : null;
  if (!value || !resolved) return null;
  if (clean(value.applies_to, 80) !== "rulemaking_petition") return null;
  const agencyId = clean(value.agency_id || value.canonical_id, 120).replace(/^agency:id:/, "");
  // Authority is never transferred between institutions: one body's published
  // procedure cannot ground an exact target on another body's profile.
  if (!agencyId || agencyId !== resolved.canonical_id) return null;
  const procedureUrl = officialUrl(value.procedure_url, ["rules.cityofnewyork.us"]);
  const receivingBody = clean(value.receiving_body, 240);
  if (!procedureUrl || !receivingBody) return null;
  const responseSourceUrl = officialUrl(value.response_source_url, ["rules.cityofnewyork.us"]) || procedureUrl;
  const responseDays = Number.isInteger(value.response_days) && value.response_days > 0 && value.response_days <= 3_650
    ? value.response_days
    : null;
  const responseStatement = clean(value.response_statement, 500);
  return Object.freeze({
    role: DEFAULT_SOURCE_ROLES.institution_procedure_url,
    agency_id: agencyId,
    applies_to: "rulemaking_petition",
    receiving_body: receivingBody,
    procedure_title: clean(value.procedure_title, 240) || null,
    procedure_url: procedureUrl,
    procedure_text_url: officialUrl(value.procedure_text_url, ["rules.cityofnewyork.us"]),
    destination_statement: clean(value.destination_statement, 500) || null,
    response_source_url: responseSourceUrl,
    response_days: responseDays,
    response_statement: responseDays && responseStatement ? responseStatement : null,
    legal_basis: clean(value.legal_basis, 240) || null,
    rule_status: clean(value.rule_status, 80) || null,
    effective_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(value.effective_date, 10)) ? clean(value.effective_date, 10) : null,
    source_system: "nyc_rules",
    basis: clean(value.basis, 160) || "published_agency_rule",
    source_vintage: clean(value.source_vintage, 20) || sourceVintageFromUrl(value.procedure_text_url) || null,
  });
}

function petitionSupported({ entry_point, lifecycle_state }) {
  if (entry_point === "agency") return true;
  if (lifecycle_state === "effective") return true;
  if (entry_point == null && lifecycle_state == null) return true;
  return false;
}

/**
 * An exact target needs three things at once: a resolved institution identity,
 * applicable procedure evidence for that same institution, and a reachable
 * official destination. A resolved identity plus the City's generic form is
 * general guidance, not an exact target.
 */
export function classifyPetitionActionTarget({
  agency = null,
  procedure_evidence = null,
  form_url = null,
  guidance_url = null,
  entry_point = null,
  lifecycle_state = null,
} = {}) {
  if (!petitionSupported({ entry_point, lifecycle_state })) return "no_supported_workflow";
  const procedureUrl = procedure_evidence?.procedure_url || null;
  if (agency && procedure_evidence && (procedureUrl || form_url)) return "exact_petition_target";
  if (form_url || guidance_url || procedureUrl) return "action_only_guidance";
  return "target_unknown";
}

/**
 * Build the stable petition workflow envelope. The contact is intentionally
 * optional: an unresolved contact is a first-class lookup fallback.
 * Generic rulemaking or emergency clocks never fill the 60-day expectation.
 */
export function buildPetitionHandoff({
  agency_resolution = null,
  procedure_evidence: procedure_evidence_input = null,
  contact = null,
  target = "adopt_amend_repeal",
  entry_point = null,
  lifecycle_state = null,
  sources = null,
  rulemaking_clock_days = null,
  generic_clock_days = null,
  emergency_clock_days = null,
} = {}) {
  void rulemaking_clock_days;
  void generic_clock_days;
  void emergency_clock_days;
  const resolved = agencyResolution(agency_resolution);
  const procedure = procedureEvidence(procedure_evidence_input, resolved);
  const resolvedContact = explicitContact(contact);
  const source = mergeOfficialSources(sources);
  const indexed = [
    procedure ? sourceRecord(DEFAULT_SOURCE_ROLES.institution_procedure_url, procedure.procedure_url) : null,
    source.page_url ? sourceRecord(DEFAULT_SOURCE_ROLES.page_url, source.page_url) : null,
    source.guidance_url ? sourceRecord(DEFAULT_SOURCE_ROLES.guidance_url, source.guidance_url) : null,
    source.form_url ? sourceRecord(DEFAULT_SOURCE_ROLES.form_url, source.form_url) : null,
    source.contact_lookup_url ? sourceRecord(DEFAULT_SOURCE_ROLES.contact_lookup_url, source.contact_lookup_url) : null,
  ].filter(Boolean);
  // A grounded institution procedure states its own response requirement, so
  // the reader's response explanation cites that same procedure rather than the
  // City-wide page.
  const procedureResponse = procedure?.response_days ? procedure : null;
  const responseBacked = Boolean(procedureResponse || source.response_source_url || source.page_url);
  const responseUrl = procedureResponse
    ? procedureResponse.response_source_url
    : (source.response_source_url || source.page_url || null);
  const actionTarget = classifyPetitionActionTarget({
    agency: resolved,
    procedure_evidence: procedure,
    form_url: source.form_url,
    guidance_url: source.guidance_url,
    entry_point,
    lifecycle_state,
  });
  const procedureBasis = procedure
    ? "institution_procedure"
    : (source.form_url || source.guidance_url || source.page_url ? "general_official_guidance" : "unknown");
  const agencyEntry = entry_point === "agency"
    ? (resolved ? "available" : "unknown")
    : (entry_point === "effective_rule" ? "not_this_surface" : (resolved ? "available" : "unknown"));
  const ruleEntry = entry_point === "effective_rule"
    ? (lifecycle_state && lifecycle_state !== "effective"
      ? "no_supported_workflow"
      : (resolved ? "available" : "unknown"))
    : (entry_point === "agency" ? "not_this_surface" : (resolved ? "available" : "unknown"));
  return Object.freeze({
    schema: RULEMAKING_PETITION_SCHEMA,
    state: resolved ? "ready" : "agency_unknown",
    procedure: "rulemaking_petition",
    procedure_mode: "rulemaking_petition",
    entry_point: entry_point || null,
    lifecycle_state: lifecycle_state || null,
    action_target: actionTarget,
    target: ["adopt", "amend", "repeal", "amend_repeal", "adopt_amend_repeal"].includes(target) ? target : "adopt_amend_repeal",
    agency: resolved
      ? Object.freeze({
        ref: `agency:id:${resolved.canonical_id}`,
        id: resolved.canonical_id,
        name: resolved.canonical_name,
        resolution: resolved,
      })
      : null,
    procedure_basis: procedureBasis,
    institution_procedure: procedure,
    official: Object.freeze({
      institution_procedure_url: procedure?.procedure_url || null,
      receiving_body: procedure?.receiving_body || null,
      page_url: source.page_url,
      guidance_url: source.guidance_url,
      form_url: source.form_url,
      contact_lookup_url: source.contact_lookup_url,
      response_source_url: responseUrl,
      indexed_sources: Object.freeze(indexed),
      workflow_availability: Object.freeze({
        procedure_mode: "rulemaking_petition",
        form: source.form_url ? "available" : "missing",
        guidance: source.guidance_url ? "available" : "missing",
        procedure_page: source.page_url ? "available" : "missing",
        form_vintage: sourceVintageFromUrl(source.form_url),
        guidance_vintage: sourceVintageFromUrl(source.guidance_url),
        procedure_page_vintage: sourceVintageFromUrl(source.page_url),
        institution_procedure: procedure ? "applicable" : "absent",
        institution_procedure_vintage: procedure?.source_vintage || null,
      }),
    }),
    purpose: Object.freeze([
      "Propose a new rule",
      "Amend an existing rule",
      "Repeal an existing rule",
    ]),
    response: responseBacked
      ? Object.freeze({
        days: procedureResponse ? procedureResponse.response_days : PETITION_RESPONSE_DAYS,
        basis: "source_stated",
        source_url: responseUrl,
        scope: procedureResponse ? "institution_procedure" : "general_official_guidance",
        statement: procedureResponse
          ? (procedureResponse.response_statement
            || `The agency must reply within ${procedureResponse.response_days} days.`)
          : "The agency must reply within 60 days.",
      })
      : Object.freeze({
        days: null,
        basis: "unknown",
        source_url: null,
        scope: "unknown",
        statement: null,
      }),
    procedure_source: procedure
      ? sourceRecord("petition_procedure", procedure.procedure_url)
      : source.page_url
        ? sourceRecord("petition_procedure", source.page_url)
        : Object.freeze({ role: "petition_procedure", url: null, source_url: null, source_system: "nyc_rules", basis: "unknown", source_vintage: null }),
    outcomes_source: source.page_url
      ? sourceRecord("petition_outcomes", source.page_url)
      : Object.freeze({ role: "petition_outcomes", url: null, source_url: null, source_system: "nyc_rules", basis: "unknown", source_vintage: null }),
    outcomes: source.page_url
      ? Object.freeze([
        Object.freeze({ id: "decline", label: "The agency declines and gives its reason." }),
        Object.freeze({ id: "proceed", label: "The agency proceeds and initiates CAPA rulemaking." }),
      ])
      : Object.freeze([]),
    contact: resolvedContact,
    contact_state: resolvedContact ? "resolved" : (source.contact_lookup_url ? "lookup_fallback" : "unresolved"),
    coverage: Object.freeze({
      procedure_mode: "rulemaking_petition",
      action_target: actionTarget,
      procedure_basis: procedureBasis,
      institution_procedure_evidence: procedure ? "applicable" : "absent",
      // Absent evidence is an unproven target, never a legal prohibition.
      missing_procedure_evidence_is_not_prohibition: true,
      agency_entry_point: agencyEntry,
      effective_rule_entry_point: ruleEntry,
      official_form: source.form_url ? "available" : "missing",
      official_guidance: source.guidance_url ? "available" : "missing",
      response_requirement: responseBacked ? "source_backed" : "unknown",
      official_contact: resolvedContact ? "resolved" : (source.contact_lookup_url ? "lookup_fallback" : "unresolved"),
      outcomes: source.page_url ? "source_backed" : "unknown",
      workflow_missing_is_not_unavailable: true,
      unsupported_dates: "unknown",
    }),
    submission: Object.freeze({ cityscroll_submits: false, tracks_submission: false }),
  });
}

function officialLink(href, label) {
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    : esc(label);
}

export function renderPetitionHandoff(handoff, { mode = "agency" } = {}) {
  if (!handoff || handoff.schema !== RULEMAKING_PETITION_SCHEMA) return "";
  if (handoff.action_target === "no_supported_workflow") return "";
  const procedure = handoff.institution_procedure || null;
  const exact = handoff.action_target === "exact_petition_target" && Boolean(procedure);
  const agencyName = handoff.agency?.name || "this agency";
  // Only a grounded institution procedure earns a heading that names an exact
  // destination. Everything else is the City's general petition guidance.
  const heading = exact
    ? (mode === "rule" ? `How to petition ${agencyName}` : "Petition this agency")
    : (mode === "rule" ? "How to petition an agency about this rule" : "How to petition a city agency");
  const identityCopy = handoff.agency
    ? `CityScroll identified ${esc(agencyName)} from an explicit CityScroll\u2013NYC Rules agency resolution.`
    : "CityScroll could not resolve the responsible agency from an explicit NYC Rules agency record.";
  const scopeCopy = exact
    ? `<p class="rule-petition-scope">${esc(agencyName)} publishes its own rulemaking-petition procedure, so the destination and response below come from that procedure.</p>`
    : `<p class="rule-petition-scope">This is the City's general rulemaking-petition guidance. CityScroll has not indexed a published petition procedure for ${esc(handoff.agency ? agencyName : "this body")}, so it does not name an exact destination here. That is missing evidence, not a finding that you cannot petition this body.</p>`;
  const receivingBody = exact
    ? `<p class="rule-petition-receiving-body"><strong>Where this petition goes:</strong> ${esc(procedure.receiving_body)}.${procedure.destination_statement ? ` ${esc(procedure.destination_statement)}` : ""} ${officialLink(procedure.procedure_url, `Read the published petition procedure${procedure.procedure_title ? ` \u2014 ${procedure.procedure_title}` : ""}`)}.${procedure.legal_basis ? ` <span class="muted">${esc(procedure.legal_basis)}</span>` : ""}</p>`
    : "";
  const contact = handoff.contact
    ? `<p class="rule-petition-contact"><strong>Official contact:</strong> ${handoff.contact.email ? `<a href="mailto:${esc(clean(handoff.contact.email, 240))}">${esc(clean(handoff.contact.email, 240))}</a>` : ""}${handoff.contact.email && handoff.contact.address ? " \u00b7 " : ""}${handoff.contact.address ? esc(clean(handoff.contact.address, 500)) : ""} <a href="${esc(handoff.contact.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></p>`
    : (handoff.official.contact_lookup_url
      ? `<p class="rule-petition-contact">An official submission contact is not resolved here.${exact ? " The published procedure above still tells you where to send the petition." : ""} <a href="${esc(handoff.official.contact_lookup_url)}" target="_blank" rel="noopener noreferrer">Use the City's official agency-contact lookup</a>.</p>`
      : `<p class="rule-petition-contact">An official submission contact is not resolved here, and the City's agency-contact lookup is not indexed.${exact ? " The published procedure above still tells you where to send the petition." : ""}</p>`);
  const formStep = handoff.official.form_url
    ? `Describe the rule you want adopted, amended, or repealed. ${officialLink(handoff.official.form_url, "Open the official petition form")}.`
    : "Describe the rule you want adopted, amended, or repealed. The official petition form is not indexed here.";
  const guidanceStep = exact
    ? `Send the completed petition to ${esc(procedure.receiving_body)}, following the agency's published procedure. ${officialLink(procedure.procedure_text_url || procedure.procedure_url, "Read the adopted rule text")}.`
    : (handoff.official.guidance_url
      ? `Send the completed form to the responsible agency. ${officialLink(handoff.official.guidance_url, "Read the official guidance")}.`
      : "Send the completed form to the responsible agency. Official guidance is not indexed here.");
  const responseStep = handoff.response.basis === "source_stated"
    ? `${esc(handoff.response.statement)} ${officialLink(handoff.response.source_url, handoff.response.scope === "institution_procedure"
      ? "See the agency's published response requirement"
      : "See the authoritative NYC Rules requirement")}.`
    : "The agency's response deadline is not stated in the indexed official sources.";
  const outcomes = handoff.outcomes.length
    ? `<p class="rule-petition-outcomes"><strong>What may happen:</strong> the agency declines and gives its reason, or proceeds and initiates CAPA rulemaking.</p>`
    : `<p class="rule-petition-outcomes">Supported agency outcomes are not stated in the indexed official sources.</p>`;
  return `<section id="${mode === "rule" ? "rulemaking-petition" : "agency-petition"}" class="rule-petition-handoff" data-petition-schema="${esc(handoff.schema)}" data-petition-state="${esc(handoff.state)}" data-contact-state="${esc(handoff.contact_state)}" data-action-target="${esc(handoff.action_target)}" data-procedure-basis="${esc(handoff.procedure_basis)}" data-response-basis="${esc(handoff.response.basis)}">
    <h2>${esc(heading)}</h2>
    <p>Petitioning asks an agency to begin rulemaking. It is different from commenting on an already-proposed rule, and different again from speaking at a public hearing on one.</p>
    <p>${identityCopy}</p>
    ${scopeCopy}
    ${receivingBody}
    <ol class="rule-petition-steps">
      <li>${formStep}</li>
      <li>${guidanceStep}</li>
      <li>${responseStep}</li>
    </ol>
    <details class="rule-petition-scaffold">
      <summary>Drafting prompts</summary>
      <p>Use these prompts to prepare your own petition before opening the official form:</p>
      <ul>
        <li>What rule should the agency adopt, amend, or repeal?</li>
        <li>What problem would the requested change address?</li>
        <li>What change are you requesting, and what evidence supports it?</li>
      </ul>
      <p class="muted">CityScroll does not save, submit, or track a petition draft.</p>
    </details>
    ${contact}
    ${outcomes}
    <p class="muted">CityScroll does not submit or track petitions.</p>
  </section>`;
}

function bump(bag, key) {
  bag[key] = (bag[key] || 0) + 1;
}

export function measurePetitionCoverage(cases = []) {
  const action_targets = Object.fromEntries(PETITION_ACTION_TARGETS.map((id) => [id, 0]));
  const response_expectation = { source_backed: 0, unknown: 0 };
  const procedure_basis = Object.fromEntries(PETITION_PROCEDURE_BASES.map((id) => [id, 0]));
  const institution_procedure_evidence = { applicable: 0, absent: 0 };
  const contacts = { resolved: 0, unresolved: 0, lookup_fallback: 0 };
  const petition_contract = {
    agency_entry_points: 0,
    effective_rule_entry_points: 0,
    official_form: 0,
    official_guidance: 0,
    explicit_contacts: 0,
    two_outcome_explanations: 0,
  };
  const workflow = {
    rulemaking_petition: {
      form_available: 0,
      form_missing: 0,
      guidance_available: 0,
      guidance_missing: 0,
      procedure_page_available: 0,
      procedure_page_missing: 0,
      form_vintages: [],
      guidance_vintages: [],
      procedure_page_vintages: [],
    },
  };
  const auto_submission = { cityscroll_submits: 0, tracks_submission: 0 };
  for (const item of Array.isArray(cases) ? cases : []) {
    const handoff = item?.handoff || item;
    if (!handoff || handoff.schema !== RULEMAKING_PETITION_SCHEMA) continue;
    bump(action_targets, handoff.action_target);
    bump(procedure_basis, PETITION_PROCEDURE_BASES.includes(handoff.procedure_basis) ? handoff.procedure_basis : "unknown");
    bump(institution_procedure_evidence, handoff.institution_procedure ? "applicable" : "absent");
    bump(response_expectation, handoff.response?.basis === "source_stated" ? "source_backed" : "unknown");
    bump(contacts, handoff.contact_state === "resolved"
      ? "resolved"
      : (handoff.contact_state === "lookup_fallback" ? "lookup_fallback" : "unresolved"));
    if (handoff.coverage?.agency_entry_point === "available") petition_contract.agency_entry_points += 1;
    if (handoff.coverage?.effective_rule_entry_point === "available") petition_contract.effective_rule_entry_points += 1;
    if (handoff.official?.form_url) petition_contract.official_form += 1;
    if (handoff.official?.guidance_url) petition_contract.official_guidance += 1;
    if (handoff.contact) petition_contract.explicit_contacts += 1;
    if (handoff.outcomes?.length === 2) petition_contract.two_outcome_explanations += 1;
    const availability = handoff.official?.workflow_availability || {};
    const mode = workflow.rulemaking_petition;
    if (availability.form === "available") mode.form_available += 1;
    else mode.form_missing += 1;
    if (availability.guidance === "available") mode.guidance_available += 1;
    else mode.guidance_missing += 1;
    if (availability.procedure_page === "available") mode.procedure_page_available += 1;
    else mode.procedure_page_missing += 1;
    if (availability.form_vintage) mode.form_vintages.push(availability.form_vintage);
    if (availability.guidance_vintage) mode.guidance_vintages.push(availability.guidance_vintage);
    if (availability.procedure_page_vintage) mode.procedure_page_vintages.push(availability.procedure_page_vintage);
    if (handoff.submission?.cityscroll_submits) auto_submission.cityscroll_submits += 1;
    if (handoff.submission?.tracks_submission) auto_submission.tracks_submission += 1;
  }
  const unique = (values) => [...new Set(values)].sort();
  return Object.freeze({
    schema: RULEMAKING_PETITION_COVERAGE_SCHEMA,
    action_targets: Object.freeze({ ...action_targets }),
    procedure_basis: Object.freeze({ ...procedure_basis }),
    institution_procedure_evidence: Object.freeze({
      ...institution_procedure_evidence,
      missing_procedure_evidence_is_not_prohibition: true,
    }),
    response_expectation: Object.freeze({ ...response_expectation }),
    contacts: Object.freeze({ ...contacts }),
    petition_contract: Object.freeze({ ...petition_contract }),
    workflow_by_procedure_mode: Object.freeze({
      rulemaking_petition: Object.freeze({
        form_available: workflow.rulemaking_petition.form_available,
        form_missing: workflow.rulemaking_petition.form_missing,
        guidance_available: workflow.rulemaking_petition.guidance_available,
        guidance_missing: workflow.rulemaking_petition.guidance_missing,
        procedure_page_available: workflow.rulemaking_petition.procedure_page_available,
        procedure_page_missing: workflow.rulemaking_petition.procedure_page_missing,
        form_vintages: unique(workflow.rulemaking_petition.form_vintages),
        guidance_vintages: unique(workflow.rulemaking_petition.guidance_vintages),
        procedure_page_vintages: unique(workflow.rulemaking_petition.procedure_page_vintages),
        missing_workflow_is_not_unavailable: true,
      }),
    }),
    auto_submission: Object.freeze({ ...auto_submission }),
    case_count: Array.isArray(cases) ? cases.length : 0,
  });
}

export {
  agencyResolution as normalizePetitionAgencyResolution,
  explicitContact as normalizePetitionContact,
  procedureEvidence as normalizeInstitutionPetitionProcedure,
};
