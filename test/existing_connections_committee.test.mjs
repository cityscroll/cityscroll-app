/**
 * Committees linked to a committee through the members they share.
 *
 * This reads the same committed committee graph as the co-service projection on
 * an official's profile, from the other end. Every number below is reproducible
 * from the repository, and where a case names a body it also names the people
 * and the source dates, because the point of the projection is that two
 * memberships only connect two committees when their dates meet.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMITTEE_SHARED_MEMBERSHIP_ANCHOR,
  COMMITTEE_SHARED_MEMBERSHIP_SCHEMA,
  COMMITTEE_SHARED_MEMBERSHIP_STRINGS,
  COMMITTEE_SHARED_VISIBLE_COMMITTEES,
  buildCommitteeCoServiceView,
  buildCommitteeSharedMembershipView,
  isCouncilCaucusBody,
  renderCommitteeSharedMembershipHTML,
} from "../site/committee_coservice.mjs";
import { buildCommitteeDocumentView, renderCommitteeDocument } from "../site/committee_document.mjs";

const graph = JSON.parse(readFileSync(new URL("../site/data/committee_graph_lookup.json", import.meta.url)));
const people = JSON.parse(readFileSync(new URL("../site/data/person_hub_lookup.json", import.meta.url)));
const documentStyles = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");
const captureManifest = JSON.parse(readFileSync(
  new URL("../docs/evidence/committee-shared-membership/capture-manifest.json", import.meta.url),
));

// The committee snapshot's own vintage day. A membership snapshot can only
// answer for a day it observed, so every corpus case below states it.
const SNAPSHOT_DAY = String(graph.generated_at).slice(0, 10);

const LANDMARKS_SUBCOMMITTEE = "5309";
const PARKS_COMMITTEE = "5106";
const FINANCE_COMMITTEE = "11";
const PUBLIC_SAFETY_COMMITTEE = "19";
const GENERAL_WELFARE_COMMITTEE = "12";
const CONSUMER_WORKER_COMMITTEE = "5269";
const AGING_COMMITTEE = "3";
const OVERSIGHT_COMMITTEE = "5107";
const TRANSPORTATION_COMMITTEE = "29";
const PROGRESSIVE_CAUCUS = "5285";
const MARTE = "7801";
const NURSE = "7824";
const BREWER = "5259";

// The shipped dictionary, so the assertions below read the copy a resident
// actually meets rather than a stand-in written for the test.
globalThis.window = globalThis.window || {};
createRequire(import.meta.url)("../site/i18n.js");
const STRINGS = globalThis.window.STRINGS;
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const escape = (value) => String(value ?? "").replace(/[<>&'"]/g, (character) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;",
}[character]));
const fill = (text, vars) => Object.entries(vars || {}).reduce(
  (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
  String(text),
);
const translateIn = (lang) => (key, vars) => {
  const value = STRINGS[lang]?.[key] ?? STRINGS.en[key];
  assert.ok(value !== undefined, `missing dictionary key ${key} for ${lang}`);
  return fill(value, vars);
};
const translateCountIn = (lang) => (base, count, vars) => {
  const dictionary = STRINGS[lang] || {};
  const key = `${base}_${count === 1 ? "one" : "other"}`;
  const value = dictionary[key] ?? dictionary[`${base}_other`] ?? STRINGS.en[key];
  assert.ok(value !== undefined, `missing plural key ${key} for ${lang}`);
  return fill(value, { n: String(count), ...(vars || {}) });
};

const viewFor = (id, asOf = SNAPSHOT_DAY, options = {}) =>
  buildCommitteeSharedMembershipView(graph, id, { asOf, people, ...options });

const rowFor = (view, committeeId) => view.committees.find((row) => row.committee_id === committeeId);
const namesOn = (view, committeeId) => (rowFor(view, committeeId)?.shared_members || [])
  .map((member) => member.name).sort();

const renderEnglish = (view) => renderCommitteeSharedMembershipHTML(view, { escapeHtml: escape });

/**
 * The same answer computed a second, deliberately naive way, straight off the
 * graph. The projection is checked against this rather than against counts
 * typed here: the committee snapshot is refreshed from the publisher, so a
 * literal population count in a gate becomes an outage the day the source moves.
 */
