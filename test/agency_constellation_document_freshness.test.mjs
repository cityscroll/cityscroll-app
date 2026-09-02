/**
 * Agency constellation generated-document freshness gate.
 *
 * Proves the committed materialization is reproducible from the owning builder and
 * that the required CI gate fails closed on an altered or missing committed document.
 *
 * Two boundaries this suite pins deliberately:
 *   - Per-agency index.html is a gitignored build artifact, so a clean checkout has
 *     none and the gate must not read its absence as drift.
 *   - A route directory the builder does not emit is not drift either: reviewed route
 *     aliases live under site/agencies/ and are counted by the agency source-identity
 *     contract, so "not emitted" must never imply "delete".
 *
 * The failure modes are reconciled against a synthetic tree under the OS temp
 * directory. This suite never mutates the working copy: `node --test` runs files
 * in parallel and other suites digest working-tree cleanliness.
 *
 *   node --test test/agency_constellation_document_freshness.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  findStaleAgencyArtifacts,
  isCommittedAgencyArtifact,
} from "../tools/build_agency_constellation_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "tools/build_agency_constellation_documents.mjs");
const CI_WORKFLOW = join(ROOT, ".github/workflows/ci.yml");
const CLOCK_FIXTURE = join(ROOT, "test/fixtures/constellation-clock/shifted-clock.cjs");

// A synthetic two-agency materialization, written where nothing else reads.
function withFixtureSite(run) {
  const site = mkdtempSync(join(tmpdir(), "cityscroll-constellation-"));
  try {
    const expected = [];
    for (const agency of ["example-agency", "second-agency"]) {
      for (const name of ["relationships.json", "relationships-data.json"]) {
        const path = join(site, "agencies", agency, name);
        mkdirSync(dirname(path), { recursive: true });
        const content = `{"schema":"cityscroll.agency_relationships.v1","subject_ref":"agency:id:${agency}"}\n`;
        writeFileSync(path, content);
        expected.push([path, content]);
      }
    }
    run({ site, expected });
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
}

describe("agency constellation freshness reconciliation", () => {
  it("reports nothing stale when every committed document matches the builder", () => {
    withFixtureSite(({ site, expected }) => {
      assert.deepEqual(findStaleAgencyArtifacts({ expected, rootDir: site }), []);
    });
  });

  it("reports an altered document as differing", () => {
    withFixtureSite(({ site, expected }) => {
      writeFileSync(expected[0][0], '{"schema":"cityscroll.agency_relationships.v1","altered":true}\n');
      const stale = findStaleAgencyArtifacts({ expected, rootDir: site });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].reason, "differs");
      assert.equal(stale[0].repoPath, join("agencies", "example-agency", "relationships.json"));
    });
  });

  it("reports a deleted document as missing", () => {
    withFixtureSite(({ site, expected }) => {
      rmSync(expected[1][0]);
      const stale = findStaleAgencyArtifacts({ expected, rootDir: site });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].reason, "missing");
      assert.equal(stale[0].repoPath, join("agencies", "example-agency", "relationships-data.json"));
    });
  });

  it("reports an altered and a missing document together so one rebuild clears both", () => {
    withFixtureSite(({ site, expected }) => {
      writeFileSync(expected[0][0], "{}\n");
      rmSync(expected[1][0]);
      const reasons = findStaleAgencyArtifacts({ expected, rootDir: site })
        .map((entry) => entry.reason)
        .sort();
      assert.deepEqual(reasons, ["differs", "missing"]);
    });
  });

  it("leaves a route directory the builder does not emit alone", () => {
    // Reviewed route aliases live under site/agencies/ without being materialized here.
    withFixtureSite(({ site, expected }) => {
      const emitted = expected.filter(([path]) => !path.includes("second-agency"));
      assert.deepEqual(findStaleAgencyArtifacts({ expected: emitted, rootDir: site }), []);
    });
  });
});

describe("the freshness contract's scope", () => {
  it("covers the committed document classes and the companion artifacts", () => {
    for (const path of [
      join(ROOT, "site/agencies/parks-and-recreation/relationships.json"),
      join(ROOT, "site/agencies/parks-and-recreation/relationships-data.json"),
      join(ROOT, "site/data/agency_constellation_lookup.json"),
      join(ROOT, "site/data/agency_route_identity_report.json"),
    ]) {
      assert.equal(isCommittedAgencyArtifact(path), true, path);
    }
  });

  it("excludes the gitignored per-agency page so a clean checkout is not stale", () => {
    // CI checks out without these; comparing them would only pass where a write-mode
    // build had already run.
    assert.equal(
      isCommittedAgencyArtifact(join(ROOT, "site/agencies/parks-and-recreation/index.html")),
      false,
    );
  });
});

describe("the committed tree", () => {
  it("passes the builder's read-only freshness check", () => {
    const result = spawnSync(process.execPath, [BUILDER, "--check"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agency constellation documents are current/);
  });

  // A required gate that reads the ambient clock goes red on the next date
  // rollover with no source change. Mandate predictions and expected-vs-observed
  // are timed against the obligations vintage instead, so the check reproduces
  // a commit on any later day.
  for (const days of ["45", "400"]) {
    it(`stays current when the ambient date is ${days} days ahead`, () => {
      const result = spawnSync(process.execPath, ["--require", CLOCK_FIXTURE, BUILDER, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CONSTELLATION_CLOCK_SHIFT_DAYS: days },
      });
      assert.equal(result.status, 0, result.stderr);
    });
  }
});

describe("required CI wiring", () => {
  const workflow = readFileSync(CI_WORKFLOW, "utf8");

  it("runs the owning builder in read-only check mode", () => {
    assert.match(workflow, /run: node tools\/build_agency_constellation_documents\.mjs --check/);
  });

  it("never runs a write-mode constellation build that could mask the gate", () => {
    const invocations = workflow.match(/node tools\/build_agency_constellation_documents\.mjs[^\n]*/g) || [];
    assert.equal(invocations.length, 1);
    for (const invocation of invocations) assert.match(invocation, /--check/);
  });

  it("cannot be skipped by a path allowlist", () => {
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("jobs:"));
    assert.ok(!/^\s+paths:\s*$/m.test(trigger), "ci.yml must not gate the suite on a path allowlist");
    assert.match(workflow, /if: needs\.changes\.outputs\.unit_full == 'true'/);
  });
});
