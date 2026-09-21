import assert from "node:assert/strict";
import test from "node:test";

import { buildPublicBodyCalendarIndex } from "../site/public_body_calendar_integration.mjs";
import {
  collapseMeetingDeliveryRows,
  meetingDeliveryEligibility,
  meetingDeliveryKey,
} from "../site/meeting_delivery_identity.mjs";
import { reconcileTemporalCandidates } from "../worker/src/lib/alert_temporal.mjs";

const NOW = "2026-10-01T12:00:00Z";
const RECEIPT = { observed_at: NOW, source_url: "https://official.example/calendar" };

function row(contract, id, title = "Same public proceeding") {
  return {
    source_contract_id: contract,
    publisher_identifier: id,
    source_url: `https://official.example/${contract}/${id}`,
    source_receipt: RECEIPT,
    event_date: "2026-10-12T18:00:00",
    timezone: "America/New_York",
    temporal_basis: "explicit_instance",
    schedule_basis: "publisher_event",
    title,
  };
}

test("A2: exact cross-post aliases deliver once while unmatched similarities stay separate", () => {
  const sharedPermalink = "https://official.example/proceeding/42";
  const left = row("nycps_pep", "pep-shared");
  left.source_url = sharedPermalink;
  const right = row("brooklyn_bp_ulurp", "ulurp-shared");
  right.source_url = sharedPermalink;
  const similar = row("ccrb_board", "ccrb-similar");
  const leftId = "meeting:public_body_calendar:nycps_pep:pep-shared";
  const rightId = "meeting:public_body_calendar:brooklyn_bp_ulurp:ulurp-shared";
  const index = buildPublicBodyCalendarIndex({
    sources: { nycps_pep: { rows: [left] }, brooklyn_bp_ulurp: { rows: [right] }, ccrb_board: { rows: [similar] } },
    aliases: [{
      meeting_ids: [leftId, rightId],
      evidence: { kind: "exact_permalink_identity", value: sharedPermalink, exact: true },
    }],
    now: NOW,
  });
  const collapsed = collapseMeetingDeliveryRows(index.rows);
  assert.equal(collapsed.length, 2, "near-duplicate titles and dates remain separate without exact evidence");
  assert.equal(collapsed.filter((rowValue) => rowValue.delivery_aliases?.length === 2).length, 1, "the exact alias creates one delivery cluster");
  const delivered = reconcileTemporalCandidates({ lens: "meetings", idField: "meeting_id", rows: collapsed, seen: new Set() });
  assert.equal(delivered.fresh.length, 2, "one exact cross-post cluster plus one unmatched meeting produce two deliveries");
  assert.equal(new Set(delivered.markSeenIds).size, 3, "delivery watermark records both source identities and the stable cluster identity");
  assert.equal(meetingDeliveryKey(collapsed.find((rowValue) => rowValue.delivery_aliases?.length === 2)), [leftId, rightId].sort()[0], "the cluster key remains a stable exact source identity");
});

test("A2: an exact shared publisher identifier is also a delivery alias", () => {
  const first = row("nycps_pep", "shared-publisher-id");
  const second = row("ccrb_board", "shared-publisher-id");
  const firstId = "meeting:public_body_calendar:nycps_pep:shared-publisher-id";
  const secondId = "meeting:public_body_calendar:ccrb_board:shared-publisher-id";
  const index = buildPublicBodyCalendarIndex({
    sources: { nycps_pep: { rows: [first] }, ccrb_board: { rows: [second] } },
    aliases: [{ meeting_ids: [firstId, secondId], evidence: { kind: "exact_publisher_identifier", value: "shared-publisher-id", exact: true } }],
    now: NOW,
  });
  assert.equal(collapseMeetingDeliveryRows(index.rows).length, 1, "exact shared publisher identity collapses the cross-post");
});

test("A3: same-contract collisions and weak alias claims fail closed", () => {
  assert.throws(
    () => buildPublicBodyCalendarIndex({ sources: { nycps_pep: { rows: [row("nycps_pep", "duplicate"), row("nycps_pep", "duplicate")] } }, now: NOW }),
    /identity collision/,
    "a repeated publisher identity raises a collision error",
  );
  assert.throws(
    () => buildPublicBodyCalendarIndex({
      sources: { nycps_pep: { rows: [row("nycps_pep", "a")] }, brooklyn_bp_ulurp: { rows: [row("brooklyn_bp_ulurp", "b")] } },
      aliases: [{ meeting_ids: ["meeting:public_body_calendar:nycps_pep:a", "meeting:public_body_calendar:brooklyn_bp_ulurp:b"], evidence: { kind: "title_similarity", value: "same title", exact: false } }],
      now: NOW,
    }),
    /exact evidence/,
    "an unmatched similarity cannot create a delivery alias",
  );
});

test("A2: typical recurrence and conflicted schedules never trigger automatic email", () => {
  const typical = { meeting_id: "meeting:public_body_calendar:ccrb_board:typical", temporal_basis: "typical_recurrence", schedule: { basis: "typical_recurrence" } };
  const conflicted = { meeting_id: "meeting:public_body_calendar:ccrb_board:conflicted", temporal_basis: "explicit_instance", schedule: { status: "conflicted", basis: "publisher_event" } };
  assert.deepEqual(meetingDeliveryEligibility(typical), { eligible: false, reason: "typical_recurrence_requires_confirmation" }, "typical recurrence is visible evidence but not an automatic delivery candidate");
  const reconciled = reconcileTemporalCandidates({ lens: "meetings", idField: "meeting_id", rows: [typical, conflicted], seen: new Set() });
  assert.deepEqual(reconciled.fresh, [], "typical and conflicted schedules do not enter unattended delivery");
  assert.deepEqual(reconciled.markSeenIds, [], "ineligible candidates are not marked delivered");
});