function expectedConnections(committeeId, asOf = SNAPSHOT_DAY) {
  const covers = (edge) => edge.type === "member_of" && edge.valid_from <= asOf && edge.valid_to >= asOf;
  const bodyName = (ref) => graph.nodes.find((node) => node.id === ref && node.type === "committee")?.name || "";
  const isCaucus = (ref) => /caucus/i.test(bodyName(ref));
  const named = (officialId) => people.by_person_id?.[officialId]?.person_name || null;
  const subjectRef = `committee:${committeeId}`;
  const members = new Set(graph.public_edges.filter((edge) => covers(edge) && edge.to === subjectRef)
    .map((edge) => edge.from));
  const byCommittee = new Map();
  for (const edge of graph.public_edges) {
    if (!covers(edge) || edge.to === subjectRef || !members.has(edge.from)) continue;
    if (isCaucus(edge.to)) continue;
    if (!byCommittee.has(edge.to)) byCommittee.set(edge.to, new Set());
    byCommittee.get(edge.to).add(edge.from.replace("official:", ""));
  }
  const rows = new Map();
  for (const [ref, officials] of byCommittee) {
    const names = [...officials].map(named).filter(Boolean).sort();
    if (names.length) rows.set(ref.replace("committee:", ""), names);
  }
  return {
    rows,
    member_count: [...members].filter((ref) => named(ref.replace("official:", ""))).length,
  };
}

// Every dictionary key this section can select, including the plural categories
// only Polish and Russian define.
const DICTIONARY_KEYS = [...new Set([
  ...Object.keys(COMMITTEE_SHARED_MEMBERSHIP_STRINGS),
  ...["summary", "members", "expand", "more"].flatMap((base) =>
    ["one", "few", "many", "other"].map((category) => `committee_shared_${base}_${category}`)),
])];

test("the snapshot day is the one the committed graph was generated for", () => {
  assert.match(SNAPSHOT_DAY, /^\d{4}-\d{2}-\d{2}$/);
  // Checked against the day the section's own capture recorded, not a literal
  // typed here. A source refresh moves the graph and the capture together
  // through the capture's builder, so the two cannot drift apart quietly, and
  // no hand-edited date stands between them.
  const captured = new Set(captureManifest.captures.map((entry) => entry.data_vintage.committee_graph_as_of));
  assert.equal(captured.size, 1, "every capture reads one committee snapshot day");
  assert.equal(SNAPSHOT_DAY, [...captured][0]);
  for (const entry of captureManifest.captures) {
    assert.equal(entry.data_vintage.committee_graph_generated_at, graph.generated_at);
  }
});

