import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeCodeChange,
  materializeCodeChanges,
  readableCodeDiff,
  resolveCodeChangeEffectiveDate,
} from "../site/code_version_materialization.mjs";

function change(operation, overrides = {}) {
  return {
    schema: "cityscroll.code_change.v1",
    id: `local-law:123-2026:${operation}`,
    operation,
    state: "enacted",
    legal_instrument_id: "local-law:123-2026",
    target: {
      corpus_id: "nyc-administrative-code",
      provision_id: "nyc-administrative-code:16-120",
      citation: "§ 16-120",
    },
    source: {
      source_ref: "council:local-law:123-2026",
      instruction_text: "Section 16-120 is amended.",
      observed_at: "2026-08-24",
    },
    effective_at: "2026-11-01",
    ...overrides,
  };
}

const provision = {
  schema: "cityscroll.code_provision.v1",
  id: "nyc-administrative-code:16-120",
  corpus_id: "nyc-administrative-code",
  citation: "§ 16-120",
  heading: "Receptacles",
  level: "section",
  status: "current",
  current_text: "Old statutory text.\nSecond paragraph.",
  source: { source_ref: "alp:16-120", observed_at: "2026-08-24", content_hash: "sha256:old" },
};

test("AMEND preserves identity and creates an effective-date version boundary", () => {
  const result = materializeCodeChange(change("amend", {
    patch: { before_text: "Old statutory text.", after_text: "New statutory text." },
  }), { provision });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.provision.id, provision.id);
  assert.equal(result.provision.current_text, "New statutory text.\nSecond paragraph.");
  assert.equal(result.versions.length, 2);
  const previous = result.versions.find((version) => version.valid_to);
  const next = result.versions.find((version) => version.valid_from === "2026-11-01");
  assert.equal(previous.valid_to, "2026-11-01");
  assert.equal(next.valid_from, "2026-11-01");
  assert.equal(previous.text, provision.current_text);
  assert.match(result.diff.text, /- Old statutory text/);
  assert.match(result.diff.text, /\+ New statutory text/);
  assert.equal(next.content_hash, "sha256:ae631416cc61354e03118519ac1eb26de26ecc46ba7f5a21d795b125e9d5e27d");
  assert.notEqual(previous.content_hash, next.content_hash);
});

test("multiline statutory patches preserve exact line structure through normalization", () => {
  const result = materializeCodeChange(change("amend", {
    patch: {
      before_text: "Old statutory text.\nSecond paragraph.",
      after_text: "New statutory text.\nSecond paragraph amended.",
    },
  }), { provision });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.after_text, "New statutory text.\nSecond paragraph amended.");
  assert.equal(result.versions.find((version) => version.valid_from)?.text, result.after_text);
  assert.match(result.diff.text, /- Old statutory text\.\n- Second paragraph\./);
  assert.match(result.diff.text, /\+ New statutory text\.\n\+ Second paragraph amended\./);
});

test("effective dates may be supplied by the Local Law envelope", () => {
  const result = materializeCodeChange(change("amend", {
    effective_at: null,
    patch: { before_text: "Old statutory text.", after_text: "New statutory text." },
  }), {
    provision,
    local_law: { effective_at: "2027-01-15" },
  });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.effective_at, "2027-01-15");
});

test("REPEAL closes the active version without deleting the provision", () => {
  const result = materializeCodeChange(change("repeal"), { provision });
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.provision.id, provision.id);
  assert.equal(result.provision.status, "repealed");
  assert.equal(result.provision.current_text, "");
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].valid_to, "2026-11-01");
  assert.equal(result.change.legal_instrument_id, "local-law:123-2026");
});

test("delayed and conditional dates never fall back to enactment", () => {
  const delayed = resolveCodeChangeEffectiveDate({
    effective_date_text: "This local law takes effect ninety days after enactment.",
    enacted_at: "2026-08-01",
  });
  assert.equal(delayed.effective_at, "2026-10-30");
  assert.equal(delayed.basis, "source_stated_delayed");
  const delayedBecomesLaw = resolveCodeChangeEffectiveDate({
    effective_date_text: "This local law takes effect thirty days after it becomes law.",
    enacted_at: "2026-08-01",
  });
  assert.equal(delayedBecomesLaw.effective_at, "2026-08-31");

  const conditional = resolveCodeChangeEffectiveDate({
    effective_date_text: "This section takes effect upon certification by the commissioner.",
    enacted_at: "2026-08-01",
  });
  assert.equal(conditional.effective_at, null);
  assert.equal(conditional.resolution, "unresolved");

  const partial = resolveCodeChangeEffectiveDate({
    effective_date_text: "Subdivision a takes effect January 1, 2027 and subdivision b takes effect February 1, 2027.",
  });
  assert.equal(partial.effective_at, null);
  assert.equal(partial.resolution, "unresolved");

  const enactedOnly = materializeCodeChange(change("amend", {
    effective_at: null,
    effective_date_text: "This section takes effect upon certification.",
    patch: { before_text: "Old statutory text.", after_text: "New statutory text." },
  }), { provision, enacted_at: "2026-08-01" });
  assert.equal(enactedOnly.materialization_status, "unresolved");
  assert.equal(enactedOnly.versions.length, 1);
  assert.equal(enactedOnly.versions[0].valid_to, null);
});

test("failed patch retains the CodeChange and emits no new version", () => {
  const result = materializeCodeChange(change("amend", {
    patch: { before_text: "Text that is not present.", after_text: "Fabricated text must not appear." },
  }), { provision });
  assert.equal(result.materialization_status, "unresolved");
  assert.equal(result.change.materialization_status, "unresolved");
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].text, provision.current_text);
  assert.doesNotMatch(result.versions[0].text, /Fabricated/);
  assert.match(result.reason, /absent|ambiguous/);
});

test("multi-target projection preserves each discrete result", () => {
  const second = { ...provision, id: "nyc-administrative-code:20-912", citation: "§ 20-912", current_text: "Second old text." };
  const result = materializeCodeChanges([
    change("amend", { id: "law:amend-1", patch: { before_text: "Old statutory text.", after_text: "First new text." } }),
    change("repeal", {
      id: "law:repeal-2",
      target: { ...change("repeal").target, provision_id: second.id, citation: second.citation },
    }),
  ], { provisions: [provision, second] });
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
