import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDeferredFragment,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  LAND_USE_ACTION_CODE_FAMILY,
  normalizeLandUseActionType,
} from "../site/land_use_action_type.mjs";
import {
  CLASS_GOVERNED_LAND_USE_KINDS,
  MANDATE_GOVERNS_PROCEDURE,
  MANDATE_LAND_USE_CLASS_IDENTITY_BASIS,
  MANDATE_LAND_USE_EDGE_TYPE,
  MANDATE_LAND_USE_METHOD,
  PROJECT_PARTICIPATES_IN_PROCEDURE,
  agencyMandateLandUsePath,
  buildMandateLandUseView,
  composePublicProcedurePaths,
  landActionKinds,
  landProcedureKinds,
  mandateActionClassIdentity,
  mandateLandUseIdentity,
  mandateLandUseKinds,
  mandateLandUseProcedures,
  projectPlaceIdentity,
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
  assert.deepEqual(view.edges[0].match.subject_scope, ["landmark"]);
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

test("live Landmarks materialization restores the class-governed zoning edges (PC-04 regression)", () => {
  // Pins the LPC case from PC-04: the commission's three "landmark"
  // obligations under Administrative Code § 25-303(l) never name a place —
  // the law is written to govern every landmark item under consideration,
  // not one of them — so a legitimate identity basis other than place must
  // be established, or these obligations wrongly render as though nothing
  // were expected of the agency at all. A deterministic rebuild from the
  // currently committed sources must reproduce exactly the 3 obligations x
  // 3 in-flight LPC landmark designations = 9 edges the committed
  // conformance lookup has historically carried for this agency.
  const view = buildAgencyConstellationView("landmarks-preservation-commission", {
    obligations,
    intelligence,
    land_projects: landProjects,
  });
  const landUse = view.mandates_land_use;
  assert.equal(landUse.edges.length, 9);
  assert.equal(landUse.shadow_edges.length, 0);
  assert.deepEqual(
    new Set(landUse.edges.map((edge) => edge.mandate.mandate_id)),
    new Set(["54431-001", "54431-002", "54431-003"]),
  );
  assert.ok(landUse.edges.every((edge) => edge.entity_link.decision === "auto_link"));
  assert.ok(landUse.edges.every((edge) => edge.entity_link.tier === "public_inferred"));
  // Never a fabricated place match: the mandate itself carries no place
  // field, so the recorded basis is the closed action-family vocabulary,
  // honestly distinct from a genuine project_place_identity match.
  assert.ok(landUse.edges.every((edge) => edge.match.project_identity === true));
  assert.ok(landUse.edges.every((edge) => edge.match.identity_basis === MANDATE_LAND_USE_CLASS_IDENTITY_BASIS));
  assert.ok(landUse.edges.every((edge) => edge.match.project_identity_detail.matched === false));
  assert.ok(landUse.edges.every((edge) => (
    edge.land_action.action_kinds.includes("landmark")
  )));
  assert.ok(landUse.edges.every((edge) => (
    edge.entity_link.evidence.class_identity_detail.matched === true
  )));
  // Landmark designation is a family, not a review procedure: it never
  // composes into a procedure path, and procedure paths require a shared
  // ulurp|elurp|non_ulurp kind named by both the law and the publisher row.
  assert.ok(landUse.project_procedure_edges.every((edge) => (
    edge.to === "procedure:non_ulurp" || edge.to === "procedure:ulurp" || edge.to === "procedure:elurp"
  )));
  assert.equal(landUse.procedure_paths.length, 0);
  const html = renderAgencyConstellationDeferredFragment(view);
  assert.doesNotMatch(html, /Landmark designation procedure/);
  assert.match(html, /requires land-use action/);
  // The class basis is surfaced, not silently presented as a place match.
  assert.match(html, /governs every action of this kind rather than naming one project/);
});

test("a mandate carrying its own place field never falls back to the class basis", () => {
  // Protects against over-relaxation: a landmark mandate that legitimately
  // names a place, but fails to match any candidate on it, is a genuine
  // data gap — not license to treat every landmark action as class-governed.
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [{
          ...mandate,
          project_id: "some-other-site",
        }] },
      },
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
  });
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.equal(view.shadow_edges[0].match.identity_basis, null);
  assert.ok(view.shadow_edges[0].reason.includes("project_identity"));
});

