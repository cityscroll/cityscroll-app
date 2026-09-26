/**
 * Land neighborhood watch scope — roundtrip, wire aliases, and save admission.
 *
 * verify: node --test test/land_nta_watch_scope.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_WATCH_DIMENSION_KEYS,
  LAND_WATCH_WIRE_ALIASES,
  landGeographyArtifactState,
  landNtaWatchBroadeningFindings,
  landNtaWatchCoverageDisclosure,
  landNtaWatchMatchingIds,
  landSemanticScopeFromWatchFilter,
  landWatchWireFilterFromSemantic,
  normalizeLandWatchFilterInput,
  prepareLandNtaWatchFilter,
} from "../site/land_nta_watch_scope.mjs";
import {
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landSemanticScopeFromState,
  landSnapshotQueryFromState,
} from "../site/land_filter_parity.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { landProjectRowsFromPayload } from "../site/land_project_catalog.mjs";
import {
  scopeFromGeographyWatch,
  scopeWithGeographies,
  watchFromGeographyScope,
} from "../site/scope_v0.mjs";
import { prepareWatchFilter, sanitize } from "../worker/src/lib/filter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-09-26";

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

const catalog = readJson("site/data/land_project_catalog.json");
const membership = readJson("site/data/land_place_membership.json");
const catalogRows = landProjectRowsFromPayload(catalog);

const NTA = Object.freeze({
  SI0105: "geography:nta2020:SI0105",
  MN0401: "geography:nta2020:MN0401",
});

describe("land NTA watch scope aliases and roundtrip", () => {
  it("A4 inventories every reachesWatchScope dimension with an explicit wire alias", () => {
    assert.deepEqual(
      [...LAND_WATCH_DIMENSION_KEYS].sort(),
      [
        "borough",
        "communityDistrict",
        "councilDistrict",
        "family",
        "filingEvidence",
        "futureAction",
        "geographies",
        "keyword",
        "procedure",
        "regulatoryEffect",
        "stage",
        "status",
      ],
    );
    for (const key of LAND_WATCH_DIMENSION_KEYS) {
      assert.ok(LAND_WATCH_WIRE_ALIASES[key], `missing wire alias for ${key}`);
    }
  });

  it("A4 reconciles borough/boro, keyword/keywords/q, future/futureAction, and geo aliases", () => {
    const normalized = normalizeLandWatchFilterInput({
      boro: "Staten Island",
      q: "Victory",
      future: "hearing",
      geo: [NTA.SI0105],
      stage: "public_review",
      filingEvidence: "required",
    });
    assert.equal(normalized.borough, "Staten Island");
    assert.equal(normalized.keyword, "Victory");
    assert.equal(normalized.futureAction, "hearing");
    assert.deepEqual(normalized.geographies, [NTA.SI0105]);
    assert.equal(normalized.stage, "public_review");
    assert.equal(normalized.filingEvidence, "required");

    const wire = landWatchWireFilterFromSemantic(normalized);
    assert.equal(wire.boro, "Staten Island");
    assert.deepEqual(wire.keywords, ["victory"]);
    assert.equal(wire.futureAction, "hearing");
    assert.deepEqual(wire.geographies, [NTA.SI0105]);
    assert.equal("borough" in wire, false);
    assert.equal("keyword" in wire, false);
    assert.equal("limit" in wire, false);
    assert.equal("projectIds" in wire, false);
  });

  it("A4 round-trips Land semantic scope through geography watch helpers", () => {
    const state = landFilterStateFromRouteParams(
      `#land?status=all&stage=public_review&boro=Staten Island&geo=${encodeURIComponent(NTA.SI0105)}`,
    );
    const semantic = landSemanticScopeFromState(state);
    const wire = landWatchWireFilterFromSemantic(semantic);
    const prepared = prepareWatchFilter("land", wire);
    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.filter.geographies, [NTA.SI0105]);
    assert.equal(prepared.filter.boro, "Staten Island");
    assert.equal(prepared.filter.stage, "public_review");
    assert.equal(prepared.filter.status, "all");

    const scope = scopeWithGeographies(
      { facets: { domains: ["land"], values: { ...prepared.filter } }, place: {} },
      prepared.filter.geographies,
    );
    const watch = watchFromGeographyScope(scope, { lens: "land" });
    assert.deepEqual(watch.filter.geographies, [NTA.SI0105]);
    const restored = scopeFromGeographyWatch(watch);
    assert.deepEqual(restored.place.geographies, [NTA.SI0105]);

    const back = landSemanticScopeFromWatchFilter(prepared.filter);
    assert.equal(back.stage, "public_review");
    assert.equal(back.borough, "Staten Island");
    assert.deepEqual(back.geographies, [NTA.SI0105]);
  });

  it("A4 refuses address/projectIds narrowing with an explicit correction instead of dropping it", () => {
    const refused = prepareLandNtaWatchFilter({
      geographies: [NTA.SI0105],
      projectIds: ["2026R0127"],
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "land-address-narrowing-present");
    assert.equal(refused.correction, "clear_address_narrowing");

    const viaPrepare = prepareWatchFilter("land", {
      geographies: [NTA.SI0105],
      projectIds: ["2026R0127"],
    });
    assert.equal(viaPrepare.ok, false);
    assert.equal(viaPrepare.reason, "land-address-narrowing-present");
    assert.equal(viaPrepare.correction, "clear_address_narrowing");
  });

  it("A4 refuses invalid geography intent that would otherwise sanitize into a citywide land watch", () => {
    const refused = prepareLandNtaWatchFilter({
      geographies: ["not-a-geography", "geography:nta2020:ZZ9999"],
      stage: "active",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "land-geography-invalid");
    assert.equal(refused.correction, "choose_valid_neighborhood");

    // sanitize alone would drop the bad keys and broaden — admission must refuse first.
    const dropped = sanitize("land", { geographies: ["not-a-geography"] });
    assert.equal("geographies" in dropped, false);
  });

  it("A4 never persists a display limit as a membership filter field", () => {
    const prepared = prepareLandNtaWatchFilter({
      geographies: [NTA.SI0105],
      limit: 40,
      stage: "any",
      status: "all",
    });
    assert.equal(prepared.ok, true);
    assert.equal("limit" in prepared.filter, false);
    const sanitized = sanitize("land", prepared.filter);
    assert.equal("limit" in sanitized, false);
  });
});

describe("land NTA watch matching against retained catalog evidence", () => {
  it("A1/A5 SI0105 geography-only matching equals browse pre-limit IDs and includes 2026R0127", () => {
    const filter = { status: "all", stage: "any", geographies: [NTA.SI0105] };
    const browseState = landFilterStateFromRouteParams(
      `#land?status=all&stage=any&geo=${encodeURIComponent(NTA.SI0105)}`,
    );
    const browseQuery = landSnapshotQueryFromState(browseState, {
      today: TODAY,
      placeMembership: membership,
      limit: catalogRows.length,
    });
    const browseIds = landCanonicalIds(filterLandSnapshot(catalogRows, browseQuery));

    const match = landNtaWatchMatchingIds({
      filter,
      catalogRows,
      placeMembership: membership,
      source: "browse",
      today: TODAY,
    });
    assert.equal(match.status, "ready");
    assert.deepEqual([...match.ids], browseIds);
    assert.ok(match.ids.includes("2026R0127"));
    assert.equal(match.ids.includes("2025M0252"), false);
    assert.equal(match.ids.includes("2022Y0395"), false);
  });

  it("A5 exercises every required watch dimension alone and with geographies", () => {
    const cases = [
      { status: "all" },
      { stage: "public_review", status: "all" },
      { futureAction: "hearing", status: "all" },
      { procedure: "ulurp", status: "all" },
      { family: "rezoning", status: "all" },
      { regulatoryEffect: "upzone", status: "all" },
      { filingEvidence: "required", status: "all" },
      { borough: "Manhattan", status: "all" },
      { communityDistrict: "M04", status: "all" },
      { councilDistrict: "3", status: "all" },
      { keyword: "park", status: "all" },
    ];

    for (const facet of cases) {
      const alone = landNtaWatchMatchingIds({
        filter: facet,
        catalogRows,
        placeMembership: membership,
        source: "browse",
        today: TODAY,
      });
      assert.equal(alone.status, "ready", `alone ${JSON.stringify(facet)}`);
      assert.ok(Array.isArray(alone.ids));

      const withGeo = landNtaWatchMatchingIds({
        filter: { ...facet, geographies: [NTA.MN0401] },
        catalogRows,
        placeMembership: membership,
        source: "browse",
        today: TODAY,
      });
      assert.equal(withGeo.status, "ready", `with geo ${JSON.stringify(facet)}`);
      for (const id of withGeo.ids) {
        assert.ok(
          (membership.by_geography?.nta2020?.MN0401 || []).includes(id),
          `${id} must stay inside MN0401 membership for ${JSON.stringify(facet)}`,
        );
      }
    }
  });

  it("A5 stage + filingEvidence + geography together asserts against retained catalog membership", () => {
    const filter = {
      status: "all",
      stage: "any",
      filingEvidence: "required",
      geographies: [NTA.MN0401],
    };
    const match = landNtaWatchMatchingIds({
      filter,
      catalogRows,
      placeMembership: membership,
      source: "browse",
      today: TODAY,
    });
    assert.equal(match.status, "ready");
    const members = new Set(membership.by_geography?.nta2020?.MN0401 || []);
    for (const id of match.ids) assert.ok(members.has(id));

    // Independent oracle: membership ∩ filingEvidence via filterLandSnapshot, no shared helper.
    const oracle = landCanonicalIds(filterLandSnapshot(catalogRows, {
      status: "all",
      stage: "any",
      filingEvidence: "required",
      geographies: [NTA.MN0401],
      placeMembership: membership,
      limit: catalogRows.length,
    }));
    assert.deepEqual([...match.ids], oracle);
  });

  it("A2 unknown NTA keys do not broaden; partial coverage is bounded disclosure", () => {
    const refused = prepareLandNtaWatchFilter({ geographies: ["geography:nta2020:SI9999"] });
    // Valid key shape is admitted; matching yields empty membership, never citywide.
    assert.equal(refused.ok, true);
    const match = landNtaWatchMatchingIds({
      filter: refused.filter,
      catalogRows,
      placeMembership: membership,
      source: "browse",
      today: TODAY,
    });
    assert.equal(match.status, "ready");
    assert.deepEqual([...match.ids], []);

    const disclosure = landNtaWatchCoverageDisclosure({
      association_kind: "published_project_lot",
      spatially_matched: 233,
      admitted: 244,
      partially_covered: 22,
    });
    assert.equal(disclosure.assurance, "matched_published_lots_only");
    assert.equal(disclosure.bounded_to_matched_lots, true);
    assert.equal(disclosure.monitoring, "published_project_lot_membership");
  });

  it("A3 missing geography artifact is unavailable, not a successful empty membership", () => {
    assert.equal(landGeographyArtifactState(null).status, "unavailable");
    assert.equal(landGeographyArtifactState({}).status, "unavailable");
    assert.equal(landGeographyArtifactState({ geography_items: { by_key: {} } }).status, "unavailable");
    assert.equal(
      landGeographyArtifactState({
        geography_items: {
          by_key: {},
          coverage: { by_lens: { land: { status: "unavailable" } } },
        },
      }).status,
      "unavailable",
    );
  });

  it("A2/A3 positive control: broadening detector reports an injected out-of-area id", () => {
    const filter = { status: "all", stage: "any", geographies: [NTA.SI0105] };
    const clean = landNtaWatchBroadeningFindings({
      filter,
      deliveredIds: ["2026R0127"],
      catalogRows,
      placeMembership: membership,
    });
    assert.deepEqual([...clean], []);

    const polluted = landNtaWatchBroadeningFindings({
      filter,
      deliveredIds: ["2026R0127", "2022Y0395"],
      catalogRows,
      placeMembership: membership,
    });
    assert.ok(polluted.some((line) => line.includes("2022Y0395")));
  });
});
