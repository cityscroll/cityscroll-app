import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLiveUpcomingCouncilMeetingsSnapshot,
  buildUpcomingCouncilMeetingsSnapshot,
  buildUpcomingCouncilMeetingsSnapshotFromAcquisition,
  buildUpcomingAcquisitionReceipt,
  readLegistarToken,
} from "../tools/build_upcoming_council_meetings_snapshot.mjs";
import { buildFirstClassFreshnessReport, productionFreshnessFindings } from "../tools/first_class_refresh.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url), "utf8"),
);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fixture builder remains deterministic for offline unit coverage", () => {
  const raw = buildUpcomingCouncilMeetingsSnapshot(fixture);
  const doc = JSON.parse(raw);
  assert.equal(doc.generated_at, "2026-09-09T12:00:00.000Z");
  assert.equal(doc.counts.meetings, 1);
  assert.equal(doc.meetings[0].identity.event_id, "22691");
});

test("live acquisition refuses to invent a vintage without a token", async () => {
  const result = await acquireLiveUpcomingCouncilMeetingsSnapshot({
    token: null,
    now: new Date("2026-09-16T15:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "token-absent");
});

test("live acquisition stamps generated_at from the run clock and keeps eligible meetings", async () => {
  const now = new Date("2026-09-16T15:00:00.000Z");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/Events?") || href.includes("/Events&") || /\/Events(?:\?|$)/.test(href.split("?")[0] + (href.includes("?") ? "?" : ""))) {
      // Events list page
      if (href.includes("/Events/") && href.includes("/EventItems") === false && /Events\/\d+/.test(href)) {
        return jsonResponse([]);
      }
      if (href.includes("EventItems") || /Events\/\d+\/EventItems/.test(href)) {
        return jsonResponse(fixture.event_items);
      }
      return jsonResponse([fixture.event]);
    }
    if (/Events\/\d+\/EventItems/.test(href) || href.includes("/EventItems")) {
      return jsonResponse(fixture.event_items);
    }
    return jsonResponse([]);
  };

  const result = await acquireLiveUpcomingCouncilMeetingsSnapshot({
    token: "test-token-not-a-secret",
    fetchImpl,
    now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.view.generated_at, now.toISOString());
  assert.equal(result.receipt.source_url, "https://webapi.legistar.com/v1/nyc/Events");
  assert.equal(result.receipt.fetched_at, now.toISOString());
  assert.match(result.receipt.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.row_count, 1);
  assert.ok(result.view.counts.meetings >= 1);
  assert.notEqual(result.view.generated_at, "2026-09-09T12:00:00.000Z");
});

test("the owning builder derives generated_at from the retained acquisition receipt", () => {
  const view = JSON.parse(buildUpcomingCouncilMeetingsSnapshot(fixture));
  const receipt = buildUpcomingAcquisitionReceipt({
    fetchedAt: "2026-09-18T08:30:00.000Z",
    eventRows: [fixture.event],
    itemsByEventId: new Map([[String(fixture.event.EventId), { rows: fixture.event_items, fetchError: null }]]),
  });
  const built = JSON.parse(buildUpcomingCouncilMeetingsSnapshotFromAcquisition({ view, receipt }));
  assert.equal(built.generated_at, receipt.fetched_at);
  assert.equal(built.source_health.observed_at, receipt.fetched_at);
  assert.equal(built.meetings[0].source_receipt.observed_at, receipt.fetched_at);
  assert.notEqual(built.generated_at, "2026-09-09T12:00:00.000Z");
});

test("the upcoming Council artifact has an explicit blocking gate and seven-day limit", () => {
  const registry = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url), "utf8"));
  const artifact = registry.first_class_artifacts.find((row) => row.id === "upcoming-council-meetings");
  assert.equal(artifact.production_freshness_gate, "block");
  assert.equal(artifact.normal_refresh_cadence_hours, 24);
  assert.equal(artifact.warning_age_hours, 48);
  assert.equal(artifact.hard_maximum_age_hours, 168);
  assert.deepEqual(artifact.acquisition_command, ["node", "tools/acquire_upcoming_council_meetings.mjs"]);
  const receipt = JSON.parse(readFileSync(new URL(
    "../site/data/legistar_sources/verification_receipts/upcoming_council_meetings_latest.json",
    import.meta.url,
  ), "utf8"));
  assert.equal(receipt.source_url, "https://webapi.legistar.com/v1/nyc/Events");
  assert.ok(Number.isFinite(Date.parse(receipt.fetched_at)));
  assert.match(receipt.content_hash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(receipt.row_count) && receipt.row_count > 0);
});

test("an unreachable publisher leaves the retained artifact unchanged and makes an old one stale", async () => {
  await withTempDir("upcoming-council-fallback", async (root) => {
    const artifactPath = join(root, "site/data/upcoming_council_meetings.json");
    mkdirSync(join(root, "site/data"), { recursive: true });
    const retained = {
      generated_at: "2026-09-01T08:30:00.000Z",
      counts: { meetings: 1 },
      meetings: [{}],
    };
    const retainedBytes = `${JSON.stringify(retained)}\n`;
    writeFileSync(artifactPath, retainedBytes);

    const result = await acquireLiveUpcomingCouncilMeetingsSnapshot({
      token: "test-token-not-a-secret",
      now: new Date("2026-09-21T08:30:00.000Z"),
      fetchImpl: async () => { throw new Error("publisher unreachable"); },
    });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(artifactPath, "utf8"), retainedBytes);

    const registry = {
      first_class_artifacts: [{
        id: "upcoming-council-meetings",
        public_artifact_path: "site/data/upcoming_council_meetings.json",
        primary_routes: ["/browse/meetings/"],
        source_contract_id: "nyc-council-legistar",
        owning_builder: "tools/build_upcoming_council_meetings_snapshot.mjs",
        production_evidence_field: "first_class.upcoming_council_meetings",
        vintage_fields: ["generated_at"],
        population_fields: ["counts.meetings", "meetings"],
        hard_maximum_age_hours: 168,
        warning_age_hours: 48,
        production_freshness_gate: "block",
      }],
    };
    const report = buildFirstClassFreshnessReport(registry, {
      root,
      now: "2026-09-21T08:30:00.000Z",
    });
    assert.equal(report.surfaces[0].freshness_state, "stale");
    assert.deepEqual(productionFreshnessFindings(report), [
      "site/data/upcoming_council_meetings.json: stale first-class artifact (vintage 2026-09-01T08:30:00.000Z)",
    ]);
  });
});

test("readLegistarToken prefers LEGISTAR_API_TOKEN_FILE without exposing the value", () => {
  assert.equal(readLegistarToken({}), null);
  assert.equal(readLegistarToken({ LEGISTAR_API_TOKEN: "  abc  " }), "abc");
});
