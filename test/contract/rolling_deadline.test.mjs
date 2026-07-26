// Contract test: the year-2090 "rolling deadline" honesty rule (see docs/drift-inventory.md #3,
// now fixed — this was the one documented one-way gap in the original inventory: the worker had
// it, the site didn't, so a live Solicitation with a placeholder due date rendered on the public
// site as something like "23,000+ days left" instead of an honest label). Both sides must now
// agree on WHICH due dates are rolling placeholders, and use the exact same wording for it.
//
//   node --test test/contract/rolling_deadline.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSite, extractFn } from "./site_extract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "test/contract/fixtures/rolling_deadline.json"), "utf8"));

// alerts.mjs imports npm packages (@jimdc/sendcap, optin-token) not available until worker/'s own
// `npm ci` step — extract dueLabel()'s source text directly, same approach site_extract.mjs uses
// for index.html, rather than importing the module and needing worker/node_modules here too.
const alertsSrc = readFileSync(join(ROOT, "worker/src/alerts.mjs"), "utf8");
const workerDueLabel = new Function(extractFn("dueLabel", alertsSrc) + "\nreturn dueLabel;")();

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

const { isRollingDeadline } = loadSite(["ROLLING_DUE_YEAR", "isRollingDeadline"]);

for (const { due, note } of fixtures) {
  test(`isRollingDeadline(${JSON.stringify(due)}) agrees with the worker's dueLabel() — ${note}`, () => {
    const siteRolling = isRollingDeadline(due);
    const workerLabel = workerDueLabel(due);
    const workerRolling = workerLabel === "no fixed deadline (rolling)";
    assert.equal(siteRolling, workerRolling, `site=${siteRolling} worker dueLabel()="${workerLabel}"`);
  });
}

test("the site's rolling-deadline tag text is byte-identical to the worker's dueLabel() phrase", () => {
  assert.equal(t("rolling_deadline_tag"), workerDueLabel("2099-01-01"));
});

test("about.html already promises this exact phrase to readers — the label must match it", () => {
  const about = readFileSync(join(ROOT, "about.html"), "utf8");
  assert.match(about, /no fixed deadline \(rolling\)/, "about.html's honesty-rule copy uses a different phrase than the shipped label");
  assert.equal(t("rolling_deadline_tag"), "no fixed deadline (rolling)");
});
