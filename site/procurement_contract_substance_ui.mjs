/**
 * Resident projection of the typed contract-substance model onto the
 * canonical procurement document.
 *
 * Projects the materialized substance, access, and service-geography
 * documents into one "What this contract requires" section: what the City
 * bought, how payment is calculated, what the vendor promised, and where the
 * work applies. Every displayed row comes from an admitted typed fact and
 * opens its cited passage; advertised evidence stays visually and verbally
 * distinct from executed terms, and only executed roles may appear beneath
 * "What the vendor promised". Missing optional facts stay quiet, bounded
 * absences stay specific, and a failed or inapplicable load renders nothing
 * rather than a successful empty result.
 */

import {
  CONTRACT_SUBSTANCE_SCHEMA,
  EVIDENCE_ROLES,
  FACT_KINDS,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
  residentPositiveAssertions,
} from "./procurement_contract_substance_contract.mjs";
import {
  ACCESS_STATES,
  CONTRACT_SUBSTANCE_ACCESS_SCHEMA,
  DOCUMENT_ROLES,
  indexAccessObservations,
} from "./procurement_contract_substance_access.mjs";
import {
  CONTRACT_SERVICE_GEOGRAPHY_SCHEMA,
  CONTRACT_PLACE_ROLES,
} from "./procurement_contract_service_geography.mjs";
import { nearYouUrlFromScope } from "./scope_v0.mjs";
import { renderNodeSection } from "./civic_document_chrome.mjs";

export const SUBSTANCE_SECTION_ID = "procurement-contract-substance";
export const SUBSTANCE_HEADING_ID = "procurement-contract-substance-heading";
export const SUBSTANCE_ACCESS_NOTE_ATTR = "data-substance-access-limit";

const PLACE_ROLE_LABELS = Object.freeze({
  [CONTRACT_PLACE_ROLES.FACILITY_SITE]: "Facility site",
  [CONTRACT_PLACE_ROLES.WORK_SITE]: "Work site",
  [CONTRACT_PLACE_ROLES.DELIVERY_SITE]: "Delivery site",
  [CONTRACT_PLACE_ROLES.SERVICE_AREA]: "Service area",
  [CONTRACT_PLACE_ROLES.BENEFICIARY_AREA]: "Beneficiary area",
});

const BROAD_SCOPE_LABELS = Object.freeze({
  citywide: "Citywide",
  boroughwide: "Boroughwide",
  multi_site: "Multiple named sites",
});

const PAYMENT_BASIS_LABELS = Object.freeze({
  unit_price: "Unit price",
  fixed_fee: "Fixed fee",
  time_and_materials: "Time and materials",
  milestone: "Milestone payments",
  percentage: "Percentage",
  not_to_exceed: "Not to exceed",
  other: "As specified",
});

const STANDING_KINDS = Object.freeze({
  [STANDING_LABELS.VENDOR_PROMISED]: "executed",
  [STANDING_LABELS.ADVERTISED]: "advertised",
  [STANDING_LABELS.REQUESTED]: "requested",
  [STANDING_LABELS.EXECUTED]: "executed",
  [STANDING_LABELS.AMENDED]: "amended",
  [STANDING_LABELS.BID_OFFER]: "bid_offer",
  [STANDING_LABELS.PROPOSED]: "proposed",
  [STANDING_LABELS.TEMPLATE]: "template",
  [STANDING_LABELS.AUDIT_REPORTED]: "audit_reported",
});

const STANDING_BADGE_LABELS = Object.freeze({
  advertised: "Advertised",
  requested: "Requested",
  executed: "Executed",
  amended: "Amended",
  bid_offer: "Bid offer",
  proposed: "Proposed agreement term",
  template: "Template pricing",
  audit_reported: "Comptroller audit",
});

const ROLE_CORPUS_SCHEMA = "cityscroll.procurement_contract_substance_role_corpus.v1";

const ROLE_EVIDENCE_HEADINGS = Object.freeze({
  performance_evaluation: "Comptroller audit reports",
  bid_tab: "DCAS bid offers",
  proposed_agreement: "GrowNYC proposed agreement terms",
  site_schedule: "Proposed site-schedule terms",
  template_pricing: "Template pricing",
});

