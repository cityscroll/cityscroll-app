import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  D1_GENERATION_FENCE_SCHEMA,
  abandonGeneration,
  checkGenerationCommit,
  claimGeneration,
  completeGeneration,
  createMemoryStateStore,
  parseArgs,
  reclaimGeneration,
  renewGeneration,
} from "../tools/d1_generation_fence.mjs";

const ROOT = join(import.meta.dirname, "..");
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const WATERMARKS = {
  entity_intelligence: { __model__: "2026-09-01T00:00:00Z" },
  keyword_search: { alpha: "2026-09-01T00:00:00Z", beta: "2026-09-02T00:00:00Z" },
};

function claimArgs(store, holder, fingerprint, now) {
  return { store, holder, fingerprint, watermarks: WATERMARKS, now, leaseMs: 1000 };
}

test("concurrent publishers produce one claim and one safe lost-race retry", async () => {
  const store = createMemoryStateStore();
  const results = await Promise.all([
    claimGeneration(claimArgs(store, "publisher-a", FINGERPRINT_A, 0)),
    claimGeneration(claimArgs(store, "publisher-b", FINGERPRINT_B, 0)),
  ]);

  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => result.retry).length, 1);
  assert.ok(results.some((result) => result.result === "lost-race"));

  const winner = results.find((result) => result.claimed);
  const accepted = await checkGenerationCommit({
    store, generation: winner.generation, holder: winner.state.holder,
    fingerprint: winner.state.fingerprint, now: 500,
  });
  assert.equal(accepted.committable, true);
  assert.equal(accepted.state.status, "accepted");
  assert.equal((await completeGeneration({
    store, generation: winner.generation, holder: winner.state.holder,
    fingerprint: winner.state.fingerprint, now: 600,
  })).completed, true);
});

test("an expired lease is reclaimed with an audit receipt naming the abandoned claim", async () => {
  const store = createMemoryStateStore();
  const first = await claimGeneration(claimArgs(store, "old-publisher", FINGERPRINT_A, 0));
  assert.equal(first.generation, 1);

  const reclaimed = await reclaimGeneration({
    store, holder: "new-publisher", fingerprint: FINGERPRINT_B,
    watermarks: WATERMARKS, now: 1000, leaseMs: 1000,
  });
  assert.equal(reclaimed.result, "reclaimed");
  assert.equal(reclaimed.generation, 2);
  assert.equal(reclaimed.audit.abandoned_claim.holder, "old-publisher");
  assert.equal(reclaimed.audit.abandoned_claim.generation, 1);
  assert.deepEqual(store.audits, [reclaimed.audit]);
});

test("a superseded generation is fenced at the D1 SQL execution boundary", async () => {
  const store = createMemoryStateStore();
  const old = await claimGeneration(claimArgs(store, "old-publisher", FINGERPRINT_A, 0));
  const newer = await reclaimGeneration({
    store, holder: "new-publisher", fingerprint: FINGERPRINT_B,
    watermarks: WATERMARKS, now: 1000, leaseMs: 1000,
  });
  const newerCommit = await checkGenerationCommit({
    store, generation: newer.generation, holder: "new-publisher", fingerprint: FINGERPRINT_B, now: 1100,
  });
  assert.equal(newerCommit.committable, true);

  let sqlCalls = 0;
  async function executeD1Sql(claim) {
    const boundary = await checkGenerationCommit({ ...claim, store, now: 1100 });
    if (boundary.fenced) return { result: "fenced", sqlCalls };
    sqlCalls += 1;
    return { result: "executed", sqlCalls };
  }

  const oldAttempt = await executeD1Sql({
    generation: old.generation, holder: "old-publisher", fingerprint: FINGERPRINT_A,
  });
  assert.deepEqual(oldAttempt, { result: "fenced", sqlCalls: 0 });
  assert.equal((await renewGeneration({
    store, generation: old.generation, holder: "old-publisher", fingerprint: FINGERPRINT_A, now: 1100,
  })).renewed, false);
});

