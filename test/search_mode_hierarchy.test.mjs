import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SITE_SOURCE } from "./helpers/site_source.mjs";

const indexSource = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("exact list search is primary and Ask CityScroll is a disclosed secondary mode", () => {
  assert.match(
    indexSource,
    /<div class="lens-toolbar money-toolbar">[\s\S]*?<details class="nlbox ask-cityscroll" data-ask-lens="money">/,
    "Contracts should place its exact-search toolbar before the secondary Ask disclosure",
  );
  assert.match(
    SITE_SOURCE,
    /Ask CityScroll/,
    "the secondary mode should use a concise, named action",
  );
  assert.match(
    SITE_SOURCE,
    /Interprets your request/,
    "adjacent context should explain that the secondary mode interprets the request",
  );
  assert.match(
    SITE_SOURCE,
    /document\.createElement\("details"\)/,
    "dynamically mounted Ask controls should use the same disclosure hierarchy",
  );
  assert.match(
    SITE_SOURCE,
    /context\.insertAdjacentElement\("afterend", tools\)/,
    "current-scope status and actions should remain visible outside the collapsed Ask mode",
  );
});

test("a conventional query visibly takes over from an interpreted request", () => {
  assert.match(SITE_SOURCE, /function deactivateAskSearch\(lens\)/);
  assert.match(SITE_SOURCE, /input\.value=""/);
  assert.match(SITE_SOURCE, /askPanel\(lens\)\?\.removeAttribute\("open"\)/);
  assert.match(
    SITE_SOURCE,
    /moneyNlResolved=\{\}/,
    "Contracts must not retain hidden Ask-only constraints after exact search takes over",
  );
  assert.match(
    SITE_SOURCE,
    /exactSearchSelectors[\s\S]*addEventListener\("input",\(\)=>deactivateAskSearch\(lens\)/,
    "typing in an exact-search input should deactivate the interpreted request",
  );
});
