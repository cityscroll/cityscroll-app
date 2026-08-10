import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleBackfillRequest,
  assertRecoveryPath,
  CarryForwardRunnerError,
  extractOwnerSnapshots,
} from "../scripts/carry_forward_backfill.mjs";
import { deriveBackfillTestData } from "./helpers/digest_backfill_fixture.mjs";

function shadowPreview() {
  const data = deriveBackfillTestData();
  const rules = data.sourceSnapshots.rules.map((entry) =>
    `<li data-digest-item="1"><b><a href="https://api.cityscroll.org/r/rules/${entry.request_id}">${entry.render_snapshot.short_title}</a></b><br><span style="color:#555">Agency ${entry.request_id}</span></li>`).join("");
  const land = `<li data-digest-item="1"><b><a href="https://zap.planning.nyc.gov/projects/2023M0452">Land</a></b></li>`;
  const meetings = data.sourceSnapshots.meetings.map((entry) =>
    `<li data-digest-item="1"><b><a href="https://api.cityscroll.org/r/meetings/${entry.request_id}">${entry.render_snapshot.short_title}</a></b><br><span style="color:#555">Agency ${entry.request_id}</span><ul><li>Event: ${entry.render_snapshot.event_date}</li></ul></li>`).join("");
  const encoded = Buffer.from(JSON.stringify({ e: "owner@example.com" })).toString("base64url");
  return {
    digest_id: "digest:test-owner",
    recipient_redacted: "ja***@gmail.com",
    watch_counts: [
      { lens: "rules", item_count: 25 },
      { lens: "land", item_count: 1 },
      { lens: "meetings", item_count: 20 },
    ],
    html: `${rules}${land}${meetings}<a href="https://api.cityscroll.org/r/rules/${data.sourceSnapshots.rules[0].request_id}?s=${encoded}.sig">owner</a>`,
  };
}

function stats() {
  return {
    digests: {
      catch_up_last_run: {
        ranAt: "2026-08-10T15:31:20.772Z",
        status: "sent",
        results: [{
          emailRedacted: "ja***@gmail.com",
          sent: true,
          noticeIds: ["2020Q0317"],
          sections: [{ lens: "land", new: 1 }],
        }],
      },
    },
  };
}

test("runner refuses a shadow whose identity set is not the exact 45-item manifest", () => {
  const preview = shadowPreview();
  preview.html = preview.html.replace("20260804030", "not-the-manifest");
  assert.throws(() => extractOwnerSnapshots(preview), CarryForwardRunnerError);
});

test("request assembly proves the delivered land evidence and excludes it from owed sections", () => {
  const request = assembleBackfillRequest({
    shadow: { run_day: "2026-08-10" },
    preview: shadowPreview(),
    stats: stats(),
  });
  assert.equal(request.source_snapshots.rules.length, 25);
  assert.equal(request.source_snapshots.meetings.length, 20);
  assert.equal(request.delivery_evidence.item_id, "land:project:2020Q0317");
  assert.equal(request.delivery_evidence.provider_accepted_at, "2026-08-10T15:31:20.772Z");
  assert.equal(request.source_snapshots.rules.some((entry) => entry.request_id === "2020Q0317"), false);
});

test("runner rejects every provider or drain endpoint before any request is made", () => {
  assert.throws(() => assertRecoveryPath("https://api.cityscroll.org/admin/digest-send-test"), CarryForwardRunnerError);
  assert.throws(() => assertRecoveryPath("https://api.cityscroll.org/admin/digest-catchup"), CarryForwardRunnerError);
  assert.doesNotThrow(() => assertRecoveryPath("https://api.cityscroll.org/admin/digest-backfill"));
});
