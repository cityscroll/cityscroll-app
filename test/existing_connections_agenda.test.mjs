/**
 * One hearing agenda, read as the land use projects it is actually about.
 *
 * The 27 May 2026 Subcommittee on Zoning and Franchises agenda is eleven
 * legislative identifiers. Most of them are the same few applications filed
 * several times over, and until now nothing on the page said so. These tests
 * cover the index that does: which agenda rows group under which project, which
 * rows stay ungrouped, and the two rendered surfaces that must agree about it.
 *
 * No population count is hard-coded here. The committed Council land-matter
 * bridge receipt is the machine evidence, and every expected grouping is
 * re-derived from it against the agenda's own retained record, so a later source
 * refresh that legitimately moves a matter reports its own new figures instead of
 * failing on a stale fixture. What is pinned is the reasoning: an exact shared
 * application number groups, a resembling title does not, an unjoined row is
 * still an agenda row, and a recorded committee step is never a project decision.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENDA_PROJECT_GROUPS_SCHEMA,
  AGENDA_PROJECT_GROUP_STATE_KEY,
  buildAgendaProjectGroups,
  readOpenAgendaProjectGroups,
  renderAgendaProjectGroups,
  writeOpenAgendaProjectGroups,
} from "../site/agenda_project_groups.mjs";
import { renderMeetingOutcomesFirstPaint } from "../site/meeting_outcomes_static.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const RECEIPT = read("warehouse/receipts/proof/council_land_bridge_latest.json");
const LOOKUP = read("site/data/council_land_matter_links.json");
const SNAPSHOT = read("site/data/meeting_outcomes_snapshot.json");

// The hearing this feature was specified against, named by the publisher's own
// identifiers: a City Record notice request id and the Council event it is
// joined to.
const NOTICE_ID = "20260512045";
const EVENT_ID = "22390";
const EVENT_DATE = "2026-05-27";

// The source-backed cases. Each is a publisher identity, so a failure says which
// record moved rather than which number changed.
const MONITOR_POINT = "2024K0358";
const QUAY_DEMAPPING = "2025K0287";
const DEWITT_CLINTON_ELEVENTH_AVENUE = "2024M0244";
const DEWITT_CLINTON_WEST_54TH = "2023M0213";
const RESEMBLING_TITLE_MATTER = "78875";

const RECORD = SNAPSHOT.by_notice?.[NOTICE_ID];

/**
 * The grouping the committed bridge receipt implies for this agenda, derived
 * independently of the module under test: walk the agenda in its own order and
 * ask the receipt which project, if any, each matter was joined to.
 */
function expectedGroupsFromReceipt(agendaMatters) {
  const projectByMatter = new Map();
  for (const edge of RECEIPT.materialized_edges) {
    projectByMatter.set(edge.council_depth.matter.matter_id, edge.project_id);
  }
  const order = [];
  const members = new Map();
  const unjoined = [];
  for (const matter of agendaMatters) {
    const projectId = projectByMatter.get(matter.matter_id);
    if (!projectId) {
      unjoined.push(matter.matter_id);
      continue;
    }
    if (!members.has(projectId)) {
      order.push(projectId);
      members.set(projectId, []);
    }
    members.get(projectId).push(matter.matter_id);
  }
  return { order, members, unjoined };
}

test("the retained agenda under test is the one the connection was specified against", () => {
  assert.ok(RECORD, `notice ${NOTICE_ID} is not in the committed meeting-outcome snapshot`);
  assert.equal(RECORD.snapshot_state, "present");
  assert.equal(RECORD.event.event_id, EVENT_ID);
  assert.equal(RECORD.event.date, EVENT_DATE);
  assert.ok(RECORD.matters.length > 0, "the retained agenda carries no matters");
});

