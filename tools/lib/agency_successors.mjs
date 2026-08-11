// OTI agency former-name / successor densify (already-held densify of t3jq-9nkf).
//
// NYC Open Data "NYC Agencies and Governance Organizations" publishes
// alternate_or_former_names and alternate_or_former_acronyms on active roster
// rows. Those fields are declared successor/alias surfaces, not fuzzy guesses.
// This module extracts them as edges, scores a dated kill sample of known
// renames + hard negatives, and densifies the existing agency crosswalk /
// resolve path only when precision clears the high-consequence floor.
//
// Wrong agency merges are worse than misses — hold ≥95% precision strictly.
// Source-null former fields stay null; never invent a successor relationship.

import { agencyComparisonKey, agencyCanonicalId } from "../../site/agency_identity.mjs";

export const AGENCY_SUCCESSOR_SOURCE_ID = "t3jq-9nkf";
export const AGENCY_SUCCESSOR_PRECISION_FLOOR = 0.95;
export const AGENCY_SUCCESSOR_BASIS = "oti_alternate_or_former_names_v1";

/** Split OTI multi-value former-name / former-acronym fields. */
export function splitFormerField(value) {
  if (value == null) return [];
  return String(value)
    .split(/[;|]/)
    .flatMap((part) => part.split(/,(?![^()]*\))/))
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function surfaceKey(value) {
  return agencyComparisonKey(value);
}

function isSelfAlias(former, current) {
  // Only exact comparison-key equality is a self-alias. normalizeAgencyKey is
  // looser (drops OFFICE/DEPARTMENT/NYC) and would incorrectly drop real
  // renames such as Office of Emergency Management → NYCEM.
  const a = surfaceKey(former);
  const b = surfaceKey(current);
  return Boolean(a && b && a === b);
}

/** Drop overly short free-text tokens that are not published acronyms. */
function isWeakFreeText(former) {
  const raw = String(former || "").trim();
  if (!raw) return true;
  // Bare digits / single tokens shorter than 4 letters are too ambiguous as names.
  if (/^\d{1,4}$/.test(raw)) return true;
  const letters = raw.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters.length < 4 && !/[A-Z]{2,}/.test(raw);
}

/**
 * Extract publisher-backed successor/alias edges from OTI roster rows.
 * Each edge is former surface → current roster name (never inferred).
 */
export function extractSuccessorEdges(rosterRows, { includeInactive = false } = {}) {
  const edges = [];
  const seen = new Set();
  for (const row of Array.isArray(rosterRows) ? rosterRows : []) {
    if (!includeInactive && String(row?.operational_status || "").toLowerCase() === "inactive") {
      continue;
    }
    const current_name = String(row?.name || "").replace(/\s+/g, " ").trim();
    if (!current_name) continue;
    const current_acronym = row?.acronym ? String(row.acronym).trim() : null;
    const formerNames = splitFormerField(row?.alternate_or_former_names);
    const formerAcronyms = splitFormerField(row?.alternate_or_former_acronyms);

    for (const former of formerNames) {
      if (isSelfAlias(former, current_name)) continue;
      if (isWeakFreeText(former)) continue;
      const id = `name:${surfaceKey(former)}→${surfaceKey(current_name)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        edge_id: id,
        kind: "former_name",
        former_surface: former,
        former_kind: "name",
        current_name,
        current_acronym,
        basis: AGENCY_SUCCESSOR_BASIS,
        source_id: AGENCY_SUCCESSOR_SOURCE_ID,
        record_id: row?.record_id || null,
        organization_type: row?.organization_type || null,
      });
    }

    for (const former of formerAcronyms) {
      const acr = String(former || "").trim();
      // Acronym edges need enough signal; single-letter / 311-style tokens stay out.
      if (acr.length < 3 || /^\d+$/.test(acr)) continue;
      if (current_acronym && surfaceKey(acr) === surfaceKey(current_acronym)) continue;
      if (isSelfAlias(acr, current_name)) continue;
      const id = `acr:${surfaceKey(acr)}→${surfaceKey(current_name)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        edge_id: id,
        kind: "former_acronym",
        former_surface: acr,
        former_kind: "acronym",
        current_name,
        current_acronym,
        basis: AGENCY_SUCCESSOR_BASIS,
        source_id: AGENCY_SUCCESSOR_SOURCE_ID,
        record_id: row?.record_id || null,
        organization_type: row?.organization_type || null,
      });
    }
  }
  return edges.sort((a, b) => a.edge_id.localeCompare(b.edge_id));
}

