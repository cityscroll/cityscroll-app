/**
 * Shared deployed-capture ancestor guard: landed pins on the default branch,
 * Pages artifact-manifest surface, and wrong-pin vs wait-for-deploy messages.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const HELPER = join(ROOT, "tools/deployed_capture_ancestor.py");

const SUBJECT_LANDED = "cb878a22f23b88908b7f4173c97fec71569367bc";
const KENSINGTON_LANDED = "c66960422d9c70a12db4f9e1a79651f35153adc7";
const PRE_SQUASH_SUBJECT = "20df28b565f7c3da6a0203a5483319237ee81fe6";
const PRE_SQUASH_KENSINGTON = "3da4739199ec09002249e623adc49f4831438622";
const PRE_DELIVERY_MAIN = "e74f72e951f5ea23ed32d66ffb9901ffd0e58088";

function originAvailable() {
  return (
    spawnSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], {
      cwd: ROOT,
      stdio: "ignore",
    }).status === 0
  );
}

function runPython(code) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return result;
}

function helperPrelude() {
  return `
import sys
from pathlib import Path
ROOT = Path(${JSON.stringify(ROOT)})
sys.path.insert(0, str(ROOT / "tools"))
from deployed_capture_ancestor import (
    DeployPendingError,
    ServedDataMissingError,
    WrongPinError,
    load_recorded_delivery,
    meeting_has_subject_assertions,
    require_served_meeting_subject_assertions,
    require_served_page_revision_contains_delivery,
    resolve_landed_ancestor,
    revision_contains_ancestor,
    served_page_revision,
)
`;
}

const SEPT14_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const SUBJECT_ADDRESS = "461 Coney Island Avenue";

test("recorded deliveries pin the landed squash merges on the page surface", () => {
  const subject = spawnSync(
    "python3",
    [
      "-c",
      `${helperPrelude()}
print(load_recorded_delivery(ROOT / "docs/evidence/near-you-subject-property-journey/delivery.json"))
`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const kensington = spawnSync(
    "python3",
    [
      "-c",
      `${helperPrelude()}
print(load_recorded_delivery(ROOT / "docs/evidence/near-you-kensington-wider-district/delivery.json"))
`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(subject.status, 0, subject.stderr || subject.stdout);
  assert.equal(kensington.status, 0, kensington.stderr || kensington.stdout);
  assert.equal(subject.stdout.trim(), SUBJECT_LANDED);
  assert.equal(kensington.stdout.trim(), KENSINGTON_LANDED);
});

test("guard accepts a page revision that contains the landed merge commit", (t) => {
  if (!originAvailable()) {
    t.skip("origin/main is unavailable");
    return;
  }
  const main = spawnSync("git", ["rev-parse", "origin/main"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const result = runPython(`${helperPrelude()}
ancestor = resolve_landed_ancestor(${JSON.stringify(SUBJECT_LANDED)}, cwd=ROOT)
assert ancestor == ${JSON.stringify(SUBJECT_LANDED)}
assert revision_contains_ancestor(ancestor, ${JSON.stringify(main)}, cwd=ROOT)
assert revision_contains_ancestor(${JSON.stringify(KENSINGTON_LANDED)}, ${JSON.stringify(main)}, cwd=ROOT)
payload = {"source_commit_sha": ${JSON.stringify(main)}}
rev = require_served_page_revision_contains_delivery(
    "https://example.test/",
    ${JSON.stringify(SUBJECT_LANDED)},
    cwd=ROOT,
    fetch_json=lambda url: payload,
)
assert rev == ${JSON.stringify(main)}
print("ok")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("guard refuses a page revision that lacks the landed merge with wait-for-deploy", (t) => {
  if (!originAvailable()) {
    t.skip("origin/main is unavailable");
    return;
  }
  const result = runPython(`${helperPrelude()}
payload = {"source_commit_sha": ${JSON.stringify(PRE_DELIVERY_MAIN)}}
try:
    require_served_page_revision_contains_delivery(
        "https://example.test/",
        ${JSON.stringify(SUBJECT_LANDED)},
        cwd=ROOT,
        fetch_json=lambda url: payload,
    )
except DeployPendingError as error:
    message = str(error)
    assert "wait for Pages deploy" in message
    assert "pin is wrong" not in message
    assert ${JSON.stringify(SUBJECT_LANDED)} in message
    assert ${JSON.stringify(PRE_DELIVERY_MAIN)} in message
    print("ok")
else:
    raise SystemExit("expected DeployPendingError")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("unreachable pin is rejected as wrong pin, not wait-for-deploy", (t) => {
  if (!originAvailable()) {
    t.skip("origin/main is unavailable");
    return;
  }
  for (const pin of [PRE_SQUASH_SUBJECT, PRE_SQUASH_KENSINGTON]) {
    const result = runPython(`${helperPrelude()}
try:
    resolve_landed_ancestor(${JSON.stringify(pin)}, cwd=ROOT)
except WrongPinError as error:
    message = str(error)
    assert "pin is wrong" in message
    assert "not reachable from the default branch" in message
    assert "wait for Pages deploy" not in message
    print("ok")
else:
    raise SystemExit("expected WrongPinError")
`);
    assert.equal(result.status, 0, `${pin}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, /ok/);
  }

  const pendingWithWrongPin = runPython(`${helperPrelude()}
payload = {"source_commit_sha": ${JSON.stringify(PRE_DELIVERY_MAIN)}}
try:
    require_served_page_revision_contains_delivery(
        "https://example.test/",
        ${JSON.stringify(PRE_SQUASH_SUBJECT)},
        cwd=ROOT,
        fetch_json=lambda url: payload,
    )
except WrongPinError as error:
    message = str(error)
    assert "pin is wrong" in message
    assert "wait for Pages deploy" not in message
    print("ok")
else:
    raise SystemExit("expected WrongPinError before deploy-pending check")
`);
  assert.equal(pendingWithWrongPin.status, 0, pendingWithWrongPin.stderr || pendingWithWrongPin.stdout);
  assert.match(pendingWithWrongPin.stdout, /ok/);
});

test("served_page_revision reads the Pages artifact-manifest surface", () => {
  const result = runPython(`${helperPrelude()}
seen = []
def fetch(url):
    seen.append(url)
    return {"source_commit_sha": ${JSON.stringify(SUBJECT_LANDED)}}
rev = served_page_revision("https://cityscroll.org/", fetch_json=fetch)
assert rev == ${JSON.stringify(SUBJECT_LANDED)}
assert seen == ["https://cityscroll.org/artifact-manifest.json"]
print("ok")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("helper module is importable as a script path", () => {
  assert.equal(
    spawnSync("python3", ["-c", `import ast; ast.parse(open(${JSON.stringify(HELPER)}).read())`], {
      cwd: ROOT,
      encoding: "utf8",
    }).status,
    0,
  );
});

test("meeting_has_subject_assertions accepts location_assertions or agenda_subject_places", () => {
  const result = runPython(`${helperPrelude()}
assert meeting_has_subject_assertions({
    "location_assertions": [{"role": "subject_property", "original_address": ${JSON.stringify(SUBJECT_ADDRESS)}}]
}, subject_address=${JSON.stringify(SUBJECT_ADDRESS)})
assert meeting_has_subject_assertions({
    "agenda_subject_places": [{"original_address": ${JSON.stringify(SUBJECT_ADDRESS)}}]
}, subject_address=${JSON.stringify(SUBJECT_ADDRESS)})
assert not meeting_has_subject_assertions({
    "location_assertions": [{"role": "venue", "original_address": "1625 Ocean Avenue"}]
}, subject_address=${JSON.stringify(SUBJECT_ADDRESS)})
assert not meeting_has_subject_assertions({"location_memberships": [{"role": "subject_property"}]}, subject_address=${JSON.stringify(SUBJECT_ADDRESS)})
print("ok")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("served subject data precondition refuses catalog without subject assertions", () => {
  const result = runPython(`${helperPrelude()}
payload = {
    "rows": [{
        "meeting_id": ${JSON.stringify(SEPT14_ID)},
        "location_memberships": [{"role": "subject_property"}],
        "venue": {"address": "1625 Ocean Avenue"},
    }]
}
try:
    require_served_meeting_subject_assertions(
        "https://example.test/",
        meeting_id=${JSON.stringify(SEPT14_ID)},
        subject_address=${JSON.stringify(SUBJECT_ADDRESS)},
        fetch_json=lambda url: payload,
    )
except ServedDataMissingError as error:
    message = str(error)
    assert "lacks subject_property location_assertions" in message
    assert "agenda_subject_places" in message
    assert ${JSON.stringify(SUBJECT_ADDRESS)} in message
    assert "wait for Pages deploy" not in message
    print("ok")
else:
    raise SystemExit("expected ServedDataMissingError")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("served subject data precondition accepts catalog with agenda_subject_places", () => {
  const result = runPython(`${helperPrelude()}
payload = {
    "rows": [{
        "meeting_id": ${JSON.stringify(SEPT14_ID)},
        "agenda_subject_places": [{"original_address": ${JSON.stringify(SUBJECT_ADDRESS)}}],
    }]
}
row = require_served_meeting_subject_assertions(
    "https://example.test/",
    meeting_id=${JSON.stringify(SEPT14_ID)},
    subject_address=${JSON.stringify(SUBJECT_ADDRESS)},
    fetch_json=lambda url: payload,
)
assert row["meeting_id"] == ${JSON.stringify(SEPT14_ID)}
print("ok")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("recorded delivery rejects a non-pages surface", () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-delivery-"));
  try {
    const path = join(directory, "delivery.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: "cityscroll.capture_delivery.v1",
        public_alias: "example",
        landed_commit: SUBJECT_LANDED,
        surface: "worker",
      }),
    );
    const result = runPython(`${helperPrelude()}
try:
    load_recorded_delivery(${JSON.stringify(path)})
except WrongPinError as error:
    assert "pages" in str(error)
    print("ok")
else:
    raise SystemExit("expected WrongPinError for worker surface")
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
