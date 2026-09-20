import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildBsaSession, parseBsaAgendaPages } from "../site/bsa_calendar.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/bsa/september-14-15-2026.json", import.meta.url)));
const agendaUrl = "https://www.nyc.gov/assets/bsa/downloads/pdf/lineup/september_14_15_2026_public_hearing.pdf";

test("BSA carries the published hearing clock as document-backed evidence", () => {
  const sessions = parseBsaAgendaPages({ ...fixture, notice: { agenda_url: agendaUrl } });
  assert.deepEqual(sessions.map((row) => row.event_date), ["2026-09-14T10:00:00", "2026-09-15T10:00:00"]);
  assert.ok(sessions.every((row) => row.schedule.basis === "publisher_document"));
  assert.ok(sessions.every((row) => row.source_entry_evidence.source_url === agendaUrl));
  assert.ok(sessions.every((row) => /10:00 A\.M\./.test(row.source_entry_evidence.excerpt)));
  assert.match(sessions[0].source_entry_evidence.excerpt, /September 14, 2026, 10:00 A\.M\./);
});

test("BSA does not manufacture a clock when an agenda header is date-only", () => {
  const session = buildBsaSession({ session_id: "bsa-date-only", date: "2026-10-01", source_url: agendaUrl });
  assert.equal(session.event_date, "2026-10-01");
  assert.equal(session.schedule.precision, "date_only");
  assert.equal(session.schedule.starts_at, null);
  assert.equal(Object.hasOwn(session, "source_entry_evidence"), false);
});