/**
 * Dated kill sample of known agency renames (positives) and hard non-merges
 * (negatives). Used only for precision measurement — not as a second source of
 * edges.
 */
export const AGENCY_SUCCESSOR_KILL_SAMPLE = Object.freeze({
  as_of: "2026-08-11",
  description:
    "Known agency renames / dual names that entity resolution must keep joined, " +
    "plus hard negatives that must stay distinct. Positives include gold gv0-026 " +
    "and OTI-published former-name pairs; negatives police borough DAs and " +
    "sibling correction bodies.",
  positives: Object.freeze([
    Object.freeze({
      id: "ks-doit-oti-gold",
      former: "Dept of Info Tech & Telecomm",
      current: "Office of Technology and Innovation",
      gold_id: "gv0-026",
      notes: "DoITT folded into OTI",
    }),
    Object.freeze({
      id: "ks-doit-full",
      former: "Department of Information Technology and Telecommunications",
      current: "Office of Technology and Innovation",
      notes: "OTI alternate_or_former_names full title",
    }),
    Object.freeze({
      id: "ks-dca-dcwp",
      former: "Department of Consumer Affairs",
      current: "Department of Consumer and Worker Protection",
      notes: "DCA → DCWP",
    }),
    Object.freeze({
      id: "ks-art-pdc",
      former: "Art Commission",
      current: "Public Design Commission",
      notes: "Art Commission → PDC",
    }),
    Object.freeze({
      id: "ks-sbs",
      former: "Department of Business Services",
      current: "Department of Small Business Services",
      gold_id: "gv0-032",
      notes: "Business Services → SBS",
    }),
    Object.freeze({
      id: "ks-da-ny-county",
      former: "New York County District Attorney's Office",
      current: "Manhattan District Attorney's Office",
      notes: "County vs borough DA naming (OTI former)",
    }),
    Object.freeze({
      id: "ks-da-kings",
      former: "Kings County District Attorney's Office",
      current: "Brooklyn District Attorney's Office",
      notes: "County vs borough DA naming",
    }),
    Object.freeze({
      id: "ks-endgbv",
      former: "Mayor's Office to Combat Domestic Violence",
      current: "Mayor's Office to End Domestic and Gender-Based Violence",
      notes: "ENDGBV rename",
    }),
    Object.freeze({
      id: "ks-oem",
      former: "Office of Emergency Management",
      current: "New York City Emergency Management",
      notes: "OEM → NYCEM",
    }),
    Object.freeze({
      id: "ks-doe-nycps",
      former: "Department of Education",
      current: "New York City Public Schools",
      notes: "DOE rebrand to NYCPS (OTI former)",
    }),
  ]),
  negatives: Object.freeze([
    Object.freeze({
      id: "ks-da-manhattan-brooklyn",
      left: "Manhattan District Attorney's Office",
      right: "Brooklyn District Attorney's Office",
      gold_id: "gv0-031",
      notes: "Same office type, different boroughs",
    }),
    Object.freeze({
      id: "ks-corr-board",
      left: "Department of Correction",
      right: "Board of Correction",
      notes: "Department vs oversight board",
    }),
    Object.freeze({
      id: "ks-transit-mta",
      left: "N.Y.C. Transit Authority",
      right: "Metropolitan Transportation Authority",
      notes: "Operating unit vs parent authority",
    }),
    Object.freeze({
      id: "ks-parks-dpr-police",
      left: "Department of Parks and Recreation",
      right: "Police Department",
      notes: "Unrelated agencies",
    }),
    Object.freeze({
      id: "ks-finance-omb",
      left: "Department of Finance",
      right: "Office of Management and Budget",
      notes: "Unrelated fiscal agencies",
    }),
  ]),
});

