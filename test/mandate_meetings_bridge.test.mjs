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

test("live one-time LPC mandates without explicit end evidence publish no meeting edge", () => {
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

test("live recurring DOT mandate publishes subject-overlap meetings after enactment", () => {
  const view = buildMandateMeetingsView("transportation", {
    obligationsLookup: obligations,
    meetingsDomain: meetings,
    crossSpineGate,
  });
  assert.equal(view.status, "matched");
  assert.equal(view.edges.length, 3, "reader view keeps the existing per-mandate cap");
  assert.ok(view.edges.every((edge) => edge.match.subject_scope.length >= 2));
  assert.ok(view.edges.every((edge) => edge.match.temporal.method === "mandate_recurring_open_window_v1"));
  assert.ok(view.edges.every((edge) => edge.match.temporal.window.start === "2023-08-16"));
  assert.ok(view.edges.every((edge) => edge.edge_policy.tier === "public_inferred"));
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

test("matter-subject stamps feed scope matching but cannot bypass temporal compatibility", () => {
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [mandate] } },
    },
    meetingsDomain: {
      rows: [{
        request_id: "stamped-shadow",
        agency_name: "Landmarks Preservation Commission",
        short_title: "Public Hearing Agenda",
        type_of_notice_description: "Public Hearings",
        event_date: "2026-08-18T09:00:00.000",
        matter_subject: {
          schema: "cityscroll.meeting_matter_stamp.v1",
          subject_tokens: ["landmark", "designation"],
          matter_ids: ["pdc:30458"],
        },
      }],
    },
    crossSpineGate,
  });

  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.deepEqual(view.shadow_edges[0].match.subject_scope, ["landmark", "designation"]);
  assert.deepEqual(view.shadow_edges[0].match.meeting_matter_ids, ["pdc:30458"]);
  assert.deepEqual(view.shadow_edges[0].reason, ["temporal"]);
});

test("recurring meeting mandates open only after a verified law anchor", () => {
  const recurring = {
    ...mandate,
    obligation_id: "recurring-window-1",
    matter_id: "recurring-window-law",
    duty_text: "Hold ongoing public hearings on sidewalk cafe petitions.",
    recurrence: "ongoing",
    enactment_date: "2024-01-15",
    effective_date: "2024-02-01",
    temporal_anchor_method: "law_envelope_strict_iso_v1",
  };
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [recurring] } },
    },
    meetingsDomain: {
      rows: [
        {
          request_id: "pre-law",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Sidewalk cafe petition hearing",
          subject: "Sidewalk cafe petition public hearing",
          type_of_notice_description: "Public Hearings",
          event_date: "2024-01-31T09:00:00.000",
        },
        {
          request_id: "post-law",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Sidewalk cafe petition hearing",
          subject: "Sidewalk cafe petition public hearing",
          type_of_notice_description: "Public Hearings",
          event_date: "2026-08-18T09:00:00.000",
        },
      ],
    },
    crossSpineGate,
  });

  assert.deepEqual(view.edges.map((edge) => edge.meeting.request_id), ["post-law"]);
  assert.equal(view.edges[0].match.temporal.method, "mandate_recurring_open_window_v1");
  assert.equal(view.edges[0].match.temporal.anchor_field, "effective_date");
  assert.deepEqual(view.edges[0].match.temporal.window, { start: "2024-02-01", end: null });
  const preLaw = view.shadow_edges.find((edge) => edge.meeting.request_id === "pre-law");
  assert.deepEqual(preLaw.reason, ["temporal"]);
  assert.equal(preLaw.match.temporal.compatible, false);
});

test("one-time meeting mandates require explicit start and end evidence", () => {
  const oneTime = {
    ...mandate,
    obligation_id: "one-time-window-1",
    matter_id: "one-time-window-law",
    duty_text: "Hold a public hearing on sidewalk cafe petitions.",
    recurrence: "one-time",
    deadline: { computed_date: "2024-06-01" },
    enactment_date: "2024-01-15",
    effective_date: "2024-02-01",
    temporal_anchor_method: "law_envelope_strict_iso_v1",
  };
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: [oneTime] } },
    },
    meetingsDomain: {
      rows: [
        {
          request_id: "inside-one-time-window",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Sidewalk cafe petition hearing",
          subject: "Sidewalk cafe petition public hearing",
          type_of_notice_description: "Public Hearings",
          event_date: "2024-05-01",
        },
        {
          request_id: "expired-one-time-window",
          agency_name: "Landmarks Preservation Commission",
          short_title: "Sidewalk cafe petition hearing",
          subject: "Sidewalk cafe petition public hearing",
          type_of_notice_description: "Public Hearings",
          event_date: "2024-06-02",
        },
      ],
    },
    crossSpineGate,
  });

  assert.deepEqual(view.edges.map((edge) => edge.meeting.request_id), ["inside-one-time-window"]);
  assert.equal(view.edges[0].match.temporal.method, "mandate_one_time_explicit_window_v1");
  assert.deepEqual(view.edges[0].match.temporal.window, { start: "2024-02-01", end: "2024-06-01" });
  const expired = view.shadow_edges.find((edge) => edge.meeting.request_id === "expired-one-time-window");
  assert.deepEqual(expired.reason, ["temporal"]);
});

test("missing and malformed law anchors fail closed", () => {
  const rows = [
    {
      ...mandate,
      obligation_id: "missing-anchor",
      duty_text: "Hold ongoing public hearings on sidewalk cafe petitions.",
      recurrence: "ongoing",
    },
    {
      ...mandate,
      obligation_id: "malformed-anchor",
      duty_text: "Hold ongoing public hearings on sidewalk cafe petitions.",
      recurrence: "ongoing",
      enactment_date: "2024-02-30",
      effective_date: "2024-13-01",
      temporal_anchor_method: "law_envelope_strict_iso_v1",
    },
  ];
  const view = buildMandateMeetingsView("landmarks-preservation-commission", {
    obligationsLookup: {
      by_agency: { "landmarks-preservation-commission": { obligations: rows } },
    },
    meetingsDomain: {
      rows: [{
        request_id: "undated-law-meeting",
        agency_name: "Landmarks Preservation Commission",
        short_title: "Sidewalk cafe petition hearing",
        subject: "Sidewalk cafe petition public hearing",
        type_of_notice_description: "Public Hearings",
        event_date: "2026-08-18",
      }],
    },
    crossSpineGate,
  });

  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 2);
  for (const edge of view.shadow_edges) {
    assert.deepEqual(edge.reason, ["temporal"]);
    assert.equal(edge.match.temporal.compatible, false);
    assert.equal(edge.match.temporal.method, null);
  }
});
