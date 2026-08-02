/**
 * WH-04: batch entity-resolution over warehouse rows.
 *
 * Reuses crol-list `entity_resolution/` (vendorStem, token_v0 candidates,
 * conventional matcher) and the pure exact-stem auto-link builder from
 * `worker/src/lib/entity_link.mjs`. Does not reinvent matchers in SQL.
 *
 * Pipeline (link-not-merge):
 *   1. Shape warehouse OCP (and optional second-table) rows as observations
 *   2. Exact vendor-stem auto_link → canonical vendor entities
 *   3. Agency alias normalize → canonical agency entities
 *   4. token_v0 candidates + scorePair for same/unresolved pair receipts
 *   5. Emit entity_link / canonical_entity / resolution_run records for parquet
 *
 * DuckDB SQL then joins once keys exist (see sql/examples/er_entity_links_verify.sql).
 */

import {
  buildExactStemAutoCase,
  canonicalVendorIdForStem,
  DECISION,
  EXACT_STEM_AUTO_CONFIDENCE,
} from "../../worker/src/lib/entity_link.mjs";
import {
  CANDIDATE_GENERATION_VERSION,
  generateCandidates,
  MATCHERS_VERSION,
  scorePair,
  vendorStem,
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  canonicalAgency,
  agencyCanonicalId,
} from "../../entity_resolution/index.mjs";

export const ER_BATCH_VERSION = "wh04_er_batch_v1";
export const OCP_SOURCE_SYSTEM = "ocp-recent-contract-awards";
export const DOING_BUSINESS_SOURCE_SYSTEM = "doing-business-entities";
export const AGENCY_METHOD = "agency_canonical_v1";
export const AGENCY_MATCHER_VERSION = "1";
export const PAIR_METHOD = "conventional_pair_v1";

