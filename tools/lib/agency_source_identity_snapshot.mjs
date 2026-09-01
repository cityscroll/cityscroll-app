/**
 * Compose the deterministic CI-K1 source-identity regression envelope.
 *
 * The envelope is the machine contract plus the two derived consumer
 * surfaces that must stay byte-compatible: per-agency Browse scope hrefs
 * (`agency:id:*` facet grammar) and per-agency follow hrefs. Shared by
 * tools/build_agency_source_identity_snapshot.mjs (--check/--write) and
 * test/agency_source_identity_contract.test.mjs so the committed fixture
 * and the live build can never diverge in shape.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgencySourceIdentityContract } from "../../site/agency_source_identity_contract.mjs";
import { agencyScopeHref } from "../../site/agency_scope_links.mjs";
import { agencyCategoryFollowHref } from "../../site/agency_constellation_model.mjs";
import routeIdentityReport from "../../site/data/agency_route_identity_report.json" with { type: "json" };
import crosswalk from "../../worker/src/data/agency_crosswalk.json" with { type: "json" };
import propertyCrossDomain from "../../site/data/property_cross_domain_lookup.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const AGENCY_SOURCE_IDENTITY_SNAPSHOT_SCHEMA = "cityscroll.agency_source_identity_snapshot.v1";

export function agencyRouteDirectoryNames({ root = ROOT } = {}) {
  return readdirSync(join(root, "site/agencies"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Build the full deterministic regression envelope. */
export function buildAgencySourceIdentitySnapshot({ root = ROOT } = {}) {
  const routes = agencyRouteDirectoryNames({ root });
  const contract = buildAgencySourceIdentityContract({
    crosswalk,
    routes,
    propertyCrossDomain,
  });
  const scopeHrefs = {};
  const followHrefs = {};
  for (const ref of contract.subject_refs.refs) {
    const id = ref.replace(/^agency:id:/, "");
    scopeHrefs[ref] = agencyScopeHref("rules", id);
    followHrefs[ref] = agencyCategoryFollowHref(id, "contracts");
  }
  return {
    schema: AGENCY_SOURCE_IDENTITY_SNAPSHOT_SCHEMA,
    generated_from: Object.freeze({
      route_identity_report: routeIdentityReport.generated_at || null,
      route_directory_count: routes.length,
    }),
    contract,
    scope_hrefs: sortEntries(scopeHrefs),
    follow_hrefs: sortEntries(followHrefs),
  };
}

function sortEntries(record) {
  return Object.freeze(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}
