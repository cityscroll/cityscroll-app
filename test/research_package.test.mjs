import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { storySignalInvestigationItem } from "../site/investigation_comparative_signal.mjs";
import {
  MAX_RESEARCH_PACKAGE_BYTES,
  RESEARCH_PACKAGE_SCHEMA,
  finalizeResearchPackage,
  normalizeResearchPackage,
  researchPackageJson,
  researchPackageNewerData,
  researchPackageRequestFromInvestigation,
} from "../site/research_package.mjs";

const storySignals = JSON.parse(readFileSync(
  new URL("../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));

function signalItem() {
  return storySignalInvestigationItem(structuredClone(storySignals.signals[0]), {
    peerSetHref: "/experimental/worth-a-look/#peer-20240119104",
  });
}

function investigation() {
  const signal = signalItem();
  signal.evidence[0].source_vault_sha256 = "a".repeat(64);
  signal.evidence[0].source_vault_ref = `/source-vault/${"a".repeat(64)}`;
  return {
    name: "Large awards worth checking",
    created: "2026-08-19",
    items: [
      signal,
      { t: "notice", id: "20240119104", title: "source notice", raw_dataset: ["must not copy"] },
    ],
    private_analysis: "must not enter the factual package",
  };
}

test("an Investigation becomes a compact, externally intelligible package request", () => {
  const request = researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed awards are unusually large within their source-bounded agency cohort?",
  });

  assert.ok(request);
  assert.equal(request.discriminator, "research_package");
  assert.equal(request.title, "Large awards worth checking");
  assert.equal(request.observations.length, 1);
  assert.equal(request.observations[0].exact_claim, signalItem().claim);
  assert.deepEqual(request.observations[0].objects[0], {
    type: "ocp_award",
    id: "20240119104",
    ref: "ocp_award:20240119104",
    label: "Immediate Response Cards and Related Services",
    href: "/notices/20240119104/",
  });
  assert.equal(request.observations[0].official_evidence[0].source_vault_sha256, "a".repeat(64));
  assert.equal(request.observations[0].comparison_receipt.receipt_id, signalItem().comparison_receipt.receipt_id);
  assert.ok(request.observations[0].snapshot_vintages.length);
  assert.ok(request.source_contracts.length);
  assert.match(request.methods.description, /deterministic comparison receipts/i);
  assert.doesNotMatch(JSON.stringify(request), /private_analysis|raw_dataset|must not copy/);
});

test("v1 is frozen and v2 has a new identity plus an explicit change record", () => {
  const requestV1 = researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed award stands out?",
  });
  const v1 = finalizeResearchPackage(requestV1, {
    packageId: "rp_test",
    versionId: "rp_test_v1",
    generatedAt: "2026-08-19T12:00:00.000Z",
  });
  const frozenV1 = researchPackageJson(v1);

  assert.equal(v1.schema, RESEARCH_PACKAGE_SCHEMA);
  assert.equal(v1.package_id, "rp_test");
  assert.equal(v1.version, 1);
  assert.equal(v1.supersedes, null);
  assert.deepEqual(v1.changes, [{ kind: "created", summary: "Initial frozen package." }]);
  assert.ok(Object.isFrozen(v1));

  const requestV2 = researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed award stands out in the refreshed snapshot?",
    supersedes: { version_id: v1.version_id },
    changes: [{ kind: "data_refreshed", summary: "Refreshed the source-bounded comparison snapshot." }],
  });
  const v2 = finalizeResearchPackage(requestV2, {
    versionId: "rp_test_v2",
    generatedAt: "2026-08-20T12:00:00.000Z",
    previousPackage: v1,
  });

  assert.equal(v2.package_id, v1.package_id);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.supersedes, { version_id: v1.version_id, version: 1 });
  assert.deepEqual(v2.changes, requestV2.changes);
  assert.equal(researchPackageJson(v1), frozenV1, "minting v2 cannot rewrite v1");
  assert.notEqual(v2.version_id, v1.version_id);

  const missingChanges = researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed award stands out?",
    supersedes: { version_id: v1.version_id },
  });
  assert.equal(finalizeResearchPackage(missingChanges, {
    versionId: "bad-v2",
    generatedAt: "2026-08-20T12:00:00.000Z",
    previousPackage: v1,
  }), null, "a later version must explain what changed");
});

