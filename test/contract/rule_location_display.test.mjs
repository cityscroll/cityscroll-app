import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../../site/index.html", import.meta.url), "utf8");

test("Rules lens joins Public Hearings through hearing normalization before display", () => {
  assert.match(
    html,
    /tools\.isRuleHearing\(row\)\s*\?\s*normalizeHearingRow\(row\)\.affected_area/,
  );
  assert.match(html, /row\._ruleLocation=tools\.ruleLocationFromRow\(row,\{hearingArea\}\)/);
  assert.match(html, /key==="rules"\?rulePlaceChips\(r\._ruleLocation\)/);
});