/**
 * Build former-surface comparison-key → preferred current name map.
 * Acronym edges only land when the acronym is not already a preferred surface
 * of a different current agency (collision → drop, fail closed).
 */
export function buildSuccessorAliasIndex(edges) {
  const byKey = new Map();
  const collisions = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    const key = surfaceKey(edge.former_surface);
    if (!key) continue;
    const preferred = String(edge.current_name || "").trim();
    if (!preferred) continue;
    const existing = byKey.get(key);
    if (existing && surfaceKey(existing.preferred) !== surfaceKey(preferred)) {
      collisions.push({
        key,
        former_surface: edge.former_surface,
        left: existing.preferred,
        right: preferred,
      });
      byKey.delete(key); // fail closed on ambiguous former surfaces
      continue;
    }
    if (existing) continue;
    byKey.set(key, {
      preferred,
      former_surface: edge.former_surface,
      former_kind: edge.former_kind,
      current_acronym: edge.current_acronym || null,
      basis: edge.basis,
      source_id: edge.source_id,
      edge_id: edge.edge_id,
    });
  }
  return { byKey, collisions };
}

/**
 * Resolve helper used by kill-sample measurement: apply successor aliases on top
 * of a provided base resolver (defaults to identity-only).
 */
export function resolveWithSuccessors(raw, aliasIndex, baseResolve) {
  const base = typeof baseResolve === "function"
    ? baseResolve(raw)
    : { canonical_id: agencyCanonicalId(raw), canonical_name: String(raw || "").trim() };
  const key = surfaceKey(raw);
  const hit = aliasIndex?.byKey?.get?.(key) || aliasIndex?.byKey?.[key];
  if (!hit) return base;
  const preferred = typeof baseResolve === "function"
    ? baseResolve(hit.preferred)
    : { canonical_id: agencyCanonicalId(hit.preferred), canonical_name: hit.preferred };
  return {
    ...preferred,
    successor_alias: {
      former_surface: hit.former_surface,
      preferred: hit.preferred,
      basis: hit.basis,
      source_id: hit.source_id,
    },
  };
}

function sameResolved(a, b) {
  const idA = String(a?.canonical_id || "").trim();
  const idB = String(b?.canonical_id || "").trim();
  return idA.length > 0 && idA === idB;
}

/**
 * Measure how densified successor aliases perform on the kill sample.
 * Precision = correct positive merges among pairs predicted same after densify,
 * restricted to labeled positives that densify actually changes or confirms,
 * plus ensuring no negative pair is merged.
 */
