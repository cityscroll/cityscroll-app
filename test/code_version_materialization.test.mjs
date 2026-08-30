import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  materializeCodeChange,
  materializeCodeChanges,
  readableCodeDiff,
  resolveCodeChangeEffectiveDate,
  selectCodeVersionAt,
} from "../site/code_version_materialization.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import {
  buildExplicitLegalChangeGraph,
  renderLegalChangeList,
  renderLegalChangeSummary,
} from "../site/legal_change_edges.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/code_version_materialization.json", import.meta.url), "utf8"));
const provision = fixtures.provision;

function run(name, extra = {}) {
  const fixture = fixtures[name];
  return materializeCodeChange(fixture.change, {
    provision: extra.provision === undefined ? provision : extra.provision,
    as_of: extra.as_of ?? fixture.as_of,
    enacted_at: fixture.enacted_at,
    local_law: extra.local_law,
  });
}

test("ADD preserves identity, source hash, and an effective-date interval", () => {
  const result = run("safe_add", { provision: null });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.provision.id, fixtures.safe_add.change.target.provision_id);
  assert.equal(result.provision.current_text, "Added statutory text.");
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].valid_from, "2026-11-01");
  assert.equal(result.versions[0].valid_to, null);
  assert.equal(result.versions[0].source_ref, "council:local-law:123-2026");
  assert.match(result.versions[0].content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.diff.text, /\+ Added statutory text/);
});

test("AMEND preserves identity, closes the prior version, and starts the new version at effective_at", () => {
  const result = run("safe_amend");
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.provision.id, provision.id);
  assert.equal(result.provision.current_text, "New statutory text.\nSecond paragraph.");
  assert.equal(result.versions.length, 2);
  const previous = result.versions.find((version) => version.valid_to);
  const next = result.versions.find((version) => version.valid_from === "2026-11-01" && !version.valid_to);
  assert.equal(previous.valid_to, "2026-11-01");
  assert.equal(next.valid_from, "2026-11-01");
  assert.equal(previous.text, provision.current_text);
  assert.equal(previous.source_ref, "alp:16-120");
  assert.equal(previous.content_hash, "sha256:old");
  assert.notEqual(next.content_hash, previous.content_hash);
  assert.equal(next.content_hash, "sha256:ae631416cc61354e03118519ac1eb26de26ecc46ba7f5a21d795b125e9d5e27d");
  assert.match(result.diff.text, /- Old statutory text/);
  assert.match(result.diff.text, /\+ New statutory text/);
});

test("law pages label operation, Before, After, and Diff for a safe amendment", () => {
  const result = run("safe_amend");
  const changeHtml = renderLegalChangeList([result.change]);
  assert.match(changeHtml, />AMEND</);
  assert.match(changeHtml, /<strong>Before<\/strong>/);
  assert.match(changeHtml, /<strong>After<\/strong>/);
  assert.match(changeHtml, /<summary>Diff<\/summary>/);
  const page = renderAdminCodeProvisionDocument(provision, {
    changes: [result.change],
    versions: result.versions,
    as_of: "2026-11-01",
  });
  assert.match(page, /New statutory text/);
  assert.match(page, />AMEND</);
  assert.match(page, /<strong>Before<\/strong>/);
  assert.match(page, /<strong>After<\/strong>/);
  assert.match(page, /Diff/);
});

test("multiline statutory patches preserve exact line structure through normalization", () => {
  const result = materializeCodeChange({
    ...fixtures.safe_amend.change,
    patch: {
      before_text: "Old statutory text.\nSecond paragraph.",
      after_text: "New statutory text.\nSecond paragraph amended.",
    },
  }, { provision, as_of: "2026-11-01" });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.after_text, "New statutory text.\nSecond paragraph amended.");
  assert.equal(result.versions.find((version) => !version.valid_to)?.text, result.after_text);
  assert.match(result.diff.text, /- Old statutory text\.\n- Second paragraph\./);
  assert.match(result.diff.text, /\+ New statutory text\.\n\+ Second paragraph amended\./);
});

test("effective dates may be supplied by the Local Law envelope", () => {
  const result = materializeCodeChange({
    ...fixtures.safe_amend.change,
    effective_at: null,
  }, {
    provision,
    as_of: "2027-01-15",
    local_law: { effective_at: "2027-01-15" },
  });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.effective_at, "2027-01-15");
});

test("REPEAL preserves historical addressability and links the repealing law", () => {
  const result = run("safe_repeal");
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.provision.id, provision.id);
  assert.equal(result.provision.status, "repealed");
  assert.equal(result.provision.current_text, "");
  const historical = result.versions.find((version) => version.valid_to === "2026-11-01");
  const inactive = result.versions.find((version) => version.valid_from === "2026-11-01" && !version.valid_to);
  assert.equal(historical.text, provision.current_text);
  assert.equal(historical.source_ref, "alp:16-120");
  assert.equal(historical.content_hash, "sha256:old");
  assert.equal(inactive.text, "");
  assert.equal(inactive.status, "repealed");
  assert.equal(inactive.legal_instrument_id, "local-law:123-2026");
  assert.equal(result.change.legal_instrument_id, "local-law:123-2026");
  const html = renderLegalChangeList([result.change]);
  assert.match(html, />REPEAL</);
  assert.match(html, /Repealing law/);
  assert.match(html, /data-legal-instrument-id="local-law:123-2026"/);
  assert.match(html, /href="\/matters\/79102\/"/);
  const page = renderAdminCodeProvisionDocument(provision, {
    changes: [result.change],
    versions: result.versions,
    as_of: "2026-11-01",
  });
  assert.match(page, /Status: repealed/);
  assert.match(page, /data-code-version-id="/);
  assert.match(page, /Repealing law/);
});

