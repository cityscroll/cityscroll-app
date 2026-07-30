import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { affectedAreaFromRow } from "../../worker/src/lib/hearings.mjs";
import { ruleLocationFromRow } from "../../site/rule_location.mjs";

const hearingFixtures = JSON.parse(await readFile(
  new URL("./fixtures/hearings.json", import.meta.url),
  "utf8",
));

test("Agency Rules hearings use affected area from the hearing machinery", () => {
  const row = hearingFixtures[2].row;
  assert.equal(row.section_name, "Agency Rules");
  const hearingArea = affectedAreaFromRow(row);
  const location = ruleLocationFromRow(row, { hearingArea });
  assert.equal(location.source, "hearing");
  assert.deepEqual(location.boroughs, hearingArea.boroughs);
  assert.equal(location.scope, "citywide");
});

test("genuinely district-scoped rules identify the named district", () => {
  const location = ruleLocationFromRow({
    type_of_notice_description: "Notice",
    short_title: "Extension of the Fulton Street business improvement district",
    additional_description_1: "This rule modifies the boundaries of the Fulton Street business improvement district and changes its district charge.",
  });
  assert.equal(location.scope, "local");
  assert.deepEqual(location.districts, ["Fulton Street business improvement district"]);
});

test("a hearing venue does not narrow an otherwise citywide rule", () => {
  const location = ruleLocationFromRow({
    type_of_notice_description: "Notice",
    short_title: "Elevator inspection rules",
    additional_description_1: "The Department will accept comments at 280 Broadway in Manhattan. The rule updates elevator inspections.",
  });
  assert.equal(location.scope, "citywide");
  assert.deepEqual(location.boroughs, []);
  assert.deepEqual(location.districts, []);
});

test("an explicit borough limitation is local rather than citywide", () => {
  const location = ruleLocationFromRow({
    type_of_notice_description: "Notice",
    short_title: "Commercial loading rule",
    additional_description_1: "This rule applies only within the Borough of the Bronx.",
  });
  assert.equal(location.scope, "local");
  assert.deepEqual(location.boroughs, ["Bronx"]);
});
