/**
 * Source-qualified handoff for NYC Rules rulemaking petitions.
 *
 * This is an action-only workflow: CityScroll links to the official form and
 * guidance but never submits a petition or records a resident's submission.
 * Agency names are publishable only when an explicit resolved identity is
 * supplied by the caller.
 */

export const RULEMAKING_PETITION_SCHEMA = "cityscroll.rulemaking_petition.v1";

export const NYC_RULES_PETITION_SOURCES = Object.freeze({
  page_url: "https://rules.cityofnewyork.us/petition-an-agency/",
  guidance_url: "https://rules.cityofnewyork.us/wp-content/uploads/2026/02/Guidance-for-Submitting-Rulemaking-Petitions-.docx",
  form_url: "https://rules.cityofnewyork.us/wp-content/uploads/2025/06/NYC-Rules-Petition-an-Agency-Form.docx",
  contact_lookup_url: "https://airtable.com/appXXXZ3RgQ13zI7H/shrXW87ArrarG2nhR/tblgmZIiEbu1FgklJ",
  response_source_url: "https://rules.cityofnewyork.us/petition-an-agency/",
});

export const PETITION_RESPONSE_DAYS = 60;

const sourceRecord = (role, url) => Object.freeze({
  role,
  url,
  source_url: url,
  source_system: "nyc_rules",
  basis: "source_stated",
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
 * Build the stable petition workflow envelope. The contact is intentionally
 * optional: an unresolved contact is a first-class lookup fallback.
 */
export function buildPetitionHandoff({
  agency_resolution = null,
  contact = null,
  target = "adopt_amend_repeal",
} = {}) {
  const resolved = agencyResolution(agency_resolution);
  const resolvedContact = explicitContact(contact);
  const source = NYC_RULES_PETITION_SOURCES;
  return Object.freeze({
    schema: RULEMAKING_PETITION_SCHEMA,
    state: resolved ? "ready" : "agency_unknown",
    procedure: "rulemaking_petition",
    target: ["adopt", "amend", "repeal", "amend_repeal", "adopt_amend_repeal"].includes(target) ? target : "adopt_amend_repeal",
    agency: resolved
      ? Object.freeze({
        ref: `agency:id:${resolved.canonical_id}`,
        id: resolved.canonical_id,
        name: resolved.canonical_name,
        resolution: resolved,
      })
      : null,
    official: Object.freeze({
      page_url: source.page_url,
      guidance_url: source.guidance_url,
      form_url: source.form_url,
      contact_lookup_url: source.contact_lookup_url,
      response_source_url: source.response_source_url,
      indexed_sources: Object.freeze([
        sourceRecord("petition_procedure", source.page_url),
        sourceRecord("petition_guidance", source.guidance_url),
        sourceRecord("petition_form", source.form_url),
        sourceRecord("agency_contact_lookup", source.contact_lookup_url),
      ]),
    }),
    purpose: Object.freeze([
      "Propose a new rule",
      "Amend an existing rule",
      "Repeal an existing rule",
    ]),
    response: Object.freeze({
      days: PETITION_RESPONSE_DAYS,
      basis: "source_stated",
      source_url: source.response_source_url,
      statement: "The agency must reply within 60 days.",
    }),
    procedure_source: sourceRecord("petition_procedure", source.page_url),
    outcomes_source: sourceRecord("petition_outcomes", source.page_url),
    outcomes: Object.freeze([
      Object.freeze({ id: "decline", label: "The agency declines and gives its reason." }),
      Object.freeze({ id: "proceed", label: "The agency proceeds and initiates CAPA rulemaking." }),
    ]),
    contact: resolvedContact,
    contact_state: resolvedContact ? "resolved" : "lookup_fallback",
    coverage: Object.freeze({
      procedure_mode: "rulemaking_petition",
      agency_entry_point: resolved ? "available" : "unknown",
      effective_rule_entry_point: resolved ? "available" : "unknown",
      official_form: "available",
      official_guidance: "available",
      response_requirement: "source_backed",
      official_contact: resolvedContact ? "resolved" : "lookup_fallback",
      outcomes: "source_backed",
    }),
    submission: Object.freeze({ cityscroll_submits: false, tracks_submission: false }),
  });
}

export function renderPetitionHandoff(handoff, { mode = "agency" } = {}) {
  if (!handoff || handoff.schema !== RULEMAKING_PETITION_SCHEMA) return "";
  const agencyName = handoff.agency?.name || "this agency";
  const heading = mode === "rule" ? `How to petition ${agencyName}` : "Petition this agency";
  const identityCopy = handoff.agency
    ? `CityScroll identified ${esc(agencyName)} from an explicit CityScroll–NYC Rules agency resolution.`
    : "CityScroll could not resolve the responsible agency from an explicit NYC Rules agency record.";
  const contact = handoff.contact
    ? `<p class="rule-petition-contact"><strong>Official contact:</strong> ${handoff.contact.email ? `<a href="mailto:${esc(clean(handoff.contact.email, 240))}">${esc(clean(handoff.contact.email, 240))}</a>` : ""}${handoff.contact.email && handoff.contact.address ? " · " : ""}${handoff.contact.address ? esc(clean(handoff.contact.address, 500)) : ""} <a href="${esc(handoff.contact.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></p>`
    : `<p class="rule-petition-contact">An official submission contact is not resolved here. <a href="${esc(handoff.official.contact_lookup_url)}" target="_blank" rel="noopener noreferrer">Use the City's official agency-contact lookup</a>.</p>`;
  return `<section id="${mode === "rule" ? "rulemaking-petition" : "agency-petition"}" class="rule-petition-handoff" data-petition-schema="${esc(handoff.schema)}" data-petition-state="${esc(handoff.state)}" data-contact-state="${esc(handoff.contact_state)}">
    <h2>${esc(heading)}</h2>
    <p>Petitioning asks an agency to begin rulemaking. It is different from commenting on an already-proposed rule.</p>
    <p>${identityCopy}</p>
    <ol class="rule-petition-steps">
      <li>Describe the rule you want adopted, amended, or repealed. <a href="${esc(handoff.official.form_url)}" target="_blank" rel="noopener noreferrer">Open the official petition form</a>.</li>
      <li>Send the completed form to the responsible agency. <a href="${esc(handoff.official.guidance_url)}" target="_blank" rel="noopener noreferrer">Read the official guidance</a>.</li>
      <li>Expect a response within 60 days. <a href="${esc(handoff.response.source_url)}" target="_blank" rel="noopener noreferrer">See the authoritative NYC Rules requirement</a>.</li>
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
    <p class="rule-petition-outcomes"><strong>What may happen:</strong> the agency declines and gives its reason, or proceeds and initiates CAPA rulemaking.</p>
    <p class="muted">CityScroll does not submit or track petitions.</p>
  </section>`;
}

export { agencyResolution as normalizePetitionAgencyResolution, explicitContact as normalizePetitionContact };