test("failure abandons a live claim without deleting fence state", async () => {
  const store = createMemoryStateStore();
  const claim = await claimGeneration(claimArgs(store, "publisher-a", FINGERPRINT_A, 0));
  const abandoned = await abandonGeneration({
    store, generation: claim.generation, holder: claim.state.holder, fingerprint: FINGERPRINT_A, now: 100,
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal((await store.read()).status, "abandoned");
  assert.equal(store.audits[0].abandoned_claim.generation, claim.generation);
});

test("the workflow keeps every fence mutation behind the existing publication gate", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const claim = workflow.indexOf("d1_generation_fence.mjs claim");
  const commit = workflow.indexOf("d1_generation_fence.mjs commit-check");
  const sql = workflow.indexOf("d1 execute crol-notices");
  assert.ok(claim >= 0 && commit > claim && commit < sql, "claim and boundary check precede D1 SQL");
  assert.match(workflow, /d1_delta_plan\.mjs snapshot/);
  assert.match(workflow, /d1_generation_fence\.mjs commit-check/);
  assert.match(workflow, /d1_generation_fence\.mjs renew/);
  assert.match(workflow, /d1_generation_fence\.mjs complete/);
  assert.match(workflow, /if: steps\.d1-publication-gate\.outputs\.should-publish == 'true'/);
  assert.match(workflow, /D1 publication rollback: pause new delta publication and use the explicit rebuild path/);
  assert.match(workflow, /node tools\/build_worker_d1_read_models\.mjs --mode rebuild/);
  assert.match(workflow, /d1-publication:state:v1/);
  assert.equal(D1_GENERATION_FENCE_SCHEMA, "cityscroll.d1-publication-generation-fence.v1");
});

// The deploy workflow is the only caller of this CLI, so its exact argv shape is part of
// the contract. These cases cover the shipped regression where a bare `--remote` swallowed
// the following `--config` flag and the config path was then rejected as a positional.
const WORKFLOW_CLAIM_ARGV = [
  "node", "tools/d1_generation_fence.mjs", "claim",
  "--fingerprint", FINGERPRINT_A,
  "--snapshot", ".d1-publication-state/partition-snapshot.json",
  "--holder", "Deploy worker:1:1",
  "--key", "d1-publication:state:v1",
  "--binding", "ALERT_STATE", "--remote", "--config", "worker/wrangler.toml",
  "--receipt", ".artifacts/d1-generation-claim.json",
  "--github-output", "/tmp/github-output",
];

function extractFenceCommands(workflow) {
  const lines = workflow.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/node \S*d1_generation_fence\.mjs/.test(lines[index])) continue;
    let command = lines[index].trim();
    while (command.endsWith("\\")) {
      command = `${command.slice(0, -1).trim()} ${lines[++index].trim()}`;
    }
    commands.push(command.split(/\s(?:\|\||&&|;|\|)\s/)[0].trim());
  }
  return commands;
}

// Shell-tokenize a workflow command line, standing placeholder values in for the
// `${{ }}` expressions and `$VAR` references the runner expands before node sees them.
function tokenizeCommand(command) {
  const expanded = command
    .replace(/\$\{\{[^}]*\}\}/g, "placeholder")
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "placeholder");
  return (expanded.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""));
}

test("the workflow claim argv parses with a bare --remote and an explicit --config", () => {
  const args = parseArgs(WORKFLOW_CLAIM_ARGV);
  assert.equal(args.command, "claim");
  assert.equal(args.remote, "true");
  assert.notEqual(args.remote, "false", "a bare --remote must keep the remote KV namespace");
  assert.equal(args.config, "worker/wrangler.toml");
  assert.equal(args.fingerprint, FINGERPRINT_A);
  assert.equal(args.snapshot, ".d1-publication-state/partition-snapshot.json");
  assert.equal(args.holder, "Deploy worker:1:1");
  assert.equal(args.key, "d1-publication:state:v1");
  assert.equal(args.binding, "ALERT_STATE");
  assert.equal(args.receipt, ".artifacts/d1-generation-claim.json");
  assert.equal(args["github-output"], "/tmp/github-output");
});

test("an explicit --remote false still selects the local namespace and a trailing flag stays boolean", () => {
  const args = parseArgs(["node", "fence.mjs", "claim", "--remote", "false", "--config", "worker/wrangler.toml", "--remote-only"]);
  assert.equal(args.remote, "false");
  assert.equal(args.config, "worker/wrangler.toml");
  assert.equal(args["remote-only"], "true");
});

test("a real positional argument is still rejected with the same clear error", () => {
  assert.throws(
    () => parseArgs(["node", "fence.mjs", "claim", "--binding", "ALERT_STATE", "worker/wrangler.toml"]),
    /d1 generation fence: unknown argument worker\/wrangler\.toml/,
  );
});

test("every fence command in the deploy workflow parses under the CLI parser", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const commands = extractFenceCommands(workflow);
  assert.ok(commands.length >= 6, `expected the workflow fence commands, found ${commands.length}`);
  const parsedCommands = new Set();
  for (const command of commands) {
    const argv = tokenizeCommand(command);
    const args = parseArgs(argv);
    assert.ok(
      ["claim", "renew", "abandon", "commit-check", "complete"].includes(args.command),
      `unexpected fence subcommand in: ${command}`,
    );
    assert.equal(args.remote, "true", `--remote must stay boolean in: ${command}`);
    assert.match(args.config, /wrangler\.toml$/, `--config must survive parsing in: ${command}`);
    assert.equal(args.key, "d1-publication:state:v1");
    assert.equal(args.binding, "ALERT_STATE");
    parsedCommands.add(args.command);
  }
  assert.deepEqual([...parsedCommands].sort(), ["abandon", "claim", "commit-check", "complete", "renew"]);
});