// PC-04 A3/G2: an obligation the bridge compared and could not connect must be
// a readable state of its own, not the same silence as an agency that carries
// no land-use duty at all.
const unmatchedSources = {
  obligationsLookup: {
    by_agency: {
      "landmarks-preservation-commission": { obligations: [{
        ...mandate,
        project_id: "some-other-site",
      }] },
    },
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
};

test("an unmatched land-use obligation is a distinct readable state, not the empty page (PC-04 A3)", () => {
  const unmatched = buildMandateLandUseView("landmarks-preservation-commission", unmatchedSources);
  // Same agency, same candidate corpus, but carrying no land-use duty at all.
  const noObligation = buildMandateLandUseView("landmarks-preservation-commission", {
    ...unmatchedSources,
    obligationsLookup: { by_agency: { "landmarks-preservation-commission": { obligations: [] } } },
  });

  assert.equal(unmatched.edges.length, 0);
  assert.equal(noObligation.edges.length, 0);

  // The view records which case it is, and why no basis could be established.
  assert.equal(unmatched.gap_class, "identity_unestablished");
  assert.equal(noObligation.gap_class, "no_land_use_obligation");
  assert.equal(unmatched.unestablished_obligations.length, 1);
  assert.equal(noObligation.unestablished_obligations.length, 0);
  const [unestablished] = unmatched.unestablished_obligations;
  assert.equal(unestablished.mandate_id, CROSS_BRIDGE_OBLIGATION_ID);
  assert.equal(unestablished.identity_basis, null);
  assert.ok(unestablished.considered_actions >= 1);
  assert.ok(unestablished.reason.includes("project_identity"));

  const unmatchedHtml = renderMandateLandUseSection(unmatched);
  const noObligationHtml = renderMandateLandUseSection(noObligation);

  // An agency with nothing expected of it still says nothing.
  assert.equal(noObligationHtml, "");
  // An agency whose duty went unmatched says so, names the duty, and gives the reason.
  assert.notEqual(unmatchedHtml, "");
  assert.notEqual(unmatchedHtml, noObligationHtml);
  assert.match(unmatchedHtml, /data-status="unestablished"/);
  assert.match(unmatchedHtml, /designate the landmark/);
  assert.match(unmatchedHtml, /could not be connected/i);
  assert.match(unmatchedHtml, /1 land-use action/);
  assert.match(unmatchedHtml, /\(1 duty without a connected action\)/);
  // It never presents the gap as a connection.
  assert.doesNotMatch(unmatchedHtml, /Public School Annex/);
});

test("the unestablished state pluralizes duties correctly for more than one", () => {
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    ...unmatchedSources,
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [
          { ...mandate, obligation_id: `${CROSS_BRIDGE_OBLIGATION_ID}-a`, project_id: "some-other-site" },
          { ...mandate, obligation_id: `${CROSS_BRIDGE_OBLIGATION_ID}-b`, project_id: "some-other-site" },
        ] },
      },
    },
  });
  assert.equal(view.unestablished_obligations.length, 2);
  const html = renderMandateLandUseSection(view);
  assert.match(html, /\(2 duties without a connected action\)/);
  assert.doesNotMatch(html, /duty duties/);
});

test("the committed agency document carries the unestablished state, not silence (PC-04 A3 end-to-end)", () => {
  // Pins the reader-facing outcome on committed output, so the distinct state
  // cannot regress to an empty section and surface only when some unrelated
  // change happens to rebuild derived data.
  const document = JSON.parse(readFileSync(
    join(ROOT, "site/agencies/housing-preservation-and-development/relationships.json"),
    "utf8",
  ));
  const html = JSON.stringify(document);
  assert.match(html, /data-agency-constellation-card=\\"mandate-land-use\\"/);
  assert.match(html, /data-status=\\"unestablished\\"/);
  assert.match(html, /could not be connected to any land-use action/);
  assert.match(html, /Compared against \d+ land-use action/);

  // An agency with no land-use obligation still renders no section at all.
  const noObligationDocument = JSON.parse(readFileSync(
    join(ROOT, "site/agencies/aging/relationships.json"),
    "utf8",
  ));
  assert.doesNotMatch(
    JSON.stringify(noObligationDocument),
    /data-agency-constellation-card=\\"mandate-land-use\\"/,
  );
});

