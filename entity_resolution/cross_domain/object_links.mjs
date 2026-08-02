/**
 * Cross-domain object-link layer.
 *
 * Resolve and link the SAME real-world entity (agency / vendor) across CityScroll
 * domains — money, land, rules, meetings, people — without collapsing publisher
 * subjects. Reuses:
 *   - entity_resolution normalizers (canonicalAgency / vendorStem)
 *   - subject_registry kinds + makeSubjectLink / formatSubjectRef
 *   - warehouse ER observation shapes (OCP awards, ZAP projects)
 *
 * Link-not-merge: each domain object keeps its own subject_ref; the root entity
 * is connected by typed edges that always carry provenance.
 *
 * Never invents a link when identity cannot be resolved or the observation lacks
 * a join key. Empty domains are explicit (matched / empty / not_yet_ingested).
 */

import {
  agencyCanonicalId,
  canonicalAgency,
  vendorStem,
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
} from "../normalizers/index.mjs";
import {
  formatSubjectRef,
  makeSubjectLink,
  parseSubjectRef,
  dedupeSubjectLinks,
  SUBJECT_LINK_METHOD,
  SUBJECT_LINK_METHOD_VERSION,
} from "../../worker/src/lib/subject_registry.mjs";
// Reuse land-side strict ULURP token extractor (same as joinCityRecordLandNotices).
import { extractUlurpKeys } from "../../worker/src/lib/ulurp_recommendations_join.mjs";

export const CROSS_DOMAIN_OBJECT_LINK_VERSION = "cross_domain_object_link_v2";
export const CROSS_DOMAIN_METHOD = "cross_domain_identity_v2";
export const CROSS_DOMAIN_METHOD_VERSION = "2.0.0";
export const AGENCY_METHOD = "agency_canonical_v1";
export const AGENCY_METHOD_VERSION = "1";
export const PIN_METHOD = "pin_authority_key_v1";
export const PIN_METHOD_VERSION = "1";
export const CONTRACT_METHOD = "contract_id_join_v1";
export const CONTRACT_METHOD_VERSION = "1";
export const PAYMENT_METHOD = "checkbook_payment_v1";
export const PAYMENT_METHOD_VERSION = "1";
/** Meeting body → land project via exact ULURP token (mirrors land CR join). */
export const MEETING_LAND_ULURP_METHOD = "exact_ulurp_token_v1";
export const MEETING_LAND_ULURP_METHOD_VERSION = "1";
/** Meeting body → land project via explicit ZAP portal / project id. */
export const MEETING_LAND_ZAP_METHOD = "zap_project_ref_v1";
export const MEETING_LAND_ZAP_METHOD_VERSION = "1";

/** Domains the intelligence surface covers (closed set). */
export const CROSS_DOMAIN_DOMAINS = Object.freeze([
  "money",
  "land",
  "property",
  "rules",
  "meetings",
  "people",
]);

/**
 * Cross-domain link types (extend subject-registry vocabulary where kinds match;
 * otherwise stay local and never claim a registry edge for invalid kind pairs).
 */
export const CROSS_DOMAIN_LINK_TYPES = Object.freeze({
  published_by_agency: {
    description: "Procurement / property / rules / hearing notice published by an agency",
    domains: Object.freeze(["money", "property", "rules", "meetings"]),
    registry: true,
  },
  named_vendor: {
    description: "Procurement notice names a vendor",
    domains: Object.freeze(["money"]),
    registry: true,
  },
  named_owner: {
    description: "Property disposition notice names a winning bidder / grantee",
    domains: Object.freeze(["property"]),
    registry: true,
  },
  sits_on_parcel: {
    description: "Property notice or land project sits on an exact BBL",
    domains: Object.freeze(["property", "land"]),
    registry: true,
  },
  parcel_links_project: {
    description: "Property disposition notice shares an exact BBL with a ZAP project",
    domains: Object.freeze(["property"]),
    registry: true,
  },
  applicant_agency: {
    description: "Land project primary applicant resolves to an agency",
    domains: Object.freeze(["land"]),
    registry: false,
  },
  applicant_vendor: {
    description: "Land project primary applicant resolves to a vendor stem",
    domains: Object.freeze(["land"]),
    registry: false,
  },
  hosts_meeting: {
    description: "Agency hosts or is the body of a meeting/hearing notice",
    domains: Object.freeze(["meetings"]),
    registry: false,
  },
  issued_rule: {
    description: "Agency issued a rule item (NYC Rules / Agency Rules notice)",
    domains: Object.freeze(["rules"]),
    registry: false,
  },
  votes_as_official: {
    description: "Person-level vote retained for an official entity",
    domains: Object.freeze(["people"]),
    registry: false,
  },
  sited_on_parcel: {
    description: "Land project is sited on a published tax lot (BBL) via ZAP BBL",
    domains: Object.freeze(["land"]),
    registry: false,
  },
  decides_land_project: {
    description:
      "Hearing/meeting body cites a ULURP application number or ZAP project that the hearing decides",
    domains: Object.freeze(["meetings"]),
    registry: false,
  },
  // --- v2 join-key edges (PIN / contract / payment) ---
  shares_authority_key: {
    description: "Notice or contract shares a structured PIN/EPIN authority key",
    domains: Object.freeze(["money"]),
    registry: true,
  },
  references_contract: {
    description: "Award notice references a Checkbook/PASSPort contract id",
    domains: Object.freeze(["money"]),
    registry: true,
  },
  paid_to_vendor: {
    description: "Checkbook spending payment is paid to a vendor (payee)",
    domains: Object.freeze(["money"]),
    registry: false,
  },
  payment_on_contract: {
    description: "Spending document is drawn on a contract id",
    domains: Object.freeze(["money"]),
    registry: false,
  },
  contract_published_by_agency: {
    description: "Registered contract subject is published by an agency (award join)",
    domains: Object.freeze(["money"]),
    registry: false,
  },
});

const DOMAIN_SET = new Set(CROSS_DOMAIN_DOMAINS);
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Stable agency subject_ref from any free-text agency surface.
 * @returns {{ ref: string, canonical_id: string, canonical_name: string } | null}
 */
export function resolveAgencySubject(name) {
  const raw = clean(name);
  if (!raw) return null;
  const { canonical_id, canonical_name } = canonicalAgency(raw);
  if (!canonical_id) return null;
  const ref = formatSubjectRef("agency", `id:${canonical_id}`);
  if (!ref) return null;
  return { ref, canonical_id, canonical_name: canonical_name || raw, input: raw };
}

/**
 * Stable vendor subject_ref from a display name (stem handle, not merge id).
 * @returns {{ ref: string, stem: string, display_name: string } | null}
 */
export function resolveVendorSubject(name) {
  const raw = clean(name);
  if (!raw) return null;
  const stem = vendorStem(raw);
  if (!stem || stem.length < 3) return null;
  // Match subject_registry lifecycle vendor handle shape (name-encoded).
  const ref = formatSubjectRef("vendor", `stem:${encodeURIComponent(stem)}`);
  if (!ref) return null;
  return { ref, stem, display_name: raw };
}

/**
 * Provenance block required on every link / object.
 * @param {object} input
 */
export function makeProvenance(input = {}) {
  const source_system = clean(input.source_system || input.system);
  const source_record_id = clean(
    input.source_record_id || input.source_system_id || input.native_key || input.id,
  );
  if (!source_system || !source_record_id) return null;
  const provenance = {
    source_system,
    source_record_id,
    source_fields: [...new Set((input.source_fields || []).map(clean).filter(Boolean))].sort(),
    basis: clean(input.basis) || "publisher_field",
  };
  if (input.observed_at) provenance.observed_at = clean(input.observed_at);
  if (input.source_url) provenance.source_url = clean(input.source_url);
  if (input.input_value != null) provenance.input_value = clean(input.input_value);
  return provenance;
}

/**
 * Build one cross-domain edge. Prefer subject_registry makeSubjectLink when the
 * type is a registered link; otherwise emit a local typed edge with provenance.
 *
 * @returns {object|null}
 */
export function makeObjectLink(input = {}) {
  const type = clean(input.type || input.link_type).toLowerCase();
  const meta = CROSS_DOMAIN_LINK_TYPES[type];
  if (!meta) return null;

  const from = parseSubjectRef(input.from || input.from_ref);
  const to = parseSubjectRef(input.to || input.to_ref);
  if (!from || !to || from.ref === to.ref) return null;

  const provenance = makeProvenance(input.provenance || input);
  if (!provenance) return null;

  const domain = clean(input.domain).toLowerCase();
  if (domain && !DOMAIN_SET.has(domain)) return null;
  if (domain && meta.domains && !meta.domains.includes(domain)) return null;

  const confidence = clean(input.confidence) || "strong";
  const method = clean(input.method) || CROSS_DOMAIN_METHOD;
  const method_version = clean(input.method_version) || CROSS_DOMAIN_METHOD_VERSION;

  // Registry path: only when type is already a subject-registry link type.
  if (meta.registry) {
    const edge = makeSubjectLink({
      type,
      from: from.ref,
      to: to.ref,
      method,
      method_version,
      confidence,
      evidence: {
        ...provenance,
        domain: domain || null,
        cross_domain: true,
      },
    });
    if (!edge) return null;
    return {
      ...edge,
      domain: domain || null,
      confidence,
      provenance,
      layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    };
  }

  return {
    type,
    from: from.ref,
    to: to.ref,
    domain: domain || null,
    confidence,
    method,
    method_version,
    provenance,
    layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
  };
}

