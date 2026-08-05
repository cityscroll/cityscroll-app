#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { buildRankedNoticesQuery, noticeSearchTerms } from "../worker/src/lib/notices.mjs";

const args = new Set(process.argv.slice(2));
if (!args.has("--retrieval-only")) {
  throw new Error("Only the committed retrieval-only check is supported; pass --retrieval-only.");
}

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const corpus = readJson("../warehouse/experiments/semantic-layer-trial/corpus.json").documents;
const qrels = readJson("../warehouse/experiments/semantic-layer-trial/queries.json").queries;
const noticeSchema = readFileSync(new URL("../worker/migrations/0001_notices.sql", import.meta.url), "utf8");
const factsSchema = readFileSync(new URL("../worker/migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const ftsSchema = readFileSync(new URL("../worker/migrations/0016_notice_fts.sql", import.meta.url), "utf8");

const db = new DatabaseSync(":memory:");
db.exec(noticeSchema);
db.exec(factsSchema);
const insert = db.prepare(`INSERT INTO notices
  (request_id, short_title, agency, section, start_date, haystack, document_urls, n_documents)
  VALUES (?, ?, ?, ?, ?, ?, '[]', 0)`);
for (const document of corpus) {
  insert.run(
    String(document.id), document.title || null, document.agency || null,
    document.section || null, String(document.published_at || "").slice(0, 10) || null,
    `${document.title || ""}\n${document.text || ""}`.toLowerCase(),
  );
}
db.exec(ftsSchema);

let relevantTopFive = 0;
const misses = [];
for (const judgment of qrels) {
  const terms = noticeSearchTerms(judgment.text);
  const query = buildRankedNoticesQuery({ termGroups: [terms], limit: 5 });
  const ids = db.prepare(query.sql).all(...query.params).map((row) => String(row.request_id));
  if (ids.some((id) => judgment.relevant.includes(id))) relevantTopFive += 1;
  else misses.push({ id: judgment.id, returned: ids });
}
db.close();

const receipt = {
  schema: "cityscroll.notice_fts_qrels_check.v1",
  corpus_documents: corpus.length,
  queries: qrels.length,
  relevant_top_five: relevantTopFive,
  required_relevant_top_five: 28,
  passes: relevantTopFive >= 28,
  misses,
};
console.log(JSON.stringify(receipt, null, 2));
if (args.has("--check") && !receipt.passes) process.exitCode = 1;
