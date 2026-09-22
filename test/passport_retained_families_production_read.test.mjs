import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionRead = JSON.parse(readFileSync(
  new URL("../docs/evidence/passport-retained-families/production-read.json", import.meta.url),
));
const fixtureRead = JSON.parse(readFileSync(
  new URL("../docs/evidence/passport-retained-families/fixture-readback.json", import.meta.url),
));

test("retained-family production read-back is linked from its A4 producer", () => {
  const a4 = fixtureRead.assertions.find((assertion) => assertion.id === "A4");
  assert.deepEqual(a4.claim.pages_readback, {
    path: "docs/evidence/passport-retained-families/production-read.json",
    schema: "cityscroll.passport_retained_families_production_read.v1",
    result: "pass",
    route_count: 4,
  });
});

test("retained-family production read-back passes its fixture-linked checker", () => {
  const output = execFileSync(
    "python3",
    ["tools/capture_passport_retained_families_production_read.py", "--check"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /production read-back passed/);
});

test("retained-family production evidence rejects alternate targets", () => {
  for (const option of ["--site", "--output"]) {
    const result = spawnSync(
      "python3",
      ["tools/capture_passport_retained_families_production_read.py", option, "alternate"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized arguments/);
  }
});

test("retained-family checker rejects a substituted detail route", () => {
  const script = `
from tools.capture_passport_retained_families_production_read import FIXTURE, OUTPUT, read_json, validate
receipt = read_json(OUTPUT)
receipt["reads"][0]["route"] = "/"
receipt["reads"][0]["url"] = "https://cityscroll.org/"
try:
    validate(receipt, read_json(FIXTURE))
except AssertionError as error:
    if "canonical production route" not in str(error):
        raise
else:
    raise AssertionError("substituted detail route passed validation")
`;
  execFileSync("python3", ["-c", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
});

test("retained-family production read-back covers four routes at both viewports", () => {
  assert.equal(productionRead.schema, "cityscroll.passport_retained_families_production_read.v1");
  assert.deepEqual(productionRead.summary, {
    result: "pass",
    routes_observed: 4,
    viewport_observations: 8,
  });
  assert.deepEqual(
    productionRead.reads.map((read) => read.family).sort(),
    ["aha", "bhrags", "firematic", "tameer"],
  );
  for (const read of productionRead.reads) {
    const expectedRoute = `/procurements/${encodeURIComponent(read.procurement_id)}`;
    assert.equal(read.result, "pass");
    assert.equal(read.route, expectedRoute);
    assert.equal(read.url, `https://cityscroll.org${expectedRoute}`);
    assert.equal(read.viewports.length, 2);
    assert.match(read.page_html_sha256, /^[0-9a-f]{64}$/);
    assert.match(read.shard.sha256, /^[0-9a-f]{64}$/);
    for (const viewport of read.viewports) {
      assert.equal(viewport.http_status, 200);
      assert.equal(viewport.no_horizontal_overflow, true);
      assert.equal(viewport.result, "pass");
    }
  }
});