/**
 * Shape a money-domain observation (OCP award / City Record notice row).
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromMoneyRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "ocp-recent-contract-awards");
  const requestId = clean(row.request_id || row.id);
  const pin = clean(row.pin);
  const contractId = clean(
    row.contract_id || row.prime_contract_id || row.ct_id || row.registered_contract_id,
  );
  const nativeKey = requestId || (pin ? `pin:${pin}` : "") || (contractId ? `ct:${contractId}` : "");
  if (!nativeKey) return null;
  const agencyName = clean(row.agency_name);
  const vendorName = clean(row.vendor_name);
  if (!agencyName && !vendorName) return null;

  const typeDesc = clean(row.type_of_notice_description).toLowerCase();
  let object_kind = "award";
  if (typeDesc.includes("solicit")) object_kind = "solicitation";
  else if (typeDesc.includes("intent to award")) object_kind = "intent_to_award";

  return {
    domain: "money",
    object_kind,
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${nativeKey}`,
    native_key: nativeKey,
    request_id: requestId || null,
    pin: pin || null,
    contract_id: contractId || null,
    agency_name: agencyName || null,
    vendor_name: vendorName || null,
    label: clean(row.short_title) || vendorName || agencyName || requestId || nativeKey,
    when: clean(row.start_date || row.award_date || row.date) || null,
    amount:
      row.contract_amount != null && row.contract_amount !== ""
        ? Number(row.contract_amount)
        : null,
    subject_ref: requestId ? formatSubjectRef("notice", requestId) : null,
  };
}

/**
 * Shape a Checkbook spending / payment observation (money domain).
 * Join keys: payee_name → vendor, contract_id → contract, optional pin / agency.
 * Never invents a payment without payee or contract identity.
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromPaymentRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(
    opts.sourceSystem || row.source_system || "checkbook-spending",
  );
  const documentId = clean(
    row.document_id || row.check_id || row.payment_id || row.id,
  );
  const contractId = clean(
    row.contract_id || row.prime_contract_id || row.ct_id,
  );
  const pin = clean(row.pin);
  const payee = clean(row.payee_name || row.vendor_name);
  const agencyName = clean(row.agency_name);
  if (!payee && !contractId) return null;
  const nativeKey =
    documentId
    || (contractId && payee ? `${contractId}:${payee}` : "")
    || contractId
    || (pin ? `pin:${pin}:pay` : "");
  if (!nativeKey) return null;

  const subject_ref = documentId
    ? formatSubjectRef("entity", `spending:${documentId}`)
    : contractId
      ? formatSubjectRef("contract", contractId)
      : null;
  if (!subject_ref) return null;

  return {
    domain: "money",
    object_kind: "payment",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${nativeKey}`,
    native_key: nativeKey,
    document_id: documentId || null,
    contract_id: contractId || null,
    pin: pin || null,
    request_id: null,
    agency_name: agencyName || null,
    vendor_name: payee || null,
    payee_name: payee || null,
    label:
      clean(row.short_title)
      || (payee && contractId ? `${payee} · ${contractId}` : "")
      || payee
      || contractId
      || nativeKey,
    when: clean(row.issue_date || row.payment_date || row.check_date || row.date) || null,
    amount:
      row.check_amount != null && row.check_amount !== ""
        ? Number(row.check_amount)
        : row.amount != null && row.amount !== ""
          ? Number(row.amount)
          : null,
    subject_ref,
  };
}

/**
 * Normalize a 10-digit NYC BBL string. Fails closed on non-BBL values.
 * @param {string|number|null|undefined} value
 * @returns {string|null}
 */
