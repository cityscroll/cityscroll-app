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
  MANDATE_GOVERNS_PROCEDURE,
  MANDATE_LAND_USE_EDGE_TYPE,
  MANDATE_LAND_USE_METHOD,
  PROJECT_PARTICIPATES_IN_PROCEDURE,
  agencyMandateLandUsePath,
  buildMandateLandUseView,
  composePublicProcedurePaths,
  landActionKinds,
  landProcedureKinds,
  mandateLandUseKinds,
  mandateLandUseProcedures,
  renderMandateLandUseSection,
} from "../site/mandate_land_use_bridge.mjs";
import {
  CROSS_BRIDGE_MANDATE_SUBJECT_REF,
  CROSS_BRIDGE_OBLIGATION_ID,
} from "./helpers/mandate_subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const obligations = JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
const landProjects = JSON.parse(readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"));

const mandate = {
  obligation_id: CROSS_BRIDGE_OBLIGATION_ID,
  agency_id: "landmarks-preservation-commission",
  agency_name: "Landmarks Preservation Commission",
  duty_text: "The commission shall designate the landmark within 180 days after the public hearing.",
  project_id: "right",
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
          current_milestone: "Designation approved",
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
  assert.equal(view.edges[0].mandate.subject_ref, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(view.edges[0].entity_link.source_record_id, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.deepEqual(view.edges[0].match.keys, [
    "agency", "land_action_kind", "project_identity", "mandate_phase_compatible",
  ]);
  assert.deepEqual(view.edges[0].match.subject_scope, ["landmark_designation"]);
  assert.equal(view.edges[0].match.project_identity, true);
  assert.equal(view.edges[0].match.project_identity_detail.matched, true);
  assert.equal(view.edges[0].match.mandate_phase_compatible, true);
  assert.equal(view.edges[0].match.mandate_phase_detail.compatible, true);
  assert.equal(view.edges[0].entity_link.tier, "public_inferred");
  assert.match(view.edges[0].entity_link.id, /^entity-link:mandate-land-use:/);
  assert.match(view.edges[0].resolution_run.id, /^resolution-run:mandate-land-use:/);
  assert.equal(view.edges[0].process_conformance.status, "observed");
  assert.equal(view.edges[0].claim.enrichment.entity_link_id.available, true);
  assert.equal(view.edges[0].claim.enrichment.resolution_run_id.available, true);
  assert.equal(view.edges[0].claim.claim_id, view.edges[0].entity_link.id);
  assert.equal(view.procedure_paths.length, 0, "landmark designation is a family, not a review procedure");
});

test("composed procedure paths require both public edges", () => {
  const mandateEdge = {
    type: MANDATE_GOVERNS_PROCEDURE,
    from: "mandate:54431-002",
    to: "procedure:ulurp",
    public: true,
  };
  const projectEdge = {
    type: PROJECT_PARTICIPATES_IN_PROCEDURE,
    from: "project:2026K0443",
    to: "procedure:ulurp",
    public: true,
  };
  assert.equal(composePublicProcedurePaths([mandateEdge], [projectEdge]).length, 1);
  assert.deepEqual(composePublicProcedurePaths(
    [mandateEdge],
    [{ ...projectEdge, public: false }],
  ), []);
  assert.deepEqual(composePublicProcedurePaths(
    [{ ...mandateEdge, public: false }],
    [projectEdge],
  ), []);
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

test("live Landmarks materialization keeps agency-only land actions in shadow", () => {
  const view = buildAgencyConstellationView("landmarks-preservation-commission", {
    obligations,
    intelligence,
    land_projects: landProjects,
  });
  assert.equal(view.mandates_land_use.edges.length, 0);
  assert.ok(view.mandates_land_use.shadow_edges.length >= 1);
  assert.ok(view.mandates_land_use.shadow_edges.every((edge) => edge.decision === "evidence_only"));
  // Agency-only actions never promote: withholding reason is missing project
  // identity on the mandate. Phase may be compatible on current sell-facing
  // rows after a WH-05 refresh; that alone must not publish the edge.
  assert.ok(view.mandates_land_use.shadow_edges.every((edge) => {
    const reasons = Array.isArray(edge.reason) ? edge.reason : [edge.reason];
    return reasons.includes("project_identity");
  }));
  assert.ok(view.mandates_land_use.shadow_edges.every((edge) => edge.match?.project_identity === false));
  assert.ok(view.mandates_land_use.shadow_edges.every((edge) => (
    edge.land_action.action_kinds.includes("landmark_designation")
  )));
  // Landmark designation is a family. Procedure paths require a shared
  // ulurp|elurp|non_ulurp kind named by both the law and the publisher row.
  assert.ok(view.mandates_land_use.project_procedure_edges.every((edge) => (
    edge.to === "procedure:non_ulurp" || edge.to === "procedure:ulurp" || edge.to === "procedure:elurp"
  )));
  assert.equal(view.mandates_land_use.procedure_paths.length, 0);
  const html = renderAgencyConstellationDocument(view);
  assert.doesNotMatch(html, /Landmark designation procedure/);
  assert.doesNotMatch(html, /requires project|mandate requires this project/i);
});

test("PQ is acquisition and ELURP is a first-class procedure edge", () => {
  assert.deepEqual(landActionKinds({ actions: "PQ" }), ["acquisition"]);
  assert.deepEqual(landActionKinds({ actions: "PS; PQ" }), ["site_selection", "acquisition"]);
  assert.deepEqual(landActionKinds({ actions: "PC; PP" }), ["acquisition", "disposition"]);
  assert.deepEqual(landProcedureKinds({ ulurp_non: "ELURP" }), ["elurp"]);
  assert.deepEqual(landProcedureKinds({ open_data: { ulurp_non: "ELURP" } }), ["elurp"]);
  assert.deepEqual(landProcedureKinds({ ulurp_non: "Non-ULURP" }), ["non_ulurp"]);
  assert.deepEqual(mandateLandUseKinds({ duty_text: "The agency shall complete the site acquisition." }), ["acquisition"]);
  assert.deepEqual(mandateLandUseKinds({ duty_text: "The agency shall complete site selection." }), ["site_selection"]);
  assert.deepEqual(mandateLandUseProcedures({
    duty_text: "The agency shall file an ELURP application for the acquisition.",
  }), ["elurp"]);
  assert.equal(mandateLandUseKinds({
    duty_text: "The agency shall file an application under the uniform land use review procedure.",
  }).includes("ulurp"), false);

  const view = buildMandateLandUseView("parks-and-recreation", {
    obligationsLookup: {
      by_agency: {
        "parks-and-recreation": {
          obligations: [{
            obligation_id: "elurp-acq-001",
            agency_id: "parks-and-recreation",
            duty_text: "The department shall complete the site acquisition through ELURP.",
            project_id: "2025R0257",
            certification: { status: "auto_certified", quote_verified: true },
            source: { legistar_url: "https://example.test/elurp" },
          }],
        },
      },
    },
    entityIntelligence: {
      by_ref: {
        "agency:id:parks-and-recreation": {
          domains: {
            land: {
              objects: [{
                subject_ref: "project:2025R0257",
                project_id: "2025R0257",
                label: "Saw Mill Creek Marsh",
                link_type: "applicant_agency",
                method: "agency_canonical_v1",
                provenance: {
                  source_system: "warehouse",
                  source_record_id: "warehouse:2025R0257",
                  input_value: "Parks and Recreation",
                },
              }],
            },
          },
        },
      },
    },
    landProjects: {
      rows: [{
        project_id: "2025R0257",
        project_name: "Saw Mill Creek Marsh",
        actions: "PQ",
        ulurp_non: "ELURP",
        primary_applicant: "Parks and Recreation",
        current_milestone: "Site acquisition certified",
        current_milestone_date: "2026-03-02",
      }],
    },
    generatedAt: "2026-08-18T12:00:00Z",
  });

  assert.deepEqual(view.edges[0].land_action.action_kinds, ["acquisition"]);
  assert.deepEqual(view.edges[0].land_action.procedure_kinds, ["elurp"]);
  assert.equal(view.edges[0].match.subject_scope.includes("site_selection"), false);
  assert.ok(view.project_procedure_edges.some((edge) => edge.to === "procedure:elurp" && edge.public === true));
  assert.ok(view.mandate_procedure_edges.some((edge) => edge.to === "procedure:elurp" && edge.public === true));
  assert.equal(view.procedure_paths.length, 1);
  assert.equal(view.procedure_paths[0].procedure.subject_ref, "procedure:elurp");
  assert.deepEqual(view.procedure_paths[0].project_edge.evidence.source_fields, [
    "project_id", "ulurp_non",
  ]);
});

test("project identity without a compatible mandate phase remains evidence-only", () => {
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [{
        ...mandate,
        duty_text: "The commission shall designate the landmark after the public hearing.",
        project_id: "right",
      }] } },
    },
    entityIntelligence: {
      by_ref: { "agency:id:landmarks-preservation-commission": { domains: { land: { objects: [{
        project_id: "right",
        subject_ref: "project:right",
        link_type: "applicant_agency",
        provenance: { input_value: "Landmarks Preservation Commission" },
      }] } } } },
    },
    landProjects: { rows: [{
      project_id: "right",
      project_name: "Public School Annex (LP-1000)",
      actions: "HI",
      primary_applicant: "Landmarks Preservation Commission",
      current_milestone: "Prepare Filed Land Use Application",
    }] },
  });
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.equal(view.shadow_edges[0].mandate, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(view.shadow_edges[0].entity_link.source_record_id, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.deepEqual(view.shadow_edges[0].reason, ["mandate_phase_compatible"]);
  assert.equal(view.shadow_edges[0].match.project_identity, true);
});

test("a sub-threshold land-use gate keeps an otherwise qualified edge in shadow", () => {
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [mandate] } },
    },
    entityIntelligence: {
      by_ref: { "agency:id:landmarks-preservation-commission": { domains: { land: { objects: [{
        project_id: "right",
        subject_ref: "project:right",
        link_type: "applicant_agency",
        provenance: { input_value: "Landmarks Preservation Commission" },
      }] } } } },
    },
    landProjects: { rows: [{
      project_id: "right",
      project_name: "Public School Annex (LP-1000)",
      actions: "HI",
      primary_applicant: "Landmarks Preservation Commission",
      current_milestone: "Designation approved",
    }] },
    crossSpineGate: {
      gate: { mandate_land_use: { status: "fail", precision: 0.89, min_precision: 0.9 } },
    },
  });
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.deepEqual(view.shadow_edges[0].reason, ["held_out_precision_gate"]);
  assert.equal(view.publication_gate.passed, false);
});
