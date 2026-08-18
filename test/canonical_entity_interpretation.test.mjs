import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

import {
  extractReviewedAgencyFromText,
  installAgencyPhraseInterpreter,
  interpretEntityPhrase,
  reviewedAgencyPhrase,
} from "../site/canonical_entity_interpretation.mjs";
import {
  canonicalAgency,
  resolveAgencyIdentity,
} from "../site/agency_identity.mjs";
import {
  agencyCanonicalId as erAgencyId,
  canonicalAgency as erCanonicalAgency,
} from "../entity_resolution/normalizers/agency.mjs";

const require = createRequire(import.meta.url);
const { parseNL, extractAgency, NL_AGENCY_ALIASES } = require("../site/nl_parse.js");

const ALIAS_REGISTRY = JSON.parse(readFileSync(
  new URL("../entity_resolution/review/alias_registry.json", import.meta.url),
  "utf8",
));

test("dot-style acronyms resolve through reviewed identity, not the NL alias list", () => {
  const hit = interpretEntityPhrase("dot");
  assert.equal(hit.status, "resolved");
  assert.equal(hit.kind, "agency");
  assert.equal(hit.canonical_name, "Transportation");
  assert.equal(hit.canonical_id, "transportation");
  assert.equal(hit.subject_ref, "agency:id:transportation");
  assert.equal(hit.method.startsWith("reviewed_agency_"), true);
  assert.equal(erAgencyId(hit.canonical_name), hit.canonical_id);
  assert.equal(erCanonicalAgency("Department of Transportation").canonical_id, hit.canonical_id);
  assert.equal(canonicalAgency("Department of Transportation").canonical_id, hit.canonical_id);
});

test("housing department derives from the reviewed HPD group", () => {
  const hit = interpretEntityPhrase("housing department");
  assert.equal(hit.status, "resolved");
  assert.equal(hit.canonical_name, "Housing Preservation and Development");
  assert.equal(hit.canonical_id, "housing-preservation-and-development");
  assert.equal(hit.subject_ref, "agency:id:housing-preservation-and-development");
  assert.equal(resolveAgencyIdentity(hit.canonical_name).matched, true);
});

test("unresolved phrasing stays text and never mints agency:id", () => {
  const phrase = "the civic bureau of madeup";
  const invented = canonicalAgency(phrase);
  assert.equal(resolveAgencyIdentity(phrase).matched, false);
  assert.ok(invented.canonical_id, "canonicalAgency still slugs unmatched input");

  const hit = interpretEntityPhrase(phrase);
  assert.equal(hit.status, "unresolved");
  assert.equal(hit.text, phrase);
  assert.equal(hit.subject_ref, null);
  assert.equal(hit.canonical_id, null);
  assert.equal(hit.kind, null);
  assert.notEqual(hit.canonical_id, invented.canonical_id);
});

test("NL-only informal aliases are not promoted into graph identity", () => {
  const nlOnly = NL_AGENCY_ALIASES
    .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ canonical, alias })))
    .find((row) => row.alias === "schools department");
  assert.ok(nlOnly, "expected NL_AGENCY_ALIASES to still list schools department");
  assert.equal(nlOnly.canonical, "Education");
  assert.equal(reviewedAgencyPhrase("schools department"), null);
  assert.equal(interpretEntityPhrase("schools department").status, "unresolved");
  assert.equal(interpretEntityPhrase("schools department").subject_ref, null);
});

test("sentence scan finds reviewed acronyms and department phrases", () => {
  assert.equal(extractReviewedAgencyFromText("email me about DOT contracts").canonical_name, "Transportation");
  assert.equal(
    extractReviewedAgencyFromText("housing department awards over $1M").canonical_name,
    "Housing Preservation and Development",
  );
  assert.equal(extractReviewedAgencyFromText("no agency is named here").status, "unresolved");
});

test("parseNL uses the reviewed interpreter when installed and keeps the script fallback otherwise", () => {
  assert.equal(parseNL("email me about DOT contracts").agency, "Transportation");
  assert.equal(parseNL("housing department contracts").agency, null, "fallback list does not invent housing department");

  const prior = globalThis.CrolInterpretAgencyPhrase;
  installAgencyPhraseInterpreter(globalThis);
  try {
    assert.equal(extractAgency("housing department contracts"), "Housing Preservation and Development");
    assert.equal(parseNL("housing department contracts").agency, "Housing Preservation and Development");
    assert.equal(parseNL("email me about DOT contracts").agency, "Transportation");
    assert.equal(parseNL("the civic bureau of madeup").agency, null);
  } finally {
    globalThis.CrolInterpretAgencyPhrase = prior;
  }
});

test("reviewed vendor aliases resolve by exact unique display name without minting an agency id", () => {
  const hit = interpretEntityPhrase("Think Leadership Center", { aliasRegistry: ALIAS_REGISTRY });
  assert.equal(hit.status, "resolved");
  assert.equal(hit.kind, "vendor");
  assert.equal(hit.canonical_name, "Think Leadership Center");
  assert.equal(hit.subject_ref, null);
  assert.equal(hit.canonical_id, null);
  assert.equal(hit.method, "reviewed_vendor_alias");
});
