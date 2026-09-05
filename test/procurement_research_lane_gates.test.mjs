// procurement-pursuit-decision, card "PPD-07": the two research lanes beside
// this workstream are held behind the shipped product cards and behind
// explicit pre-registration. This card ships gates and honest copy, not
// research results.
//
// Acceptance criteria exercised here:
//   A1 neither lane begins until the production cards carry independent proof
//   A2 the outcome study is pre-registered before any analysis
//   A3 the study states association only, and claims none of the readings a
//      reader supplies for free
//   A4 each examined field is classified across a substantial cross-agency
//      sample
//   A5 no credential automation and no scraping is built
//   A6 where access is infeasible, the handoff says what requires signing in
//      and when the matter was last observed
//   A7 the learned-ranking lane is deferred and no part of it begins here

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCESS_CLASSES,
  ACCESS_THRESHOLDS,
  ACCESS_CLASSIFICATION_SCHEMA,
  parseAccessClassificationArgv,
} from "../tools/build_procurement_access_classification.mjs";
import {
  FORBIDDEN_CLAIM_RULES,
  RESEARCH_LANES_RELATIVE,
  RESEARCH_LANES_SCHEMA,
  RESEARCH_LANE_STATUS,
  contentHash,
  evaluateResearchLaneGates,
  forbiddenClaimFindings,
  parseResearchLaneArgv,
  readResearchLaneRegistry,
  researchLaneById,
  shardPathForEntryId,
  stripVocabularyFences,
} from "../tools/procurement_research_lane_gates.mjs";
import {
  researchLaneCaptureCases,
  researchLaneCaptureText,
} from "../tools/render_procurement_research_lane_capture_fixtures.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";
import {
  HANDOFF_ACCESS_CLASSES,
  HANDOFF_INFEASIBLE_CLASSES,
  accessClassFor,
  buildProcurementHandoffCopy,
  handoffCopyForField,
  handoffObservedDateLabel,
  lastObservedFromRecord,
  renderProcurementHandoffCopyHtml,
} from "../site/procurement_handoff_copy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFICATION_PATH = "docs/research/procurement-access-classification/classification.json";

function repoText(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

/**
 * Source with its comments removed. A boundary test has to look at what the
 * code does, not at prose describing the boundary -- a module doc that says
 * "this never reads a clock" must not itself trip the clock scan.
 */
function repoCode(relative) {
  return repoText(relative).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1");
}

function registry() {
  return readResearchLaneRegistry(ROOT);
}

const classification = JSON.parse(repoText(CLASSIFICATION_PATH));

/**
 * A fixture registry rooted in a scratch directory, so a test can remove one
 * prerequisite shard without touching the repository. Every path the registry
 * names is materialized as a placeholder file; the gate only asks whether the
 * evidence is present, which is exactly the ordering claim A1 makes.
 */
function fixtureRegistryRoot(mutate = (value) => value) {
  const root = mkdtempSync(join(tmpdir(), "cs-ppd07-lanes-"));
  const source = registry();
  for (const card of source.prerequisite_cards) {
    for (const entryId of card.evidence_shards || []) {
      const target = join(root, shardPathForEntryId(entryId));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ id: entryId }));
    }
    for (const manifest of card.manifests || []) {
      const target = join(root, manifest);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ schema: "fixture" }));
    }
  }
  for (const lane of source.lanes) {
    if (!lane.preregistration?.path) continue;
    const target = join(root, lane.preregistration.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, repoText(lane.preregistration.path));
  }
  return { root, registry: mutate(source) };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- A1 --------

