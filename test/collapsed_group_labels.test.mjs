import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditCollapsedGroupLabels,
  findCollapsedGroupLabelFindings,
  hasCollapsedGroupDescription,
} from "../tools/check-collapsed-group-labels.mjs";

test("collapsed-group label check rejects count-only and bare residual labels", () => {
  for (const label of ["11 near-identical notices", "{n} similar notices", "Other"]) {
    assert.equal(hasCollapsedGroupDescription(label), false, label);
  }
  const findings = findCollapsedGroupLabelFindings(
    'property_cluster_summary: "{n} near-identical notices",',
    "old-property-rendering.js",
  );
  assert.equal(findings.length, 1, "the previous Property label must fail loudly");
});

test("collapsed-group label check accepts labels that name shared content", () => {
  for (const label of [
    "DCAS auction notices — 11 similar",
    "NYPD property clerk notices — {n} similar",
    "Property dispositions · 2025–2026 · 4 grouped",
  ]) {
    assert.equal(hasCollapsedGroupDescription(label), true, label);
  }
});

test("all collapsed-group labels across site lenses describe their content", () => {
  assert.deepEqual(auditCollapsedGroupLabels(), []);
});
