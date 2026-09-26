/**
 * Positive controls for Near You detail capture observations.
 *
 * named_row_present and no_javascript_title_link must derive from the served
 * document so each field can report failure when the page lacks the thing it
 * claims. Capture tools must import the shared helper instead of hard-coding
 * those two fields on detail packets.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const HELPER = join(ROOT, "tools/near_you_detail_observer.py");
const CAPTURE_TOOLS = [
  "tools/capture_near_you_midwood_venue_journey.py",
  "tools/capture_near_you_subject_property_journey.py",
  "tools/capture_kensington_wider_district_journey.py",
];

const RECORD_NEEDLE = "housing-and-land-use-committee-meeting-september-2026";
const TITLE_NEEDLE = "Housing and Land Use Committee Meeting";

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
from near_you_detail_observer import (
    observe_detail_packet_fields,
    observe_named_row_present,
    observe_no_javascript_title_link,
)
`;
}

function observe(codeBody) {
  const result = runPython(`${helperPrelude()}\n${codeBody}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("helper module parses", () => {
  const result = runPython(
    `import ast; ast.parse(open(${JSON.stringify(HELPER)}).read()); print("ok")`,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("named_row_present reports true for a Near You list row and false without row markup", () => {
  const listHtml = `
    <ul>
      <li class="near-record" data-record-id="meeting:community_board:https://cb14brooklyn.com/meeting/${RECORD_NEEDLE}/">
        <a class="near-record-title-link near-record-title" href="/meetings/example/">${TITLE_NEEDLE}</a>
      </li>
    </ul>
  `;
  const detailOnlyHtml = `
    <main>
      <section class="node-hero civic-object-hero meeting-hero">
        <h1>${TITLE_NEEDLE}</h1>
      </section>
      <p>Canonical id mentions ${RECORD_NEEDLE} without a list row.</p>
    </main>
  `;
  const missingHtml = `<main><h1>Unrelated meeting</h1></main>`;

  const present = observe(`
html = ${JSON.stringify(listHtml)}
print(json.dumps(observe_named_row_present(html, record_id_needle=${JSON.stringify(RECORD_NEEDLE)}, title_needle=${JSON.stringify(TITLE_NEEDLE)})))
`);
  const detailComplement = observe(`
html = ${JSON.stringify(detailOnlyHtml)}
print(json.dumps(observe_named_row_present(html, record_id_needle=${JSON.stringify(RECORD_NEEDLE)}, title_needle=${JSON.stringify(TITLE_NEEDLE)})))
`);
  const missing = observe(`
html = ${JSON.stringify(missingHtml)}
print(json.dumps(observe_named_row_present(html, record_id_needle=${JSON.stringify(RECORD_NEEDLE)}, title_needle=${JSON.stringify(TITLE_NEEDLE)})))
`);

  assert.equal(present, true);
  assert.equal(detailComplement, false);
  assert.equal(missing, false);
});

test("no_javascript_title_link reports true for real anchors and false when they are absent", () => {
  const listLinkHtml = `
    <a class="near-record-title-link near-record-title" href="/meetings/example/">${TITLE_NEEDLE}</a>
  `;
  const detailSourceHtml = `
    <a href="https://cb14brooklyn.com/meeting/example/" rel="noopener noreferrer">Official source</a>
  `;
  const bareTitleHtml = `
    <section class="meeting-hero"><h1>${TITLE_NEEDLE}</h1></section>
    <p>Official source mentioned in prose without an href.</p>
  `;
  const classWithoutHref = `
    <a class="near-record-title-link near-record-title">${TITLE_NEEDLE}</a>
  `;

  const listLink = observe(`
print(json.dumps(observe_no_javascript_title_link(${JSON.stringify(listLinkHtml)})))
`);
  const detailSource = observe(`
print(json.dumps(observe_no_javascript_title_link(${JSON.stringify(detailSourceHtml)})))
`);
  const bareTitle = observe(`
print(json.dumps(observe_no_javascript_title_link(${JSON.stringify(bareTitleHtml)})))
`);
  const classOnly = observe(`
print(json.dumps(observe_no_javascript_title_link(${JSON.stringify(classWithoutHref)})))
`);

  assert.equal(listLink, true);
  assert.equal(detailSource, true);
  assert.equal(bareTitle, false);
  assert.equal(classOnly, false);
});

test("detail packet fields fail closed when the page lacks the claimed row or link", () => {
  const emptyDetail = `
    <main>
      <section class="meeting-hero"><h1>${TITLE_NEEDLE}</h1></section>
      <p>Mentions ${RECORD_NEEDLE} in text only.</p>
    </main>
  `;
  const packet = observe(`
print(json.dumps(observe_detail_packet_fields(
  ${JSON.stringify(emptyDetail)},
  record_id_needle=${JSON.stringify(RECORD_NEEDLE)},
  title_needle=${JSON.stringify(TITLE_NEEDLE)},
  no_js_html=${JSON.stringify(emptyDetail)},
)))
`);
  assert.equal(packet.named_row_present, false);
  assert.equal(packet.no_javascript_title_link, false);
});

test("capture tools import the shared observer and do not hard-code the two detail fields", () => {
  for (const relative of CAPTURE_TOOLS) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    assert.match(source, /from near_you_detail_observer import/);
    assert.match(source, /observe_detail_packet_fields/);
    assert.match(source, /fetch_document_html/);
    assert.doesNotMatch(
      source,
      /"named_row_present":\s*False/,
      `${relative} still hard-codes named_row_present`,
    );
    assert.doesNotMatch(
      source,
      /"no_javascript_title_link":\s*True/,
      `${relative} still hard-codes no_javascript_title_link`,
    );
  }
});