test("a committee names the other committees its own members also sit on", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  assert.equal(view.schema, COMMITTEE_SHARED_MEMBERSHIP_SCHEMA);
  assert.equal(view.state, "matched");
  assert.equal(view.as_of, SNAPSHOT_DAY);
  assert.equal(view.subject.name, "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions");
  assert.equal(view.subject.href, `/committees/${LANDMARKS_SUBCOMMITTEE}/`);

  // The whole answer for this committee at this vintage, checked against the
  // graph rather than against a count typed here.
  const expected = expectedConnections(LANDMARKS_SUBCOMMITTEE);
  assert.equal(view.committee_count, expected.rows.size);
  assert.equal(view.subject_member_count, expected.member_count);
  assert.equal(view.unnamed_member_count, 0);
  for (const [committeeId, names] of expected.rows) {
    assert.deepEqual(namesOn(view, committeeId), names, `committee ${committeeId}`);
  }
  assert.equal(
    view.represented_official_count,
    new Set(graph.public_edges
      .filter((edge) => edge.type === "member_of"
        && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY)
      .filter((edge) => !isCouncilCaucusBody(
        graph.nodes.find((node) => node.id === edge.to)?.name))
      .map((edge) => edge.from)).size,
  );

  // The named cases this section was built for. The committee snapshot is a
  // rolling publisher window, so each is asserted while the record is in it and
  // reported as a signal when it leaves, rather than failing a deploy.
  const NAMED = [
    [FINANCE_COMMITTEE, "Committee on Finance", ["Alexa Avilés", "Christopher Marte", "Oswald J. Feliz"]],
    [PUBLIC_SAFETY_COMMITTEE, "Committee on Public Safety", ["Kamillah Hanks", "Oswald J. Feliz", "Sandy Nurse"]],
    [PARKS_COMMITTEE, "Committee on Parks and Recreation", ["Christopher Marte", "Sandy Nurse"]],
    [GENERAL_WELFARE_COMMITTEE, "Committee on General Welfare", ["Alexa Avilés", "Sandy Nurse"]],
    [CONSUMER_WORKER_COMMITTEE, "Committee on Consumer and Worker Protection", ["Chi A. Ossé", "Kamillah Hanks"]],
  ];
  let present = 0;
  for (const [committeeId, name, names] of NAMED) {
    if (!expected.rows.has(committeeId)) {
      console.log(`signal: committee ${committeeId} (${name}) is no longer connected on ${SNAPSHOT_DAY}`);
      continue;
    }
    present += 1;
    assert.equal(rowFor(view, committeeId).name, name);
    assert.deepEqual(namesOn(view, committeeId), names);
  }
  assert.ok(present > 0, "no named connection survives in the current window");

  // The most-shared bodies lead, and the rest sort by the publisher's own name.
  const leaders = [...expected.rows.entries()]
    .filter(([, names]) => names.length === Math.max(...[...expected.rows.values()].map((n) => n.length)))
    .map(([committeeId]) => committeeId).sort();
  assert.deepEqual(view.committees.slice(0, leaders.length).map((row) => row.committee_id).sort(), leaders);
  assert.ok(view.committees.every((row, index, rows) =>
    index === 0 || rows[index - 1].shared_member_count >= row.shared_member_count));
});

test("every count is distinct people whose two memberships cover the same days", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  const subject = view.committees.length;
  assert.ok(subject > 0);
  for (const row of view.committees) {
    const ids = row.shared_members.map((member) => member.official_id);
    assert.equal(row.shared_member_count, row.shared_members.length);
    assert.equal(new Set(ids).size, ids.length, `${row.name} counts a person once`);
    for (const member of row.shared_members) {
      assert.ok(member.overlap_start <= SNAPSHOT_DAY && member.overlap_end >= SNAPSHOT_DAY);
      assert.ok(member.overlap_start <= member.overlap_end);
      assert.equal(member.href, `/officials/${member.official_id}/`);
      assert.ok(member.subject_role && member.linked_role);
    }
    assert.equal(row.href, `/committees/${row.committee_id}/`);
    assert.notEqual(row.committee_id, LANDMARKS_SUBCOMMITTEE, "a committee is never linked to itself");
  }

  // The roles are the ones the existing memberships list already uses for the
  // same edges, and the publisher's own title is retained beside them.
  const parks = rowFor(view, PARKS_COMMITTEE);
  const marte = parks.shared_members.find((member) => member.official_id === MARTE);
  assert.equal(marte.subject_role, "Chair");
  assert.equal(marte.subject_role_source_title, "CHAIRPERSON");
  assert.equal(marte.linked_role, "Committee Member");
  assert.equal(marte.overlap_start, "2026-01-15");
  assert.equal(marte.overlap_end, "2029-12-31");
});

