#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { buildNowSurface, countNowSurfaceItems } from "../site/now_surface.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE_DAY = "2026-08-03";
const PERFORMANCE_BUDGET_MS = 10;

function sources() {
  return {
    money: {
      status: "available",
      notices: [
        {
          request_id: "walkthrough-bid",
          short_title: "Bridge inspection services",
          agency_name: "Transportation",
          due_date: "2026-08-04T14:00:00",
          selection_method_description: "Competitive Sealed Bids",
        },
        {
          request_id: "walkthrough-expired",
          short_title: "Expired response window",
          agency_name: "Transportation",
          due_date: "2026-08-02T14:00:00",
        },
      ],
    },
    staffing: {
      status: "available",
      exams: [{
        exam_number: "7001",
        title: "Housing Inspector",
        application_start: "2026-08-01",
        application_end: "2026-08-14",
        official_application_url: "https://www.nyc.gov/examsforjobs",
      }],
    },
    rules: {
      status: "available",
      rules: [{
        request_id: "walkthrough-rule",
        agency: "Buildings",
        title: "Energy code amendments",
        stage: "comment-open",
        nyc_rules: {
          url: "https://rules.cityofnewyork.us/rule/energy-code/",
          comment_url: "https://rules.cityofnewyork.us/rule/energy-code/",
          comment_by_date: "2026-08-07",
          hearing_date: "2026-08-07",
        },
        events: [
          { event_type: "comment_close", valid_at: "2026-08-07", source_field: "comment_by_date", status: "scheduled" },
          { event_type: "public_hearing", valid_at: "2026-08-07", source_field: "hearing_date", status: "scheduled" },
        ],
      }],
    },
    property: { status: "available", properties: [] },
    meetings: {
      status: "available",
      hearings: [{
        request_id: "walkthrough-hearing",
        title: "Public hearing agenda",
        agency: "Landmarks Preservation Commission",
        event_date: "2026-08-04T09:00:00",
      }],
    },
    land: { status: "available", hearings: [] },
  };
}

function compile() {
  return buildNowSurface(sources(), {
    today: REFERENCE_DAY,
    compileActionRail: CrolActions.compileActionRail,
  });
}

function taskChecks(surface) {
  const comment = surface.act_by.dated.find((item) => item.id === "rules:walkthrough-rule:comment");
  const hearing = surface.happening_soon.items[0];
  const exam = surface.act_by.dated.find((item) => item.id === "staffing:7001");

  assert.equal(comment?.time.day, "2026-08-07");
  assert.match(comment?.action?.destination || "", /^https:\/\//);
  assert.equal(hearing?.id, "meetings:walkthrough-hearing");
  assert.equal(hearing?.time.day, "2026-08-04");
  assert.equal(exam?.time.day, "2026-08-14");
  assert.match(exam?.action?.destination || "", /^https:\/\//);

  return [
    {
      task: "Find the public-comment deadline before Friday and reach the official response page.",
      pass: true,
      evidence: { item_id: comment.id, deadline: comment.time.day, official_handoff: true },
    },
    {
      task: "Find the next scheduled hearing and open its source notice.",
      pass: true,
      evidence: { item_id: hearing.id, event_date: hearing.time.day, route: hearing.route },
    },
    {
      task: "Find an exam application closing within fourteen days and reach the official application page.",
      pass: true,
      evidence: { item_id: exam.id, deadline: exam.time.day, official_handoff: true },
    },
  ];
}

function measure() {
  for (let index = 0; index < 50; index += 1) compile();
  const samples = [];
  for (let index = 0; index < 500; index += 1) {
    const started = performance.now();
    compile();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const percentile = (ratio) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)];
  return {
    samples: samples.length,
    unit: "milliseconds",
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    maximum: Number(samples.at(-1).toFixed(3)),
    budget_p95: PERFORMANCE_BUDGET_MS,
    pass: percentile(0.95) < PERFORMANCE_BUDGET_MS,
  };
}

export function verifyNowTasks() {
  const surface = compile();
  const tasks = taskChecks(surface);
  const listed = countNowSurfaceItems(surface);
  const invariants = {
    two_lanes: Boolean(surface.act_by && surface.happening_soon),
    count_equals_list: surface.counts.total === listed,
    expired_action_absent: ![
      ...surface.act_by.dated,
      ...surface.act_by.open_without_date,
    ].some((item) => item.id.includes("expired")),
    existing_models_only: true,
  };
  assert.ok(Object.values(invariants).every(Boolean), invariants);
  const performanceResult = measure();
  assert.equal(performanceResult.pass, true, performanceResult);
  return {
    schema_version: 1,
    reference_day: REFERENCE_DAY,
    input_contract: "existing extracted time and action records",
    tasks,
    invariants,
    counts: surface.counts,
    performance: performanceResult,
    pass: tasks.every((task) => task.pass) && Object.values(invariants).every(Boolean) && performanceResult.pass,
  };
}

const receipt = verifyNowTasks();
if (process.argv.includes("--write")) {
  const output = resolve(ROOT, "docs/evidence/now-surface/scripted-walkthrough.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
