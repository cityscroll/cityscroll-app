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
import {
  buildProcurementAlertAtom,
  procurementAlertSubject,
} from "../site/procurement_alert_atom.mjs";

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

// Card 1 of the procurement-pursuit-decision workstream: the same Fixture C row
// normalizes to the opportunity-first procurement alert atom and subject.
test("preview solicitation fixture normalizes to the opportunity-first atom + subject", () => {
  const row = {
    request_id: "FIX-PREV-SOL-1",
    short_title: "Fixture street materials",
    agency_name: "Department of Transportation",
    type_of_notice_description: "Solicitation",
    due_date: "2026-08-10",
  };
  const atom = buildProcurementAlertAtom(row);
  assert.equal(atom.matter_kind, "solicitation");
  assert.equal(procurementAlertSubject({ atoms: [atom] }), "DOT · Fixture street materials · closes Aug 10");
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

// Card 1: the same award control row keeps award language in its atom-derived
// subject too — no fabricated deadline segment, no bid CTA.
test("award fixture's procurement alert subject retains award language, never bid/deadline copy", () => {
  const row = {
    request_id: "FIX-PREV-AWD-1",
    short_title: "Fixture award",
    type_of_notice_description: "Award",
    vendor_name: "Acme Snow & Ice LLC",
    contract_amount: 250000,
    pin: "PIN-PREV-1",
  };
  const atom = buildProcurementAlertAtom(row);
  assert.equal(atom.matter_kind, "award");
  const subject = procurementAlertSubject({ atoms: [atom] });
  assert.doesNotMatch(subject, /\bbid\b/i);
  assert.doesNotMatch(subject, /closes|deadline/i);
});

// Card 1: a sparse real solicitation (Fixture D identity, ledger id "D") never
// fabricates an amount or a due date — subject omits amount, labels the deadline.
test("sparse solicitation fixture never renders $0 or a fabricated due date", () => {
  const row = {
    procurement_id: "procurement:solicitation:S48020",
    title: "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
    agency_name: "MTA Construction & Development",
    kind: "solicitation",
  };
  const atom = buildProcurementAlertAtom(row, { amountStatus: "unavailable", deadlineStatus: "unavailable" });
  const subject = procurementAlertSubject({ atoms: [atom] });
  assert.equal(subject, "MTA C&D · CBTC for 6th Ave / 63rd St · deadline not published");
  assert.doesNotMatch(subject, /\$0\b/);
  assert.doesNotMatch(subject, /\d{4}-\d{2}-\d{2}/);
});

test("shared module is the single source for worker email and site preview", () => {
  const workerReexport = readFileSync(
    new URL("../worker/src/lib/digest_item_awareness.mjs", import.meta.url),
    "utf8",
  );
  assert.match(workerReexport, /site\/digest_item_awareness\.mjs/);
});

// Card 1: the procurement alert atom module follows the same
// site-source-of-truth / worker-re-export pattern as digest_item_awareness.mjs.
test("procurement alert atom module is the single source for worker email and site preview", () => {
  const workerReexport = readFileSync(
    new URL("../worker/src/lib/procurement_alert_atom.mjs", import.meta.url),
    "utf8",
  );
  assert.match(workerReexport, /site\/procurement_alert_atom\.mjs/);
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
  assert.match(following, /Daily sends when there are matches|Weekly digest sends Monday/i);
});