/** FNV-1a 32-bit opaque id (same shape as entity_link.mjs). */
export function opaqueId(prefix, parts) {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${prefix}_${hex}_${raw.length.toString(16)}`;
}

/**
 * Stable source_record id for a warehouse row (publisher grain, not a merge).
 * @param {string} sourceSystem
 * @param {string|number|null|undefined} nativeKey
 */
export function sourceRecordId(sourceSystem, nativeKey) {
  const sys = String(sourceSystem || "").trim();
  const key = String(nativeKey ?? "").trim();
  if (!sys || !key) return "";
  return `${sys}:${key}`;
}

/**
 * Shape an OCP awards warehouse/SODA row into an ER observation.
 * @param {object} row
 * @param {{ sourceSystem?: string }} [opts]
 */
export function observationFromOcpRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = opts.sourceSystem || OCP_SOURCE_SYSTEM;
  const requestId =
    row.request_id != null && String(row.request_id).trim()
      ? String(row.request_id).trim()
      : null;
  const pin =
    row.pin != null && String(row.pin).trim() ? String(row.pin).trim() : null;
  const nativeKey = requestId || (pin ? `pin:${pin}` : null);
  if (!nativeKey) return null;

  const vendorName =
    row.vendor_name != null ? String(row.vendor_name).replace(/\s+/g, " ").trim() : "";
  const agencyName =
    row.agency_name != null ? String(row.agency_name).replace(/\s+/g, " ").trim() : "";

  return {
    source_record_id: sourceRecordId(sourceSystem, nativeKey),
    source_system: sourceSystem,
    native_key: nativeKey,
    request_id: requestId,
    pin,
    vendor_name: vendorName,
    agency_name: agencyName,
    display_name: vendorName,
    entity_type: "vendor",
    contract_amount:
      row.contract_amount != null && row.contract_amount !== ""
        ? String(row.contract_amount)
        : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
  };
}

/**
 * Shape a Doing Business Search Entities row (organization_name grain).
 * @param {object} row
 * @param {{ sourceSystem?: string, index?: number }} [opts]
 */
export function observationFromDoingBusinessRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const sourceSystem = opts.sourceSystem || DOING_BUSINESS_SOURCE_SYSTEM;
  const org =
    row.organization_name != null
      ? String(row.organization_name).replace(/\s+/g, " ").trim()
      : "";
  if (!org) return null;
  // Dataset has no stable public id column — use stem + ordinal for batch grain.
  const stem = vendorStem(org);
  const nativeKey = stem
    ? `stem:${stem}:${opts.index ?? 0}`
    : `name:${org.slice(0, 64)}:${opts.index ?? 0}`;
  return {
    source_record_id: sourceRecordId(sourceSystem, nativeKey),
    source_system: sourceSystem,
    native_key: nativeKey,
    vendor_name: org,
    organization_name: org,
    display_name: org,
    entity_type: "vendor",
    ownership_structure_code:
      row.ownership_structure_code != null
        ? String(row.ownership_structure_code)
        : null,
  };
}

/**
 * Exact-stem vendor auto_link cases (reuses worker pure builder).
 * @param {Array<object>} observations
 */
export function buildVendorStemLinks(observations) {
  const list = Array.isArray(observations) ? observations : [];
  const links = [];
  for (const obs of list) {
    const c = buildExactStemAutoCase(obs);
    if (!c) continue;
    links.push({
      ...c,
      source_system: obs.source_system || OCP_SOURCE_SYSTEM,
      native_key: obs.native_key || null,
      pin: obs.pin || null,
      request_id: obs.request_id || null,
    });
  }
  return links;
}

/**
 * Agency alias auto_link cases via entity_resolution agency normalizer.
 * @param {Array<object>} observations
 */
export function buildAgencyLinks(observations) {
  const list = Array.isArray(observations) ? observations : [];
  const links = [];
  for (const obs of list) {
    const agencyName = obs.agency_name;
    if (!agencyName) continue;
    const sourceRecordId = String(obs.source_record_id || "").trim();
    if (!sourceRecordId) continue;
    const { canonical_id, canonical_name } = canonicalAgency(agencyName);
    if (!canonical_id) continue;
    const canonicalEntityId = `agency:id:${canonical_id}`;
    links.push({
      source_record_id: sourceRecordId,
      source_system: obs.source_system || OCP_SOURCE_SYSTEM,
      native_key: obs.native_key || null,
      canonical_entity_id: canonicalEntityId,
      decision: DECISION.AUTO_LINK,
      confidence: EXACT_STEM_AUTO_CONFIDENCE,
      method: AGENCY_METHOD,
      matcher_version: AGENCY_MATCHER_VERSION,
      entity_type: "agency",
      display_name: canonical_name || agencyName,
      stem: canonical_id,
      evidence: {
        match: "agency_canonical",
        input_agency_name: agencyName,
        canonical_id,
        canonical_name,
        method: AGENCY_METHOD,
        matcher_version: AGENCY_MATCHER_VERSION,
      },
    });
  }
  return links;
}

/**
 * Run token_v0 candidates + conventional scorePair over observations.
 * Emits pair receipts (not all become entity_link rows).
 * @param {Array<object>} observations
 * @param {{ entityType?: string }} [opts]
 */
export function scoreObservationPairs(observations, opts = {}) {
  const list = Array.isArray(observations) ? observations : [];
  const candidates = generateCandidates(list, {
    blocker: "token_v0",
    entityType: opts.entityType || "vendor",
  });
  const pairs = [];
  for (const cand of candidates) {
    const left = cand.left || {};
    const right = cand.right || {};
    const scored = scorePair(
      {
        display_name: left.display_name || left.vendor_name,
        vendor_name: left.vendor_name,
        entity_type: left.entity_type || "vendor",
        attrs: { pin: left.pin },
      },
      {
        display_name: right.display_name || right.vendor_name,
        vendor_name: right.vendor_name,
        entity_type: right.entity_type || "vendor",
        attrs: { pin: right.pin },
      }
    );
    pairs.push({
      left_source_record_id: left.source_record_id || null,
      right_source_record_id: right.source_record_id || null,
      left_vendor_name: left.vendor_name || left.display_name || null,
      right_vendor_name: right.vendor_name || right.display_name || null,
      left_stem: vendorStem(left.vendor_name || left.display_name),
      right_stem: vendorStem(right.vendor_name || right.display_name),
      shared_keys: cand.shared_keys || [],
      blocker: cand.blocker || "token_v0",
      decision: scored.decision,
      confidence: scored.confidence,
      method: scored.method,
      matcher_version: scored.matcher_version || MATCHERS_VERSION,
    });
  }
  return pairs;
}

/**
 * Collapse auto_link cases into unique canonical_entity rows.
 * @param {Array<object>} linkCases
 */
export function canonicalEntitiesFromLinks(linkCases) {
  const byId = new Map();
  for (const c of linkCases) {
    const id = c.canonical_entity_id;
    if (!id) continue;
    const prev = byId.get(id);
    const display = c.display_name || c.stem || id;
    if (!prev) {
      byId.set(id, {
        id,
        entity_type: c.entity_type || "vendor",
        display_name: display,
        attrs_json: JSON.stringify(
          c.entity_type === "agency"
            ? { canonical_id: c.stem }
            : { stem: c.stem }
        ),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Map pair "same" decisions onto entity_link rows that share a stem target
 * when both sides already have a stem (link-not-merge: both point at same
 * canonical; we do not invent a third merge id).
 * @param {Array<object>} pairs
 * @param {Map<string, object>} stemBySourceId
 */
export function pairSameToLinks(pairs, stemBySourceId) {
  const links = [];
  for (const p of pairs) {
    if (p.decision !== "same") continue;
    const leftStem = p.left_stem || stemBySourceId.get(p.left_source_record_id)?.stem;
    const rightStem =
      p.right_stem || stemBySourceId.get(p.right_source_record_id)?.stem;
    // Prefer agreeing stems; otherwise skip (ambiguous pair same without shared stem).
    const stem =
      leftStem && rightStem && leftStem === rightStem
        ? leftStem
        : leftStem && rightStem
          ? null
          : leftStem || rightStem;
    if (!stem) continue;
    const canonicalId = canonicalVendorIdForStem(stem);
    if (!canonicalId) continue;
    for (const sid of [p.left_source_record_id, p.right_source_record_id]) {
      if (!sid) continue;
      links.push({
        source_record_id: sid,
        source_system: String(sid).split(":")[0] || OCP_SOURCE_SYSTEM,
        native_key: null,
        canonical_entity_id: canonicalId,
        decision: DECISION.AUTO_LINK,
        confidence: p.confidence,
        method: PAIR_METHOD,
        matcher_version: p.matcher_version || MATCHERS_VERSION,
        entity_type: "vendor",
        display_name: stem,
        stem,
        evidence: {
          match: "pair_same",
          pair_method: p.method,
          left_source_record_id: p.left_source_record_id,
          right_source_record_id: p.right_source_record_id,
          shared_keys: p.shared_keys,
          stem,
        },
      });
    }
  }
  return links;
}

/**
 * Deduplicate link cases by (source_record_id, method, matcher_version, decision, canonical).
 * Prefer exact-stem / agency methods over pair method when colliding on same target.
 */
export function dedupeLinkCases(cases) {
  const methodRank = {
    [VENDOR_STEM_METHOD]: 3,
    [AGENCY_METHOD]: 3,
    [PAIR_METHOD]: 1,
  };
  const byKey = new Map();
  for (const c of cases) {
    const key = [
      c.source_record_id,
      c.method,
      c.matcher_version,
      c.decision,
      c.canonical_entity_id,
    ].join("|");
    if (!byKey.has(key)) byKey.set(key, c);
  }
  // Also collapse vendor targets: one vendor link per source preferred by rank.
  const vendorBest = new Map();
  const agencyAndOther = [];
  for (const c of byKey.values()) {
    if (c.entity_type === "vendor" && c.decision === DECISION.AUTO_LINK) {
      const k = c.source_record_id;
      const prev = vendorBest.get(k);
      const rank = methodRank[c.method] || 0;
      const prevRank = prev ? methodRank[prev.method] || 0 : -1;
      if (!prev || rank > prevRank) vendorBest.set(k, c);
    } else {
      agencyAndOther.push(c);
    }
  }
  return [...vendorBest.values(), ...agencyAndOther];
}

/**
 * Full batch: observations → links + entities + pair receipts + metrics.
 *
 * @param {object} input
 * @param {Array<object>} input.ocpRows - OCP award rows
 * @param {Array<object>} [input.doingBusinessRows] - optional second table
 * @param {number} [input.limit] - cap OCP rows (default no extra cap beyond array)
 * @param {string} [input.now] - ISO timestamp
 * @param {string} [input.scopeNote]
 */
export function runErBatch(input = {}) {
  const now = input.now || new Date().toISOString();
  const limit =
    input.limit != null && Number.isFinite(Number(input.limit))
      ? Math.max(0, Number(input.limit))
      : null;

  let ocpRows = Array.isArray(input.ocpRows) ? input.ocpRows : [];
  if (limit != null) ocpRows = ocpRows.slice(0, limit);

  const ocpObs = [];
  for (const row of ocpRows) {
    const obs = observationFromOcpRow(row);
    if (obs) ocpObs.push(obs);
  }

  const dbObs = [];
  const dbRows = Array.isArray(input.doingBusinessRows)
    ? input.doingBusinessRows
    : [];
  dbRows.forEach((row, index) => {
    const obs = observationFromDoingBusinessRow(row, { index });
    if (obs) dbObs.push(obs);
  });

  const vendorObs = [...ocpObs, ...dbObs];
  const vendorStemCases = buildVendorStemLinks(vendorObs);
  const agencyCases = buildAgencyLinks(ocpObs);
  const pairs = scoreObservationPairs(vendorObs, { entityType: "vendor" });

  const stemBySource = new Map();
  for (const c of vendorStemCases) {
    stemBySource.set(c.source_record_id, c);
  }
  const pairLinks = pairSameToLinks(pairs, stemBySource);

  const allCases = dedupeLinkCases([
    ...vendorStemCases,
    ...agencyCases,
    ...pairLinks,
  ]);

  const entities = canonicalEntitiesFromLinks(allCases);

  const runId = opaqueId("run", [
    ER_BATCH_VERSION,
    VENDOR_STEM_METHOD,
    VENDOR_STEM_VERSION,
    now,
    vendorObs.length,
    input.scopeNote || "",
  ]);

  const samePairs = pairs.filter((p) => p.decision === "same");
  const unresolvedPairs = pairs.filter((p) => p.decision === "unresolved");
  const differentPairs = pairs.filter((p) => p.decision === "different");

  const vendorLinks = allCases.filter((c) => c.entity_type === "vendor");
  const agencyLinks = allCases.filter((c) => c.entity_type === "agency");
  const uniqueVendorEntities = new Set(
    vendorLinks.map((c) => c.canonical_entity_id)
  ).size;
  const uniqueAgencyEntities = new Set(
    agencyLinks.map((c) => c.canonical_entity_id)
  ).size;

  // Cross-source stem overlaps (OCP ↔ Doing Business) when both present.
  const ocpStems = new Set(
    ocpObs.map((o) => vendorStem(o.vendor_name)).filter(Boolean)
  );
  const dbStems = new Set(
    dbObs.map((o) => vendorStem(o.vendor_name)).filter(Boolean)
  );
  let crossSourceStemHits = 0;
  if (dbStems.size) {
    for (const s of ocpStems) {
      if (dbStems.has(s)) crossSourceStemHits += 1;
    }
  }

  const metrics = {
    er_batch_version: ER_BATCH_VERSION,
    ocp_rows_in: ocpRows.length,
    ocp_observations: ocpObs.length,
    doing_business_observations: dbObs.length,
    vendor_observations: vendorObs.length,
    vendor_stem_links: vendorStemCases.length,
    agency_links: agencyCases.length,
    pair_candidates: pairs.length,
    pair_same: samePairs.length,
    pair_unresolved: unresolvedPairs.length,
    pair_different: differentPairs.length,
    entity_link_rows: allCases.length,
    canonical_entities: entities.length,
    unique_vendor_entities: uniqueVendorEntities,
    unique_agency_entities: uniqueAgencyEntities,
    cross_source_stem_hits: crossSourceStemHits,
    blocker: CANDIDATE_GENERATION_VERSION,
    vendor_method: VENDOR_STEM_METHOD,
    vendor_matcher_version: VENDOR_STEM_VERSION,
    agency_method: AGENCY_METHOD,
    matchers_version: MATCHERS_VERSION,
  };

  const entityLinkRows = allCases.map((c) => {
    const linkId = opaqueId("link", [
      c.source_record_id,
      c.method,
      c.matcher_version,
      c.decision,
      c.canonical_entity_id,
    ]);
    return {
      id: linkId,
      source_record_id: c.source_record_id,
      source_system: c.source_system || null,
      native_key: c.native_key || null,
      canonical_entity_id: c.canonical_entity_id,
      decision: c.decision,
      confidence: c.confidence,
      method: c.method,
      matcher_version: c.matcher_version,
      entity_type: c.entity_type || null,
      evidence_json: JSON.stringify(c.evidence || {}),
      resolution_run_id: runId,
      review_status: null,
      created_at: now,
    };
  });

  const canonicalRows = entities.map((e) => ({
    id: e.id,
    entity_type: e.entity_type,
    display_name: e.display_name,
    attrs_json: e.attrs_json,
    created_at: now,
    updated_at: now,
  }));

  const runRow = {
    id: runId,
    method: VENDOR_STEM_METHOD,
    matcher_version: VENDOR_STEM_VERSION,
    config_hash: opaqueId("cfg", [ER_BATCH_VERSION, limit ?? "all"]),
    entity_type: "vendor+agency",
    scope_note:
      input.scopeNote ||
      `WH-04 batch ER over ${OCP_SOURCE_SYSTEM}` +
        (dbObs.length ? ` + ${DOING_BUSINESS_SOURCE_SYSTEM}` : ""),
    started_at: now,
    finished_at: now,
    metrics_json: JSON.stringify(metrics),
    status: "completed",
  };

  const pairRows = pairs.map((p, i) => ({
    id: opaqueId("pair", [
      p.left_source_record_id,
      p.right_source_record_id,
      p.method,
      i,
    ]),
    resolution_run_id: runId,
    left_source_record_id: p.left_source_record_id,
    right_source_record_id: p.right_source_record_id,
    left_vendor_name: p.left_vendor_name,
    right_vendor_name: p.right_vendor_name,
    left_stem: p.left_stem,
    right_stem: p.right_stem,
    shared_keys_json: JSON.stringify(p.shared_keys || []),
    decision: p.decision,
    confidence: p.confidence,
    method: p.method,
    matcher_version: p.matcher_version,
    created_at: now,
  }));

  return {
    resolution_run: runRow,
    entity_links: entityLinkRows,
    canonical_entities: canonicalRows,
    pair_receipts: pairRows,
    metrics,
    observations: vendorObs,
  };
}

/**
 * SQL join sketch: awards → vendor entity via entity_link (for docs/tests).
 */
export function sqlVerifyVendorResolution({
  awardsTable = "ocp_recent_contract_awards",
  linksTable = "er_entity_link",
  entitiesTable = "er_canonical_entity",
  limit = 20,
} = {}) {
  return `
SELECT
  a.request_id,
  a.vendor_name,
  l.canonical_entity_id,
  e.display_name AS entity_display_name,
  l.method,
  l.confidence,
  l.decision
FROM ${awardsTable} a
JOIN ${linksTable} l
  ON l.source_record_id = 'ocp-recent-contract-awards:' || CAST(a.request_id AS VARCHAR)
 AND l.entity_type = 'vendor'
 AND l.decision = 'auto_link'
LEFT JOIN ${entitiesTable} e
  ON e.id = l.canonical_entity_id
ORDER BY l.canonical_entity_id, a.request_id
LIMIT ${Number(limit) || 20}
`.trim();
}

export {
  vendorStem,
  canonicalVendorIdForStem,
  agencyCanonicalId,
  DECISION,
  EXACT_STEM_AUTO_CONFIDENCE,
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  CANDIDATE_GENERATION_VERSION,
  MATCHERS_VERSION,
};
