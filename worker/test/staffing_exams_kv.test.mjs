/**
 * Staffing exams KV cutover: SODA + OASys overlay → ALERT_STATE, committed floor.
 *
 *   node --test worker/test/staffing_exams_kv.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  handleStaffingExams,
  refreshStaffingExams,
  STAFFING_EXAMS_KV_KEY,
} from "../src/staffing_exams.mjs";
import {
  committedStaffingExamsFloor,
  loadStaffingExams,
  overlayStaffingExams,
  parseStaffingExamsRecord,
  staffingExamsContentHash,
  staffingExamsKvAcceptable,
} from "../src/lib/staffing_exams_kv.mjs";
import { compileSub, rowsForCompiledQuery, STAFFING_EXAMS } from "../src/lib/compile.mjs";

const FLOOR = committedStaffingExamsFloor();
const NOW = new Date("2026-08-23T08:00:00.000Z");

function memoryKV(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

/**
 * Overlay subjects are read from the committed floor. The published schedule
 * rolls with each fiscal year, so writing exam numbers into the fixture makes
 * it fail the day one of them leaves the schedule.
 */
const ANNUAL_SUBJECT = FLOOR.exams[0].exam_number;
const OASYS_SUBJECT = FLOOR.exams[1].exam_number;

function listRecords(n = 120) {
  return Array.from({ length: n }, (_, i) => ({
    exam_number: String(6000 + i),
    list_count: 10 + i,
    established_date: "2026-08-19",
    extension_date: null,
    title_count: 1,
  }));
}