test("the linked committee reports the same connection back, with the roles swapped", () => {
  const parks = viewFor(PARKS_COMMITTEE);
  assert.deepEqual(namesOn(parks, LANDMARKS_SUBCOMMITTEE), ["Christopher Marte", "Sandy Nurse"]);
  const back = rowFor(parks, LANDMARKS_SUBCOMMITTEE);
  assert.equal(back.name, "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions");
  assert.equal(back.shared_member_count, 2);
  const marteBack = back.shared_members.find((member) => member.official_id === MARTE);
  assert.equal(marteBack.subject_role, "Committee Member");
  assert.equal(marteBack.linked_role, "Chair");

  const forward = rowFor(viewFor(LANDMARKS_SUBCOMMITTEE), PARKS_COMMITTEE);
  assert.equal(forward.shared_member_count, back.shared_member_count);
  assert.deepEqual(
    forward.shared_members.map((member) => [member.official_id, member.overlap_start, member.overlap_end]),
    back.shared_members.map((member) => [member.official_id, member.overlap_start, member.overlap_end]),
  );

  // One implementation serves both directions, so the member profile cannot
  // report a pair of bodies the committee record disagrees about.
  const colleague = buildCommitteeCoServiceView(graph, MARTE, { asOf: SNAPSHOT_DAY, people })
    .colleagues.find((entry) => entry.official_id === NURSE);
  assert.deepEqual(
    colleague.shared_committees.map((row) => row.committee_id).sort(),
    [LANDMARKS_SUBCOMMITTEE, PARKS_COMMITTEE].sort(),
  );
  for (const committeeId of [LANDMARKS_SUBCOMMITTEE, PARKS_COMMITTEE]) {
    const other = committeeId === LANDMARKS_SUBCOMMITTEE ? PARKS_COMMITTEE : LANDMARKS_SUBCOMMITTEE;
    const shared = rowFor(viewFor(committeeId), other).shared_members.map((member) => member.official_id);
    assert.ok(shared.includes(MARTE) && shared.includes(NURSE));
  }
});

test("a repeated publisher row is one shared member, not two", () => {
  const pick = (from, to) => graph.public_edges.find((edge) =>
    edge.from === from && edge.to === to && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY);
  const duplicated = {
    ...graph,
    public_edges: [
      ...graph.public_edges,
      { ...pick(`official:${MARTE}`, `committee:${LANDMARKS_SUBCOMMITTEE}`), source_row_hash: "repeat-a" },
      { ...pick(`official:${MARTE}`, `committee:${PARKS_COMMITTEE}`), source_row_hash: "repeat-b" },
      { ...pick(`official:${NURSE}`, `committee:${PARKS_COMMITTEE}`), source_row_hash: "repeat-c" },
    ],
  };
  const view = buildCommitteeSharedMembershipView(duplicated, LANDMARKS_SUBCOMMITTEE, {
    asOf: SNAPSHOT_DAY,
    people,
  });
  assert.equal(rowFor(view, PARKS_COMMITTEE).shared_member_count, 2);
  assert.deepEqual(namesOn(view, PARKS_COMMITTEE), ["Christopher Marte", "Sandy Nurse"]);
  assert.equal(view.committee_count, 22);
  assert.equal(view.subject_member_count, 6);
});

test("two terms that never meet do not connect two committees", () => {
  // One member, two other bodies whose recorded terms sit either side of a
  // single day: Oversight and Investigations ends 2009-03-24, Transportation
  // begins 2009-03-25, and both are reached from the Committee on Aging.
  const oversight = graph.public_edges.find((edge) =>
    edge.from === `official:${BREWER}` && edge.to === `committee:${OVERSIGHT_COMMITTEE}`
    && edge.valid_from === "2006-01-18");
  const transportation = graph.public_edges.find((edge) =>
    edge.from === `official:${BREWER}` && edge.to === `committee:${TRANSPORTATION_COMMITTEE}`
    && edge.valid_from === "2009-03-25");
  assert.equal(oversight.valid_to, "2009-03-24");
  assert.equal(transportation.valid_to, "2009-12-31");

  const before = viewFor(AGING_COMMITTEE, "2009-03-01", { limit: 100 });
  assert.ok(rowFor(before, OVERSIGHT_COMMITTEE), "the term that covers the day is reported");
  assert.equal(rowFor(before, TRANSPORTATION_COMMITTEE), undefined);

  const after = viewFor(AGING_COMMITTEE, "2009-04-01", { limit: 100 });
  assert.equal(rowFor(after, OVERSIGHT_COMMITTEE), undefined);
  assert.ok(rowFor(after, TRANSPORTATION_COMMITTEE), "the later term is reported on a later day");
  assert.equal(rowFor(after, TRANSPORTATION_COMMITTEE).shared_members[0].overlap_start, "2009-03-25");

  // The 2026 roster reaches neither of them, so an old term never leaks into
  // the day a resident is actually reading about.
  const now = viewFor(AGING_COMMITTEE, SNAPSHOT_DAY, { limit: 100 });
  assert.equal(rowFor(now, OVERSIGHT_COMMITTEE), undefined);
  assert.equal(rowFor(now, TRANSPORTATION_COMMITTEE), undefined);
});

