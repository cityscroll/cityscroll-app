// Track C delivery UI characterization: rollup TOC/quiet one-liners, quiet still-subscribed
// framing, match-evidence salience, prefs/unsub latency honesty, and preview≡email awareness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  subDigestHtml,
  quietHtml,
  rollupDigestHtml,
} from "../src/alerts.mjs";
import { digestItemAwareness, itemAwarenessHtml } from "../src/lib/digest_item_awareness.mjs";
import { matchEvidence } from "../src/lib/digest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

const TODAY = "2026-08-02";

const solicitation = {
  request_id: "FIX-PREV-SOL-1",
  short_title: "Fixture street materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  section_name: "Procurement",
  due_date: "2026-08-10",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting. Education programs may apply.",
};

test("quietHtml states still-subscribed and unsub/prefs latency honesty", () => {
  const html = quietHtml(
    "contract money — about “education”",
    "heartbeat",
    "2026-07-15",
    "https://api.cityscroll.org/unsubscribe?token=x",
    "en",
    "",
    "https://cityscroll.org/prefs?token=y",
  );
  assert.match(html, /data-quiet-still-subscribed="1"/);
  assert.match(html, /No new matches since/i);
  assert.match(html, /still subscribed/i);
  assert.match(html, /takes effect immediately/i);
  assert.match(html, /next digest/i);
  assert.match(html, /9am Eastern/i);
});

test("weekly-empty quietHtml uses weekly still-subscribed framing", () => {
  const html = quietHtml("hearings", "weekly-empty", "2026-07-28", "https://example.test/u", "en");
  assert.match(html, /still subscribed/i);
  assert.match(html, /weekly/i);
});

test("rollupDigestHtml: TOC jump links + one-line quiet sections", () => {
  const html = rollupDigestHtml({
    sections: [
      {
        label: "Construction",
        kind: "rfp",
        new: 1,
        freshRows: [solicitation],
        keywords: ["education"],
        action: "match",
      },
      {
        label: "Hearings",
        kind: "meetings",
        new: 0,
        freshRows: [],
        action: "none",
      },
      {
        label: "Weekly parks",
        skipped: "weekly",
        new: 0,
      },
    ],
    wantingCount: 1,
    watchCount: 3,
    unsubAllUrl: "https://api.cityscroll.org/unsubscribe?token=all",
    manageUrl: "https://cityscroll.org/prefs?token=m",
    lang: "en",
    today: TODAY,
    totalNew: 1,
    since: "2026-07-20",
  });
  assert.match(html, /data-rollup-toc="1"/);
  assert.match(html, /In this email/);
  assert.match(html, /href="#watch-0-construction"/);
  assert.match(html, /1 new · 1 of 3 watches with updates/);
  assert.match(html, /since Jul 20|since 7\/20|since July/i);
  assert.match(html, /data-rollup-quiet="1"/);
  assert.match(html, /Hearings — no new matches/);
  assert.match(html, /Weekly parks — weekly/i);
  // Quiet sections must not mount full item chrome (no empty <ul> of items).
  assert.doesNotMatch(html, /id="watch-1-hearings"[\s\S]*<ul/i);
  assert.match(html, /data-match-evidence="1"/);
  assert.match(html, /Matched:/);
  assert.match(html, /takes effect immediately/i);
  assert.match(html, /next digest/i);
});

test("subDigestHtml places match evidence under title and before actions", () => {
  const html = subDigestHtml(
    "education",
    "rfp",
    [solicitation],
    "https://api.cityscroll.org/unsubscribe?token=x",
    "2026-07-20",
    "https://api.cityscroll.org",
    [],
    "en",
    ["education"],
    null,
    "",
    null,
    null,
    TODAY,
  );
  const titleAt = html.indexOf("Fixture street materials");
  const evidenceAt = html.indexOf('data-match-evidence="1"');
  const actionAt = html.indexOf("View on CityScroll");
  assert.ok(titleAt >= 0 && evidenceAt > titleAt, "evidence after title");
  assert.ok(actionAt > evidenceAt, "actions after evidence");
  assert.match(html, /border-left:3px solid #1a44e0/);
  assert.match(html, /takes effect immediately/i);
  assert.match(html, /next digest/i);
  // Title-only match: no separate evidence line.
  const titleHit = {
    ...solicitation,
    short_title: "Education program services",
    additional_description_1: "No buried keyword here.",
  };
  const titleHtml = subDigestHtml(
    "education", "rfp", [titleHit], "https://u", "2026-07-20",
    "https://api.cityscroll.org", [], "en", ["education"], null, "", null, null, TODAY,
  );
  assert.doesNotMatch(titleHtml, /data-match-evidence="1"/);
});

test("preview awareness ≡ email awareness for phase + next-step strings", () => {
  const emailAwareness = itemAwarenessHtml(solicitation, esc, "en", { kind: "rfp", today: TODAY });
  const model = digestItemAwareness(solicitation, { kind: "rfp", today: TODAY });
  assert.equal(model.deadline.state, "closing-soon");
  assert.ok(model.action?.label || model.action?.guide?.label);

  const emailHtml = subDigestHtml(
    "fixture", "rfp", [solicitation], "https://u", "2026-07-20",
    "https://api.cityscroll.org", [], "en", [], null, "", null, null, TODAY,
  );
  // Strip tags to compare the shared pure-model strings.
  const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const emailPlain = strip(emailHtml);
  const awarenessPlain = strip(emailAwareness);
  // Every non-empty awareness token must appear in the email body.
  for (const token of awarenessPlain.split(" ").filter((w) => w.length > 3)) {
    assert.ok(
      emailPlain.toLowerCase().includes(token.toLowerCase()),
      `email missing awareness token "${token}"`,
    );
  }
  // Site digItemHTML must import the same pure module (no third renderer).
  const resultMatch = readFileSync(join(ROOT, "site/app/result-match.mjs"), "utf8");
  const alerts = readFileSync(join(ROOT, "site/app/alerts.mjs"), "utf8");
  assert.match(resultMatch, /digest_item_awareness\.mjs/);
  assert.match(alerts, /digest_item_awareness\.mjs/);
  assert.match(alerts, /function digItemHTML/);
  // Following list preview is a documented slim subset (title/summary), not a third dig item model.
  const following = readFileSync(join(ROOT, "site/following_view.mjs"), "utf8");
  assert.match(following, /following-delivery-help|still-watching note|14 days/);
  assert.match(following, /previewItem|following-preview/);
});

test("matchEvidence still skips evidence when the title already shows the hit", () => {
  const ev = matchEvidence("Education grant", "body without hit", ["education"]);
  assert.equal(ev.field, "title");
});