const ROLE_EVIDENCE_LABELS = Object.freeze({
  performance_evaluation: "Comptroller audit",
  bid_tab: "Bid offer",
  proposed_agreement: "Proposed agreement term",
  site_schedule: "Proposed site-schedule term",
  template_pricing: "Template pricing",
});

/** Roles whose evidence may carry the resident vendor-promise wording. */
const PROMISE_ROLES = new Set([
  EVIDENCE_ROLES.EXECUTED_OBLIGATION,
  EVIDENCE_ROLES.EXECUTED_SCOPE,
  EVIDENCE_ROLES.AMENDMENT,
]);

/** Access roles that materially limit the four contract-substance questions. */
const SUBSTANCE_CORE_ACCESS_ROLES = Object.freeze([
  DOCUMENT_ROLES.EXECUTED_CONTRACT,
  DOCUMENT_ROLES.STATEMENT_OF_WORK,
  DOCUMENT_ROLES.PRICING_SCHEDULE,
]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function text(value, max = 500) {
  const result = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
}

function money(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));
  if (!Number.isFinite(number)) return text(value, 60);
  // Whole dollars render without forced cents, matching the page's own
  // contract-fact formatting; fractional amounts keep their cents.
  if (Number.isInteger(number)) return `$${number.toLocaleString("en-US")}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(number);
}

function normalizeContractIds(values = []) {
  const ids = new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => text(value, 160)?.toUpperCase())
      .filter(Boolean),
  );
  return [...ids];
}

function standingKind(standingLabel) {
  return STANDING_KINDS[text(standingLabel, 80)] || null;
}

function citationView(fact) {
  const href = text(fact?.public_url, 2000);
  const locator = text(fact?.locator, 240);
  const excerpt = text(fact?.excerpt, 800);
  return {
    href,
    locator,
    excerpt,
    label: text(fact?.source_document_id, 180),
  };
}

function scopeSentence(fact) {
  const bits = [
    [fact.subject, fact.action, fact.object].filter(Boolean).join(" "),
    fact.exclusions ? `Excludes ${fact.exclusions}` : "",
    fact.period ? `Period: ${fact.period}` : "",
  ].filter(Boolean);
  return text(bits.join(". "), 800);
}

function obligationSentence(fact) {
  const bits = [
    `${fact.obligated_party} shall ${fact.action} ${fact.deliverable}`.replace(/\s+/g, " ").trim(),
    fact.frequency ? `${fact.frequency}` : "",
    fact.deadline ? `due ${fact.deadline}` : "",
    fact.condition ? `(${fact.condition})` : "",
  ].filter(Boolean);
  return text(bits.join(" · "), 800);
}

function isCurrentFact(fact) {
  // Superseded rows are retained for evidence depth but never lead the view.
  return !text(fact?.superseded_by_fact_id, 120);
}

function scopeRow(fact) {
  const standing = standingKind(fact.standing_label);
  return {
    kind: "scope",
    sentence: scopeSentence(fact),
    standing,
    claim_label: text(fact.resident_claim_label, 120),
    citation: citationView(fact),
  };
}

function priceRow(fact) {
  const standing = standingKind(fact.standing_label);
  const rate = fact.rate != null ? money(fact.rate) : null;
  const maximum = fact.maximum != null ? money(fact.maximum) : null;
  const quantity = fact.quantity != null && Number.isFinite(Number(fact.quantity))
    ? String(Number(fact.quantity))
    : null;
  const unit = text(fact.unit, 40);
  const rateBits = [
    rate ? `${rate}${unit ? ` per ${unit}` : ""}` : null,
    quantity && quantity !== "1" ? `${quantity} ${unit || "units"}` : null,
    maximum ? `up to ${maximum}` : null,
  ].filter(Boolean);
  return {
    kind: "price",
    basis: text(fact.payment_basis, 40),
    basis_label: PAYMENT_BASIS_LABELS[text(fact.payment_basis, 40)] || "As specified",
    description: text(fact.description, 400),
    rate_text: rateBits.join(" · ") || null,
    period: text(fact.period || fact.option_period, 120),
    conditions: text(fact.conditions, 400),
    standing,
    claim_label: text(fact.resident_claim_label, 120),
    amends_prior: Boolean(text(fact.supersedes_fact_id, 120)),
    citation: citationView(fact),
  };
}

function promiseRow(fact) {
  const standing = standingKind(fact.standing_label);
  return {
    kind: "promise",
    sentence: obligationSentence(fact),
    frequency: text(fact.frequency, 80),
    deadline: text(fact.deadline, 80),
    condition: text(fact.condition, 400),
    standing,
    claim_label: text(fact.resident_claim_label, 120),
    amends_prior: Boolean(text(fact.supersedes_fact_id, 120)),
    citation: citationView(fact),
  };
}

function roleCorpusRows(roleCorpus, idSet) {
  if (roleCorpus?.schema !== ROLE_CORPUS_SCHEMA || !Array.isArray(roleCorpus.rows)) return [];
  return roleCorpus.rows.filter((row) => {
    const checks = [
      row?.status === "admitted",
      row?.resident_assertion === true,
      row?.provenance_class === "real_source",
      idSet.has(text(row.contract_id, 160)?.toUpperCase()),
      Object.hasOwn(ROLE_EVIDENCE_HEADINGS, text(row.document_role, 80)),
      Boolean(text(row.public_url, 2000)),
      Boolean(text(row.locator, 240)),
      Boolean(text(row.excerpt, 800)),
      Boolean(text(row.content_hash, 100)),
      Boolean(text(row.excerpt_hash, 100)),
      Boolean(text(row.extraction_quality, 80)),
      Boolean(text(row.projector_version, 160)),
    ];
    return checks.every(Boolean);
  });
}

function roleCorpusRow(fact) {
  const role = text(fact.document_role, 80);
  const row = fact.kind === FACT_KINDS.PRICE_TERM
    ? priceRow(fact)
    : fact.kind === FACT_KINDS.OBLIGATION
      ? promiseRow(fact)
      : scopeRow(fact);
  return {
    ...row,
    source_role: role,
    source_role_label: ROLE_EVIDENCE_LABELS[role],
  };
}

function roleEvidenceGroups(rows) {
  const order = [
    "performance_evaluation",
    "bid_tab",
    "proposed_agreement",
    "site_schedule",
    "template_pricing",
  ];
  return order
    .map((role) => ({
      role,
      heading: ROLE_EVIDENCE_HEADINGS[role],
      rows: rows.filter((row) => row.source_role === role),
    }))
    .filter((group) => group.rows.length);
}

function geographyLink(match, index) {
  const key = text(match?.key, 120);
  if (!key) return null;
  let href = null;
  try {
    href = nearYouUrlFromScope({
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["money"] },
      place: { geographies: [key] },
    });
  } catch {
    href = null;
  }
  if (!href) return null;
  return {
    key,
    label: text(match.label, 200) || key,
    type: text(match.type, 40),
    href,
    selected: index === 0,
  };
}

function placeRow(entry) {
  const assertion = entry?.assertion;
  const resolution = entry?.resolution;
  const role = text(assertion?.place_role, 40);
  if (!role || !(role in PLACE_ROLE_LABELS)) return null;
  const input = assertion?.input || {};
  const citation = assertion?.citation || {};

  const placeLabel = text(
    input.address || input.label || input.name,
    240,
  );
  const geographies = (Array.isArray(resolution?.geographies) ? resolution.geographies : [])
    .map(geographyLink)
    .filter(Boolean);

  const row = {
    kind: "place",
    role,
    role_label: PLACE_ROLE_LABELS[role],
    place_label: placeLabel,
    units: input.units ?? entry?.units ?? null,
    geographies,
    record_href: text(citation.notice_href, 300),
    record_label: text(citation.attribution_label, 160),
    attribution_label: text(citation.attribution_label, 160),
    broad_scope: null,
    site_labels: [],
    resolution_state: text(resolution?.state, 40) || "unresolved",
  };

  if (resolution?.state === "broad_scope") {
    row.broad_scope = BROAD_SCOPE_LABELS[text(input.scope_kind, 40)] || "Multiple named sites";
    row.site_labels = (Array.isArray(input.site_labels) ? input.site_labels : [])
      .map((value) => text(value, 200))
      .filter(Boolean);
  }
  return row;
}

function substanceAccessLimit(accessIndexed, contractIds, { hasAdmittedSubstanceRows }) {
  if (hasAdmittedSubstanceRows || !accessIndexed || !contractIds.length) return null;
  const gatedRoles = [];
  const kinds = new Set();
  for (const contractId of contractIds) {
    for (const role of SUBSTANCE_CORE_ACCESS_ROLES) {
      const observation = accessIndexed.get(contractId)?.get(role);
      if (!observation) continue;
      if (observation.access_state === ACCESS_STATES.ACCOUNT_GATED
        || observation.access_state === ACCESS_STATES.METADATA_ONLY) {
        gatedRoles.push(role);
        kinds.add(observation.access_state);
      }
    }
  }
  // The note fires only when the whole substance core is sign-in bound: the
  // executed agreement, statement of work, and pricing schedule together.
  const coreSet = new Set(SUBSTANCE_CORE_ACCESS_ROLES);
  const limitedCore = SUBSTANCE_CORE_ACCESS_ROLES.filter((role) => gatedRoles.includes(role));
  if (limitedCore.length < coreSet.size || kinds.size !== 1) return null;
  return {
    kind: [...kinds][0],
    roles: limitedCore,
    observed_at: null,
  };
}

function pricingNoScheduleBasis(accessIndexed, contractIds) {
  if (!accessIndexed) return null;
  for (const contractId of contractIds) {
    const observation = accessIndexed.get(contractId)?.get(DOCUMENT_ROLES.PRICING_SCHEDULE);
    if (!observation) continue;
    if (observation.access_state === ACCESS_STATES.NOT_LOCATED) {
      return {
        basis: "not_located",
        checked_source_ids: Array.isArray(observation.checked_source_ids)
          ? observation.checked_source_ids.map((value) => text(value, 120)).filter(Boolean)
          : [],
        observed_at: text(observation.observed_at, 40),
      };
    }
  }
  return null;
}

/**
 * Build the resident contract-substance view for one procurement. Returns
 * null when the materializations are absent, malformed, scoped to other
 * contracts, or carry no renderable content — never an empty success.
 */
export function buildContractSubstanceView({
  substance = null,
  access = null,
  serviceGeography = null,
  roleCorpus = null,
  contractIds = [],
  authorizedTotal = null,
  paidTotal = null,
  paidAsOf = null,
} = {}) {
  try {
    const ids = normalizeContractIds(contractIds);
    if (!ids.length) return null;
    const idSet = new Set(ids);

    if (substance && substance.schema !== CONTRACT_SUBSTANCE_SCHEMA) return null;
    if (access && access.schema !== CONTRACT_SUBSTANCE_ACCESS_SCHEMA) return null;
    if (serviceGeography && serviceGeography.schema !== CONTRACT_SERVICE_GEOGRAPHY_SCHEMA) return null;

    const admitted = substance
      ? residentPositiveAssertions(substance).filter((row) => idSet.has(text(row.contract_id, 160)?.toUpperCase()))
      : [];
    const roleRows = roleCorpusRows(roleCorpus, idSet).map(roleCorpusRow);

    const scopeRows = admitted
      .filter((row) => row.kind === FACT_KINDS.SCOPE_FACT && isCurrentFact(row))
      .map(scopeRow)
      .filter((row) => row.sentence);

    const priceRows = admitted
      .filter((row) => row.kind === FACT_KINDS.PRICE_TERM && isCurrentFact(row))
      .map(priceRow);

    const promiseRows = admitted
      .filter((row) => row.kind === FACT_KINDS.OBLIGATION && isCurrentFact(row))
      .filter((row) => PROMISE_ROLES.has(text(row.document_role, 80))
        && (row.standing_label === STANDING_LABELS.VENDOR_PROMISED
          || row.standing_label === STANDING_LABELS.AMENDED))
      .map(promiseRow)
      .filter((row) => row.sentence);

    const roleEvidence = roleEvidenceGroups(roleRows);

    const accessIndexed = access ? indexAccessObservations(access.rows || []) : null;

    const authorized = authorizedTotal != null && authorizedTotal !== "" ? money(authorizedTotal) : null;
    const paid = paidTotal != null && paidTotal !== "" ? money(paidTotal) : null;
    const hasTotals = Boolean(authorized || paid);
    const noRateSchedule = hasTotals && !priceRows.length
      ? pricingNoScheduleBasis(accessIndexed, ids)
      : null;

    const places = serviceGeography
      ? (Array.isArray(serviceGeography.rows) ? serviceGeography.rows : [])
        .filter((entry) => entry?.kind === "contract_place"
          && idSet.has(text(entry.assertion?.contract_id, 160)?.toUpperCase()))
        .map(placeRow)
        .filter(Boolean)
        .filter((row, index, rows) => (
          // A materialization may retain verification copies of the same
          // asserted place; the resident view shows each place once.
          rows.findIndex((other) => other.role === row.role
            && other.place_label === row.place_label
            && other.record_href === row.record_href) === index
        ))
      : [];

    const accessLimit = substanceAccessLimit(accessIndexed, ids, {
      hasAdmittedSubstanceRows: Boolean(admitted.length),
    });

    const hasContent = Boolean(
      scopeRows.length
      || priceRows.length
      || promiseRows.length
      || roleEvidence.length
      || places.length
      || (hasTotals && (priceRows.length || noRateSchedule)),
    );
    if (!hasContent) {
      // Still surface a material access limit even without positive rows.
      if (!accessLimit) return null;
      return {
        contract_ids: ids,
        groups: {
          scope: [],
          pricing: {
            authorized_total: null,
            paid_total: null,
            paid_as_of: null,
            rate_rows: [],
            no_rate_schedule: null,
          },
          promises: [],
          role_evidence: roleEvidence,
          places: [],
        },
        access_limit: accessLimit,
        has_content: false,
      };
    }

    return {
      contract_ids: ids,
      groups: {
        scope: scopeRows,
        pricing: {
          authorized_total: authorized,
          paid_total: paid,
          paid_as_of: text(paidAsOf, 40),
          rate_rows: priceRows,
          no_rate_schedule: noRateSchedule,
        },
        promises: promiseRows,
        role_evidence: roleEvidence,
        places,
      },
      access_limit: accessLimit,
      has_content: true,
      role_corpus_receipt: roleEvidence.length
        ? {
          generated_at: text(roleCorpus.generated_at, 40),
          observation_vintage: text(roleCorpus.observation_vintage?.observed_at || roleCorpus.generated_at, 40),
          projector_version: text(roleCorpus.projector_version, 160),
          real_source_row_count: Number(roleCorpus.build_counts?.real_source_row_count) || roleRows.length,
        }
        : null,
    };
  } catch {
    // A malformed payload never takes the rest of the page down.
    return null;
  }
}

function standingBadge(row) {
  const kind = row.standing || "requested";
  const label = row.source_role_label || STANDING_BADGE_LABELS[kind] || "Requested";
  return `<span class="substance-standing substance-standing-${esc(kind)}">${esc(label)}</span>`;
}

function citationLink(row) {
  const { href, locator, label } = row.citation;
  if (!href) {
    return locator
      ? `<span class="substance-citation-note">${esc(locator)}</span>`
      : "";
  }
  const external = /^https?:\/\//i.test(href);
  return `<a class="substance-citation-link" href="${esc(href)}"${external ? ' rel="noopener noreferrer"' : ""}>Source passage${locator ? ` · ${esc(locator)}` : ""}${label ? ` · ${esc(label)}` : ""}</a>`;
}

function excerptDetails(row) {
  const excerpt = row.citation?.excerpt;
  if (!excerpt) return "";
  return `<details class="substance-excerpt"><summary>Cited passage</summary><blockquote>${esc(excerpt)}</blockquote></details>`;
}

function sourceRoleClaimHtml(row) {
  return row.source_role && row.claim_label
    ? `<p class="substance-row-attribution">${esc(row.claim_label)}</p>`
    : "";
}

function substanceRowHtml(row) {
  const amendBit = row.amends_prior
    ? '<span class="substance-amends-note">Amends the prior term</span>'
    : "";
  if (row.kind === "price") {
    const main = [
      row.rate_text ? `<strong>${esc(row.rate_text)}</strong>` : "",
      row.description ? esc(row.description) : "",
    ].filter(Boolean).join(" · ") || row.basis_label;
    const conditions = row.conditions ? `<p class="substance-row-conditions">${esc(row.conditions)}</p>` : "";
    return `<li class="substance-row substance-price-row" data-substance-kind="price" data-payment-basis="${esc(row.basis || "other")}">${standingBadge(row)}${sourceRoleClaimHtml(row)}<div class="substance-row-main"><p class="substance-row-text">${main}</p><p class="substance-row-meta">${esc(row.basis_label)}${row.period ? ` · ${row.period}` : ""}${amendBit ? ` · ${amendBit}` : ""}</p>${conditions}${citationLink(row)}${excerptDetails(row)}</div></li>`;
  }
  const metaBits = [
    row.condition,
    row.kind === "promise" && row.amends_prior ? "Amends the prior term" : "",
  ].filter(Boolean);
  const meta = metaBits.length ? `<p class="substance-row-meta">${esc(metaBits.join(" · "))}</p>` : "";
  return `<li class="substance-row substance-${esc(row.kind)}-row" data-substance-kind="${esc(row.kind)}">${standingBadge(row)}${sourceRoleClaimHtml(row)}<div class="substance-row-main"><p class="substance-row-text">${esc(row.sentence)}</p>${meta}${citationLink(row)}${excerptDetails(row)}</div></li>`;
}

function placeRowHtml(row) {
  const geographyLinks = row.geographies.length
    ? `<p class="substance-place-geographies">${row.geographies.map((geo) => `<a class="substance-place-geography-link${geo.selected ? " is-selected" : ""}" href="${esc(geo.href)}" data-geography-key="${esc(geo.key)}">${esc(geo.label)} · Near you</a>`).join("")}</p>`
    : "";
  const recordLink = row.record_href
    ? `<a class="substance-place-record-link" href="${esc(row.record_href)}">${esc(row.record_label || "Scoped record")}</a>`
    : "";
  const main = row.broad_scope
    ? `<strong>${esc(row.broad_scope)}</strong>${row.site_labels.length ? ` · ${esc(row.site_labels.join("; "))}` : ""}`
    : `${esc(row.place_label || row.role_label)}${row.units != null ? ` · ${esc(row.units)} units` : ""}`;
  const attribution = row.attribution_label
    ? `<p class="substance-place-attribution">Notice-attributed facility context</p>`
    : "";
  return `<li class="substance-row substance-place-row" data-substance-kind="place" data-substance-place-role="${esc(row.role)}" data-substance-resolution="${esc(row.resolution_state)}"><span class="substance-place-role">${esc(row.role_label)}</span><div class="substance-row-main"><p class="substance-row-text">${main}</p>${attribution}${geographyLinks}${recordLink}</div></li>`;
}

function pricingGroupHtml(pricing) {
  const totalBits = [];
  if (pricing.authorized_total) {
    totalBits.push(`<div><dt>Authorized contract total</dt><dd data-substance-authorized-total>${esc(pricing.authorized_total)}</dd></div>`);
  }
  if (pricing.paid_total) {
    totalBits.push(`<div><dt>Paid to date</dt><dd data-substance-paid-total>${esc(pricing.paid_total)}${pricing.paid_as_of ? ` <span class="substance-paid-as-of">(payments through ${esc(pricing.paid_as_of)})</span>` : ""}</dd></div>`);
  }
  const totals = totalBits.length
    ? `<dl class="node-facts substance-totals">${totalBits.join("")}</dl>`
    : "";
  const rates = pricing.rate_rows.length
    ? `<ul class="substance-rows">${pricing.rate_rows.map(substanceRowHtml).join("")}</ul>`
    : "";
  let noSchedule = "";
  if (pricing.no_rate_schedule && !pricing.rate_rows.length) {
    noSchedule = `<p class="substance-no-rate-schedule" data-substance-no-rate-schedule="not_located">No public rate schedule was located in the checked public sources${pricing.no_rate_schedule.observed_at ? ` as of ${esc(String(pricing.no_rate_schedule.observed_at).slice(0, 10))}` : ""}. This is a bounded search result, and does not establish that no rate schedule exists.</p>`;
  }
  const content = [totals, rates, noSchedule].filter(Boolean).join("");
  return content
    ? `<div class="substance-group substance-group-pricing"><h3 class="substance-group-heading">How payment is calculated</h3>${content}</div>`
    : "";
}

function scopeGroupHtml(rows) {
  if (!rows.length) return "";
  return `<div class="substance-group substance-group-scope"><h3 class="substance-group-heading">What the City bought</h3><ul class="substance-rows">${rows.map(substanceRowHtml).join("")}</ul></div>`;
}

function promisesGroupHtml(rows) {
  if (!rows.length) return "";
  return `<div class="substance-group substance-group-promises"><h3 class="substance-group-heading">${esc(RESIDENT_VENDOR_PROMISE_LABEL)}</h3><ul class="substance-rows">${rows.map(substanceRowHtml).join("")}</ul></div>`;
}

function placesGroupHtml(rows) {
  if (!rows.length) return "";
  return `<div class="substance-group substance-group-places"><h3 class="substance-group-heading">Where the work applies</h3><ul class="substance-rows">${rows.map(placeRowHtml).join("")}</ul></div>`;
}

function roleEvidenceGroupHtml(group) {
  return `<div class="substance-group substance-group-role-evidence" data-substance-role="${esc(group.role)}"><h3 class="substance-group-heading">${esc(group.heading)}</h3><ul class="substance-rows">${group.rows.map(substanceRowHtml).join("")}</ul></div>`;
}

function evidenceReceiptHtml(receipt, pricing) {
  if (!receipt) return "";
  const amounts = [
    pricing.authorized_total ? `authorized ${pricing.authorized_total}` : "",
    pricing.paid_total ? `paid ${pricing.paid_total}` : "",
  ].filter(Boolean).join("; ");
  const vintage = receipt.observation_vintage || receipt.generated_at;
  return `<p class="substance-evidence-receipt" data-substance-receipt="real-corpus" data-observation-vintage="${esc(vintage || "")}"${pricing.authorized_total ? ` data-observed-authorized-total="${esc(pricing.authorized_total)}"` : ""}${pricing.paid_total ? ` data-observed-paid-total="${esc(pricing.paid_total)}"` : ""}>Real-source evidence receipt${amounts ? ` · observed served amounts: ${esc(amounts)}` : ""}${vintage ? ` · data vintage ${esc(vintage)}` : ""}</p>`;
}

/**
 * Render the contract-substance section. Role-only evidence gets a neutral
 * heading so a bid, proposed term, or audit observation cannot be mistaken for
 * an executed obligation.
 */
export function renderContractSubstanceHtml(view) {
  if (!view || view.has_content !== true) return "";
  const roleOnly = (view.groups.role_evidence || []).length > 0
    && view.groups.scope.length === 0
    && view.groups.pricing.rate_rows.length === 0
    && view.groups.promises.length === 0;
  const groups = [
    scopeGroupHtml(view.groups.scope),
    pricingGroupHtml(view.groups.pricing),
    promisesGroupHtml(view.groups.promises),
    ...(view.groups.role_evidence || []).map(roleEvidenceGroupHtml),
    placesGroupHtml(view.groups.places),
  ].filter(Boolean).join("");
  if (!groups) return "";
  return renderNodeSection({
    heading: roleOnly ? "Public source evidence" : "What this contract requires",
    headingId: SUBSTANCE_HEADING_ID,
    extraClass: "procurement-contract-substance",
    attrs: { id: SUBSTANCE_SECTION_ID, "data-contract-substance": "1" },
    body: `<p class="substance-lede">${roleOnly ? "Cited passages retained from public source documents. Each row keeps its source role." : "Concise answers from the contract's own admitted terms. Every claim opens its cited passage."}</p>${evidenceReceiptHtml(view.role_corpus_receipt, view.groups.pricing)}${groups}`,
  });
}

/**
 * Render the single access-limit note placed near the official records.
 * Renders nothing unless the whole substance core is sign-in bound.
 */
export function renderContractSubstanceAccessNoteHtml(view) {
  const limit = view?.access_limit;
  if (!limit) return "";
  const kindText = limit.kind === ACCESS_STATES.METADATA_ONLY
    ? "published only as metadata without a public document"
    : "published only behind publisher sign-in";
  return `<p class="note procurement-substance-access-note" ${SUBSTANCE_ACCESS_NOTE_ATTR}="${esc(limit.kind)}">What the City bought, how payment is calculated, and what the vendor promised for this contract are ${esc(kindText)} in the publisher's records. The official sources linked on this page carry the public view.</p>`;
}

/** Geography links used by the place rows, exposed for link-integrity checks. */
export function substanceGeographyLinkKeys(view) {
  return (view?.groups?.places || []).flatMap((row) => row.geographies.map((geo) => geo.key));
}