test("caucuses never become a committee connection from either end", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE, SNAPSHOT_DAY, { limit: 100 });
  assert.ok(view.committees.every((row) => !isCouncilCaucusBody(row.name)));
  // The caucuses these members share are real and counted, and none of them is
  // rendered as a committee link. The count is taken from the graph, not typed.
  const caucusIds = new Set(graph.nodes.filter((node) => isCouncilCaucusBody(node.name)).map((node) => node.id));
  const subjectMembers = new Set(graph.public_edges
    .filter((edge) => edge.type === "member_of" && edge.to === `committee:${LANDMARKS_SUBCOMMITTEE}`
      && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY)
    .map((edge) => edge.from));
  const sharedCaucuses = new Set(graph.public_edges
    .filter((edge) => edge.type === "member_of" && caucusIds.has(edge.to)
      && subjectMembers.has(edge.from)
      && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY)
    .map((edge) => edge.to));
  assert.ok(sharedCaucuses.size > 0, "the control needs at least one shared caucus to hold out");
  assert.equal(view.excluded_caucus_body_count, sharedCaucuses.size);
  assert.ok(caucusIds.size > 0);
  assert.ok(view.committees.every((row) => !caucusIds.has(row.committee_ref)));

  // A caucus page does not borrow its own roster's committees either.
  const caucus = viewFor(PROGRESSIVE_CAUCUS);
  assert.equal(caucus.state, "empty");
  assert.equal(caucus.subject_is_caucus, true);
  assert.equal(caucus.committee_count, 0);
  assert.equal(renderEnglish(caucus), "");
});

test("the as-of day is an argument, never an ambient clock", () => {
  assert.equal(buildCommitteeSharedMembershipView(graph, LANDMARKS_SUBCOMMITTEE, { people }).state, "unknown");
  assert.equal(
    buildCommitteeSharedMembershipView(graph, LANDMARKS_SUBCOMMITTEE, { asOf: "not-a-day", people }).state,
    "unknown",
  );
  // A real day this committee had no recorded roster is an empty answer, not an
  // unknown one, and neither state renders anything.
  assert.equal(viewFor(LANDMARKS_SUBCOMMITTEE, "1999-01-01").state, "empty");
  assert.equal(renderEnglish(viewFor(LANDMARKS_SUBCOMMITTEE, "1999-01-01")), "");
  assert.notEqual(viewFor(AGING_COMMITTEE, "2009-03-01").committee_count, viewFor(AGING_COMMITTEE).committee_count);
});

test("an unpublished, unrostered or unconnected committee renders no furniture", () => {
  const held = buildCommitteeSharedMembershipView({ ...graph, publication: "held" }, LANDMARKS_SUBCOMMITTEE, {
    asOf: SNAPSHOT_DAY,
    people,
  });
  assert.equal(held.state, "unknown");
  assert.equal(renderEnglish(held), "");
  assert.equal(renderCommitteeSharedMembershipHTML(null, { escapeHtml: escape }), "");

  // A committee whose members hold no other membership that day is a real
  // answer with nothing to show, and it shows nothing.
  const isolated = buildCommitteeSharedMembershipView({
    ...graph,
    public_edges: graph.public_edges.filter((edge) =>
      edge.to === `committee:${LANDMARKS_SUBCOMMITTEE}` || edge.from === `official:${BREWER}`),
  }, LANDMARKS_SUBCOMMITTEE, { asOf: SNAPSHOT_DAY, people });
  assert.equal(isolated.state, "empty");
  assert.equal(isolated.committee_count, 0);
  assert.equal(renderEnglish(isolated), "");

  // A committee with no roster at all on the day never claims zero connections.
  const unrostered = buildCommitteeSharedMembershipView({
    ...graph,
    public_edges: graph.public_edges.filter((edge) => edge.to !== `committee:${LANDMARKS_SUBCOMMITTEE}`),
  }, LANDMARKS_SUBCOMMITTEE, { asOf: SNAPSHOT_DAY, people });
  assert.equal(unrostered.state, "empty");
  assert.equal(unrostered.subject_member_count, 0);
  assert.equal(renderEnglish(unrostered), "");
});

