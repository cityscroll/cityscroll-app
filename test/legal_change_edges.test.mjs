import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildExplicitLegalChangeGraph,
  extractExplicitCodeChanges,
  indexLegalChanges,
  materializeCodeChange,
  renderLegalChangeSummary,
  renderLegalChangeList,
} from "../site/legal_change_edges.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import { codeChange } from "../ontology/legal_change.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/legal_change_edges.json", import.meta.url), "utf8"));

function graphFor(fixture) {
  return buildExplicitLegalChangeGraph({
    ...fixture,
    source: { source_ref: fixture.source_ref },
    known_provision_ids: [
      "nyc-administrative-code:16-120",
      "nyc-administrative-code:20-912",
    ],
  });
}

test("ADD creates a prospective matter edge without making an Intro a law", () => {
  const graph = graphFor({ ...fixtures.pending_add, corpus_id: "nyc-administrative-code" });
  assert.equal(graph.local_law, null);
  assert.equal(graph.changes.length, 1);
  assert.equal(graph.changes[0].operation, "add");
  assert.equal(graph.changes[0].state, "prospective");
  assert.equal(graph.changes[0].target.provision_id, "nyc-administrative-code:20-912");
  assert.equal(graph.edges[0].relation, "proposes_change_to");
  assert.equal(graph.edges[0].state, "prospective");
});

test("multi-target and multiple-corpus instructions retain every target", () => {
  const graph = graphFor(fixtures.multi_target);
  assert.deepEqual(graph.changes.map((change) => [change.operation, change.target.corpus_id, change.target.citation]), [
    ["amend", "nyc-administrative-code", "§ 16-120"],
    ["amend", "nyc-administrative-code", "§ 20-912"],
    ["repeal", "nyc-building-code", "§ 28-103.22"],
  ]);
  assert.equal(graph.changes[2].target.provision_id, null);
  assert.equal(graph.changes[2].target.resolution, "unresolved_external_corpus");
  assert.equal(graph.edges.length, 3);
});

test("enacted Local Law remains distinct from its matter and preserves effective date", () => {
  const graph = graphFor(fixtures.enacted);
  assert.equal(graph.matter.id, "79102");
  assert.equal(graph.local_law.id, "local-law:123-2026");
  assert.equal(graph.local_law.matter_id, "79102");
  assert.equal(graph.changes.every((change) => change.state === "enacted"), true);
  assert.equal(graph.changes[0].effective_at, "2026-11-01");
  assert.equal(graph.edges[0].relation, "enacted_as");
  assert.equal(graph.edges.filter((edge) => edge.relation === "contains").length, 2);
  assert.equal(graph.edges.filter((edge) => edge.relation === "targets").length, 2);
});

test("unsupported or implicit policy language produces no change edge", () => {
  assert.deepEqual(extractExplicitCodeChanges({
    matter_id: "79103",
    source_ref: "fixture:implicit",
    source_text: "This bill improves sanitation policy and affects section 16-120.",
  }), []);
});

test("heading amendment is represented as the supported RENAME operation", () => {
  const changes = extractExplicitCodeChanges({
    matter_id: "79104",
    source_ref: "fixture:rename",
    source_text: "The heading of section 16-120 of the administrative code is amended to read as follows.",
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].operation, "rename");
});

test("reverse index keeps proposals and enacted changes separately", () => {
  const pending = graphFor({ ...fixtures.pending_add, corpus_id: "nyc-administrative-code" });
  const enacted = graphFor(fixtures.enacted);
  const index = indexLegalChanges([pending, enacted]);
  assert.equal(index.by_provision["nyc-administrative-code:20-912"].length, 2);
  assert.equal(index.by_matter["79100"][0].local_law, null);
  assert.equal(index.by_matter["79102"][0].local_law.id, "local-law:123-2026");
});

test("matter and provision renderers label prospective changes", () => {
  const pending = graphFor({ ...fixtures.pending_add, corpus_id: "nyc-administrative-code" });
  const summary = renderLegalChangeSummary(pending);
  assert.match(summary, /What this proposal changes/);
  assert.match(summary, /Prospective proposal/);
  assert.match(summary, /not current law/);
  const html = renderAdminCodeProvisionDocument({
    id: "nyc-administrative-code:20-912",
    citation: "§ 20-912",
    current_text: "Current text",
    source: { observed_at: "2026-08-24", content_hash: "sha256:test" },
  }, { changes: pending.changes });
  assert.match(html, /Current proposals/);
  assert.match(html, /data-code-change-state="prospective"/);
  assert.match(html, /Matter timeline/);
  assert.match(html, /Administrative Code § 20-912/);
});

test("an explicit read-as-follows clause carries a whole-provision patch", () => {
  const changes = extractExplicitCodeChanges({
    matter_id: "79105",
    legal_instrument_id: "local-law:124-2026",
    state: "enacted",
    source_ref: "council:local-law:124-2026",
    effective_at: "2026-11-01",
    source_text: "Section 16-120 of the administrative code is amended to read as follows: New complete section text.\nSection 20-912 of the administrative code is amended.",
  });
  assert.equal(changes[0].patch.scope, "whole_provision");
  const result = materializeCodeChange(changes[0], {
    provision: {
      id: "nyc-administrative-code:16-120",
      corpus_id: "nyc-administrative-code",
      citation: "§ 16-120",
      current_text: "Old complete section text.",
      source: { source_ref: "alp:16-120", observed_at: "2026-08-24" },
    },
  });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.after_text, "New complete section text.");
  const rendered = renderLegalChangeList([result.change]);
  assert.match(rendered, /Before/);
  assert.match(rendered, /After/);
  assert.match(rendered, /New complete section text/);
  assert.match(rendered, /data-materialization-status="materialized"/);
});

test("CodeChange normalization preserves multiline statutory patch text", () => {
  const normalized = codeChange({
    id: "fixture:multiline-patch",
    matter_id: "79106",
    operation: "amend",
    target: {
      corpus_id: "nyc-administrative-code",
      provision_id: "nyc-administrative-code:16-120",
      citation: "§ 16-120",
    },
    source: {
      source_ref: "fixture:multiline-patch",
      instruction_text: "Section 16-120 is amended.",
    },
    patch: {
      before_text: "Old line one.\nOld line two.",
      after_text: "New line one.\nNew line two.",
    },
  });
  assert.equal(normalized.patch.before_text, "Old line one.\nOld line two.");
  assert.equal(normalized.patch.after_text, "New line one.\nNew line two.");
});