test("delayed and partial/conditional dates keep enacted visibility off current-law text", () => {
  const delayedDate = resolveCodeChangeEffectiveDate(fixtures.delayed.change, {
    enacted_at: fixtures.delayed.enacted_at,
  });
  assert.equal(delayedDate.effective_at, "2026-10-30");
  assert.equal(delayedDate.basis, "source_stated_delayed");

  const delayed = run("delayed");
  assert.equal(delayed.materialization_status, "materialized");
  assert.equal(delayed.effective_at, "2026-10-30");
  assert.equal(delayed.change.state, "enacted");
  assert.equal(delayed.provision.current_text, provision.current_text);
  assert.equal(delayed.provision.status, "current");
  assert.equal(selectCodeVersionAt(delayed.versions, "2026-08-01").text, provision.current_text);
  assert.equal(selectCodeVersionAt(delayed.versions, "2026-10-30").text, "New statutory text.\nSecond paragraph.");
  const delayedPage = renderAdminCodeProvisionDocument(provision, {
    changes: [delayed.change],
    versions: delayed.versions,
    as_of: "2026-08-01",
  });
  const currentSection = delayedPage.match(/<section aria-labelledby="current-text">[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(currentSection, /Old statutory text/);
  assert.doesNotMatch(currentSection, /New statutory text/);
  assert.match(delayedPage, />AMEND</);
  assert.match(delayedPage, /Enacted change/);
  assert.match(delayedPage, /Status: current/);

  const partialDate = resolveCodeChangeEffectiveDate(fixtures.partial.change);
  assert.equal(partialDate.effective_at, null);
  assert.equal(partialDate.resolution, "unresolved");
  const partial = run("partial");
  assert.equal(partial.materialization_status, "unresolved");
  assert.equal(partial.provision.current_text, provision.current_text);
  assert.equal(partial.versions.length, 1);
  assert.equal(partial.versions[0].valid_to, null);
  assert.match(partial.reason, /clause-specific/);

  const conditionalDate = resolveCodeChangeEffectiveDate(fixtures.conditional.change, {
    enacted_at: fixtures.conditional.enacted_at,
  });
  assert.equal(conditionalDate.effective_at, null);
  const conditional = run("conditional");
  assert.equal(conditional.materialization_status, "unresolved");
  assert.equal(conditional.change.materialization_status, "unresolved");
  assert.equal(conditional.provision.current_text, provision.current_text);
  assert.doesNotMatch(JSON.stringify(conditional.versions), /New statutory text/);
});

test("failed patch retains the CodeChange and emits no new version", () => {
  const result = run("patch_failure");
  assert.equal(result.materialization_status, "unresolved");
  assert.equal(result.change.materialization_status, "unresolved");
  assert.equal(result.change.id, fixtures.patch_failure.change.id);
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].text, provision.current_text);
  assert.doesNotMatch(result.versions[0].text, /Fabricated/);
  assert.match(result.reason, /absent|ambiguous/);
  const html = renderLegalChangeList([result.change]);
  assert.match(html, /data-materialization-status="unresolved"/);
  assert.match(html, />AMEND</);
});

test("multi-target projection preserves each discrete result", () => {
  const second = { ...provision, id: "nyc-administrative-code:20-912", citation: "§ 20-912", current_text: "Second old text." };
  const result = materializeCodeChanges([
    fixtures.safe_amend.change,
    {
      ...fixtures.safe_repeal.change,
      id: "law:repeal-2",
      target: { ...fixtures.safe_repeal.change.target, provision_id: second.id, citation: second.citation },
    },
  ], { provisions: [provision, second], as_of: "2026-11-01" });
  assert.equal(result.coverage.changes, 2);
  assert.equal(result.coverage.materialized, 2);
  assert.equal(result.changes[0].materialization_status, "materialized");
  assert.equal(result.provisions[second.id].status, "repealed");
});

test("diff output remains readable for a whole-section replacement", () => {
  const diff = readableCodeDiff("before", "after");
  assert.deepEqual(diff.lines, [
    { kind: "removed", text: "before" },
    { kind: "added", text: "after" },
  ]);
  assert.equal(diff.text, "- before\n+ after");
});

test("a delayed becomes-law clause is resolved without treating enactment as immediate", () => {
  const delayedBecomesLaw = resolveCodeChangeEffectiveDate({
    effective_date_text: "This local law takes effect thirty days after it becomes law.",
    enacted_at: "2026-08-01",
  });
  assert.equal(delayedBecomesLaw.effective_at, "2026-08-31");
});

test("enacted change summaries stay distinct from current-law text", () => {
  const graph = buildExplicitLegalChangeGraph({
    matter: { id: "79102" },
    local_law: {
      id: "local-law:123-2026",
      matter_id: "79102",
      local_law_number: "123",
      enacted_at: "2026-08-01",
      effective_at: "2026-11-01",
    },
    source_text: "Section 16-120 of the administrative code is amended to read as follows.",
    source: { source_ref: "council:local-law:123-2026" },
  });
  const summary = renderLegalChangeSummary(graph);
  assert.match(summary, /What this law changed/);
  assert.match(summary, /Enactment is shown separately from effectiveness/);
});
