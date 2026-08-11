import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Alert preview digItemHTML must surface the same time + next-action awareness
// as the outbound digest email (site/digest_item_awareness.mjs).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  digestItemAwareness,
  itemAwarenessHtml,
} from "../site/digest_item_awareness.mjs";

const INDEX = SITE_SOURCE;
const TODAY = "2026-08-02";
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;",
}[c]));

test("index.html wires dig awareness into aPreview and digItemHTML", () => {
  assert.match(INDEX, /import\("\.\.\/digest_item_awareness\.mjs"\)/);
  assert.match(INDEX, /ensureDigAwarenessTools/);
  assert.match(INDEX, /digAwarenessHTML/);
  assert.match(INDEX, /function digItemHTML\(kind, r, keywords, awarenessTools\)/);
  assert.match(INDEX, /await ensureDigAwarenessTools\(\)/);
});

test("preview solicitation fixture carries closing-soon + package next step", () => {
  const row = {
    request_id: "FIX-PREV-SOL-1",
    short_title: "Fixture street materials",
    agency_name: "Department of Transportation",
    type_of_notice_description: "Solicitation",
    due_date: "2026-08-10",
    additional_description_1:
      "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
  };
  const a = digestItemAwareness(row, { kind: "rfp", today: TODAY });
  assert.equal(a.deadline.state, "closing-soon");
  assert.equal(a.pointer_only, false);
  const html = itemAwarenessHtml(row, esc, "en", { kind: "rfp", today: TODAY });
  assert.match(html, /Closing soon|Next step|example\.com\/rfps/i);
});

test("preview award fixture is not a bid CTA", () => {
  const row = {
    request_id: "FIX-PREV-AWD-1",
    short_title: "Fixture award",
    type_of_notice_description: "Award",
    vendor_name: "Acme Snow & Ice LLC",
    contract_amount: 250000,
    pin: "PIN-PREV-1",
  };
  const a = digestItemAwareness(row, { kind: "award", today: TODAY });
  assert.equal(a.action?.label, "Open Checkbook");
  assert.match(a.action?.guide?.label || "", /Awarded to/i);
  assert.doesNotMatch(a.action?.label || "", /\bbid\b/i);
});

test("shared module is the single source for worker email and site preview", () => {
  const workerReexport = readFileSync(
    new URL("../worker/src/lib/digest_item_awareness.mjs", import.meta.url),
    "utf8",
  );
  assert.match(workerReexport, /site\/digest_item_awareness\.mjs/);
});

test("digItemHTML places match evidence under title before actions (preview≡email scan order)", () => {
  // Both home-wire and alerts-island digItemHTML must keep evidence before action chrome.
  assert.match(INDEX, /digEvidenceHTML\(ev\)[\s\S]{0,200}class="dm"/);
  assert.match(INDEX, /data-match-evidence="1"/);
});

test("Following list preview is a slim subset — dig item awareness stays digItemHTML/subDigestHtml", () => {
  const following = readFileSync(
    new URL("../site/following_view.mjs", import.meta.url),
    "utf8",
  );
  // Following uses a documented digItem-shaped slim subset (phase/next-step chips),
  // not the full digItemHTML / subDigestHtml email item renderer.
  assert.match(following, /function followingPreviewItemHtml/);
  assert.doesNotMatch(following, /function digItemHTML/);
  assert.match(following, /14 quiet days|still-watching/i);
});