export function normalizeBbl(value) {
  let s = clean(value).replace(/\.0$/, "");
  if (!s) return null;
  // Pure digits: pad short borough-block-lot fragments to 10.
  if (/^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
  if (/^\d{10}$/.test(s)) return s;
  // Formatted BBLs (1-00644-0001 / commas): keep digits only.
  const digits = s.replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return digits;
  if (/^\d+$/.test(digits) && digits.length < 10) {
    const padded = digits.padStart(10, "0");
    return /^\d{10}$/.test(padded) ? padded : null;
  }
  return null;
}

/**
 * Parcel subject_ref from a 10-digit BBL.
 * @returns {{ ref: string, bbl: string } | null}
 */
export function resolveParcelSubject(bbl) {
  const id = normalizeBbl(bbl);
  if (!id) return null;
  const ref = formatSubjectRef("parcel", id);
  if (!ref) return null;
  return { ref, bbl: id };
}

/**
 * Shape a land-domain observation (ZAP project row).
 * Optional `bbls` / single `bbl` attach tax-lot join keys from ZAP BBL (WH-06).
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromLandRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "zap-projects");
  const projectId = clean(row.project_id || row.id);
  if (!projectId) return null;
  const applicant = clean(row.primary_applicant || row.applicant);
  if (!applicant) return null;

  const bblInputs = [
    ...(Array.isArray(row.bbls) ? row.bbls : []),
    ...(row.bbl != null ? [row.bbl] : []),
  ];
  const bbls = [...new Set(bblInputs.map(normalizeBbl).filter(Boolean))].sort().slice(0, 25);

  return {
    domain: "land",
    object_kind: "project",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${projectId}`,
    native_key: projectId,
    project_id: projectId,
    applicant,
    agency_name: null, // resolved later when applicant is agency-shaped
    vendor_name: null,
    label: clean(row.project_name) || projectId,
    when: clean(
      row.current_milestone_date
        || row.certified_referred
        || row.noticed_date
        || row.app_filed_date
        || row.approval_date,
    ) || null,
    public_status: clean(row.public_status) || null,
    ulurp_numbers: clean(row.ulurp_numbers) || null,
    bbls,
    subject_ref: formatSubjectRef("project", projectId),
  };
}

/**
 * Shape a ZAP BBL tax-lot row as a land-side enrichment observation.
 * Does not invent an agency/vendor root by itself — pair with a project row via
 * mergeBblsOntoLandObservations, or use when project_id is already known.
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 * @returns {{ project_id: string, bbl: string, source_system: string, source_record_id: string } | null}
 */
export function observationFromZapBblRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "zap-bbl");
  const projectId = clean(row.project_id || row.id);
  const bbl = normalizeBbl(row.bbl);
  if (!projectId || !bbl) return null;
  return {
    domain: "land",
    object_kind: "tax_lot",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${projectId}:${bbl}`,
    native_key: `${projectId}:${bbl}`,
    project_id: projectId,
    bbl,
    bbls: [bbl],
    subject_ref: formatSubjectRef("parcel", bbl),
  };
}

/**
 * Merge project_id → BBLs onto land project observations (join key: project_id).
 * Mutates nothing; returns a new observation list.
 * @param {object[]} observations
 * @param {Array<{ project_id: string, bbl?: string, bbls?: string[] }>} bblRows
 */
export function mergeBblsOntoLandObservations(observations, bblRows = []) {
  /** @type {Map<string, string[]>} */
  const byProject = new Map();
  for (const row of bblRows || []) {
    const pid = clean(row?.project_id);
    if (!pid) continue;
    const list = [
      ...(Array.isArray(row.bbls) ? row.bbls : []),
      ...(row.bbl != null ? [row.bbl] : []),
    ]
      .map(normalizeBbl)
      .filter(Boolean);
    if (!list.length) continue;
    const cur = byProject.get(pid) || [];
    byProject.set(pid, [...new Set([...cur, ...list])].sort().slice(0, 25));
  }
  if (!byProject.size) return [...(observations || [])];

  return (observations || []).map((obs) => {
    if (!obs || obs.domain !== "land" || obs.object_kind !== "project") return obs;
    const pid = clean(obs.project_id);
    const extra = byProject.get(pid);
    if (!extra?.length) return obs;
    const bbls = [...new Set([...(obs.bbls || []), ...extra])].sort().slice(0, 25);
    return { ...obs, bbls };
  });
}

/**
 * Flatten a rules:materialized:v2 record (or City Record / domain-snapshot row)
 * into the fields observationFromRulesRow expects. Does not invent joins.
 * @param {object} record
 */
export function flattenRulesMaterializationRecord(record) {
  if (!record || typeof record !== "object") return null;
  // Nested city_record / nyc_rules from rules:materialized:v2
  const cr = record.city_record && typeof record.city_record === "object" ? record.city_record : null;
  const nr = record.nyc_rules && typeof record.nyc_rules === "object" ? record.nyc_rules : null;
  const requestId = clean(
    record.request_id
      || cr?.request_id
      || record.id
      || record.rules_id
      || nr?.guid
      || nr?.url,
  );
  const agencyName = clean(
    record.agency_name
      || record.agency
      || cr?.agency
      || cr?.agency_name
      || nr?.agency_name
      || nr?.agency_full
      || nr?.agency_abbr,
  );
  if (!requestId || !agencyName) return null;
  return {
    request_id: requestId,
    agency_name: agencyName,
    short_title: clean(record.short_title || record.title || cr?.title || nr?.title) || null,
    start_date: clean(
      record.start_date
        || record.notice_date
        || cr?.notice_date
        || nr?.pub_date
        || record.pub_date,
    ) || null,
    comment_close: clean(record.comment_close || nr?.comment_by_date) || null,
    source_system: clean(record.source_system) || "city_record",
  };
}

/**
 * Flatten a meeting-outcomes:materialized:v2 record (or hearing / domain-snapshot
 * row) into the fields observationFromMeetingsRow expects.
 * @param {object} record
 */
export function flattenMeetingsMaterializationRecord(record) {
  if (!record || typeof record !== "object") return null;
  const notice = record.notice && typeof record.notice === "object" ? record.notice : null;
  const council = record.council_event && typeof record.council_event === "object"
    ? record.council_event
    : null;
  const requestId = clean(record.request_id || notice?.request_id || record.id);
  const eventId = clean(
    record.event_id
      || record.legistar_event_id
      || council?.event_id
      || council?.EventId,
  );
  const agencyName = clean(
    record.agency_name
      || record.agency
      || notice?.agency
      || notice?.agency_name
      || council?.body_name,
  );
  if ((!requestId && !eventId) || !agencyName) return null;
  // Preserve body/description surfaces so ULURP / ZAP reverse joins can run
  // (same fields land uses via cityRecordBlob).
  const bodySource = {
    short_title: record.short_title || notice?.title || notice?.short_title,
    title: record.title || notice?.title,
    additional_description_1:
      record.additional_description_1 || notice?.additional_description_1,
    additional_description_2:
      record.additional_description_2 || notice?.additional_description_2,
    additional_description_3:
      record.additional_description_3 || notice?.additional_description_3,
    other_info_1: record.other_info_1 || notice?.other_info_1,
    other_info_2: record.other_info_2 || notice?.other_info_2,
    other_info_3: record.other_info_3 || notice?.other_info_3,
    printout_1: record.printout_1 || notice?.printout_1,
    printout_2: record.printout_2 || notice?.printout_2,
    printout_3: record.printout_3 || notice?.printout_3,
    body: record.body || record.body_text || notice?.body || notice?.body_text,
    body_text: record.body_text || notice?.body_text,
  };
  return {
    request_id: requestId || null,
    event_id: eventId || null,
    agency_name: agencyName,
    short_title: clean(
      record.short_title
        || record.title
        || notice?.title
        || council?.title
        || record.event_name,
    ) || null,
    event_date: clean(
      record.event_date
        || notice?.event_date
        || council?.event_date
        || council?.start_time,
    ) || null,
    start_date: clean(record.start_date || notice?.start_date) || null,
    source_system: clean(record.source_system) || "city_record",
    ...bodySource,
    // Optional pre-stamped join keys (domain snapshot / tests).
    ulurp_numbers: clean(record.ulurp_numbers || notice?.ulurp_numbers) || null,
    project_id: clean(record.project_id || notice?.project_id) || null,
    related_project_ids: Array.isArray(record.related_project_ids)
      ? record.related_project_ids
      : null,
  };
}

/**
 * Free-text blob from a hearing / City Record notice row — same field set as
 * land-side `cityRecordBlob` used by joinCityRecordLandNotices.
 * @param {object} row
 * @returns {string}
 */
export function hearingBodyBlob(row) {
  if (!row || typeof row !== "object") return "";
  return [
    row.short_title,
    row.title,
    row.body,
    row.body_text,
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
    row.ulurp_numbers,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ZAP portal / API project URL path segment → project_id. */
const ZAP_PROJECT_URL_RE =
  /(?:zap\.planning\.nyc\.gov|zap-api-production\.herokuapp\.com)\/projects\/([A-Za-z0-9]+)/gi;

/**
 * Extract ZAP project ids from free text (portal or API URLs only — never bare
 * year tokens). Reuses the same strict URL surface the land action rail already
 * treats as a deep project handoff.
 * @param {string|null|undefined} value
 * @returns {Set<string>}
 */
export function extractZapProjectIds(value) {
  const ids = new Set();
  if (value == null) return ids;
  const text = String(value);
  for (const m of text.matchAll(ZAP_PROJECT_URL_RE)) {
    const id = clean(m[1]);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Collect ULURP tokens + ZAP project ids from a hearing body / row.
 * Does not invent matches — only publisher-shaped refs.
 * @param {object|string|null|undefined} rowOrText
 * @returns {{ ulurp_keys: string[], zap_project_ids: string[], body_blob: string }}
 */
export function extractMeetingLandRefs(rowOrText) {
  const body_blob = typeof rowOrText === "string"
    ? clean(rowOrText)
    : hearingBodyBlob(rowOrText || {});
  const ulurp = extractUlurpKeys(body_blob);
  const zap = extractZapProjectIds(body_blob);
  // Also accept pre-stamped keys / project_id on structured rows (domain snapshots
  // store keys without committing raw body text).
  if (rowOrText && typeof rowOrText === "object") {
    for (const k of extractUlurpKeys(rowOrText.ulurp_numbers)) ulurp.add(k);
    for (const k of Array.isArray(rowOrText.ulurp_keys) ? rowOrText.ulurp_keys : []) {
      const key = clean(k).toUpperCase();
      if (key) ulurp.add(key);
    }
    for (const id of Array.isArray(rowOrText.related_project_ids)
      ? rowOrText.related_project_ids
      : []) {
      const cleanId = clean(id);
      if (cleanId) zap.add(cleanId);
    }
    for (const id of Array.isArray(rowOrText.zap_project_ids) ? rowOrText.zap_project_ids : []) {
      const cleanId = clean(id);
      if (cleanId) zap.add(cleanId);
    }
    // Explicit project_id on the row only when it matches ZAP shape YYYY + borough letter + digits
    // (e.g. 2022M0258) — never a bare integer notice id.
    const explicit = clean(rowOrText.project_id);
    if (explicit && /^[0-9]{4}[A-Z][0-9]+$/i.test(explicit)) zap.add(explicit);
  }
  return {
    ulurp_keys: [...ulurp].sort(),
    zap_project_ids: [...zap].sort(),
    body_blob,
  };
}

/**
 * Index land project observations for reverse ULURP / project_id join.
 * @param {Iterable<object>} landObservations
 * @returns {{ byUlurp: Map<string, object[]>, byProjectId: Map<string, object> }}
 */
export function buildLandProjectJoinIndex(landObservations = []) {
  /** @type {Map<string, object[]>} */
  const byUlurp = new Map();
  /** @type {Map<string, object>} */
  const byProjectId = new Map();
  for (const obs of landObservations || []) {
    if (!obs || obs.domain !== "land") continue;
    const projectId = clean(obs.project_id);
    if (!projectId) continue;
    if (obs.object_kind && obs.object_kind !== "project") continue;
    byProjectId.set(projectId, obs);
    for (const key of extractUlurpKeys(obs.ulurp_numbers)) {
      if (!byUlurp.has(key)) byUlurp.set(key, []);
      byUlurp.get(key).push(obs);
    }
  }
  return { byUlurp, byProjectId };
}

/**
 * Resolve meeting land refs against a land project index.
 * Only returns projects that exist in the index (no speculative links).
 * @param {object} meetingObs
 * @param {{ byUlurp: Map, byProjectId: Map }} landIndex
 * @returns {object[]} related_projects
 */
export function resolveMeetingLandProjects(meetingObs, landIndex) {
  if (!meetingObs || meetingObs.domain !== "meetings" || !landIndex) return [];
  const refs = {
    ulurp_keys: Array.isArray(meetingObs.ulurp_keys) ? meetingObs.ulurp_keys : [],
    zap_project_ids: Array.isArray(meetingObs.zap_project_ids)
      ? meetingObs.zap_project_ids
      : [],
  };
  // Re-extract when body fields are present but keys were not pre-stamped.
  if (!refs.ulurp_keys.length && !refs.zap_project_ids.length) {
    const extracted = extractMeetingLandRefs(meetingObs);
    refs.ulurp_keys = extracted.ulurp_keys;
    refs.zap_project_ids = extracted.zap_project_ids;
  }

  /** @type {Map<string, object>} */
  const hits = new Map();

  for (const key of refs.ulurp_keys) {
    const list = landIndex.byUlurp?.get(key) || [];
    for (const land of list) {
      const pid = clean(land.project_id);
      if (!pid) continue;
      const cur = hits.get(pid) || {
        project_id: pid,
        subject_ref: land.subject_ref || formatSubjectRef("project", pid),
        label: land.label || pid,
        join_method: MEETING_LAND_ULURP_METHOD,
        join_keys: [],
      };
      if (!cur.join_keys.includes(key)) cur.join_keys.push(key);
      cur.join_method = MEETING_LAND_ULURP_METHOD;
      hits.set(pid, cur);
    }
  }

  for (const pid of refs.zap_project_ids) {
    const land = landIndex.byProjectId?.get(pid);
    if (!land) continue; // unknown project → no link (honest punt)
    const cur = hits.get(pid) || {
      project_id: pid,
      subject_ref: land.subject_ref || formatSubjectRef("project", pid),
      label: land.label || pid,
      join_method: MEETING_LAND_ZAP_METHOD,
      join_keys: [],
    };
    if (!cur.join_keys.includes(pid)) cur.join_keys.push(pid);
    // Prefer ULURP method when both match; otherwise stamp ZAP URL method.
    if (cur.join_method !== MEETING_LAND_ULURP_METHOD) {
      cur.join_method = MEETING_LAND_ZAP_METHOD;
    }
    hits.set(pid, cur);
  }

  return [...hits.values()]
    .map((h) => ({
      ...h,
      join_keys: [...h.join_keys].sort(),
      href: `#land?project=${encodeURIComponent(h.project_id)}`,
    }))
    .sort((a, b) => String(a.project_id).localeCompare(String(b.project_id)));
}

