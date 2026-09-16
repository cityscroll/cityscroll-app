import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { meetingsCardInteractionProjection } from "../site/meetings_card_interaction.mjs";
import {
  MEETING_ORIGINS,
  meetingOriginLabel,
  normalizeMeetingOrigin,
} from "../site/meeting_origin.mjs";
import { meetingCanonicalHref } from "../site/meeting_object_contract.mjs";

const require = createRequire(import.meta.url);
const { normalizeHearingRow } = require("../site/hearing_location.js");

const BARE_REQUEST_DETAIL = /a856-cityrecord\.nyc\.gov\/RequestDetail\/?$/i;

function cardProjection(row) {
  const normalized = normalizeHearingRow(row);
  const origin = normalizeMeetingOrigin(normalized);
  const title = normalized.title || "Untitled meeting";
  const projection = meetingsCardInteractionProjection({
    meeting_id: normalized.meeting_id,
    request_id: normalized.request_id,
    title,
    source_url: normalized.source_url,
    source_label: meetingOriginLabel(origin),
  });
  return { normalized, origin, projection };
}

test("OATH and PDC feed cards keep a detail route and a real publisher handoff", () => {
  const oath = cardProjection({
    meeting_id: "meeting:oath_trial_calendar:261372:2026-09-16:09:30:00:Scheduled For Trial",
    source_system: "oath_trial_calendar",
    publisher_identifier: "261372:2026-09-16:09:30:00:Scheduled For Trial",
    oath_index: "261372",
    title: "OATH trial 261372",
    event_date: "2026-09-16T09:30:00",
    meeting_origin: "official_oath_trial_calendar",
    source_url: "https://www.nyc.gov/site/oath/calendar/calendar.page",
  });
  assert.equal(oath.origin, "official_oath_trial_calendar");
  assert.equal(meetingOriginLabel(oath.origin), "OATH trial calendar");
  assert.equal(
    oath.projection.target?.href,
    meetingCanonicalHref(oath.normalized.meeting_id),
  );
  assert.ok(oath.projection.external_handoffs.length >= 1);
  assert.equal(
    oath.projection.external_handoffs[0].href,
    "https://www.nyc.gov/site/oath/calendar/calendar.page",
  );
  assert.doesNotMatch(oath.projection.external_handoffs[0].href, BARE_REQUEST_DETAIL);

  const pdc = cardProjection({
    meeting_id: "meeting:pdc_calendar:pdc-2026-09-22",
    source_system: "pdc_calendar",
    publisher_identifier: "pdc-2026-09-22",
    title: "Public Design Commission meeting",
    event_date: "2026-09-22",
    meeting_origin: "official_pdc_schedule",
    source_url: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page",
  });
  assert.equal(pdc.origin, "official_pdc_schedule");
  assert.equal(meetingOriginLabel(pdc.origin), "Public Design Commission schedule");
  assert.equal(pdc.projection.target?.href, meetingCanonicalHref(pdc.normalized.meeting_id));
  assert.doesNotMatch(pdc.projection.external_handoffs[0].href, BARE_REQUEST_DETAIL);
});

test("published shared meeting rows never yield bare RequestDetail handoffs or missing detail routes", () => {
  const model = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(model.rows) && model.rows.length > 0);

  let oathCount = 0;
  let pdcCount = 0;
  for (const row of model.rows) {
    const { normalized, origin, projection } = cardProjection(row);
    assert.ok(MEETING_ORIGINS.includes(origin), `${row.meeting_id} origin ${origin}`);
    assert.ok(normalized.meeting_id, `missing meeting_id after normalize: ${row.meeting_id}`);
    assert.ok(projection.target?.href, `missing detail route after normalize: ${row.meeting_id}`);
    assert.equal(projection.target.href, meetingCanonicalHref(normalized.meeting_id));

    if (row.source_system === "oath_trial_calendar") {
      assert.equal(origin, "official_oath_trial_calendar", row.meeting_id);
      assert.equal(meetingOriginLabel(origin), "OATH trial calendar");
      oathCount += 1;
    }
    if (row.source_system === "pdc_calendar") {
      assert.equal(origin, "official_pdc_schedule", row.meeting_id);
      assert.equal(meetingOriginLabel(origin), "Public Design Commission schedule");
      pdcCount += 1;
    }

    for (const handoff of projection.external_handoffs || []) {
      assert.doesNotMatch(String(handoff.href || ""), BARE_REQUEST_DETAIL, row.meeting_id);
      if (/RequestDetail\//i.test(String(handoff.href || ""))) {
        assert.match(String(handoff.href), /RequestDetail\/[^/?#]+/i, row.meeting_id);
        assert.ok(normalized.request_id, `RequestDetail without request_id: ${row.meeting_id}`);
      }
    }

    if (normalized.source_system === "city_record") {
      assert.ok(normalized.request_id, row.meeting_id);
      assert.ok(normalized.publisher_identifier, row.meeting_id);
    } else {
      assert.ok(normalized.publisher_identifier || normalized.source_url, row.meeting_id);
    }
  }

  assert.ok(oathCount > 0, "fixture shared model should include OATH trial rows");
  assert.ok(pdcCount > 0, "fixture shared model should include PDC rows");
});
