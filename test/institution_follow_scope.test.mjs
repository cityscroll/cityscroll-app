/**
 * Exact-institution follows keep one selected body from start through delivery.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  agencyConstellationFollowHref,
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { communityBoardParticipationPaths } from "../site/community_board_participation.mjs";
import { followingUrlFromWatch, watchFromFollowingParams } from "../site/following_view.mjs";
import {
  composeWatchRuleSentence,
  buildFollowingViewModel,
  renderFollowingDocument,
} from "../site/following_view.mjs";
import {
  COMMUNITY_BOARD_FOLLOW_RECORD_SCOPE,
  INSTITUTION_FOLLOW_RECORD_SCOPE,
  exactInstitutionFollow,
  exactInstitutionNoticeMatches,
  interpretStoredInstitutionFollow,
  relatedInstitutionIds,
} from "../site/institution_follow_scope.mjs";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";

const ORE = "office-of-racial-equity";
const CORE = "commission-on-racial-equity";
const MTA = "metropolitan-transportation-authority";
const NYCT = "n-y-c-transit-authority";
const BOARD = "brooklyn-cb-15";

function filterFromHref(href) {
  return JSON.parse(new URL(href).searchParams.get("filter"));
}

test("new ORE and CORE follows are separately named and persist distinct canonical refs", () => {
  const office = exactInstitutionFollow(ORE);
  const commission = exactInstitutionFollow(CORE);
  assert.equal(office.status, "ok");
  assert.equal(commission.status, "ok");
  assert.equal(office.canonical_id, ORE);
  assert.equal(commission.canonical_id, CORE);
  assert.notEqual(office.filter.entity_refs_all[0], commission.filter.entity_refs_all[0]);
  assert.equal(office.filter.entity_refs_all[0], `agency:id:${ORE}`);
  assert.equal(commission.filter.entity_refs_all[0], `agency:id:${CORE}`);
  assert.match(office.follow_label, /Office of Racial Equity/);
  assert.match(commission.follow_label, /Commission on Racial Equity/);
  assert.equal(office.record_scope, INSTITUTION_FOLLOW_RECORD_SCOPE);
  assert.equal(office.rule_sentence.includes("Commission on Racial Equity"), false);
  assert.equal(commission.rule_sentence.includes("Office of Racial Equity"), false);

  const officeHref = agencyConstellationFollowHref(ORE);
  const commissionHref = agencyConstellationFollowHref(CORE);
  assert.notEqual(officeHref, commissionHref);
  const officeFilter = filterFromHref(officeHref);
  const commissionFilter = filterFromHref(commissionHref);
  assert.deepEqual(officeFilter.entity_refs_all, [`agency:id:${ORE}`]);
  assert.deepEqual(commissionFilter.entity_refs_all, [`agency:id:${CORE}`]);
  assert.equal(JSON.stringify(officeFilter).includes(CORE), false);
  assert.equal(JSON.stringify(commissionFilter).includes(ORE), false);

  const roundTrip = watchFromFollowingParams(new URL(officeHref).searchParams);
  assert.equal(roundTrip.lens, "entity");
  assert.deepEqual(roundTrip.filter.entity_refs_all, [`agency:id:${ORE}`]);
  assert.equal(roundTrip.filter.name, office.canonical_name);
});

test("an MTA operating-body follow stays distinct from MTA and does not inherit related bodies", () => {
  const authority = exactInstitutionFollow(MTA);
  const transit = exactInstitutionFollow(NYCT);
  assert.equal(authority.canonical_id, MTA);
  assert.equal(transit.canonical_id, NYCT);
  assert.ok(authority.related_ids.includes(NYCT));
  assert.ok(transit.related_ids.includes(MTA));
  assert.equal(authority.filter.entity_refs_all.includes(`agency:id:${NYCT}`), false);
  assert.equal(transit.filter.entity_refs_all.includes(`agency:id:${MTA}`), false);

  const href = agencyConstellationFollowHref(MTA);
  const filter = filterFromHref(href);
  assert.deepEqual(filter.entity_refs_all, [`agency:id:${MTA}`]);
  assert.equal(JSON.stringify(filter).includes(NYCT), false);

  assert.equal(exactInstitutionNoticeMatches(authority, { agency_name: "Metropolitan Transportation Authority" }), true);
  assert.equal(exactInstitutionNoticeMatches(authority, { agency_name: "N.Y.C. Transit Authority" }), false);
  assert.equal(exactInstitutionNoticeMatches(transit, { agency_name: "Metropolitan Transportation Authority" }), false);
});

test("a Community Board follow reuses the board-institution meetings capability", () => {
  const follow = exactInstitutionFollow(BOARD);
  assert.equal(follow.status, "ok");
  assert.equal(follow.lens, "meetings");
  assert.equal(follow.filter.communityBoard, "community-board:brooklyn-cb-15");
  assert.equal(follow.record_scope, COMMUNITY_BOARD_FOLLOW_RECORD_SCOPE);
  assert.match(follow.follow_label, /Brooklyn Community Board 15/);
  assert.equal(follow.filter.entity_refs_all, undefined);

  const paths = communityBoardParticipationPaths({ board_id: BOARD, board: { body_id: BOARD } });
  const boardFollow = paths.find((path) => path.kind === "follow_board");
  assert.ok(boardFollow);
  assert.match(boardFollow.verb, /Brooklyn Community Board 15/);
  const parsed = watchFromFollowingParams(new URL(boardFollow.href).searchParams);
  assert.equal(parsed.lens, "meetings");
  assert.equal(parsed.filter.communityBoard, "community-board:brooklyn-cb-15");
});

test("existing name-only watches keep stored matching and offer an explicit correction", () => {
  const stored = interpretStoredInstitutionFollow({
    lens: "entity",
    filter: { kind: "agency", name: "OFFICE OF RACIAL EQUITY" },
  });
  assert.equal(stored.status, "ok");
  assert.equal(stored.matching_mode, "stored_name");
  assert.deepEqual(stored.filter, { kind: "agency", name: "OFFICE OF RACIAL EQUITY" });
  assert.equal(stored.filter.entity_refs_all, undefined);
  assert.ok(stored.correction);
  assert.match(stored.correction.offer, /not reassigned/);
  assert.equal(stored.correction.follow.canonical_id, ORE);
  assert.equal(exactInstitutionNoticeMatches(stored, { agency_name: "OFFICE OF RACIAL EQUITY" }), true);
  assert.equal(exactInstitutionNoticeMatches(stored, { agency_name: "Commission on Racial Equity" }), false);
  assert.equal(exactInstitutionNoticeMatches(stored, { agency_name: "Office of Racial Equity" }), false);
});

test("multi-entity AND filters are not compiled as a group union", () => {
  const stored = interpretStoredInstitutionFollow({
    lens: "entity",
    filter: {
      kind: "agency",
      name: "Metropolitan Transportation Authority",
      entity_refs_all: [`agency:id:${MTA}`, `agency:id:${NYCT}`],
    },
  });
  assert.equal(stored.status, "unsupported");
  assert.match(stored.reason, /not a group follow/);
});

test("preview, confirmation, and profile initiation name the same institution and record scope", () => {
  const exact = exactInstitutionFollow(ORE);
  const view = buildFollowingViewModel({
    lens: exact.lens,
    filter: exact.filter,
    requested: true,
    frequency: "weekly",
  });
  assert.match(view.ruleSentence, /Office of Racial Equity/);
  assert.match(view.ruleSentence, /City Record notices/);
  assert.equal(view.graphContext.institutionFollow.canonical_id, ORE);
  assert.equal(view.graphContext.institutionFollow.record_scope, INSTITUTION_FOLLOW_RECORD_SCOPE);

  const html = renderFollowingDocument(view);
  assert.match(html, /Office of Racial Equity/);
  assert.match(html, /City Record notices this body publishes/);
  assert.doesNotMatch(html, /Follow every MTA operating body|Follow this role/);
  assert.match(html, /data-following-choice-boundary/);

  const profile = renderAgencyConstellationDocument(buildAgencyConstellationView(ORE, {
    intelligence: { by_ref: {}, generated_at: "test" },
    certification: { edges: [], generated_at: "test" },
    obligations: { by_agency: {}, generated_at: "test" },
  }));
  assert.match(profile, /Follow Office of Racial Equity/);
  assert.match(profile, /lens=entity/);
  assert.match(profile, /office-of-racial-equity/);
  assert.doesNotMatch(profile, />Follow this agency</);
});

test("inspecting a related body or source detail is not a follow save", () => {
  const html = renderAgencyConstellationDocument(buildAgencyConstellationView(MTA, {
    intelligence: { by_ref: {}, generated_at: "test" },
    certification: { edges: [], generated_at: "test" },
    obligations: { by_agency: {}, generated_at: "test" },
  }));
  assert.match(html, /data-related-source="1"/);
  assert.doesNotMatch(html, /data-following-subscribe-form/);
  const followHref = new URL(html.match(/href="(https:\/\/cityscroll\.org\/following\?[^"]+)"/)[1].replaceAll("&amp;", "&"));
  const filter = JSON.parse(followHref.searchParams.get("filter"));
  assert.deepEqual(filter.entity_refs_all, [`agency:id:${MTA}`]);
  for (const id of relatedInstitutionIds(MTA)) {
    assert.equal(JSON.stringify(filter).includes(id), false, id);
  }
});

test("composeWatchRuleSentence agrees with the exact follow for ORE, NYCT, and a Community Board", () => {
  for (const id of [ORE, NYCT, BOARD]) {
    const exact = exactInstitutionFollow(id);
    assert.equal(
      composeWatchRuleSentence(exact.lens, exact.filter),
      exact.rule_sentence,
    );
  }
});

test("source-identity resolution still keeps ORE and CORE as separate institutions", () => {
  const office = resolveAgencyIdentity(ORE);
  const commission = resolveAgencyIdentity(CORE);
  assert.equal(office.canonical_id, ORE);
  assert.equal(commission.canonical_id, CORE);
  assert.notEqual(office.canonical_name, commission.canonical_name);
});