/**
 * Stamp related_projects onto a meeting observation when land index hits.
 * Returns a new observation (does not mutate). No-op when nothing resolves.
 * @param {object} meetingObs
 * @param {{ byUlurp: Map, byProjectId: Map }} landIndex
 */
export function stampMeetingLandProjects(meetingObs, landIndex) {
  if (!meetingObs || meetingObs.domain !== "meetings") return meetingObs;
  const related = resolveMeetingLandProjects(meetingObs, landIndex);
  if (!related.length) {
    // Still surface extracted keys for diagnostics / tests when body had refs
    // that did not resolve (honest empty related_projects).
    const extracted = extractMeetingLandRefs(meetingObs);
    if (!extracted.ulurp_keys.length && !extracted.zap_project_ids.length) {
      return meetingObs;
    }
    return {
      ...meetingObs,
      ulurp_keys: extracted.ulurp_keys,
      zap_project_ids: extracted.zap_project_ids,
      related_projects: [],
    };
  }
  const extracted = extractMeetingLandRefs(meetingObs);
  return {
    ...meetingObs,
    ulurp_keys: extracted.ulurp_keys.length
      ? extracted.ulurp_keys
      : (meetingObs.ulurp_keys || []),
    zap_project_ids: extracted.zap_project_ids.length
      ? extracted.zap_project_ids
      : (meetingObs.zap_project_ids || []),
    related_projects: related,
  };
}

/**
 * Stamp every meetings observation in a corpus against land projects present
 * in the same corpus. Unknown ULURP/ZAP refs produce no link.
 * @param {object[]} observations
 * @returns {object[]}
 */
export function stampMeetingLandLinksOnCorpus(observations = []) {
  const list = Array.isArray(observations) ? observations : [];
  const land = list.filter(
    (o) => o && o.domain === "land" && o.object_kind === "project" && o.project_id,
  );
  if (!land.length) return list;
  const index = buildLandProjectJoinIndex(land);
  return list.map((obs) => {
    if (!obs || obs.domain !== "meetings") return obs;
    return stampMeetingLandProjects(obs, index);
  });
}

/**
 * Corpus-level join: emit decides_land_project edges for meetings that resolve
 * to known land projects. Pure — does not mutate inputs.
 * @param {object[]} meetingObservations
 * @param {object[]} landObservations
 * @returns {{ links: object[], by_notice: object, metrics: object }}
 */
export function joinMeetingsToLandProjects(meetingObservations = [], landObservations = []) {
  const landIndex = buildLandProjectJoinIndex(landObservations);
  const links = [];
  const by_notice = {};
  let matched = 0;
  let withRefs = 0;

  for (const raw of meetingObservations || []) {
    if (!raw || raw.domain !== "meetings") continue;
    const obs = stampMeetingLandProjects(raw, landIndex);
    const noticeKey = clean(obs.request_id || obs.event_id || obs.native_key);
    if (!noticeKey) continue;
    const hasRefs = (obs.ulurp_keys && obs.ulurp_keys.length)
      || (obs.zap_project_ids && obs.zap_project_ids.length);
    if (hasRefs) withRefs += 1;

    const related = obs.related_projects || [];
    by_notice[noticeKey] = {
      request_id: obs.request_id || null,
      event_id: obs.event_id || null,
      subject_ref: obs.subject_ref,
      ulurp_keys: obs.ulurp_keys || [],
      zap_project_ids: obs.zap_project_ids || [],
      related_projects: related,
      status: related.length ? "matched" : (hasRefs ? "no_land_match" : "no_ref"),
    };
    if (!related.length) continue;
    matched += 1;

    for (const project of related) {
      const edge = makeMeetingLandProjectLink(obs, project);
      if (edge) links.push(edge);
    }
  }

  return {
    links: dedupeObjectLinks(links),
    by_notice,
    metrics: {
      metric: "meeting_land_reverse_link_rate",
      meeting_count: (meetingObservations || []).filter((o) => o?.domain === "meetings").length,
      meetings_with_land_ref: withRefs,
      matched_meeting_count: matched,
      link_pair_count: links.length,
      meeting_land_reverse_link_rate: withRefs ? matched / withRefs : 0,
    },
  };
}

/**
 * Build one decides_land_project edge (meeting notice → land project).
 * @param {object} meetingObs
 * @param {object} project — { project_id, subject_ref, join_method, join_keys }
 */
export function makeMeetingLandProjectLink(meetingObs, project) {
  if (!meetingObs?.subject_ref || !project?.project_id) return null;
  const projectRef = project.subject_ref || formatSubjectRef("project", project.project_id);
  if (!projectRef) return null;
  const method = project.join_method === MEETING_LAND_ZAP_METHOD
    ? MEETING_LAND_ZAP_METHOD
    : MEETING_LAND_ULURP_METHOD;
  const method_version = method === MEETING_LAND_ZAP_METHOD
    ? MEETING_LAND_ZAP_METHOD_VERSION
    : MEETING_LAND_ULURP_METHOD_VERSION;
  const sourceFields = method === MEETING_LAND_ZAP_METHOD
    ? ["body", "zap_project_url"]
    : ["body", "ulurp_numbers"];
  const provenance = makeProvenance({
    source_system: meetingObs.source_system || "city_record",
    source_record_id: meetingObs.source_record_id
      || `${meetingObs.source_system || "city_record"}:${meetingObs.native_key}`,
    source_fields: sourceFields,
    basis: method === MEETING_LAND_ZAP_METHOD
      ? "meeting_body_zap_project"
      : "meeting_body_ulurp_token",
    observed_at: meetingObs.when,
    input_value: (project.join_keys || []).join(";") || project.project_id,
    source_url: `https://zap.planning.nyc.gov/projects/${encodeURIComponent(project.project_id)}`,
  });
  if (!provenance) return null;
  return makeObjectLink({
    type: "decides_land_project",
    from: meetingObs.subject_ref,
    to: projectRef,
    domain: "meetings",
    confidence: "strong",
    method,
    method_version,
    provenance,
  });
}

/**
 * Shape a rules-domain observation (Agency Rules notice or NYC Rules item).
 * Accepts raw City Record rows, domain-snapshot rows, or rules:materialized:v2 records.
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromRulesRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const flat = flattenRulesMaterializationRecord(row) || row;
  const sourceSystem = clean(opts.sourceSystem || flat.source_system || row.source_system || "city_record");
  const requestId = clean(flat.request_id || flat.id || flat.rules_id);
  const agencyName = clean(flat.agency_name);
  if (!requestId || !agencyName) return null;

  return {
    domain: "rules",
    object_kind: "rule",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${requestId}`,
    native_key: requestId,
    request_id: requestId,
    agency_name: agencyName,
    label: clean(flat.short_title || flat.title || row.short_title || row.title) || requestId,
    when: clean(flat.start_date || flat.pub_date || flat.comment_close) || null,
    subject_ref: formatSubjectRef("notice", requestId)
      || formatSubjectRef("rules", requestId),
  };
}

/**
 * Shape a meetings-domain observation (hearing notice or Legistar event).
 * Accepts raw City Record rows, domain-snapshot rows, or meeting-outcomes records.
 * When body / description fields carry ULURP or ZAP URLs, stamps ulurp_keys and
 * zap_project_ids for reverse land joins (no project link until resolve against
 * a known land subject).
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromMeetingsRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const flat = flattenMeetingsMaterializationRecord(row) || row;
  const sourceSystem = clean(opts.sourceSystem || flat.source_system || row.source_system || "city_record");
  const requestId = clean(flat.request_id || flat.id);
  const eventId = clean(flat.event_id || flat.legistar_event_id);
  const agencyName = clean(flat.agency_name);
  const nativeKey = requestId || eventId;
  if (!nativeKey || !agencyName) return null;

  const subject_ref = eventId && !requestId
    ? formatSubjectRef("legistar-event", eventId)
    : formatSubjectRef("notice", requestId || nativeKey);

  // Prefer flat (includes nested notice body); fall back to raw row fields.
  // Domain snapshots may already stamp ulurp_keys / zap_project_ids without body.
  const landRefs = extractMeetingLandRefs({ ...row, ...flat });
  const preUlurp = Array.isArray(row.ulurp_keys)
    ? row.ulurp_keys.map(clean).filter(Boolean)
    : (Array.isArray(flat.ulurp_keys) ? flat.ulurp_keys.map(clean).filter(Boolean) : []);
  const preZap = Array.isArray(row.zap_project_ids)
    ? row.zap_project_ids.map(clean).filter(Boolean)
    : (Array.isArray(flat.zap_project_ids) ? flat.zap_project_ids.map(clean).filter(Boolean) : []);
  const ulurp_keys = [...new Set([...landRefs.ulurp_keys, ...preUlurp])].sort();
  const zap_project_ids = [...new Set([...landRefs.zap_project_ids, ...preZap])].sort();

  const obs = {
    domain: "meetings",
    object_kind: eventId && !requestId ? "legistar_event" : "hearing",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${nativeKey}`,
    native_key: nativeKey,
    request_id: requestId || null,
    event_id: eventId || null,
    agency_name: agencyName,
    label: clean(flat.short_title || flat.title || flat.event_name || row.short_title || row.title) || nativeKey,
    when: clean(flat.event_date || flat.start_date) || null,
    subject_ref,
    // Optional body surfaces (tests / live materialization). Domain snapshots
    // stamp ulurp_keys / zap_project_ids instead of committing raw body text.
    short_title: clean(flat.short_title || row.short_title) || null,
    additional_description_1: clean(flat.additional_description_1 || row.additional_description_1) || null,
    additional_description_2: clean(flat.additional_description_2 || row.additional_description_2) || null,
    additional_description_3: clean(flat.additional_description_3 || row.additional_description_3) || null,
    other_info_1: clean(flat.other_info_1 || row.other_info_1) || null,
    printout_1: clean(flat.printout_1 || row.printout_1) || null,
    body: clean(flat.body || flat.body_text || row.body || row.body_text) || null,
    ulurp_keys,
    zap_project_ids,
    related_projects: Array.isArray(row.related_projects)
      ? row.related_projects
      : (Array.isArray(flat.related_projects) ? flat.related_projects : null),
  };
  return obs;
}

/**
 * Emit rules observations from a rules:materialized:v2 view, a domain snapshot
 * ({ rows }), or a bare array of City Record / record objects.
 * @param {object|object[]} viewOrRows
 * @param {{ sourceSystem?: string, limit?: number }} [opts]
 * @returns {object[]}
 */