test("newer-data projection is explicit and never mutates the frozen package", () => {
  const v1 = finalizeResearchPackage(researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed award stands out?",
  }), {
    packageId: "rp_test",
    versionId: "rp_test_v1",
    generatedAt: "2026-08-19T12:00:00.000Z",
  });
  const before = researchPackageJson(v1);
  const current = structuredClone(storySignals.signals[0]);
  current.signal_id = `${current.signal_id}:refresh-2`;
  current.fact_id = `${current.fact_id}:refresh-2`;
  current.generated_at = "2026-08-20T12:00:00.000Z";
  current.comparison_receipt.receipt_id = current.fact_id;
  current.comparison_receipt.generated_at = current.generated_at;
  current.comparison_receipt.peer_basis.source_vintages[0].materialized_at = current.generated_at;

  const projection = researchPackageNewerData(v1, [current]);
  assert.equal(projection.newer_data_available, true);
  assert.deepEqual(projection.newer_materializations, [{
    observation_id: v1.observations[0].observation_id,
    signal_id: current.signal_id,
    generated_at: current.generated_at,
  }]);
  assert.equal(researchPackageJson(v1), before, "checking live freshness cannot rewrite the package");
  assert.equal(researchPackageNewerData(v1, storySignals.signals).newer_data_available, false);
});

test("the JSON export is deterministic, bounded, and fails closed on copied data or held signals", () => {
  const v1 = finalizeResearchPackage(researchPackageRequestFromInvestigation(investigation(), {
    question: "Which observed award stands out?",
  }), {
    packageId: "rp_test",
    versionId: "rp_test_v1",
    generatedAt: "2026-08-19T12:00:00.000Z",
  });
  const exported = researchPackageJson(v1);

  assert.equal(exported, researchPackageJson(JSON.parse(exported)));
  assert.ok(new TextEncoder().encode(exported).byteLength <= MAX_RESEARCH_PACKAGE_BYTES);
  assert.deepEqual(normalizeResearchPackage(JSON.parse(exported)), v1);

  const held = investigation();
  held.items[0].state = "held_mnar";
  assert.equal(researchPackageRequestFromInvestigation(held, { question: "A question" }), null);

  const copied = JSON.parse(exported);
  copied.source_dataset = Array.from({ length: 20_000 }, (_, index) => ({ index }));
  assert.deepEqual(normalizeResearchPackage(copied), v1, "unknown dataset payloads are not admitted");
});

test("the package uses the existing Investigation workspace, /inv route, and shared renderer", () => {
  const workspace = readFileSync(new URL("../site/app/workspace.mjs", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker/src/inv.mjs", import.meta.url), "utf8");

  assert.match(workspace, /researchPackageRequestFromInvestigation\(cur,/);
  assert.match(workspace, /workerFetch\("\/inv"/);
  assert.match(workspace, /id="invpackage"/);
  assert.match(workspace, /j\?\.schema===RESEARCH_PACKAGE_SCHEMA/);
  assert.match(workspace, /researchPackageNewerData\(researchPackage,currentSignals\)/);
  assert.match(workspace, /researchPackageJson\(researchPackage\)/);
  assert.doesNotMatch(workspace, /crd_(?:research|package)/,
    "the pilot must not create a parallel browser storage subsystem");
  assert.match(worker, /validResearchPackageRequest\(body\)/);
  assert.match(worker, /`inv:\$\{id\}`/,
    "package versions stay in the existing /inv KV namespace");
});

test("research-package helper bindings remain safe in the classic flattened bundle", () => {
  const bindings = (source) => new Set(Array.from(
    source.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm),
    (match) => match[1],
  ));
  const packageBindings = bindings(readFileSync(
    new URL("../site/research_package.mjs", import.meta.url),
    "utf8",
  ));
  const signalBindings = bindings(readFileSync(
    new URL("../site/investigation_comparative_signal.mjs", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(
    [...packageBindings].filter((name) => signalBindings.has(name)),
    [],
    "workspace helpers are concatenated into one classic-script scope",
  );
});
