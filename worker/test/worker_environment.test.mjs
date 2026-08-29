import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("production Worker routes carry API domains and bounded canonical document paths", () => {
  const production = read("../wrangler.toml");
  assert.doesNotMatch(production, /\[env\.beta/);
  for (const hostname of [
    "api.cityscroll.org",
    ["api.", "crol", "-", "list", ".org"].join(""),
  ]) {
    assert.match(production, new RegExp(`pattern = "${hostname.replaceAll(".", "\\.")}"`));
  }
  assert.match(production, /pattern = "cityscroll\.org\/near-you\*"/);
  assert.match(production, /pattern = "cityscroll\.org\/following\*"/);
  assert.match(production, /pattern = "cityscroll\.org\/prefs\*"/);
  assert.doesNotMatch(production, /pattern = "cityscroll\.org"\s*,\s*custom_domain/);
  assert.doesNotMatch(production, /pattern = "www\.cityscroll\.org"/);
  assert.match(production, /crons\s*=\s*\[\s*"0 8 \* \* \*",\s*"0 10 \* \* \*",\s*"0 13 \* \* \*",?\s*\]/);
  // Production analytics writes must not depend on a secret that can be forgotten —
  // ANALYTICS_ENVIRONMENT=production is a vars gate (field case 2026-07-30: silent drops).
  assert.match(production, /^ANALYTICS_ENVIRONMENT = "production"$/m);

  const deploy = read("../../.github/workflows/deploy-worker.yml");
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /^\s+push:\n\s+branches: \[main\]/m);
  assert.match(deploy, /- "site\/following_view\.mjs"/);
  assert.match(deploy, /- "site\/data\/watch_templates\.json"/);
  assert.doesNotMatch(deploy, /Workers Builds is canonical/);
  assert.doesNotMatch(deploy, /--env beta/);
});
