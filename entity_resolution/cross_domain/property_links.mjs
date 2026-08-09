/**
 * Property / BBL cross-domain joins.
 *
 * Data-grounded edges the Property domain can form without inventing keys:
 *   - property notice ↔ tax parcel (BBL) — exact 10-digit BBL from disposition extract
 *   - parcel ↔ ZAP project — exact BBL match on zap-bbl (project_id, bbl)
 *   - property notice → owner vendor — labeled winning-bidder / sold-to body language only
 *   - owner vendor → money awards — same vendorStem as OCP (no fuzzy invent)
 *
 * Every edge carries provenance. Empty joins stay empty (no fabricated land projects).
 */

import { vendorStem, VENDOR_STEM_METHOD, VENDOR_STEM_VERSION } from "../normalizers/index.mjs";
import {
  formatSubjectRef,
  parseSubjectRef,
  makeSubjectLink,
} from "../../worker/src/lib/subject_registry.mjs";
import {
  normalizeBbl,
  makeProvenance,
  resolveAgencySubject,
  resolveVendorSubject,
  observationFromMoneyRow,
  CROSS_DOMAIN_METHOD,
  CROSS_DOMAIN_METHOD_VERSION,
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  EXACT_KEY_EDGE_TIER,
  EXACT_KEY_EDGE_TIER_VERSION,
} from "./object_links.mjs";
import { primaryPropertyBbl, propertyLocationFromRow } from "../../site/property_location.mjs";

export { normalizeBbl };

