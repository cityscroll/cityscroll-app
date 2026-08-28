/*
 * Regulatory-agenda source bridge and resident projection.
 *
 * An agenda is a publisher forecast, not a rulemaking proceeding.  This
 * module deliberately keeps the two identities separate: agenda items have
 * their own source-qualified ids and the only agenda -> rulemaking links
 * emitted here are explicitly supported by retained evidence.
 */

export const REGULATORY_AGENDA_SCHEMA = "cityscroll.regulatory_agenda.v1";
export const REGULATORY_AGENDA_ITEM_SCHEMA = "cityscroll.regulatory_agenda_item.v1";
export const REGULATORY_AGENDA_INDEX_URL = "https://rules.cityofnewyork.us/view-agency-regulatory-agendas/";
export const REGULATORY_AGENDA_FIELDS = Object.freeze([
  "subject",
  "justification",
  "anticipated_content",
  "objective",
  "legal_basis",
  "affected_groups",
  "approximate_schedule",
  "publisher_document",
  "publisher_page",
]);

const FIELD_ALIASES = Object.freeze({
  description: "description",
  reason: "justification",
  reasons: "justification",
  justification: "justification",
  "anticipated contents": "anticipated_content",
  "anticipated content": "anticipated_content",
  objective: "objective",
  objectives: "objective",
  "legal basis": "legal_basis",
  "other relevant laws": "relevant_laws",
  "types of individuals and entities likely to be affected": "affected_groups",
  "types of individuals and entities likely to be subject to the proposed rule": "affected_groups",
  "types of individuals and entities likely to be subject to the rule": "affected_groups",
  "approximate schedule": "approximate_schedule",
  "approximate schedule for adopting the proposed rule": "approximate_schedule",
});

const AGENCY_NAMES = Object.freeze({
  TLC: "Taxi and Limousine Commission",
  DFTA: "Aging",
  DOHMH: "Health and Mental Hygiene",
  DEP: "Environmental Protection",
  PPB: "Public Procurement Policy Board",
  LPC: "Landmarks Preservation Commission",
  SBS: "Small Business Services",
  DCWP: "Consumer and Worker Protection",
  OTI: "Information Technology and Telecommunications",
  DSNY: "Sanitation",
  DCP: "City Planning",
  CCHR: "Commission on Human Rights",
  DOB: "Buildings",
  DOT: "Transportation",
  DOF: "Finance",
  HPD: "Housing Preservation and Development",
  CFB: "Campaign Finance Board",
  COIB: "Conflicts of Interest Board",
  CCRB: "Civilian Complaint Review Board",
  BIC: "Business Integrity Commission",
  "OATH-ECB": "Administrative Trials and Hearings",
  MOEC: "Office of Media and Entertainment",
  FDNY: "Fire Department",
  OER: "Mayor's Office of Environmental Remediation",
  DPR: "Parks and Recreation",
  DORIS: "Records and Information Services",
  MOME: "Office of Media and Entertainment",
});

