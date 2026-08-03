import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/attachment-metadata.yml", import.meta.url),
  "utf8",
);

test("scheduled attachment metadata batch is bounded and publishes its receipt", () => {
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /attachment_metadata_run\.py/);
  assert.match(workflow, /--limit 200/);
  assert.match(workflow, /CITYSCROLL_ATTACHMENT_ENDPOINT/);
  assert.match(workflow, /CITYSCROLL_ADMIN_KEY/);
});

test("scheduled attachment jobs also run the T1 inline-text extract", () => {
  assert.match(workflow, /attachment_text_run\.py/);
  assert.match(workflow, /--limit 25/);
  assert.match(workflow, /attachment_text_latest\.json/);
});
