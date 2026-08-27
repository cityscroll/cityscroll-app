import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildNoticeContextLookup } from "../tools/build_notice_context_lookup.mjs";

const lookup = JSON.parse(readFileSync(new URL("../site/data/notice_context_lookup.json", import.meta.url)));
const noticeContextSource = readFileSync(new URL("../site/app/notice-context.mjs", import.meta.url), "utf8");
const applicationSource = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");

test("Notice context lookup is a source-vintaged resident projection", () => {
  assert.equal(lookup.schema_version, 1);
  assert.equal(lookup.delivery_tier, "resident-snapshot");
  assert.equal(lookup.source, "site/data/money_resident_snapshot.json");
  assert.equal(lookup.count, Object.keys(lookup.by_notice).length);
  assert.ok(lookup.count > 0);
  for (const facts of Object.values(lookup.by_notice)) {
    assert.equal(typeof facts.agency_award_count_12m, "number");
    assert.equal(typeof facts.agency_award_total_12m, "number");
    assert.equal(typeof facts.vendor_award_count_90d, "number");
  }
});

test("Notice context reads the compact lookup instead of the full resident snapshot", () => {
  assert.match(noticeContextSource, /notice_context_lookup\.json/);
  assert.doesNotMatch(noticeContextSource, /residentMoneyRows|money_resident_snapshot/);
});

test("Notice route starts context import early and keeps import marks bounded", () => {
  assert.match(applicationSource, /const NOTICE_ROUTE =/);
  assert.match(applicationSource, /NOTICE_ROUTE \? import\(NOTICE_CONTEXT_MODULE_PATH\) : null/);
  assert.match(applicationSource, /cityscroll\.app-import\.\$\{phase\}/);
  assert.doesNotMatch(applicationSource, /performance\.mark\(.*request_id/);
});

test("lookup preserves Notice context aggregate semantics", () => {
  const snapshot = {
    generated_at: "2026-08-01T00:00:00.000Z",
    rows: [
      { request_id: "sol-1", agency_name: "Agency", type_of_notice_description: "Solicitation", start_date: "2026-01-01", due_date: "2026-01-11" },
      { request_id: "sol-2", agency_name: "Agency", type_of_notice_description: "Solicitation", start_date: "2026-01-02", due_date: "2026-01-14" },
      { request_id: "award-1", agency_name: "Agency", type_of_notice_description: "Award", start_date: "2026-07-15", contract_amount: "100", vendor_name: "Vendor" },
      { request_id: "award-2", agency_name: "Agency", type_of_notice_description: "Award", start_date: "2026-07-20", contract_amount: "200", vendor_name: "Vendor" },
      { request_id: "target", agency_name: "Agency", type_of_notice_description: "Award", start_date: "2026-07-25", contract_amount: "150", vendor_name: "Vendor" },
    ],
  };
  const facts = buildNoticeContextLookup(snapshot).by_notice.target;
  assert.equal(facts.agency_ad_median_days, null, "the existing eight-window floor remains fail-closed");
  assert.equal(facts.agency_award_count_12m, 3);
  assert.equal(facts.agency_award_total_12m, 450);
  assert.equal(facts.agency_awards_at_or_below, 2);
  assert.equal(facts.vendor_award_count_90d, 3);
  assert.equal(facts.vendor_award_total_12m, 450);
});