export function observationsFromRulesMaterialization(viewOrRows, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 500;
  const rows = Array.isArray(viewOrRows)
    ? viewOrRows
    : Array.isArray(viewOrRows?.rules)
      ? viewOrRows.rules
      : Array.isArray(viewOrRows?.rows)
        ? viewOrRows.rows
        : Array.isArray(viewOrRows?.records)
          ? viewOrRows.records
          : [];
  const sourceSystem = clean(
    opts.sourceSystem
      || viewOrRows?.source?.system
      || viewOrRows?.source_system
      || "city_record",
  );
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const obs = observationFromRulesRow(row, { sourceSystem });
    if (obs) out.push(obs);
  }
  return out;
}

/**
 * Emit meetings observations from a meeting-outcomes:materialized:v2 view, a
 * hearings materialization, a domain snapshot ({ rows }), or a bare array.
 * Does not invent person-level votes.
 * @param {object|object[]} viewOrRows
 * @param {{ sourceSystem?: string, limit?: number }} [opts]
 * @returns {object[]}
 */
export function observationsFromMeetingsMaterialization(viewOrRows, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 500;
  const rows = Array.isArray(viewOrRows)
    ? viewOrRows
    : Array.isArray(viewOrRows?.records)
      ? viewOrRows.records
      : Array.isArray(viewOrRows?.rows)
        ? viewOrRows.rows
        : Array.isArray(viewOrRows?.hearings)
          ? viewOrRows.hearings
          : [];
  const sourceSystem = clean(
    opts.sourceSystem
      || viewOrRows?.source?.system
      || viewOrRows?.source_system
      || "city_record",
  );
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const obs = observationFromMeetingsRow(row, { sourceSystem });
    if (obs) out.push(obs);
  }
  return out;
}

/**
 * Shape a people-domain observation (official vote retention).
 * Only emits when person id is present — production often has tallies only.
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromPeopleRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "legistar");
  const personId = clean(row.person_id || row.PersonId);
  const personName = clean(row.person_name || row.PersonName);
  if (!personId || !personName) return null;
  const matterId = clean(row.matter_id || row.MatterId);
  const eventId = clean(row.event_id || row.EventId);

  return {
    domain: "people",
    object_kind: "vote",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:person:${personId}${matterId ? `:matter:${matterId}` : ""}`,
    native_key: personId,
    person_id: personId,
    person_name: personName,
    agency_name: clean(row.agency_name) || null, // rarely present
    label: personName,
    when: clean(row.vote_date || row.event_date) || null,
    vote: clean(row.vote || row.VoteValueName) || null,
    subject_ref: formatSubjectRef("entity", `official:${personId}`),
    matter_id: matterId || null,
    event_id: eventId || null,
  };
}

/**
 * Resolve which root entities an observation can attach to.
 * Land applicants: try agency first; if not in known agency GROUPS (preferred
 * alias), also try vendor stem for private applicants — never both for the
 * same string when agency preferred alias exists.
 *
 * @param {object} obs
 * @returns {Array<{ kind: 'agency'|'vendor', subject: object, field: string }>}
 */
export function rootsForObservation(obs) {
  if (!obs) return [];
  const roots = [];

  if (obs.domain === "land" && obs.applicant) {
    const agency = resolveAgencySubject(obs.applicant);
    // Only treat as agency when comparison landed on a preferred GROUPS name
    // OR the comparison key equals a known canonical (agencyCanonicalId non-empty
    // is always true for any string). Prefer agency when the preferred alias map
    // would have rewritten the name (canonical_name differs from raw in case-insensitive
    // sense via GROUPS) — use agencyCanonicalId equality with a known site id pattern
    // from GROUPS by checking if input matched PREFERRED path: canonicalAgency returns
    // the preferred name when in map. Heuristic: if applicant contains "Dept"/"Department"
    // / agency acronyms or resolves to a multi-word government name that is in the
    // agency table... Actually simplest honest rule:
    //   1) If sameAgency would match a City Record agency later, we still need a root.
    //   2) Prefer agency subject when agencyCanonicalId is non-empty AND the applicant
    //      string looks agency-shaped OR matches a GROUPS preferred rewrite.
    const preferred = agency && agency.canonical_name
      && comparisonSuggestsAgency(obs.applicant, agency);
    if (preferred) {
      roots.push({ kind: "agency", subject: agency, field: "primary_applicant" });
    } else {
      const vendor = resolveVendorSubject(obs.applicant);
      if (vendor) {
        roots.push({ kind: "vendor", subject: vendor, field: "primary_applicant" });
      }
    }
    return roots;
  }

  // Payments are vendor-centric (payee). Agency identity on spending rows is often the
  // contracting agency column — attach via contract_published_by_agency on the award
  // path, not as published_by_agency from entity:spending (registry from_kinds).
  if (obs.domain === "money" && obs.object_kind === "payment") {
    const payee = clean(obs.payee_name || obs.vendor_name);
    if (payee) {
      const vendor = resolveVendorSubject(payee);
      if (vendor) roots.push({ kind: "vendor", subject: vendor, field: "payee_name" });
    }
    return roots;
  }

  if (obs.agency_name) {
    const agency = resolveAgencySubject(obs.agency_name);
    if (agency) roots.push({ kind: "agency", subject: agency, field: "agency_name" });
  }
  if (obs.vendor_name && (obs.domain === "money" || obs.domain === "land" || obs.domain === "property")) {
    const vendor = resolveVendorSubject(obs.vendor_name);
    if (vendor) roots.push({ kind: "vendor", subject: vendor, field: "vendor_name" });
  }
  return roots;
}

/**
 * True when the applicant/agency string should be treated as an agency root.
 * Uses preferred rewrite (GROUPS) or government-shaped tokens.
 */
function comparisonSuggestsAgency(raw, resolved) {
  if (!resolved?.canonical_id) return false;
  const input = clean(raw);
  const preferred = clean(resolved.canonical_name);
  // GROUPS rewrite: preferred name differs from raw after case fold of full string
  // when the map supplied a different surface.
  if (preferred && preferred.toLowerCase() !== input.toLowerCase()) {
    // Only if comparisonKey would have hit PREFERRED — we cannot import the map,
    // but a rewrite to a shorter/different canonical_name is the GROUPS signal.
    // Also accept when canonical_id is a known multi-agency pattern from site ids.
    return true;
  }
  // Government-shaped free text that already is the preferred canonical surface.
  if (/\b(department|dept|commission|authority|office of|borough president|district attorney|board of|city planning|housing preservation|citywide administrative|parks and recreation|transportation|sanitation|education|police|fire department)\b/i.test(input)) {
    return true;
  }
  // Acronym-led city applicants: "HPD - …", "DPR - …", "DCP …", "EDC - …"
  if (/^(HPD|DPR|DCP|DOT|DEP|DCAS|SBS|HRA|ACS|NYCHA|EDC|SCA)\b/i.test(input)) {
    return true;
  }
  return false;
}

/**
 * Link type for (domain, root kind, field [, object_kind]).
 */
