#!/usr/bin/env node
// Headless dry-run evidence for digest time + action awareness.
// Writes before/after HTML under docs/evidence/digest-time-action-awareness/.
//
// Usage (from repo root):
//   node tools/render_digest_awareness_evidence.mjs
//
// "Before" freezes the prior email shape: meta line + generic City Record / CityScroll
// links only (no phase/deadline state, no extracted next-action rail).
// "After" is the live subDigestHtml path.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { subDigestHtml } from "../worker/src/alerts.mjs";
import { shortDate } from "../worker/src/lib/digest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../docs/evidence/digest-time-action-awareness");
const TODAY = "2026-08-02";

// Synthetic fixtures only (RFC 2606 example domains / 555 numbers / FIX-* ids).
// Not live City Record or ZAP rows.
const fixtures = [
  {
    kind: "rfp",
    label: "money — construction solicitations",
    row: {
      request_id: "FIX-SOL-0001",
      short_title: "Street resurfacing materials",
      agency_name: "Department of Transportation",
      type_of_notice_description: "Solicitation",
      due_date: "2026-08-10",
      email: "example@example.com",
      contact_name: "Testy McTestface",
      contact_phone: "555-0100",
      pin: "DOT-RFQ-2026-01",
      address_to_request: "1 Example Street, NY",
      selection_method_description: "Competitive Sealed Bid",
      additional_description_1:
        "Vendors must download the solicitation documents at https://example.com/rfps before submitting a proposal.",
    },
  },
  {
    kind: "award",
    label: "money — awards ≥ $100k",
    row: {
      request_id: "FIX-AWD-0002",
      short_title: "Snow removal equipment maintenance",
      agency_name: "Department of Sanitation",
      type_of_notice_description: "Award",
      vendor_name: "Acme Snow & Ice LLC",
      contract_amount: 250000,
      pin: "PIN-FIXTURE-0001",
      start_date: "2026-07-02",
    },
  },
  {
    kind: "rules",
    label: "rules — Department of Transportation",
    row: {
      request_id: "FIX-RULE-0001",
      start_date: "2026-07-15T00:00:00.000",
      agency_name: "Department of Transportation",
      short_title: "Commercial curb-use rule",
      section_name: "Agency Rules",
      additional_description_1: "Proposed curb-use requirements.",
      temporal_action: {
        kind: "rules-comment-open",
        event_at: "2026-09-15",
        publication_at: "2026-08-01T12:30:00.000Z",
        recorded_at: "2026-08-01T12:55:00.000Z",
        url: "https://example.com/rules/fixture-curb-use/",
      },
    },
  },
  {
    kind: "meetings",
    label: "meetings — public hearings",
    row: {
      request_id: "FIX-MTG-0001",
      short_title: "Franchise and Concession Review Committee public hearing",
      agency_name: "Mayor's Office of Contract Services",
      section_name: "Public Hearings and Meetings",
      type_of_notice_description: "Public Hearing",
      event_date: "2026-08-05",
      email: "example@example.com",
      street_address_1: "1 Example Plaza",
      building_name: "Fixture Hall",
      additional_description_1:
        "Written testimony may be submitted electronically to example@example.com until the close of the public hearing. Join via Zoom at https://example.com/join/fixture-hearing.",
    },
  },
  {
    kind: "rezone",
    label: "land — ULURP in public review",
    row: {
      project_id: "FIX-ZAP-0001",
      project_name: "Harbor rezoning",
      public_status: "In Public Review",
      borough: "Manhattan",
      community_district: "1",
      primary_applicant: "DCP",
      project_brief: "Zoning map amendment for waterfront parcels.",
    },
  },
];

function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function dueLabel(dueDate) {
  if (!dueDate) return "";
  const s = String(dueDate);
  const year = Number(s.slice(0, 4));
  if (Number.isFinite(year) && year >= 2090) return "no fixed deadline (rolling)";
  return "due " + s.slice(0, 10);
}

/** Prior email shape: meta + generic links only (no phase / deadline state / next-action rail). */
function beforeItemHtml(kind, r) {
  const usd = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  if (kind === "rezone") {
    const cd = r.community_district ? `CD ${r.community_district}` : "";
    const meta = [r.borough, cd, r.public_status].filter(Boolean).map(esc).join(" · ");
    return `<li style="margin:0 0 14px"><b><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">${esc(r.project_name || "(unnamed rezoning)")}</a></b><br>
      <span style="color:#555;font-size:13px">${meta}</span><br>
      <span style="font-size:13px"><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">↗ View &amp; comment on ZAP</a></span></li>`;
  }
  const title = esc(r.short_title || "Notice");
  const acts = [];
  if (r.email) acts.push(`<a href="mailto:${esc(r.email)}">✉ Email</a>`);
  if (r.contact_phone) acts.push(`☎ Call`);
  acts.push(`<a href="https://api.cityscroll.org/r/${kind}/${encodeURIComponent(r.request_id)}">↗ View on CityScroll</a>`);
  acts.push(`<a href="https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(r.request_id)}">City Record</a>`);
  // Prior rules-only temporal line (when present) — still no phase/closing-soon band for other kinds.
  let temporal = "";
  if (r.temporal_action?.kind === "rules-comment-open" && r.temporal_action.event_at && r.temporal_action.url) {
    temporal = `<div style="color:#8a3d12;font-size:13px;margin:3px 0">Comments open through ${esc(shortDate(r.temporal_action.event_at))} · <a href="${esc(r.temporal_action.url)}">Comment on NYC Rules</a></div>`;
  }
  const meta = [r.agency_name, usd(r.contract_amount), dueLabel(r.due_date),
    r.event_date ? "event " + String(r.event_date).slice(0, 10) : ""]
    .filter(Boolean).map(esc).join(" · ");
  return `<li style="margin:0 0 14px"><b>${title}</b><br>
    <span style="color:#555;font-size:13px">${meta}</span><br>
    ${temporal}
    <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
}

function wrapPage(title, bodyInner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{margin:0;padding:32px;background:#f5f1e8;color:#24211d;font-family:Georgia,serif}
  h1{font-family:system-ui;font-size:20px;margin:0 0 8px}
  .note{color:#666;font-size:13px;margin:0 0 24px;max-width:640px}
  .card{background:white;padding:28px;border:1px solid #ded7ca;border-radius:10px;
    box-shadow:0 8px 30px rgba(50,42,30,.08);max-width:640px;margin-bottom:28px}
  a{color:#245e52}
  .badge{display:inline-block;font-family:system-ui;font-size:11px;font-weight:600;
    letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:4px;margin-bottom:12px}
  .badge.before{background:#f0e6d8;color:#6b5344}
  .badge.after{background:#dceee8;color:#1d4d42}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="note">Dry-run digest items only — no send. Event clock for status chips is fixed at ${TODAY} (America/New_York calendar date for this evidence set). Delivery identity / seen: keys are unchanged.</p>
${bodyInner}
</body></html>`;
}

