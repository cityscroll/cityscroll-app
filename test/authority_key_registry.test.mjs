import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_KEY_REGISTRY_VERSION,
  authorityKeyId,
  authorityKeysForSide,
  parseAuthorityKey,
} from "../entity_resolution/authority_keys/index.mjs";
import { extractFeatures } from "../entity_resolution/features/index.mjs";
import { scorePair } from "../entity_resolution/matchers/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(
  ROOT,
  "entity_resolution/eval/fixtures/authority_key_pin_epin_v1.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

test("PIN and EPIN parser fixtures produce structured scoped authority keys", () => {
  assert.equal(AUTHORITY_KEY_REGISTRY_VERSION, fixture.version);
  for (const row of fixture.valid) {
    assert.deepEqual(
      parseAuthorityKey(row.field, row.value, row.context),
      row.expected,
      row.name,
    );
  }
  for (const row of fixture.invalid) {
    assert.equal(parseAuthorityKey(row.field, row.value), null, row.name);
  }
});

test("PIN and EPIN aliases share a key only under the same issuer and scope", () => {
  const pin = authorityKeysForSide({ attrs: { pin: "84124P0003001" } });
  const epin = authorityKeysForSide({ attrs: { epin: "841-24-P0003-001" } });
  assert.equal(pin.length, 1);
  assert.equal(authorityKeyId(pin[0]), authorityKeyId(epin[0]));

  const otherIssuer = authorityKeysForSide({
    attrs: {
      pin: "84124P0003001",
      pin_issuing_authority: "071",
    },
  });
  const otherScope = authorityKeysForSide({
    attrs: {
      pin: "84124P0003001",
      pin_scope: "nyc:capital-planning",
    },
  });
  assert.notEqual(authorityKeyId(pin[0]), authorityKeyId(otherIssuer[0]));
  assert.notEqual(authorityKeyId(pin[0]), authorityKeyId(otherScope[0]));
});

test("matcher gives scoped PIN/EPIN agreement high weight without cross-scheme joins", () => {
  const left = {
    display_name: "Bridge design services",
    attrs: { pin: "84124P0003001" },
  };
  const matching = {
    display_name: "Unrelated registration title",
    attrs: { epin: "84124P0003001" },
  };
  const wrongScheme = {
    display_name: "Bridge design services",
    attrs: {
      authority_keys: [{
        scheme: "state_contract_number",
        issuing_authority: "841",
        value: "84124P0003001",
        scope: "nyc_procurement",
      }],
    },
  };
  const wrongScope = {
    display_name: "Bridge design services",
    attrs: {
      epin: "84124P0003001",
      epin_scope: "nyc:capital-planning",
    },
  };

  const matchFeatures = extractFeatures(left, matching, { entityType: "procurement" });
  assert.equal(matchFeatures.authority_key_equal, true);
  assert.equal(scorePair(left, matching, matchFeatures).decision, "same");

  for (const right of [wrongScheme, wrongScope]) {
    const features = extractFeatures(left, right, { entityType: "procurement" });
    assert.equal(features.authority_key_equal, false);
    assert.notEqual(scorePair(left, right, features).decision, "same");
  }
});
