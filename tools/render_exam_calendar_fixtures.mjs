#!/usr/bin/env node
/**
 * Render the committed exam-calendar fixtures (test/fixtures/exam_calendar_fixtures.mjs)
 * into standalone documents for the headless evidence capture
 * (tools/capture_exam_calendar_evidence.py).
 *
 * Output goes to a caller-chosen, gitignored directory — never into site/ —
 * and a manifest records each case's route, date/source state, and expected
 * render outcome so the capture asserts against the same contract the unit
 * tests pin.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildExamPhaseView } from "../site/exam_phase_spine.mjs";
import { buildExamProcessSpine } from "../site/exam_process_spine.mjs";
import { buildExamCalendarView } from "../site/exam_calendar.mjs";
import { examDocumentPath, renderExamDocument } from "../site/exam_document.mjs";
import { EXAM_CALENDAR_FIXTURES, FIXTURE_TODAY } from "../test/fixtures/exam_calendar_fixtures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outDir() {
  const index = process.argv.indexOf("--out");
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("usage: render_exam_calendar_fixtures.mjs --out <dir>");
  }
  return resolve(ROOT, process.argv[index + 1]);
}

export function renderFixtureDocuments(dir) {
  const manifest = [];
  for (const [name, exam] of Object.entries(EXAM_CALENDAR_FIXTURES)) {
    const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
    const html = renderExamDocument(exam, {
      today: FIXTURE_TODAY,
      feeSalary: {},
      phaseView: buildExamPhaseView(buildExamProcessSpine(exam)),
    });
    const route = `/__capture__/exam-calendar/${name}/`;
    const path = join(dir, name, "index.html");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
    manifest.push({
      case: name,
      exam_number: exam.exam_number,
      route,
      today: FIXTURE_TODAY,
      canonical_path: examDocumentPath(exam.exam_number),
      date_state: {
        application_start: exam.application_start ?? null,
        application_end: exam.application_end ?? null,
        exam_date: exam.exam_date ?? null,
        predicted_list_window: exam.list_establishment_forecast?.prediction?.predicted_window ?? null,
      },
      source_state: {
        schedule_status: exam.schedule_status ?? null,
        filing_mode: exam.filing_mode ?? null,
        notice_url: exam.notice_url ?? null,
      },
      expected: {
        render: view.render,
        reason: view.render ? "eligible" : view.reason,
      },
    });
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ today: FIXTURE_TODAY, cases: manifest }, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = renderFixtureDocuments(outDir());
  console.log(`rendered ${manifest.length} fixture documents`);
}