test("a member the publisher records without a published name is counted, never printed", () => {
  const view = buildCommitteeSharedMembershipView(graph, LANDMARKS_SUBCOMMITTEE, {
    asOf: SNAPSHOT_DAY,
    people: { by_person_id: { [MARTE]: people.by_person_id[MARTE] } },
  });
  // Every other member of this committee is unnamed in the trimmed lookup.
  assert.equal(view.unnamed_member_count, expectedConnections(LANDMARKS_SUBCOMMITTEE).member_count - 1);
  assert.equal(view.subject_member_count, 1);
  const html = renderEnglish(view);
  assert.ok(html);
  assert.ok(!/>\s*78\d\d\s*</.test(html), "no bare publisher id reaches the reader");
  assert.equal(viewFor(LANDMARKS_SUBCOMMITTEE).unnamed_member_count, 0);
});

test("the rendered section links people and committees through published routes only", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  const html = renderEnglish(view);

  assert.match(html, /data-committee-shared-membership="1"/);
  assert.match(html, new RegExp(`data-shared-as-of="${SNAPSHOT_DAY}"`));
  assert.match(html, /data-shared-committee-count="22"/);
  assert.match(html, /data-shared-subject-members="6"/);
  assert.match(html, /data-shared-represented-officials="24"/);
  assert.match(html, /data-shared-excluded-caucus-bodies="6"/);

  // Native anchors only: a modified click and the browser's own history keep
  // working, and nothing here submits, scripts or subscribes.
  assert.ok(!/<button/.test(html));
  assert.ok(!/onclick=/.test(html));
  assert.ok(!/<script/.test(html));
  assert.ok(!/target="_blank"/.test(html));
  assert.match(html, new RegExp(`<a[^>]+href="/committees/${FINANCE_COMMITTEE}/"`));
  assert.match(html, new RegExp(`<a[^>]+href="/officials/${MARTE}/"`));
  for (const href of html.match(/href="[^"]+"/g) || []) {
    assert.match(href, /^href="(?:\/(?:officials|committees)\/\d+\/|#committee-shared-membership(?:-(?:\d+|more))?)"$/);
  }

  assert.match(html, /Committee on Finance/);
  assert.match(html, /Christopher Marte/);
  assert.match(html, /3 shared members/);
  assert.match(html, /On both 2026-01-15 to 2029-12-31/);
  assert.match(html, /Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions: Chair/);

  // A shared roster is a roster fact and the copy stays one.
  for (const claim of ["attend", "vote", "voting", "align", "ally", "coordinat", "influence", "agree", "power"]) {
    assert.ok(!html.toLowerCase().includes(claim), `shared-membership copy must not claim ${claim}`);
  }
});

