#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AWARDS_SOURCE_PATH,
  KEYWORD_INDEX_PATH,
  MTA_SOURCE_PATH,
  READ_MODEL_PATH,
  SPINE_SOURCE_PATH,
  checkProcurementIndexCoherence,
  formatCoherenceFindings,
} from "./lib/procurement_index_coherence.mjs";
import { readSharedProcurementReadModel } from "./lib/procurement_read_model_io.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readTarget(relativeOrAbsolute, fallbackRelative) {
  const raw = relativeOrAbsolute || fallbackRelative;
  const path = isAbsolute(raw) ? raw : resolve(ROOT, raw);
  return {
    path,
    value: path === resolve(ROOT, READ_MODEL_PATH)
      ? readSharedProcurementReadModel(path)
      : JSON.parse(readFileSync(path, "utf8")),
  };
}

function readBytes(relative) {
  return readFileSync(resolve(ROOT, relative));
}

const skipSource = process.argv.includes("--skip-source-fingerprint");
const readModel = readTarget(argValue("--read-model"), READ_MODEL_PATH);
const keywordIndex = readTarget(argValue("--keyword-index"), KEYWORD_INDEX_PATH);
const result = checkProcurementIndexCoherence({
  readModel: readModel.value,
  keywordIndex: keywordIndex.value,
  ...(skipSource ? {} : {
    spineBytes: readBytes(argValue("--spine") || SPINE_SOURCE_PATH),
    awardsBytes: readBytes(argValue("--awards") || AWARDS_SOURCE_PATH),
    mtaBytes: readBytes(argValue("--mta") || MTA_SOURCE_PATH),
  }),
});

if (!result.ok) {
  console.error(formatCoherenceFindings(result.findings));
  process.exitCode = 1;
} else {
  console.log(
    `procurement index coherence ok (${result.advertised_count} advertised, ${result.served_count} served)`,
  );
}
