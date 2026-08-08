import { entityHref, parseEntityRef } from "./entity_pivot.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { constellationLink, staticFact } from "./affordance_grammar.mjs";
import { scopeFromRouteHash, emptyScope } from "./scope_v0.mjs";
import {
  buildContextualSuggestions,
  renderContextualSuggestions,
} from "./contextual_suggestions.mjs";

export const BROWSE_FACETS = Object.freeze({
  contracts: {
    tab: "money",
    label: "Contracts",
    route: "/browse/contracts/",
    countLabel: "open opportunities",
    description: "Open solicitations, awards, procurement plans, registration, and payment trails.",
    sources: "City Record · PASSPort · Checkbook NYC · MOCS plans",
    container: "list",
    dataPath: "/data/money_default_open.json",
    rowsKey: "notices",
  },
  staffing: {
    tab: "people",
    label: "Staffing",
    route: "/browse/staffing/",
    countLabel: "recent appointments",
    description: "Recent appointments, payroll, civil-service exams, eligible lists, and hiring outcomes.",
    sources: "City Record · DCAS · Citywide Payroll",
    container: "staffing-notice-list",
    dataPath: "/data/staffing_default_hires.json",
    rowsKey: "notices",
  },
  zoning: {
    tab: "land",
    label: "Zoning",
    route: "/browse/zoning/",
    countLabel: "active projects",
    description: "Active land-use projects, hearings, recommendations, votes, and final outcomes.",
    sources: "ZAP · City Record · Council records",
    container: "llist",
    dataPath: "/data/land_default_ulurp.json",
    rowsKey: "projects",
  },
  property: {
    tab: "property",
    label: "Property",
    route: "/browse/property/",
    countLabel: "observed property records",
    description: "Property dispositions, hearings, sales, conveyances, and tax-lien context.",
    sources: "City Record · parcel data · published tax-lien lists",
    container: "propertyfeed",
    dataPath: "/data/property_domain_observations.json",
    rowsKey: "property_rows",
  },
  rules: {
    tab: "rules",
    label: "Rules",
    route: "/browse/rules/",
    countLabel: "recent rule records",
    description: "Proposed and adopted rules, comment periods, hearings, and effective dates.",
    sources: "City Record · NYC Rules",
    container: "rulesfeed",
    dataPath: "/data/rules_domain_observations.json",
    rowsKey: "rows",
  },
  meetings: {
    tab: "meetings",
    label: "Meetings",
    route: "/browse/meetings/",
    countLabel: "recent meeting records",
    description: "Public meetings and hearings, agendas, testimony details, votes, minutes, and outcomes.",
    sources: "City Record · Council Legistar",
    container: "meetingsfeed",
    dataPath: "/data/meetings_domain_observations.json",
    rowsKey: "rows",
  },
});

const BROWSE_SCOPE_POLICY = Object.freeze({
  contracts: {
    agencyField: "agency_name",
    entityRefFields: [
      "entity_refs_all",
      "entity_refs",
      "scope_entity_refs",
      "subject_entity_refs",
      "vendor_entity_ref",
      "project_entity_ref",
      "agency_entity_ref",
    ],
  },
  staffing: { agencyField: "agency_name", entityRefFields: [] },
  zoning: { agencyField: "primary_applicant", entityRefFields: [] },
  property: { agencyField: "agency_name", entityRefFields: ["disposition_subject_ref", "disposition_join_keys"] },
  rules: { agencyField: "agency_name", entityRefFields: [] },
  meetings: { agencyField: "agency_name", entityRefFields: [] },
});

const KNOWN_SCOPE_FILTER_KEYS = new Set(["facet"]);

// Edge-applied query keys for the static Browse document. Keys not listed here
// surface as liveOnlyFilters (SPA must still honor them after hydrate).
// `mode` stays live-only: the contracts document snapshot is open solicitations;
// award / all-RFP modes load a different universe after hydrate.
const EDGE_FILTERS = new Set([
  "q",
  "agency",
  "boro",
  "closing",
  "when",
  "status",
  "cd",
  "community_district",
  "council",
]);
const DOCUMENT_FILTERS = new Set(["lang", "legacy"]);