const clean = (value, max = 4_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function slug(value) {
  return clean(value, 160).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function fiscalYear(value, fallback = null) {
  const match = clean(value, 120).match(/\b(?:fy|fiscal\s+year)\s*['’]?(\d{2,4})\b/i)
    || clean(value, 120).match(/\b(20\d{2})\b/i);
  if (!match) return fallback;
  const year = Number(match[1].length === 2 ? `20${match[1]}` : match[1]);
  return year >= 2000 && year <= 2200 ? `FY${year}` : fallback;
}

function sourceUrl(value, base = REGULATORY_AGENDA_INDEX_URL) {
  try {
    const url = new URL(String(value || ""), base);
    return url.protocol === "https:" && url.hostname === "rules.cityofnewyork.us" ? url.href : null;
  } catch {
    return null;
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#8211;|&#x2013;/gi, "–")
    .replace(/&#8212;|&#x2014;/gi, "—")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, hex, dec) => String.fromCodePoint(Number.parseInt(hex || dec, hex ? 16 : 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function parsePublishDate(value) {
  const text = clean(value, 80);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function agencyLabel(value) {
  const raw = clean(value, 240);
  const code = raw.toUpperCase().replace(/\s+/g, "");
  return AGENCY_NAMES[code] || raw || null;
}

function itemId({ agency, fiscal_year, publisher_item_id }) {
  return `regulatory-agenda-item:${slug(agency)}:${slug(fiscal_year)}:${slug(publisher_item_id)}`;
}

export function agendaItemHref(id) {
  const value = clean(id, 500);
  return value ? `/rules/agenda/${encodeURIComponent(value)}/` : null;
}

function fieldState(value, { acquired = true, headingFound = true } = {}) {
  if (!acquired) return "not_yet_acquired";
  if (!headingFound) return "parse_failed";
  if (/^(?:none|not applicable|n\/a|not stated)$/i.test(clean(value))) return "source_not_published";
  if (!clean(value)) return "empty";
  return "published";
}

function availability(values, options = {}) {
  return Object.fromEntries(REGULATORY_AGENDA_FIELDS.map((field) => [
    field,
    fieldState(values[field], {
      acquired: field === "publisher_page"
        ? Number.isInteger(values[field])
        : options.acquired !== false,
      headingFound: field === "publisher_document"
        ? Boolean(values[field])
        : field === "publisher_page"
          ? Number.isInteger(values[field])
        : field === "subject"
          ? Boolean(values[field])
          : options.headings ? options.headings[field] === true : true,
    }),
  ]));
}

function normalizedLines(text) {
  return String(text || "")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^page \d+(?: of \d+)?$/i.test(line));
}

function heading(line) {
  const match = clean(line, 240).match(/^(?:[A-I]\s*[.)]\s*)?(.+?)\s*:\s*$/i);
  if (!match) return null;
  const label = match[1].replace(/^[A-I]\s*[.)]\s*/i, "").toLowerCase().replace(/\s+/g, " ").trim();
  return FIELD_ALIASES[label] || null;
}

function isFieldLine(line) {
  return Boolean(heading(line)) || /^\s*[A-I]\s*[.)]\s*(?:description|reason|reasons|objectives?|legal basis|other relevant laws|types of individuals|approximate schedule)/i.test(line);
}

function sectionValues(lines) {
  const values = {};
  const headings = {};
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s*([A-I])\s*[.)]\s*(.*)$/i);
    const label = match ? `${match[2]}` : line;
    const mapped = match ? FIELD_ALIASES[label.replace(/:.*$/, "").toLowerCase().replace(/\s+/g, " ").trim()] : heading(line);
    if (mapped) {
      current = mapped;
      headings[current] = true;
      const inline = match ? label.replace(/^.*?:\s*/, "") : "";
      values[current] = inline && !FIELD_ALIASES[label.toLowerCase().trim()]
        ? inline
        : (values[current] || "");
      continue;
    }
    if (current && !isFieldLine(line) && !/^agency contact\s*:/i.test(line)) {
      values[current] = `${values[current] || ""} ${line}`.trim();
    }
  }
  return { values, headings };
}

function subjectFromBlock(lines) {
  const subjectLine = lines.findIndex((line) => /^\s*(?:\d+\.\s*)?subject\s*:/i.test(line));
  if (subjectLine >= 0) {
    const first = lines[subjectLine].replace(/^\s*(?:\d+\.\s*)?subject\s*:\s*/i, "");
    const parts = [first];
    for (let i = subjectLine + 1; i < lines.length && parts.join(" ").length < 500; i += 1) {
      if (/^\s*[A-I]\s*[.)]\s*/i.test(lines[i])) break;
      parts.push(lines[i]);
    }
    return clean(parts.join(" "), 500);
  }
  return clean(lines.find((line) => /^\s*\d+\.\s+\S/.test(line))?.replace(/^\s*\d+\.\s*/, ""), 500);
}

