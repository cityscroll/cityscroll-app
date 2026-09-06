/**
 * The public-body directory: what a reader can find, and what the page refuses
 * to claim while they find it.
 *
 * These cases run against the committed directory document and the model that
 * produced it, not a fixture, so a regression in the real page fails here.
 *
 *   node --test test/agency_directory_state.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENCY_GROUPS, agencyCanonicalId } from "../site/agency_identity.mjs";
import {
  AGENCY_DIRECTORY_LEDE,
  AGENCY_DIRECTORY_TITLE,
  buildAgencyDirectoryModel,
  renderAgencyDirectoryDocument,
} from "../site/agency_directory.mjs";
import {
  agencyDirectoryParams,
  agencyDirectoryShareSearch,
  agencyDirectorySummary,
  filterAgencyDirectoryRows,
} from "../site/agency_directory_contract.mjs";
import {
  INSTITUTION_BROWSE_GROUPS,
} from "../site/civic_institution_classification.mjs";
import {
  projectInstitutionClassification,
} from "../site/civic_institution_classification_project.mjs";
import { agencyDirectoryModel } from "../tools/build_agency_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(join(ROOT, "site/agencies/index.html"), "utf8");
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
const BOARDS = JSON.parse(
  readFileSync(join(ROOT, "site/data/community_board_constellation_lookup.json"), "utf8"),
);
const MODEL = agencyDirectoryModel();
const GROUP_IDS = INSTITUTION_BROWSE_GROUPS.map((group) => group.id);

function row(canonicalId) {
  return MODEL.rows.find((entry) => entry.canonical_id === canonicalId);
}

// A1 [outcome] [G1]
test("A1 the directory opens as the commissioned entry point with search and browse groups", () => {
  assert.match(INDEX, /<h1>Agencies &amp; public bodies<\/h1>/);
  assert.ok(INDEX.includes(AGENCY_DIRECTORY_LEDE.replace(/&/g, "&amp;")) || INDEX.includes(AGENCY_DIRECTORY_LEDE));
  assert.equal(AGENCY_DIRECTORY_TITLE, "Agencies & public bodies");

  // The search is a real GET form and the groups are real anchors, so both
  // work before any script runs.
  assert.match(INDEX, /<form class="agency-directory-search" method="get" action="\/agencies\/"/);
  assert.match(INDEX, /name="q"/);
  for (const group of INSTITUTION_BROWSE_GROUPS) {
    if (!MODEL.groups.find((entry) => entry.id === group.id)?.count) continue;
    assert.match(INDEX, new RegExp(`href="/agencies/\\?group=${group.id}#group-${group.id}"`), group.id);
    assert.match(INDEX, new RegExp(`id="group-${group.id}"`), group.id);
  }
});

// A1 [outcome] [G1]
test("A1 the profiles the old directory omitted are reachable without knowing a URL", () => {
  for (const [canonicalId, href] of [
    ["city-planning-commission", "/agencies/city-planning-commission/"],
    ["economic-development-corporation", "/agencies/economic-development-corporation/"],
    ["office-of-racial-equity", "/agencies/office-of-racial-equity/"],
    ["commission-on-racial-equity", "/agencies/commission-on-racial-equity/"],
  ]) {
    assert.equal(row(canonicalId)?.href, href, canonicalId);
    assert.match(INDEX, new RegExp(`href="${href}"`), canonicalId);
  }

  // Every canonical community board keeps its own destination, and no board is
  // republished under an agency route.
  const boardIds = Object.keys(BOARDS.by_id);
  assert.equal(boardIds.length, 59);
  for (const bodyId of boardIds) {
    assert.equal(row(bodyId)?.href, `/community-boards/${bodyId}/`, bodyId);
  }
  assert.doesNotMatch(INDEX, /href="\/agencies\/[a-z-]+-cb-\d+\//);
});

// A1 [outcome] [G1]
test("A1 a name or an acronym narrows the directory to the body that was asked for", () => {
  for (const [query, canonicalId] of [
    ["NYCEDC", "economic-development-corporation"],
    ["CPC", "city-planning-commission"],
    ["DCP", "city-planning"],
    ["NYCHA", "housing-authority"],
    ["Office of Racial Equity", "office-of-racial-equity"],
    ["Commission on Racial Equity", "commission-on-racial-equity"],
    ["Manhattan Community Board 6", "manhattan-cb-06"],
  ]) {
    const matches = filterAgencyDirectoryRows(MODEL.rows, { query });
    assert.ok(matches.length >= 1, `${query} matched nothing`);
    assert.ok(
      matches.some((entry) => entry.canonical_id === canonicalId),
      `${query} did not reach ${canonicalId}`,
    );
  }

  // An acronym one body owns does not drag the other racial equity body in.
  const ore = filterAgencyDirectoryRows(MODEL.rows, { query: "ORE" })
    .map((entry) => entry.canonical_id);
  assert.ok(ore.includes("office-of-racial-equity"));
  assert.equal(ore.includes("commission-on-racial-equity"), false);
});

// A2 [outcome] [G1]
test("A2 the launch classification slice separates the bodies a name would merge", () => {
  const slice = {
    "city-planning": ["department", "departments-executive-offices"],
    "city-planning-commission": ["commission", "boards-commissions"],
    "city-council": ["legislative_body", "council-elected-offices"],
    "office-of-the-mayor": ["elected_office", "council-elected-offices"],
    comptroller: ["elected_office", "council-elected-offices"],
    "public-advocate": ["elected_office", "council-elected-offices"],
    "borough-president-brooklyn": ["elected_office", "council-elected-offices"],
    "housing-authority": ["authority", "authorities-public-corporations"],
    "metropolitan-transportation-authority": ["public_benefit_corporation", "authorities-public-corporations"],
    "economic-development-corporation": ["nonprofit", "nonprofit-organizations"],
  };
  for (const [canonicalId, [kind, group]] of Object.entries(slice)) {
    const projection = projectInstitutionClassification(canonicalId);
    assert.ok(projection, `${canonicalId} has no reviewed classification`);
    assert.equal(projection.institution.institution_kind, kind, canonicalId);
    assert.equal(projection.browse_group, group, canonicalId);
    // A kind never arrives without the source that supports it.
    assert.ok(projection.kind_basis, canonicalId);
    assert.ok(projection.kind_sources.length >= 1, canonicalId);
    for (const source of projection.kind_sources) {
      assert.match(source.source_url, /^https:\/\//, canonicalId);
      assert.ok(source.citation, canonicalId);
    }
  }

  // The department and the commission that shares its leadership stay two
  // bodies with two destinations.
  assert.notEqual(row("city-planning").href, row("city-planning-commission").href);
  assert.notEqual(row("city-planning").group, row("city-planning-commission").group);
});

// A2 [outcome] [G1]
test("A2 the corporation's nonprofit form and its authority regime are separately representable", () => {
  const edc = projectInstitutionClassification("economic-development-corporation");
  assert.equal(edc.institution.institution_kind, "nonprofit");
  assert.equal(edc.legal_form.form, "Nonprofit corporation");
  assert.match(edc.legal_form.source_url, /^https:\/\/edc\.nyc\//);

  // The authority regime is recorded alongside the corporate form, on its own
  // citation, and does not overwrite it.
  const regimes = edc.statutory_regimes.map((regime) => regime.regime);
  assert.ok(regimes.some((regime) => /local authority/i.test(regime)));
  for (const regime of edc.statutory_regimes) {
    assert.ok(regime.citation, regime.regime);
    assert.match(regime.source_url, /^https:\/\//, regime.regime);
  }
  // A dated document is carried with its date rather than as a current fact.
  const dated = edc.statutory_regimes.find((regime) => regime.observed_on);
  assert.match(dated.observed_on, /^\d{4}-\d{2}-\d{2}$/);

  // A reader browsing authorities still finds it, without the group changing
  // what the body's form is.
  assert.ok(edc.secondary_groups.includes("authorities-public-corporations"));
  assert.equal(
    filterAgencyDirectoryRows(MODEL.rows, { group: "authorities-public-corporations" })
      .some((entry) => entry.canonical_id === "economic-development-corporation"),
    true,
  );
  assert.equal(row("economic-development-corporation").kind_label, "Nonprofit organization");
});

// A2 [outcome] [G1]
test("borough boards are distinct directory destinations from the borough office", () => {
  const office = row("borough-president-brooklyn");
  const board = row("brooklyn-borough-board");
  assert.equal(office.href, "/agencies/borough-president-brooklyn/");
  assert.equal(board.href, "/agencies/brooklyn-borough-board/");
  assert.notEqual(office.href, board.href);
  assert.equal(board.kind_label, "Borough board");
  assert.equal(board.subject_ref, "borough-board:brooklyn");
  assert.match(INDEX, /href="\/agencies\/brooklyn-borough-board\/"/);
});

test("A2 an MTA operating body is navigable without inheriting the authority's legal form", () => {
  const parent = projectInstitutionClassification("metropolitan-transportation-authority");
  assert.equal(parent.institution.institution_kind, "public_benefit_corporation");
  for (const canonicalId of ["n-y-c-transit-authority", "long-island-rail-road", "triborough-bridge-and-tunnel-authority"]) {
    const body = projectInstitutionClassification(canonicalId);
    assert.equal(body.browse_group, "authorities-public-corporations", canonicalId);
    assert.equal(body.legal_form, null, canonicalId);
    assert.equal(body.institution.legal_form, null, canonicalId);
    assert.notEqual(body.institution.institution_kind, "public_benefit_corporation", canonicalId);
  }
});

// A3 [boundary] [G1]
test("A3 every institution the previous directory listed is still findable", () => {
  for (const name of Object.keys(AGENCY_GROUPS)) {
    const canonicalId = agencyCanonicalId(name);
    const entry = row(canonicalId);
    assert.ok(entry, `${name} left the directory`);
    // Either it has a published destination, or it is kept by name with an
    // honest statement that this build publishes no profile for it.
    if (!entry.href) {
      assert.match(INDEX, new RegExp(`data-canonical-id="${canonicalId}"`), name);
      assert.match(INDEX, /No profile page yet\./);
    }
    // Reaching it by its own name always works.
    assert.ok(
      filterAgencyDirectoryRows(MODEL.rows, { query: name })
        .some((match) => match.canonical_id === canonicalId),
      name,
    );
  }
});

// A3 [boundary] [G1]
test("A3 one institution is one row, and an unknown classification gets no badge", () => {
  const ids = MODEL.rows.map((entry) => entry.canonical_id);
  assert.equal(ids.length, new Set(ids).size);
  const hrefs = MODEL.rows.filter((entry) => entry.href).map((entry) => entry.href);
  assert.equal(hrefs.length, new Set(hrefs).size);

  // A reviewed alias route resolves into the canonical institution rather than
  // becoming a second row beside it.
  for (const [alias, canonical] of Object.entries(LOOKUP.aliases)) {
    if (alias === canonical) continue;
    assert.equal(ids.includes(alias), false, alias);
    assert.ok(ids.includes(canonical), canonical);
  }

  for (const entry of MODEL.rows) {
    if (entry.classification_status === "classified") {
      assert.ok(entry.kind_label, entry.canonical_id);
      continue;
    }
    assert.equal(entry.kind_label, null, entry.canonical_id);
    assert.equal(entry.purpose, null, entry.canonical_id);
    assert.equal(entry.group, "", entry.canonical_id);
  }
  assert.ok(MODEL.rows.some((entry) => entry.classification_status === "unclassified"));
});

// A3 [boundary] [G1]
test("A3 a group is a navigation placement, never an exclusive legal class", () => {
  const grouped = MODEL.rows.filter((entry) => entry.group);
  for (const entry of grouped) {
    assert.ok(GROUP_IDS.includes(entry.group), entry.canonical_id);
    for (const secondary of entry.secondary_groups) {
      assert.ok(GROUP_IDS.includes(secondary), entry.canonical_id);
      assert.notEqual(secondary, entry.group, entry.canonical_id);
    }
  }
  // A body in two groups is still counted once in All.
  const mayor = row("office-of-the-mayor");
  assert.equal(mayor.secondary_groups.length, 1);
  assert.equal(
    MODEL.rows.filter((entry) => entry.canonical_id === "office-of-the-mayor").length,
    1,
  );
  for (const group of INSTITUTION_BROWSE_GROUPS) {
    const declared = MODEL.groups.find((entry) => entry.id === group.id);
    assert.equal(declared.count, filterAgencyDirectoryRows(MODEL.rows, { group: group.id }).length, group.id);
    assert.ok(declared.count <= MODEL.total, group.id);
  }
});

// A4 [verification] [G1]
test("A4 query and group survive a shared link, and an unknown group degrades to the whole directory", () => {
  assert.deepEqual(
    agencyDirectoryParams("?q=planning&group=boards-commissions", GROUP_IDS),
    { query: "planning", group: "boards-commissions" },
  );
  // A stale or hand-edited group is dropped rather than emptying the page.
  assert.deepEqual(
    agencyDirectoryParams("?q=planning&group=retired-group", GROUP_IDS),
    { query: "planning", group: "" },
  );
  assert.equal(
    agencyDirectoryShareSearch({ query: "planning", group: "boards-commissions" }, GROUP_IDS).toString(),
    "q=planning&group=boards-commissions",
  );
  assert.equal(agencyDirectoryShareSearch({ query: "", group: "" }, GROUP_IDS).toString(), "");

  // The rendered document reflects the state a shared link carries.
  const shared = renderAgencyDirectoryDocument(MODEL, { search: "?q=planning&group=boards-commissions" });
  assert.match(shared, /value="planning"/);
  assert.match(shared, /data-directory-group="boards-commissions" aria-current="true"/);
  assert.match(shared, /Showing \d+ of \d+ public bodies in Boards &amp; commissions matching “planning”\./);
});

// A4 [verification] [G1]
test("A4 with scripting unavailable every destination is still in the document", () => {
  // Nothing is hidden at first paint except the empty-result message, so a
  // reader whose script never runs sees the whole directory rather than none of it.
  const hidden = [...INDEX.matchAll(/<(?:li|section)[^>]*\shidden[^>]*>/g)];
  assert.equal(hidden.length, 0);
  assert.match(INDEX, /<p class="agency-directory-empty" data-directory-empty="1" hidden>/);
  for (const entry of MODEL.rows) {
    if (!entry.href) continue;
    assert.ok(INDEX.includes(`href="${entry.href}"`), entry.canonical_id);
  }
  // The enhancement is a module the page loads, not the source of its links.
  assert.match(INDEX, /<script type="module" src="\/agency_directory_runtime\.mjs"><\/script>/);
});

// A4 [verification] [G1]
test("A4 a search that matches nothing keeps the query and offers a way back", () => {
  const none = filterAgencyDirectoryRows(MODEL.rows, { query: "zzzz no such body" });
  assert.equal(none.length, 0);
  assert.match(
    agencyDirectorySummary({ matched: 0, total: MODEL.total, query: "zzzz no such body" }),
    /Showing 0 of \d+ public bodies matching “zzzz no such body”\./,
  );
  const empty = renderAgencyDirectoryDocument(MODEL, { search: "?q=zzzz+no+such+body" });
  // The query a reader typed is still in the field, and Clear is a real anchor.
  assert.match(empty, /value="zzzz no such body"/);
  assert.match(empty, /<a class="civic-object-action agency-directory-clear" href="\/agencies\/"/);
  assert.match(INDEX, /No public body in this directory matches that search\./);
});

test("the committed directory is what the model renders", () => {
  assert.equal(INDEX, renderAgencyDirectoryDocument(MODEL));
  const rebuilt = buildAgencyDirectoryModel({ agencies: LOOKUP, communityBoards: BOARDS });
  assert.equal(rebuilt.total, MODEL.total);
  assert.equal(rebuilt.linked, MODEL.linked);
  assert.equal(rebuilt.classified, MODEL.classified);
});