test("A1: the committed registry's gate passes only because every prerequisite card carries its own evidence", () => {
  const source = registry();
  assert.equal(source.schema, RESEARCH_LANES_SCHEMA);
  assert.equal(source.prerequisite_cards.length, 6, "cards 1 through 6 are the declared prerequisites");
  const result = evaluateResearchLaneGates(source, { root: ROOT });
  assert.deepEqual(result.failures, [], "the committed registry gate is green");
  assert.equal(result.ok, true);

  for (const card of source.prerequisite_cards) {
    assert.ok(
      (card.evidence_shards || []).length + (card.manifests || []).length > 0,
      `${card.card} names at least one piece of independent evidence`,
    );
    for (const entryId of card.evidence_shards || []) {
      assert.ok(existsSync(join(ROOT, shardPathForEntryId(entryId))), `${entryId} shard exists`);
    }
    for (const manifest of card.manifests || []) {
      assert.ok(existsSync(join(ROOT, manifest)), `${manifest} exists`);
    }
  }
});

test("A1: removing any prerequisite shard from a fixture registry makes the gate fail", () => {
  const source = registry();
  const shardCards = source.prerequisite_cards.filter((card) => (card.evidence_shards || []).length);
  assert.ok(shardCards.length >= 5, "most prerequisite cards are proven by an evidence shard");

  for (const card of shardCards) {
    for (const entryId of card.evidence_shards) {
      const fixture = fixtureRegistryRoot();
      try {
        const green = evaluateResearchLaneGates(fixture.registry, { root: fixture.root });
        assert.equal(green.ok, true, `${card.card} fixture starts green`);
        rmSync(join(fixture.root, shardPathForEntryId(entryId)));
        const result = evaluateResearchLaneGates(fixture.registry, { root: fixture.root });
        assert.equal(result.ok, false, `removing ${entryId} fails the gate`);
        assert.ok(
          result.failures.some((failure) => failure.code === "missing_evidence_shard" && failure.card === card.card),
          `the failure names ${card.card}`,
        );
      } finally {
        cleanup(fixture.root);
      }
    }
  }
});

test("A1: removing a prerequisite capture manifest also fails the gate", () => {
  const fixture = fixtureRegistryRoot();
  try {
    const card = fixture.registry.prerequisite_cards.find((entry) => (entry.manifests || []).length);
    rmSync(join(fixture.root, card.manifests[0]));
    const result = evaluateResearchLaneGates(fixture.registry, { root: fixture.root });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.code === "missing_manifest" && failure.card === card.card));
  } finally {
    cleanup(fixture.root);
  }
});

test("A1: a lane may not name a prerequisite card the registry does not declare", () => {
  const fixture = fixtureRegistryRoot((value) => {
    const copy = JSON.parse(JSON.stringify(value));
    researchLaneById(copy, "outcome_study").prerequisite_cards.push("PPD-99");
    return copy;
  });
  try {
    const result = evaluateResearchLaneGates(fixture.registry, { root: fixture.root });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.code === "lane_prerequisite_unknown"));
  } finally {
    cleanup(fixture.root);
  }
});

// ---------------------------------------------------------------- A2 --------

test("A2: the registry carries the outcome study's pre-registration hash, and it matches the file on disk", () => {
  const lane = researchLaneById(registry(), "outcome_study");
  assert.equal(lane.preregistration.path, "docs/research/procurement-response-window-study/preregistration.md");
  assert.match(lane.preregistration.content_sha256, /^[0-9a-f]{64}$/);
  assert.ok(lane.preregistration.registered_at, "the registration carries a date");
  assert.equal(contentHash(repoText(lane.preregistration.path)), lane.preregistration.content_sha256);
});

test("A2: an edited pre-registration fails the check", () => {
  const fixture = fixtureRegistryRoot();
  try {
    const lane = researchLaneById(fixture.registry, "outcome_study");
    const target = join(fixture.root, lane.preregistration.path);
    writeFileSync(target, `${readFileSync(target, "utf8")}\nOne more sentence, added after registration.\n`);
    const result = evaluateResearchLaneGates(fixture.registry, { root: fixture.root });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.code === "preregistration_hash_mismatch" && failure.lane === "outcome_study"));
  } finally {
    cleanup(fixture.root);
  }
});