export const PROPERTY_CROSS_DOMAIN_VERSION = "property_cross_domain_v1";
export const BBL_JOIN_METHOD = "exact_bbl_v1";
export const BBL_JOIN_METHOD_VERSION = "1.0.0";
export const OWNER_EXTRACT_METHOD = "disposition_owner_label_v1";
export const OWNER_EXTRACT_METHOD_VERSION = "1.0.0";
export const LL48_JOIN_METHOD = "exact_bbl_v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Strip HTML so disposition owner labels in City Record bodies can match. */
export function stripNoticeHtml(value) {
  return clean(
    String(value ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#\d+;/g, " "),
  );
}

/** subject_ref for a tax parcel: bbl:{digits}. */
export function bblSubjectRef(bbl) {
  const id = normalizeBbl(bbl);
  if (!id) return null;
  return formatSubjectRef("bbl", id);
}

/**
 * BBLs on a property disposition row (pre-extracted location or live extract).
 * @returns {string[]}
 */
export function bblsFromPropertyRow(row) {
  const location = row?.property_location || propertyLocationFromRow(row || {});
  const out = new Set();
  for (const b of location?.bbls || []) {
    const n = normalizeBbl(b);
    if (n) out.add(n);
  }
  const primary = normalizeBbl(primaryPropertyBbl(location));
  if (primary) out.add(primary);
  return [...out].sort();
}

/**
 * Labeled owner / winning-bidder extraction for disposition notices only.
 * Requires explicit auction-award language — never bare company names in titles.
 * @returns {{ name: string, evidence: string, basis: string } | null}
 */
export function extractDispositionOwner(row) {
  const text = stripNoticeHtml([
    row?.short_title,
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
    row?.other_info_1,
    row?.printout_1,
  ].filter(Boolean).join(" "));
  if (!text) return null;

  const patterns = [
    {
      re: /\b(?:tentative\s+)?winning\s+bidder[s]?\s*(?:is|are|:)\s+([A-Z0-9][^.;]{1,120}?)(?:\.|;|$)/i,
      basis: "winning_bidder",
    },
    {
      re: /\bhas\s+been\s+sold\s+to\s+([A-Z0-9][^.;]{1,120}?)(?:\.|;|$)/i,
      basis: "sold_to",
    },
    {
      re: /\bsuccessful\s+bidder[s]?\s*(?:is|are|:)\s+([A-Z0-9][^.;]{1,120}?)(?:\.|;|$)/i,
      basis: "successful_bidder",
    },
    {
      re: /\bdeed(?:ed)?\s+to\s+([A-Z0-9][^.;]{1,120}?)(?:\.|;|$)/i,
      basis: "deed_to",
    },
  ];
  for (const { re, basis } of patterns) {
    const m = text.match(re);
    if (!m) continue;
    // Strip trailing price / consideration language from grantee capture.
    let name = clean(m[1])
      .replace(/[,\s]+$/, "")
      .replace(/\s+for\s+\$[\d,]+(?:\.\d+)?\b.*$/i, "")
      .replace(/\s+in\s+the\s+amount\s+of\s+\$[\d,]+.*$/i, "")
      .replace(/[,\s]+$/, "");
    // Reject too-short / placeholder / infinitive-purpose fragments
    // ("Deed to permit development…" is not a grantee name).
    if (!name || name.length < 3 || /^(the|a|an|city|nyc)\b/i.test(name)) continue;
    if (/^(permit|allow|enable|facilitate|provide|construct|develop|build|use)\b/i.test(name)) {
      continue;
    }
    // Grantee names are proper nouns — require an initial capital letter.
    if (!/^[A-Z0-9]/.test(name)) continue;
    if (vendorStem(name).length < 3) continue;
    return { name, evidence: clean(m[0]).slice(0, 280), basis };
  }
  return null;
}

/**
 * Shape a property-domain observation (City Record Property Disposition notice).
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromPropertyRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "city_record");
  const requestId = clean(row.request_id || row.id);
  const agencyName = clean(row.agency_name);
  if (!requestId || !agencyName) return null;

  // Prefer Property Disposition; allow explicit domain stamp for fixtures.
  const section = clean(row.section_name);
  if (section && section !== "Property Disposition" && row.domain !== "property") {
    return null;
  }

  const bbls = bblsFromPropertyRow(row);
  const owner = extractDispositionOwner(row);
  const subject_ref = formatSubjectRef("notice", requestId);

  return {
    domain: "property",
    object_kind: "disposition",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${requestId}`,
    native_key: requestId,
    request_id: requestId,
    agency_name: agencyName,
    vendor_name: owner?.name || null,
    owner_basis: owner?.basis || null,
    owner_evidence: owner?.evidence || null,
    label: clean(row.short_title) || requestId,
    when: clean(row.event_date || row.start_date) || null,
    bbls,
    primary_bbl: bbls[0] || null,
    disposition_stage: clean(row.disposition_stage) || null,
    type_of_notice: clean(row.type_of_notice_description) || null,
    subject_ref,
  };
}

/**
 * Shape a zap-bbl row into a parcel observation for join (project_id + bbl required).
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromZapBblRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = clean(opts.sourceSystem || row.source_system || "zap-bbl");
  const projectId = clean(row.project_id || row.projectid);
  const bbl = normalizeBbl(row.bbl);
  if (!projectId || !bbl) return null;
  return {
    domain: "land",
    object_kind: "project_parcel",
    source_system: sourceSystem,
    source_record_id: `${sourceSystem}:${projectId}:${bbl}`,
    native_key: `${projectId}:${bbl}`,
    project_id: projectId,
    bbl,
    label: clean(row.project_name) || projectId,
    when: clean(row.as_of || row.observed_at) || null,
    subject_ref: formatSubjectRef("project", projectId),
  };
}

/**
 * Build provenance-stamped edges for one property observation:
 *   notice → agency, notice → bbl (per BBL), notice → owner vendor (when labeled).
 * Does not invent ZAP joins — call linkPropertyBblsToProjects separately.
 *
 * @param {object} obs from observationFromPropertyRow
 * @returns {{ objects: object[], links: object[], parcel_refs: string[] }}
 */
export function linkPropertyObservation(obs) {
  if (!obs || obs.domain !== "property" || !obs.subject_ref) {
    return { objects: [], links: [], parcel_refs: [] };
  }
  const objects = [];
  const links = [];
  const parcel_refs = [];

  const agency = resolveAgencySubject(obs.agency_name);
  if (agency) {
    const provenance = makeProvenance({
      source_system: obs.source_system,
      source_record_id: obs.source_record_id,
      source_fields: ["agency_name"],
      basis: "property_agency_name",
      observed_at: obs.when,
      input_value: obs.agency_name,
    });
    if (provenance) {
      const edge = {
        type: "published_by_agency",
        from: obs.subject_ref,
        to: agency.ref,
        domain: "property",
        confidence: "strong",
        method: "agency_canonical_v1",
        method_version: "1",
        provenance,
        layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
      };
      links.push(edge);
      objects.push({
        subject_ref: obs.subject_ref,
        domain: "property",
        object_kind: obs.object_kind,
        label: obs.label,
        when: obs.when,
        request_id: obs.request_id,
        bbls: obs.bbls || [],
        primary_bbl: obs.primary_bbl || null,
        root_ref: agency.ref,
        root_kind: "agency",
        href: `#notice/${encodeURIComponent(obs.request_id)}`,
        provenance,
        link_type: "published_by_agency",
        confidence: "strong",
        method: edge.method,
      });
    }
  }

  if (obs.vendor_name) {
    const vendor = resolveVendorSubject(obs.vendor_name);
    if (vendor) {
      const provenance = makeProvenance({
        source_system: obs.source_system,
        source_record_id: obs.source_record_id,
        source_fields: ["additional_description_1", "short_title"],
        basis: obs.owner_basis || "disposition_owner",
        observed_at: obs.when,
        input_value: obs.vendor_name,
      });
      if (provenance) {
        const edge = {
          type: "named_owner",
          from: obs.subject_ref,
          to: vendor.ref,
          domain: "property",
          confidence: "tentative",
          method: OWNER_EXTRACT_METHOD,
          method_version: OWNER_EXTRACT_METHOD_VERSION,
          provenance: {
            ...provenance,
            evidence: obs.owner_evidence || null,
          },
          layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
        };
        links.push(edge);
        objects.push({
          subject_ref: obs.subject_ref,
          domain: "property",
          object_kind: obs.object_kind,
          label: obs.label,
          when: obs.when,
          request_id: obs.request_id,
          bbls: obs.bbls || [],
          primary_bbl: obs.primary_bbl || null,
          root_ref: vendor.ref,
          root_kind: "vendor",
          href: `#notice/${encodeURIComponent(obs.request_id)}`,
          provenance: edge.provenance,
          link_type: "named_owner",
          confidence: "tentative",
          method: edge.method,
        });
      }
    }
  }

  for (const bbl of obs.bbls || []) {
    const parcelRef = bblSubjectRef(bbl);
    if (!parcelRef) continue;
    parcel_refs.push(parcelRef);
    const provenance = makeProvenance({
      source_system: obs.source_system,
      source_record_id: obs.source_record_id,
      source_fields: ["property_location.bbls", "tax_lots"],
      basis: "exact_bbl",
      observed_at: obs.when,
      input_value: bbl,
      join_key: "bbl",
      join_value: bbl,
      match: "exact",
      tier: EXACT_KEY_EDGE_TIER,
    });
    if (!provenance) continue;
    links.push({
      type: "sits_on_parcel",
      from: obs.subject_ref,
      to: parcelRef,
      domain: "property",
      confidence: "strong",
      method: BBL_JOIN_METHOD,
      method_version: BBL_JOIN_METHOD_VERSION,
      provenance,
      tier: EXACT_KEY_EDGE_TIER,
      tier_version: EXACT_KEY_EDGE_TIER_VERSION,
      layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    });
  }

  return { objects, links, parcel_refs: [...new Set(parcel_refs)].sort() };
}

/**
 * Exact BBL join: property notices ↔ ZAP projects via zap-bbl rows.
 * @param {object[]} propertyObservations
 * @param {object[]} zapBblRows — { project_id, bbl, ... }
 * @param {object[]} [zapProjects] — optional project metadata for labels
 * @returns {{ links: object[], by_bbl: object, metrics: object }}
 */
export function joinPropertyToZapByBbl(propertyObservations = [], zapBblRows = [], zapProjects = []) {
  const projectMeta = new Map();
  for (const p of zapProjects || []) {
    const id = clean(p.project_id || p.id);
    if (id) projectMeta.set(id, p);
  }

  /** bbl → Set of project_id */
  const bblToProjects = new Map();
  for (const row of zapBblRows || []) {
    const bbl = normalizeBbl(row.bbl);
    const projectId = clean(row.project_id || row.projectid);
    if (!bbl || !projectId) continue;
    if (!bblToProjects.has(bbl)) bblToProjects.set(bbl, new Set());
    bblToProjects.get(bbl).add(projectId);
  }

  const links = [];
  const by_bbl = {};
  let pairCount = 0;

  const noticeSummary = (obs) => ({
    request_id: obs.request_id,
    subject_ref: obs.subject_ref,
    label: obs.label,
    when: obs.when || null,
    date_basis: obs.when ? "City Record event/start date" : null,
    agency_name: obs.agency_name || null,
    disposition_stage: obs.disposition_stage || null,
    source: "City Record Online",
    relation: "sits_on_parcel",
    confidence: "strong",
    method: BBL_JOIN_METHOD,
    href: `#notice/${encodeURIComponent(obs.request_id)}`,
  });

  for (const obs of propertyObservations || []) {
    if (!obs?.subject_ref || obs.domain !== "property") continue;
    for (const bbl of obs.bbls || []) {
      const projects = bblToProjects.get(bbl);
      if (!projects || !projects.size) {
        if (!by_bbl[bbl]) {
          by_bbl[bbl] = {
            bbl,
            parcel_ref: bblSubjectRef(bbl),
            property_notices: [],
            land_projects: [],
            status: "no_zap_match",
          };
        }
        by_bbl[bbl].property_notices.push(noticeSummary(obs));
        continue;
      }
      if (!by_bbl[bbl]) {
        by_bbl[bbl] = {
          bbl,
          parcel_ref: bblSubjectRef(bbl),
          property_notices: [],
          land_projects: [],
          status: "matched",
        };
      }
      by_bbl[bbl].property_notices.push(noticeSummary(obs));
      for (const projectId of projects) {
        const projectRef = formatSubjectRef("project", projectId);
        const parcelRef = bblSubjectRef(bbl);
        const meta = projectMeta.get(projectId) || {};
        const provenance = makeProvenance({
          source_system: "zap-bbl",
          source_record_id: `zap-bbl:${projectId}:${bbl}`,
          source_fields: ["project_id", "bbl"],
          basis: "exact_bbl",
          input_value: bbl,
          join_key: "bbl",
          join_value: bbl,
          match: "exact",
          tier: EXACT_KEY_EDGE_TIER,
          source_url: `https://zap.planning.nyc.gov/projects/${encodeURIComponent(projectId)}`,
        });
        if (!provenance || !projectRef || !parcelRef) continue;

        // notice → project via shared parcel (property → land-use)
        links.push({
          type: "parcel_links_project",
          from: obs.subject_ref,
          to: projectRef,
          domain: "property",
          confidence: "strong",
          method: BBL_JOIN_METHOD,
          method_version: BBL_JOIN_METHOD_VERSION,
          bbl,
          provenance: {
            ...provenance,
            via_parcel: parcelRef,
            property_request_id: obs.request_id,
          },
          tier: EXACT_KEY_EDGE_TIER,
          tier_version: EXACT_KEY_EDGE_TIER_VERSION,
          layer: PROPERTY_CROSS_DOMAIN_VERSION,
        });
        // project → parcel
        links.push({
          type: "sits_on_parcel",
          from: projectRef,
          to: parcelRef,
          domain: "land",
          confidence: "strong",
          method: BBL_JOIN_METHOD,
          method_version: BBL_JOIN_METHOD_VERSION,
          provenance,
          tier: EXACT_KEY_EDGE_TIER,
          tier_version: EXACT_KEY_EDGE_TIER_VERSION,
          layer: PROPERTY_CROSS_DOMAIN_VERSION,
        });
        pairCount += 1;
        by_bbl[bbl].land_projects.push({
          project_id: projectId,
          subject_ref: projectRef,
          label: clean(meta.project_name) || projectId,
          public_status: clean(meta.public_status) || null,
          when: clean(meta.completed_date || meta.approval_date || meta.current_milestone_date
            || meta.noticed_date || meta.app_filed_date) || null,
          date_basis: meta.completed_date ? "ZAP completed date"
            : meta.approval_date ? "ZAP approval date"
              : meta.current_milestone_date ? "ZAP current milestone date"
                : meta.noticed_date ? "ZAP noticed date"
                  : meta.app_filed_date ? "ZAP application filed date" : null,
          source: "ZAP / zap-bbl",
          relation: "sits_on_parcel",
          confidence: "strong",
          method: BBL_JOIN_METHOD,
          href: `#land?project=${encodeURIComponent(projectId)}`,
        });
        by_bbl[bbl].status = "matched";
      }
    }
  }

  // Dedupe land_projects per bbl
  for (const bucket of Object.values(by_bbl)) {
    const seen = new Set();
    bucket.land_projects = (bucket.land_projects || []).filter((p) => {
      if (seen.has(p.project_id)) return false;
      seen.add(p.project_id);
      return true;
    });
    const nSeen = new Set();
    bucket.property_notices = (bucket.property_notices || []).filter((n) => {
      if (nSeen.has(n.request_id)) return false;
      nSeen.add(n.request_id);
      return true;
    });
  }

  const bblCount = Object.keys(by_bbl).length;
  const matchedBbls = Object.values(by_bbl).filter((b) => b.status === "matched").length;

  return {
    links,
    by_bbl,
    metrics: {
      metric: "property_bbl_zap_join_rate",
      property_bbl_zap_join_rate: bblCount ? matchedBbls / bblCount : 0,
      bbl_count: bblCount,
      matched_bbl_count: matchedBbls,
      link_pair_count: pairCount,
      method: BBL_JOIN_METHOD,
    },
  };
}

/**
 * Owner vendor → money awards (same vendorStem). Honest empty when no money row matches.
 * @param {object[]} propertyObservations
 * @param {object[]} moneyRows
 * @returns {{ links: object[], by_owner: object, metrics: object }}
 */
export function joinPropertyOwnerToContracts(propertyObservations = [], moneyRows = []) {
  const moneyObs = (moneyRows || [])
    .map((r) => (r.domain === "money" ? r : observationFromMoneyRow(r)))
    .filter(Boolean);

  const byStem = new Map();
  for (const m of moneyObs) {
    if (!m.vendor_name) continue;
    const stem = vendorStem(m.vendor_name);
    if (!stem) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(m);
  }

  const links = [];
  const by_owner = {};
  let ownersWithContracts = 0;
  let ownerCount = 0;

  for (const obs of propertyObservations || []) {
    if (!obs?.vendor_name || !obs.subject_ref) continue;
    const vendor = resolveVendorSubject(obs.vendor_name);
    if (!vendor) continue;
    ownerCount += 1;
    const awards = byStem.get(vendor.stem) || [];
    by_owner[vendor.stem] = {
      stem: vendor.stem,
      display_name: obs.vendor_name,
      vendor_ref: vendor.ref,
      property_notices: [
        {
          request_id: obs.request_id,
          subject_ref: obs.subject_ref,
          label: obs.label,
        },
      ],
      contracts: awards.map((m) => ({
        request_id: m.request_id,
        subject_ref: m.subject_ref,
        pin: m.pin,
        label: m.label,
        when: m.when,
        amount: m.amount,
        href: m.request_id ? `#notice/${encodeURIComponent(m.request_id)}` : null,
      })),
      status: awards.length ? "matched" : "empty",
      gap_note: awards.length
        ? null
        : "No money awards in the linked corpus share this owner stem — not proof the owner has zero city contracts.",
    };
    if (!awards.length) continue;
    ownersWithContracts += 1;
    for (const m of awards) {
      if (!m.subject_ref) continue;
      const provenance = makeProvenance({
        source_system: m.source_system,
        source_record_id: m.source_record_id,
        source_fields: ["vendor_name"],
        basis: "owner_vendor_stem",
        input_value: obs.vendor_name,
      });
      if (!provenance) continue;
      links.push({
        type: "owner_has_award",
        from: vendor.ref,
        to: m.subject_ref,
        domain: "money",
        confidence: "tentative",
        method: VENDOR_STEM_METHOD,
        method_version: VENDOR_STEM_VERSION,
        provenance: {
          ...provenance,
          via_property_notice: obs.request_id,
          owner_extract_method: OWNER_EXTRACT_METHOD,
        },
        layer: PROPERTY_CROSS_DOMAIN_VERSION,
      });
    }
  }

  return {
    links,
    by_owner,
    metrics: {
      metric: "property_owner_contract_join_rate",
      property_owner_contract_join_rate: ownerCount ? ownersWithContracts / ownerCount : 0,
      owner_count: ownerCount,
      owners_with_contracts: ownersWithContracts,
      link_count: links.length,
      method: VENDOR_STEM_METHOD,
    },
  };
}

function ll48EvidenceItem(row, bbl) {
  const sourceRecordId = `4e2n-s75z:bbl:${bbl}`;
  return {
    id: sourceRecordId,
    bbl,
    label: clean(row.parcel_name || row.address || bbl),
    address: clean(row.address) || null,
    agency: clean(row.agency) || null,
    current_uses: clean(row.current_uses) || null,
    potential_urban_ag: clean(row.potential_urban_ag) || null,
    source: "NYC Open Data · LL48 suitability",
    source_url: "https://data.cityofnewyork.us/d/4e2n-s75z",
    observed_at: row._source_observed_at || null,
    confidence: "strong",
    method: LL48_JOIN_METHOD,
    provenance: {
      source_system: "socrata:4e2n-s75z",
      source_record_id: sourceRecordId,
      source_fields: ["bbl"],
      basis: "exact_bbl",
      input_value: bbl,
    },
  };
}

/** Exact BBL graph-slice join for LL48 suitability rows. */
export function joinPropertyToLl48ByBbl(eligibleBbls = [], ll48Rows = []) {
  const eligible = new Set((eligibleBbls || []).map(normalizeBbl).filter(Boolean));
  const by_bbl = {};
  for (const row of ll48Rows || []) {
    const bbl = normalizeBbl(row?.bbl);
    if (!bbl || !eligible.has(bbl)) continue;
    if (!by_bbl[bbl]) by_bbl[bbl] = { bbl, items: [], status: "matched" };
    by_bbl[bbl].items.push(ll48EvidenceItem(row, bbl));
  }
  const linked = Object.keys(by_bbl).length;
  return {
    by_bbl,
    metrics: {
      eligible: eligible.size,
      linked,
      rate: eligible.size ? Number((linked / eligible.size).toFixed(4)) : 0,
      method: LL48_JOIN_METHOD,
    },
  };
}

/**
 * Assemble a parcel-centric property intelligence view for one BBL.
 * Grounded only in supplied rows — never invents ZAP/contract hits.
 *
 * @param {string} bbl
 * @param {{
 *   propertyRows?: object[],
 *   zapBblRows?: object[],
 *   zapProjects?: object[],
 *   moneyRows?: object[],
 * }} corpus
 */
export function buildParcelIntelligence(bbl, corpus = {}) {
  const id = normalizeBbl(bbl);
  if (!id) {
    return {
      ok: false,
      reason: "invalid_bbl",
      version: PROPERTY_CROSS_DOMAIN_VERSION,
    };
  }
  const propertyObs = (corpus.propertyRows || [])
    .map((r) => coercePropertyObservation(r))
    .filter((o) => o && (o.bbls || []).includes(id));

  const zapJoin = joinPropertyToZapByBbl(
    propertyObs,
    corpus.zapBblRows || [],
    corpus.zapProjects || [],
  );
  const ownerJoin = joinPropertyOwnerToContracts(propertyObs, corpus.moneyRows || []);
  const ll48Rows = (corpus.ll48Rows || []).filter((row) => normalizeBbl(row?.bbl) === id);
  const bucket = zapJoin.by_bbl[id] || {
    bbl: id,
    parcel_ref: bblSubjectRef(id),
    property_notices: propertyObs.map((o) => ({
      request_id: o.request_id,
      subject_ref: o.subject_ref,
      label: o.label,
    })),
    land_projects: [],
    status: propertyObs.length ? "no_zap_match" : "empty",
  };

  const owners = [];
  for (const o of propertyObs) {
    if (!o.vendor_name) continue;
    const v = resolveVendorSubject(o.vendor_name);
    if (!v) continue;
    owners.push({
      name: o.vendor_name,
      vendor_ref: v.ref,
      stem: v.stem,
      basis: o.owner_basis,
      contracts: ownerJoin.by_owner[v.stem]?.contracts || [],
    });
  }

  // Agency roots on these notices (for land-use agency context)
  const agencies = [];
  const seenAgency = new Set();
  for (const o of propertyObs) {
    const a = resolveAgencySubject(o.agency_name);
    if (!a || seenAgency.has(a.ref)) continue;
    seenAgency.add(a.ref);
    agencies.push({ ref: a.ref, name: a.canonical_name || o.agency_name });
  }

  const landMatched = bucket.land_projects.length > 0;
  const propertyMatched = propertyObs.length > 0;

  return {
    ok: true,
    version: PROPERTY_CROSS_DOMAIN_VERSION,
    method: BBL_JOIN_METHOD,
    method_version: BBL_JOIN_METHOD_VERSION,
    bbl: id,
    parcel_ref: bblSubjectRef(id),
    property: {
      status: propertyMatched ? "matched" : "empty",
      notices: propertyObs.map((o) => ({
        request_id: o.request_id,
        subject_ref: o.subject_ref,
        label: o.label,
        when: o.when,
        agency_name: o.agency_name,
        disposition_stage: o.disposition_stage,
        href: `#notice/${encodeURIComponent(o.request_id)}`,
      })),
      count: propertyObs.length,
    },
    land: {
      status: landMatched ? "matched" : propertyMatched ? "empty" : "empty",
      gap_class: landMatched ? null : "empty_in_corpus",
      note: landMatched
        ? null
        : propertyMatched
          ? "No ZAP project in the linked corpus shares this exact BBL — not proof no land-use application exists citywide."
          : "No property disposition notices for this BBL in the corpus.",
      projects: bucket.land_projects,
      count: bucket.land_projects.length,
    },
    owners: {
      status: owners.length ? "matched" : "empty",
      note: owners.length
        ? null
        : "No labeled winning-bidder / sold-to owner in these disposition notices.",
      items: owners,
      count: owners.length,
    },
    ll48: {
      status: ll48Rows.length ? "matched" : "empty",
      items: ll48Rows.map((row) => ll48EvidenceItem(row, id)),
      count: ll48Rows.length,
    },
    agencies,
    links: [
      ...zapJoin.links.filter((l) => l.bbl === id || l.provenance?.input_value === id
        || (l.to && l.to.endsWith(id)) || (l.from && String(l.provenance?.via_parcel || "").includes(id))),
      ...ownerJoin.links.filter((l) =>
        owners.some((o) => o.vendor_ref === l.from),
      ),
    ],
    metrics: {
      property_notice_count: propertyObs.length,
      land_project_count: bucket.land_projects.length,
      owner_count: owners.length,
      owner_contract_count: owners.reduce((n, o) => n + (o.contracts?.length || 0), 0),
    },
    honesty: {
      zap_bbl_required: true,
      owner_requires_labeled_language: true,
      money_join_is_stem_only: true,
    },
  };
}

/**
 * Coerce a raw disposition row or a pre-shaped property observation.
 * Rows stamped domain=property without subject_ref/bbls (live feed snapshots)
 * still need observationFromPropertyRow — do not treat domain alone as shaped.
 */
export function coercePropertyObservation(row) {
  if (!row || typeof row !== "object") return null;
  if (
    row.domain === "property" &&
    row.subject_ref &&
    Array.isArray(row.bbls) &&
    row.request_id
  ) {
    return row;
  }
  return observationFromPropertyRow(row);
}

/**
 * Build a materialization slice of property cross-domain joins for the product.
 */
export function buildPropertyCrossDomainDoc(corpus = {}) {
  const propertyObs = (corpus.propertyRows || [])
    .map((r) => coercePropertyObservation(r))
    .filter(Boolean);
  const zapJoin = joinPropertyToZapByBbl(
    propertyObs,
    corpus.zapBblRows || [],
    corpus.zapProjects || [],
  );
  const ownerJoin = joinPropertyOwnerToContracts(propertyObs, corpus.moneyRows || []);
  const ll48Join = joinPropertyToLl48ByBbl(Object.keys(zapJoin.by_bbl), corpus.ll48Rows || []);
  for (const [bbl, evidence] of Object.entries(ll48Join.by_bbl)) {
    if (zapJoin.by_bbl[bbl]) zapJoin.by_bbl[bbl].ll48 = evidence;
  }

  // Agency-rooted property objects for entity intelligence merge
  const agencyObjects = [];
  const agencyLinks = [];
  for (const obs of propertyObs) {
    const { objects, links } = linkPropertyObservation(obs);
    agencyObjects.push(...objects);
    agencyLinks.push(...links);
  }

  const agencyLinkCount = agencyLinks.filter((l) => l.type === "published_by_agency").length;
  const ownerLinkCount = agencyLinks.filter((l) => l.type === "named_owner").length;
  const parcelLinkCount = agencyLinks.filter((l) => l.type === "sits_on_parcel").length;
  const bblCount = zapJoin.metrics.bbl_count;
  const matchedBblCount = zapJoin.metrics.matched_bbl_count;
  const rowsWithBbl = propertyObs.filter((o) => (o.bbls || []).length > 0).length;
  const observationCount = propertyObs.length;
  const fractionWithBbl = observationCount ? rowsWithBbl / observationCount : 0;
  const zapMatchedFraction = bblCount ? matchedBblCount / bblCount : 0;

  const coverage = {
    by_bbl_count: bblCount,
    property_observation_count: observationCount,
    property_rows_with_bbl: rowsWithBbl,
    fraction_observations_with_bbl: Number(fractionWithBbl.toFixed(4)),
    zap_matched_bbl_count: matchedBblCount,
    zap_matched_fraction: Number(zapMatchedFraction.toFixed(4)),
    agency_link_count: agencyLinkCount,
    owner_link_count: ownerLinkCount,
    parcel_link_count: parcelLinkCount,
    owner_count: ownerJoin.metrics.owner_count,
    owners_with_contracts: ownerJoin.metrics.owners_with_contracts,
    ll48_eligible_bbl_count: ll48Join.metrics.eligible,
    ll48_linked_bbl_count: ll48Join.metrics.linked,
    ll48_bbl_join_rate: ll48Join.metrics.rate,
    ll48_vintage: (corpus.ll48Rows || [])[0]?._source_observed_at || null,
  };

  return {
    schema_version: 1,
    version: PROPERTY_CROSS_DOMAIN_VERSION,
    generated_at: new Date().toISOString(),
    property_observation_count: observationCount,
    by_bbl: zapJoin.by_bbl,
    by_owner: ownerJoin.by_owner,
    links: [...zapJoin.links, ...ownerJoin.links, ...agencyLinks],
    agency_objects: agencyObjects,
    metrics: {
      property_bbl_zap_join_rate: zapJoin.metrics.property_bbl_zap_join_rate,
      bbl_count: bblCount,
      matched_bbl_count: matchedBblCount,
      bbl_link_pair_count: zapJoin.metrics.link_pair_count,
      property_owner_contract_join_rate: ownerJoin.metrics.property_owner_contract_join_rate,
      ll48_bbl_join_rate: ll48Join.metrics.rate,
      ll48_eligible_bbl_count: ll48Join.metrics.eligible,
      ll48_linked_bbl_count: ll48Join.metrics.linked,
      owner_count: ownerJoin.metrics.owner_count,
      owners_with_contracts: ownerJoin.metrics.owners_with_contracts,
      owner_contract_link_count: ownerJoin.metrics.link_count,
      property_agency_link_count: agencyLinkCount,
      property_owner_link_count: ownerLinkCount,
      property_parcel_link_count: parcelLinkCount,
      property_rows_with_bbl: rowsWithBbl,
      fraction_observations_with_bbl: coverage.fraction_observations_with_bbl,
    },
    coverage,
    provenance: {
      sources: [
        "city_record Property Disposition",
        "property-locations materialization / property_domain_observations",
        "zap-bbl (2iga-a6mk)",
        "ocp-recent-contract-awards",
        "suitability-city-owned-leased-property-ll48 (4e2n-s75z)",
      ],
      methods: [BBL_JOIN_METHOD, OWNER_EXTRACT_METHOD, VENDOR_STEM_METHOD, "agency_canonical_v1"],
      coverage,
      note:
        "BBL→ZAP and BBL→LL48 are exact tax-lot joins only; suitability rows are a graph-BBL slice. Owner→contract is vendorStem only when a labeled winning bidder exists. Agency + parcel edges densify from every disposition row with a BBL. No fuzzy address geocode invents land links.",
    },
  };
}
