import { SITE_SOURCE } from "../helpers/site_source.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = SITE_SOURCE;

test("Rules lens joins Public Hearings through hearing normalization before display", () => {
  assert.match(
    html,
    /tools\.isRuleHearing\(row\)\s*\?\s*normalizeHearingRow\(row\)\.affected_area/,
  );
  assert.match(html, /row\._ruleLocation=tools\.ruleLocationFromRow\(row,\{hearingArea\}\)/);
  assert.match(html, /key==="rules"\?rulePlaceChips\(r\._ruleLocation\)/);
});
