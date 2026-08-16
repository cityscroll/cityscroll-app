import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { BROWSE_ROUTE_ALIASES } from "../site/browse_route_aliases.mjs";


const FIRST_PAINT_FIXTURES = Object.freeze([
  {
    lens: "Contracts",
    facet: "contracts",
    payload: { notices: [{ request_id: "contract-1", short_title: "School food services" }] },
    target: "/notices/contract-1",
  },
  {
    lens: "People + organizations / Staffing",
    facet: "staffing",
    payload: { notices: [{ request_id: "staffing-1", short_title: "Appointment record" }] },
    target: "/notices/staffing-1",
  },
  {
    lens: "Land / zoning",
    facet: "zoning",
    payload: { projects: [{ project_id: "2026M0001", project_name: "Example Street rezoning" }] },
    target: "/browse/zoning/#land/2026M0001",
  },
  {
    lens: "Rules",
    facet: "rules",
    payload: { rows: [{ request_id: "rule-1", short_title: "Street-vending rule" }] },
    target: "/notices/rule-1",
  },
  {
    lens: "Meetings",
    facet: "meetings",
    payload: { rows: [{ meeting_id: "meeting:city_record:meeting-1", request_id: "meeting-1", short_title: "Community-board hearing" }] },
    target: "/meetings/meeting%3Acity_record%3Ameeting-1",
  },
]);


test("build-rendered Browse cards keep the shared title and Copy grammar before hydration", () => {
  for (const fixture of FIRST_PAINT_FIXTURES) {
    const html = renderBrowseView(buildBrowseView(fixture.facet, fixture.payload));
    assert.match(
      html,
      new RegExp(
        `class="ui-constellation-link [^"]*ui-object-card-title[^"]*"[^>]*href="${fixture.target.replaceAll("/", "\\/")}"[^>]*><span aria-hidden="true">◆<\\/span>`,
      ),
      `${fixture.lens}: first-paint title keeps the canonical internal target`,
    );
    assert.match(
      html,
      new RegExp(
        `class="ui-object-card-copy"[^>]*data-object-card-copy="https:\\/\\/cityscroll\\.org${fixture.target.replaceAll("/", "\\/")}"[^>]*>Copy link<\\/button>`,
      ),
      `${fixture.lens}: first-paint Copy matches the title target`,
    );
    assert.doesNotMatch(html, /ui-object-card-action-rail|What can I do now/, `${fixture.lens}: first paint invents no action rail`);
  }
});

test("Exams declares Staffing as its sole renderer before hydration and in the browser", () => {
  assert.deepEqual(
    {
      route: BROWSE_ROUTE_ALIASES.exams.route,
      targetFacet: BROWSE_ROUTE_ALIASES.exams.targetFacet,
      targetTab: BROWSE_ROUTE_ALIASES.exams.targetTab,
      defaultView: BROWSE_ROUTE_ALIASES.exams.defaultView,
    },
    {
      route: "/browse/exams/",
      targetFacet: "staffing",
      targetTab: "people",
      defaultView: "guide",
    },
  );
});
