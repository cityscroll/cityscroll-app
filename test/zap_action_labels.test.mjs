/**
 * Land detail action chips: label known ZAP codes, leave unknowns raw.
 *
 * SPARC Kips Bay 2024M0158 must not print a bare "PP". Display only —
 * family mapping stays in land_use_action_type.mjs.
 * Verify: node --test test/zap_action_labels.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  UNLABELED_ZAP_ACTION_CODES,
  ZAP_ACTION_LABEL_KEYS,
  zapActionDisplayLabels,
} from "../site/zap_action_labels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test/fixtures/land_use_action_type");
const EN = {
  zapact_zm: "Zoning map amendment",
  zapact_zr: "Zoning text amendment",
  zapact_za: "Authorization",
  zapact_zc: "Certification",
  zapact_zs: "Special permit",
  zapact_ha: "Disposition (HPD)",
  zapact_pc: "Acquisition",
  zapact_hg: "Urban renewal",
  zapact_pp: "Disposition",
  zapact_ps: "Site selection",
  zapact_mm: "City map amendment",
  zapact_dm: "Demapping",
  zapact_hi: "Landmark designation",
};
const t = (key) => EN[key] || key;

test("PP, PS, and MM have zapact_ display keys", () => {
  assert.equal(ZAP_ACTION_LABEL_KEYS.PP, "zapact_pp");
  assert.equal(ZAP_ACTION_LABEL_KEYS.PS, "zapact_ps");
  assert.equal(ZAP_ACTION_LABEL_KEYS.MM, "zapact_mm");
  assert.deepEqual(zapActionDisplayLabels("PP; PS; MM", t), [
    "Disposition",
    "Site selection",
    "City map amendment",
  ]);
});

test("SPARC 2024M0158 detail chips label PP instead of printing the raw code", () => {
  const sparc = JSON.parse(readFileSync(join(FIXTURES, "2024M0158.json"), "utf8"));
  const labels = zapActionDisplayLabels(sparc.open_data.actions, t);
  assert.ok(labels.includes("Disposition"), "PP must render as Disposition");
  assert.ok(labels.includes("Zoning map amendment"));
  assert.ok(labels.includes("Zoning text amendment"));
  assert.ok(labels.includes("Special permit"));
  assert.ok(labels.includes("Acquisition"));
  assert.ok(
    labels.every((label) => label !== "PP"),
    `SPARC must not print raw PP: ${labels.join(" · ")}`,
  );
});

test("remaining mapped codes HI, LD, and DM are labeled", () => {
  assert.equal(ZAP_ACTION_LABEL_KEYS.HI, "zapact_hi");
  assert.equal(ZAP_ACTION_LABEL_KEYS.LD, "zapact_hi");
  assert.equal(ZAP_ACTION_LABEL_KEYS.DM, "zapact_dm");
  assert.deepEqual(zapActionDisplayLabels("HI; LD; DM", t), [
    "Landmark designation",
    "Landmark designation",
    "Demapping",
  ]);
});

test("unknown codes stay unlabeled and are not forced into rezoning", () => {
  for (const code of UNLABELED_ZAP_ACTION_CODES) {
    assert.equal(
      ZAP_ACTION_LABEL_KEYS[code],
      undefined,
      `${code} must not have a zapact_ label`,
    );
  }
  assert.deepEqual(
    UNLABELED_ZAP_ACTION_CODES,
    ["CM", "HU", "UK", "EAS", "RA", "RC", "RS"],
  );
  const labels = zapActionDisplayLabels("CM; HU; UK; EAS; RA; RC; RS", t);
  assert.deepEqual(labels, ["CM", "HU", "UK", "EAS", "RA", "RC", "RS"]);
  assert.ok(labels.every((label) => label !== "Zoning map amendment"));
});

test("English catalog ships the new zapact_ strings", () => {
  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  assert.match(i18n, /zapact_pp:\s*"Disposition"/);
  assert.match(i18n, /zapact_ps:\s*"Site selection"/);
  assert.match(i18n, /zapact_mm:\s*"City map amendment"/);
  assert.match(i18n, /zapact_dm:\s*"Demapping"/);
  assert.match(i18n, /zapact_hi:\s*"Landmark designation"/);
  assert.doesNotMatch(i18n, /zapact_cm:/);
});

test("land detail uses the shared action-label helper", () => {
  const landSrc = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
  assert.match(landSrc, /zapActionDisplayLabels/);
  assert.doesNotMatch(
    landSrc,
    /const ZAPACT_KEY=\{ZM:"zapact_zm"/,
    "partial inline ZAPACT_KEY must not remain in landSelect",
  );
});
