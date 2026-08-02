// Legistar depth recon characterization (authenticated Web API + strict join).
//
//   node --test test/legistar_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alnumSpaces,
  buildMeetingDateIndex,
  committeeMatchesTitle,
  distinctiveTokens,
  joinNoticeToCouncilMeeting,
  meetingDetailUrl,
  matterDetailUrl,
} from "../worker/src/lib/legistar_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/legistar/join_cases.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/legistar_sources/verification_receipts/legistar_depth_2026-07-30.json",
    ),
    "utf8",
  ),
);

const meetings = cases.cases
  .map((c) => c.meeting)
  .filter((m) => m && (m.event_id || m.EventId));
// Same-day false-friend so rejection is explicit.
meetings.push({
  event_id: "20677",
  committee: "Subcommittee on Zoning and Franchises",
  meeting_date: "2024-03-26T00:00:00.000",
});
const index = buildMeetingDateIndex(meetings);

test("alnumSpaces and distinctiveTokens normalize body labels", () => {
  assert.equal(
    alnumSpaces("Subcommittee on Zoning and Franchises"),
    "subcommittee on zoning and franchises",
  );
  assert.deepEqual(distinctiveTokens("Subcommittee on Zoning and Franchises"), [
    "zoning",
    "franchises",
  ]);
});

test("committeeMatchesTitle accepts comma variants and rejects loose zoning titles", () => {
  assert.equal(
    committeeMatchesTitle(
      "Subcommittee on Landmarks, Public Sitings and Dispositions",
      "10-8-24 Subcommittee on Landmarks, Public Sitings, and Dispositions meeting",
    ),
    true,
  );
  assert.equal(
    committeeMatchesTitle(
      "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions",
      "Correction: 7-14-26 Subcommittee on Landmarks, Public Sitings, Resiliency, and Dispositions meeting",
    ),
    true,
  );
  assert.equal(
    committeeMatchesTitle(
      "Subcommittee on Zoning and Franchises",
      "3-26-24 Subcommittee on Zoning and Land Use meeting",
    ),
    false,
  );
});

test("strict join accepts Legistar EventBodyName and Open Data committee shapes", () => {
  const apiHit = joinNoticeToCouncilMeeting(
    {
      short_title:
        "Correction: 7-14-26 Subcommittee on Landmarks, Public Sitings, Resiliency, and Dispositions meeting",
      event_date: "2026-07-14",
    },
    index,
  );
  assert.ok(apiHit);
  assert.equal(apiHit.method, "exact_date_body_tokens");
  assert.equal(apiHit.event_id, "22526");

  const odHit = joinNoticeToCouncilMeeting(
    {
      short_title: "12-12-24 Subcommittee on Zoning and Franchises",
      event_date: "2024-12-12",
    },
    index,
  );
  assert.ok(odHit);
  assert.equal(odHit.event_id, "21247");
});

test("strict join rejects loose same-day body mismatches", () => {
  assert.equal(
    joinNoticeToCouncilMeeting(
      {
        short_title: "3-26-24 Subcommittee on Zoning and Land Use meeting",
        event_date: "2024-03-26",
      },
      index,
    ),
    null,
  );
});

test("field-case fixtures match the accepted/rejected strategy table", () => {
  for (const c of cases.cases) {
    const hit = joinNoticeToCouncilMeeting(c.notice, index);
    if (c.expect === "joined") {
      assert.ok(hit, c.id);
      assert.equal(hit.method, c.method, c.id);
      const expectedId = String(c.meeting.EventId || c.meeting.event_id);
      assert.equal(hit.event_id, expectedId, c.id);
    } else {
      assert.equal(hit, null, c.id);
    }
  }
});

test("meetingDetailUrl prefers publisher url object and falls back to LEGID", () => {
  assert.match(meetingDetailUrl({ event_id: "99" }), /LEGID=99/);
  assert.match(meetingDetailUrl({ EventId: 22526 }), /LEGID=22526/);
});

test("matterDetailUrl builds Gateway M=L for numeric MatterIds only", () => {
  assert.equal(
    matterDetailUrl(79062),
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79062",
  );
  assert.equal(
    matterDetailUrl("79193"),
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79193",
  );
  assert.equal(matterDetailUrl("mat-001"), null);
  assert.equal(matterDetailUrl(""), null);
  assert.equal(matterDetailUrl(null), null);
});

test("verification receipt records authenticated modern 100% join", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.equal(jm.rates.modern_notices_strict.rate, 1);
  assert.equal(jm.rates.modern_notices_strict.joined, 59);
  assert.equal(jm.rates.modern_notices_strict.total, 59);
  assert.ok(jm.rates.historical_notices_strict.rate > 0.3);
  assert.equal(jm.depth.modern.frac_with_items, 1);
  assert.ok(jm.depth.modern.frac_with_matters >= 0.9);
  assert.match(jm.verdict, /100\.0%|Above ~30%|Above ~30/i);
  assert.equal(receipt.auth.authenticated_events_http, 200);
  assert.equal(receipt.auth.unauthenticated_events_http, 403);
  assert.equal(receipt.auth.token_env, "LEGISTAR_API_TOKEN");
  assert.ok(receipt.auth.token_len > 50);
  assert.match(receipt.auth.token_sha256_12, /^[a-f0-9]{12}$/);
  // Secret hygiene: receipt must not embed the token value.
  const raw = readFileSync(
    join(
      ROOT,
      "site/data/legistar_sources/verification_receipts/legistar_depth_2026-07-30.json",
    ),
    "utf8",
  );
  assert.equal(raw.includes("token="), false);
  assert.ok(!/"token"\s*:\s*"[A-Za-z0-9_]{20,}/.test(raw));
  const demo = jm.demos.modern.find((d) => d.request_id === "20260706036");
  assert.ok(demo, "demo frame missing from receipt");
  assert.equal(demo.event_id, 22526);
  assert.ok(demo.votes_sampled >= 1);
});

test("source contracts record authenticated usefulness above threshold", () => {
  const registry = loadSourceContracts();
  const legistar = registry.contracts.find((c) => c.id === "nyc-council-legistar");
  assert.ok(legistar, "nyc-council-legistar contract missing");
  assert.ok(legistar.join_measurement);
  assert.equal(legistar.join_measurement.rates.modern_notices_strict.rate, 1);
  assert.ok(legistar.join_measurement.rates.modern_notices_strict.rate >= 0.3);
  assert.match(legistar.join_measurement.verdict, /Above usefulness|100%/i);
  assert.equal(legistar.join_measurement.access.webapi_token_required, true);
  assert.equal(legistar.join_measurement.access.authenticated_http, 200);

  const openData = registry.contracts.find((c) => c.id === "city-council-meetings-open-data");
  assert.ok(openData, "city-council-meetings-open-data contract missing");
  assert.equal(openData.status, "disabled");
  assert.equal(openData.join_measurement.rates.modern_notices_strict.rate, 0);
});

test("annotated recon screenshots are present and sha-pinned in the manifest", () => {
  const dir = join(ROOT, "docs/screenshots/legistar-depth-recon");
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4);
  for (const file of manifest.files) {
    const path = join(dir, file.name);
    assert.ok(existsSync(path), file.name);
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    assert.equal(sha, file.sha256, file.name);
    assert.equal(buf.length, file.bytes, file.name);
  }
});