export function measureSuccessorKillSample({
  edges,
  sample = AGENCY_SUCCESSOR_KILL_SAMPLE,
  baseResolve,
  densifiedResolve,
  aliasMap = null,
} = {}) {
  const aliasIndex = aliasMap
    ? {
      byKey: new Map(Object.entries(aliasMap).map(([key, hit]) => [key, {
        preferred: hit.preferred,
        former_surface: hit.former_surface,
        basis: hit.basis,
        source_id: hit.source_id,
      }])),
      collisions: [],
    }
    : buildSuccessorAliasIndex(edges);
  const resolveBase = (raw) => (typeof baseResolve === "function"
    ? baseResolve(raw)
    : { canonical_id: agencyCanonicalId(raw), canonical_name: String(raw || "").trim() });
  const resolveDense = (raw) => {
    if (typeof densifiedResolve === "function") return densifiedResolve(raw);
    return resolveWithSuccessors(raw, aliasIndex, resolveBase);
  };

  const positiveRows = [];
  let positivesBefore = 0;
  let positivesAfter = 0;
  for (const row of sample.positives || []) {
    const beforeSame = sameResolved(resolveBase(row.former), resolveBase(row.current));
    const afterSame = sameResolved(resolveDense(row.former), resolveDense(row.current));
    if (beforeSame) positivesBefore += 1;
    if (afterSame) positivesAfter += 1;
    positiveRows.push({
      id: row.id,
      former: row.former,
      current: row.current,
      gold_id: row.gold_id || null,
      before_same: beforeSame,
      after_same: afterSame,
      fixed: !beforeSame && afterSame,
      still_broken: !afterSame,
      notes: row.notes || null,
    });
  }

  const negativeRows = [];
  let negativesHeld = 0;
  for (const row of sample.negatives || []) {
    const beforeSame = sameResolved(resolveBase(row.left), resolveBase(row.right));
    const afterSame = sameResolved(resolveDense(row.left), resolveDense(row.right));
    const held = !afterSame;
    if (held) negativesHeld += 1;
    negativeRows.push({
      id: row.id,
      left: row.left,
      right: row.right,
      gold_id: row.gold_id || null,
      before_same: beforeSame,
      after_same: afterSame,
      held,
      notes: row.notes || null,
    });
  }

  const fixed = positiveRows.filter((r) => r.fixed);
  const stillBroken = positiveRows.filter((r) => r.still_broken);
  const falseMerges = negativeRows.filter((r) => r.after_same);
  const positiveTotal = positiveRows.length;
  const negativeTotal = negativeRows.length;
  // Precision for materialization: among densify-driven positive claims that
  // end same, plus any negative that densify wrongly merges. Publisher edges
  // that only restate already-correct pairs count as true positives.
  const truePositives = positiveRows.filter((r) => r.after_same).length;
  const falsePositives = falseMerges.length;
  const predictedSame = truePositives + falsePositives;
  const precision = predictedSame === 0 ? 1 : truePositives / predictedSame;
  const residualBefore = positiveRows.filter((r) => !r.before_same).length;
  const residualAfter = stillBroken.length;
  const residualFixRate = residualBefore === 0 ? 1 : fixed.length / residualBefore;

  const clearsPrecision = precision >= AGENCY_SUCCESSOR_PRECISION_FLOOR && falsePositives === 0;
  const materialize = clearsPrecision && residualAfter < residualBefore
    || (clearsPrecision && residualBefore === 0 && truePositives === positiveTotal);

  return {
    as_of: sample.as_of,
    source_id: AGENCY_SUCCESSOR_SOURCE_ID,
    basis: AGENCY_SUCCESSOR_BASIS,
    precision_floor: AGENCY_SUCCESSOR_PRECISION_FLOOR,
    edge_count: Array.isArray(edges) ? edges.length : 0,
    alias_count: aliasIndex.byKey.size,
    collisions: aliasIndex.collisions,
    positives: {
      total: positiveTotal,
      resolved_before: positivesBefore,
      resolved_after: positivesAfter,
      residual_before: residualBefore,
      residual_after: residualAfter,
      fixed: fixed.length,
      fix_rate_on_residual: residualFixRate,
      rows: positiveRows,
    },
    negatives: {
      total: negativeTotal,
      held: negativesHeld,
      false_merges: falsePositives,
      rows: negativeRows,
    },
    precision,
    clears_precision_bar: clearsPrecision,
    materialize_edges: Boolean(clearsPrecision),
    rates: {
      precision,
      residual_fix_rate: residualFixRate,
      positive_coverage_after: positiveTotal ? positivesAfter / positiveTotal : 0,
      negative_hold_rate: negativeTotal ? negativesHeld / negativeTotal : 0,
    },
  };
}

/**
 * Stamp publisher former-name surfaces onto existing crosswalk entries.
 * Matches an edge's current_name / current_acronym to an entry's
 * canonical_name / acronym / variants. Preserves nulls; never fabricates.
 */