test("A2: an unsigned or absent pre-registration fails the check", () => {
  const unsigned = fixtureRegistryRoot((value) => {
    const copy = JSON.parse(JSON.stringify(value));
    researchLaneById(copy, "outcome_study").preregistration.content_sha256 = null;
    return copy;
  });
  try {
    const result = evaluateResearchLaneGates(unsigned.registry, { root: unsigned.root });
    assert.ok(result.failures.some((failure) => failure.code === "preregistration_unsigned"));
  } finally {
    cleanup(unsigned.root);
  }

  const absent = fixtureRegistryRoot();
  try {
    const lane = researchLaneById(absent.registry, "access_feasibility");
    rmSync(join(absent.root, lane.preregistration.path));
    const result = evaluateResearchLaneGates(absent.registry, { root: absent.root });
    assert.ok(result.failures.some((failure) => failure.code === "preregistration_file_absent"));
  } finally {
    cleanup(absent.root);
  }
});

test("A2: the study itself has not been run -- the outcome lane ships a pre-registration and nothing else", () => {
  const lane = researchLaneById(registry(), "outcome_study");
  assert.equal(lane.status, RESEARCH_LANE_STATUS.GATED);
  assert.ok(!("deliverables" in lane), "the outcome lane declares no analysis output");
  assert.ok(String(lane.not_started_note || "").length > 0);
  const preregistrationDir = "docs/research/procurement-response-window-study";
  assert.ok(existsSync(join(ROOT, preregistrationDir, "preregistration.md")));
  for (const analysisArtifact of ["results.json", "results.md", "findings.md", "analysis.json"]) {
    assert.ok(!existsSync(join(ROOT, preregistrationDir, analysisArtifact)), `${analysisArtifact} does not exist`);
  }
});

// ---------------------------------------------------------------- A3 --------

test("A3: the forbidden-claims lint finds a causal, favoritism, irregularity, illegality, or bidder-count claim", () => {
  const ids = FORBIDDEN_CLAIM_RULES.map((rule) => rule.id);
  assert.deepEqual(ids, ["causation", "favoritism", "irregularity", "illegality", "bidder_count"]);

  const cases = [
    ["A shorter window causes fewer responses.", "causation"],
    ["The window length is explained by the agency.", "causation"],
    ["This agency favored one vendor.", "favoritism"],
    ["A short window is an anomaly worth flagging.", "irregularity"],
    ["The agency violated the procurement rules.", "illegality"],
    ["Shorter windows attract fewer bidders.", "bidder_count"],
  ];
  for (const [line, expected] of cases) {
    const findings = forbiddenClaimFindings(line);
    assert.ok(findings.length > 0, `flags: ${line}`);
    assert.ok(findings.some((finding) => finding.rule === expected), `${line} -> ${expected}`);
  }

  assert.deepEqual(
    forbiddenClaimFindings("Among the records in this extract, matters published with this method had a median observed response window of 35 calendar days."),
    [],
    "association wording passes",
  );
});

test("A3: both pre-registrations state association only and make no forbidden claim", () => {
  for (const lane of registry().lanes.filter((entry) => entry.runnable)) {
    const body = repoText(lane.preregistration.path);
    assert.deepEqual(
      forbiddenClaimFindings(body).map((finding) => `${finding.rule}:${finding.match}@${finding.line}`),
      [],
      `${lane.id} pre-registration is clean outside its declared vocabulary`,
    );
    if (lane.id === "outcome_study") {
      assert.match(body, /association/i, "the outcome study names association explicitly");
      assert.match(body, /Association only\./, "and says association only, in those words");
    }
    assert.match(body, /forbidden to make/i, `${lane.id} declares what it may not claim`);
  }
});