function linkTypeFor(domain, rootKind, field, objectKind = null) {
  if (domain === "money" && rootKind === "agency") return "published_by_agency";
  if (domain === "money" && rootKind === "vendor" && field === "payee_name") {
    return "paid_to_vendor";
  }
  if (domain === "money" && rootKind === "vendor" && objectKind === "payment") {
    return "paid_to_vendor";
  }
  if (domain === "money" && rootKind === "vendor") return "named_vendor";
  if (domain === "property" && rootKind === "agency") return "published_by_agency";
  if (domain === "property" && rootKind === "vendor") return "named_owner";
  if (domain === "land" && rootKind === "agency") return "applicant_agency";
  if (domain === "land" && rootKind === "vendor") return "applicant_vendor";
  if (domain === "rules" && rootKind === "agency") return "issued_rule";
  if (domain === "meetings" && rootKind === "agency") return "hosts_meeting";
  if (domain === "people") return "votes_as_official";
  return null;
}

/**
 * Confidence for identity methods.
 */
function confidenceFor(rootKind, field, obs) {
  if (rootKind === "agency" && field === "agency_name") return "strong";
  if (rootKind === "vendor" && field === "vendor_name") {
    // Disposition owners are label-extracted from body language — not a publisher column.
    if (obs.domain === "property") return "tentative";
    return "strong";
  }
  if (rootKind === "vendor" && field === "payee_name") return "strong";
  if (rootKind === "agency" && field === "primary_applicant") {
    // Applicant strings are noisier than City Record agency_name columns.
    return comparisonSuggestsAgency(obs.applicant, resolveAgencySubject(obs.applicant))
      ? "tentative"
      : "strong";
  }
  if (rootKind === "vendor" && field === "primary_applicant") return "tentative";
  return "not_scored";
}

/**
 * Convert an observation into linked objects + edges for any matching roots.
 * @param {object} obs
 * @returns {{ objects: object[], links: object[] }}
 */
export function linkObservation(obs) {
  if (!obs || !DOMAIN_SET.has(obs.domain)) return { objects: [], links: [] };
  const roots = rootsForObservation(obs);
  // Join-key edges may exist without agency/vendor roots (parcel / pin / contract / land).
  const parcelLinks = parcelLinksForObservation(obs);
  const joinKeyLinks = joinKeyLinksForObservation(obs);
  const meetingLandLinks = meetingLandLinksForObservation(obs);
  if (!roots.length && !parcelLinks.length && !joinKeyLinks.length && !meetingLandLinks.length) {
    return { objects: [], links: [] };
  }

  const objects = [];
  const links = [];
  const objectSubject = obs.subject_ref || null;
  const bbls = Array.isArray(obs.bbls) ? obs.bbls.map(normalizeBbl).filter(Boolean) : [];

  for (const root of roots) {
    const type = linkTypeFor(obs.domain, root.kind, root.field, obs.object_kind);
    if (!type || !objectSubject) continue;

    const method = root.kind === "agency"
      ? AGENCY_METHOD
      : (type === "paid_to_vendor" ? PAYMENT_METHOD : VENDOR_STEM_METHOD);
    const method_version = root.kind === "agency"
      ? AGENCY_METHOD_VERSION
      : (type === "paid_to_vendor" ? PAYMENT_METHOD_VERSION : VENDOR_STEM_VERSION);

    const inputValue = root.field === "primary_applicant"
      ? obs.applicant
      : root.field === "agency_name"
        ? obs.agency_name
        : root.field === "payee_name"
          ? (obs.payee_name || obs.vendor_name)
          : obs.vendor_name;

    const provenance = makeProvenance({
      source_system: obs.source_system,
      source_record_id: obs.source_record_id,
      source_fields: [root.field],
      basis: `${obs.domain}_${root.field}`,
      observed_at: obs.when,
      input_value: inputValue,
    });
    if (!provenance) continue;

    // Edge direction: domain object → root entity (same as published_by_agency
    // from_kinds notice → agency).
    const edge = makeObjectLink({
      type,
      from: objectSubject,
      to: root.subject.ref,
      domain: obs.domain,
      confidence: confidenceFor(root.kind, root.field, obs),
      method,
      method_version,
      provenance,
    });
    if (!edge) continue;

    objects.push({
      subject_ref: objectSubject,
      domain: obs.domain,
      object_kind: obs.object_kind,
      label: obs.label,
      when: obs.when,
      amount: Number.isFinite(obs.amount) ? obs.amount : null,
      public_status: obs.public_status || null,
      pin: obs.pin || null,
      contract_id: obs.contract_id || null,
      document_id: obs.document_id || null,
      project_id: obs.project_id || null,
      request_id: obs.request_id || null,
      event_id: obs.event_id || null,
      ulurp_numbers: obs.ulurp_numbers || null,
      bbls: bbls.length ? bbls : null,
      root_ref: root.subject.ref,
      root_kind: root.kind,
      href: hrefForObject(obs),
      provenance,
      link_type: type,
      confidence: edge.confidence,
      method,
    });
    links.push(edge);
  }

  // Project → parcel edges (ZAP BBL join). Always from project subject when present.
  const projectRef = obs.project_id
    ? formatSubjectRef("project", clean(obs.project_id))
    : (objectSubject && parseSubjectRef(objectSubject)?.kind === "project" ? objectSubject : null);
  if (projectRef && parcelLinks.length) {
    for (const edge of parcelLinks) {
      if (edge) links.push(edge);
    }
  }

  // PIN / contract join-key edges (award → pin, award → contract, payment → contract).
  for (const edge of joinKeyLinks) {
    if (edge) links.push(edge);
  }

  // Meeting → land reverse edges (ULURP / ZAP refs resolved to known projects).
  for (const edge of meetingLandLinks) {
    if (edge) links.push(edge);
  }

  return { objects, links };
}

/**
 * Emit decides_land_project edges for meetings with related_projects already
 * resolved against a known land corpus. Never invents a project id from body alone.
 * @param {object} obs
 * @returns {object[]}
 */
export function meetingLandLinksForObservation(obs) {
  if (!obs || obs.domain !== "meetings") return [];
  const related = Array.isArray(obs.related_projects) ? obs.related_projects : [];
  if (!related.length) return [];
  const edges = [];
  for (const project of related) {
    const edge = makeMeetingLandProjectLink(obs, project);
    if (edge) edges.push(edge);
  }
  return edges;
}

/**
 * Join-key edges that are not root-identity edges: PIN, contract_id, payment→contract.
 * Each edge carries provenance; never invents a key when the field is empty.
 * @param {object} obs
 * @returns {object[]}
 */
export function joinKeyLinksForObservation(obs) {
  if (!obs || obs.domain !== "money") return [];
  const edges = [];
  const objectSubject = obs.subject_ref;
  const pin = clean(obs.pin);
  const contractId = clean(obs.contract_id);

  // notice|entity → pin (authority key)
  if (objectSubject && pin) {
    const pinRef = formatSubjectRef("pin", pin);
    if (pinRef) {
      const provenance = makeProvenance({
        source_system: obs.source_system,
        source_record_id: obs.source_record_id,
        source_fields: ["pin"],
        basis: "money_pin",
        observed_at: obs.when,
        input_value: pin,
      });
      if (provenance) {
        // Registry path when both kinds are in shares_authority_key vocabulary.
        const fromKind = parseSubjectRef(objectSubject)?.kind;
        if (fromKind === "notice" || fromKind === "contract" || fromKind === "vendor") {
          const edge = makeObjectLink({
            type: "shares_authority_key",
            from: objectSubject,
            to: pinRef,
            domain: "money",
            confidence: "strong",
            method: PIN_METHOD,
            method_version: PIN_METHOD_VERSION,
            provenance,
          });
          if (edge) edges.push(edge);
        }
      }
    }
  }

  // Award notice → contract (references_contract registry type)
  if (
    objectSubject
    && contractId
    && obs.object_kind !== "payment"
    && parseSubjectRef(objectSubject)?.kind === "notice"
  ) {
    const contractRef = formatSubjectRef("contract", contractId);
    if (contractRef) {
      const provenance = makeProvenance({
        source_system: obs.source_system,
        source_record_id: obs.source_record_id,
        source_fields: ["contract_id"],
        basis: "money_contract_id",
        observed_at: obs.when,
        input_value: contractId,
      });
      if (provenance) {
        const edge = makeObjectLink({
          type: "references_contract",
          from: objectSubject,
          to: contractRef,
          domain: "money",
          confidence: "strong",
          method: CONTRACT_METHOD,
          method_version: CONTRACT_METHOD_VERSION,
          provenance,
        });
        if (edge) edges.push(edge);

        // contract → agency when agency resolved (local; contract not always registry from-kind for published_by)
        const agency = obs.agency_name ? resolveAgencySubject(obs.agency_name) : null;
        if (agency) {
          const agencyEdge = makeObjectLink({
            type: "contract_published_by_agency",
            from: contractRef,
            to: agency.ref,
            domain: "money",
            confidence: "strong",
            method: CONTRACT_METHOD,
            method_version: CONTRACT_METHOD_VERSION,
            provenance: makeProvenance({
              source_system: obs.source_system,
              source_record_id: obs.source_record_id,
              source_fields: ["contract_id", "agency_name"],
              basis: "money_contract_agency",
              observed_at: obs.when,
              input_value: obs.agency_name,
            }),
          });
          if (agencyEdge) edges.push(agencyEdge);
        }
      }
    }
  }

  // Payment document → contract
  if (objectSubject && contractId && obs.object_kind === "payment") {
    const contractRef = formatSubjectRef("contract", contractId);
    const from = parseSubjectRef(objectSubject);
    // Only when payment is not already the contract subject (avoid self-edge).
    if (contractRef && from && from.ref !== contractRef) {
      const provenance = makeProvenance({
        source_system: obs.source_system,
        source_record_id: obs.source_record_id,
        source_fields: ["contract_id"],
        basis: "money_payment_contract",
        observed_at: obs.when,
        input_value: contractId,
      });
      if (provenance) {
        const edge = makeObjectLink({
          type: "payment_on_contract",
          from: objectSubject,
          to: contractRef,
          domain: "money",
          confidence: "strong",
          method: PAYMENT_METHOD,
          method_version: PAYMENT_METHOD_VERSION,
          provenance,
        });
        if (edge) edges.push(edge);
      }
    }
  }

  return edges;
}

