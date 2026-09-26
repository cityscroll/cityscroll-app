/**
 * Cross-packet capture image provenance: refuse silent reuse of digests that
 * already appear in the retained evidence tree or in this manifest's previous
 * committed version unless the row carries reused_from.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();

function runPython(code) {
  return spawnSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
}

function helperPrelude() {
  return `
import json
import sys
from pathlib import Path
ROOT = Path(${JSON.stringify(ROOT)})
sys.path.insert(0, str(ROOT / "tools"))
from capture_image_provenance import (
    CommittedManifestDigests,
    collect_retained_image_digests,
    refuse_silent_image_reuse,
)
`;
}

function writeManifest(dir, relativePath, manifest) {
  const full = join(dir, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return full;
}

test("positive control: digest from another packet is refused without reused_from", () => {
  const tmp = mkdtempSync(join(tmpdir(), "capture-image-provenance-"));
  try {
    const foreignDigest = "aa".repeat(32);
    writeManifest(tmp, "other-feature/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "other-feature",
      captures: [
        {
          name: "foreign-row",
          sha256: foreignDigest,
          screenshot_url: "https://example.test/foreign.png",
        },
      ],
    });
    const candidatePath = writeManifest(tmp, "near-you-kensington-wider-district/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "near-you-kensington-wider-district",
      capture_run_id: "run-new",
      captures: [
        {
          name: "kensington-detail-desktop",
          sha256: foreignDigest,
          screenshot_url: "https://example.test/copied.png",
        },
      ],
    });

    const result = runPython(`${helperPrelude()}
evidence = Path(${JSON.stringify(tmp)})
manifest = json.loads(Path(${JSON.stringify(candidatePath)}).read_text())
try:
    refuse_silent_image_reuse(
        manifest,
        evidence_root=evidence,
        manifest_path=Path(${JSON.stringify(candidatePath)}),
        previous=None,
    )
except SystemExit as error:
    print(str(error))
    raise SystemExit(2)
raise SystemExit("expected refusal for foreign digest")
`);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stdout, /already appears in retained evidence/);
    assert.match(result.stdout, /other-feature/);
    assert.match(result.stdout, /without reused_from/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("positive control: digest from previous committed version is refused for a new run", () => {
  const previousDigest = "bb".repeat(32);
  const result = runPython(`${helperPrelude()}
manifest = {
    "schema": "cityscroll.render_capture_manifest.v1",
    "feature": "near-you-kensington-wider-district",
    "capture_run_id": "run-new",
    "captures": [
        {
            "name": "kensington-meetings-desktop",
            "sha256": ${JSON.stringify(previousDigest)},
            "screenshot_url": "https://example.test/list.png",
        }
    ],
}
previous = CommittedManifestDigests(
    digests=frozenset({${JSON.stringify(previousDigest)}}),
    capture_run_id="run-old",
    source="HEAD:docs/evidence/near-you-kensington-wider-district/capture-manifest.json",
)
try:
    refuse_silent_image_reuse(
        manifest,
        evidence_root=Path(${JSON.stringify(ROOT)}) / "docs" / "evidence",
        manifest_path=None,
        previous=previous,
        foreign_index={},
    )
except SystemExit as error:
    print(str(error))
    raise SystemExit(2)
raise SystemExit("expected refusal for previous-version digest")
`);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stdout, /previous committed version/);
  assert.match(result.stdout, /without reused_from/);
});

test("clean case: unique digests with a new run id are accepted", () => {
  const tmp = mkdtempSync(join(tmpdir(), "capture-image-provenance-clean-"));
  try {
    writeManifest(tmp, "other-feature/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "other-feature",
      captures: [
        {
          name: "foreign-row",
          sha256: "cc".repeat(32),
          screenshot_url: "https://example.test/foreign.png",
        },
      ],
    });
    const candidatePath = writeManifest(tmp, "near-you-kensington-wider-district/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "near-you-kensington-wider-district",
      capture_run_id: "run-new",
      captures: [
        {
          name: "kensington-meetings-desktop",
          sha256: "dd".repeat(32),
          screenshot_url: "https://example.test/list.png",
        },
        {
          name: "kensington-detail-desktop",
          sha256: "ee".repeat(32),
          screenshot_url: "https://example.test/detail.png",
        },
      ],
    });
    const result = runPython(`${helperPrelude()}
evidence = Path(${JSON.stringify(tmp)})
manifest = json.loads(Path(${JSON.stringify(candidatePath)}).read_text())
previous = CommittedManifestDigests(
    digests=frozenset({"ff" * 32}),
    capture_run_id="run-old",
    source="HEAD:fixture",
)
refuse_silent_image_reuse(
    manifest,
    evidence_root=evidence,
    manifest_path=Path(${JSON.stringify(candidatePath)}),
    previous=previous,
)
print("ok")
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "ok");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reused_from rows may repeat a foreign digest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "capture-image-provenance-reuse-"));
  try {
    const foreignDigest = "11".repeat(32);
    writeManifest(tmp, "segmented-meeting-detail/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "segmented-meeting-detail",
      captures: [
        {
          name: "m3-desktop-enabled",
          screenshot_sha256: foreignDigest,
          screenshot_url: "https://example.test/snzlc1.png",
        },
      ],
    });
    const candidatePath = writeManifest(tmp, "near-you-kensington-wider-district/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "near-you-kensington-wider-district",
      capture_run_id: "run-new",
      captures: [
        {
          name: "kensington-detail-desktop",
          sha256: foreignDigest,
          screenshot_url: "https://example.test/snzlc1.png",
          reused_from: {
            feature: "segmented-meeting-detail",
            revision: "1ff60f293dc5f348cc6d08e1953232b4159235da",
            capture_run_id: "segmented-prior",
          },
        },
      ],
    });
    const result = runPython(`${helperPrelude()}
evidence = Path(${JSON.stringify(tmp)})
manifest = json.loads(Path(${JSON.stringify(candidatePath)}).read_text())
refuse_silent_image_reuse(
    manifest,
    evidence_root=evidence,
    manifest_path=Path(${JSON.stringify(candidatePath)}),
    previous=None,
)
print("ok")
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "ok");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("indexes screenshot_sha256 from other packets as a colliding image digest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "capture-image-provenance-field-"));
  try {
    const imageDigest = "22".repeat(32);
    writeManifest(tmp, "segmented-meeting-detail/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "segmented-meeting-detail",
      captures: [
        {
          name: "m3-desktop-enabled",
          sha256: "33".repeat(32),
          screenshot_sha256: imageDigest,
          screenshot_url: "https://example.test/snzlc1.png",
        },
      ],
    });
    const candidatePath = writeManifest(tmp, "near-you-kensington-wider-district/capture-manifest.json", {
      schema: "cityscroll.render_capture_manifest.v1",
      feature: "near-you-kensington-wider-district",
      capture_run_id: "run-new",
      captures: [
        {
          name: "kensington-detail-desktop",
          sha256: imageDigest,
          screenshot_url: "https://example.test/snzlc1.png",
        },
      ],
    });
    const result = runPython(`${helperPrelude()}
evidence = Path(${JSON.stringify(tmp)})
manifest = json.loads(Path(${JSON.stringify(candidatePath)}).read_text())
index = collect_retained_image_digests(evidence, exclude_manifest=Path(${JSON.stringify(candidatePath)}))
hits = index.get(${JSON.stringify(imageDigest)}) or []
print(json.dumps([hit.field for hit in hits]))
try:
    refuse_silent_image_reuse(
        manifest,
        evidence_root=evidence,
        manifest_path=Path(${JSON.stringify(candidatePath)}),
        previous=None,
    )
except SystemExit as error:
    print(str(error))
    raise SystemExit(2)
raise SystemExit("expected refusal via screenshot_sha256 index")
`);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stdout, /screenshot_sha256/);
    assert.match(result.stdout, /already appears in retained evidence/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
