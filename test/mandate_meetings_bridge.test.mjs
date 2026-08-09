import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENCY_CONSTELLATION_SECTIONS,
} from "../site/agency_constellation_section_registry.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  MANDATE_MEETING_EDGE_TYPE,
  MANDATE_MEETINGS_METHOD,
  agencyMandateMeetingsPath,
  buildMandateMeetingsView,
  renderMandateMeetingsSection,
} from "../site/mandate_meetings_bridge.mjs";
import {
  CROSS_BRIDGE_MANDATE_SUBJECT_REF,
  CROSS_BRIDGE_OBLIGATION_ID,
} from "./helpers/mandate_subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const obligations = JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
const meetings = JSON.parse(readFileSync(join(ROOT, "site/data/meetings_domain_observations.json"), "utf8"));
const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
const processConformance = JSON.parse(readFileSync(join(ROOT, "site/data/process_conformance_lookup.json"), "utf8"));
const crossSpineGate = JSON.parse(readFileSync(join(ROOT, "site/data/cross_spine_edge_gate.json"), "utf8"));

const mandate = {
  obligation_id: CROSS_BRIDGE_OBLIGATION_ID,
  matter_id: "matter-1",
  agency_id: "landmarks-preservation-commission",
  agency_name: "Landmarks Preservation Commission",
  duty_text: "The commission shall hold a public hearing to consider any landmark under consideration for landmark designation.",
  deliverable_type: "other",
  citation: "Administrative Code section 25-303(l)(2)",
  source: { legistar_url: "https://example.test/law" },
  certification: { status: "auto_certified", quote_verified: true },
};

test("mandate meetings bridge is a registered constellation section", () => {
  const section = AGENCY_CONSTELLATION_SECTIONS.find((entry) => entry.id === "mandate-meetings");
  assert.ok(section);
  assert.equal(typeof section.render, "function");
  assert.equal(
    agencyMandateMeetingsPath("landmarks-preservation-commission"),
    "/agencies/landmarks-preservation-commission/#mandates-meetings",
  );
});

test("resolver requires agency, event kind, and subject scope rather than title alone", () => {
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: {
        "landmarks-preservation-commission": { obligations: [mandate] },
      },
    },
    meetingsDomain: {
      rows: [
        {
          request_id: "right",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Public Hearing Agenda",
          matter_id: "matter-1",
          subject: "Landmark designation public hearing",
          type_of_notice_description: "Public Hearings",
          event_date: "2026-08-18T09:00:00.000",
          temporal_compatible: true,
          source_system: "city_record",
        },
        {
          request_id: "wrong-agency",
          agency_name: "Transportation",
          short_title: "Landmark Designation Public Hearing",
          type_of_notice_description: "Public Hearings",
        },
        {
          request_id: "wrong-event",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Landmark designation contract award",
          type_of_notice_description: "Contract Award Hearings",
          section_name: "Procurement",
        },
      ],
    },
    generatedAt: "2026-08-08T12:00:00Z",
    crossSpineGate,
  });

  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_MEETINGS_METHOD);
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].meeting.request_id, "right");
  assert.equal(view.edges[0].relation, MANDATE_MEETING_EDGE_TYPE);
  assert.equal(view.edges[0].mandate.subject_ref, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(view.edges[0].entity_link.source_record_id, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.deepEqual(view.edges[0].match.keys, ["agency", "event_kind", "matter_body_subject", "temporal"]);
  assert.ok(view.edges[0].match.subject_scope.includes("landmark"));
  assert.equal(view.edges[0].match.matter_exact, true);
  assert.equal(view.edges[0].match.temporal_compatible, true);
  assert.equal(view.edges[0].edge_policy.tier, "public_inferred");
  assert.equal(view.edges[0].entity_link.tier, "public_inferred");
  assert.match(view.edges[0].entity_link.id, /^entity-link:mandate-meeting:/);
  assert.match(view.edges[0].resolution_run.id, /^resolution-run:mandate-meeting:/);
  assert.equal(view.edges[0].process_conformance.status, "observed");
  assert.equal(view.edges[0].claim.enrichment.entity_link_id.available, true);
  assert.equal(view.edges[0].claim.enrichment.resolution_run_id.available, true);
});

test("unresolved mandates and empty agencies render nothing", () => {
  const view = buildMandateMeetingsView("transportation", {
    obligationsLookup: {
      by_agency: {
        transportation: {
          obligations: [{
            ...mandate,
            obligation_id: "transport-1",
            agency_id: "transportation",
            agency_name: "Transportation",
            duty_text: "Hold a required public hearing on a sidewalk-cafe petition.",
          }],
        },
      },
    },
    meetingsDomain: {
      rows: [{
        request_id: "generic",
        agency_name: "Transportation",
        short_title: "General Public Hearing",
        type_of_notice_description: "Public Hearings",
      }],
    },
    crossSpineGate,
  });
  assert.equal(view.status, "empty");
  assert.deepEqual(view.edges, []);
  assert.equal(renderMandateMeetingsSection(view), "");
});

test("live snapshot with no matter/body subject or temporal evidence publishes no meeting edge", () => {
  const view = buildAgencyConstellationView("landmarks-preservation-commission", {
    obligations,
    meetings_domain: meetings,
    intelligence,
    certification,
    process_conformance: processConformance,
    cross_spine_gate: crossSpineGate,
  });
  assert.equal(view.mandates_meetings, undefined);

  const html = renderAgencyConstellationDocument(view);
  assert.doesNotMatch(html, /id="mandates-meetings"/);
  assert.doesNotMatch(html, /not yet|no meeting|unresolved|not adjudicated|methodology/i);
});

test("a failed held-out gate keeps otherwise supported candidates in evidence-only shadow", () => {
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [mandate] } },
    },
    meetingsDomain: {
      rows: [{
        request_id: "shadow",
        agency_name: "Landmarks Preservation Commission",
        short_title: "Landmark designation public hearing",
        subject: "Landmark designation public hearing",
        matter_id: "matter-1",
        type_of_notice_description: "Public Hearings",
        event_date: "2026-08-18T09:00:00.000",
        temporal_compatible: true,
      }],
    },
    crossSpineGate: { gate: { mandate_meeting: { passed: false, precision: 0.89, min_precision: 0.9, status: "fail" } } },
  });
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.deepEqual(view.shadow_edges[0].reason, ["held_out_precision_gate"]);
  assert.equal(view.shadow_edges[0].decision, "evidence_only");
  assert.equal(view.shadow_edges[0].mandate, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(view.shadow_edges[0].entity_link.source_record_id, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(view.shadow_edges[0].entity_link.tier, "evidence_only");
});