function parseDispositionRef(value) {
  const match = String(value || "").trim().match(/^disposition:[^:]+:(bbl:\d{10})$/);
  return match ? { kind: "bbl", id: match[1], ref: String(value || "").trim() } : null;
}

function normalizeAgencyIdFromRef(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("id:") ? raw.slice(3) : raw;
}

function collectEntityRefsFromCell(value) {
  if (value == null) return [];
  const cells = Array.isArray(value) ? value : [value];
  return cells.flatMap((raw) => {
    if (raw == null || raw === "") return [];
    const candidate = typeof raw === "string" ? raw : raw?.ref || raw?.entity_ref;
    if (typeof candidate !== "string") return [];
    const parsed = parseEntityRef(candidate) || parseDispositionRef(candidate);
    if (!parsed) return [];
    if (parsed.kind === "agency") parsed.id = normalizeAgencyIdFromRef(parsed.id);
    return [parsed];
  });
}

function appendScopeRef(target, item) {
  if (!item || typeof item.kind !== "string" || item.kind.length === 0) return;
  const id = String(item.id);
  if (!id.length) return;
  const existing = target.get(item.kind);
  if (!existing) target.set(item.kind, new Map());
  const finalMap = target.get(item.kind);
  finalMap.set(id, item);
}

function scopeLabelFromRef(item) {
  if (item.kind === "agency") {
    return resolveAgencyIdentity(item.id).canonical_name;
  }
  return `${item.kind}:${item.id}`;
}

function normalizeScopeFromSearch(facet, search) {
  const policy = BROWSE_FACETS[facet];
  if (!policy) return emptyScope("en");
  const safeSurface = policy.tab || "money";
  const searchParams = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  return scopeFromRouteHash(`#${safeSurface}?${searchParams.toString()}`, { language: "en" });
}

function scopeFromFacetParams(facet, search) {
  const parsed = normalizeScopeFromSearch(facet, search);
  const refValues = Array.isArray(parsed?.facets?.values?.entity_refs_all)
    ? parsed.facets.values.entity_refs_all.filter((value) => typeof value === "string" && value.length)
    : [];
  const requestedRefs = new Map();
  const unsupportedRefs = new Set();
  const addRef = (item) => {
    if (!item || !item.kind || item.id == null) return;
    const normalizedId = item.kind === "agency" ? normalizeAgencyIdFromRef(item.id) : String(item.id);
    appendScopeRef(requestedRefs, {
      kind: item.kind,
      id: normalizedId,
      ref: item.ref,
      label: scopeLabelFromRef({ ...item, id: normalizedId }),
    });
  };

  for (const rawRef of parsed.facets?.agencies || []) {
    const resolved = resolveAgencyIdentity(rawRef);
    addRef({ kind: "agency", id: resolved.canonical_id, label: resolved.canonical_name, ref: `agency:id:${resolved.canonical_id}` });
  }

  for (const rawRef of refValues) {
    const parsedRef = parseEntityRef(rawRef) || parseDispositionRef(rawRef);
    if (!parsedRef) {
      unsupportedRefs.add(String(rawRef));
      continue;
    }
    addRef({ ...parsedRef, ref: String(rawRef) });
  }

  const labels = [...requestedRefs.values()].flatMap((refs) => [...refs.values()].map((item) => item.label));
  return {
    parsed,
    hasScopeFacet: requestedRefs.size > 0,
    refsByKind: requestedRefs,
    refs: [...requestedRefs.values()].flatMap((kindRefs) => [...kindRefs.values()]),
    labels: [...new Set(labels)],
    unsupportedRefs: [...unsupportedRefs],
  };
}

function readAgencyIdFromRow(row, facet) {
  const policy = BROWSE_SCOPE_POLICY[facet];
  if (!policy || !policy.agencyField) return "";
  return resolveAgencyIdentity(row?.[policy.agencyField] || row?.agency_name || row?.agency || "").canonical_id;
}

