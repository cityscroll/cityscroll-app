import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
} from "../capabilities/federated_search.mjs";
import {
  NOTICE_GET_CAPABILITY,
  NOTICE_GET_CAPABILITY_REFERENCE,
} from "../capabilities/notice_get.mjs";
import {
  INELIGIBILITY_REASONS,
  PRODUCT_UPDATE_CANDIDATE_SCHEMA,
  PRODUCT_UPDATE_JOINS,
  PRODUCT_UPDATE_SOURCE_INPUTS,
  PRODUCT_UPDATES_METHOD,
  PRODUCT_UPDATES_SCHEMA,
  buildProductUpdatesArtifact,
  eligibleProductUpdateIds,
  hashProductUpdatesEvidence,
  publicProductUpdatesLeaks,
  serializeProductUpdatesArtifact,
  validatePublicProductUpdatesArtifact,
} from "../site/product_updates_source.mjs";
import {
  checkProductUpdatesArtifact,
  generateProductUpdatesArtifact,
} from "../tools/build_product_updates.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARTIFACT_PATH = new URL("../site/product-updates.json", import.meta.url);
const BUILDER_PATH = new URL("../tools/build_product_updates.mjs", import.meta.url);
const DEMO_MANIFEST = JSON.parse(readFileSync(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"));
const CHANGELOG = JSON.parse(readFileSync(new URL("../site/changelog-data.json", import.meta.url), "utf8"));
const WATERMARK = JSON.parse(readFileSync(new URL("../architecture/generated/watermark.json", import.meta.url), "utf8"));

const HOUSING_JOIN = PRODUCT_UPDATE_JOINS.find((join) => join.demo_id === "semantic-search-housing");
const NOTICE_JOIN = PRODUCT_UPDATE_JOINS.find((join) => join.demo_id === "notice-sanitation-connected-mandate");

function healthyReconciliation(overrides = {}) {
  return {
    schema: "cityscroll.architecture.reconciliation.v1",
    status: "healthy",
    path: "architecture/generated/reconciliation.json",
    observed_commit: WATERMARK.commit,
    as_of: WATERMARK.generated_at,
    baseline: "architecture/generated/watermark.json",
    ...overrides,
  };
}

function sources(overrides = {}) {
  return {
    changelog: CHANGELOG,
    reconciliation: healthyReconciliation(),
    capabilities: CAPABILITY_REGISTRY,
    demoManifest: DEMO_MANIFEST,
    joins: PRODUCT_UPDATE_JOINS,
    ...overrides,
  };
}

function demo(id) {
  return DEMO_MANIFEST.entries.find((entry) => entry.id === id);
}

test("explicit joins are the only pairing mechanism and name the four public sources", () => {
  assert.deepEqual(
    PRODUCT_UPDATE_JOINS.map(({ capability_reference, demo_id }) => [capability_reference, demo_id]),
    [
      [FEDERATED_SEARCH_CAPABILITY_REFERENCE, "semantic-search-housing"],
      [NOTICE_GET_CAPABILITY_REFERENCE, "notice-sanitation-connected-mandate"],
    ],
  );
  assert.deepEqual(PRODUCT_UPDATE_SOURCE_INPUTS.map(({ id }) => id), [
    "changelog",
    "architecture_reconciliation",
    "capability_registry",
    "demo_manifest",
  ]);
  assert.equal(HOUSING_JOIN.source.kind, "architecture_reconciliation");
  assert.equal(NOTICE_JOIN.source.kind, "architecture_reconciliation");
});

test("grounded fixture joins are eligible with exact source anchors and manifest-owned routes", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const errors = validatePublicProductUpdatesArtifact(artifact);
  assert.deepEqual(errors, []);
  assert.equal(artifact.schema, PRODUCT_UPDATES_SCHEMA);
  assert.equal(artifact.method, PRODUCT_UPDATES_METHOD);
  assert.equal(artifact.observed_commit, WATERMARK.commit);
  assert.equal(artifact.as_of, WATERMARK.generated_at);
  assert.deepEqual(artifact.eligible_ids, [
    NOTICE_JOIN.id,
    HOUSING_JOIN.id,
  ].sort());
  assert.deepEqual(artifact.ineligible_ids, []);
  assert.deepEqual(eligibleProductUpdateIds(artifact), artifact.eligible_ids);

  const housing = artifact.candidates.find((row) => row.id === HOUSING_JOIN.id);
  const notice = artifact.candidates.find((row) => row.id === NOTICE_JOIN.id);
  const housingDemo = demo("semantic-search-housing");
  const noticeDemo = demo("notice-sanitation-connected-mandate");

  assert.equal(housing.state, "eligible");
  assert.equal(housing.schema, PRODUCT_UPDATE_CANDIDATE_SCHEMA);
  assert.equal(housing.capability.reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(housing.capability.version, FEDERATED_SEARCH_CAPABILITY.version);
  assert.equal(housing.demo.id, "semantic-search-housing");
  assert.equal(housing.demo.url, housingDemo.url);
  assert.equal(housing.demo.pathname, housingDemo.expectations.pathname);
  assert.equal(housing.claim, housingDemo.description);
  assert.equal(housing.source_event.kind, "architecture_reconciliation");
  assert.equal(housing.source_event.path, "architecture/generated/reconciliation.json");
  assert.equal(housing.source_event.status, "checked");
  assert.equal(housing.observed_commit, WATERMARK.commit);
  assert.equal(housing.as_of, WATERMARK.generated_at);
  assert.equal(housing.provenance.demo_manifest.demo_id, "semantic-search-housing");
  assert.equal(housing.provenance.capability_registry.reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  assert.notEqual(housing.demo.url, FEDERATED_SEARCH_CAPABILITY.examples[0].input.query);

  assert.equal(notice.state, "eligible");
  assert.equal(notice.capability.reference, NOTICE_GET_CAPABILITY_REFERENCE);
  assert.equal(notice.capability.version, NOTICE_GET_CAPABILITY.version);
  assert.equal(notice.demo.id, "notice-sanitation-connected-mandate");
  assert.equal(notice.demo.url, noticeDemo.url);
  assert.equal(notice.demo.pathname, noticeDemo.expectations.pathname);
  assert.equal(notice.claim, noticeDemo.description);
  assert.equal(notice.source_event.kind, "architecture_reconciliation");
  assert.notEqual(notice.demo.url, `notices/${NOTICE_GET_CAPABILITY.examples[0].input.requestId}`);
});

test("ordering and content hashing are deterministic", () => {
  const first = buildProductUpdatesArtifact(sources());
  const second = buildProductUpdatesArtifact(sources());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.content_hash, hashProductUpdatesEvidence(first));
  assert.equal(first.content_hash, second.content_hash);
  const ids = first.candidates.map((row) => row.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(serializeProductUpdatesArtifact(first), `${JSON.stringify(first, null, 2)}\n`);
});

test("prose similarity never invents a capability/demo join", () => {
  const similarDemo = {
    id: "housing-prose-near-miss",
    url: "search/?q=apartments",
    feature: "semantic-cross-source-search",
    description: "One housing concept query returns cited passages across Rules and Meetings.",
    expectations: { pathname: "/search/", visible: [{ selector: "main" }] },
  };
  const artifact = buildProductUpdatesArtifact(sources({
    demoManifest: { entries: [...DEMO_MANIFEST.entries, similarDemo] },
    joins: [],
  }));
  assert.equal(artifact.candidates.length, 0);
  assert.deepEqual(artifact.eligible_ids, []);
  assert.equal(artifact.candidates.some((row) => row.demo?.id === "housing-prose-near-miss"), false);
});

test("proposed, merged-but-not-public, stale, unregistered, missing, and incomplete inputs stay ineligible", () => {
  const incompleteDemo = {
    id: "incomplete-demo",
    url: "#notice/123",
    feature: "notice-mandate-pivot",
    description: "This hash route is not a public document route for product updates.",
    expectations: { pathname: "/notices/123" },
  };
  const privateCapability = {
    ...NOTICE_GET_CAPABILITY,
    id: "notice.private",
    reference: "notice.private@1",
    authority: { class: "operator-read", sideEffect: "none", approval: "none" },
    adapters: NOTICE_GET_CAPABILITY.adapters,
    provider: { ...NOTICE_GET_CAPABILITY.provider, id: "worker-notices.notice-private" },
  };
  const extraJoins = [
    {
      id: "search.federated@1::proposed-search",
      capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
      demo_id: "semantic-search-housing",
      publication_state: "proposed",
      source: { kind: "architecture_reconciliation" },
    },
    {
      id: "notice.get@1::missing-changelog",
      capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
      demo_id: "notice-sanitation-connected-mandate",
      source: { kind: "changelog", pr: 999999 },
    },
    {
      id: "search.federated@1::stale-reconciliation",
      capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
      demo_id: "semantic-search-housing",
      source: { kind: "architecture_reconciliation" },
    },
    {
      id: "search.unregistered@1::semantic-search-housing",
      capability_reference: "search.unregistered@1",
      demo_id: "semantic-search-housing",
      source: { kind: "architecture_reconciliation" },
    },
    {
      id: "notice.get@1::missing-demo",
      capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
      demo_id: "notice-does-not-exist",
      source: { kind: "architecture_reconciliation" },
    },
    {
      id: "notice.get@1::incomplete-demo",
      capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
      demo_id: "incomplete-demo",
      source: { kind: "architecture_reconciliation" },
    },
    {
      id: "notice.private@1::notice-sanitation-connected-mandate",
      capability_reference: "notice.private@1",
      demo_id: "notice-sanitation-connected-mandate",
      source: { kind: "architecture_reconciliation" },
    },
  ];

  const staleArtifact = buildProductUpdatesArtifact(sources({
    reconciliation: healthyReconciliation({ status: "stale" }),
    capabilities: [...CAPABILITY_REGISTRY, privateCapability],
    demoManifest: { entries: [...DEMO_MANIFEST.entries, incompleteDemo] },
    joins: extraJoins,
  }));

  const byId = Object.fromEntries(staleArtifact.candidates.map((row) => [row.id, row]));
  assert.equal(byId["search.federated@1::proposed-search"].reason, "proposed");
  assert.equal(byId["notice.get@1::missing-changelog"].reason, "merged_but_not_public");
  assert.equal(byId["search.federated@1::stale-reconciliation"].reason, "stale");
  assert.equal(byId["search.unregistered@1::semantic-search-housing"].reason, "unregistered");
  assert.equal(byId["notice.get@1::missing-demo"].reason, "missing");
  assert.equal(byId["notice.get@1::incomplete-demo"].reason, "incomplete");
  assert.equal(byId["notice.private@1::notice-sanitation-connected-mandate"].reason, "merged_but_not_public");
  assert.deepEqual(staleArtifact.eligible_ids, []);
  assert.equal(staleArtifact.candidates.every((row) => row.eligible === false), true);
  assert.deepEqual([...new Set(staleArtifact.candidates.map((row) => row.reason))].sort(), [
    "incomplete",
    "merged_but_not_public",
    "missing",
    "proposed",
    "stale",
    "unregistered",
  ]);
  assert.deepEqual(INELIGIBILITY_REASONS.slice().sort(), [
    "incomplete",
    "merged_but_not_public",
    "missing",
    "proposed",
    "stale",
    "unregistered",
  ]);
  assert.deepEqual(validatePublicProductUpdatesArtifact(staleArtifact), []);
  assert.equal(eligibleProductUpdateIds(staleArtifact).length, 0);
});

test("a changelog-sourced join records the public changelog event without replacing the demo route", () => {
  const join = {
    id: "notice.get@1::changelog-sanitation",
    capability_reference: NOTICE_GET_CAPABILITY_REFERENCE,
    demo_id: "notice-sanitation-connected-mandate",
    source: { kind: "changelog", pr: 318 },
  };
  const artifact = buildProductUpdatesArtifact(sources({ joins: [join] }));
  const candidate = artifact.candidates[0];
  assert.equal(candidate.state, "eligible");
  assert.equal(candidate.source_event.kind, "changelog");
  assert.equal(candidate.source_event.pr, 318);
  assert.equal(candidate.source_event.path, "site/changelog-data.json");
  assert.equal(candidate.as_of, "2026-08-02");
  assert.equal(candidate.demo.url, demo("notice-sanitation-connected-mandate").url);
  assert.equal(candidate.provenance.changelog.used, true);
  assert.equal(candidate.provenance.changelog.pr, 318);
});

test("missing required source inputs fail closed as missing, not eligible", () => {
  const missingChangelog = buildProductUpdatesArtifact(sources({ changelog: null }));
  const missingReconciliation = buildProductUpdatesArtifact(sources({ reconciliation: null }));
  assert.equal(missingChangelog.candidates.every((row) => row.reason === "missing"), true);
  assert.equal(missingReconciliation.candidates.every((row) => row.reason === "missing"), true);
  assert.deepEqual(missingChangelog.eligible_ids, []);
  assert.deepEqual(missingReconciliation.eligible_ids, []);
});

test("the public artifact omits private paths, operator state, and unbounded marketing copy", () => {
  const artifact = buildProductUpdatesArtifact(sources());
  const text = serializeProductUpdatesArtifact(artifact);
  assert.deepEqual(publicProductUpdatesLeaks(artifact), []);
  assert.doesNotMatch(text, /\/Users\/|\/var\/folders|file:\/\/|127\.0\.0\.1|ADMIN_KEY/i);
  assert.doesNotMatch(text, /best ever|game-changer|amazing/i);
  const builder = readFileSync(BUILDER_PATH, "utf8");
  assert.doesNotMatch(builder, /from ["'].*cityscroll-internal/);
  assert.doesNotMatch(builder, /ops\/desk-publish-cron/);
});

test("the committed public artifact matches the checked publication output", () => {
  const committed = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  const generated = generateProductUpdatesArtifact({
    changelog: CHANGELOG,
    reconciliation: healthyReconciliation(),
    capabilities: CAPABILITY_REGISTRY,
    demoManifest: DEMO_MANIFEST,
  });
  assert.deepEqual(validatePublicProductUpdatesArtifact(committed), []);
  assert.deepEqual(committed.eligible_ids, generated.eligible_ids);
  assert.equal(committed.content_hash, generated.content_hash);
  assert.deepEqual(
    checkProductUpdatesArtifact({
      changelog: CHANGELOG,
      reconciliation: healthyReconciliation(),
      capabilities: CAPABILITY_REGISTRY,
      demoManifest: DEMO_MANIFEST,
    }),
    [],
  );
});

test("the generation check fails closed on a stale public artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "product-updates-"));
  const outputPath = join(directory, "product-updates.json");
  try {
    const current = generateProductUpdatesArtifact({
      changelog: CHANGELOG,
      reconciliation: healthyReconciliation(),
      capabilities: CAPABILITY_REGISTRY,
      demoManifest: DEMO_MANIFEST,
    });
    writeFileSync(outputPath, serializeProductUpdatesArtifact(current));
    assert.deepEqual(checkProductUpdatesArtifact({
      changelog: CHANGELOG,
      reconciliation: healthyReconciliation(),
      capabilities: CAPABILITY_REGISTRY,
      demoManifest: DEMO_MANIFEST,
      outputPath,
    }), []);
    writeFileSync(outputPath, serializeProductUpdatesArtifact({
      ...current,
      candidates: current.candidates.map((row) => ({ ...row, claim: "rewritten marketing copy that is still long enough" })),
      content_hash: current.content_hash,
    }));
    const stale = checkProductUpdatesArtifact({
      changelog: CHANGELOG,
      reconciliation: healthyReconciliation(),
      capabilities: CAPABILITY_REGISTRY,
      demoManifest: DEMO_MANIFEST,
      outputPath,
    });
    assert.match(stale[0], /stale|invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI generation check is the publication gate", () => {
  const command = fileURLToPath(BUILDER_PATH);
  const generated = spawnSync(process.execPath, [command], { cwd: ROOT, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const checked = spawnSync(process.execPath, [command, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /checked site\/product-updates\.json/);
});