/**
 * Emit sited_on_parcel edges for land observations that carry BBL join keys.
 * @param {object} obs
 * @returns {object[]}
 */
function parcelLinksForObservation(obs) {
  if (!obs || obs.domain !== "land") return [];
  const projectId = clean(obs.project_id);
  if (!projectId) return [];
  const projectRef = formatSubjectRef("project", projectId);
  if (!projectRef) return [];
  const bbls = [
    ...(Array.isArray(obs.bbls) ? obs.bbls : []),
    ...(obs.bbl != null ? [obs.bbl] : []),
  ]
    .map(normalizeBbl)
    .filter(Boolean)
    .slice(0, 25);
  if (!bbls.length) return [];

  const edges = [];
  for (const bbl of bbls) {
    const parcel = resolveParcelSubject(bbl);
    if (!parcel) continue;
    const provenance = makeProvenance({
      source_system: obs.source_system || "zap-bbl",
      source_record_id: `${obs.source_system || "zap-bbl"}:${projectId}:${bbl}`,
      source_fields: ["bbl", "project_id"],
      basis: "land_project_bbl",
      observed_at: obs.when,
      input_value: bbl,
    });
    if (!provenance) continue;
    const edge = makeObjectLink({
      type: "sited_on_parcel",
      from: projectRef,
      to: parcel.ref,
      domain: "land",
      confidence: "strong",
      method: "zap_bbl_project_id_v1",
      method_version: "1",
      provenance,
    });
    if (edge) edges.push(edge);
  }
  return edges;
}

function hrefForObject(obs) {
  if (obs.request_id) return `#notice/${encodeURIComponent(obs.request_id)}`;
  if (obs.project_id) return `#land?project=${encodeURIComponent(obs.project_id)}`;
  if (obs.event_id) return `#notice/`; // meetings often via notice; leave soft
  if (obs.primary_bbl || (obs.bbls && obs.bbls[0])) {
    return `#property?bbl=${encodeURIComponent(obs.primary_bbl || obs.bbls[0])}`;
  }
  return null;
}


/**
 * Index observations into a cross-domain graph keyed by root entity ref.
 * @param {Iterable<object>} observations
 * @returns {Map<string, { root: object, objects: object[], links: object[] }>}
 */
/** Link types that are join-key sidecars (not the primary identity edge per object). */
const SIDE_LINK_TYPES = new Set([
  "sited_on_parcel",
  "shares_authority_key",
  "references_contract",
  "payment_on_contract",
  "contract_published_by_agency",
  "decides_land_project",
]);

