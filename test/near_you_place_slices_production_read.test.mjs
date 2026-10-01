import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionRead = JSON.parse(readFileSync(
  new URL("../docs/evidence/near-you-place-slices/production-read.json", import.meta.url),
));
const receipt = JSON.parse(readFileSync(
  new URL("../docs/evidence/near-you-place-slices/live-readback-receipt.json", import.meta.url),
));

test("place-slices production read-back covers the five borough fixtures", () => {
  assert.equal(productionRead.schema, "cityscroll.near_you_place_slices_production_read.v1");
  assert.equal(productionRead.origin, "https://cityscroll.org");
  assert.equal(productionRead.api_origin, "https://api.cityscroll.org");
  assert.match(productionRead.deployment.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(productionRead.summary, {
    result: "pass",
    fixtures_observed: 5,
    viewport_observations: 10,
  });
  assert.deepEqual(
    productionRead.reads.map((read) => read.fixture),
    ["BK0101", "QN0103", "SI0101", "MN0102", "BX0101"],
  );
  assert.deepEqual(
    productionRead.reads.map((read) => read.served_state),
    [
      "unavailable_source_coverage",
      "unavailable_source_coverage",
      "unavailable_source_coverage",
      "available_records",
      "published_zero",
    ],
  );
});

test("place-slices live receipt is recorded and linked to the production read-back", () => {
  assert.equal(receipt.status, "recorded");
  assert.ok(receipt.assertions.some((row) => row.id === "production-five-fixture-readback" && row.result === "accepted"));
  for (const fixture of receipt.fixtures) {
    assert.equal(fixture.production_readback?.result, "pass");
    assert.equal(fixture.production_readback?.deployment_revision, productionRead.deployment.revision);
  }
});

test("place-slices production read-back passes its fixture checker", () => {
  const output = execFileSync(
    "python3",
    ["tools/capture_near_you_place_slices_production_read.py", "--check-fixtures"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /production read-back passed/);
});

test("place-slices full checker requires retained membership served read-back", () => {
  const membershipUrl = new URL(
    "../docs/evidence/near-you-place-slices/membership-served-read.json",
    import.meta.url,
  );
  let membershipPresent = true;
  try {
    readFileSync(membershipUrl);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      membershipPresent = false;
    } else {
      throw error;
    }
  }
  const result = spawnSync(
    "python3",
    ["tools/capture_near_you_place_slices_production_read.py", "--check"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  if (!membershipPresent) {
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr || ""}${result.stdout || ""}`,
      /membership served read missing|wait for Pages|wait for Worker|does not contain required ancestor/,
    );
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /production read-back passed/);
  assert.match(result.stdout, /membership served read-back passed/);
});

test("place-slices capture tool rejects alternate CLI targets", () => {
  for (const option of ["--site", "--output"]) {
    const result = spawnSync(
      "python3",
      ["tools/capture_near_you_place_slices_production_read.py", option, "alternate"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized arguments/);
  }
});

// The discovery-recovery scenario of the default-local-home capture tool reads
// the same served surfaces; like this read-back it owns its evidence paths and
// accepts no alternate output or site target.
test("discovery-recovery capture scenario rejects alternate CLI targets", () => {
  for (const option of ["--site", "--output", "--manifest"]) {
    const result = spawnSync(
      "python3",
      ["tools/capture_default_local_home_journey.py", "--scenario", "discovery-recovery", option, "alternate"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized arguments/);
  }
});
