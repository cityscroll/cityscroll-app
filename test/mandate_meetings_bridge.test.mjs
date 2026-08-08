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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const obligations = JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
const meetings = JSON.parse(readFileSync(join(ROOT, "site/data/meetings_domain_observations.json"), "utf8"));
const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
const processConformance = JSON.parse(readFileSync(join(ROOT, "site/data/process_conformance_lookup.json"), "utf8"));

const mandate = {
  obligation_id: "54431-002",
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
          type_of_notice_description: "Public Hearings",
          event_date: "2026-08-18T09:00:00.000",
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
  });

  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_MEETINGS_METHOD);
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].meeting.request_id, "right");
  assert.equal(view.edges[0].relation, MANDATE_MEETING_EDGE_TYPE);
  assert.deepEqual(view.edges[0].match.keys, ["agency", "event_kind", "subject_scope"]);
  assert.ok(view.edges[0].match.subject_scope.includes("landmark"));
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
  });
  assert.equal(view.status, "empty");
  assert.deepEqual(view.edges, []);
  assert.equal(renderMandateMeetingsSection(view), "");
});

test("live Landmarks materialization links hearing mandates to City Record meetings", () => {
  const view = buildAgencyConstellationView("landmarks-preservation-commission", {
    obligations,
    meetings_domain: meetings,
    intelligence,
    certification,
    process_conformance: processConformance,
  });
  assert.equal(view.mandates_meetings.status, "matched");
  assert.ok(view.mandates_meetings.counts.mandates >= 1);
  assert.ok(view.mandates_meetings.counts.meetings >= 1);
  assert.ok(view.mandates_meetings.edges.every((edge) => edge.meeting.request_id));
  assert.ok(view.claims.some((claim) => claim.category_id === "mandate-meetings"));

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-meetings"/);
  assert.match(html, /Mandates · Meetings and hearings/);
  assert.match(html, /data-mandate-meeting-edge=/);
  assert.match(html, /Watch mandates/);
  assert.match(html, /Follow meetings and hearings/);
  assert.doesNotMatch(html, /not yet|no meeting|unresolved|not adjudicated|methodology/i);
});