test("A3: the declared forbidden-claims vocabulary is fenced, and only the fence is exempt", () => {
  const body = repoText("docs/research/procurement-response-window-study/preregistration.md");
  const scanned = stripVocabularyFences(body);
  assert.ok(body.includes("Bidder-count effects"), "the document names what it forbids");
  assert.ok(!scanned.includes("Bidder-count effects"), "the fenced vocabulary is excluded from the scan");
  assert.ok(scanned.includes("## Question"), "everything outside the fence is still scanned");
  assert.ok(forbiddenClaimFindings(`${body}\nShorter windows cause fewer responses.`).length > 0, "a claim outside the fence is still caught");
});

// ---------------------------------------------------------------- A4 --------

test("A4: every examined field carries a class and a sample size", () => {
  assert.equal(classification.schema, ACCESS_CLASSIFICATION_SCHEMA);
  assert.ok(classification.fields.length >= 12, "a field list worth calling a classification");
  const seen = new Set();
  for (const field of classification.fields) {
    assert.ok(field.id, "every field has an id");
    assert.ok(!seen.has(field.id), `${field.id} appears once`);
    seen.add(field.id);
    assert.ok(ACCESS_CLASSES.includes(field.class), `${field.id} carries a known class`);
    assert.equal(typeof field.sample.records_examined, "number");
    assert.equal(typeof field.sample.records_observed, "number");
    assert.equal(typeof field.sample.agencies_observed, "number");
    assert.ok(field.sample.records_examined >= field.sample.records_observed, `${field.id} observes no more than it examined`);
    assert.ok(String(field.basis || "").length > 0, `${field.id} says why it carries its class`);
    assert.equal(typeof field.per_agency, "object");
    assert.equal(Object.keys(field.per_agency).length, field.sample.agencies_observed, `${field.id} per-agency counts match its agency count`);
  }
});

test("A4: the sample is substantial and cross-agency, and the summary counts add up", () => {
  assert.ok(classification.corpus.records >= 1000, "a substantial record corpus");
  assert.ok(classification.corpus.agencies >= 10, "spanning many agencies");
  assert.ok(classification.observation_vintage.browse_projection_generated_at, "the observation vintage is recorded");

  const tally = Object.fromEntries(ACCESS_CLASSES.map((name) => [name, 0]));
  for (const field of classification.fields) tally[field.class] += 1;
  assert.deepEqual(classification.summary.by_class, tally, "the summary matches the fields");
  assert.equal(classification.summary.fields_total, classification.fields.length);
  assert.equal(
    Object.values(classification.summary.by_class).reduce((sum, count) => sum + count, 0),
    classification.summary.fields_total,
    "the class counts sum to the field total",
  );

  const accessible = classification.fields.filter((field) => field.class === "accessible");
  assert.ok(accessible.length > 0, "at least one field is reachable without signing in");
  for (const field of accessible) {
    assert.ok(field.sample.records_observed >= ACCESS_THRESHOLDS.min_records);
    assert.ok(field.sample.agencies_observed >= ACCESS_THRESHOLDS.min_agencies);
    assert.ok(field.sample.presence_rate >= ACCESS_THRESHOLDS.min_presence_rate);
  }
  for (const field of classification.fields.filter((entry) => entry.class === "unstable")) {
    assert.match(field.basis, /cannot tell/i, `${field.id} says the committed record cannot tell, not that the field is absent`);
  }
});

// ---------------------------------------------------------------- A5 --------

const NEW_SOURCE_FILES = Object.freeze([
  "tools/procurement_research_lane_gates.mjs",
  "tools/build_procurement_access_classification.mjs",
  "site/procurement_handoff_copy.mjs",
]);

