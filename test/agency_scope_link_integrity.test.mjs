import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import * as Scope from "../site/scope_v0.mjs";
import { buildAgencyConnectionView } from "../site/agency_connections.mjs";
import { BROWSE_FACETS, buildBrowseView } from "../site/browse_view.mjs";
import { chooseHearingScope } from "../site/hearing_location.js";
import { agencyNameFromEntityFacet } from "../site/agency_scope_route.mjs";

const MEETINGS_FIXTURE = new URL(
  "../site/data/meetings_domain_observations.json",
  import.meta.url,
);
const TARGET_REF = "agency:id:citywide-administrative-services";
const ENTITY_FIXTURE = new URL("../site/data/entity_intelligence_lookup.json", import.meta.url);

function liveHearingRows() {
  const payload = JSON.parse(fs.readFileSync(MEETINGS_FIXTURE, "utf8"));
  return payload.rows.map((row) => ({
    request_id: row.request_id,
    agency: row.agency_name,
    title: row.short_title,
    event_date: row.event_date,
    affected_area: row.affected_area || { scope: "unlocated" },
  }));
}

test("reported Meetings agency scope follows the facet into the live-shaped result set", () => {
  const records = liveHearingRows();
  const targetAgency = agencyNameFromEntityFacet({ entity_refs_all: [TARGET_REF] });
  const targetId = resolveAgencyIdentity(targetAgency).canonical_id;
  const scoped = chooseHearingScope(records, {
    when: "all",
    agency: targetAgency,
  }, "2026-08-06", false).rows;

  assert.ok(targetAgency, "the typed agency ref resolves to a display name");
  assert.ok(scoped.length > 0, "the observed Citywide Administrative Services fixture has meetings");
  assert.ok(scoped.length < records.length, "the agency scope must be non-trivially narrower than all meetings");
  assert.ok(scoped.every((record) => resolveAgencyIdentity(record.agency).canonical_id === targetId),
    "every scoped result must carry the requested canonical agency edge");
});

test("agency connection links are executable, scoped Browse links across populated lenses", () => {
  const lookup = JSON.parse(fs.readFileSync(ENTITY_FIXTURE, "utf8"));
  const response = lookup.by_ref[TARGET_REF];
  const agencyView = buildAgencyConnectionView(response, { scope: Scope });
  const populatedGroups = agencyView.groups.filter((group) => group.view_all_href);

  assert.ok(populatedGroups.length >= 2, "the fixture exercises more than one agency lens");
  for (const group of populatedGroups) {
    const url = new URL(group.view_all_href, "https://cityscroll.org");
    const facet = Object.entries(BROWSE_FACETS).find(([, config]) => config.route === url.pathname)?.[0];
    assert.ok(facet, `${group.domain} scope link maps to a registered Browse facet`);
    const payloadPath = new URL(`../site${BROWSE_FACETS[facet].dataPath}`, import.meta.url);
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    const view = buildBrowseView(facet, payload, url.searchParams, { limit: 1000 });

    assert.equal(view.scope.mode, "applied", `${group.domain} scope is applied`);
    assert.ok(view.total > 0, `${group.domain} scope has observed records`);
    assert.ok(view.total < view.preScopeTotal, `${group.domain} scope is non-trivially narrower`);
    assert.ok(view.rows.every((row) => {
      const agency = row.agency_name || row.primary_applicant || "";
      return resolveAgencyIdentity(agency).canonical_id === "citywide-administrative-services";
    }), `${group.domain} results all carry the target agency edge`);
  }
});