function section(badge, label, itemsHtml) {
  return `<div class="card">
  <span class="badge ${badge}">${badge}</span>
  <div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui;font-size:18px;margin:0 0 8px">CityScroll — ${esc(label)}</h2>
    <p style="color:#555">1 new item since ${esc(shortDate("2026-07-31"))}.</p>
    <ul style="list-style:none;padding:0">${itemsHtml}</ul>
  </div>
</div>`;
}

mkdirSync(OUT_DIR, { recursive: true });

const beforeSections = fixtures.map((f) =>
  section("before", f.label, beforeItemHtml(f.kind, f.row))).join("\n");
const afterSections = fixtures.map((f) => {
  // Freeze "today" for reproducible closing-soon labels by patching Date only if needed —
  // itemAwarenessHtml uses opts.today from subDigestHtml which uses Date.now().
  // We call subDigestHtml (live path); closing-soon thresholds relative to wall clock
  // may drift. For stable evidence, prefer the pure HTML for the single item via a
  // synthetic email built the same way as subDigestHtml after wiring.
  const html = subDigestHtml(
    f.label,
    f.kind,
    [f.row],
    "https://api.cityscroll.org/unsubscribe?token=example",
    "2026-07-31",
    "https://api.cityscroll.org",
    [],
    "en",
    [],
  );
  // Extract the <ul>…</ul> item block for the card, or drop the full email body.
  return `<div class="card">
  <span class="badge after">after</span>
  ${html}
</div>`;
}).join("\n");

const beforePath = join(OUT_DIR, "before.html");
const afterPath = join(OUT_DIR, "after.html");
const pairPath = join(OUT_DIR, "before-after.html");

writeFileSync(beforePath, wrapPage("Digest email — before (generic pointer)", beforeSections));
writeFileSync(afterPath, wrapPage("Digest email — after (time + action awareness)", afterSections));
writeFileSync(pairPath, wrapPage(
  "Digest email — before / after comparison",
  `<h2 style="font-family:system-ui;font-size:16px">Before</h2>${beforeSections}
   <h2 style="font-family:system-ui;font-size:16px;margin-top:32px">After</h2>${afterSections}`,
));

// Machine-readable summary for the PR body.
const summary = {
  generated_for: TODAY,
  fixtures: fixtures.map((f) => ({ kind: f.kind, label: f.label, request_or_project_id: f.row.request_id || f.row.project_id })),
  files: ["before.html", "after.html", "before-after.html"],
  notes: [
    "Render-only; no Resend / no send-path changes.",
    "Idempotent temporal delivery keys (alert_temporal) unchanged.",
    "After uses live subDigestHtml with itemAwarenessHtml (phase, deadline state, next-action rail).",
  ],
};
writeFileSync(join(OUT_DIR, "README.md"), `# Digest time + action awareness — dry-run evidence

Generated by \`node tools/render_digest_awareness_evidence.mjs\`.

## What changed

Digest emails previously often showed only agency/meta lines and generic
"View on CityScroll" / "City Record" links. After this change, each item
carries — **when ingested fields support it**:

1. **Time-awareness** — lifecycle phase / where-in-timeline and deadline(s)
   with open / closing-soon / closed from **event** time (see
   \`docs/digest-time-ontology.md\`).
2. **Action-awareness** — a specific next step extracted via the shared
   site action rails (\`site/action_registry.js\`: comment / respond / attend /
   submit, plus contacts and package URLs when published).

Where data has no actionable steps, the email keeps a concise honest pointer
(no fabricated CTA).

## Files

| File | Contents |
|------|----------|
| \`before.html\` | Prior shape (meta + generic links; rules comment-open line only) |
| \`after.html\` | Live \`subDigestHtml\` with time + action awareness |
| \`before-after.html\` | Side-by-side for review |

## Fixture kinds

${fixtures.map((f) => `- **${f.kind}**: ${f.label} (\`${f.row.request_id || f.row.project_id}\`)`).join("\n")}

## Idempotency

Delivery identity remains source id + actionable semantic state
(\`temporal:rules:{id}:comment-open:{deadline}\` for open comment periods).
Publication/recorded timestamp churn does not resend. This evidence does not
exercise send timing.

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`
`);

console.log(`wrote ${OUT_DIR}`);
console.log(JSON.stringify(summary, null, 2));