test("A5: no new module imports a network or browser client", () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /from\s+["']node:https?["']/,
    /require\(\s*["']node:https?["']\s*\)/,
    /\bpuppeteer\b/,
    /\bplaywright\b/,
    /\bchrome-launcher\b/,
    /\bundici\b/,
    /\baxios\b/,
    /\bnode-fetch\b/,
  ];
  for (const relative of NEW_SOURCE_FILES) {
    const body = repoCode(relative);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(body), `${relative} does not use ${pattern}`);
    }
    const imports = [...body.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../") || ["node:crypto", "node:fs", "node:path", "node:url", "node:os"].includes(specifier),
        `${relative} imports only local modules and offline node builtins, found ${specifier}`,
      );
    }
  }
});

test("A5: no credential automation is built", () => {
  const credentialish = [
    /\bprocess\.env\b/,
    /\bAuthorization\b/i,
    /\bdocument\.cookie\b/,
    /\bset-cookie\b/i,
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b/i,
    /\b(authenticate|signIn|logIn|login)\s*\(/i,
  ];
  for (const relative of NEW_SOURCE_FILES) {
    const code = repoCode(relative);
    for (const pattern of credentialish) {
      assert.ok(!pattern.test(code), `${relative} contains no credential handling (${pattern})`);
    }
  }
});

test("A5: the tools accept no URL argument, and parse the exact argv the workflow uses", () => {
  assert.deepEqual(parseResearchLaneArgv(["--check"]), {
    check: true, list: false, json: false, register: null, root: null, registry: null, errors: [],
  });
  assert.deepEqual(parseResearchLaneArgv(["--register", "outcome_study"]), {
    check: false, list: false, json: false, register: "outcome_study", root: null, registry: null, errors: [],
  });
  assert.deepEqual(parseAccessClassificationArgv(["--check"]).errors, []);
  assert.equal(parseAccessClassificationArgv(["--check"]).check, true);
  assert.equal(parseAccessClassificationArgv(["--write"]).write, true);

  for (const argv of [["--url", "https://example.gov/rfx"], ["https://example.gov/rfx"], ["--registry", "https://example.gov/lanes.json"]]) {
    const parsed = parseResearchLaneArgv(argv);
    assert.ok(parsed.errors.length > 0, `${argv.join(" ")} is refused`);
    assert.ok(parsed.errors.some((error) => /URL|Unknown argument/.test(error)));
  }
  assert.ok(parseAccessClassificationArgv(["--out", "https://example.gov/x.json"]).errors.length > 0);
  assert.ok(parseResearchLaneArgv(["--nonsense"]).errors.length > 0, "an unknown flag is an error, not a silent no-op");
});

test("A5: the classification names committed inputs only, and says so", () => {
  for (const input of classification.corpus.inputs) {
    assert.ok(!/^[a-z][a-z0-9+.-]*:\/\//i.test(input), `${input} is a repository path, not a remote address`);
    assert.ok(existsSync(join(ROOT, input)), `${input} is committed`);
  }
  assert.match(classification.method_note, /no live retrieval/i);
  assert.match(classification.method_note, /no scraping/i);
  assert.match(classification.method_note, /no credential automation/i);
});

// ---------------------------------------------------------------- A6 --------

const AUTHENTICATED_FIXTURE = Object.freeze({
  schema: ACCESS_CLASSIFICATION_SCHEMA,
  fields: [
    {
      id: "solicitation_package_documents",
      label: "Solicitation package documents",
      class: "authenticated",
      sign_in_system: "PASSPort",
      sample: { records_examined: 10, records_observed: 0, agencies_observed: 0, presence_rate: 0 },
      per_agency: {},
    },
    {
      id: "amendment_documents",
      label: "Amendment documents",
      class: "unavailable",
      sample: { records_examined: 10, records_observed: 0, agencies_observed: 0, presence_rate: 0 },
      per_agency: {},
    },
    {
      id: "solicitation_title",
      label: "Solicitation title",
      class: "accessible",
      sample: { records_examined: 10, records_observed: 10, agencies_observed: 4, presence_rate: 1 },
      per_agency: {},
    },
    {
      id: "response_due_date",
      label: "Response due date",
      class: "unstable",
      sample: { records_examined: 10, records_observed: 1, agencies_observed: 1, presence_rate: 0.1 },
      per_agency: {},
    },
  ],
});

test("A6: an authenticated field says what requires signing in, and when the matter was last observed", () => {
  const note = handoffCopyForField(AUTHENTICATED_FIXTURE, "solicitation_package_documents", {
    record: { last_observed_at: "2026-08-18T04:05:51.552Z" },
  });
  assert.equal(note.class, "authenticated");
  assert.equal(note.sign_in_required, true);
  assert.equal(note.last_observed_label, "Aug 18, 2026");
  assert.equal(note.line, "PASSPort sign-in is required to reach the solicitation package documents. CityScroll last observed this matter on Aug 18, 2026.");
});

test("A6: an unavailable field says no public source carries it, and when the matter was last observed", () => {
  const note = handoffCopyForField(AUTHENTICATED_FIXTURE, "amendment_documents", {
    record: { retrieval_timestamp: "2026-07-30T12:00:00.000Z" },
  });
  assert.equal(note.class, "unavailable");
  assert.equal(note.sign_in_required, false);
  assert.equal(note.line, "No public source CityScroll observes carries the amendment documents. CityScroll last observed this matter on Jul 30, 2026.");
});

test("A6: the last-observed date comes from the record, never from the clock", () => {
  const undated = handoffCopyForField(AUTHENTICATED_FIXTURE, "solicitation_package_documents", { record: {} });
  assert.equal(undated.last_observed_at, null);
  assert.equal(undated.last_observed_label, null);
  assert.equal(undated.line, "PASSPort sign-in is required to reach the solicitation package documents.");
  assert.ok(!/last observed/.test(undated.line), "no date sentence is invented for a record that carries no date");

  const code = repoCode("site/procurement_handoff_copy.mjs");
  assert.ok(!/Date\.now\(\)/.test(code), "the module never reads a clock");
  assert.ok(!/new Date\(/.test(code), "the module never constructs a date");
  assert.ok(!/\bDate\b/.test(code), "the module never touches Date at all");
  assert.equal(lastObservedFromRecord({ ingested_at: "2026-01-02T00:00:00.000Z" }), "2026-01-02T00:00:00.000Z");
  assert.equal(lastObservedFromRecord({}), null);
  assert.equal(handoffObservedDateLabel("not-a-date"), "");
});

test("A6: reachable and unsettled fields produce no handoff line at all", () => {
  assert.deepEqual(HANDOFF_INFEASIBLE_CLASSES, ["authenticated", "unavailable"]);
  assert.deepEqual([...HANDOFF_ACCESS_CLASSES], [...ACCESS_CLASSES]);
  assert.equal(handoffCopyForField(AUTHENTICATED_FIXTURE, "solicitation_title", { record: {} }), null);
  assert.equal(handoffCopyForField(AUTHENTICATED_FIXTURE, "response_due_date", { record: {} }), null);
  assert.equal(handoffCopyForField(AUTHENTICATED_FIXTURE, "not_a_field", { record: {} }), null);
  assert.equal(accessClassFor(AUTHENTICATED_FIXTURE, "solicitation_title"), "accessible");
  assert.equal(accessClassFor(AUTHENTICATED_FIXTURE, "not_a_field"), null);
});

test("A6: the copy built from the committed classification covers every infeasible field, in the classification's order", () => {
  const copy = buildProcurementHandoffCopy(classification, { record: { last_observed_at: "2026-08-18T04:05:51.552Z" } });
  const expected = classification.fields.filter((field) => HANDOFF_INFEASIBLE_CLASSES.includes(field.class)).map((field) => field.id);
  assert.ok(expected.length >= 2, "the committed classification has infeasible fields to disclose");
  assert.deepEqual(copy.notes.map((note) => note.field), expected);
  for (const note of copy.notes) {
    assert.match(note.line, /CityScroll last observed this matter on Aug 18, 2026\./);
  }
  const html = renderProcurementHandoffCopyHtml(copy);
  assert.match(html, /class="procurement-handoff-copy"/);
  assert.match(html, /data-access-class="authenticated"/);
  assert.equal(renderProcurementHandoffCopyHtml({ notes: [] }), "", "nothing to disclose renders nothing");
  assert.equal(renderProcurementHandoffCopyHtml(null), "");
});

/**
 * Fixture A from the workstream's committed fixture ledger -- the dense
 * exact-join solicitation the sibling cards already render -- so the handoff
 * disclosure is exercised on the same matter the rest of this workstream uses.
 */
function fixtureADetailHtml(opts = {}) {
  const solicitationRef = "city_record:20260701001";
  const rfxRef = "passport_public_rfx:rfx:EPIN-2026-07:1001";
  const observations = [
    {
      source_observation_ref: rfxRef,
      source_system: "passport_public_rfx",
      source_system_id: "rfx:EPIN-2026-07:1001",
      ingested_at: "2026-07-01T10:00:00Z",
      snapshot: {
        rfp_id: "1001",
        epin: "EPIN-2026-07",
        procurement_name: "Playground reconstruction",
        agency: "Department of Parks and Recreation",
        rfx_status: "Released",
        release_date: "07/01/2026",
        due_date: "08/05/2026",
        official_url: "https://passport.example/rfx/1001",
      },
    },
    {
      source_observation_ref: solicitationRef,
      source_system: "city_record",
      source_system_id: "20260701001",
      ingested_at: "2026-07-02T10:00:00Z",
      snapshot: {
        request_id: "20260701001",
        short_title: "Playground reconstruction solicitation",
        type_of_notice_description: "Solicitation Notice",
      },
    },
  ];
  const object = {
    procurement_id: "procurement:epin-2026-07",
    source_observation_refs: [rfxRef, solicitationRef],
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: "2026-07-10", ...opts });
}

test("A6: the existing procurement handoff carries the disclosure when the classification is supplied, and nothing when it is not", () => {
  const without = fixtureADetailHtml();
  assert.ok(!without.includes("procurement-handoff-copy"), "absent input renders nothing, like every other optional section on this page");
  assert.ok(!without.includes("What these official records do not carry"));

  const withClassification = fixtureADetailHtml({ accessClassification: classification });
  assert.match(withClassification, /What these official records do not carry/);
  assert.match(withClassification, /PASSPort sign-in is required to reach the solicitation package documents\./);
  assert.match(withClassification, /No public source CityScroll observes carries the amendment documents\./);
  // The date is the latest observation this record actually carries
  // (2026-07-02), not the day the page was rendered.
  assert.match(withClassification, /CityScroll last observed this matter on Jul 2, 2026\./);
  assert.ok(!withClassification.includes("Jul 10, 2026"), "the render day never becomes a last-observed date");
  assert.ok(
    withClassification.indexOf("Official records") < withClassification.indexOf("What these official records do not carry"),
    "the disclosure sits with the official-record handoff it qualifies",
  );
});

// ---------------------------------------------------------------- A7 --------

test("A7: the learned-ranking lane is deferred, with no steps and no pre-registration", () => {
  const lane = researchLaneById(registry(), "learned_ranking");
  assert.ok(lane, "the lane is declared, so its deferral is on the record");
  assert.equal(lane.status, RESEARCH_LANE_STATUS.DEFERRED);
  assert.equal(lane.runnable, false);
  assert.deepEqual(lane.steps, []);
  assert.equal(lane.preregistration, null);
  assert.ok(String(lane.deferral_note || "").length > 0, "the registry says why it is deferred");
});

test("A7: a deferred lane that grew steps or a pre-registration fails the gate", () => {
  const withSteps = fixtureRegistryRoot((value) => {
    const copy = JSON.parse(JSON.stringify(value));
    researchLaneById(copy, "learned_ranking").steps = ["Assemble training data"];
    return copy;
  });
  try {
    const result = evaluateResearchLaneGates(withSteps.registry, { root: withSteps.root });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.code === "deferred_lane_has_steps"));
  } finally {
    cleanup(withSteps.root);
  }

  const withPrereg = fixtureRegistryRoot((value) => {
    const copy = JSON.parse(JSON.stringify(value));
    researchLaneById(copy, "learned_ranking").preregistration = { path: "docs/research/x.md", content_sha256: "0".repeat(64) };
    return copy;
  });
  try {
    const result = evaluateResearchLaneGates(withPrereg.registry, { root: withPrereg.root });
    assert.ok(result.failures.some((failure) => failure.code === "deferred_lane_registered"));
  } finally {
    cleanup(withPrereg.root);
  }
});