export function densifyCrosswalkWithSuccessors(crosswalk, edges, { materialize = true } = {}) {
  const bundle = crosswalk && typeof crosswalk === "object" ? structuredClone(crosswalk) : { entries: {} };
  const entries = bundle.entries && typeof bundle.entries === "object" ? bundle.entries : {};
  const bySurface = new Map();
  for (const [canonical_id, entry] of Object.entries(entries)) {
    const surfaces = [
      canonical_id,
      entry?.canonical_name,
      entry?.acronym,
      ...(Array.isArray(entry?.variants) ? entry.variants : []),
    ];
    for (const surface of surfaces) {
      const key = surfaceKey(surface);
      if (key && !bySurface.has(key)) bySurface.set(key, canonical_id);
    }
  }

  let stampedEntries = 0;
  let stampedSurfaces = 0;
  const applied = [];
  if (materialize) {
    for (const edge of Array.isArray(edges) ? edges : []) {
      const currentKey = surfaceKey(edge.current_name);
      const acrKey = surfaceKey(edge.current_acronym);
      const canonical_id = bySurface.get(currentKey) || bySurface.get(acrKey) || null;
      if (!canonical_id || !entries[canonical_id]) continue;
      const entry = entries[canonical_id];
      const former_names = Array.isArray(entry.former_names) ? [...entry.former_names] : [];
      const former_acronyms = Array.isArray(entry.former_acronyms) ? [...entry.former_acronyms] : [];
      if (edge.former_kind === "acronym") {
        if (!former_acronyms.some((v) => surfaceKey(v) === surfaceKey(edge.former_surface))) {
          former_acronyms.push(edge.former_surface);
          stampedSurfaces += 1;
        }
      } else if (!former_names.some((v) => surfaceKey(v) === surfaceKey(edge.former_surface))) {
        former_names.push(edge.former_surface);
        stampedSurfaces += 1;
      }
      // Keep City Record query variants complete when the former surface is a
      // spelling we may see on notices.
      const variants = Array.isArray(entry.variants) ? [...entry.variants] : [];
      if (edge.former_kind === "name"
        && !variants.some((v) => surfaceKey(v) === surfaceKey(edge.former_surface))) {
        variants.push(edge.former_surface);
      }
      const changed = former_names.length !== (entry.former_names || []).length
        || former_acronyms.length !== (entry.former_acronyms || []).length
        || variants.length !== (entry.variants || []).length;
      if (!changed) continue;
      entries[canonical_id] = {
        ...entry,
        variants: variants.sort((a, b) => a.localeCompare(b)),
        former_names: former_names.length ? former_names.sort((a, b) => a.localeCompare(b)) : null,
        former_acronyms: former_acronyms.length
          ? former_acronyms.sort((a, b) => a.localeCompare(b))
          : null,
        successor_basis: AGENCY_SUCCESSOR_BASIS,
      };
      stampedEntries += 1;
      applied.push({
        canonical_id,
        former_surface: edge.former_surface,
        former_kind: edge.former_kind,
        current_name: edge.current_name,
      });
    }
  }

  // Ensure every entry has explicit null former fields when untouched, so
  // source-null stays visible rather than absent.
  for (const [id, entry] of Object.entries(entries)) {
    if (!("former_names" in entry)) entry.former_names = null;
    if (!("former_acronyms" in entry)) entry.former_acronyms = null;
    entries[id] = entry;
  }

  const provenance = bundle._provenance && typeof bundle._provenance === "object"
    ? { ...bundle._provenance }
    : {};
  provenance.successor_densify = {
    source_id: AGENCY_SUCCESSOR_SOURCE_ID,
    basis: AGENCY_SUCCESSOR_BASIS,
    edge_count: Array.isArray(edges) ? edges.length : 0,
    stamped_entries: stampedEntries,
    stamped_surfaces: stampedSurfaces,
    materialize,
    applied_count: applied.length,
  };
  bundle._provenance = provenance;
  bundle.entries = entries;
  return { crosswalk: bundle, stampedEntries, stampedSurfaces, applied };
}

/**
 * Emit a plain object map for the site resolve path: comparison key → preferred
 * display name.
 *
 * Policy (wrong merge worse than miss):
 * - If the former surface already resolves to a reviewed group, keep that group
 *   and alias the OTI current name onto it (OEM/NYCEM, DOE/NYCPS).
 * - If the former surface is unmatched, alias it onto the OTI current name
 *   (Art Commission → Public Design Commission).
 * - Never re-point a reviewed group member onto a newly minted current id.
 */
