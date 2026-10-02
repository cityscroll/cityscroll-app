/**
 * Production discover-journey census for connected histories.
 *
 *   node --test test/connected_histories_discover_journeys_production_read.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { retainedMeasurementStatus } from "../tools/repository_revision.mjs";

const ROOT = process.cwd();
const OUT = "docs/evidence/connected-histories/discover-journeys-readback.json";
const TOOL = "tools/capture_connected_histories_discover_journeys_production_read.py";
const SCHEMA = "cityscroll.connected_histories_discover_journeys.v1";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

function runPython(args, { input = null, env = process.env } = {}) {
  return spawnSync("python3", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    env: { ...env },
  });
}

test("retained discover-journeys observation matches the declared schema and census denominators", () => {
  const observation = readJson(OUT);
  assert.equal(observation.schema, SCHEMA);
  assert.match(observation.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(observation.served_revision, /^[0-9a-f]{40}$/);
  assert.match(observation.required_landed_commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof observation.census.journeys_attempted, "number");
  assert.equal(typeof observation.census.journeys_satisfied, "number");
  assert.ok(Object.prototype.hasOwnProperty.call(observation.census, "journeys_attempted"));
  assert.ok(Object.prototype.hasOwnProperty.call(observation.census, "journeys_satisfied"));
  assert.equal(observation.journeys.length, observation.census.journeys_attempted);
  assert.equal(
    observation.journeys.filter((row) => row.satisfied === true).length,
    observation.census.journeys_satisfied,
  );
  assert.equal(observation.census.journeys_attempted, 18);
  assert.ok(!("result" in observation));
  assert.ok(!("verdict" in observation));
  assert.ok(!("passed" in observation));
  assert.equal(observation.provenance.schema, "cityscroll.production_provenance.v1");
  assert.equal(observation.provenance.evidence_class, "live-production-read");
  assert.equal(observation.provenance.isolated, false);
  assert.equal(observation.image_binaries_committed, false);
});

test("--check accepts the retained production observation", () => {
  const result = runPython([TOOL, "--check"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /discover-journeys production read-back passed/);
});

test("checker refuses synthetic or fixture provenance", () => {
  const observation = readJson(OUT);
  const dir = mkdtempSync(join(tmpdir(), "discover-journeys-synthetic-"));
  try {
    for (const mutate of [
      (payload) => {
        payload.provenance.evidence_class = "synthetic";
        payload.provenance.isolated = true;
      },
      (payload) => {
        payload.provenance.environment = "fixture";
        payload.provenance.isolated = true;
      },
      (payload) => {
        delete payload.provenance;
      },
    ]) {
      const copy = structuredClone(observation);
      mutate(copy);
      const path = join(dir, "bad.json");
      writeFileSync(path, `${JSON.stringify(copy, null, 2)}\n`);
      const result = runPython([TOOL, "--check", "--output", path]);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(
        result.stderr,
        /fixture\/rehearsal\/synthetic provenance|production provenance not retained/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checker refuses absent census counts rather than treating them as zero", () => {
  const observation = readJson(OUT);
  const dir = mkdtempSync(join(tmpdir(), "discover-journeys-absent-counts-"));
  try {
    for (const field of ["journeys_attempted", "journeys_satisfied"]) {
      const copy = structuredClone(observation);
      delete copy.census[field];
      const path = join(dir, `${field}.json`);
      writeFileSync(path, `${JSON.stringify(copy, null, 2)}\n`);
      const result = runPython([TOOL, "--check", "--output", path]);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, new RegExp(`${field} is absent rather than zero`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production read refuses an unpinned invocation at runtime", () => {
  const result = runPython([TOOL, "--production"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--production requires --landed-commit/);
});

const PRODUCTION_HARNESS = String.raw`
import json, os, subprocess, sys, tempfile
from pathlib import Path

for key in [key for key in os.environ if key.startswith("GIT_")]:
    del os.environ[key]
ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / "tools"))
import capture_connected_histories_discover_journeys_production_read as capture

request = json.loads(sys.argv[2])
for name in request.get("neuter", []):
    setattr(capture, name, lambda *args, **kwargs: None)

repo = tempfile.mkdtemp(prefix="discover-journeys-refusals-")

def git(*args):
    return subprocess.run(
        ["git", "-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()

def fake_journeys(_base):
    rows = []
    for profile, _w, _h, _t in capture.PROFILES:
        for family_id, query, title in capture.CASES:
            rows.append({
                "family_id": family_id,
                "title": title,
                "query": query,
                "profile": profile,
                "route": capture.route_for(query),
                "viewport": {"width": 1440, "height": 900, "has_touch": False},
                "satisfied": True,
                "runtime": {"query": query, "state": "ready", "family": family_id},
                "observation": {},
            })
    return rows

try:
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "landed")
    landed = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "later")
    later = git("rev-parse", "HEAD")
    git("checkout", "-q", "-b", "side", landed)
    git("commit", "-q", "--allow-empty", "-m", "unmerged")
    side = git("rev-parse", "HEAD")
    git("checkout", "-q", "main")

    def run(case):
        pin, start, end = landed, landed, landed
        relations_type, relations_body = "application/json", json.dumps({"generated_at": "2026-09-26T00:00:00.000Z"}).encode("utf-8")
        rays = None
        journey_runner = fake_journeys
        if case == "non_main_pin":
            pin = side
        elif case == "served_revision_lacks_landed_commit":
            pin = later
        elif case == "absent_served_data":
            relations_type, relations_body = "text/html; charset=utf-8", b"<!doctype html><title>CityScroll</title>"
        elif case == "incomplete_journey_census":
            def journey_runner(_base):
                rows = fake_journeys(_base)
                rows.pop()
                return rows
        elif case == "revision_changed_during_read":
            end = later
        elif case == "missing_edge_receipt":
            rays = ["fixture-ray-1", "fixture-ray-2", "fixture-ray-3", "fixture-ray-4", None]
        elif case == "repeated_edge_receipt":
            rays = ["fixture-ray-1"] * 5
        elif case != "control":
            raise SystemExit(f"unknown case {case}")

        answers = [
            ("application/json", json.dumps({"source_commit_sha": start}).encode("utf-8")),
            (relations_type, relations_body),
            ("application/json", json.dumps({"generated_at": "2026-09-26T00:00:00.000Z"}).encode("utf-8")),
            ("application/json", json.dumps({"generated_at": "2026-09-26T00:00:00.000Z"}).encode("utf-8")),
            ("application/json", json.dumps({"source_commit_sha": end}).encode("utf-8")),
        ]
        served = []

        def get(url):
            index = len(served)
            content_type, answer = answers[index]
            served.append(url)
            ray = rays[index] if rays else f"fixture-ray-{index + 1}"
            headers = {"Content-Type": content_type, "Date": "Thu, 02 Oct 2026 12:00:00 GMT"}
            if ray:
                headers["CF-Ray"] = ray
            return {"status": 200, "headers": headers, "body": answer}

        try:
            read = capture.production_read(
                "https://cityscroll.org",
                pin,
                get=get,
                journey_runner=journey_runner,
                cwd=Path(repo),
                main_ref="main",
                repository_revision=landed,
                observed_at="2026-10-02T12:00:00Z",
            )
        except Exception as error:
            return {"refused": True, "error_type": type(error).__name__, "message": str(error)}
        return {
            "refused": False,
            "journeys_attempted": read["census"]["journeys_attempted"],
            "journeys_satisfied": read["census"]["journeys_satisfied"],
            "revision_pin": read["revision_pin"]["state"],
            "receipt_rays": [receipt["edge_ray"] for receipt in read["request_receipts"]],
        }

    print(json.dumps({case: run(case) for case in request["cases"]}))
finally:
    subprocess.run(["rm", "-rf", repo], check=False)
`;

function productionOutcomes(cases, { neuter = [] } = {}) {
  const result = runPython(["-c", PRODUCTION_HARNESS, ROOT, JSON.stringify({ cases, neuter })]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const REFUSALS = {
  non_main_pin: { type: "WrongPinError", message: /is not reachable from the default branch/ },
  served_revision_lacks_landed_commit: {
    type: "DeployPendingError",
    message: /does not contain required ancestor/,
  },
  absent_served_data: {
    type: "ServedDataMissingError",
    message: /served history materialization absent .*content-type/,
  },
  incomplete_journey_census: {
    type: "ServedDataMissingError",
    message: /discover-journey census is incomplete: 17 journeys, expected 18/,
  },
  revision_changed_during_read: {
    type: "ServedRevisionChangedError",
    message: /served revision changed during the production read/,
  },
  missing_edge_receipt: {
    type: "RequestReceiptError",
    message: /missing its own edge ray receipt/,
  },
  repeated_edge_receipt: {
    type: "RequestReceiptError",
    message: /edge ray receipts are not distinct/,
  },
};

const controlBundle = productionOutcomes(["control", ...Object.keys(REFUSALS)]);

test("production read control completes the eighteen-journey census with exact pins", () => {
  const control = controlBundle.control;
  assert.equal(control.refused, false, JSON.stringify(control));
  assert.equal(control.journeys_attempted, 18);
  assert.equal(control.journeys_satisfied, 18);
  assert.equal(control.revision_pin, "exact");
  assert.equal(control.receipt_rays.length, 5);
});

for (const name of Object.keys(REFUSALS)) {
  test(`production read refuses ${name.replaceAll("_", " ")}`, () => {
    const outcome = controlBundle[name];
    const expected = REFUSALS[name];
    assert.equal(outcome.refused, true, `${name} must refuse; completed instead: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.error_type, expected.type);
    assert.match(outcome.message, expected.message);
  });
}

test("neutering require_distinct_receipts makes the receipt refusals stop firing", () => {
  const outcomes = productionOutcomes(
    ["control", "missing_edge_receipt", "repeated_edge_receipt"],
    { neuter: ["require_distinct_receipts"] },
  );
  assert.equal(outcomes.control.refused, false);
  assert.equal(
    outcomes.missing_edge_receipt.refused,
    false,
    "neutering the receipt guard must let a missing ray complete",
  );
  assert.equal(
    outcomes.repeated_edge_receipt.refused,
    false,
    "neutering the receipt guard must let a repeated ray complete",
  );
});

test("retained observation pins are ancestors of HEAD with unchanged producer bytes", () => {
  const observation = readJson(OUT);
  assert.match(observation.repository_revision, /^[0-9a-f]{40}$/);
  const landedAncestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", observation.required_landed_commit, "HEAD"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(landedAncestor.status, 0, "required landed commit must be an ancestor of HEAD");
  const servedAncestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", observation.served_revision, "origin/main"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(servedAncestor.status, 0, "served revision must be reachable from origin/main");
  const producerInput = observation.measurement_provenance.inputs.find((row) => row.path === TOOL);
  assert.ok(producerInput, "measurement provenance must name the producer");
  const status = retainedMeasurementStatus(ROOT, {
    revision: observation.repository_revision,
    inputs: [producerInput],
  });
  assert.equal(status.ok, true, `${status.reason}: ${status.changedInputs.join(", ")}`);
});
