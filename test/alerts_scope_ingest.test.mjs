import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  alertsHref,
  parseAlertsEntryParams,
} from "../site/alerts_context_carry.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

function extractFunction(name) {
  let start = SITE_SOURCE.indexOf(`async function ${name}(`);
  if (start < 0) start = SITE_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let index = SITE_SOURCE.indexOf("{", start); index < SITE_SOURCE.length; index += 1) {
    if (SITE_SOURCE[index] === "{") {
      depth += 1;
      opened = true;
    } else if (SITE_SOURCE[index] === "}" && opened) {
      depth -= 1;
      if (depth === 0) return SITE_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

test("carried scope is applied before an optional notice lookup can delay it", () => {
  const fn = extractFunction("prefillAlertFromLink");
  const appliesScope = fn.indexOf("applyAlertScopeToBuilder");
  const waitsForNotice = fn.indexOf("await applyNoticeWatchSeed");
  assert.ok(appliesScope >= 0, "prefill should have one scope-to-builder seam");
  assert.ok(waitsForNotice < 0 || appliesScope < waitsForNotice,
    "known lens/filter scope must paint before the notice seed lookup");
  assert.match(fn, /CrolScope\.scopeFromWatch|adaptAlertEntryScope/,
    "prefill consumes the canonical adapter when PR 524 is present");
});

test("the main alert flow renders one keyword input, not two synchronized copies", () => {
  const tab = html.slice(html.indexOf('id="tab-alerts"'), html.indexOf('id="tab-notice"'));
  const keywordLabels = [...tab.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)]
    .map(([, control, label]) => ({
      control,
      label: label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase(),
    }))
    .filter(({ label }) => label.includes("keyword") && label.includes("optional"));
  assert.deepEqual(keywordLabels.map(({ control }) => control), ["quiznarrow"]);
  assert.doesNotMatch(tab, /id="amoneykw"/);
});

test("money refinements are honest-absent when the selected notice type cannot use them", () => {
  assert.match(html, /id="amoneyminbox"[^>]*hidden/);
  assert.match(html, /id="amoneymonthsbox"[^>]*hidden/);
  const sync = extractFunction("syncAlertConditionalFields");
  assert.match(sync, /noticeType\s*===\s*"solicitation"/);
  assert.match(sync, /noticeType\s*===\s*"award"/);
});

test("money context descriptions include carried agency and notice type", () => {
  const describe = extractFunction("aDescribe");
  assert.match(describe, /watch_scope_awards/);
  assert.match(describe, /watch_scope_solicitations/);
  assert.match(describe, /moneynlExtra/);
});

test("source-list result count travels as a receipt and is exposed by the preview", () => {
  const countHelper = new Function(
    "currentRows", "lRows", "feedRows",
    `${extractFunction("currentLensResultCount")}\nreturn currentLensResultCount;`,
  )(
    Array.from({ length: 17 }),
    Array.from({ length: 9 }),
    { property: Array.from({ length: 4 }) },
  );
  const sourceCount = countHelper("money");
  assert.equal(sourceCount, 17);
  const href = alertsHref({
    lens: "money",
    filter: { agency: "Homeless Services", noticeType: "award" },
  }, { matchCount: sourceCount, noticeId: "20260724018" });
  const parsed = parseAlertsEntryParams(href);
  assert.equal(parsed.matchCount, 17);
  assert.equal(parseAlertsEntryParams("#alerts?lens=money").matchCount, null,
    "an absent receipt must not become an invented zero-result count");
  assert.match(SITE_SOURCE, /currentLensResultCount/);
  assert.match(SITE_SOURCE, /alertEntryMatchCount/);
  assert.match(SITE_SOURCE, /data-scope-count/);
});

test("browse route facets remain visible in the active scope chip and watch handoff", () => {
  assert.match(SITE_SOURCE, /CROL_ACTIVE_SCOPE_FACET_VALUES/);
  assert.match(SITE_SOURCE, /active-scope-chip/);
  assert.match(SITE_SOURCE, /agencyFromRouteFacet/);
});
