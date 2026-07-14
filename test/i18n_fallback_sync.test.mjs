// Characterization test for test/standards/i18n_fallback_sync.py, the gate added in
// crol-staticsync-b2 after a verification pass found index.html's raw pre-JS fallback text
// still reading "Money" / "Money trail" though the i18n.js en dictionary — what every real
// pageview actually renders once applyStrings() runs — had long since moved to
// "Contracts" / "Contract trail". Nothing had caught that drift; this pins the exact
// real-world regression (a data-i18n element's fallback text lagging its dictionary entry)
// against a hermetic fixture so it can never silently reappear.
//
// The gate itself is Python (test/standards/*.py has no JS runtime dependency), so this test
// spawns it against a tiny fixture directory via CROL_FALLBACK_SYNC_ROOT/_PAGES (the gate's
// test-only override, see its own header comment) rather than mutating the real site files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "test", "standards", "i18n_fallback_sync.py");

function runGate(fixtureDir) {
  return spawnSync("python3", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      CROL_FALLBACK_SYNC_ROOT: fixtureDir,
      CROL_FALLBACK_SYNC_PAGES: "index.html",
    },
  });
}

function writeFixture(dir, { tabMoneyFallback, enValue }) {
  writeFileSync(join(dir, "i18n.js"),
    `window.STRINGS = window.STRINGS || {};\n` +
    `window.STRINGS.en = { tab_money: ${JSON.stringify(enValue)} };\n`);
  writeFileSync(join(dir, "index.html"),
    `<button data-i18n="tab_money">${tabMoneyFallback}</button>\n`);
}

test("i18n_fallback_sync: before — flags the real 2026-07-14 drift (fallback stuck on 'Money' after the dictionary moved to 'Contracts')", () => {
  const dir = mkdtempSync(join(tmpdir(), "crol-fallback-sync-"));
  try {
    writeFixture(dir, { tabMoneyFallback: "Money", enValue: "Contracts" });
    const result = runGate(dir);
    assert.notEqual(result.status, 0, "gate must fail when the static fallback lags the dictionary");
    assert.match(result.stderr, /tab_money/);
    assert.match(result.stderr, /'Money'/);
    assert.match(result.stderr, /'Contracts'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i18n_fallback_sync: after — passes once the static fallback is synced to the dictionary", () => {
  const dir = mkdtempSync(join(tmpdir(), "crol-fallback-sync-"));
  try {
    writeFixture(dir, { tabMoneyFallback: "Contracts", enValue: "Contracts" });
    const result = runGate(dir);
    assert.equal(result.status, 0, `gate should pass; stderr: ${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i18n_fallback_sync: flags a data-i18n element whose nested markup can never be translated (children.length !== 0 blocks applyStrings())", () => {
  const dir = mkdtempSync(join(tmpdir(), "crol-fallback-sync-"));
  try {
    writeFileSync(join(dir, "i18n.js"),
      `window.STRINGS = window.STRINGS || {};\n` +
      `window.STRINGS.en = { hint: "Try a title -- or switch to a person." };\n`);
    writeFileSync(join(dir, "index.html"),
      `<div data-i18n="hint">Try a title <b>like this</b> -- or switch to a person.</div>\n`);
    const result = runGate(dir);
    assert.notEqual(result.status, 0, "gate must fail on nested markup inside a plain data-i18n element");
    assert.match(result.stderr, /nested markup/);
    assert.match(result.stderr, /NEVER gets translated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