test("A7: no ranking module is added by this card", () => {
  for (const candidate of [
    "site/procurement_learned_ranking.mjs",
    "site/procurement_ranking.mjs",
    "site/procurement_opportunity_ranking.mjs",
    "tools/train_procurement_ranking.mjs",
    "tools/build_procurement_ranking.mjs",
  ]) {
    assert.ok(!existsSync(join(ROOT, candidate)), `${candidate} does not exist`);
  }
  for (const relative of NEW_SOURCE_FILES) {
    const code = repoCode(relative);
    assert.ok(!/\brankScore\b|\bscoreOpportunity\b|\btrainModel\b|\.sort\(.*score/i.test(code), `${relative} builds no ranking`);
  }
});

// ------------------------------------------------------------ evidence ------

test("the capture manifest is a receipt: every hash is what the evidence script prints today", () => {
  const manifest = JSON.parse(repoText("docs/evidence/procurement-pursuit-decision/gated-research-lanes/capture-manifest.json"));
  const rendered = repoText("docs/evidence/procurement-pursuit-decision/gated-research-lanes/rendered-lines.md");
  const cases = researchLaneCaptureCases();
  assert.equal(manifest.captures.length, Object.keys(cases).length);

  for (const capture of manifest.captures) {
    const result = cases[capture.case];
    assert.ok(result, `${capture.case} is a case the evidence script produces`);
    const body = researchLaneCaptureText(result);
    assert.equal(capture.content_sha256, createHash("sha256").update(body, "utf8").digest("hex"), `${capture.case} hash`);
    assert.equal(capture.bytes, Buffer.byteLength(body, "utf8"), `${capture.case} byte count`);
    assert.equal(capture.content_source, "tools/render_procurement_research_lane_capture_fixtures.mjs");
    assert.ok(capture.assertion.length > 0, `${capture.case} states what it proves`);
    assert.ok(capture.data_vintage.length > 0, `${capture.case} states its data vintage`);
    assert.ok(rendered.includes(body.trim()), `${capture.case} is reproduced verbatim in the rendered evidence`);
  }
  assert.match(manifest.note, /No image binaries are produced or committed/);
  assert.equal(cases["research-lane-gate-green"].ok, true, "the committed gate is green in the evidence");
  assert.equal(cases["research-lane-gate-withdrawn-evidence"].ok, false, "withdrawing a card's evidence fails it");
});

// --------------------------------------------------------------- shape ------

test("the registry lives where the gate command expects it, and its lanes are exactly the three this card declares", () => {
  assert.equal(RESEARCH_LANES_RELATIVE, "site/procurement_research_lanes.json");
  assert.ok(existsSync(join(ROOT, RESEARCH_LANES_RELATIVE)));
  const source = registry();
  assert.deepEqual(source.lanes.map((lane) => lane.id), ["outcome_study", "access_feasibility", "learned_ranking"]);
  assert.equal(source.gate_command, "node tools/procurement_research_lane_gates.mjs --check");
});
