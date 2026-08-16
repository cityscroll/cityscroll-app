import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join("test", "standards", "resident_surface_catalog.py");

function run(args) {
  return spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8" });
}

function writeAllowlist(path, exceptions = []) {
  writeFileSync(path, JSON.stringify({
    schema: "cityscroll.resident_surface_allowlist.v1",
    exceptions,
  }));
}

test("resident surface catalog rejects an unreviewed requested shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "resident-surface-"));
  try {
    const fixture = join(dir, "bad.html");
    const allowlist = join(dir, "allowlist.json");
    writeFileSync(fixture, "<!doctype html><body><p>Source fields: Unavailable</p><p>raw_field_name</p></body>");
    writeAllowlist(allowlist);

    const result = run(["--fixture", fixture, "--allowlist", allowlist, "--json"]);
    assert.notEqual(result.status, 0, `fixture must fail: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.leak_counts.unreviewed, {
      implementation_schema: 1,
      reconciliation_disclaimer: 0,
      unavailable_debug_copy: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a matching named reviewed exception clears a requested shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "resident-surface-"));
  try {
    const fixture = join(dir, "reviewed.html");
    const allowlist = join(dir, "allowlist.json");
    writeFileSync(fixture, "<!doctype html><body><p>public_contract_name</p></body>");
    writeAllowlist(allowlist, [{
      id: "reviewed-public-contract-name",
      category: "implementation_schema",
      terms: ["public_contract_name"],
      surface_family: "other",
      surface_kind: "default_document",
      content_mode: "default_reader",
      surface: "fixture:reviewed.html",
      reason: "The fixture models an exact public contract name.",
    }]);

    const result = run(["--fixture", fixture, "--allowlist", allowlist, "--json"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.unreviewed_findings.length, 0);
    assert.equal(report.reviewed_findings[0].exception_id, "reviewed-public-contract-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default copy and opt-in disclosure copy have separate counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "resident-surface-"));
  try {
    const fixture = join(dir, "disclosure.html");
    const allowlist = join(dir, "allowlist.json");
    writeFileSync(
      fixture,
      "<!doctype html><body><p>Plain default copy.</p><details><summary>Technical details</summary><p>joined_record_id</p></details></body>",
    );
    writeAllowlist(allowlist);

    const result = run(["--fixture", fixture, "--allowlist", allowlist, "--json"]);
    assert.notEqual(result.status, 0, "the disclosure finding remains strict");
    const report = JSON.parse(result.stdout);
    assert.equal(report.surface_counts.default_documents, 1);
    assert.equal(report.surface_counts.route_states, 0);
    assert.equal(report.surface_counts.opt_in_disclosures, 1, JSON.stringify(report.errors));
    assert.deepEqual(report.leak_counts.by_content_mode.opt_in_disclosure, {
      implementation_schema: 1,
      reconciliation_disclaimer: 0,
      unavailable_debug_copy: 0,
    });
    assert.deepEqual(report.leak_counts.by_content_mode.default_reader, {
      implementation_schema: 0,
      reconciliation_disclaimer: 0,
      unavailable_debug_copy: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("surface-family and category summaries are stable regardless of fixture order", () => {
  const dir = mkdtempSync(join(tmpdir(), "resident-surface-"));
  try {
    const first = join(dir, "one.html");
    const secondDir = join(dir, "nested");
    mkdirSync(secondDir);
    const second = join(secondDir, "two.html");
    const allowlist = join(dir, "allowlist.json");
    writeFileSync(first, "<!doctype html><body><p>first_field</p></body>");
    writeFileSync(second, "<!doctype html><body><p>This check compares claims.</p></body>");
    writeAllowlist(allowlist);

    const forward = run(["--fixture", first, "--fixture", second, "--allowlist", allowlist, "--json"]);
    const reverse = run(["--fixture", second, "--fixture", first, "--allowlist", allowlist, "--json"]);
    const a = JSON.parse(forward.stdout);
    const b = JSON.parse(reverse.stdout);
    assert.deepEqual(a.surface_counts, b.surface_counts);
    assert.deepEqual(a.leak_counts, b.leak_counts);
    assert.deepEqual(a.leak_counts.by_family.other, {
      implementation_schema: 1,
      reconciliation_disclaimer: 1,
      unavailable_debug_copy: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
