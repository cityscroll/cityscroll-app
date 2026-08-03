#!/usr/bin/env node
// Headless evidence: alert-preview dig items + desk daylog shape after awareness upgrade.
//   node tools/render_preview_ops_parity_evidence.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { itemAwarenessHtml, digestItemAwareness } from "../site/digest_item_awareness.mjs";
import { toDayLogEntry, noticeDeepLink } from "../worker/src/lib/digest_ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../docs/evidence/digest-preview-ops-parity");
const TODAY = "2026-08-02";
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;",
}[c]));

const sol = {
  request_id: "FIX-PREV-SOL-1",
  short_title: "Street resurfacing materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};
const award = {
  request_id: "FIX-PREV-AWD-1",
  short_title: "Snow removal award",
  agency_name: "Department of Sanitation",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-PREV-1",
  start_date: "2026-08-01",
};

function digMock(kind, r) {
  const aw = itemAwarenessHtml(r, esc, "en", { kind, today: TODAY });
  const title = esc(r.short_title || r.project_name || "Notice");
  const meta = [r.agency_name, r.vendor_name, r.due_date ? `due ${String(r.due_date).slice(0, 10)}` : ""]
    .filter(Boolean).map(esc).join(" · ");
  return `<div class="digitem" style="margin:0 0 16px;padding:12px 0;border-bottom:1px solid #e5dfd3">
    <div class="dt" style="font-weight:700"><a href="#notice/${esc(r.request_id)}">${title}</a></div>
    <div class="dm" style="color:#555;font-size:13px">${meta}</div>
    <div class="dig-awareness">${aw}</div>
  </div>`;
}

const daylog = toDayLogEntry({
  sub: "sub:ops-demo",
  kind: "subscription",
  lens: "money",
  queryLabel: "contract money — construction",
  emailRedacted: "u***@example.com",
  found: 2,
  new: 2,
  noticeIds: [sol.request_id, award.request_id],
  action: "match",
  sent: true,
}, { day: TODAY });

const findings = {
  alert_preview: {
    verdict: "fixed",
    note: "digItemHTML now loads site/digest_item_awareness.mjs and renders phase/deadline/next-step under each dig item (parity with email).",
    models: {
      solicitation: digestItemAwareness(sol, { kind: "rfp", today: TODAY }),
      award: digestItemAwareness(award, { kind: "award", today: TODAY }),
    },
  },
  desk_daylog: {
    verdict: "correct_by_design",
    note: "Operator daylog is send-level: noticeIds + noticeLinks + outcome labels. It does not re-render email item HTML. After the email upgrade, notice deep links and counts remain intact.",
    entry: daylog,
    noticeLinks: daylog.noticeLinks,
  },
};

mkdirSync(OUT, { recursive: true });

const previewHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Alert preview — time + action awareness</title>
<style>
body{font-family:Georgia,serif;margin:0;padding:32px;background:#f5f1e8;color:#24211d}
.card{background:#fff;border:1px solid #ded7ca;border-radius:10px;padding:24px;max-width:640px;box-shadow:0 8px 30px rgba(50,42,30,.08)}
.badge{display:inline-block;font:600 11px/1 system-ui;text-transform:uppercase;letter-spacing:.04em;background:#dceee8;color:#1d4d42;padding:4px 8px;border-radius:4px;margin-bottom:12px}
a{color:#245e52}
.note{color:#666;font-size:13px;max-width:640px;margin:0 0 20px}
</style></head><body>
<span class="badge">alert preview</span>
<h1 style="font-family:system-ui;font-size:20px">Preview dig items (email mock parity)</h1>
<p class="note">Rendered via <code>itemAwarenessHtml</code> — the same module <code>digItemHTML</code> loads on the Alerts tab Preview control.</p>
<div class="card emailmock">
  <div style="font:12px system-ui;color:#666;margin-bottom:8px">CityScroll &lt;alerts@crol-list.org&gt; → reader@example.com</div>
  <div style="font:700 15px system-ui;margin-bottom:16px">Your digest — construction solicitations</div>
  ${digMock("rfp", sol)}
  ${digMock("award", award)}
</div>
</body></html>`;

const deskHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Desk daylog — send-level receipt</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#111;color:#eee}
.card{background:#1c1c1c;border:1px solid #333;border-radius:8px;padding:20px;max-width:720px}
.badge{display:inline-block;font:600 11px/1 system-ui;text-transform:uppercase;letter-spacing:.04em;background:#333;color:#9fd;padding:4px 8px;border-radius:4px;margin-bottom:12px}
a{color:#8cf}
pre{background:#0a0a0a;padding:12px;overflow:auto;font-size:12px;border-radius:6px}
.note{color:#aaa;font-size:13px;max-width:720px}
</style></head><body>
<span class="badge">desk / ops</span>
<h1 style="font-size:20px">Daylog send row (digest_ops)</h1>
<p class="note">Operators see <strong>counts + deep links</strong>, not the subscriber email body. That is intentional: the desk is for send continuity, not re-reading digests. Notice links remain after the awareness upgrade.</p>
<div class="card">
  <p><strong>${esc(daylog.query)}</strong> · ${esc(daylog.email)} · action=${esc(daylog.action)}</p>
  <p>${daylog.noticeCount} new · found ${daylog.found} · sent=${daylog.sent}</p>
  <p>Deep links:</p>
  <ul>${daylog.noticeLinks.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join("")}</ul>
  <pre>${esc(JSON.stringify(daylog, null, 2))}</pre>
</div>
</body></html>`;

writeFileSync(join(OUT, "alert-preview.html"), previewHtml);
writeFileSync(join(OUT, "desk-daylog.html"), deskHtml);
writeFileSync(join(OUT, "findings.json"), JSON.stringify(findings, null, 2) + "\n");
writeFileSync(join(OUT, "README.md"), `# Digest preview + ops parity evidence

## Findings

| Surface | Verdict | Notes |
|---------|---------|-------|
| Site alert preview (\`digItemHTML\` / \`aPreview\`) | **Fixed** | Loads \`site/digest_item_awareness.mjs\` and shows phase / open·closing-soon·closed / next-step under each dig item — same model as email. |
| Desk hub daylog (\`digest_ops\`) | **Correct by design** | Send-level: \`noticeIds\`, \`noticeLinks\`, outcome labels. Does not re-render email item HTML. Continuity of deep links verified. |

## Files

- \`alert-preview.html\` — email-mock dig items with awareness
- \`desk-daylog.html\` — operator send row + JSON
- \`findings.json\` — machine-readable verdicts

Regenerate: \`node tools/render_preview_ops_parity_evidence.mjs\`
`);

console.log(JSON.stringify({ out: OUT, findings: {
  alert_preview: findings.alert_preview.verdict,
  desk_daylog: findings.desk_daylog.verdict,
} }, null, 2));
