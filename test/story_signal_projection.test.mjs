import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PRIVATE_STORY_SIGNAL_LIMIT,
  buildPrivateStorySignalProjection,
  renderPrivateStorySignalPage,
} from "../site/story_signal_projection.mjs";
import {
  buildStorySignalProjectionArtifact,
  storySignalProjectionOutputs,
} from "../tools/build_story_signal_projection.mjs";

const admitted = JSON.parse(readFileSync(
  new URL("../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));

test("the private projection is bounded and contains admitted closed-template signals only", () => {
  const repeated = structuredClone(admitted);
  repeated.signals = Array.from({ length: PRIVATE_STORY_SIGNAL_LIMIT + 5 }, (_, index) => {
    const factId = `${admitted.signals[0].fact_id}:${String(index).padStart(2, "0")}`;
    return {
      ...structuredClone(admitted.signals[0]),
      fact_id: factId,
      signal_id: `story_signal:${factId}`,
      subject: {
        ...admitted.signals[0].subject,
        id: `20240119${String(index).padStart(3, "0")}`,
      },
      comparison_receipt: {
        ...admitted.signals[0].comparison_receipt,
        receipt_id: factId,
      },
      evidence: admitted.signals[0].evidence.map((item) => ({
        ...item,
        source_row_id: `20240119${String(index).padStart(3, "0")}`,
      })),
    };
  });
  const projection = buildPrivateStorySignalProjection(repeated);

  assert.equal(projection.schema, "cityscroll.private_story_signal_projection.v1");
  assert.equal(projection.visibility, "private_experimental");
  assert.equal(projection.cards.length, PRIVATE_STORY_SIGNAL_LIMIT);
  assert.equal(Object.isFrozen(projection), true);
  // The peer-group size moves with every warehouse snapshot, so take it from
  // the admitted signal rather than freezing one snapshot's count here.
  const observedCount = admitted.signals[0].comparison.observed_count;
  const expected = new RegExp(
    `4th-largest among ${observedCount} Housing Preservation and Development award rows observed`,
  );
  for (const card of projection.cards) {
    assert.match(card.what_stands_out, expected);
    assert.equal(card.actions.length, 5);
  }
});

test("held, empty, malformed, and unsupported inputs render no resident card", () => {
  const unsupported = structuredClone(admitted);
  unsupported.signals[0].metric.id = "vendor_concentration";
  const malformed = structuredClone(admitted);
  malformed.signals[0].basis_sentence = "A model-authored rewrite";
  const held = structuredClone(admitted);
  held.signals[0].state = "held_mnar";
  held.signals[0].backstage = { gate_id: "negative_inference" };

  for (const input of [
    { ...admitted, signals: [] },
    { schema: "cityscroll.comparative_signal_admission.v1", signals: admitted.signals },
    unsupported,
    malformed,
    held,
  ]) {
    const projection = buildPrivateStorySignalProjection(input);
    assert.deepEqual(projection.cards, []);
    assert.doesNotMatch(renderPrivateStorySignalPage(projection), /data-story-signal-card="1"/);
  }
});

test("the committed private route is a byte-current static materialization", () => {
  const [[path, html]] = storySignalProjectionOutputs(admitted);
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, "utf8"), html);
  assert.equal(buildStorySignalProjectionArtifact(admitted), html);
  assert.match(html, /<main id="main"/);
  assert.match(html, /data-private-story-signal-projection="1"/);
  assert.match(html, /data-story-signal-card="1"/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.match(html, /<script defer src="\/analytics\.js\?v=1\.3\.0"><\/script>/);
  assert.doesNotMatch(html, /fetch\s*\(|D1Database|\.prepare\s*\(|openai|anthropic/i);
});

test("public builds omit the private experimental route", () => {
  const output = mkdtempSync(join(tmpdir(), "crol-story-signal-public-"));
  try {
    const result = spawnSync(process.execPath, [
      "tools/build_public_site.mjs",
      "--source-dir", ".",
      "--site-dir", output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(output, "experimental")), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
