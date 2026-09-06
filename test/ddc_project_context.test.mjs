/**
 * Wider-project context on a construction solicitation.
 *
 * The relation under test connects a City Record procurement notice to the
 * capital project record the notice's own published project code belongs to.
 * The tests are grouped by the obligation each one discharges:
 *
 *   A1  the published population, re-derived here rather than read back
 *   A2  the matched project context a vendor actually sees
 *   A3  a published identifier that disagrees with itself
 *   A4  partial matches, blank scope, shared contracts, word collisions
 *   A5  the reader journeys: inspect, dismiss, full page, failed detail
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProjectContextView,
  projectContextAmount,
  projectContextInspectSummary,
  projectContextDay,
  projectRelationsForNotice,
  renderProjectContextHtml,
  projectContextReportingPeriod,
  unresolvedComponentsForNotice,
  PROCUREMENT_PROJECT_CONTEXT_SCHEMA,
  PROJECT_CONTEXT_RELATION,
} from "../site/procurement_project_context.mjs";
import { calendarPreviewInlineDetailReader, CALENDAR_PREVIEW_DETAIL_SELECTOR } from "../site/calendar_event_preview_boot.mjs";
import { CALENDAR_EVENT_PREVIEW_DIALOG_ID } from "../site/calendar_event_preview.mjs";
import {
  bindCompactMonthCalendar,
  buildCompactMonthView,
  renderCompactMonth,
} from "../site/compact_calendar.mjs";
import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import { click, mountDocument } from "./helpers/preview_dom.mjs";
import {
  BLANK_SCOPE_REQUEST_ID,
  BUNDLE_REQUEST_ID,
  MATERIALIZATION,
  MUSEUM_REQUEST_ID,
  QUALIFICATION_REQUEST_ID,
  renderCase,
} from "./fixtures/procurement_project_context_fixtures.mjs";

const FIXTURE_DIR = new URL("../warehouse/fixtures/procurement-project-context/", import.meta.url);

function readFixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));
}

const NOTICES = readFixture("city-record-ddc-notices.json");
const CAPITAL = readFixture("capital-ddc-project-index.json");
const CONTRACTS = readFixture("registered-ddc-contracts.json");

const NOTICE_TEXT_FIELDS = [
  "short_title",
  "additional_description_1",
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
];

/**
 * The join predicate, written out here on purpose.
 *
 * The population counts below would be worth nothing if they were read back
 * out of the same materialization that produced them, so this test re-derives
 * the relation from the frozen published records with an independently written
 * matcher, and only then compares. Two implementations agreeing on 347 notices
 * is evidence; one implementation agreeing with itself is not.
 */
function codesNamedIn(notice, roster) {
  const text = NOTICE_TEXT_FIELDS
    .map((field) => String(notice[field] ?? ""))
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .toUpperCase();
  const found = new Set();
  for (const code of roster) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(code, from);
      if (at < 0) break;
      const before = at === 0 ? "" : text[at - 1];
      const after = text[at + code.length] ?? "";
      const boundary = (char) => char === "" || !/[A-Z0-9-]/.test(char);
      if (boundary(before) && boundary(after)) { found.add(code); break; }
      from = at + 1;
    }
  }
  return [...found].sort();
}

const SOLICITATIONS = NOTICES.rows.filter((row) => row.type_of_notice_description === "Solicitation");
const INDEPENDENT = SOLICITATIONS.map((notice) => ({
  notice,
  codes: codesNamedIn(notice, CAPITAL.code_roster),
}));

function relationsFor(requestId) {
  return projectRelationsForNotice(MATERIALIZATION, requestId);
}

function projectViewFor(requestId) {
  return buildProjectContextView(MATERIALIZATION, { request_id: requestId });
}

function sectionOf(html) {
  const match = html.match(/<section class="project-context"[\s\S]*?<\/section>/);
  return match ? match[0] : null;
}

/* ---------- A1: the published population ---------- */