test("every agenda matter is grouped exactly as the committed bridge receipt joined it", () => {
  const expected = expectedGroupsFromReceipt(RECORD.matters);
  const view = buildAgendaProjectGroups(RECORD.matters);
  assert.equal(view.schema, AGENDA_PROJECT_GROUPS_SCHEMA);
  assert.deepEqual(view.groups.map((group) => group.project_id), expected.order);
  for (const group of view.groups) {
    assert.deepEqual(
      group.matters.map((matter) => matter.matter_id),
      expected.members.get(group.project_id),
      `project ${group.project_id} does not carry the agenda matters the receipt joined to it`,
    );
  }
  assert.equal(view.unlinked_matter_count, expected.unjoined.length);
  assert.equal(
    view.linked_matter_count,
    [...expected.members.values()].reduce((total, ids) => total + ids.length, 0),
  );
  assert.equal(view.group_count, expected.order.length);
});

test("the agenda's own count is preserved: linked plus unlinked is every retained matter", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  const distinctAgendaMatters = new Set(RECORD.matters.map((matter) => matter.matter_id));
  assert.equal(view.agenda_matter_count, distinctAgendaMatters.size);
  assert.equal(view.linked_matter_count + view.unlinked_matter_count, view.agenda_matter_count);
});

test("each named case groups its own agenda matters under its own project", () => {
  const expected = expectedGroupsFromReceipt(RECORD.matters);
  const view = buildAgendaProjectGroups(RECORD.matters);
  const byProject = new Map(view.groups.map((group) => [group.project_id, group]));
  for (const projectId of [
    MONITOR_POINT,
    QUAY_DEMAPPING,
    DEWITT_CLINTON_ELEVENTH_AVENUE,
    DEWITT_CLINTON_WEST_54TH,
  ]) {
    const members = expected.members.get(projectId);
    assert.ok(members?.length, `the receipt no longer joins any agenda matter to ${projectId}`);
    const group = byProject.get(projectId);
    assert.ok(group, `${projectId} is missing from the rendered grouping`);
    assert.deepEqual(group.matters.map((matter) => matter.matter_id), members);
    assert.equal(group.project_href, `/browse/zoning/#land/${projectId}`);
    assert.equal(group.project_name, LOOKUP.projects[projectId].project_name);
  }
});

test("the grouping key is the shared application number, and it travels with every row", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  for (const group of view.groups) {
    for (const matter of group.matters) {
      assert.equal(matter.join_value, LOOKUP.matters[matter.matter_id].join_value);
      assert.equal(LOOKUP.matters[matter.matter_id].join_key, "ulurp_number");
      assert.equal(LOOKUP.matters[matter.matter_id].join_method, "exact_ulurp_token");
    }
    assert.deepEqual(group.join_values, group.matters.map((matter) => matter.join_value));
  }
});

test("negative control: a matter whose title names the same development but shares no application number stays ungrouped", () => {
  const onAgenda = RECORD.matters.find((matter) => matter.matter_id === RESEMBLING_TITLE_MATTER);
  assert.ok(onAgenda, `matter ${RESEMBLING_TITLE_MATTER} is no longer on this agenda`);
  assert.match(onAgenda.title, /Monitor Point/);
  assert.equal(LOOKUP.matters[RESEMBLING_TITLE_MATTER], undefined);

  const view = buildAgendaProjectGroups(RECORD.matters);
  const grouped = view.groups.flatMap((group) => group.matters.map((matter) => matter.matter_id));
  assert.ok(!grouped.includes(RESEMBLING_TITLE_MATTER));
  assert.ok(view.unlinked_matter_count >= 1);

  // It is still an agenda item, and the rendered agenda still lists it.
  const html = renderMeetingOutcomesFirstPaint(SNAPSHOT, NOTICE_ID);
  assert.ok(html.includes(`data-matter-id="${RESEMBLING_TITLE_MATTER}"`));
});

test("negative control: two applications whose titles differ only by street address stay two projects", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  const first = view.groups.find((group) => group.project_id === DEWITT_CLINTON_ELEVENTH_AVENUE);
  const second = view.groups.find((group) => group.project_id === DEWITT_CLINTON_WEST_54TH);
  assert.ok(first && second);
  assert.notEqual(first.project_id, second.project_id);
  assert.notEqual(first.project_href, second.project_href);
  // The titles genuinely resemble each other, which is the point of the control.
  const shared = "Dewitt Clinton Park North";
  assert.ok(first.project_name.startsWith(shared) && second.project_name.startsWith(shared));
  const overlap = first.matters
    .map((matter) => matter.matter_id)
    .filter((id) => second.matters.some((matter) => matter.matter_id === id));
  assert.deepEqual(overlap, []);
});

