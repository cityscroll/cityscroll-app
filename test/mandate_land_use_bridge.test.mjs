import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  MANDATE_LAND_USE_EDGE_TYPE,
  MANDATE_LAND_USE_METHOD,
  agencyMandateLandUsePath,
  buildMandateLandUseView,
  mandateLandUseKinds,
  renderMandateLandUseSection,
} from "../site/mandate_land_use_bridge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const obligations = JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
const landProjects = JSON.parse(readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"));

const mandate = {
  obligation_id: "landmark-1",
  agency_id: "landmarks-preservation-commission",
  agency_name: "Landmarks Preservation Commission",
  duty_text: "The commission shall designate the landmark within 180 days after the public hearing.",
  deliverable_type: "other",
  citation: "Administrative Code section 25-303(l)(2)",
  source: { legistar_url: "https://example.test/law" },
  certification: { status: "auto_certified", quote_verified: true },
};

test("mandate land-use bridge is a registered constellation section", () => {
  const section = AGENCY_CONSTELLATION_SECTIONS.find((entry) => entry.id === "mandate-land-use");
  assert.ok(section);
  assert.equal(typeof section.render, "function");
  assert.equal(
    agencyMandateLandUsePath("landmarks-preservation-commission"),
    "/agencies/landmarks-preservation-commission/#mandates-land-use",
  );
});

test("resolver requires agency, structured action kind, and subject scope rather than title alone", () => {
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [mandate] },
      },
    },
    entityIntelligence: {
      by_ref: {
        "agency:id:landmarks-preservation-commission": {
          domains: {
            land: {
              objects: [
                {
                  subject_ref: "project:right",
                  project_id: "right",
                  label: "Public School Annex (LP-1000)",
                  link_type: "applicant_agency",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "warehouse",
                    source_record_id: "warehouse:right",
                    source_fields: ["primary_applicant"],
                    basis: "land_primary_applicant",
                    input_value: "LPC - NYC Landmarks Preservation Commission",
                  },
                },
                {
                  subject_ref: "project:title-only",
                  project_id: "title-only",
                  label: "Landmark designation study",
                  link_type: "applicant_agency",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "warehouse",
                    source_record_id: "warehouse:title-only",
                    source_fields: ["primary_applicant"],
                    basis: "land_primary_applicant",
                    input_value: "LPC - NYC Landmarks Preservation Commission",
                  },
                },
              ],
            },
          },
        },
        "agency:id:parks-and-recreation": {
          domains: {
            land: {
              objects: [{
                subject_ref: "project:wrong-agency",
                project_id: "wrong-agency",
                label: "Park landmark designation",
                link_type: "applicant_agency",
                method: "agency_canonical_v1",
                provenance: { input_value: "Parks and Recreation" },
              }],
            },
          },
        },
      },
    },
    landProjects: {
      rows: [
        {
          project_id: "right",
          project_name: "Public School Annex (LP-1000)",
          actions: "HI",
          primary_applicant: "LPC - NYC Landmarks Preservation Commission",
          current_milestone_date: "2026-08-08",
        },
        {
          project_id: "title-only",
          project_name: "Landmark designation study",
          actions: "ZR",
          primary_applicant: "LPC - NYC Landmarks Preservation Commission",
        },
        {
          project_id: "wrong-agency",
          project_name: "Park landmark designation",
          actions: "HI",
          primary_applicant: "Parks and Recreation",
        },
      ],
    },
    generatedAt: "2026-08-08T12:00:00Z",
  });

  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_LAND_USE_METHOD);
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].land_action.project_id, "right");
  assert.equal(view.edges[0].relation, MANDATE_LAND_USE_EDGE_TYPE);
  assert.deepEqual(view.edges[0].match.keys, ["agency", "land_action_kind", "subject_scope"]);
  assert.deepEqual(view.edges[0].match.subject_scope, ["landmark_designation"]);
  assert.match(view.edges[0].entity_link.id, /^entity-link:mandate-land-use:/);
  assert.match(view.edges[0].resolution_run.id, /^resolution-run:mandate-land-use:/);
  assert.equal(view.edges[0].process_conformance.status, "observed");
  assert.equal(view.edges[0].claim.enrichment.entity_link_id.available, true);
  assert.equal(view.edges[0].claim.enrichment.resolution_run_id.available, true);
  assert.equal(view.edges[0].claim.claim_id, view.edges[0].entity_link.id);
});

test("subject and temporal conditions suppress unsupported designation edges", () => {
  assert.deepEqual(mandateLandUseKinds({
    duty_text: "The commission shall designate the historic district within one year.",
  }), []);
  assert.deepEqual(mandateLandUseKinds({
    duty_text: "Landmarks calendared but not designated by the effective date of the local law shall be designated within 18 months.",
  }), []);
});

test("unresolved land-use mandates render nothing", () => {
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [mandate] },
      },
    },
    entityIntelligence: { by_ref: {} },
    landProjects: { rows: [] },
  });
  assert.equal(view.status, "empty");
  assert.deepEqual(view.edges, []);
  assert.equal(renderMandateLandUseSection(view), "");
});

test("live Landmarks materialization links designation mandates to ZAP land-use actions", () => {
  const view = buildAgencyConstellationView("landmarks-preservation-commission", {
    obligations,
    intelligence,
    land_projects: landProjects,
  });
  assert.equal(view.mandates_land_use.status, "matched");
  assert.ok(view.mandates_land_use.counts.mandates >= 1);
  assert.ok(view.mandates_land_use.counts.land_actions >= 1);
  assert.ok(view.mandates_land_use.edges.every((edge) => edge.land_action.project_id));
  assert.equal(
    new Set(view.mandates_land_use.edges.map((edge) => edge.claim.claim_id)).size,
    view.mandates_land_use.edges.length,
  );
  assert.ok(view.claims.some((claim) => claim.category_id === "mandate-land-use"));

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-land-use"/);
  assert.match(html, /Mandates · Land-use and zoning actions/);
  assert.match(html, /data-mandate-land-use-edge=/);
  assert.match(html, /Watch mandates/);
  assert.match(html, /Follow land-use and zoning actions/);
  assert.doesNotMatch(html, /not yet|no action|unresolved|not adjudicated|methodology/i);
});