test("A1: the frozen corpus carries every published notice, and the solicitation denominator inside it", () => {
  assert.equal(NOTICES.rows.length, 347, "published procurement notices in the observed window");
  assert.equal(NOTICES.row_count, NOTICES.rows.length, "the corpus states its own row count honestly");
  assert.equal(SOLICITATIONS.length, 131, "solicitation notices — the denominator this relation applies to");
  assert.equal(new Set(NOTICES.rows.map((row) => row.request_id)).size, 347, "no duplicated notice");
  // The window and its extract date travel with the corpus, so a later reader
  // can tell what "published" meant here without asking anyone.
  assert.equal(NOTICES.observed_window.published_from, "2025-01-03");
  assert.equal(NOTICES.observed_window.published_through, "2026-09-04");
  assert.equal(NOTICES.extract_date, "2026-09-04");
});

test("A1: an independently written matcher reproduces the same 80 related notices and 71 project codes", () => {
  const related = INDEPENDENT.filter((entry) => entry.codes.length);
  const codes = new Set(related.flatMap((entry) => entry.codes));
  assert.equal(related.length, 80, "notices carrying a published project code for this agency");
  assert.equal(codes.size, 71, "distinct project codes those notices name");
  assert.equal(MATERIALIZATION.counts.solicitations_related, 80);
  assert.equal(MATERIALIZATION.counts.project_codes_related, 71);
  assert.equal(
    new Set(MATERIALIZATION.relations.map((relation) => relation.solicitation.request_id)).size,
    related.length,
    "the materialization relates exactly the notices the independent matcher relates",
  );
});

test("A1: the 51 unrelated solicitations stay unlinked, and carry no inferred relation", () => {
  const unrelated = INDEPENDENT.filter((entry) => !entry.codes.length);
  assert.equal(unrelated.length, 51);
  assert.equal(MATERIALIZATION.counts.solicitations_unlinked, 51);
  assert.equal(MATERIALIZATION.unlinked_solicitations.length, 51);
  const relatedIds = new Set(MATERIALIZATION.relations.map((r) => r.solicitation.request_id));
  for (const entry of unrelated) {
    assert.equal(relatedIds.has(entry.notice.request_id), false,
      `notice ${entry.notice.request_id} names no published project code and must stay unlinked`);
    assert.equal(relationsFor(entry.notice.request_id).length, 0);
    assert.equal(projectViewFor(entry.notice.request_id), null, "an unlinked notice produces no section at all");
  }
});

test("A1: schedule identity and published scope are counted separately, because they are separate facts", () => {
  const withSchedule = new Set();
  const withScope = new Set();
  for (const relation of MATERIALIZATION.relations) {
    if (relation.capital_project.schedule_identity) withSchedule.add(relation.solicitation.request_id);
    if (!relation.capital_project.project_scope_published_blank) withScope.add(relation.solicitation.request_id);
  }
  assert.equal(withSchedule.size, 76, "related notices whose project publishes a schedule number");
  assert.equal(withScope.size, 66, "related notices whose project publishes a description");
  assert.equal(MATERIALIZATION.counts.relations_with_schedule_identity, 76);
  assert.equal(MATERIALIZATION.counts.relations_with_project_scope, 66);
  assert.ok(withSchedule.size !== withScope.size,
    "the two counts differ, which is why the relation never treats one as evidence of the other");
});

test("A1: every relation names the exact code its evidence claims, in a field the notice actually published", () => {
  const byId = new Map(NOTICES.rows.map((row) => [row.request_id, row]));
  for (const relation of MATERIALIZATION.relations) {
    const notice = byId.get(relation.solicitation.request_id);
    assert.ok(notice, "every relation points at a notice in the corpus");
    const code = relation.evidence.matched_code;
    assert.ok(codesNamedIn(notice, [code]).includes(code),
      `notice ${notice.request_id} must publish ${code} as a whole token`);
    assert.ok(relation.evidence.matched_in.length > 0, "the evidence names the fields the code appears in");
    for (const field of relation.evidence.matched_in) {
      assert.ok(NOTICE_TEXT_FIELDS.includes(field), `${field} is a published notice field`);
    }
    assert.equal(relation.method, "exact_published_project_code");
    assert.equal(relation.evidence.managing_agency, "DDC");
    assert.equal(relation.capital_project.financial_identity.project_code, code);
  }
});

