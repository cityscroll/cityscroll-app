#!/usr/bin/env node
// Renders real production output for the procurement-pursuit-decision Card 1
// evidence: the opportunity-first subject + body for Fixtures C, D, and E, and
// one multi-watch rollup with Fixture C as the selected lead item. Calls the
// same production functions the worker uses (subDigestHtml/rollupDigestHtml
// from worker/src/alerts.mjs, buildProcurementAlertAtom/procurementAlertSubject
// from site/procurement_alert_atom.mjs) so this is the after-Card-1 counterpart
// to tools/render_procurement_pursuit_decision_baseline_fixtures.mjs (Card 0's
// before capture). Fixtures reused verbatim from
// test/digest_preview_awareness.test.mjs and the shared fixture ledger — no
// new commission examples. Nothing here is a served route or a build artifact.
//
// Per the repository's binding evidence rule for this card, output is full,
// reviewable HTML (no screenshot binaries) written directly under
// docs/evidence/procurement-pursuit-decision/alerts/, alongside a manifest
// recording route, viewport intent, revision, fixture vintage, the assertion
// each render demonstrates, and a sha256 of the HTML content.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { subDigestHtml, rollupDigestHtml } from "../worker/src/alerts.mjs";
import { buildProcurementAlertAtom, procurementAlertSubject } from "../site/procurement_alert_atom.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = new URL("../docs/evidence/procurement-pursuit-decision/alerts/", import.meta.url);
const TODAY = "2026-08-02";

