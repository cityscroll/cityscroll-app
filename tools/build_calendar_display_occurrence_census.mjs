#!/usr/bin/env node

/**
 * Build the calendar display-occurrence density census from the committed
 * fixture corpus. This is a deterministic, build-time inventory artifact: it
 * measures where the commissioned density rule qualifies before any calendar
 * interface is mounted. It never fetches a live source and never manufactures a
 * date or a join — every occurrence comes from the presentation-neutral
 * projection, and every exclusion carries its reason.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDisplayOccurrenceCensus } from "../site/calendar_display.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORPUS_PATH = "test/fixtures/calendar-display/census-corpus.json";
const OUTPUT_PATH = "site/data/calendar_display_occurrence_census.json";

export function readCorpus(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, CORPUS_PATH), "utf8"));
}

export function buildCalendarDisplayOccurrenceCensus(corpus = readCorpus()) {
  const census = buildDisplayOccurrenceCensus(corpus.surfaces || []);
  return {
    ...census,
    corpus: {
      schema: corpus.schema,
      revision: corpus.revision ?? null,
      path: CORPUS_PATH,
      surface_count: (corpus.surfaces || []).length,
    },
  };
}

export function buildAndWriteCalendarDisplayOccurrenceCensus({ root = ROOT, outputPath = OUTPUT_PATH } = {}) {
  const census = buildCalendarDisplayOccurrenceCensus(readCorpus(root));
  writeFileSync(resolve(root, outputPath), `${JSON.stringify(census, null, 2)}\n`);
  return census;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const census = buildAndWriteCalendarDisplayOccurrenceCensus();
  const { status_counts: counts } = census.summary;
  console.log(
    `wrote ${census.surfaces.length} surfaces to ${OUTPUT_PATH}: `
    + `${counts.eligible} eligible, ${counts.sparse} sparse, ${counts.excluded} excluded, ${counts.unavailable} unavailable`,
  );
}