function staffingFetch({
  annual = [{
    exam_number: ANNUAL_SUBJECT,
    exam_title: "Overlay subject",
    application_period_start: "2026-09-01",
    application_period_end_date: "2026-09-21",
    open_competitive_promotion: "Open-Competitive",
    data_current_as_of: "2026-08-22",
  }],
  list = listRecords(),
  oasys = [{ examId: 9619, examNumber: OASYS_SUBJECT, title: "Overlay subject", isPromotional: false }],
} = {}) {
  return async (url) => {
    const href = decodeURIComponent(String(url));
    if (href.includes("4ptz-hmtc.json") && href.includes("max(data_current_as_of)")) {
      return { ok: true, json: async () => [{ latest: "2026-08-22" }] };
    }
    if (href.includes("4ptz-hmtc.json")) {
      return { ok: true, json: async () => annual };
    }
    if (href.includes("vx8i-nprf.json")) {
      return {
        ok: true,
        json: async () => list.map((row) => ({
          exam_no: row.exam_number,
          list_count: String(row.list_count),
          established_date: row.established_date,
          extension_date: row.extension_date,
          title_count: String(row.title_count),
        })),
      };
    }
    if (href.includes("GetActiveExams")) {
      return { ok: true, json: async () => oasys };
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

test("committed floor is the shape Staffing and compile already consume", () => {
  assert.equal(FLOOR.schema_version, 6);
  assert.ok(Array.isArray(FLOOR.exams) && FLOOR.exams.length >= 100);
  // Shape, not named rows: every exam still names one cycle and the schedule
  // join survived into the committed floor.
  assert.ok(FLOOR.exams.every((exam) => /^\d{4}$/.test(String(exam.exam_number))));
  assert.ok(
    FLOOR.exams.filter((exam) => exam.application_start && exam.application_end).length
      >= FLOOR.exams.length * 0.9,
  );
  const parsed = parseStaffingExamsRecord(JSON.stringify(FLOOR));
  assert.equal(parsed.exams.length, FLOOR.exams.length);
  assert.equal(staffingExamsKvAcceptable(parsed), true);
});

test("cold, empty, unparseable, and failed KV fall back to the committed JSON", async () => {
  const none = await loadStaffingExams({});
  assert.equal(none.source, "committed_floor");
  assert.equal(none.record, FLOOR);

  const empty = await loadStaffingExams({ ALERT_STATE: memoryKV() });
  assert.equal(empty.source, "committed_floor");
  assert.equal(empty.record.exams.length, FLOOR.exams.length);

  const garbage = await loadStaffingExams({
    ALERT_STATE: memoryKV({ [STAFFING_EXAMS_KV_KEY]: "not-json" }),
  });
  assert.equal(garbage.source, "committed_floor");

  const tooSmall = await loadStaffingExams({
    ALERT_STATE: memoryKV({
      [STAFFING_EXAMS_KV_KEY]: JSON.stringify({
        schema_version: 6,
        exams: [{ exam_number: "7016" }],
        interest_areas: [],
        sources: [],
      }),
    }),
  });
  assert.equal(tooSmall.source, "committed_floor");

  const throwing = await loadStaffingExams({
    ALERT_STATE: { async get() { throw new Error("kv down"); } },
  });
  assert.equal(throwing.source, "committed_floor");
  assert.equal(throwing.record.exams.length, FLOOR.exams.length);
});

test("GET /staffing-exams serves KV when present and the floor when not", async () => {
  const live = {
    ...FLOOR,
    generated_at: "2099-01-01",
    kv_refreshed_at: "2099-01-01T00:00:00.000Z",
  };
  const kvHit = await handleStaffingExams(
    new Request("https://api.cityscroll.org/staffing-exams"),
    { ALERT_STATE: memoryKV({ [STAFFING_EXAMS_KV_KEY]: JSON.stringify(live) }) },
  );
  assert.equal(kvHit.status, 200);
  const kvBody = await kvHit.json();
  assert.equal(kvBody.schema_version, 6);
  assert.equal(kvBody.generated_at, "2099-01-01");
  assert.equal(Array.isArray(kvBody.exams), true);
  assert.equal("stale" in kvBody, true);

  const floorHit = await handleStaffingExams(
    new Request("https://api.cityscroll.org/staffing-exams"),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(floorHit.status, 200);
  assert.equal((await floorHit.json()).exams.length, FLOOR.exams.length);
});

test("refresh overlays SODA windows and OASys links, and hashes skip unchanged exam facts", async () => {
  const kv = memoryKV();
  const result = await refreshStaffingExams(
    { ALERT_STATE: kv },
    { fetchImpl: staffingFetch(), now: NOW },
  );
  assert.equal(result.status, "success");
  assert.ok(result.exam_count >= 100);
  const stored = parseStaffingExamsRecord(kv.values.get(STAFFING_EXAMS_KV_KEY));
  assert.ok(stored);
  assert.equal(stored.refresh_mode, "worker_cron_overlay");
  const overlaid = stored.exams.find((exam) => exam.exam_number === ANNUAL_SUBJECT);
  assert.equal(overlaid.application_start, "2026-09-01");
  assert.equal(overlaid.application_end, "2026-09-21");
  const deepLinked = stored.exams.find((exam) => exam.exam_number === OASYS_SUBJECT);
  assert.match(String(deepLinked.official_application_url || ""), /examId=9619/);

  const again = await refreshStaffingExams(
    { ALERT_STATE: kv },
    { fetchImpl: staffingFetch(), now: new Date("2026-08-24T08:00:00.000Z") },
  );
  assert.equal(again.status, "success");
  assert.equal(again.unchanged, true);
  const storedAgain = parseStaffingExamsRecord(kv.values.get(STAFFING_EXAMS_KV_KEY));
  assert.equal(staffingExamsContentHash(stored), staffingExamsContentHash(storedAgain));
  assert.equal(storedAgain.kv_refreshed_at !== stored.kv_refreshed_at, true);
  assert.equal((await refreshStaffingExams({})).status, "skipped");
});

test("people/guide compile reads the KV payload and falls back to the floor", async () => {
  // The guide answers for an exam inside its filing window, so the subject and
  // the day are taken from the same committed row rather than pinned.
  const subject = FLOOR.exams.find((exam) => exam.application_start && exam.application_end);
  assert.ok(subject, "the committed floor still carries a dated exam");
  const q = compileSub({
    lens: "people",
    filter: { view: "guide", examNumber: subject.exam_number },
  }, subject.application_start);
  assert.equal(q.url, STAFFING_EXAMS);
  const kvRows = await rowsForCompiledQuery(q, {
    ALERT_STATE: memoryKV({
      [STAFFING_EXAMS_KV_KEY]: JSON.stringify({
        ...FLOOR,
        generated_at: "2099-01-01",
        kv_refreshed_at: "2099-01-01T00:00:00.000Z",
      }),
    }),
  });
  assert.equal(kvRows.length, 1);
  assert.equal(kvRows[0].exam_number, subject.exam_number);

  const floorRows = await rowsForCompiledQuery(q, {});
  assert.ok(floorRows.some((row) => row.exam_number === subject.exam_number));
});

test("overlay keeps densify extras while updating windows", () => {
  const overlaid = overlayStaffingExams(FLOOR, {
    annualRows: [{
      exam_number: ANNUAL_SUBJECT,
      exam_title: "Overlay subject",
      application_period_start: "2026-10-01",
      application_period_end_date: "2026-10-21",
      open_competitive_promotion: "Open-Competitive",
      data_current_as_of: "2026-08-22",
    }],
    listRecords: listRecords(),
    now: NOW,
  });
  const subject = overlaid.exams.find((exam) => exam.exam_number === ANNUAL_SUBJECT);
  assert.equal(subject.application_start, "2026-10-01");
  assert.ok(subject.fee != null || subject.notice_url || subject.title);
});

test("scheduled staffing refresh is public SODA + OASys, not a secret-bearing path", () => {
  const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/staffing_exams_kv.mjs", import.meta.url), "utf8");
  assert.match(worker, /event\.cron === "0 8 \* \* \*"/);
  assert.match(worker, /refreshStaffingExams\(env\)/);
  assert.match(lib, /4ptz-hmtc/);
  assert.match(lib, /vx8i-nprf/);
  assert.match(lib, /GetActiveExams/);
  assert.match(lib, /staffingExamsContentHash/);
  assert.doesNotMatch(lib, /process\.env|SECRET|API_KEY|LEGISTAR|token=/i);
});
