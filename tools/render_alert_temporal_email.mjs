import { subDigestHtml } from "../worker/src/alerts.mjs";

const row = {
  request_id: "20260715001",
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
    url: "https://rules.cityofnewyork.us/rule/commercial-curb-use/",
  },
};

const email = subDigestHtml(
  "rules & notices — Department of Transportation",
  "rules",
  [row],
  "https://api.cityscroll.org/unsubscribe?token=example",
  "2026-07-31",
  "https://api.cityscroll.org",
  [],
  "en",
);

process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:32px;background:#f5f1e8;color:#24211d}body>div{background:white;padding:28px;border:1px solid #ded7ca;border-radius:10px;box-shadow:0 8px 30px rgba(50,42,30,.08)}a{color:#245e52}</style></head><body>${email}</body></html>`);