test("A1: the relation policy travels with the data, so no reader can present it without its terms", () => {
  assert.equal(MATERIALIZATION.schema, PROCUREMENT_PROJECT_CONTEXT_SCHEMA);
  assert.equal(MATERIALIZATION.policy.agency_match_alone_is_not_a_relation, true);
  assert.equal(MATERIALIZATION.policy.unresolved_candidates_remain_unlinked, true);
  assert.equal(MATERIALIZATION.policy.identifier_conflicts_preserved_unrepaired, true);
  assert.match(MATERIALIZATION.policy.amounts_are_project_scope, /never a solicitation value/);
  assert.match(MATERIALIZATION.policy.dates_are_project_scope, /never a bid deadline/);
  assert.match(MATERIALIZATION.policy.scope_is_wider_project, /never verified requirements/);
  // Source scope and observation dates stay inspectable on the artifact itself.
  assert.equal(MATERIALIZATION.source_scope.capital_projects.reporting_period, "202605");
  assert.match(MATERIALIZATION.source_scope.solicitations.source_url, /^https:\/\/data\.cityofnewyork\.us\//);
  // A materialization that fails the acceptance shape is ignored, not partly read.
  assert.deepEqual(projectRelationsForNotice({ ...MATERIALIZATION, schema: "other" }, MUSEUM_REQUEST_ID), []);
  assert.deepEqual(
    projectRelationsForNotice({ ...MATERIALIZATION, policy: { ...MATERIALIZATION.policy, agency_match_alone_is_not_a_relation: false } },
      MUSEUM_REQUEST_ID),
    [],
  );
});

test("A1: a project code is never matched inside a longer identifier", () => {
  const notice = {
    short_title: "ACEDCA215X and 12-ACEDCA215 and ACEDCA2159 upgrades",
    additional_description_1: "",
  };
  assert.deepEqual(codesNamedIn(notice, ["ACEDCA215"]), [],
    "a code touching another identifier character on either side is not a published code");
  assert.deepEqual(codesNamedIn({ short_title: "Work under ACEDCA215." }, ["ACEDCA215"]), ["ACEDCA215"]);
});

test("A1: the committed materialization is exactly what its owning builder produces", () => {
  const result = spawnSync(
    "python3",
    ["warehouse/scripts/capital_project_relations_run.py", "--check"],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  if (result.error?.code === "ENOENT") return; // no Python here; the gate runs where there is one.
  assert.equal(result.status, 0,
    `the materialization is stale against its inputs:\n${result.stderr || result.stdout}`);
});

/* ---------- A2: the matched project context ---------- */

test("A2: the museum notice joins this agency and ACEDCA215 to the project record", () => {
  const relations = relationsFor(MUSEUM_REQUEST_ID);
  assert.equal(relations.length, 1);
  const [relation] = relations;
  assert.equal(relation.relation, PROJECT_CONTEXT_RELATION);
  assert.deepEqual(relation.capital_project.financial_identity,
    { managing_agency: "DDC", project_code: "ACEDCA215" });
  assert.deepEqual(relation.capital_project.schedule_identity,
    { managing_agency: "DDC", schedule_ids: ["4369"] });
  assert.equal(relation.capital_project.sponsor_agency, "DCLA");
});

test("A2: the section states the wider project's published scope, including the temporary cooling and the electrical and plumbing work", () => {
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.ok(section, "the section renders for a matched notice");
  assert.match(section, /Temporary cooling will be needed to keep the facility operation during construction/);
  assert.match(section, /electrical, and plumbing work/);
  assert.match(section, /BCM-HVAC Upgrades/);
  assert.match(section, /ACEDCA215/);
  assert.match(section, /DCLA/);
});

test("A2: project figures are labeled as the project's, never as the advertised package's", () => {
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.match(section, /<dt>Project budget<\/dt><dd>\$19,905,486<\/dd>/);
  assert.match(section, /<dt>Recorded project spending<\/dt><dd>\$2,116,345<\/dd>/);
  assert.match(section, /<dt>Project forecast completion<\/dt><dd>June 25, 2029<\/dd>/);
  assert.match(section, /<dt>Project schedule number<\/dt><dd>4369<\/dd>/);
  // The words that would turn a project figure into a contractual one never appear.
  assert.doesNotMatch(section, /solicitation value|bid deadline|contract value|due date|estimated value/i);
  // And the section says outright which of the two things it describes.
  assert.match(section, /describes the whole project/i);
  assert.match(section, /the official notice is the only place its requirements are stated/i);
});

test("A2: the official notice action is preserved, unchanged, beside the project section", () => {
  const html = renderCase(MUSEUM_REQUEST_ID);
  const official = `https://a856-cityrecord.nyc.gov/RequestDetail/${MUSEUM_REQUEST_ID}`;
  assert.ok(html.includes(official), "the official City Record destination survives");
  assert.match(sectionOf(html), new RegExp(`href="${official}"`), "and is offered from the section itself");
  const view = projectViewFor(MUSEUM_REQUEST_ID);
  assert.equal(view.official_notice.href, official);
  // A caller-resolved official destination wins, so this never becomes a second
  // source of truth for where the official record lives.
  const supplied = buildProjectContextView(MATERIALIZATION, { request_id: MUSEUM_REQUEST_ID }, {
    officialNotice: { href: "https://example.invalid/notice", label: "City Record notice" },
  });
  assert.equal(supplied.official_notice.href, "https://example.invalid/notice");
  assert.equal(supplied.official_notice.label, "City Record notice");
});

test("A2: source observations are available on demand rather than in the default reading", () => {
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.match(section, /<details class="project-context-observations"><summary>Source records<\/summary>/);
  assert.match(section, /City capital project record published for May 2026/);
  assert.match(section, /Agency record dated June 23, 2026/);
  assert.match(section, /Financial record dated May 18, 2026/);
  assert.match(section, /href="https:\/\/data\.cityofnewyork\.us\/d\/fb86-vt7u"/);
  // The raw period code is never shown to a reader.
  assert.doesNotMatch(section, /202605/);
  assert.equal(projectContextReportingPeriod("202605"), "May 2026");
  assert.equal(projectContextReportingPeriod("2026"), null);
});

/* ---------- A3: an identifier that disagrees with itself ---------- */

test("A3: both published forms of the museum identifier survive, unrepaired", () => {
  const [relation] = relationsFor(MUSEUM_REQUEST_ID);
  assert.equal(relation.solicitation.structured_pin, "85026B0110");
  assert.deepEqual(relation.solicitation.body_identifiers, ["85026B01107"]);
  assert.equal(relation.solicitation.identifier_conflict, true);
  const view = projectViewFor(MUSEUM_REQUEST_ID);
  assert.deepEqual(view.identifier_conflict, { structured: "85026B0110", in_notice_text: ["85026B01107"] });
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.match(section, /85026B0110\b/);
  assert.match(section, /85026B01107/);
  assert.match(section, /Both appear here as the city published them/);
});

test("A3: the conflict never becomes a resolved portal handoff", () => {
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  // No claim that either identifier has been checked against, or will succeed
  // in, the city's procurement portal.
  assert.doesNotMatch(section, /PASSPort/i);
  assert.doesNotMatch(section, /verified identifier|corrected|resolves to|the correct (?:EPIN|PIN)/i);
  assert.match(section, /use the official notice to confirm which identifier the portal expects/i);
});

test("A3: the capital relation stands on the project code, so the identifier conflict cannot move it", () => {
  const [relation] = relationsFor(MUSEUM_REQUEST_ID);
  assert.equal(relation.evidence.matched_code, "ACEDCA215");
  assert.deepEqual(relation.evidence.matched_in, ["short_title"]);
  assert.equal(relation.capital_project.financial_identity.project_code, "ACEDCA215");
  // Neither published identifier is a project code, so neither can be the join.
  assert.equal(CAPITAL.code_roster.includes("85026B0110"), false);
  assert.equal(CAPITAL.code_roster.includes("85026B01107"), false);
});

/* ---------- A4: partial matches, blank scope, shared contracts, collisions ---------- */

test("A4: a project whose scope the city published blank renders no scope, and no empty row", () => {
  const [relation] = relationsFor(BLANK_SCOPE_REQUEST_ID);
  assert.equal(relation.evidence.matched_code, "PV279ACON");
  assert.equal(relation.capital_project.project_scope_published_blank, true);
  assert.equal(relation.capital_project.project_scope, null);
  const section = sectionOf(renderCase(BLANK_SCOPE_REQUEST_ID));
  assert.ok(section, "the rest of the section still renders");
  assert.doesNotMatch(section, /project-context-scope/, "no scope paragraph at all");
  assert.doesNotMatch(section, /&lt;blank&gt;|<blank>/, "the publisher's blank marker never reaches a reader");
  assert.match(section, /PV279ACON/);
  assert.match(section, /<dt>Project budget<\/dt>/, "the facts the city did publish are unaffected");
});

test("A4: a bundled notice relates only the component the city publishes, and says so", () => {
  const relations = relationsFor(BUNDLE_REQUEST_ID);
  assert.equal(relations.length, 1, "one component resolves");
  assert.equal(relations[0].evidence.matched_code, "LBK16SCRF");
  assert.equal(relations[0].capital_project.schedule_identity, null,
    "this project publishes no schedule number, and none is invented");
  assert.equal(CAPITAL.code_roster.includes("PV820HVAC"), false,
    "the other named component is not a published project code for this agency");
  assert.deepEqual(unresolvedComponentsForNotice(MATERIALIZATION, BUNDLE_REQUEST_ID), ["PV820HVAC"]);
  const section = sectionOf(renderCase(BUNDLE_REQUEST_ID));
  assert.match(section, /This notice also names PV820HVAC/);
  assert.match(section, /so it is not covered above/);
  assert.doesNotMatch(section, /<dt>Project schedule number<\/dt>/);
});

test("A4: a contract naming two project codes keeps both links, and neither implies whole-package coverage", () => {
  const edges = MATERIALIZATION.registered_contract_relations
    .filter((edge) => edge.registered_contract.contract_id === "CT1-850-20228803715");
  assert.deepEqual(edges.map((edge) => edge.evidence.matched_code).sort(), ["CO301LL", "CO301PD"]);
  // Two codes, two published schedule numbers: the components are genuinely
  // separate records, not one project written twice.
  assert.deepEqual(
    edges.map((edge) => edge.capital_project.schedule_identity.schedule_ids).flat().sort(),
    ["4155", "4156"],
  );
  for (const edge of edges) {
    assert.equal(edge.relation, "registered_contract_names_capital_project_code");
    assert.equal(edge.registered_contract.vendor, "LITEHOUSE BUILDERS, INC.");
  }
  assert.match(CONTRACTS.field_note, /not a complete package inventory/);
  // Contract edges are a separate relation and are never rendered as the
  // notice's project section.
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.doesNotMatch(section, /CT1-850-/);
});

test("A4: a word published as another agency's project code is never joined to this agency", () => {
  const collisions = CAPITAL.other_agency_codes.map((entry) => entry.fms_id).sort();
  assert.deepEqual(collisions, ["BATHGATE", "MASPETH"]);
  for (const entry of CAPITAL.other_agency_codes) {
    assert.notEqual(entry.managing_agency, "DDC");
    assert.equal(CAPITAL.code_roster.includes(entry.fms_id), false,
      `${entry.fms_id} belongs to ${entry.managing_agency} and is not on this agency's roster`);
  }
  const named = new Set(MATERIALIZATION.relations.map((relation) => relation.evidence.matched_code));
  assert.equal(named.has("BATHGATE"), false);
  assert.equal(named.has("MASPETH"), false);
  // A notice that does print one of those words still forms no relation, because
  // the roster the matcher is built from never contained it.
  assert.deepEqual(codesNamedIn({ short_title: "MASPETH and BATHGATE work" }, CAPITAL.code_roster), []);
});

test("A4: a qualification route is presented as one, not as a construction bid deadline", () => {
  const [relation] = relationsFor(QUALIFICATION_REQUEST_ID);
  assert.equal(relation.solicitation.structured_pin, "PQL000172");
  assert.equal(relation.solicitation.qualification_route, true);
  assert.equal(relation.solicitation.selection_method, "Request for Qualifications");
  const section = sectionOf(renderCase(QUALIFICATION_REQUEST_ID));
  assert.match(section, /route to a qualified vendor list/);
  assert.match(section, /not a construction bid deadline/);
  // Every other related notice keeps the flag off, so this is a published
  // property rather than a blanket disclaimer.
  const flagged = MATERIALIZATION.relations.filter((r) => r.solicitation.qualification_route);
  assert.ok(flagged.length >= 1);
  assert.ok(flagged.every((r) => r.solicitation.structured_pin.startsWith("PQL")));
});

/* ---------- A5: the reader journeys ---------- */

test("A5: an absent relation renders no section, no heading, and no empty panel", () => {
  const html = renderCase(MUSEUM_REQUEST_ID, { materialization: null });
  assert.equal(sectionOf(html), null);
  assert.doesNotMatch(html, /project-context/);
  assert.doesNotMatch(html, /The wider project/);
  // The pursuit page itself is unaffected: its official record is still there.
  assert.ok(html.includes(`https://a856-cityrecord.nyc.gov/RequestDetail/${MUSEUM_REQUEST_ID}`));
  assert.equal(renderProjectContextHtml(null), "");
});

test("A5: the section's stylesheet is requested only when the section renders", () => {
  assert.match(renderCase(MUSEUM_REQUEST_ID), /href="\/procurement_project_context\.css"/);
  assert.doesNotMatch(renderCase(MUSEUM_REQUEST_ID, { materialization: null }),
    /procurement_project_context\.css/);
});

test("A5: the section is a labelled landmark with one heading, so a keyboard reader can reach and name it", () => {
  const section = sectionOf(renderCase(MUSEUM_REQUEST_ID));
  assert.match(section, /<section class="project-context" aria-labelledby="project-context-heading"/);
  assert.match(section, /<h2 id="project-context-heading">The wider project<\/h2>/);
  assert.equal((section.match(/<h2/g) || []).length, 1, "exactly one heading in the section");
  // Every link in the section is a real destination with its own text, so
  // nothing here depends on scripting or on a pointer.
  for (const anchor of section.match(/<a [^>]*>/g) || []) {
    assert.match(anchor, /href="[^"]+"/);
    assert.match(anchor, /rel="noopener noreferrer"/);
  }
  assert.doesNotMatch(section, /<a[^>]*\shref="#"|onclick=/);
});

test("A5: the page inlines the one-line summary for in-place inspection, escaped so it cannot end its own element", () => {
  const html = renderCase(MUSEUM_REQUEST_ID);
  const block = html.match(/<script type="application\/json" data-project-context-inspect="1">([\s\S]*?)<\/script>/);
  assert.ok(block, "the inspection summary is inlined, not fetched");
  assert.doesNotMatch(block[1], /</, "no raw < survives into the inline JSON");
  const payload = JSON.parse(block[1].replace(/\\u003c/g, "<"));
  assert.match(payload.summary, /^Wider project: BCM-HVAC Upgrades/);
  assert.match(payload.summary, /project budget \$19,905,486/);
  assert.match(payload.summary, /project forecast June 25, 2029/);
  assert.match(payload.summary, /Project figures, not the advertised package\./);
  assert.equal(projectContextInspectSummary(null), null);
  assert.equal(projectContextInspectSummary({ projects: [] }), null);
  assert.equal(html.includes("data-project-context-inspect") && sectionOf(html) !== null, true,
    "the inspection line only exists where the full section also exists");
});

/**
 * A calendar month with one occurrence, mounted the way a procurement page
 * mounts one, so the inspect journey below runs against the shared binder
 * rather than a stand-in.
 */
function mountPursuitCalendar(detailBlock) {
  const canonical = `https://cityscroll.org/procurements/procurement:city-record:${MUSEUM_REQUEST_ID}`;
  const occurrence = (uid, date, title, kind) => createCalendarOccurrence({
    uid,
    object_ref: `object:${uid}`,
    kind,
    title,
    date,
    lifecycle: "scheduled",
    canonical_url: canonical,
    source: { system: "city_record", record_id: MUSEUM_REQUEST_ID },
    provenance: { basis: "publisher_record" },
  });
  // Three occurrences, because the shared month renderer paints nothing for a
  // month too sparse to be worth a grid. The one under test is first.
  const month = renderCompactMonth(buildCompactMonthView([
    occurrence("occ:pursuit", "2026-09-16", "Responses due", "deadline"),
    occurrence("occ:conference", "2026-09-03", "Pre-bid conference", "event"),
    occurrence("occ:questions", "2026-09-09", "Questions deadline", "deadline"),
  ], { today: "2026-09-01" }));
  const { doc, container } = mountDocument(`${month}${detailBlock || ""}`);
  // The shared mount the rendered-document boot uses, not the preview binder
  // alone: a page carrying the inlined block must still get the crowded-day
  // agenda that mount also installs.
  const loadDetail = calendarPreviewInlineDetailReader(doc);
  const controller = bindCompactMonthCalendar(container, loadDetail ? { loadDetail } : {});
  return { doc, container, controller, dialog: doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID) };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("A5: inspecting an event in place shows the project line, then dismissing returns the reader where they were", async () => {
  const html = renderCase(MUSEUM_REQUEST_ID);
  const block = html.match(/<script type="application\/json" data-project-context-inspect="1">[\s\S]*?<\/script>/)[0];
  const { doc, container, dialog } = mountPursuitCalendar(block);

  const anchor = container.querySelector('[data-calendar-event-preview-uid="occ:pursuit"]')
    .parentNode.querySelector("a.compact-month-occ-link");
  const before = anchor.getAttribute("href");
  const anchorsBefore = container.querySelectorAll("a.compact-month-occ-link").length;
  const button = container.querySelector('[data-calendar-event-preview-uid="occ:pursuit"]');
  click(button);
  assert.equal(dialog.open, true, "inspection opens in place");
  await tick();

  assert.match(dialog.textContent, /Wider project: BCM-HVAC Upgrades/);
  assert.match(dialog.textContent, /Project figures, not the advertised package/);
  // The full page is one explicit choice away, and it is the same destination
  // the cell already carried.
  const open = dialog.querySelector("[data-calendar-event-preview-open]");
  assert.equal(open.getAttribute("href"), before);

  click(dialog.querySelector("[data-calendar-event-preview-close]"));
  assert.equal(dialog.open, false, "dismissal closes the inspection");
  // Nothing about the reader's position changed: the same month, the same
  // occurrence, the same untouched destination.
  assert.equal(container.querySelectorAll("a.compact-month-occ-link").length, anchorsBefore,
    "the month the reader had is still the month they have");
  assert.equal(anchor.getAttribute("href"), before);
  assert.equal(doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID), dialog, "one dialog, reused");
});

test("A5: the canonical destination keeps working without scripting and under a modified click", () => {
  const { container } = mountPursuitCalendar(null);
  const anchor = container.querySelector("a.compact-month-occ-link");
  // The destination is a plain anchor: no handler, no role, no dialog wiring.
  assert.match(anchor.getAttribute("href"), /^https:\/\/cityscroll\.org\/procurements\//);
  assert.equal(anchor.hasAttribute("role"), false);
  assert.equal(anchor.hasAttribute("onclick"), false);
  assert.equal(anchor.hasAttribute("data-calendar-event-preview"), false);
  // A modified click is a browser navigation this code never sees, because the
  // inspect control is a separate button rather than an intercepted link.
  const button = container.querySelector('[data-calendar-event-preview-uid="occ:pursuit"]');
  assert.equal(button.tagName, "button");
  assert.notEqual(button.parentNode, anchor);
});

test("A5: a failed detail load leaves the published facts and the working link exactly as they were", async () => {
  const { dialog, container } = mountPursuitCalendar(
    `<script type="application/json" data-project-context-inspect="1">{ not json </script>`,
  );
  click(container.querySelector('[data-calendar-event-preview-uid="occ:pursuit"]'));
  await tick();
  assert.equal(dialog.open, true, "the inspection stays open");
  assert.match(dialog.textContent, /Responses due/, "the facts the cell was admitted with survive");
  assert.match(dialog.textContent, /did not load/, "and the reader is told, with a recovery");
  const open = dialog.querySelector("[data-calendar-event-preview-open]");
  assert.match(open.getAttribute("href"), /^https:\/\/cityscroll\.org\/procurements\//,
    "the full page remains one working link away");
  assert.doesNotMatch(dialog.textContent, /Wider project:/, "and no half-built context is shown");
});

test("A5: the rendered-document boot mounts the shared calendar, and hands it the inlined reader", () => {
  const boot = readFileSync(new URL("../site/calendar_event_preview_boot.mjs", import.meta.url), "utf8");
  // Mounting through the shared renderer is what keeps a document that carries
  // the inlined block from losing the crowded-day agenda that mount installs.
  assert.match(boot, /import \{ bindCompactMonthCalendar \} from "\.\/compact_calendar\.mjs";/);
  assert.match(boot, /bindCompactMonthCalendar\(document, loadDetail \? \{ loadDetail \} : \{\}\)/);
  assert.doesNotMatch(boot, /bindCalendarEventPreview\(|bindCalendarDayAgenda\(/,
    "neither half of the shared mount is reached for directly");
});

test("A5: a page that inlines nothing makes no request of any kind", () => {
  const { doc } = mountPursuitCalendar(null);
  assert.equal(calendarPreviewInlineDetailReader(doc), null, "no block, no detail hook, no request");
  assert.equal(CALENDAR_PREVIEW_DETAIL_SELECTOR.includes("data-project-context-inspect"), true);
  // A block that parses but carries no summary is a failure, not a blank line.
  const { doc: emptyDoc } = mountPursuitCalendar(
    `<script type="application/json" data-project-context-inspect="1">{"summary":"  "}</script>`,
  );
  assert.throws(() => calendarPreviewInlineDetailReader(emptyDoc)(), /no summary/);
});

test("A5: formatting helpers refuse to invent a value they were not given", () => {
  assert.equal(projectContextDay("2029-06-25T00:00:00.000"), "June 25, 2029");
  assert.equal(projectContextDay("2029-06"), null);
  assert.equal(projectContextDay(null), null);
  assert.equal(projectContextAmount("19905485.81"), "$19,905,486");
  assert.equal(projectContextAmount(""), null);
  assert.equal(projectContextAmount("not a number"), null);
});