test("an expansion lives in the URL, so it survives the walk out and back", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  const html = renderEnglish(view);

  // A history entry carries the URL, not element state, so the disclosure is a
  // :target one rather than a <details> element.
  assert.ok(!/<details/.test(html));
  assert.match(html, new RegExp(`id="${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}-${FINANCE_COMMITTEE}"`));
  assert.match(html, new RegExp(`href="#${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}-${FINANCE_COMMITTEE}"`));
  assert.match(html, new RegExp(`href="#${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}"`));
  for (const row of view.committees) {
    assert.equal(row.anchor, `${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}-${row.committee_id}`);
  }
  const anchors = html.match(/id="committee-shared-membership-[a-z0-9]+"/g) || [];
  assert.equal(new Set(anchors).size, anchors.length, "every anchor on the page is unique");

  // The behaviour is stylesheet-only, and with no stylesheet everything renders.
  assert.match(documentStyles, /\.committee-shared-row:target > \.committee-shared-members \{/);
  assert.match(documentStyles, /\.committee-shared-overflow:has\(\.committee-shared-row:target\) > \.committee-shared-list \{/);
  assert.match(documentStyles, /\.committee-shared-members \{[^}]*display: none;/);
  // Touch targets on the open and close controls.
  assert.match(documentStyles, /\.committee-shared-controls a \{[^}]*min-height: 44px;/);
});

test("the list is bounded and every linked committee stays reachable", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  assert.equal(view.visible_count, COMMITTEE_SHARED_VISIBLE_COMMITTEES);
  assert.equal(view.disclosed_count, view.committee_count - COMMITTEE_SHARED_VISIBLE_COMMITTEES);

  const html = renderEnglish(view);
  assert.match(html, new RegExp(`data-shared-disclosed="${view.disclosed_count}"`));
  assert.match(html, new RegExp(`Show ${view.disclosed_count} more committees`));
  const rendered = html.match(/data-shared-committee-id="(\d+)"/g) || [];
  assert.equal(new Set(rendered).size, view.committee_count);

  const unbounded = viewFor(LANDMARKS_SUBCOMMITTEE, SNAPSHOT_DAY, { limit: 100 });
  assert.equal(unbounded.visible_count, unbounded.committee_count);
  assert.equal(unbounded.disclosed_count, 0);
  assert.ok(!renderEnglish(unbounded).includes("committee-shared-overflow"));
});

test("markup escapes publisher text rather than trusting it", () => {
  const injected = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === `committee:${FINANCE_COMMITTEE}`
      ? { ...node, name: '<img src=x onerror="alert(1)">' }
      : node),
  };
  const view = buildCommitteeSharedMembershipView(injected, LANDMARKS_SUBCOMMITTEE, {
    asOf: SNAPSHOT_DAY,
    people,
  });
  const html = renderEnglish(view);
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img src=x/);
});