test("nothing here becomes a project decision, and the bridge's negative rule travels with the view", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  assert.equal(view.is_decision, false);
  for (const group of view.groups) {
    assert.equal(group.is_decision, false);
    assert.equal(group.canonical_relation, "about_project");
    assert.equal(group.proceeding_relation, "reviews_project");
    assert.equal(group.negative_rule, LOOKUP.relation.negative_rule);
  }
  const html = renderAgendaProjectGroups(view);
  assert.ok(html.includes('data-agenda-project-decision="false"'));
  assert.ok(!/\bapproved\b|\bdenied\b|\bdecision on\b/i.test(html.replace(/not a decision on the project/gi, "")));
});

test("shared agenda presence is never described as a shared position", () => {
  const html = renderAgendaProjectGroups(buildAgendaProjectGroups(RECORD.matters));
  assert.match(html, /not a shared position/);
  assert.match(html, /step in the review, not a decision on the project/);
  assert.match(html, /never by a likeness between their titles/);
});

test("no named participant reaches the agenda index", () => {
  const html = renderAgendaProjectGroups(buildAgendaProjectGroups(RECORD.matters));
  assert.ok(!html.includes("data-official-id"));
  assert.ok(!html.includes("meeting-roll-call"));
  assert.ok(!/\/officials\//.test(html));
});

test("every connection is a native link the browser owns, and inspection never navigates", () => {
  const html = renderAgendaProjectGroups(buildAgendaProjectGroups(RECORD.matters));
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.match(link, /href="/, `a connection was rendered without an href: ${link}`);
    assert.ok(!link.includes("target="), `a connection opens a new tab: ${link}`);
    assert.ok(!link.includes("onclick"), `a connection carries a script handler: ${link}`);
  }
  // Expansion is a native details element: no button, no form, no subscription.
  assert.match(html, /<details class="meeting-more agenda-project-matters"><summary>/);
  assert.ok(!html.includes("<button"));
  assert.ok(!html.includes("<form"));
  assert.ok(!html.includes("matter-follow-link"));
});

test("a matter is only offered a local route the published generation actually carries", () => {
  const published = read("site/data/legislative_matter_index.json").matters;
  const view = buildAgendaProjectGroups(RECORD.matters);
  for (const group of view.groups) {
    for (const matter of group.matters) {
      if (matter.availability === "local_history") {
        assert.ok(published[matter.matter_id], `${matter.matter_id} is advertised locally but unpublished`);
        assert.equal(matter.href, `/matters/${matter.matter_id}/`);
        assert.equal(matter.external, false);
      } else {
        assert.notEqual(matter.href, `/matters/${matter.matter_id}/`);
      }
    }
  }
});

test("an unpublished matter is still grouped, and named without a local route", () => {
  const view = buildAgendaProjectGroups(RECORD.matters, { published: new Set() });
  const matters = view.groups.flatMap((group) => group.matters);
  assert.ok(matters.length > 0);
  for (const matter of matters) {
    assert.notEqual(matter.availability, "local_history");
    assert.ok(matter.label.length > 0);
  }
  const html = renderAgendaProjectGroups(view);
  assert.ok(!html.includes('href="/matters/'));
  for (const matter of matters) {
    assert.ok(html.includes(`data-agenda-project-matter="${matter.matter_id}"`));
  }
});

test("the served notice keeps every original agenda item, in the order the source record gives it", () => {
  const html = renderMeetingOutcomesFirstPaint(SNAPSHOT, NOTICE_ID);
  const agendaStart = html.indexOf('<ol class="meeting-agenda">');
  assert.ok(agendaStart > 0, "the original agenda list is missing from the served notice");
  const agenda = html.slice(agendaStart);
  const rendered = [...agenda.matchAll(/<li class="meeting-matter" data-outcome-bucket="[^"]*" data-matter-id="(\d+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(rendered, RECORD.matters.map((matter) => matter.matter_id));
});

test("the index sits above the agenda it indexes and replaces nothing", () => {
  const html = renderMeetingOutcomesFirstPaint(SNAPSHOT, NOTICE_ID);
  const index = html.indexOf('data-agenda-project-groups="1"');
  const agenda = html.indexOf('<ol class="meeting-agenda">');
  assert.ok(index > 0 && agenda > index);
  assert.match(html, /data-agenda-project-group-count="\d+"/);
});

test("the served notice reports the same figures the view derived", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  const html = renderMeetingOutcomesFirstPaint(SNAPSHOT, NOTICE_ID);
  assert.ok(html.includes(`data-agenda-project-group-count="${view.group_count}"`));
  assert.ok(html.includes(`data-agenda-linked-matters="${view.linked_matter_count}"`));
  assert.ok(html.includes(`data-agenda-matters="${view.agenda_matter_count}"`));
  assert.ok(html.includes(`data-agenda-unlinked-matters="${view.unlinked_matter_count}"`));
});

test("an agenda with no accepted project join renders no group furniture at all", () => {
  const unjoined = RECORD.matters.filter((matter) => !LOOKUP.matters[matter.matter_id]);
  assert.ok(unjoined.length > 0, "this agenda has no unjoined matter to build the empty case from");
  assert.equal(buildAgendaProjectGroups(unjoined), null);
  assert.equal(renderAgendaProjectGroups(null), "");
  assert.equal(renderAgendaProjectGroups(buildAgendaProjectGroups([])), "");
});

test("a missing connection lookup leaves the agenda exactly as it was", () => {
  const empty = { schema: LOOKUP.schema, matters: {}, projects: {}, relation: LOOKUP.relation };
  assert.equal(buildAgendaProjectGroups(RECORD.matters, { lookup: empty }), null);

  const view = buildAgendaProjectGroups(RECORD.matters);
  assert.ok(view, "the committed lookup should still group this agenda");
});

test("an unjoined matter is reported as a state, never as a zero", () => {
  const joined = RECORD.matters.filter((matter) => LOOKUP.matters[matter.matter_id]);
  const complete = buildAgendaProjectGroups(joined);
  assert.equal(complete.unlinked_matter_count, 0);
  const html = renderAgendaProjectGroups(complete);
  assert.ok(!html.includes("agenda-project-unlinked"));
  assert.ok(!/\b0 matters\b/.test(html));

  const withGap = renderAgendaProjectGroups(buildAgendaProjectGroups(RECORD.matters));
  assert.match(withGap, /class="note agenda-project-unlinked"/);
});

test("procedural agenda rows are neither counted as matters nor invented into a group", () => {
  const withProcedural = [{ title: "Roll call" }, ...RECORD.matters, { matter_id: "" }];
  const view = buildAgendaProjectGroups(withProcedural);
  const baseline = buildAgendaProjectGroups(RECORD.matters);
  assert.equal(view.agenda_matter_count, baseline.agenda_matter_count);
  assert.equal(view.unlinked_matter_count, baseline.unlinked_matter_count);
  assert.deepEqual(
    view.groups.map((group) => group.matters.map((matter) => matter.matter_id)),
    baseline.groups.map((group) => group.matters.map((matter) => matter.matter_id)),
  );
});

test("a matter recorded twice on one agenda is counted once", () => {
  const doubled = [...RECORD.matters, RECORD.matters[0]];
  const view = buildAgendaProjectGroups(doubled);
  const baseline = buildAgendaProjectGroups(RECORD.matters);
  assert.equal(view.agenda_matter_count, baseline.agenda_matter_count);
  assert.equal(view.linked_matter_count, baseline.linked_matter_count);
  assert.deepEqual(
    view.groups.map((group) => group.matters.map((matter) => matter.matter_id)),
    baseline.groups.map((group) => group.matters.map((matter) => matter.matter_id)),
  );
});

test("both agenda surfaces read one builder, so they cannot assign a matter to two projects", () => {
  // The client surface collapses the worker's agenda items into the same row
  // shape the compact snapshot carries; the assignment must not depend on which
  // of the two produced it.
  const clientShaped = RECORD.matters.map((matter) => ({
    matter_id: matter.matter_id,
    matter_file: matter.matter_file,
    title: matter.title,
    matter_url: matter.matter_url,
    actions: matter.actions,
  }));
  const fromStatic = buildAgendaProjectGroups(RECORD.matters);
  const fromClient = buildAgendaProjectGroups(clientShaped);
  assert.deepEqual(
    fromClient.groups.map((group) => [group.project_id, group.matters.map((matter) => matter.matter_id)]),
    fromStatic.groups.map((group) => [group.project_id, group.matters.map((matter) => matter.matter_id)]),
  );
  assert.equal(fromClient.linked_matter_count, fromStatic.linked_matter_count);
  assert.equal(fromClient.unlinked_matter_count, fromStatic.unlinked_matter_count);
});

test("a surface's own labels are used without changing which project a matter belongs to", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  const translated = renderAgendaProjectGroups(view, {
    labels: {
      heading: "Proyectos de uso del suelo en este orden del día",
      matters: (count) => `${count} asuntos`,
      expand: "Asuntos presentados bajo este proyecto",
    },
  });
  assert.match(translated, /Proyectos de uso del suelo/);
  assert.match(translated, /Asuntos presentados bajo este proyecto/);
  for (const group of view.groups) {
    assert.ok(translated.includes(`data-agenda-project-id="${group.project_id}"`));
    for (const matter of group.matters) {
      // The publisher's own file number and title are never translated.
      assert.ok(translated.includes(`data-agenda-project-matter="${matter.matter_id}"`));
      assert.ok(translated.includes(matter.matter_file));
    }
  }
});

test("the published English copy and the shipping dictionary say the same thing", () => {
  const dictionary = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  for (const key of [
    "agenda_project_groups_heading",
    "agenda_project_groups_lead_one",
    "agenda_project_groups_lead_other",
    "agenda_project_groups_matters_one",
    "agenda_project_groups_matters_other",
    "agenda_project_groups_applications",
    "agenda_project_groups_expand",
    "agenda_project_groups_unlinked_one",
    "agenda_project_groups_unlinked_other",
    "agenda_project_groups_limit",
  ]) {
    assert.ok(dictionary.includes(`${key}:`), `${key} is missing from the en dictionary`);
  }
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    snapshot: () => Object.fromEntries(values),
  };
}

test("the reader's expanded groups survive a link out and back, per agenda", () => {
  const storage = memoryStorage();
  assert.deepEqual(readOpenAgendaProjectGroups(NOTICE_ID, storage), []);
  writeOpenAgendaProjectGroups(NOTICE_ID, [MONITOR_POINT, DEWITT_CLINTON_WEST_54TH], storage);
  assert.deepEqual(
    readOpenAgendaProjectGroups(NOTICE_ID, storage),
    [MONITOR_POINT, DEWITT_CLINTON_WEST_54TH],
  );
  // One agenda's reading position says nothing about another's.
  assert.deepEqual(readOpenAgendaProjectGroups("20260428021", storage), []);
  writeOpenAgendaProjectGroups(NOTICE_ID, [], storage);
  assert.deepEqual(readOpenAgendaProjectGroups(NOTICE_ID, storage), []);
});

test("the remembered reading position is bounded, and unusable storage is simply a closed agenda", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 30; index += 1) {
    writeOpenAgendaProjectGroups(`2026051204${index}`, [MONITOR_POINT], storage);
  }
  const stored = JSON.parse(storage.snapshot()[AGENDA_PROJECT_GROUP_STATE_KEY]);
  assert.ok(Object.keys(stored).length <= 12);
  assert.deepEqual(stored["202605120429"], [MONITOR_POINT]);

  const hostile = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  };
  assert.deepEqual(readOpenAgendaProjectGroups(NOTICE_ID, hostile), []);
  assert.doesNotThrow(() => writeOpenAgendaProjectGroups(NOTICE_ID, [MONITOR_POINT], hostile));
  assert.deepEqual(readOpenAgendaProjectGroups(NOTICE_ID, memoryStorage({
    [AGENDA_PROJECT_GROUP_STATE_KEY]: "not json",
  })), []);
});

test("the view carries the materialization it was derived from", () => {
  const view = buildAgendaProjectGroups(RECORD.matters);
  assert.equal(view.generated_at, LOOKUP.generated_at);
});
