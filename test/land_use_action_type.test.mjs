/**
 * Bundled NYC land-use actions keep families[] first-class.
 *
 * SPARC Kips Bay 2024M0158 (ZM+ZS+ZR+PP+PC+PQ) and HPD UDAAP 2022X0393
 * (ZS+ZC+LD+HA+ZA) must not collapse into a single rezoning / special-permit
 * box. Verify: node --test test/land_use_action_type.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  LAND_USE_ACTION_CODE_FAMILY,
  LAND_USE_FAMILY_LABEL_KEY,
  landParticipationGuideHeadingKey,
  landParticipationStepsMissingKey,
  normalizeLandUseActionType,
} from "../site/land_use_action_type.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test/fixtures/land_use_action_type");

function loadFixture(id) {
  return JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8"));
}

test("SPARC 2024M0158 keeps PP/PC/PQ and disposition+acquisition families", () => {
  const sparc = loadFixture("2024M0158");
  const type = normalizeLandUseActionType(sparc);

  assert.ok(type.codes.includes("PP"), "PP disposition code must be retained");
  assert.ok(type.codes.includes("PC"), "PC acquisition code must be retained");
  assert.ok(type.codes.includes("PQ"), "PQ acquisition code must be retained");
  assert.ok(type.codes.includes("ZM"));
  assert.ok(type.codes.includes("ZR"));
  assert.ok(type.codes.includes("ZS"));

  assert.ok(type.families.includes("disposition"), "PP must map into disposition");
  assert.ok(type.families.includes("acquisition"), "PC/PQ must remain acquisition");
  assert.ok(type.families.includes("rezoning"));
  assert.ok(type.families.includes("special_permit"));

  assert.notEqual(
    type.primary,
    "rezoning",
    "rezoning must not win over bundled disposition/acquisition",
  );
  assert.ok(
    type.families.length > 1,
    "bundled control actions stay visible on families[]",
  );
});

test("SPARC 2024M0158 participation copy is not rezoning-only", () => {
  const sparc = loadFixture("2024M0158");
  assert.notEqual(
    landParticipationGuideHeadingKey(sparc),
    "land_guide_heading_rezoning",
  );
  assert.equal(landParticipationGuideHeadingKey(sparc), "land_guide_heading");
  assert.notEqual(
    landParticipationStepsMissingKey(sparc),
    "next_action_land_steps_missing_rezoning",
  );
});

test("2022X0393 HPD UDAAP keeps City disposition beside special permit", () => {
  const hpd = loadFixture("2022X0393");
  const type = normalizeLandUseActionType(hpd);

  assert.ok(type.codes.includes("HA"));
  assert.ok(type.codes.includes("ZS"));
  assert.ok(type.families.includes("disposition"), "HA UDAAP disposition must stay");
  assert.ok(type.families.includes("special_permit"));
  assert.ok(type.families.includes("authorization"));
  assert.ok(type.families.includes("certification"));
  assert.ok(
    type.families.length > 1,
    "City disposition must not be erased by special_permit primary",
  );
  assert.notEqual(
    type.primary,
    "special_permit",
    "a single sibling must not become the public ontology",
  );
});

test("bundled ZM+disposition heading is not this-rezoning", () => {
  const bundled = { actions: "ZM,PP", project_id: "FIXTURE-ZM-PP" };
  const type = normalizeLandUseActionType(bundled);
  assert.deepEqual(type.codes, ["ZM", "PP"]);
  assert.ok(type.families.includes("rezoning"));
  assert.ok(type.families.includes("disposition"));
  assert.equal(landParticipationGuideHeadingKey(bundled), "land_guide_heading");
});

test("glossary-backed DCP codes map; UK/EAS stay unmapped; no upzone/downzone family", () => {
  // Meanings from the DCP ZAP Projects data dictionary (Action Types, shared
  // string 252) and Land Use Application form §§6–13. South Richmond RA/RC/RS
  // fold into the base families; they must not hide behind a south_richmond family.
  const glossary = {
    ZM: "rezoning",
    ZR: "rezoning",
    ZS: "special_permit",
    RS: "special_permit",
    ZA: "authorization",
    RA: "authorization",
    ZC: "certification",
    RC: "certification",
    PQ: "acquisition",
    PC: "acquisition",
    PS: "site_selection",
    MM: "mapping",
    ME: "mapping",
    MD: "mapping",
    DM: "demapping",
    HA: "disposition",
    PP: "disposition",
    HN: "disposition",
    HD: "disposition",
    HG: "urban_renewal",
    HU: "urban_renewal",
    HC: "urban_renewal",
    HI: "landmark",
    HK: "landmark",
    LD: "legal_document",
    CM: "renewal",
    CS: "follow_up",
    PX: "office_space",
    BD: "bid",
    MC: "major_concession",
    GF: "franchise_consent",
    HO: "housing_plan",
    SG: "pops",
    ML: "landfill",
  };
  for (const [code, family] of Object.entries(glossary)) {
    assert.equal(
      LAND_USE_ACTION_CODE_FAMILY[code],
      family,
      `${code} must map to ${family}`,
    );
  }

  for (const code of ["UK", "EAS"]) {
    assert.equal(
      LAND_USE_ACTION_CODE_FAMILY[code],
      undefined,
      `${code} must stay unmapped`,
    );
  }

  const families = Object.values(LAND_USE_ACTION_CODE_FAMILY);
  assert.ok(!families.includes("upzone"));
  assert.ok(!families.includes("downzone"));
  assert.ok(!families.includes("south_richmond"));

  const newFamilyKeys = [
    "legal_document",
    "renewal",
    "follow_up",
    "office_space",
    "bid",
    "major_concession",
    "franchise_consent",
    "housing_plan",
    "pops",
    "landfill",
  ];
  for (const family of newFamilyKeys) {
    assert.equal(
      LAND_USE_FAMILY_LABEL_KEY[family],
      `land_use_family_${family}`,
      `${family} needs a family label key`,
    );
  }

  // 2025R0222 St. Joseph by the Sea — South Richmond RS/RC/RA plus an LD
  // legal document. LD must not paint this as a landmark.
  const southRichmond = normalizeLandUseActionType({
    project_id: "2025R0222",
    actions: "RS;RC;RA;LD",
  });
  assert.deepEqual(southRichmond.codes, ["RS", "RC", "RA", "LD"]);
  assert.ok(southRichmond.families.includes("special_permit"));
  assert.ok(southRichmond.families.includes("authorization"));
  assert.ok(southRichmond.families.includes("certification"));
  assert.ok(southRichmond.families.includes("legal_document"));
  assert.ok(!southRichmond.families.includes("landmark"));
  assert.notEqual(southRichmond.primary, "landmark");

  const ldOnly = normalizeLandUseActionType({ actions: "LD" });
  assert.deepEqual(ldOnly.families, ["legal_document"]);
  assert.equal(ldOnly.primary, "legal_document");
  assert.notEqual(ldOnly.primary, "landmark");

  const unknown = normalizeLandUseActionType({ actions: "UK,EAS" });
  assert.deepEqual(unknown.codes, ["UK", "EAS"]);
  assert.deepEqual(unknown.families, []);
  assert.equal(unknown.primary, "land_use");
});
