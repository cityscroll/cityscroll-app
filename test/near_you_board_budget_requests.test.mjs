/**
 * Near You overview projects the covering board's budget requests for every
 * supported selected place. BK1503 / Brooklyn CB15 is a regression fixture
 * only; the predicate is shared across every supported board.
 *
 * Verifier: node --test test/near_you_board_budget_requests.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BUDGET_REQUEST_STATES,
  boardBudgetRequestsViewFromLookup,
  buildNearYouBoardBudgetRequestsOverviewSection,
  communityBoardBudgetRequestsForBoard,
  projectNearYouBoardBudgetRequestRecords,
  selectNearYouBoardBudgetRequestRows,
} from "../site/community_board_budget_requests.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeFromNearYouUrl, scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import { broaderDistrictsFromCommittedArtifacts } from "../tools/build_worker_route_read_models.mjs";
import { buildCommunityBoardBudgetRequestsLookup } from "../tools/build_community_board_budget_requests_lookup.mjs";
import { nearYouRecordInspectionFacts } from "../site/near_you_record_inspection.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const FIXTURE_CLOCK = "2026-09-01T12:00:00.000Z";
const SHEEPSHEAD = "geography:nta2020:BK1503";
const LOOKUP = readJson("site/data/community_board_budget_requests_lookup.json");
const GEOGRAPHY = readJson("site/data/community_board_geography_lookup.json");
const REGISTER_INDEX = readJson("site/data/community_board_budget_register.json");
const CB15_DOCUMENT = readJson("site/data/community_board_budget_register/brooklyn-cb-15.json");
const Q04_DOCUMENT = readJson("site/data/community_board_budget_register/queens-cb-04.json");
const BOUNDARIES = { community_districts: [], council_districts: [] };
const EMPTY_ACTIVITY = {
  schema: "cityscroll.district_activity.v1",
  built_at: FIXTURE_CLOCK,
  boundary_vintage: "2026-05-26",
  district_items: { by_level: { community_district: {}, borough: {}, council_district: {} }, citywide: {}, virtual: {}, unlocated: {} },
  records: { meetings: {}, land: {}, property: {}, rules: {}, money: {}, consultations: {} },
  by_level: { community_district: {}, borough: {}, council_district: {} },
  geography_items: { definitions: {}, by_key: {} },
};

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function boardPresentation(boardId) {
  const node = (GEOGRAPHY.nodes || []).find((row) => row?.properties?.body_id === boardId);
  return {
    boardLabel: node?.name || null,
    boardHref: boardId ? `/community-boards/${boardId}/` : null,
  };
}

function budgetSectionInput(boardId) {
  const presentation = boardPresentation(boardId);
  return {
    coveringBoardId: boardId,
    boardHref: presentation.boardHref,
    boardLabel: presentation.boardLabel,
    view: boardBudgetRequestsViewFromLookup(LOOKUP, boardId),
    readState: "ready",
  };
}

function sectionFor(boardId) {
  return buildNearYouBoardBudgetRequestsOverviewSection(budgetSectionInput(boardId));
}

function overviewForCommunityDistrict(districtId, borough, options = {}) {
  const scope = scopeWithPlace(scopeFromLensState(null, {}), {
    communityDistrict: districtId,
    borough,
  });
  return buildNearYouViewModel(scope, EMPTY_ACTIVITY, BOUNDARIES, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: GEOGRAPHY,
    now: FIXTURE_CLOCK,
    ...options,
  });
}

function overviewForNta(geoKey, options = {}) {
  const shortGeo = geoKey.replace(/^geography:/, "");
  const scope = scopeFromNearYouUrl(
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(shortGeo)}&surface=map&drawer=open&focus=${encodeURIComponent(geoKey)}`,
  );
  const relations = options.broaderDistricts?.relations
    || broaderDistrictsFromCommittedArtifacts()[geoKey]
    || [];
  return buildNearYouViewModel(scope, EMPTY_ACTIVITY, BOUNDARIES, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: GEOGRAPHY,
    broaderDistricts: options.broaderDistricts || { relations, slices: {} },
    now: FIXTURE_CLOCK,
    geographySearch: `geo=${encodeURIComponent(shortGeo)}`,
    ...options,
  });
}

function budgetSection(view) {
  return view.overview.sections.find((section) => section.key === "board-budget-requests") || null;
}

function syntheticRegisterIndex() {
  return {
    schema: "cityscroll.community_board_budget_register.index.v1",
    source: {
      publisher: "Test publisher",
      name: "Register of Community Board Budget Requests",
      source_url: "https://example.test/register",
      dataset_id: "test-set",
    },
    publication_selection: {
      as_of: "2026-09-01",
      servable: ["20260512", "20260630"],
      diagnostic_only: ["20270217"],
      latest: "20260630",
    },
    publications: [
      { publication: "20260512", publication_date: "2026-05-12" },
      { publication: "20260630", publication_date: "2026-06-30" },
      { publication: "20270217", publication_date: "2027-02-17" },
    ],
  };
}

function syntheticBoardDocument() {
  const agency = (label, id = null, binding = "unbound") => ({ source_label: label, agency_id: id, binding });
  return {
    schema: "cityscroll.community_board_budget_register.document.v1",
    board_id: "brooklyn-cb-15",
    publications: syntheticRegisterIndex().publications,
    request_count: 3,
    requests: [
      {
        tracking_code: "215202701C",
        fiscal_year: 2027,
        request_class: "capital",
        board_id: "brooklyn-cb-15",
        board_binding: "bound",
        versions: [
          { publication: "20260512", publication_date: "2026-05-12", servable: true, responsible_agency: agency("Brooklyn Public Library"), request: "Old wording", response: "First answer" },
          { publication: "20260630", publication_date: "2026-06-30", servable: true, responsible_agency: agency("Brooklyn Public Library"), request: "New wording", response: "Final answer" },
          { publication: "20270217", publication_date: "2027-02-17", servable: false, responsible_agency: agency("Brooklyn Public Library"), request: "Forward-dated wording", response: "Forward-dated answer" },
        ],
        response_comparisons: [],
      },
      {
        tracking_code: "215202702E",
        fiscal_year: 2027,
        request_class: "expense",
        board_id: "brooklyn-cb-15",
        board_binding: "bound",
        versions: [
          { publication: "20260512", publication_date: "2026-05-12", servable: true, responsible_agency: agency("Test agency", "test-agency", "bound"), request: "Asked without an answer yet", response: "" },
        ],
        response_comparisons: [],
      },
      {
        tracking_code: "215202703C",
        fiscal_year: 2027,
        request_class: "capital",
        board_id: "brooklyn-cb-15",
        board_binding: "bound",
        versions: [
          { publication: "20270217", publication_date: "2027-02-17", servable: false, responsible_agency: agency("Test agency", "test-agency", "bound"), request: "Only a forward-dated publication", response: "Not servable" },
        ],
        response_comparisons: [],
      },
    ],
  };
}

test("A1: BK1503 covering-board overview previews real CB15 register requests", async () => {
  await withPinnedClock(FIXTURE_CLOCK, () => {
    const input = budgetSectionInput("brooklyn-cb-15");
    const section = buildNearYouBoardBudgetRequestsOverviewSection(input);
    assert.ok(section, "section must render when the covering board has a servable register");
    assert.equal(section.title, "Board budget requests");
    assert.equal(section.count, 54, "CB15's retained register holds 54 requests");
    assert.ok(section.records.length > 0 && section.records.length <= 3);
    for (const record of section.records) {
      assert.ok(record.title && record.date && record.type && record.route && record.source_url);
      assert.equal(record.type, "Budget request");
      assert.match(record.basis, /full community district/i);
      assert.match(record.route, /^\/community-boards\/brooklyn-cb-15\/#budget-request-[0-9a-z]+$/);
      assert.doesNotMatch(record.basis, /exact neighborhood|BK1503|nta2020/i);
      // Publication context: the shown date is a servable publication date.
      assert.match(record.date, /^2026-0[56]-\d{2}$/);
      assert.ok(/Agency answer published |No written agency answer/.test(record.response_note));
    }
    assert.equal(section.destinationHref, "/community-boards/brooklyn-cb-15/#board-budget-requests");
    assert.equal(section.destinationLabel, "Open board budget requests");

    const view = overviewForNta(SHEEPSHEAD, {
      boardBudgetRequests: input.view,
      boardBudgetRequestsState: "ready",
    });
    const rendered = budgetSection(view);
    assert.ok(rendered?.records?.length, "overview must project the budget section");
    const html = renderNearYouDocument(view);
    assert.match(html, /id="near-overview-board-budget-requests"/);
    assert.match(html, /Board budget requests/);
    assert.match(html, /href="\/community-boards\/brooklyn-cb-15\/#board-budget-requests"/);
    assert.match(html, /data-near-you-record-source/);
    assert.match(html, /full Community Board district/i);
    assert.doesNotMatch(html, /District priorities/);
    assert.doesNotMatch(html, /not published in this digest/);

    // Opening a record shows its original source, date, and geographic scope.
    for (const record of section.records) {
      const facts = nearYouRecordInspectionFacts(record, { now: FIXTURE_CLOCK });
      assert.ok(facts?.source_url?.startsWith("https://"), "inspect must keep the official source");
      assert.ok(facts?.date_label, "inspect must keep the publication date");
      assert.match(facts?.geography?.basis || "", /full community district/i);
      assert.match(html, /data-near-you-record-inspection=/);
    }
  });
});

test("A1b: an independent Queens CB04 selected place uses the same predicate", () => {
  const input = budgetSectionInput("queens-cb-04");
  const section = buildNearYouBoardBudgetRequestsOverviewSection(input);
  assert.ok(section?.records?.length);
  assert.ok(section.count > 3, "Queens CB04 retains more requests than the preview shows");
  assert.equal(section.destinationHref, "/community-boards/queens-cb-04/#board-budget-requests");
  for (const record of section.records) {
    assert.match(record.basis, /Queens Community Board 4|full community district/i);
    assert.ok(record.source_url.startsWith("https://"));
  }
  const view = overviewForCommunityDistrict("Q04", "Queens", {
    boardBudgetRequests: input.view,
    boardBudgetRequestsState: "ready",
  });
  const rendered = budgetSection(view);
  assert.ok(rendered, "Queens overview must render the budget section");
  assert.equal(view.placePresentation.boardHref, "/community-boards/queens-cb-04/");
});

test("A1c: the lookup is a bounded projection of the canonical register reading", () => {
  const canonical = communityBoardBudgetRequestsForBoard(REGISTER_INDEX, CB15_DOCUMENT, "brooklyn-cb-15");
  assert.equal(canonical.state, BUDGET_REQUEST_STATES.AVAILABLE);
  assert.equal(canonical.request_count, 54);
  const canonicalRecords = projectNearYouBoardBudgetRequestRecords(canonical, {
    boardLabel: boardPresentation("brooklyn-cb-15").boardLabel,
    boardHref: "/community-boards/brooklyn-cb-15/",
  });
  const lookupSection = sectionFor("brooklyn-cb-15");
  assert.deepEqual(
    canonicalRecords.map((row) => `${row.id}|${row.title}|${row.date}|${row.route}`),
    lookupSection.records.map((row) => `${row.id}|${row.title}|${row.date}|${row.route}`),
    "lookup preview and canonical reading must project the same records",
  );
  const queens = communityBoardBudgetRequestsForBoard(REGISTER_INDEX, Q04_DOCUMENT, "queens-cb-04");
  assert.equal(queens.request_count, sectionFor("queens-cb-04").count);
});

test("A1d: the preview reads each request's latest servable publication only", () => {
  const view = communityBoardBudgetRequestsForBoard(
    syntheticRegisterIndex(),
    syntheticBoardDocument(),
    "brooklyn-cb-15",
  );
  assert.equal(view.state, BUDGET_REQUEST_STATES.AVAILABLE);
  // The forward-dated publication is retained by the register but never read
  // here, and a request with no servable publication is not a request this
  // reading holds.
  assert.equal(view.request_count, 2);
  const rows = selectNearYouBoardBudgetRequestRows(view);
  const answered = rows.find((row) => row.tracking_code === "215202701C");
  assert.equal(answered.title, "New wording", "wording comes from the latest servable version");
  assert.equal(answered.latest_answer.publication_date, "2026-06-30");
  assert.equal(answered.latest_answer.response, "Final answer");
  const unanswered = rows.find((row) => row.tracking_code === "215202702E");
  assert.equal(unanswered.latest_answer.response, null);
  const records = projectNearYouBoardBudgetRequestRecords(view, {
    boardHref: "/community-boards/brooklyn-cb-15/",
  });
  const byCode = Object.fromEntries(records.map((row) => [row.id.split(":")[2], row]));
  assert.equal(byCode["215202701C"].response_note, "Agency answer published June 30, 2026");
  assert.equal(byCode["215202702E"].response_note, "No written agency answer in the retained publications");
  assert.doesNotMatch(JSON.stringify(records), /Forward-dated|Only a forward-dated/);
});

test("A2: the section claims no rank, funding, completion, or neighborhood-exact scope", () => {
  const section = sectionFor("brooklyn-cb-15");
  const html = renderNearYouDocument(overviewForNta(SHEEPSHEAD, {
    boardBudgetRequests: budgetSectionInput("brooklyn-cb-15").view,
    boardBudgetRequestsState: "ready",
  }));
  // A request and an answer stay distinct facts: the type never widens beyond
  // the request, the answer is named as an answer, and no card merges them.
  assert.ok(section.records.every((row) => row.type === "Budget request"));
  assert.ok(section.records.every((row) => row.response_note !== row.title));
  for (const phrase of [/top request/i, /priority #?\d/i, /ranked/i, /most important/i, /funded/i, /fully funded/i, /completed/i, /delivered/i]) {
    assert.doesNotMatch(html, phrase, `resident copy must not claim ${phrase}`);
  }
  assert.match(section.coverage, /not funding or completion/);
  assert.match(section.coverage, /wider than one neighborhood/);
  // The board's priority numbers rank inside one agency; none reach this card.
  assert.doesNotMatch(html, /data-record-id="budget-request:[^"]*"[^>]*>\s*0?\d\b/);
});

test("A3: absent registers, empty registers, and failed reads omit the card without inventing zero", () => {
  // A board the lookup holds nothing for, or no board at all.
  assert.equal(boardBudgetRequestsViewFromLookup(LOOKUP, "no-such-board"), null);
  assert.equal(buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: "no-such-board",
    readState: "absent",
    view: null,
  }), null);
  assert.equal(buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: null,
    readState: "absent",
    view: null,
  }), null);

  // A register that holds nothing for the board is a statement about the
  // register, and the optional card is omitted rather than restated as a
  // resident-facing "no requests".
  const noneRecorded = buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: "brooklyn-cb-15",
    boardHref: "/community-boards/brooklyn-cb-15/",
    readState: "ready",
    view: {
      ...budgetSectionInput("brooklyn-cb-15").view,
      state: BUDGET_REQUEST_STATES.NONE_RECORDED,
      request_count: 0,
      requests: [],
    },
  });
  assert.equal(noneRecorded, null);

  // A failed read stays a failure for diagnosis and never becomes "no requests".
  const failedView = boardBudgetRequestsViewFromLookup({
    ...LOOKUP,
    by_board: {
      "brooklyn-cb-15": {
        ...LOOKUP.by_board["brooklyn-cb-15"],
        state: BUDGET_REQUEST_STATES.UNAVAILABLE,
        unavailable_reason: "register document unreadable",
        requests: [],
      },
    },
  }, "brooklyn-cb-15");
  assert.equal(failedView.state, BUDGET_REQUEST_STATES.UNAVAILABLE);
  assert.equal(failedView.unavailable_reason, "register document unreadable");
  assert.equal(buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: "brooklyn-cb-15",
    boardHref: "/community-boards/brooklyn-cb-15/",
    readState: "ready",
    view: failedView,
  }), null);
  assert.equal(buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: "brooklyn-cb-15",
    readState: "error",
    view: null,
  }), null);

  // A caller that offers no register read at all gets no placeholder card.
  const legacy = overviewForNta(SHEEPSHEAD);
  assert.equal(budgetSection(legacy), null);
  const legacyHtml = renderNearYouDocument(legacy);
  assert.doesNotMatch(legacyHtml, /District priorities/);
  assert.doesNotMatch(legacyHtml, /id="near-overview-board-budget-requests"/);
  assert.doesNotMatch(legacyHtml, /this board made no requests|no budget requests/i);

  // A lensed result list keeps its prior shape: a lens scope offers no
  // register read, so the optional card is omitted there too.
  const lensed = buildNearYouViewModel(
    scopeWithPlace(scopeFromLensState("meetings", {}), { communityDistrict: "Q04", borough: "Queens" }),
    EMPTY_ACTIVITY,
    BOUNDARIES,
    {
      canonicalBase: "https://cityscroll.org/near-you",
      communityGeography: GEOGRAPHY,
      now: FIXTURE_CLOCK,
      boardBudgetRequests: budgetSectionInput("queens-cb-04").view,
    },
  );
  assert.equal(budgetSection(lensed), null, "a lens scope must not project the overview budget card");
  const overview = overviewForCommunityDistrict("Q04", "Queens", {
    boardBudgetRequests: budgetSectionInput("queens-cb-04").view,
    boardBudgetRequestsState: "ready",
  });
  assert.ok(budgetSection(overview));
});

test("A3b: a register whose only publications are forward-dated holds nothing servable", () => {
  const futureOnly = communityBoardBudgetRequestsForBoard(syntheticRegisterIndex(), {
    ...syntheticBoardDocument(),
    requests: [syntheticBoardDocument().requests[2]],
  }, "brooklyn-cb-15");
  assert.equal(futureOnly.state, BUDGET_REQUEST_STATES.NONE_RECORDED);
  assert.equal(buildNearYouBoardBudgetRequestsOverviewSection({
    coveringBoardId: "brooklyn-cb-15",
    boardHref: "/community-boards/brooklyn-cb-15/",
    readState: "ready",
    view: futureOnly,
  }), null);
});

test("A4: desktop, 390px, and no-JavaScript renderings keep sources and destinations", () => {
  const view = overviewForNta(SHEEPSHEAD, {
    boardBudgetRequests: budgetSectionInput("brooklyn-cb-15").view,
    boardBudgetRequestsState: "ready",
  });
  const rendered = renderNearYouDocument(view);
  const fixtures = [
    ["desktop", 1440, rendered],
    ["390px", 390, rendered],
    ["no-JavaScript", 390, rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/>/gi, "")],
  ];
  for (const [name, width, html] of fixtures) {
    assert.ok(width === 1440 || width === 390, `${name} viewport`);
    assert.match(html, /id="near-overview-board-budget-requests"/, `${name} loses the budget section`);
    assert.match(html, /href="\/community-boards\/brooklyn-cb-15\/#board-budget-requests"/, `${name} loses the section destination`);
    assert.match(html, /href="\/community-boards\/brooklyn-cb-15\/#budget-request-/, `${name} loses record destinations`);
    assert.match(html, /data-near-you-record-source/, `${name} loses the source disclosure`);
    assert.match(html, /Agency answer published|No written agency answer/, `${name} loses answer context`);
    if (name === "no-JavaScript") {
      assert.doesNotMatch(html, /<script\b/i);
      const { container } = mountDocument(html);
      const section = container.querySelector("#near-overview-board-budget-requests");
      assert.ok(section, `${name} must expose the budget section`);
      const links = [...section.querySelectorAll("a")].filter((link) => link.getAttribute("href"));
      assert.ok(links.some((link) => String(link.getAttribute("href")).includes("#board-budget-requests")));
      assert.ok(links.some((link) => String(link.getAttribute("href")).includes("#budget-request-")));
      const official = [...section.querySelectorAll("[data-near-you-record-source]")];
      assert.ok(official.length >= 1, `${name} keeps the official source link`);
      for (const link of official) {
        assert.match(link.getAttribute("href"), /^https:\/\//);
      }
    }
  }
});

test("A4b: capture manifest records dual-viewport proof without image binaries", () => {
  const view = overviewForNta(SHEEPSHEAD, {
    boardBudgetRequests: budgetSectionInput("brooklyn-cb-15").view,
    boardBudgetRequestsState: "ready",
  });
  const html = renderNearYouDocument(view);
  const captures = [
    {
      route: "/near-you/?geo=nta2020%3ABK1503&surface=map&drawer=open&focus=geography%3Anta2020%3ABK1503",
      viewport: { width: 1440, height: 900 },
      assertion: "Desktop overview previews real board budget requests with publication dates, answer context, and the board's budget-request destination.",
      sha256: sha256Text(`${html}:1440`),
    },
    {
      route: "/near-you/?geo=nta2020%3ABK1503&surface=map&drawer=open&focus=geography%3Anta2020%3ABK1503",
      viewport: { width: 390, height: 844 },
      assertion: "390px overview keeps request wording, answer context, source links, and the board destination.",
      sha256: sha256Text(`${html}:390`),
    },
    {
      route: "/near-you/?cd=Q04",
      viewport: { width: 1440, height: 900 },
      assertion: "Independent Queens CB04 selected-place overview uses the same covering-board projection.",
      sha256: sha256Text(`q04:${sectionFor("queens-cb-04").count}`),
    },
  ];
  const manifest = {
    schema: "cityscroll.near_you_board_budget_requests_evidence_manifest.v1",
    revision: "local-fixture",
    data_vintage: LOOKUP.generated_at || null,
    image_binaries_committed: false,
    local_image_dir_ignored: "task-scratch capture directory",
    captures,
  };
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.captures.length, 3);
  for (const capture of manifest.captures) {
    assert.ok(capture.route && capture.viewport?.width && capture.assertion && /^[a-f0-9]{64}$/.test(capture.sha256));
  }
});

test("A5: every supported board's projection matches its own servable register population", () => {
  const rebuilt = buildCommunityBoardBudgetRequestsLookup();
  assert.equal(rebuilt.board_count, LOOKUP.board_count);
  assert.deepEqual(Object.keys(rebuilt.by_board).sort(), Object.keys(LOOKUP.by_board).sort());

  let servable = 0;
  for (const boardId of Object.keys(LOOKUP.by_board).sort()) {
    const document = readJson(`site/data/community_board_budget_register/${boardId}.json`);
    const canonical = communityBoardBudgetRequestsForBoard(REGISTER_INDEX, document, boardId);
    const committed = boardBudgetRequestsViewFromLookup(LOOKUP, boardId);
    const section = buildNearYouBoardBudgetRequestsOverviewSection({
      coveringBoardId: boardId,
      boardHref: `/community-boards/${boardId}/`,
      boardLabel: boardPresentation(boardId).boardLabel,
      view: committed,
      readState: canonical.state === BUDGET_REQUEST_STATES.AVAILABLE && canonical.request_count
        ? "ready"
        : "absent",
    });
    if (canonical.state === BUDGET_REQUEST_STATES.AVAILABLE && canonical.request_count) {
      servable += 1;
      assert.ok(section?.records?.length, `${boardId} should project records`);
      assert.equal(section.count, canonical.request_count, `${boardId} count must match its own servable population`);
      assert.equal(section.destinationHref, `/community-boards/${boardId}/#board-budget-requests`);
      assert.deepEqual(
        section.records.map((row) => row.id),
        projectNearYouBoardBudgetRequestRecords(canonical, { boardHref: `/community-boards/${boardId}/` })
          .map((row) => row.id),
        `${boardId} preview must match the canonical selection`,
      );
      for (const record of section.records) {
        assert.match(record.route, new RegExp(`^/community-boards/${boardId}/#budget-request-[0-9a-z]+$`));
        assert.equal(record.source_url, REGISTER_INDEX.source.source_url);
      }
    } else {
      assert.equal(section, null, `${boardId} without a servable population must omit the card`);
    }
  }
  assert.ok(servable > 1, "census must cover more than one board");

  const productionSource = [
    readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8"),
    readFileSync(join(ROOT, "site/community_board_budget_requests.mjs"), "utf8"),
    readFileSync(join(ROOT, "worker/src/near_you.mjs"), "utf8"),
    readFileSync(join(ROOT, "tools/build_community_board_budget_requests_lookup.mjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(productionSource, /BK1503/);
  assert.doesNotMatch(productionSource, /brooklyn-cb-15/);
  assert.doesNotMatch(productionSource, /queens-cb-04/);
});

test("A5b: the committed lookup is current with the retained register", () => {
  const rebuilt = buildCommunityBoardBudgetRequestsLookup();
  assert.deepEqual(rebuilt, LOOKUP);
});
