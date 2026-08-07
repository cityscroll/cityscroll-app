import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fixture from "./fixtures/entity_resolution/llm_alias_proposals.json" with { type: "json" };
import {
  ALIAS_ACCEPTED_STATUS,
  ALIAS_PROPOSAL_STATUS,
  buildAliasProposalPrompt,
  generateAliasProposals,
  lookupAliasInRegistry,
  promoteAliasProposal,
} from "../entity_resolution/index.mjs";

function registryPath() {
  const dir = mkdtempSync(join(tmpdir(), "crol-alias-proposals-"));
  const path = join(dir, "alias_registry.json");
  writeFileSync(path, JSON.stringify({
    _meta: { registry_version: "v1", description: "fixture" },
    entries: [],
  }, null, 2));
  return { dir, path };
}

test("alias proposal prompt bounds the model to the entity set and review-only output", () => {
  const prompt = buildAliasProposalPrompt(fixture.entities);
  assert.match(prompt, /Prompt version: llm_alias_proposal_v1/);
  assert.match(prompt, /never auto-link/i);
  assert.match(prompt, /vendor:city_record:acme/);
  assert.match(prompt, /Acme Environmental Services LLC/);
  assert.match(prompt, /verified_alias or successor/);
});

test("LLM output persists valid proposals as PROPOSED with evidence and no link effect", async () => {
  const { dir, path } = registryPath();
  try {
    const result = await generateAliasProposals({
      entities: fixture.entities,
      registryPath: path,
      model: "fixture-model",
      runId: "fixture-run-1",
      generatedAt: "2026-08-06T22:00:00.000Z",
      complete: async () => fixture.response,
    });

    assert.equal(result.added.length, 1);
    assert.equal(result.rejected.length, 1);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    const proposal = stored.entries[0];
    assert.equal(proposal.status, ALIAS_PROPOSAL_STATUS);
    assert.equal(proposal.proposal.model, "fixture-model");
    assert.equal(proposal.proposal.run_id, "fixture-run-1");
    assert.equal(proposal.evidence.length, 2);
    assert.equal(lookupAliasInRegistry(stored, "Acme Environmental Services LLC", "Acme Environmental"), null);

    const repeat = await generateAliasProposals({
      entities: fixture.entities,
      registryPath: path,
      complete: async () => fixture.response,
    });
    assert.equal(repeat.added.length, 0);
    assert.equal(repeat.skipped.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only an explicit clerk review promotes a proposal into the policy index", async () => {
  const { dir, path } = registryPath();
  try {
    const result = await generateAliasProposals({
      entities: fixture.entities,
      registryPath: path,
      complete: async () => fixture.response,
    });
    const id = result.added[0].id;
    assert.throws(
      () => promoteAliasProposal({ registryPath: path, proposalId: id }),
      /reviewer is required/,
    );
    assert.equal(
      lookupAliasInRegistry(JSON.parse(readFileSync(path, "utf8")), "Acme Environmental Services LLC", "Acme Environmental"),
      null,
    );

    const promoted = promoteAliasProposal({
      registryPath: path,
      proposalId: id,
      reviewer: "clerk-fixture",
      reviewedAt: "2026-08-06T22:05:00.000Z",
    });
    assert.equal(promoted.status, ALIAS_ACCEPTED_STATUS);
    assert.equal(promoted.reviewer, "clerk-fixture");
    const accepted = lookupAliasInRegistry(
      JSON.parse(readFileSync(path, "utf8")),
      "Acme Environmental Services LLC",
      "Acme Environmental",
    );
    assert.equal(accepted.id, id);
    assert.equal(accepted.status, ALIAS_ACCEPTED_STATUS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
