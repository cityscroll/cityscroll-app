import {
  DELIVERED_LAND_ITEM_ID,
  FIRST_PAYLOAD_ID,
  FIRST_PAYLOAD_MANIFEST,
} from "../../src/digest_backfill.mjs";

const OWNER_EMAIL = "owner@example.com";
const FIRST_OWED_AT = "2026-08-10T16:00:00Z";
const DELIVERY_EVIDENCE = {
  reconciled: true,
  item_id: DELIVERED_LAND_ITEM_ID,
  provider_accepted_at: "2026-08-10T15:31:15Z",
  evidence_ref: "provider-receipt:recovery-2026-08-10",
};

function sourceSnapshots() {
  return {
    rules: FIRST_PAYLOAD_MANIFEST.rules.map((requestId, index) => ({
      request_id: requestId,
      source_date: `2026-08-${String(4 + (index % 4)).padStart(2, "0")}`,
      action_key: `temporal:rules:${requestId}:comment-open:2026-08-20`,
      render_snapshot: {
        request_id: requestId,
        short_title: `Rule ${requestId}`,
        start_date: `2026-08-${String(4 + (index % 4)).padStart(2, "0")}`,
      },
    })),
    meetings: FIRST_PAYLOAD_MANIFEST.meetings.map((requestId, index) => ({
      request_id: requestId,
      source_date: `2026-08-${String(4 + (index % 4)).padStart(2, "0")}`,
      render_snapshot: {
        request_id: requestId,
        short_title: `Meeting ${requestId}`,
        event_date: `2026-08-${String(12 + (index % 10)).padStart(2, "0")}`,
      },
    })),
  };
}

export function deriveBackfillTestData() {
  const keys = [
    ["sub:owner-rules", "rules"],
    ["sub:owner-money-one", "money"],
    ["sub:owner-money-two", "money"],
    ["sub:owner-land", "land"],
    ["sub:owner-meetings", "meetings"],
    ["sub:other-rules", "rules"],
  ];
  const subscriptions = keys.map(([key, lens]) => ({
    key,
    record: {
      email: key.includes("other") ? "other@example.com" : OWNER_EMAIL,
      lens,
      filter: { fixture: lens },
    },
  }));
  return {
    payloadId: FIRST_PAYLOAD_ID,
    ownerEmail: OWNER_EMAIL,
    firstOwedAt: FIRST_OWED_AT,
    deliveryEvidence: DELIVERY_EVIDENCE,
    sourceSnapshots: sourceSnapshots(),
    subscriptions,
  };
}