test("an obligation the bridge never compared makes no land-use claim (PC-04 A3 boundary)", () => {
  // No candidate land action exists for this agency, so the bridge performed no
  // comparison. Reporting an unestablished edge here would assert a land-use
  // duty the evidence does not support, so the section stays silent.
  const view = buildMandateLandUseView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [{ ...mandate, project_id: "some-other-site" }] },
      },
    },
    entityIntelligence: { by_ref: {} },
    landProjects: { rows: [] },
  });
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 0);
  assert.equal(view.unestablished_obligations.length, 0);
  assert.equal(view.gap_class, "empty_in_corpus");
  assert.equal(renderMandateLandUseSection(view), "");
});

test("mandateActionClassIdentity only fires for a closed, place-free action family", () => {
  assert.deepEqual(CLASS_GOVERNED_LAND_USE_KINDS, ["landmark"]);
  assert.equal(mandateActionClassIdentity({}, ["landmark"]).matched, true);
  assert.equal(mandateActionClassIdentity({}, ["landmark"]).basis, MANDATE_LAND_USE_CLASS_IDENTITY_BASIS);
  // Not a member of the closed vocabulary: no class basis.
  assert.equal(mandateActionClassIdentity({}, ["rezoning"]).matched, false);
  // A mandate carrying a place field is never let through on class alone.
  assert.equal(mandateActionClassIdentity({ project_id: "right" }, ["landmark"]).matched, false);
  // Empty subject scope never fires.
  assert.equal(mandateActionClassIdentity({}, []).matched, false);

  const placeMatch = mandateLandUseIdentity({ project_id: "right" }, { project_id: "right" }, ["landmark"]);
  assert.equal(placeMatch.matched, true);
  assert.equal(placeMatch.basis, "project_place_identity");
  assert.deepEqual(placeMatch.place, projectPlaceIdentity({ project_id: "right" }, { project_id: "right" }));

  const classMatch = mandateLandUseIdentity({}, { project_id: "right" }, ["landmark"]);
  assert.equal(classMatch.matched, true);
  assert.equal(classMatch.basis, MANDATE_LAND_USE_CLASS_IDENTITY_BASIS);

  const noMatch = mandateLandUseIdentity({}, { project_id: "right" }, ["rezoning"]);
  assert.equal(noMatch.matched, false);
  assert.equal(noMatch.basis, null);
});

test("PQ is acquisition and ELURP is a first-class procedure edge", () => {
  assert.deepEqual(landActionKinds({ actions: "PQ" }), ["acquisition"]);
  assert.deepEqual(landActionKinds({ actions: "PS; PQ" }), ["site_selection", "acquisition"]);
  assert.deepEqual(landActionKinds({ actions: "PC; PP" }), ["acquisition", "disposition"]);
  assert.deepEqual(landActionKinds({ actions: "LD" }), ["legal_document"]);
  assert.deepEqual(landActionKinds({ actions: "HI" }), ["landmark"]);
  assert.ok(!landActionKinds({ actions: "LD" }).includes("landmark"));
  assert.ok(!landActionKinds({ actions: "PQ" }).includes("site_selection"));
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

test("graph and UI land-use families share LAND_USE_ACTION_CODE_FAMILY", () => {
  const southRichmond = landProjects.rows.find((row) => row.project_id === "2025R0222");
  assert.ok(southRichmond, "warehouse must retain 2025R0222 St. Joseph by the Sea");
  const graph = landActionKinds(southRichmond);
  const ui = normalizeLandUseActionType(southRichmond);
  assert.deepEqual(graph, ui.families);
  assert.deepEqual(graph, [
    "special_permit",
    "certification",
    "authorization",
    "legal_document",
  ]);
  assert.ok(!graph.includes("landmark"));
  assert.ok(!graph.includes("landmark_designation"));

  for (const [code, family] of Object.entries(LAND_USE_ACTION_CODE_FAMILY)) {
    const row = { actions: code };
    assert.deepEqual(
      landActionKinds(row),
      [family],
      `graph landActionKinds(${code}) must follow LAND_USE_ACTION_CODE_FAMILY`,
    );
    assert.deepEqual(
      normalizeLandUseActionType(row).families,
      [family],
      `UI normalizeLandUseActionType(${code}) must follow LAND_USE_ACTION_CODE_FAMILY`,
    );
  }
});