/** Parse the current NYC Rules index's embedded agency_agendas JSON. */
export function parseRegulatoryAgendaIndex(html, { indexUrl = REGULATORY_AGENDA_INDEX_URL, retrievedAt = null } = {}) {
  const raw = String(html || "");
  const match = raw.match(/var\s+agency_agendas\s*=\s*(\[.*?\])\s*;/s);
  let rows = [];
  if (match) {
    try {
      rows = JSON.parse(match[1]);
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    const tableRows = [...raw.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    rows = tableRows.map((entry) => {
      const links = [...entry[1].matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)];
      const cells = [...entry[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(cell[1]));
      return links[0] ? { submitting_agency: cells[1], file_button: `<a href="${links[0][1]}">${cells[0] || "Regulatory Agenda"}</a>`, publish_date: cells[2] } : null;
    }).filter(Boolean);
  }
  const documents = rows.map((row, index) => {
    const rawButton = String(row.file_button || "");
    const href = sourceUrl(rawButton.match(/https:\/\/[^\s"']+\.pdf(?:\?[^\s"']*)?/i)?.[0] || row.url, indexUrl);
    const label = clean(decodeHtml(rawButton), 240) || `${row.submitting_agency || "Agency"} Regulatory Agenda`;
    const agency = agencyLabel(row.submitting_agency || label.match(/^([A-Z][A-Z-]+)\s*-/)?.[1]);
    const fy = fiscalYear(label) || fiscalYear(href) || "FYunknown";
    return {
      agency_code: clean(row.submitting_agency, 40) || null,
      agency,
      fiscal_year: fy,
      publisher_document: href,
      publisher_document_label: label || null,
      publish_date: parsePublishDate(row.publish_date),
      index_url: sourceUrl(indexUrl),
      retrieved_at: retrievedAt,
      publisher_item_id: `${clean(row.submitting_agency, 40) || slug(agency)}-${fy}-${index + 1}`,
      retrieval_status: href ? "available" : "not_yet_acquired",
    };
  }).filter((row) => row.agency || row.publisher_document);
  return {
    schema: "cityscroll.regulatory_agenda_index.v1",
    index_url: sourceUrl(indexUrl),
    retrieved_at: retrievedAt,
    documents,
    document_count: documents.length,
  };
}

/** Extract one source-qualified anticipated item from an agenda PDF's text. */
export function extractRegulatoryAgendaItems(text, document = {}) {
  const lines = normalizedLines(text);
  if (!lines.length) return [];
  const starts = [];
  lines.forEach((line, index) => {
    if (/^\s*(?:\d+\.\s*)?subject\s*:/i.test(line)) starts.push(index);
  });
  const chunks = starts.length
    ? starts.map((start, index) => lines.slice(start, starts[index + 1] || lines.length))
    : [];
  return chunks.map((chunk, index) => {
    const subject = subjectFromBlock(chunk);
    const parsed = sectionValues(chunk);
    const values = {
      subject,
      justification: parsed.values.justification || null,
      anticipated_content: parsed.values.anticipated_content || null,
      objective: parsed.values.objective || null,
      legal_basis: parsed.values.legal_basis || null,
      affected_groups: parsed.values.affected_groups || null,
      approximate_schedule: parsed.values.approximate_schedule || null,
      relevant_laws: parsed.values.relevant_laws || null,
      description: parsed.values.description || null,
    };
    const agency = agencyLabel(document.agency || document.agency_code) || "Unknown agency";
    const fiscal_year = fiscalYear(document.fiscal_year || document.publisher_document_label) || "FYunknown";
    const publisherItemId = `${document.publisher_item_id || slug(agency)}-${index + 1}`;
    const id = itemId({ agency, fiscal_year, publisher_item_id: publisherItemId });
    const item = {
      schema: REGULATORY_AGENDA_ITEM_SCHEMA,
      id,
      object_type: "regulatory-agenda-item",
      agency,
      agency_code: clean(document.agency_code, 40) || null,
      fiscal_year,
      subject: values.subject || null,
      justification: values.justification,
      anticipated_content: values.anticipated_content,
      objective: values.objective,
      legal_basis: values.legal_basis,
      affected_groups: values.affected_groups,
      approximate_schedule: values.approximate_schedule,
      relevant_laws: values.relevant_laws,
      lifecycle_stage: "anticipated",
      formal_rulemaking: false,
      publisher_document: sourceUrl(document.publisher_document),
      publisher_page: Number.isInteger(document.publisher_page) ? document.publisher_page : null,
      source: {
        system: "nyc_rules",
        index_url: sourceUrl(document.index_url) || REGULATORY_AGENDA_INDEX_URL,
        document_url: sourceUrl(document.publisher_document),
        publisher_item_id: publisherItemId,
        published_at: document.publish_date || null,
        retrieved_at: document.retrieved_at || null,
      },
      field_availability: availability({
        ...values,
        publisher_document: document.publisher_document,
        publisher_page: document.publisher_page,
      }, { headings: parsed.headings }),
      canonical_href: agendaItemHref(id),
    };
    return item;
  }).filter((item) => item.subject || item.publisher_document);
}

export function agendaFieldAvailability(items = []) {
  return Object.fromEntries(REGULATORY_AGENDA_FIELDS.map((field) => [field, Object.fromEntries(
    ["published", "source_not_published", "not_yet_acquired", "parse_failed", "empty"].map((state) => [
      state,
      items.filter((item) => item?.field_availability?.[field] === state || (!item?.field_availability?.[field] && state === "not_yet_acquired")).length,
    ]),
  )]));
}

function schedulePrecision(value) {
  const text = clean(value, 240);
  if (!text) return "not_stated";
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(text)) return "date";
  if (/\b(?:q[1-4]|first|second|third|fourth)\s+quarter\b/i.test(text)) return "quarter";
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text)) return "month";
  if (/\b(?:spring|summer|fall|autumn|winter)\b/i.test(text)) return "season";
  if (/\b(?:fy|fiscal\s+year)\s*['’]?\d{2,4}\b/i.test(text)) return "fiscal_year";
  return "unspecified";
}

export function agendaSchedulePrecision(items = []) {
  const states = ["date", "month", "quarter", "season", "fiscal_year", "unspecified", "not_stated"];
  return Object.fromEntries(states.map((state) => [
    state,
    items.filter((item) => schedulePrecision(item?.approximate_schedule) === state).length,
  ]));
}

export function agendaExtractionChecks({ documents = [], items = [], index = null } = {}) {
  const agencies = [...new Set(items.map((item) => item.agency).filter(Boolean))].sort();
  const retrievalFailures = documents.filter((document) => document.retrieval_status !== "available").length;
  return {
    schema: "cityscroll.regulatory_agenda_extraction_checks.v1",
    agencies_represented: agencies,
    agency_count: agencies.length,
    structured_items: items.length,
    item_count: items.length,
    field_availability: agendaFieldAvailability(items),
    schedule_precision: agendaSchedulePrecision(items),
    documents: {
      indexed: documents.length,
      retrieval_failures: retrievalFailures,
      index_retrieved_at: index?.retrieved_at || null,
      source_vintages: [...new Set(documents.map((document) => document.publish_date).filter(Boolean))].sort(),
      index_url: index?.index_url || REGULATORY_AGENDA_INDEX_URL,
    },
  };
}

function norm(value) {
  return clean(value, 4_000).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function agencySame(left, right) {
  const comparable = (value) => norm(agencyLabel(value))
    .replace(/^new york city\s+/, "")
    .replace(/\s+of the city of new york$/, "")
    .replace(/^department of\s+/, "")
    .replace(/^department\s+/, "");
  return comparable(left) === comparable(right);
}

function distinctiveOverlap(left, right) {
  const a = new Set(norm(left).split(" ").filter((token) => token.length >= 5));
  return norm(right).split(" ").filter((token) => token.length >= 5 && a.has(token)).length >= 2;
}

/** Keep tentative matches out of the public graph unless evidence is explicit. */
export function evaluateAgendaRulemakingLink(item, rulemaking) {
  const evidence = Array.isArray(rulemaking?.agenda_link_evidence)
    ? rulemaking.agenda_link_evidence.filter((value) => clean(value, 300))
    : [];
  const exactAgency = agencySame(item?.agency, rulemaking?.agency);
  const supports = [
    distinctiveOverlap(item?.subject, rulemaking?.title || rulemaking?.subject),
    clean(item?.legal_basis) && clean(rulemaking?.legal_basis) && distinctiveOverlap(item.legal_basis, rulemaking.legal_basis),
    clean(item?.approximate_schedule) && clean(rulemaking?.notice_date) && /\b(?:fy|quarter|month|summer|fall|spring|winter)\b/i.test(item.approximate_schedule),
    evidence.length > 0,
  ].filter(Boolean).length;
  const accepted = exactAgency && evidence.length >= 2 && supports >= 2;
  return {
    from: item?.id || null,
    to: rulemaking?.rulemaking_id || rulemaking?.subject_ref || null,
    relation: "anticipates?",
    status: accepted ? "accepted" : "candidate",
    public_edge: accepted,
    exact_agency: exactAgency,
    evidence,
    evidence_count: evidence.length,
    reason: accepted ? "explicit_supporting_evidence" : "forecast_match_not_publicly_supported",
  };
}

export function buildAgendaRulemakingBridge(items = [], rulemakings = []) {
  const candidates = [];
  for (const item of items) {
    for (const rulemaking of rulemakings) {
      const link = evaluateAgendaRulemakingLink(item, rulemaking);
      if (link.exact_agency && (link.status === "accepted" || distinctiveOverlap(item.subject, rulemaking.title || rulemaking.subject))) candidates.push(link);
    }
  }
  const accepted = candidates.filter((link) => link.public_edge);
  return {
    schema: "cityscroll.regulatory_agenda_bridge.v1",
    candidates,
    links: accepted,
    metrics: {
      candidate_rate: items.length ? candidates.length / items.length : 0,
      candidate_count: candidates.length,
      accepted_link_count: accepted.length,
      accepted_link_precision: accepted.length ? "requires_reviewed_evidence" : "no_accepted_links",
      unlinked_but_plausible_count: candidates.filter((link) => link.status === "candidate").length,
    },
  };
}

export function buildRegulatoryAgendaMaterialization({ index = {}, documents = [], items = [], rulemakings = [], generatedAt = null } = {}) {
  const bridge = buildAgendaRulemakingBridge(items, rulemakings);
  return {
    schema: REGULATORY_AGENDA_SCHEMA,
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      system: "nyc_rules",
      index_url: index.index_url || REGULATORY_AGENDA_INDEX_URL,
      index_retrieved_at: index.retrieved_at || null,
      acquisition_tier: 1,
      resident_time_fetch: false,
      documents: documents.map((document) => ({
        agency: document.agency,
        fiscal_year: document.fiscal_year,
        url: document.publisher_document,
        publish_date: document.publish_date || null,
        retrieval_status: document.retrieval_status || "unknown",
      })),
    },
    counts: {
      agencies: new Set(items.map((item) => item.agency).filter(Boolean)).size,
      items: items.length,
      anticipated: items.filter((item) => item.lifecycle_stage === "anticipated").length,
      documents: documents.length,
    },
    agenda_items: items,
    agenda_link_bridge: bridge,
    checks: agendaExtractionChecks({ documents, items, index }),
  };
}

export function buildAgencyHorizon(items = [], { agency = null, now = null } = {}) {
  const agencyName = agencyLabel(agency);
  const rows = (items || []).filter((item) => (!agencyName || agencySame(item.agency, agencyName)) && item.lifecycle_stage === "anticipated");
  const groups = new Map();
  for (const item of rows) {
    const key = agencyLabel(item.agency) || "Unknown agency";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      ...item,
      horizon_label: item.approximate_schedule || "Schedule not stated",
      follow_href: item.follow_href || "/following/",
    });
  }
  return {
    schema: "cityscroll.regulatory_agenda_horizon.v1",
    stage: "anticipated",
    meaning: "Agency planning signal; not a formal rulemaking proceeding.",
    as_of: now || null,
    agencies: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, agencyItems]) => ({ agency: name, items: agencyItems })),
    items: rows,
  };
}

export { AGENCY_NAMES, agencyLabel, fiscalYear };
