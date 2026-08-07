import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  procurementLocationHref,
  procurementModeHref,
  PROCUREMENT_ACTION_LOCATION_KEYS,
  PROCUREMENT_MODE_KEYS,
} from "../site/procurement_facet_links.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope.mjs";
import { buildNearYouViewModel } from "../site/near_you_view.mjs";
import { buildContractActionBasisLayer } from "../tools/lib/district_activity.mjs";

const actionDoc = JSON.parse(readFileSync(
  new URL("../site/data/contract_action_address_locations.json", import.meta.url),
  "utf8",
));
const boundaries = JSON.parse(readFileSync(
  new URL("../site/data/district_boundaries.json", import.meta.url),
  "utf8",
));

test("procurement mode facets are exact, canonical, and shareable", () => {
  assert.deepEqual(PROCUREMENT_MODE_KEYS, ["open", "allrfp", "award"]);
  assert.deepEqual(
    PROCUREMENT_MODE_KEYS.map(procurementModeHref),
    [
      "/browse/contracts/?mode=open",
      "/browse/contracts/?mode=allrfp",
      "/browse/contracts/?mode=award",
    ],
  );
  assert.equal(procurementModeHref("unknown"), "");
});
test("response-location facets carry typed Near-you basis edges", () => {
  assert.deepEqual(
    PROCUREMENT_ACTION_LOCATION_KEYS.map(procurementLocationHref),
    [
      "/near-you/?v=0&lens=money&basis=contract_action_address&facet=%7B%22mode%22%3A%22allrfp%22%7D",
      "/near-you/?v=0&lens=money&basis=contract_action_address&facet=%7B%22mode%22%3A%22allrfp%22%2C%22actionBasis%22%3A%22submission_address%22%7D",
      "/near-you/?v=0&lens=money&basis=contract_action_address&facet=%7B%22mode%22%3A%22allrfp%22%2C%22actionBasis%22%3A%22pre_bid_venue%22%7D",
      "/near-you/?v=0&lens=money&basis=contract_action_address&facet=%7B%22mode%22%3A%22allrfp%22%2C%22actionBasis%22%3A%22document_pickup%22%7D",
    ],
  );
  assert.equal(procurementLocationHref("not-a-basis"), "");
  const parsed = scopeFromNearYouUrl(procurementLocationHref("pre_bid_venue"));
  assert.deepEqual(parsed.facets.domains, ["money"]);
  assert.equal(parsed.facets.values.basis, "contract_action_address");
  assert.equal(parsed.facets.values.actionBasis, "pre_bid_venue");
});

test("real response-location records remain separate exact basis joins", () => {
  const row = actionDoc.rows.find((candidate) => candidate.request_id === "20260723025");
  assert.ok(row, "characterization fixture must remain in the committed action-location corpus");
  assert.deepEqual(
    [...new Set(row.locations.map((location) => location.basis))].sort(),
    ["pre_bid_venue", "submission_address"],
  );
  const layer = buildContractActionBasisLayer([row], boundaries);
  assert.deepEqual(
    layer.records.money[row.request_id].basis_methods.sort(),
    ["pre_bid_venue", "submission_address"],
  );

  const activity = { basis_layers: { contract_action_address: layer } };
  for (const basis of ["submission_address", "pre_bid_venue"]) {
    const scope = scopeFromNearYouUrl(procurementLocationHref(basis));
    const view = buildNearYouViewModel(scope, activity, boundaries);
    assert.deepEqual(view.results.ids, [row.request_id], basis);
  }
  const unknown = scopeFromNearYouUrl(
    "/near-you/?v=0&lens=money&basis=contract_action_address&facet=%7B%22actionBasis%22%3A%22invented_basis%22%7D",
  );
  assert.equal(unknown.facets.values.actionBasis, "unknown");
  assert.equal(buildNearYouViewModel(unknown, activity, boundaries).results.count, 0);
});