function readRowEntityRefs(row, facet) {
  const policy = BROWSE_SCOPE_POLICY[facet];
  const fields = policy?.entityRefFields || [];
  const refs = [];
  for (const field of fields) {
    refs.push(...collectEntityRefsFromCell(row?.[field]));
  }
  return refs;
}

function renderScopeChip(scopeState, config, scopeSearch) {
  if (!scopeState.hasScopeFacet) return "";
  const raw = new URLSearchParams(scopeSearch instanceof URLSearchParams ? scopeSearch : new URLSearchParams(scopeSearch));
  const status = scopeState.mode;
  const label = scopeState.labels.length ? scopeState.labels.join(", ") : "Scope constraints";
  const details = status === "unsupported"
    ? `This lens does not support this scope filter; showing all matched records for this view.`
    : status === "empty"
      ? `No records in this lens match ${label}.`
      : `Filtered to ${label}.`;
  const chips = scopeState.refs.map((item) => {
    const removeParams = new URLSearchParams(raw);
    const facetRaw = removeParams.get("facet");
    let removed = false;
    if (facetRaw) {
      try {
        const facet = JSON.parse(facetRaw);
        const refs = Array.isArray(facet?.entity_refs_all) ? facet.entity_refs_all : [];
        const remaining = refs.filter((ref) => String(ref) !== String(item.ref));
        if (remaining.length < refs.length) {
          removed = true;
          delete facet.result_count_receipt;
          if (remaining.length) {
            removeParams.set("facet", JSON.stringify({ ...facet, entity_refs_all: remaining }));
          } else {
            removeParams.delete("facet");
          }
        }
      } catch (_error) {
        removeParams.delete("facet");
      }
    }
    if (!removed && item.kind === "agency") removeParams.delete("agency");
    const removeHref = `${config.route}${removeParams.toString() ? `?${removeParams}` : ""}`;
    return `<a href="${esc(removeHref)}" class="x-remove-scope">${esc(item.label)} ×</a>`;
  }).join(" ");
  return `<p class="scope" data-browse-scope="${esc(status)}" role="status"><span class="lbl">Scope</span> ${chips || `<span>${esc(label)}</span>`} ${esc(details)}</p>`;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isoDay(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function rowId(facet, row) {
  if (facet === "zoning") return row.project_id || null;
  return row.request_id || null;
}

function rowTitle(facet, row) {
  if (facet === "zoning") return row.project_name || row.project_id;
  return row.short_title || row.title || row.request_id;
}

function rowAgency(facet, row) {
  if (facet === "zoning") return row.primary_applicant || null;
  return row.agency_name || row.agency || null;
}

function rowDate(facet, row) {
  if (facet === "contracts") return row.due_date || row.start_date;
  if (facet === "meetings") return row.event_date || row.start_date;
  return row.start_date || row.event_date || null;
}

function asPlaceObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Collect structured borough labels from every place bag a lens stores.
 * Multi-value bags (meetings affected_area, property_location, money place)
 * must contribute every borough so a shareable boro= link is not a silent miss.
 */
function rowBoroughs(facet, row) {
  if (facet === "zoning") {
    return row?.borough ? [String(row.borough)] : [];
  }
  const bags = [
    asPlaceObject(row?.affected_area),
    asPlaceObject(row?.rule_location),
    asPlaceObject(row?.place),
    asPlaceObject(row?.property_location),
    asPlaceObject(row?._location),
  ].filter(Boolean);
  const out = [];
  if (row?.borough) out.push(String(row.borough));
  for (const bag of bags) {
    if (bag.borough) out.push(String(bag.borough));
    if (Array.isArray(bag.boroughs)) {
      for (const borough of bag.boroughs) {
        if (borough) out.push(String(borough));
      }
    }
  }
  return out;
}

function rowMatchesBorough(facet, row, borough) {
  if (!borough) return true;
  const target = String(borough).trim().toLocaleLowerCase();
  if (!target) return true;
  const structured = rowBoroughs(facet, row)
    .map((value) => String(value).trim().toLocaleLowerCase())
    .filter(Boolean);
  if (structured.length) {
    // Exact label match (case-insensitive). Multi-borough rows match any member.
    return structured.some((value) => value === target);
  }
  // Fallback for free-text place lines that never received a structured bag.
  return rowPlace(facet, row).toLocaleLowerCase().includes(target);
}

function rowPlace(facet, row) {
  if (facet === "zoning") {
    return [row.borough, row.community_district, row.cc_district].filter(Boolean).join(" ");
  }
  const area = asPlaceObject(row.affected_area)
    || asPlaceObject(row.rule_location)
    || asPlaceObject(row.place)
    || {};
  const propertyLoc = asPlaceObject(row.property_location) || asPlaceObject(row._location);
  const placeLoc = asPlaceObject(row.place);
  const boroughs = rowBoroughs(facet, row);
  const addressish = [
    typeof row.property_location === "string" ? row.property_location : null,
    propertyLoc?.addresses?.[0]?.label,
    placeLoc?.addresses?.[0]?.label,
    row.street_address_1,
  ];
  return [row.borough, area.borough, ...boroughs, ...addressish].filter(Boolean).join(" ");
}

function rowStatusHaystack(row) {
  return [
    row?.public_status,
    row?.project_status,
    row?.disposition_stage,
    row?.status,
    row?.type_of_notice_description,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLocaleLowerCase())
    .join(" ");
}

function rowMatchesStatus(row, status) {
  if (!status) return true;
  const target = String(status).trim().toLocaleLowerCase();
  if (!target) return true;
  // Accept land-status facet ids ("project:Active" / "public:Completed") as well
  // as bare status tokens used on shareable Browse links.
  const match = target.match(/^(project|public):(.*)$/);
  if (match) {
    const field = match[1] === "project" ? "project_status" : "public_status";
    return String(row?.[field] || "").toLocaleLowerCase() === match[2];
  }
  return rowStatusHaystack(row).includes(target);
}

/**
 * Pure procurement-mode predicate for detector / SPA parity checks.
 * Not applied by buildBrowseView — mode is a live-only control because the
 * edge contracts document is an open-solicitation snapshot.
 */
export function rowMatchesProcurementMode(row, mode) {
  if (!mode) return true;
  const target = String(mode).trim().toLocaleLowerCase();
  if (!target || target === "allrfp") {
    const type = String(row?.type_of_notice_description || "").toLocaleLowerCase();
    return !type || type.includes("solicitation");
  }
  if (target === "open") {
    const type = String(row?.type_of_notice_description || "").toLocaleLowerCase();
    return !type || type.includes("solicitation");
  }
  if (target === "award") {
    return String(row?.type_of_notice_description || "").toLocaleLowerCase().includes("award");
  }
  return true;
}

function rowMatchesCommunityDistrict(row, cd) {
  if (!cd) return true;
  const target = String(cd).trim().toUpperCase();
  if (!target) return true;
  const candidates = [
    row?.community_district,
    row?._communityDistrict,
    ...(Array.isArray(row?.community_districts) ? row.community_districts : []),
    ...(Array.isArray(row?.place?.community_districts) ? row.place.community_districts : []),
    ...(Array.isArray(row?.affected_area?.community_districts) ? row.affected_area.community_districts : []),
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toUpperCase());
  if (!candidates.length) return false;
  return candidates.some((value) => value === target || value.includes(target));
}

function rowMatchesCouncilDistrict(row, council) {
  if (!council) return true;
  const target = String(council).trim().replace(/^0+/, "");
  if (!target) return true;
  const candidates = [
    row?.cc_district,
    row?.council_district,
    row?._councilDistrict,
    ...(Array.isArray(row?.council_districts) ? row.council_districts : []),
    ...(Array.isArray(row?.place?.council_districts) ? row.place.council_districts : []),
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().replace(/^0+/, ""));
  if (!candidates.length) return false;
  return candidates.some((value) => value === target || value.split(/[,\s]+/).includes(target));
}

function rowHref(facet, row) {
  const id = rowId(facet, row);
  if (!id) return null;
  if (facet === "zoning") return `/#land/${encodeURIComponent(id)}`;
  return `/notices/${encodeURIComponent(id)}`;
}

function corpus(row) {
  return Object.values(row || {}).flatMap((value) => {
    if (value == null) return [];
    if (typeof value === "object") return [JSON.stringify(value)];
    return [String(value)];
  }).join(" ").toLocaleLowerCase();
}

function matchesClosing(row, value, asOf) {
  if (!value) return true;
  const due = isoDay(row.due_date);
  const start = isoDay(asOf);
  if (!due || !start) return false;
  const days = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
  if (value === "week") return days >= 0 && days <= 7;
  if (value === "month") return days >= 0 && days <= 30;
  return true;
}

function liveOnlyFilters(params) {
  const liveOnly = [];
  for (const [key] of params) {
    if (KNOWN_SCOPE_FILTER_KEYS.has(key)) continue;
    if (DOCUMENT_FILTERS.has(key) || EDGE_FILTERS.has(key)) continue;
    liveOnly.push(key);
  }
  return [...new Set(liveOnly)].sort();
}

function scopeApplicability(facet, rows, scopeState) {
  const policy = BROWSE_SCOPE_POLICY[facet];
  const supported = new Set();
  if (policy?.agencyField) supported.add("agency");
  for (const row of rows) {
    for (const ref of readRowEntityRefs(row, facet)) {
      supported.add(ref.kind);
    }
  }
  const requested = new Set(scopeState.refs.map((item) => item.kind));
  const supportedRequested = [...requested].filter((kind) => supported.has(kind));
  const unsupported = [...requested].filter((kind) => !supported.has(kind));
  return {
    supportedKinds: supported,
    supportedRequestedKinds: supportedRequested,
    unsupportedKinds: unsupported,
    canApplyScope: requested.size > 0 && unsupported.length === 0,
  };
}

function scopeKeyFromKindAndRef(ref) {
  return `${ref.kind}:${ref.id}`;
}

function rowReferenceSet(row, facet) {
  const refs = new Map();
  const rowRefs = new Map();
  const rowAgencyId = readAgencyIdFromRow(row, facet);
  if (rowAgencyId) appendScopeRef(rowRefs, { kind: "agency", id: normalizeAgencyIdFromRef(rowAgencyId), ref: `agency:id:${rowAgencyId}`, label: rowAgencyId });
  for (const ref of readRowEntityRefs(row, facet)) {
    appendScopeRef(rowRefs, ref);
  }
  for (const [kind, byId] of rowRefs) {
    for (const [id, item] of byId) {
      refs.set(scopeKeyFromKindAndRef(item), item);
    }
  }
  return refs;
}

function rowAgencyFilterMatches(row, facet, filter) {
  if (!filter) return true;
  const raw = String(filter || "").trim();
  if (!raw) return true;
  const resolved = resolveAgencyIdentity(raw).canonical_id;
  const rowAgency = String(readAgencyIdFromRow(row, facet) || rowAgency(facet, row) || "").trim();
  const normalizedRowAgency = rowAgency.toLocaleLowerCase();
  const normalizedFilter = raw.toLocaleLowerCase();
  if (normalizedRowAgency.includes(normalizedFilter)) return true;
  if (resolved && resolveAgencyIdentity(rowAgency).canonical_id === resolved) return true;
  return false;
}

function rowMatchesScopeRefs(row, facet, requestedRefs, applicableKinds) {
  if (!applicableKinds.length) return false;
  const rowRefs = rowReferenceSet(row, facet);
  return requestedRefs.every((item) => (
    applicableKinds.includes(item.kind)
      && rowRefs.has(scopeKeyFromKindAndRef(item))
  ));
}

function suggestionEdgeLabel(item) {
  if (item.kind === "agency") {
    const identity = resolveAgencyIdentity(item.id);
    if (identity.matched) return identity.canonical_name;
    return String(identity.canonical_name || item.id).replaceAll("-", " ").replace(/\b[a-z]/g, (char) => char.toUpperCase());
  }
  if (item.kind === "project") return `project ${item.id}`;
  if (item.kind === "parcel") return `parcel ${item.id}`;
  if (item.kind === "vendor") {
    const raw = String(item.id || "").replace(/^stem:/, "");
    try { return decodeURIComponent(raw) || "this vendor"; } catch { return raw || "this vendor"; }
  }
  if (item.kind === "official") return `official ${item.id}`;
  return scopeLabelFromRef(item);
}

function browseEdgeInventory(facet, rows, currentRefs) {
  const requested = (currentRefs || []).map((ref) => {
    const parsed = parseEntityRef(ref);
    if (!parsed) return null;
    return parsed.kind === "agency"
      ? { ...parsed, id: parsed.id.replace(/^id:/, "") }
      : parsed;
  }).filter(Boolean);
  const requestedKeys = new Set(requested.map(scopeKeyFromKindAndRef));
  const candidateByRef = new Map();
  const pairByKey = new Map();
  const baseMatches = (rows || []).filter((row) => {
    if (!requested.length) return true;
    return rowMatchesScopeRefs(row, facet, requested, requested.map((item) => item.kind));
  });

  for (const row of baseMatches) {
    const rowEdges = [...rowReferenceSet(row, facet).values()] // Source: current Browse payload's typed rowReferenceSet; no new data is fetched here.
      .filter((item) => parseEntityRef(item.ref))
      .filter((item) => item.ref && !requestedKeys.has(scopeKeyFromKindAndRef(item)));
    for (const item of rowEdges) {
      const key = item.ref;
      const existing = candidateByRef.get(key) || {
        ref: item.ref,
        kind: item.kind,
        id: item.id,
        label: suggestionEdgeLabel(item),
        count: 0,
        pivotHref: "",
      };
      existing.count += 1;
      if (!existing.pivotHref) {
        existing.pivotHref = entityHref({ ref: item.ref, label: existing.label, confidence: "strong" }) || "";
      }
      candidateByRef.set(key, existing);
    }
    for (let left = 0; left < rowEdges.length; left += 1) {
      for (let right = left + 1; right < rowEdges.length; right += 1) {
        const pair = [rowEdges[left], rowEdges[right]].sort((a, b) => a.ref.localeCompare(b.ref));
        const key = pair.map((item) => item.ref).join("|");
        const existing = pairByKey.get(key) || {
          refs: pair.map((item) => item.ref),
          labels: pair.map(suggestionEdgeLabel),
          count: 0,
        };
        existing.count += 1;
        pairByKey.set(key, existing);
      }
    }
  }
  return {
    edgeInventory: [...candidateByRef.values()],
    edgePairs: [...pairByKey.values()],
  };
}

export { browseEdgeInventory };

export function buildBrowseView(facet, payload = {}, params = new URLSearchParams(), options = {}) {
  const config = BROWSE_FACETS[facet];
  if (!config) return null;
  const search = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const query = String(search.get("q") || "").trim().toLocaleLowerCase();
  const agency = String(search.get("agency") || "").trim().toLocaleLowerCase();
  const borough = String(search.get("boro") || "").trim();
  const status = String(search.get("status") || "").trim();
  const communityDistrict = String(search.get("cd") || search.get("community_district") || "").trim();
  const councilDistrict = String(search.get("council") || "").trim();
  const asOf = payload.open_as_of || payload.generated_at || payload.retrieved_at || null;
  const rows = Array.isArray(payload[config.rowsKey]) ? payload[config.rowsKey] : [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 40;
  const scopeState = scopeFromFacetParams(facet, search);
  const applicability = scopeApplicability(facet, rows, scopeState);
  const matchedBase = rows.filter((row) => {
    const text = corpus(row);
    if (query && !text.includes(query)) return false;
    if (agency && !rowAgencyFilterMatches(row, facet, agency)) return false;
    if (borough && !rowMatchesBorough(facet, row, borough)) return false;
    if (status && !rowMatchesStatus(row, status)) return false;
    if (communityDistrict && !rowMatchesCommunityDistrict(row, communityDistrict)) return false;
    if (councilDistrict && !rowMatchesCouncilDistrict(row, councilDistrict)) return false;
    if (facet === "contracts" && !matchesClosing(row, search.get("closing"), asOf)) return false;
    return true;
  });
  const matched = scopeState.hasScopeFacet && applicability.canApplyScope
    ? matchedBase.filter((row) => rowMatchesScopeRefs(row, facet, scopeState.refs, applicability.supportedRequestedKinds))
    : matchedBase;
  const requestedKinds = new Set(scopeState.refs.map((item) => item.kind));
  const supportedRequestedKinds = [...requestedKinds].filter((kind) => applicability.supportedKinds.has(kind));
  const unsupportedKinds = [...requestedKinds].filter((kind) => !applicability.supportedKinds.has(kind));
  const mode = !scopeState.hasScopeFacet ? "none"
    : !applicability.canApplyScope ? "unsupported"
      : matched.length === 0 ? "empty"
        : "applied";
  let emptyReason = "";
  if (mode === "empty") {
    const scopeLabel = scopeState.labels.length ? scopeState.labels.join(", ") : "this scope";
    emptyReason = `No records in this lens match ${scopeLabel}.`;
  } else if (mode === "unsupported") {
    emptyReason = `This lens does not support this scope filter; showing all matched records for this view.`;
  }
  const scopeSummary = {
    hasScopeFacet: scopeState.hasScopeFacet,
    labels: scopeState.labels,
    refs: scopeState.refs,
    unsupportedRefs: scopeState.unsupportedRefs,
    canApply: applicability.canApplyScope,
    supportedKinds: supportedRequestedKinds,
    unsupportedKinds,
    mode,
    emptyReason,
    preFilterTotal: matchedBase.length,
  };
  const edgeInventory = scopeState.hasScopeFacet && !applicability.canApplyScope
    ? { edgeInventory: [], edgePairs: [] }
    : browseEdgeInventory(facet, matchedBase, scopeState.refs.map((item) => item.ref));
  const contextualSuggestions = buildContextualSuggestions({
    scope: scopeState.parsed,
    surface: config.tab,
    route: config.route,
    search,
    resultCount: matched.length,
    ...edgeInventory,
  });
  return {
    facet,
    config,
    total: matched.length,
    scope: scopeSummary,
    preScopeTotal: matchedBase.length,
    rows: matched.slice(0, limit),
    asOf: isoDay(asOf),
    scopeSearch: search.toString(),
    liveOnlyFilters: liveOnlyFilters(search),
    hasQuery: [...search].some(([key]) => !DOCUMENT_FILTERS.has(key)),
    contextualSuggestions,
  };
}

export function buildBrowseLanding(payloads = {}, options = {}) {
  const cards = Object.entries(BROWSE_FACETS).map(([facet, config]) => {
    const payload = payloads[facet] || {};
    const view = buildBrowseView(facet, payload);
    return {
      facet,
      ...config,
      count: view.total,
      asOf: view.asOf,
      secondaryCount: facet === "staffing" ? Number(options.staffingExamCount) || 0 : null,
      secondaryAsOf: facet === "staffing" ? isoDay(options.staffingExamAsOf) : null,
    };
  });
  const dated = cards.flatMap((card) => [card.asOf, card.secondaryAsOf]).filter(Boolean).sort();
  return {
    cards,
    oldestSnapshot: dated[0] || null,
    newestSnapshot: dated.at(-1) || null,
  };
}

export function renderBrowseLanding(landing) {
  const cards = (landing?.cards || []).map((card) => {
    const primary = `${card.count.toLocaleString("en-US")} ${card.countLabel}`;
    const secondary = card.secondaryCount
      ? ` · ${card.secondaryCount.toLocaleString("en-US")} civil-service exams${card.secondaryAsOf ? ` as of ${esc(card.secondaryAsOf)}` : ""}`
      : "";
    return `<article class="browse-source-card" id="source-${esc(card.facet)}">
      <p class="browse-source-count">${esc(primary)}${secondary}</p>
      <h3>${constellationLink({ href: card.route, label: card.label, className: "browse-card-link", escape: esc })}</h3>
      <p class="browse-source-description">${esc(card.description)}</p>
      <p class="browse-source-asof">${staticFact({ label: card.asOf ? `Updated ${card.asOf}` : "Update date unavailable", className: "browse-card-date", escape: esc })}</p>
      <details class="browse-source-disclosure"><summary>Official data from…</summary><p>${staticFact({ label: card.sources, className: "browse-card-sources", escape: esc })}</p></details>
      ${constellationLink({ href: card.route, label: `Browse ${card.label.toLowerCase()}`, className: "browse-source-action", escape: esc })}
    </article>`;
  }).join("");
  return `<div class="browse-landing" data-build-rendered="browse-landing">
    <header class="browse-landing-head">
      <p class="now-kicker">Browse</p>
      <h2>Browse NYC’s public record</h2>
      <p>Pick a city topic. Filter by agency, place, status, date, or search term.</p>
    </header>
    <div class="browse-source-grid">${cards}</div>
  </div>`;
}

function renderedDate(value) {
  const day = isoDay(value);
  if (!day) return "";
  return `<time datetime="${esc(day)}">${esc(day)}</time>`;
}

export function renderBrowseView(view) {
  if (!view) return "";
  const disclosure = view.liveOnlyFilters.length
    ? `<p class="note warn browse-filter-disclosure" role="status" aria-label="Loading requested filters"><span class="loading" aria-hidden="true"></span></p>`
    : "";
  const scopeChip = renderScopeChip(view.scope, view.config, view.scopeSearch);
  const contextualSuggestions = renderContextualSuggestions(view.contextualSuggestions);
  const cards = view.rows.map((row) => {
    const href = rowHref(view.facet, row);
    const title = rowTitle(view.facet, row) || "Untitled record";
    const agency = rowAgency(view.facet, row);
    const date = renderedDate(rowDate(view.facet, row));
    const place = rowPlace(view.facet, row);
    const agencyIdentity = agency ? resolveAgencyIdentity(agency) : null;
    const agencyMarkup = agencyIdentity
      ? constellationLink({ href: `/agencies/${encodeURIComponent(agencyIdentity.canonical_id)}/`, label: agency, className: "browse-agency-link", escape: esc })
      : "";
    return `<article class="browse-static-record" data-record-id="${esc(rowId(view.facet, row) || "")}">
      <h3>${href ? constellationLink({ href, label: title, className: "browse-record-link", escape: esc }) : `<span lang="en" dir="ltr">${esc(title)}</span>`}</h3>
      <p class="browse-static-meta">${[agencyMarkup, date, place && staticFact({ label: place, className: "browse-place-fact", escape: esc })].filter(Boolean).join(" · ")}</p>
    </article>`;
  }).join("");
  const summary = `<p class="browse-static-summary" data-build-summary data-scope-count="${esc(view.total)}">${esc(view.config.label)} · ${view.total} available ${view.total === 1 ? "record" : "records"}${view.asOf ? ` · updated ${esc(view.asOf)}` : ""}</p>`;
  return `<div class="browse-build-view" data-build-rendered="browse" data-browse-facet="${esc(view.facet)}">${summary}${scopeChip}${contextualSuggestions}${disclosure}${cards || `<div class="empty">${esc(view.scope.emptyReason || "No records match this bounded view.")}</div>`}</div>`;
}

export function browseAssetPath(facet) {
  return BROWSE_FACETS[facet]?.dataPath || null;
}

export function browseContainerId(facet) {
  return BROWSE_FACETS[facet]?.container || null;
}