export function materializeSuccessorAliasMap(edges, { baseResolve } = {}) {
  const out = {};
  const resolve = typeof baseResolve === "function"
    ? baseResolve
    : (raw) => ({
      canonical_id: agencyCanonicalId(raw),
      canonical_name: String(raw || "").trim(),
      matched: false,
    });

  // First pass: group-preserving alignment for edges whose former side is
  // already a reviewed identity.
  const currentToGroup = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const formerRes = resolve(edge.former_surface);
    const currentRes = resolve(edge.current_name);
    if (!formerRes?.canonical_id || !currentRes?.canonical_id) continue;
    if (formerRes.canonical_id === currentRes.canonical_id) continue;
    if (formerRes.matched === true) {
      const currentKey = surfaceKey(edge.current_name);
      if (!currentKey) continue;
      currentToGroup.set(currentKey, {
        preferred: formerRes.canonical_name,
        former_surface: edge.current_name,
        former_kind: "current_name_group_alignment",
        basis: AGENCY_SUCCESSOR_BASIS,
        source_id: AGENCY_SUCCESSOR_SOURCE_ID,
      });
    }
  }

  for (const [key, hit] of currentToGroup.entries()) {
    out[key] = hit;
  }

  // Second pass: map unmatched former surfaces onto the OTI current name, but
  // when that current name was aligned to a group, prefer the group name so a
  // single hop lands on the reviewed id (acronym edges included).
  for (const edge of Array.isArray(edges) ? edges : []) {
    const formerKey = surfaceKey(edge.former_surface);
    if (!formerKey || out[formerKey]) continue;
    const formerRes = resolve(edge.former_surface);
    const currentRes = resolve(edge.current_name);
    if (formerRes?.canonical_id && currentRes?.canonical_id
      && formerRes.canonical_id === currentRes.canonical_id) {
      continue;
    }
    if (formerRes?.matched === true) {
      // Keep reviewed former spellings on their group; do not re-point them.
      continue;
    }
    const currentKey = surfaceKey(edge.current_name);
    const aligned = currentKey ? currentToGroup.get(currentKey) : null;
    const preferred = aligned?.preferred || edge.current_name;
    if (!preferred) continue;
    out[formerKey] = {
      preferred,
      former_surface: edge.former_surface,
      former_kind: edge.former_kind,
      basis: edge.basis || AGENCY_SUCCESSOR_BASIS,
      source_id: edge.source_id || AGENCY_SUCCESSOR_SOURCE_ID,
    };
  }
  return out;
}

export function renderSuccessorAliasModule(aliasMap, { asOf } = {}) {
  const keys = Object.keys(aliasMap || {}).sort();
  const lines = keys.map((key) => {
    const row = aliasMap[key];
    return `  ${JSON.stringify(key)}: Object.freeze(${JSON.stringify({
      preferred: row.preferred,
      former_surface: row.former_surface,
      former_kind: row.former_kind,
      basis: row.basis,
      source_id: row.source_id,
    })}),`;
  });
  return (
    `// Auto-generated by tools/build_agency_successors.mjs — do not edit by hand.\n` +
    `// Source: OTI ${AGENCY_SUCCESSOR_SOURCE_ID} alternate_or_former_names / acronyms.\n` +
    `// Basis: ${AGENCY_SUCCESSOR_BASIS}. Snapshot as_of=${asOf || "unknown"}.\n` +
    `// Publisher-declared former surfaces only; collisions fail closed.\n\n` +
    `export const AGENCY_SUCCESSOR_ALIAS_BY_KEY = Object.freeze({\n` +
    `${lines.join("\n")}\n` +
    `});\n\n` +
    `export function successorPreferredFor(value, comparisonKeyFn) {\n` +
    `  const key = typeof comparisonKeyFn === "function"\n` +
    `    ? comparisonKeyFn(value)\n` +
    `    : String(value || "").trim().toUpperCase();\n` +
    `  if (!key) return null;\n` +
    `  return AGENCY_SUCCESSOR_ALIAS_BY_KEY[key] || null;\n` +
    `}\n`
  );
}