const FIXTURE_C_ROW = {
  request_id: "FIX-PREV-SOL-1",
  short_title: "Fixture street materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};
const FIXTURE_D_ROW = {
  procurement_id: "procurement:solicitation:S48020",
  short_title: "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
  agency_name: "MTA Construction & Development",
  kind: "solicitation",
};
const FIXTURE_E_ROW = {
  request_id: "FIX-PREV-AWD-1",
  short_title: "Fixture award",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-PREV-1",
};
// Two additional procurement matches for the multi-watch rollup case, distinct
// from Fixtures A-F (ordinary test-only rollup filler, not a new commission
// example — see site/alerts_rollup_prefs.mjs's own demoRollupWatches() for the
// established pattern of bespoke rollup-preview sample rows).
const ROLLUP_SECOND_ROW = {
  request_id: "FIX-ROLLUP-2",
  short_title: "Boiler replacement",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Award",
  contract_amount: 90000,
};
const ROLLUP_THIRD_ROW = {
  request_id: "FIX-ROLLUP-3",
  short_title: "Elevator modernization",
  agency_name: "Housing Authority",
  type_of_notice_description: "Award",
  contract_amount: 120000,
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function wrapEmailHtml(title, subject, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head><body style="margin:0;padding:24px;background:#f4f6fb;font-family:system-ui,sans-serif">
<div style="max-width:640px;margin:0 auto">
  <div style="background:#12181f;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-size:13px">
    <b>Subject:</b> ${esc(subject)}
  </div>
  <div style="max-width:640px;margin:0 auto;background:#fff;padding:24px;border-radius:0 0 8px 8px">${bodyHtml}</div>
</div>
</body></html>`;
}

function singleWatchCase(label, row, watchLabel) {
  const atom = row === FIXTURE_D_ROW
    ? buildProcurementAlertAtom(row, { amountStatus: "unavailable", deadlineStatus: "unavailable" })
    : buildProcurementAlertAtom(row);
  const subject = procurementAlertSubject({ atoms: [atom] });
  const kind = atom.matter_kind === "award" ? "award" : "rfp";
  const body = subDigestHtml(
    watchLabel,
    kind,
    [row],
    "https://api.cityscroll.org/u/test-unsub",
    "2026-08-01",
    "https://api.cityscroll.org",
    [],
    "en",
    [],
    null,
    "",
    null,
    null,
    TODAY,
    false,
  );
  return { subject, html: wrapEmailHtml(`${label} preview`, subject, body) };
}

function multiWatchRollupCase() {
  const atoms = [
    buildProcurementAlertAtom(FIXTURE_C_ROW),
    buildProcurementAlertAtom(ROLLUP_SECOND_ROW),
    buildProcurementAlertAtom(ROLLUP_THIRD_ROW),
  ];
  const subject = procurementAlertSubject({ atoms });
  const body = rollupDigestHtml({
    sections: [
      { label: "DOT solicitations", kind: "rfp", freshRows: [FIXTURE_C_ROW], new: 1, action: "match" },
      { label: "Citywide Administrative Services awards", kind: "award", freshRows: [ROLLUP_SECOND_ROW], new: 1, action: "match" },
      { label: "Housing Authority awards", kind: "award", freshRows: [ROLLUP_THIRD_ROW], new: 1, action: "match" },
    ],
    wantingCount: 3,
    watchCount: 3,
    unsubAllUrl: "https://api.cityscroll.org/u/all-test",
    manageUrl: "https://api.cityscroll.org/manage",
    today: TODAY,
  });
  return { subject, html: wrapEmailHtml("Multi-watch rollup preview (opportunity-first)", subject, body) };
}

function gitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const cases = [
  {
    label: "alert-fixture-c-single-watch",
    surface: "email-preview",
    fixture_ids: ["C"],
    data_vintage: "test/digest_preview_awareness.test.mjs FIX-PREV-SOL-1 fixture row; rendered as of 2026-08-02",
    assertion:
      "Opportunity-first subject 'DOT · Fixture street materials · closes Aug 10' (agency + recognizable title + closing date; amount omitted, never observed). Body still carries match evidence, deadline awareness, and the explicit package URL ahead of actions.",
    ...singleWatchCase("Single-watch — Fixture C (solicitation)", FIXTURE_C_ROW, "DOT solicitations I'm watching"),
  },
  {
    label: "alert-fixture-d-single-watch",
    surface: "email-preview",
    fixture_ids: ["D"],
    data_vintage: "test/fixtures/procurement_pursuit_decision/fixture-ledger.json id D identity; rendered as of 2026-08-02",
    assertion:
      "Sparse real solicitation subject 'MTA C&D · CBTC for 6th Ave / 63rd St · deadline not published' — no $0, no fabricated due date, no generic 'Respond now' CTA; unknown amount is omitted and unknown deadline is explicitly labeled per acceptance criterion 2.",
    ...singleWatchCase("Single-watch — Fixture D (sparse solicitation)", FIXTURE_D_ROW, "MTA C&D solicitations I'm watching"),
  },
  {
    label: "alert-fixture-e-single-watch",
    surface: "email-preview",
    fixture_ids: ["E"],
    data_vintage: "test/digest_preview_awareness.test.mjs FIX-PREV-AWD-1 fixture row; rendered as of 2026-08-02",
    assertion:
      "Award control keeps award-specific language: the subject never renders a closing date or bid CTA, and the body's action rail stays 'Awarded to' / 'Open Checkbook', never rewritten as a solicitation.",
    ...singleWatchCase("Single-watch — Fixture E (award control)", FIXTURE_E_ROW, "Award watch"),
  },
  {
    label: "alert-multi-watch-rollup",
    surface: "email-preview",
    fixture_ids: ["C"],
    data_vintage: "Fixture C plus two additional procurement-shaped rollup matches; rendered as of 2026-08-02",
    assertion:
      "Multi-match subject 'DOT · Fixture street materials · closes Aug 10 (+2)' — Fixture C selected as lead (actionable solicitation before award/history), exact remaining count named. Body still renders every watch's own section beneath the lead (every-watch rollup honesty preserved).",
    ...multiWatchRollupCase(),
  },
];

const revision = gitRevision();
const capturedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const manifest = {
  schema: "cityscroll.procurement_pursuit_decision_alerts_manifest.v1",
  captured_at: capturedAt,
  revision,
  note:
    "Card 1 (opportunity-first procurement alert atom) evidence. Rendered by calling the production subDigestHtml()/rollupDigestHtml() (worker/src/alerts.mjs) and buildProcurementAlertAtom()/procurementAlertSubject() (site/procurement_alert_atom.mjs) directly. Per this repository's binding evidence rule for this card, full HTML previews are committed in-repo (no screenshot binaries); each entry's sha256 is over the committed HTML file's content.",
  captures: cases.map(({ label, surface, fixture_ids, data_vintage, assertion, subject, html }) => {
    const filename = `${label}.html`;
    writeFileSync(new URL(filename, OUT_DIR), html);
    return {
      case: label,
      surface,
      route: `/_capture/alerts/${label}`,
      viewport_intent: "responsive email HTML; reviewable at narrow mobile and desktop widths",
      revision,
      fixture_ids,
      data_vintage,
      assertion,
      subject,
      html_filename: filename,
      sha256: sha256(html),
      bytes: Buffer.byteLength(html, "utf8"),
    };
  }),
};

writeFileSync(new URL("capture-manifest.json", OUT_DIR), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`wrote ${manifest.captures.length} HTML previews + capture-manifest.json to docs/evidence/procurement-pursuit-decision/alerts/\n`);