test("the committee record composes the section beside its existing roster", () => {
  const view = buildCommitteeDocumentView(graph, people, LANDMARKS_SUBCOMMITTEE);
  assert.equal(view.shared_membership.state, "matched");
  assert.equal(view.shared_membership.as_of, SNAPSHOT_DAY);
  assert.equal(view.members.length, expectedConnections(LANDMARKS_SUBCOMMITTEE).member_count);

  // The existing member list is untouched and still carries the full recorded
  // membership history, not only the periods covering the snapshot day. The
  // Committee on Aging is the clearest case in the corpus: its roster keeps
  // periods that closed long before this snapshot, while the connections beside
  // it describe the snapshot day alone.
  const aging = buildCommitteeDocumentView(graph, people, AGING_COMMITTEE);
  const periods = aging.members.flatMap((member) => member.periods);
  const agingEdges = graph.public_edges.filter((edge) =>
    edge.type === "member_of" && edge.to === `committee:${AGING_COMMITTEE}`
    && people.by_person_id?.[edge.from.replace("official:", "")]?.person_name);
  const distinctEdges = new Set(agingEdges.map((edge) =>
    `${edge.from}\u0000${edge.title}\u0000${edge.valid_from}\u0000${edge.valid_to}`));
  assert.equal(aging.members.length, new Set(agingEdges.map((edge) => edge.from)).size);
  assert.equal(periods.length, distinctEdges.size);
  const closed = periods.filter((period) => period.end < SNAPSHOT_DAY).length;
  assert.ok(closed > 0, "the roster keeps periods that closed before this snapshot");
  assert.equal(closed, periods.length - periods.filter((period) => period.end >= SNAPSHOT_DAY).length);
  assert.equal(aging.shared_membership.as_of, SNAPSHOT_DAY);
  const brewer = aging.members.find((member) => member.official_id === BREWER);
  assert.ok(brewer.periods.length > 1, "a member with several recorded terms keeps all of them");
  assert.deepEqual(
    brewer.periods.map((period) => period.start),
    [...brewer.periods.map((period) => period.start)].sort().reverse(),
    "recorded periods stay newest first",
  );

  const html = renderCommitteeDocument(view, { currentHref: `https://cityscroll.org/committees/${LANDMARKS_SUBCOMMITTEE}/` });
  const roster = html.indexOf('id="committee-members"');
  const shared = html.indexOf(`id="${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}"`);
  assert.ok(roster > -1 && shared > roster, "the roster is rendered before the connections");
  assert.match(html, /<h2 id="committee-shared-membership-heading">Committees these members also serve on<\/h2>/);
  assert.match(html, /data-export-class="committee_shared_membership"/);
  // No new destination: every link the section adds is an existing record route.
  const sectionHtml = html.slice(shared);
  for (const href of sectionHtml.match(/href="[^"]+"/g) || []) {
    assert.match(href, /^href="(?:\/(?:officials|committees)\/\d+\/|#committee-shared-membership(?:-(?:\d+|more))?|\/about\.html|\/guide\/)"$/);
  }

  // A committee with nothing to connect omits the whole section, heading and all.
  const isolatedGraph = {
    ...graph,
    public_edges: graph.public_edges.filter((edge) =>
      edge.to === `committee:${LANDMARKS_SUBCOMMITTEE}` || edge.from === `official:${BREWER}`),
  };
  const isolated = renderCommitteeDocument(
    buildCommitteeDocumentView(isolatedGraph, people, LANDMARKS_SUBCOMMITTEE),
    { currentHref: `https://cityscroll.org/committees/${LANDMARKS_SUBCOMMITTEE}/` },
  );
  assert.ok(!isolated.includes(`id="${COMMITTEE_SHARED_MEMBERSHIP_ANCHOR}"`));
  assert.ok(!isolated.includes("Committees these members also serve on"));
  assert.ok(isolated.includes('id="committee-members"'), "the roster is untouched");
});

test("the copy the record renders is the copy the dictionary ships", () => {
  for (const [key, value] of Object.entries(COMMITTEE_SHARED_MEMBERSHIP_STRINGS)) {
    assert.equal(STRINGS.en[key], value, `${key} drifted from the shipped en dictionary`);
  }
  // The document renders these strings directly because the committee record is
  // served without a dictionary runtime; a translator is still selectable.
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  assert.equal(
    renderEnglish(view),
    renderCommitteeSharedMembershipHTML(view, {
      escapeHtml: escape,
      translate: translateIn("en"),
      translateCount: translateCountIn("en"),
    }),
  );
});

test("the section ships in every first-class language with source titles kept", () => {
  const view = viewFor(LANDMARKS_SUBCOMMITTEE);
  const languages = ["en", ...SHIPPING_LANGS];
  assert.ok(languages.length >= 11);
  for (const lang of languages) {
    const html = renderCommitteeSharedMembershipHTML(view, {
      escapeHtml: escape,
      translate: translateIn(lang),
      translateCount: translateCountIn(lang),
    });
    assert.ok(html, `${lang} renders the section`);
    // No raw dictionary key reaches the reader in any language.
    for (const key of DICTIONARY_KEYS) {
      assert.ok(!html.includes(key), `${lang} leaked the dictionary key ${key}`);
    }
    // Publisher titles, ids, dates and routes are language-independent, and the
    // English data islands stay marked as such for bidirectional layouts.
    assert.match(html, /Committee on Finance/);
    assert.match(html, /Christopher Marte/);
    assert.match(html, /2026-01-15/);
    assert.match(html, new RegExp(`href="/committees/${PARKS_COMMITTEE}/"`));
    assert.match(html, new RegExp(`href="/officials/${NURSE}/"`));
    assert.ok((html.match(/lang="en" dir="ltr"/g) || []).length > 0);
  }
});
