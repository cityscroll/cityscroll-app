#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { buildExamProcessSpine } from "../site/exam_process_spine.mjs";
import { buildExamPhaseView } from "../site/exam_phase_spine.mjs";
import { renderExamDocument, examDocumentPath, ELIGIBLE_LIST_GUIDE_HREF } from "../site/exam_document.mjs";
import { buildTitleCodeFamilyIndex } from "../site/title_code_family.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

export function examDocumentOutputs(artifact = JSON.parse(readFileSync(join(SITE, "data/staffing_exams.json"), "utf8"))) {
  const today = String(artifact.data_current_as_of || artifact.generated_at || "").slice(0, 10);
  const titleCodeFamilies = buildTitleCodeFamilyIndex(artifact.exams);
  const outputs = (artifact.exams || []).map((exam) => {
    const spine = buildExamProcessSpine(exam);
    const path = join(SITE, examDocumentPath(exam.exam_number), "index.html");
    const content = renderExamDocument(exam, {
      today,
      status: Staffing.statusFor(exam, today),
      feeSalary: Staffing.examFeeSalaryView(exam),
      outcome: Staffing.examOutcomeView(exam),
      phaseView: buildExamPhaseView(spine),
      titleCodeFamilyMembers: titleCodeFamilies[Staffing.titleCodeFamilyView(exam)?.code] || [],
    });
    return [path, content];
  });
  // Retained exam documents outlive the rolling input window. Refresh navigation
  // without regenerating their historical facts from today's incomplete corpus.
  const current = new Set(outputs.map(([path]) => path));
  const directory = join(SITE, "exams");
  if (existsSync(directory)) for (const entry of readdirSync(directory)) {
    const path = join(directory, entry, "index.html");
    if (!/^\d+$/.test(entry) || current.has(path) || !existsSync(path)) continue;
    const html = readFileSync(path, "utf8");
    outputs.push([path, refreshRetainedExamNavigation(html)]);
  }
  return outputs;
}

function retainedEligibilityCohort(html) {
  if (/Eligibility<\/dt><dd>Promotion<\/dd>/i.test(html)) return "promotion";
  return "open_competitive";
}

function retainedCohortBenchmarkLabel(cohort) {
  if (cohort === "promotion") return "Promotion";
  if (cohort === "citywide") return "Citywide";
  return "Open-competitive";
}

/** Rewrite superseded cohort-only timing copy on retained exam pages. */
export function refreshRetainedExamListTiming(html) {
  if (!html.includes("Expect the eligible list about")) return html;
  if (html.includes("exam-prediction-window") || html.includes("Statistical range")) return html;
  const claim = html.match(
    /<p class="exam-prediction-claim"[^>]*data-prediction-value="(\d+)-months"[^>]*>Expect the eligible list about <strong>\1 months after applications close\.<\/strong><\/p>/,
  );
  const basis = html.match(
    /<p class="exam-muted">Historical cohort: ([\d,]+) past exams since (\d{4})\.\s*<a href="([^"]+)">How this range is calculated<\/a>\.<\/p>/,
  );
  if (!claim || !basis) return html;
  const months = claim[1];
  const n = basis[1].replaceAll(",", "");
  const year = basis[2];
  const href = basis[3];
  const cohort = retainedEligibilityCohort(html);
  const label = retainedCohortBenchmarkLabel(cohort);
  const nText = Number(n).toLocaleString("en-US");
  const replacement = [
    `<section class="node-section exam-section" aria-labelledby="exam-list-timing-benchmark-heading" data-export-class="exam_prediction">`,
    `<h2 id="exam-list-timing-benchmark-heading">Eligible-list timing benchmark</h2>`,
    `<p class="exam-list-timing-benchmark" data-staffing-list-benchmark="1" data-benchmark-subject="eligible-list-establishment" data-benchmark-cohort="${cohort}" data-benchmark-value="${months}-months" data-benchmark-n="${n}" data-benchmark-since-year="${year}">${label} benchmark: Across <strong>${nText} exams since ${year}</strong>, the median time from application close to eligible-list establishment was about <strong>${months} months</strong>.</p>`,
    `<p class="exam-muted"><a href="${href}">How this is calculated</a>.</p>`,
    `</section>`,
  ].join("");
  return html.replace(
    /<section class="node-section exam-section" aria-labelledby="exam-prediction-heading" data-export-class="exam_prediction"><h2 id="exam-prediction-heading">What may happen next<\/h2><p class="exam-prediction-claim"[^>]*>Expect the eligible list about <strong>\d+ months after applications close\.<\/strong><\/p>\s*<p class="exam-muted">Historical cohort: [\d,]+ past exams since \d{4}\.\s*<a href="[^"]+">How this range is calculated<\/a>\.<\/p><\/section>/,
    replacement,
  );
}

export function refreshRetainedExamNavigation(html) {
  const oldHref = "/about.html#staffing-list-establishment-formula";
  if (!html.includes(oldHref) && !html.includes(ELIGIBLE_LIST_GUIDE_HREF)
      && !html.includes("Expect the eligible list about")) return html;
  let updated = html.replaceAll(oldHref, ELIGIBLE_LIST_GUIDE_HREF);
  updated = refreshRetainedExamListTiming(updated);
  if (!updated.includes('src="/guide_navigation.mjs"')) {
    updated = updated.replace("</body>", '<script type="module" src="/guide_navigation.mjs"></script></body>');
  }
  return updated;
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
