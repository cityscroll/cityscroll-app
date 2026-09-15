import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseBsaAgendaPages, createBsaContainsScheduleRelation, bsaCalendarOccurrences } from "../site/bsa_calendar.mjs";
import { todayISO } from "./helpers/test_clock.mjs";

const sourceFixture = JSON.parse(readFileSync(new URL("./fixtures/bsa/september-14-15-2026.json", import.meta.url)));
function addDays(day, days) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function longDate(day) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}
const fixtureDays = [addDays(todayISO(), 1), addDays(todayISO(), 2)];
const fixture = {
  ...sourceFixture,
  publication_date: todayISO(),
  pages: sourceFixture.pages.map((page) => ({
    ...page,
    ...(page.date ? { date: fixtureDays[page.date === "2026-09-15" ? 1 : 0] } : {}),
    text: String(page.text || "")
      .replaceAll("2026-09-14", fixtureDays[0])
      .replaceAll("2026-09-15", fixtureDays[1])
      .replaceAll("September 14, 2026", longDate(fixtureDays[0]))
      .replaceAll("September 15, 2026", longDate(fixtureDays[1])),
  })),
};
const sessions = parseBsaAgendaPages(fixture);

test("the dated six-page agenda creates two timed daily sessions with day-local registration", () => {
  assert.deepEqual(sessions.map((row) => row.event_date), fixtureDays.map((day) => `${day}T10:00:00`));
  assert.deepEqual(sessions.map((row) => row.agenda_items.length), [21, 4]);
  assert.equal(sessions[0].remote_registration_url.endsWith("day-one"), true);
  assert.equal(sessions[1].remote_registration_url.endsWith("day-two"), true);
  assert.deepEqual(bsaCalendarOccurrences(sessions).map((row) => row.starts_at), sessions.map((row) => row.event_date));
});

test("historical case dates do not create extra upcoming occurrences and the notice relation is explicit", () => {
  const relation = createBsaContainsScheduleRelation({ request_id: "20260817015", source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260817015" }, sessions);
  assert.equal(relation.relation, "contains_schedule");
  assert.deepEqual(relation.to, sessions.map((row) => row.meeting_id));
  assert.equal(relation.method, "explicit_dated_agenda_sections");
  assert.equal(bsaCalendarOccurrences(sessions).length, 2);
  assert.equal(sessions.flatMap((row) => row.agenda_items).some((item) => item.case_id === "2024-58-BZ"), true);
});

test("item lifecycle and affected geography stay below the session and separate from the venue", () => {
  const first = sessions[0].agenda_items.find((item) => item.case_id === "2024-58-BZ");
  assert.equal(first.section, "adjournments");
  assert.equal(first.lifecycle.state, "adjourned");
  assert.deepEqual(first.affected_area.community_districts, ["K15"]);
  assert.equal(sessions[0].venue.address.includes("22 Reade Street"), true);
  assert.equal(sessions[0].venue.address.includes("1228 Avenue V"), false);
  assert.deepEqual(sessions[0].phases.map((phase) => phase.id).length, 2);
  assert.equal(sessions[0].phases.some((phase) => phase.state === "applicant_response_and_public_testimony"), true);
  assert.equal(sessions[0].agenda_items.every((item) => item.disposition === null), true);
});

test("the rendered agenda exposes cases and returns through the canonical day route", () => {
  if (!existsSync(new URL("../site/data/legislative_matter_index.json", import.meta.url))) return;
  return import("../site/meeting_document.mjs").then(({ renderMeetingDocument }) => {
  const html = renderMeetingDocument(sessions[0], { generated_at: fixture.publication_date, rows: [sessions[0]], sources: { bsa_calendar: { status: "available", row_count: 2 } } });
  assert.match(html, /data-agenda-items="21"/);
  assert.match(html, /2024-58-BZ/);
  assert.match(html, /K15/);
  assert.match(html, /22 Reade Street/);
  assert.match(html, /Executive review is a public observation phase/);
  assert.match(html, /applicant response and public testimony/);
  assert.match(html, /href="\/browse\/meetings\/"/);
  assert.match(html, new RegExp(`meeting:bsa_calendar:bsa-${fixtureDays[0]}`));
  });
});

test("BSA sessions cross the shared read-model boundary as native source rows", () => {
  if (!existsSync(new URL("../site/data/legislative_matter_index.json", import.meta.url))) return;
  return import("../site/shared_meeting_read_model.mjs").then(({ buildSharedMeetingReadModel }) => {
  const model = buildSharedMeetingReadModel({
    bsaCalendarIndex: { generated_at: fixture.publication_date, rows: sessions },
    generatedAt: fixture.publication_date,
    now: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(model.sources.bsa_calendar.status, "available");
  assert.equal(model.counts.bsa_calendar, 2);
  assert.deepEqual(model.rows.filter((row) => row.source_system === "bsa_calendar").map((row) => row.event_date), ["2026-09-15T10:00:00", "2026-09-14T10:00:00"]);
  assert.equal(model.rows.find((row) => row.bsa_session_id === "bsa-2026-09-14").agenda_items.length, 21);
  });
});
