/**
 * Dated committee co-service on official profiles.
 *
 * The committed committee graph is the only input, so every number below is
 * reproducible from the repository. Where a case names a person or a body it
 * also names the source dates, because the point of the projection is that two
 * memberships of the same body are only service together when their dates meet.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMITTEE_COSERVICE_SCHEMA,
  buildCommitteeCoServiceView,
  datedServiceOverlap,
  isCouncilCaucusBody,
  measureCommitteeCoServicePairs,
  renderCommitteeCoServiceHTML,
} from "../site/committee_coservice.mjs";

const graph = JSON.parse(readFileSync(new URL("../site/data/committee_graph_lookup.json", import.meta.url)));
const people = JSON.parse(readFileSync(new URL("../site/data/person_hub_lookup.json", import.meta.url)));
const entitiesSource = readFileSync(new URL("../site/app/entities.mjs", import.meta.url), "utf8");
const captureManifest = JSON.parse(readFileSync(
  new URL("../docs/evidence/official-committee-co-service/capture-manifest.json", import.meta.url),
));

// The committee snapshot's own vintage day. A membership snapshot can only
// answer for a day it observed, so every corpus case below states it.
const SNAPSHOT_DAY = String(graph.generated_at).slice(0, 10);

const MARTE = "7801";
const NURSE = "7824";
const BREWER = "5259";
const LANDMARKS_SUBCOMMITTEE = "5309";
const PARKS_COMMITTEE = "5106";
const AGING_COMMITTEE = "3";

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
const translate = translateIn("en");
const translateCount = translateCountIn("en");

const viewFor = (id, asOf = SNAPSHOT_DAY, options = {}) =>
  buildCommitteeCoServiceView(graph, id, { asOf, people, ...options });

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

test("two members sharing exact bodies are reported with their overlapping dates", () => {
  const view = viewFor(MARTE);
  assert.equal(view.schema, COMMITTEE_COSERVICE_SCHEMA);
  assert.equal(view.state, "matched");
  assert.equal(view.as_of, SNAPSHOT_DAY);

  const colleague = view.colleagues.find((entry) => entry.official_id === NURSE);
  assert.ok(colleague, "the co-service list names the other member");
  assert.equal(colleague.name, "Sandy Nurse");
  assert.equal(colleague.href, `/officials/${NURSE}/`);
  assert.equal(colleague.shared_committee_count, 2);
  assert.deepEqual(
    colleague.shared_committees.map((row) => row.committee_id).sort(),
    [PARKS_COMMITTEE, LANDMARKS_SUBCOMMITTEE].sort(),
  );

  const landmarks = colleague.shared_committees.find((row) => row.committee_id === LANDMARKS_SUBCOMMITTEE);
  assert.equal(landmarks.name, "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions");
  assert.equal(landmarks.href, `/committees/${LANDMARKS_SUBCOMMITTEE}/`);
  // The publisher's own title is retained; the reader-facing role is the one
  // the existing memberships list already uses for the same edge.
  assert.equal(landmarks.subject_role, "Chair");
  assert.equal(landmarks.subject_role_source_title, "CHAIRPERSON");
  assert.equal(landmarks.colleague_role, "Committee Member");
  assert.equal(landmarks.overlap_start, "2026-01-15");

  const parks = colleague.shared_committees.find((row) => row.committee_id === PARKS_COMMITTEE);
  assert.equal(parks.name, "Committee on Parks and Recreation");
  assert.equal(parks.subject_role, "Committee Member");
  assert.equal(parks.colleague_role, "Committee Member");
  assert.equal(parks.overlap_start, "2026-01-15");

  for (const row of colleague.shared_committees) {
    assert.ok(row.overlap_start <= SNAPSHOT_DAY && row.overlap_end >= SNAPSHOT_DAY);
  }
});

test("the reciprocal profile reports the same two bodies with the roles swapped", () => {
  const colleague = viewFor(NURSE).colleagues.find((entry) => entry.official_id === MARTE);
  assert.ok(colleague);
  assert.equal(colleague.name, "Christopher Marte");
  assert.equal(colleague.shared_committee_count, 2);
  const landmarks = colleague.shared_committees.find((row) => row.committee_id === LANDMARKS_SUBCOMMITTEE);
  assert.equal(landmarks.subject_role, "Committee Member");
  assert.equal(landmarks.colleague_role, "Chair");
  assert.equal(landmarks.overlap_start, "2026-01-15");
});

test("the population the profile counts come from is reproducible from the graph", () => {
  const measured = measureCommitteeCoServicePairs(graph, { asOf: SNAPSHOT_DAY });
  assert.equal(measured.as_of, SNAPSHOT_DAY);
  assert.equal(measured.represented_officials, 24);
  assert.equal(measured.pairs, 165);
  assert.equal(measured.pairs_with_two_or_more_bodies, 60);

  // The graph itself is larger than the set active on the snapshot day, and the
  // section says so by carrying the represented count rather than implying the
  // roster is complete.
  const allPeople = new Set(graph.public_edges.map((edge) => edge.from));
  assert.equal(allPeople.size, 30);
  assert.equal(graph.nodes.length, 96);
  assert.equal(graph.public_edges.length, 1143);
  assert.equal(viewFor(MARTE).represented_official_count, measured.represented_officials);
});

test("service on one body in different decades is not service together", () => {
  // Both members served on the Committee on Aging, and never at the same time
  // in these two terms.
  const marteAging = graph.public_edges.find((edge) =>
    edge.from === `official:${MARTE}` && edge.to === `committee:${AGING_COMMITTEE}`
    && edge.valid_from === "2022-01-20");
  const brewerAging = graph.public_edges.find((edge) =>
    edge.from === `official:${BREWER}` && edge.to === `committee:${AGING_COMMITTEE}`
    && edge.valid_from === "2006-01-18");
  assert.equal(marteAging.valid_to, "2023-12-31");
  assert.equal(brewerAging.valid_to, "2009-12-31");
  assert.equal(
    datedServiceOverlap(
      { start: marteAging.valid_from, end: marteAging.valid_to },
      { start: brewerAging.valid_from, end: brewerAging.valid_to },
    ),
    null,
  );

  // Asked about a day inside only one of the two Aging terms, the projection
  // reports no Aging service together. The control is about dates: on that same
  // day the two members do share other bodies, and those are still reported.
  const view = viewFor(MARTE, "2023-01-01");
  const brewer = view.colleagues.find((entry) => entry.official_id === BREWER);
  assert.ok(brewer, "same-day service on other bodies is unaffected");
  assert.ok(!brewer.shared_committees.some((row) => row.committee_id === AGING_COMMITTEE));
  // Brewer's Aging membership is not merely absent from the pair; it is absent
  // from the day, so no other member picks it up from him either.
  assert.ok(!graph.public_edges.some((edge) =>
    edge.from === `official:${BREWER}` && edge.to === `committee:${AGING_COMMITTEE}`
    && edge.valid_from <= "2023-01-01" && edge.valid_to >= "2023-01-01"));
});

test("a day both terms cover does report the same body", () => {
  // The control above is about dates, not about the pair: on a day both members
  // are recorded on Aging, the same projection reports it.
  const view = viewFor(MARTE, "2026-01-20");
  const brewer = view.colleagues.find((entry) => entry.official_id === BREWER);
  assert.ok(brewer, "same-body service on a shared day is reported");
  const aging = brewer.shared_committees.find((row) => row.committee_id === AGING_COMMITTEE);
  assert.ok(aging);
  assert.equal(aging.overlap_start, "2026-01-15");
  assert.equal(aging.overlap_end, "2026-01-29");
});

test("a repeated observation of one membership stays one body", () => {
  const marteLandmarks = graph.public_edges.find((edge) =>
    edge.from === `official:${MARTE}` && edge.to === `committee:${LANDMARKS_SUBCOMMITTEE}`
    && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY);
  const nurseLandmarks = graph.public_edges.find((edge) =>
    edge.from === `official:${NURSE}` && edge.to === `committee:${LANDMARKS_SUBCOMMITTEE}`
    && edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY);
  const duplicated = {
    ...graph,
    public_edges: [
      ...graph.public_edges,
      { ...marteLandmarks, source_row_hash: "repeat-observation-a" },
      { ...nurseLandmarks, source_row_hash: "repeat-observation-b" },
    ],
  };
  const view = buildCommitteeCoServiceView(duplicated, MARTE, { asOf: SNAPSHOT_DAY, people });
  const colleague = view.colleagues.find((entry) => entry.official_id === NURSE);
  assert.equal(colleague.shared_committee_count, 2);
  assert.equal(
    colleague.shared_committees.filter((row) => row.committee_id === LANDMARKS_SUBCOMMITTEE).length,
    1,
  );
  assert.equal(
    measureCommitteeCoServicePairs(duplicated, { asOf: SNAPSHOT_DAY }).pairs_with_two_or_more_bodies,
    60,
  );
});

test("caucuses are held apart from the committee count", () => {
  assert.equal(isCouncilCaucusBody("Caucus - Progressive Caucus"), true);
  assert.equal(isCouncilCaucusBody("Committee on Parks and Recreation"), false);

  const colleague = viewFor(MARTE).colleagues.find((entry) => entry.official_id === NURSE);
  assert.equal(colleague.shared_committee_count, 2);
  assert.equal(colleague.shared_caucus_count, 3);
  assert.ok(colleague.shared_caucuses.every((row) => isCouncilCaucusBody(row.name)));
  assert.ok(colleague.shared_committees.every((row) => !isCouncilCaucusBody(row.name)));

  // A caucus never promotes someone into the list on its own.
  const caucusRefs = new Set(graph.nodes.filter((node) => isCouncilCaucusBody(node.name)).map((node) => node.id));
  assert.ok(caucusRefs.size > 0);
  const view = viewFor(MARTE);
  for (const entry of view.colleagues) {
    assert.ok(entry.shared_committee_count > 0);
  }
  assert.equal(
    view.represented_official_count,
    new Set(graph.public_edges
      .filter((edge) => edge.valid_from <= SNAPSHOT_DAY && edge.valid_to >= SNAPSHOT_DAY)
      .filter((edge) => !caucusRefs.has(edge.to))
      .map((edge) => edge.from)).size,
  );
});

test("the as-of day is an argument, never an ambient clock", () => {
  assert.equal(buildCommitteeCoServiceView(graph, MARTE, { people }).state, "unknown");
  assert.equal(buildCommitteeCoServiceView(graph, MARTE, { asOf: "not-a-day", people }).state, "unknown");
  // A real day the member held no committee is an empty answer, not an unknown
  // one, and neither state renders anything.
  assert.equal(viewFor(MARTE, "1999-01-01").state, "empty");
  assert.equal(viewFor(MARTE, "2015-06-01").state, "empty");
  assert.equal(viewFor(BREWER, "2007-06-01").state, "matched");
  assert.notEqual(viewFor(BREWER, "2007-06-01").colleague_count, viewFor(BREWER).colleague_count);
});

test("an unpublished or unmatched graph renders no resident furniture", () => {
  const held = buildCommitteeCoServiceView({ ...graph, publication: "held" }, MARTE, {
    asOf: SNAPSHOT_DAY,
    people,
  });
  assert.equal(held.state, "unknown");
  assert.equal(renderCommitteeCoServiceHTML(held, { escape, translate, translateCount }), "");
  assert.equal(renderCommitteeCoServiceHTML(null, { escape, translate, translateCount }), "");

  const soleMember = buildCommitteeCoServiceView({
    ...graph,
    public_edges: graph.public_edges.filter((edge) =>
      edge.to !== `committee:${LANDMARKS_SUBCOMMITTEE}` || edge.from === `official:${MARTE}`),
  }, MARTE, { asOf: SNAPSHOT_DAY, people });
  assert.equal(soleMember.state, "matched");
  assert.ok(!soleMember.colleagues.some((entry) =>
    entry.shared_committees.some((row) => row.committee_id === LANDMARKS_SUBCOMMITTEE)));

  const noCommittees = buildCommitteeCoServiceView({
    ...graph,
    public_edges: graph.public_edges.filter((edge) => edge.from !== `official:${MARTE}`),
  }, MARTE, { asOf: SNAPSHOT_DAY, people });
  assert.equal(noCommittees.state, "empty");
  assert.equal(noCommittees.colleague_count, 0);
  assert.equal(renderCommitteeCoServiceHTML(noCommittees, { escape, translate, translateCount }), "");
});

test("an official with no published name is counted, never rendered as an id", () => {
  const view = buildCommitteeCoServiceView(graph, MARTE, {
    asOf: SNAPSHOT_DAY,
    people: { by_person_id: { [MARTE]: people.by_person_id[MARTE] } },
  });
  assert.equal(view.colleague_count, 0);
  assert.equal(view.unnamed_colleague_count, 17);
  assert.equal(renderCommitteeCoServiceHTML(view, { escape, translate, translateCount }), "");
  assert.equal(viewFor(MARTE).unnamed_colleague_count, 0);
});

test("the rendered section links people and committees through published routes", () => {
  const view = viewFor(MARTE);
  const html = renderCommitteeCoServiceHTML(view, { escapeHtml: escape, translate, translateCount });

  assert.match(html, /data-official-coservice="1"/);
  assert.match(html, new RegExp(`data-coservice-as-of="${SNAPSHOT_DAY}"`));
  assert.match(html, /data-coservice-colleague-count="17"/);
  assert.match(html, /data-coservice-represented-officials="24"/);

  // Native anchors only: a modified click and the browser's own history keep
  // working, and nothing here submits or subscribes.
  assert.ok(!/<button/.test(html));
  assert.ok(!/onclick=/.test(html));
  assert.ok(!/target="_blank"/.test(html));
  assert.match(html, new RegExp(`<a[^>]+href="/officials/${NURSE}/"`));
  assert.match(html, new RegExp(`<a[^>]+href="/committees/${LANDMARKS_SUBCOMMITTEE}/"`));
  assert.match(html, new RegExp(`<a[^>]+href="/committees/${PARKS_COMMITTEE}/"`));
  for (const href of html.match(/href="[^"]+"/g) || []) {
    assert.match(href, /^href="\/(officials|committees)\/\d+\/"$/);
  }

  assert.match(html, /Sandy Nurse/);
  assert.match(html, /Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions/);
  assert.match(html, /Christopher Marte: Chair/);
  assert.match(html, /Sandy Nurse: Committee Member/);
  assert.match(html, /Both listed 2026-01-15 to 2029-12-31/);
  assert.match(html, /2 shared committees/);

  // Co-service is a roster fact and the copy stays one.
  for (const claim of ["attend", "vote", "voting", "align", "ally", "coordinat", "influence", "agree"]) {
    assert.ok(!html.toLowerCase().includes(claim), `co-service copy must not claim ${claim}`);
  }
});

test("the list is bounded and the remainder stays inspectable in place", () => {
  const view = viewFor(MARTE);
  assert.equal(view.colleague_count, 17);
  assert.equal(view.visible_count, 8);
  assert.equal(view.disclosed_count, 9);

  const html = renderCommitteeCoServiceHTML(view, { escapeHtml: escape, translate, translateCount });
  assert.match(html, /<details class="official-coservice-more" data-coservice-disclosed="9">/);
  assert.match(html, /<summary>Show 9 more officials<\/summary>/);
  // Every colleague is reachable; the disclosure hides none of them from the
  // document, and opening it navigates nowhere.
  const rendered = html.match(/data-coservice-official-id="(\d+)"/g) || [];
  assert.equal(new Set(rendered).size, 17);

  const unbounded = viewFor(MARTE, SNAPSHOT_DAY, { limit: 100 });
  assert.equal(unbounded.visible_count, 17);
  assert.equal(unbounded.disclosed_count, 0);
  assert.ok(!renderCommitteeCoServiceHTML(unbounded, {
    escapeHtml: escape, translate, translateCount,
  }).includes("<details"));
});

test("markup escapes publisher text rather than trusting it", () => {
  const injected = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === `committee:${PARKS_COMMITTEE}`
      ? { ...node, name: '<img src=x onerror="alert(1)">' }
      : node),
  };
  const view = buildCommitteeCoServiceView(injected, MARTE, { asOf: SNAPSHOT_DAY, people });
  const html = renderCommitteeCoServiceHTML(view, { escapeHtml: escape, translate, translateCount });
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img src=x/);
});

test("the official profile composes the section beside the existing memberships list", () => {
  assert.match(entitiesSource, /import\("\.\.\/committee_coservice\.mjs"\)/);
  assert.match(entitiesSource, /buildCommitteeCoServiceView\(committeeGraph \|\| \{\}, id, \{/);
  assert.match(entitiesSource, /asOf: String\(committeeGraph\?\.generated_at \|\| ""\)\.slice\(0, 10\)/);
  assert.match(entitiesSource, /renderCommitteeCoServiceHTML\(coserviceView/);
  // The existing membership list stays, and is rendered before the new section.
  const memberships = entitiesSource.indexOf("renderCommitteeMembershipsHTML(committeeBag");
  const coservice = entitiesSource.indexOf("renderCommitteeCoServiceHTML(coserviceView");
  assert.ok(memberships > -1 && coservice > memberships);
});

test("the section ships in every first-class language with source titles kept", () => {
  const view = viewFor(MARTE);
  const languages = ["en", ...SHIPPING_LANGS];
  assert.ok(languages.length >= 11);
  for (const lang of languages) {
    const html = renderCommitteeCoServiceHTML(view, {
      escapeHtml: escape,
      translate: translateIn(lang),
      translateCount: translateCountIn(lang),
    });
    assert.ok(html, `${lang} renders the section`);
    // No raw dictionary key reaches the reader in any language.
    assert.ok(!/official_coservice_/.test(html), `${lang} leaked a dictionary key`);
    // Publisher titles, ids, dates and routes are language-independent, and the
    // English data islands stay marked as such for bidirectional layouts.
    assert.match(html, /Sandy Nurse/);
    assert.match(html, /Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions/);
    assert.match(html, /2026-01-15/);
    assert.match(html, new RegExp(`href="/committees/${LANDMARKS_SUBCOMMITTEE}/"`));
    assert.match(html, new RegExp(`href="/officials/${NURSE}/"`));
    assert.equal((html.match(/lang="en" dir="ltr"/g) || []).length > 0, true);
  }
});