export function indexObservationsByRoot(observations) {
  const byRoot = new Map();
  // Resolve meeting → land reverse links against land projects in the same corpus
  // before identity indexing so decides_land_project edges ride with agency roots.
  const stamped = stampMeetingLandLinksOnCorpus(observations);

  for (const obs of stamped || []) {
    const { objects, links } = linkObservation(obs);
    // Identity edges (agency/vendor) share the object list order; join-key edges are extras.
    const identityLinks = (links || []).filter((l) => l && !SIDE_LINK_TYPES.has(l.type));
    const sideLinks = (links || []).filter((l) => l && SIDE_LINK_TYPES.has(l.type));

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      const edge = identityLinks[i] || null;
      const rootRef = obj.root_ref;
      if (!rootRef) continue;
      let bucket = byRoot.get(rootRef);
      if (!bucket) {
        const parsed = parseSubjectRef(rootRef);
        bucket = {
          root: {
            kind: obj.root_kind,
            ref: rootRef,
            id: parsed?.id || rootRef,
          },
          objects: [],
          links: [],
        };
        byRoot.set(rootRef, bucket);
      }
      bucket.objects.push(obj);
      if (edge) bucket.links.push(edge);
      // Attach join-key side edges (BBL, PIN, contract, payment) onto the root bucket
      // when this object participates in the same observation.
      if (sideLinks.length) {
        for (const sEdge of sideLinks) {
          if (sEdge) bucket.links.push(sEdge);
        }
      }
    }
  }

  for (const bucket of byRoot.values()) {
    bucket.links = dedupeObjectLinks(bucket.links);
    // Dedupe objects by subject_ref + domain + link_type
    const seen = new Set();
    bucket.objects = bucket.objects.filter((o) => {
      const key = `${o.domain}|${o.subject_ref}|${o.link_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return byRoot;
}

export function dedupeObjectLinks(links = []) {
  const seen = new Map();
  for (const link of links || []) {
    if (!link?.type || !link?.from || !link?.to) continue;
    const id = `${link.type}|${link.from}|${link.to}|${link.domain || ""}`;
    if (seen.has(id)) continue;
    seen.set(id, link);
  }
  return [...seen.values()].sort((a, b) =>
    String(a.from).localeCompare(String(b.from))
    || String(a.type).localeCompare(String(b.type))
    || String(a.to).localeCompare(String(b.to)),
  );
}

/**
 * Build the intelligence view for one root from a pre-built root index bucket.
 * Prefer this over re-scanning observations when the index is already materialised.
 *
 * @param {object} root resolved root (from resolveRootQuery)
 * @param {{ objects?: object[], links?: object[] }} bucket
 * @param {{ max_per_domain?: number }} [opts]
 */
export function buildEntityIntelligenceFromBucket(root, bucket, opts = {}) {
  const maxPerDomain = Math.max(1, Number(opts.max_per_domain) || 12);
  if (!root) {
    return {
      ok: false,
      version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
      reason: "unresolved_root",
      root: null,
      domains: emptyDomainBlock(),
      links: [],
      metrics: null,
    };
  }

  const displayRoot = {
    ...root,
    display_name: root.display_name || root.canonical_name || root.stem || root.id,
  };
  const objects = Array.isArray(bucket?.objects) ? bucket.objects : [];
  const rawLinks = Array.isArray(bucket?.links) ? bucket.links : [];

  const domains = {};
  for (const domain of CROSS_DOMAIN_DOMAINS) {
    const domainObjects = objects
      .filter((o) => o.domain === domain)
      .sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")))
      .slice(0, maxPerDomain);

    if (domain === "people" && domainObjects.length === 0) {
      domains[domain] = {
        status: "not_yet_ingested",
        gap_class: "not_yet_ingested",
        note:
          "Not yet shown here — person-level votes live in Legistar when the meeting-outcomes read model retains by_person rows.",
        objects: [],
        count: 0,
      };
      continue;
    }

    domains[domain] = {
      status: domainObjects.length ? "matched" : "empty",
      gap_class: domainObjects.length ? null : "empty_in_corpus",
      note: domainObjects.length
        ? null
        : `No ${domain} objects in the linked corpus resolved to this entity.`,
      objects: domainObjects,
      count: domainObjects.length,
    };
  }

  const links = dedupeObjectLinks(rawLinks);
  const domainsWithLinks = CROSS_DOMAIN_DOMAINS.filter(
    (d) => domains[d].status === "matched",
  ).length;
  const totalObjects = CROSS_DOMAIN_DOMAINS.reduce((n, d) => n + domains[d].count, 0);
  const joinKeyTypes = [
    "sited_on_parcel",
    "shares_authority_key",
    "references_contract",
    "payment_on_contract",
    "paid_to_vendor",
    "contract_published_by_agency",
    "decides_land_project",
  ];
  const join_key_link_count = links.filter((l) => joinKeyTypes.includes(l.type)).length;

  return {
    ok: true,
    version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    method: CROSS_DOMAIN_METHOD,
    method_version: CROSS_DOMAIN_METHOD_VERSION,
    root: displayRoot,
    domains,
    links,
    metrics: {
      metric: "cross_domain_object_link_coverage",
      domains_total: CROSS_DOMAIN_DOMAINS.length,
      domains_matched: domainsWithLinks,
      domains_not_yet_ingested: CROSS_DOMAIN_DOMAINS.filter(
        (d) => domains[d].status === "not_yet_ingested",
      ).length,
      domains_empty: CROSS_DOMAIN_DOMAINS.filter((d) => domains[d].status === "empty").length,
      total_linked_objects: totalObjects,
      link_count: links.length,
      join_key_link_count,
      coverage_rate: domainsWithLinks / CROSS_DOMAIN_DOMAINS.length,
    },
  };
}

/**
 * Build the intelligence view for one root entity from an observation corpus.
 *
 * @param {{ kind: 'agency'|'vendor', name?: string, id?: string, ref?: string }} rootQuery
 * @param {Iterable<object>} observations
 * @param {{ max_per_domain?: number, index?: Map }} [opts]
 * @returns {object}
 */
export function buildEntityIntelligence(rootQuery, observations, opts = {}) {
  const root = resolveRootQuery(rootQuery);
  if (!root) {
    return {
      ok: false,
      version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
      reason: "unresolved_root",
      root: null,
      domains: emptyDomainBlock(),
      links: [],
      metrics: null,
    };
  }

  // Reuse a pre-built index when provided (warehouse materialization path).
  const index = opts.index || indexObservationsByRoot(observations);
  const bucket = index.get(root.ref) || { root, objects: [], links: [] };
  return buildEntityIntelligenceFromBucket(root, bucket, opts);
}

function emptyDomainBlock() {
  const domains = {};
  for (const domain of CROSS_DOMAIN_DOMAINS) {
    domains[domain] = {
      status: "empty",
      gap_class: "empty_in_corpus",
      note: null,
      objects: [],
      count: 0,
    };
  }
  return domains;
}

/**
 * @param {{ kind: string, name?: string, id?: string, ref?: string }} query
 */
export function resolveRootQuery(query = {}) {
  const kind = clean(query.kind).toLowerCase();
  if (query.ref) {
    const parsed = parseSubjectRef(query.ref);
    if (!parsed) return null;
    if (parsed.kind === "agency") {
      const id = parsed.id.startsWith("id:") ? parsed.id.slice(3) : parsed.id;
      const fromName = clean(query.name) ? resolveAgencySubject(query.name) : null;
      return {
        kind: "agency",
        ref: parsed.ref,
        id: parsed.id,
        canonical_id: id,
        canonical_name: fromName?.canonical_name || null,
        display_name: fromName?.canonical_name || clean(query.name) || id,
      };
    }
    if (parsed.kind === "vendor") {
      const stem = parsed.id.startsWith("stem:")
        ? decodeURIComponent(parsed.id.slice(5))
        : parsed.id;
      return {
        kind: "vendor",
        ref: parsed.ref,
        id: parsed.id,
        stem,
        display_name: clean(query.name) || stem,
      };
    }
    return null;
  }

  if (kind === "agency") {
    const name = clean(query.name || query.id);
    if (!name) return null;
    // Allow bare canonical_id
    if (!/\s/.test(name) && !query.name && query.id) {
      const ref = formatSubjectRef("agency", `id:${query.id}`);
      if (!ref) return null;
      return {
        kind: "agency",
        ref,
        id: `id:${query.id}`,
        canonical_id: query.id,
        display_name: query.id,
      };
    }
    const resolved = resolveAgencySubject(name);
    if (!resolved) return null;
    return {
      kind: "agency",
      ref: resolved.ref,
      id: `id:${resolved.canonical_id}`,
      canonical_id: resolved.canonical_id,
      canonical_name: resolved.canonical_name,
      display_name: resolved.canonical_name,
    };
  }

  if (kind === "vendor") {
    const name = clean(query.name || query.id);
    if (!name) return null;
    if (String(query.id || "").startsWith("stem:") || (query.id && !query.name && !/\s/.test(query.id))) {
      const stem = String(query.id).startsWith("stem:")
        ? decodeURIComponent(String(query.id).slice(5))
        : vendorStem(query.id);
      const ref = formatSubjectRef("vendor", `stem:${encodeURIComponent(stem)}`);
      if (!ref || !stem) return null;
      return {
        kind: "vendor",
        ref,
        id: `stem:${encodeURIComponent(stem)}`,
        stem,
        display_name: query.name || stem,
      };
    }
    const resolved = resolveVendorSubject(name);
    if (!resolved) return null;
    return {
      kind: "vendor",
      ref: resolved.ref,
      id: `stem:${encodeURIComponent(resolved.stem)}`,
      stem: resolved.stem,
      display_name: resolved.display_name,
    };
  }

  return null;
}

/**
 * Build a materialization document: intelligence views for every root that has
 * ≥1 linked object, plus a small index.
 *
 * @param {Iterable<object>} observations
 * @param {{ max_per_domain?: number, max_entities?: number }} [opts]
 */
export function buildIntelligenceCorpus(observations, opts = {}) {
  const maxEntities = Math.max(1, Number(opts.max_entities) || 80);
  /** Prefer multi-domain entities; keep high-fan-out single-domain only as fillers. */
  const preferMultiDomain = opts.prefer_multi_domain !== false;
  // Single pass index — corpus no longer re-scans observations per entity.
  const index = opts.index || indexObservationsByRoot(observations);

  const entities = [];
  for (const [ref, bucket] of index) {
    if (!bucket.objects.length) continue;
    const kind = bucket.root.kind;
    // Recover a human display name from provenance input when possible.
    const sampleInput = bucket.objects.find((o) => o.provenance?.input_value)
      ?.provenance?.input_value;
    const root = resolveRootQuery({ kind, ref, name: sampleInput || undefined })
      || {
        kind,
        ref,
        id: bucket.root.id,
        display_name: sampleInput || ref,
      };
    const view = buildEntityIntelligenceFromBucket(root, bucket, opts);
    if (kind === "agency") {
      const fromName = sampleInput ? resolveAgencySubject(sampleInput) : null;
      view.root.display_name = fromName?.canonical_name
        || view.root.canonical_name
        || view.root.display_name
        || view.root.canonical_id
        || ref;
      if (fromName?.canonical_name) view.root.canonical_name = fromName.canonical_name;
    } else if (kind === "vendor") {
      view.root.display_name = sampleInput
        || view.root.display_name
        || view.root.stem
        || ref;
    }
    entities.push(view);
  }

  entities.sort((a, b) => {
    // Multi-domain first, then by object count.
    const ma = a.metrics?.domains_matched || 0;
    const mb = b.metrics?.domains_matched || 0;
    if (mb !== ma) return mb - ma;
    const ca = b.metrics?.total_linked_objects || 0;
    const cb = a.metrics?.total_linked_objects || 0;
    if (ca !== cb) return ca - cb;
    return String(a.root?.ref || "").localeCompare(String(b.root?.ref || ""));
  });

  let ranked = entities;
  if (preferMultiDomain) {
    const multi = entities.filter((e) => (e.metrics?.domains_matched || 0) >= 2);
    const rest = entities.filter((e) => (e.metrics?.domains_matched || 0) < 2);
    // Always keep all multi-domain; fill remainder with richest single-domain.
    ranked = [...multi, ...rest];
  }
  const sliced = ranked.slice(0, maxEntities);
  const byRef = {};
  for (const e of sliced) {
    if (e.root?.ref) byRef[e.root.ref] = e;
  }

  // Multi-domain entities (the point of this layer)
  const multiDomain = sliced.filter((e) => (e.metrics?.domains_matched || 0) >= 2);

  return {
    schema_version: 1,
    version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    method: CROSS_DOMAIN_METHOD,
    method_version: CROSS_DOMAIN_METHOD_VERSION,
    generated_at: new Date().toISOString(),
    entity_count: sliced.length,
    multi_domain_count: multiDomain.length,
    domains: [...CROSS_DOMAIN_DOMAINS],
    entities: sliced,
    by_ref: byRef,
    demo_refs: multiDomain.slice(0, 5).map((e) => e.root.ref),
  };
}

/**
 * Lookup one entity from a materialization doc (instant path).
 * @param {object} doc
 * @param {{ kind?: string, name?: string, id?: string, ref?: string }} query
 */
export function lookupEntityIntelligence(doc, query) {
  const root = resolveRootQuery(query);
  if (!root) {
    return {
      ok: false,
      reason: "unresolved_root",
      public_status: "not_found",
      version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    };
  }
  const hit = doc?.by_ref?.[root.ref];
  if (hit) {
    return {
      ...hit,
      ok: true,
      serve: "materialization",
      root: { ...hit.root, display_name: hit.root.display_name || root.display_name },
    };
  }
  // Miss: return honest empty view (not 404 fabrication of links)
  return {
    ok: true,
    serve: "materialization_miss",
    version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    method: CROSS_DOMAIN_METHOD,
    method_version: CROSS_DOMAIN_METHOD_VERSION,
    root: {
      ...root,
      display_name: root.display_name || root.canonical_name || root.stem || root.id,
    },
    domains: emptyDomainBlockWithPeopleGap(),
    links: [],
    metrics: {
      metric: "cross_domain_object_link_coverage",
      domains_total: CROSS_DOMAIN_DOMAINS.length,
      domains_matched: 0,
      domains_not_yet_ingested: 1,
      domains_empty: CROSS_DOMAIN_DOMAINS.length - 1,
      total_linked_objects: 0,
      link_count: 0,
      coverage_rate: 0,
    },
    note: "No cross-domain links in the current materialization for this entity.",
  };
}

function emptyDomainBlockWithPeopleGap() {
  const domains = emptyDomainBlock();
  domains.people = {
    status: "not_yet_ingested",
    gap_class: "not_yet_ingested",
    note:
      "Not yet shown here — person-level votes live in Legistar when the meeting-outcomes read model retains by_person rows.",
    objects: [],
    count: 0,
  };
  return domains;
}

// Re-export identity helpers tests may want.
export { agencyCanonicalId, vendorStem, dedupeSubjectLinks, SUBJECT_LINK_METHOD, SUBJECT_LINK_METHOD_VERSION };
