// Resolve IBO source labels through the repository's shared agency identity module.
//
// Input is a JSON array on stdin. Output is one explicit decision per label. The
// resolver deliberately does not invent a canonical id for an unmatched label.

import { readFileSync } from "node:fs";

import {
  AGENCY_GROUPS,
  agencyComparisonKey,
  resolveAgencyIdentity,
} from "../../site/agency_identity.mjs";

const labels = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(labels)) throw new TypeError("agency labels must be an array");

function decision(sourceAgencyName) {
  const raw = String(sourceAgencyName || "").trim();
  const identity = resolveAgencyIdentity(raw);
  if (!identity.matched) {
    return {
      source_agency_name: raw,
      status: "unresolved",
      canonical_agency_id: null,
      canonical_agency_name: null,
      basis: "shared_agency_identity_unmatched",
    };
  }

  const key = agencyComparisonKey(raw);
  const group = Object.entries(AGENCY_GROUPS).find(([canonical, variants]) => {
    const surfaces = [canonical, ...variants];
    return surfaces.some((surface) => agencyComparisonKey(surface) === key);
  });
  const isExact = group && agencyComparisonKey(group[0]) === key;
  return {
    source_agency_name: raw,
    status: isExact ? "exact" : "alias",
    canonical_agency_id: identity.canonical_id,
    canonical_agency_name: identity.canonical_name,
    basis: isExact
      ? "shared_agency_identity_canonical_surface"
      : "shared_agency_identity_explicit_alias_or_successor_surface",
  };
}

process.stdout.write(`${JSON.stringify(labels.map(decision).sort((a, b) => a.source_agency_name.localeCompare(b.source_agency_name)))}\n`);
