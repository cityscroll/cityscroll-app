#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { buildExamProcessSpine } from "../site/exam_process_spine.mjs";
import { buildExamPhaseView } from "../site/exam_phase_spine.mjs";
import { renderExamDocument, examDocumentPath } from "../site/exam_document.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

export function examDocumentOutputs(artifact = JSON.parse(readFileSync(join(SITE, "data/staffing_exams.json"), "utf8"))) {
  const today = String(artifact.data_current_as_of || artifact.generated_at || "").slice(0, 10);
  return (artifact.exams || []).map((exam) => {
    const spine = buildExamProcessSpine(exam);
    const path = join(SITE, examDocumentPath(exam.exam_number), "index.html");
    const content = renderExamDocument(exam, {
      today,
      status: Staffing.statusFor(exam, today),
      feeSalary: Staffing.examFeeSalaryView(exam),
      outcome: Staffing.examOutcomeView(exam),
      phaseView: buildExamPhaseView(spine),
    });
    return [path, content];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of examDocumentOutputs()) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      stale += 1;
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        console.log("wrote", path);
      }
    }
  }
  if (check && stale) {
    console.error(`${stale} exam document artifact(s) are stale`);
    process.exit(1);
  }
  console.log(check ? `Exam documents are current (${examDocumentOutputs().length})` : `Exam documents built (${examDocumentOutputs().length})`);
}
