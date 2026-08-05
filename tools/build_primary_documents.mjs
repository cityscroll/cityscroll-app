#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import {
  buildBrowseDocument,
  buildBrowseLandingDocument,
  buildNowDocument,
} from "../site/primary_document_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

function json(path) {
  return JSON.parse(readFileSync(join(SITE, path.replace(/^\//, "")), "utf8"));
}

function output(path, content) {
  return [join(SITE, path, "index.html"), content];
}

export function primaryDocumentOutputs() {
  const shell = readFileSync(join(SITE, "index.html"), "utf8");
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  const nowSources = {
    money: { ...payloads.contracts, status: "available" },
    staffing: { ...json("/data/staffing_exams.json"), status: "available" },
    land: { ...json("/data/land_upcoming_hearings.json"), status: "available" },
    rules: { status: "unavailable", reason: "edge_refresh", rules: [] },
    property: { status: "unavailable", reason: "edge_refresh", properties: [] },
    meetings: { status: "unavailable", reason: "edge_refresh", hearings: [] },
  };
  const outputs = [output("now", buildNowDocument(shell, nowSources))];
  const staffingExams = json("/data/staffing_exams.json");
  outputs.push(output("browse", buildBrowseLandingDocument(shell, payloads, {
    staffingExamCount: Array.isArray(staffingExams.exams) ? staffingExams.exams.length : 0,
    staffingExamAsOf: staffingExams.data_current_as_of,
  })));
  for (const [facet, payload] of Object.entries(payloads)) {
    outputs.push(output(`browse/${facet}`, buildBrowseDocument(shell, facet, payload, new URLSearchParams(), { route: `/browse/${facet}/` })));
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of primaryDocumentOutputs()) {
    if (!existsSync(path)) {
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        console.log("wrote", path);
      }
      continue;
    }
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    stale += 1;
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log("wrote", path);
    }
  }
  if (check && stale) {
    console.error(`${stale} primary document artifact(s) are stale`);
    process.exit(1);
  }
  console.log(check ? "Primary documents are current" : "Primary documents built");
}
