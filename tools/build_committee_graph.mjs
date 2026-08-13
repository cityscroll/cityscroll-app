#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommitteeGateReceipt,
  buildCommitteeGraph,
  buildCommitteeReciprocalEdges,
  committeeGateAllowsPublication,
} from "../site/committee_graph.mjs";
import { fetchLegistarPersonOfficeRecords } from "../worker/src/lib/legistar_client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUTS = [
  path.join(ROOT, "site/data/committee_graph_lookup.json"),
  path.join(ROOT, "worker/src/data/committee_graph_lookup.json"),
];
const RECEIPT = path.join(
  ROOT,
  "site/data/committee_graph/verification_receipts/committee_sample_2026-08-12.json",
);
const OBSERVED_AT = process.env.COMMITTEE_RETRIEVED_AT || "2026-08-12T00:00:00.000Z";
// The publication gate is the dated 30-person sample: 20 current-term, 5 recent-former, 5 Socrata overlap.

async function json(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

function distinct(ids, excluded = new Set()) {
  return [...new Set(ids.map((id) => String(id)).filter((id) => id && !excluded.has(id)))];
}

function samplePeople(people, socrata) {
  const rows = Object.values(people.by_person_id || {});
  const current = rows
    .filter((row) => row.current_term?.term_start === "2026-01-01" && row.current_term?.term_end >= "2026-08-12")
    .map((row) => row.person_id);
  const former = rows
    .filter((row) => row.current_term?.term_end >= "2024-01-01" && row.current_term?.term_end < "2026-08-12")
    .map((row) => row.person_id);
  const currentIds = distinct(current).slice(0, 20);
  const currentSet = new Set(currentIds);
  const formerIds = distinct(former, currentSet).slice(0, 5);
  const selected = new Set([...currentIds, ...formerIds]);
  const socrataIds = Object.keys(socrata.by_member_id || {});
  const socrataSample = distinct(socrataIds, selected).slice(0, 5);
  const personIds = [...currentIds, ...formerIds, ...socrataSample];
  return {
    personIds,
    currentIds,
    formerIds,
    socrataIds: socrataSample,
  };
}

async function acquire(personIds, token) {
  if (!token) return { rows: null, sampleComplete: false, error: "LEGISTAR_API_TOKEN is not configured" };
  const rows = [];
  const errors = [];
  for (const personId of personIds) {
    try {
      rows.push(...await fetchLegistarPersonOfficeRecords({ personId, token }));
    } catch (error) {
      errors.push({ person_id: personId, error: error?.message || "legistar request failed", status: error?.status || null });
    }
  }
  return {
    rows,
    sampleComplete: errors.length === 0,
    error: errors.length ? "One or more authenticated office-record requests failed" : null,
    request_errors: errors,
  };
}

function receiptProjection(receipt) {
  return receipt;
}

async function main() {
  const [people, socrata] = await Promise.all([
    json("site/data/person_hub_lookup.json"),
    json("site/data/official_committee_memberships_lookup.json"),
  ]);
  const sample = samplePeople(people, socrata);
  if (process.argv.includes("--check")) {
    const [existingGraphText, existingReceiptText] = await Promise.all([
      readFile(OUTPUTS[0], "utf8"),
      readFile(RECEIPT, "utf8"),
    ]);
    const existingGraph = JSON.parse(existingGraphText);
    const existingReceipt = JSON.parse(existingReceiptText);
    const people = await json("site/data/person_hub_lookup.json");
    const publicationAllowed = committeeGateAllowsPublication(existingReceipt);
    if (existingGraph.publication !== (publicationAllowed ? "published" : "held")) {
      throw new Error("committee graph publication does not match the committed receipt gate");
    }
    if (!publicationAllowed && existingGraph.public_edges.length !== 0) {
      throw new Error("held committee sample exposed public membership edges");
    }
    const expectedReverseEdges = publicationAllowed
      ? buildCommitteeReciprocalEdges(existingGraph.public_edges, people)
      : [];
    if (JSON.stringify(existingGraph.public_reverse_edges || []) !== JSON.stringify(expectedReverseEdges)) {
      throw new Error("committee graph reciprocal edges are stale");
    }
    const expectedGraphEdges = [...(existingGraph.public_edges || []), ...expectedReverseEdges];
    if (JSON.stringify(existingGraph.public_graph?.edges || []) !== JSON.stringify(expectedGraphEdges)) {
      throw new Error("committee public graph does not expose reciprocal edges");
    }
    const expectedGraphText = await readFile(OUTPUTS[1], "utf8");
    if (existingGraphText !== expectedGraphText) throw new Error("committee graph twin artifacts differ");
    console.log(`committee graph ok sample_complete=${existingReceipt.sample_acquisition?.complete === true} publication=${existingGraph.publication}`);
    return;
  }
  const acquisition = await acquire(sample.personIds, process.env.LEGISTAR_API_TOKEN);
  const gate = buildCommitteeGateReceipt({
    observedAt: OBSERVED_AT,
    samplePersonIds: sample.personIds,
    currentPersonIds: sample.currentIds,
    formerPersonIds: sample.formerIds,
    socrataPersonIds: sample.socrataIds,
    rows: acquisition.sampleComplete ? acquisition.rows : null,
    peopleDoc: people,
    error: acquisition.error,
  });
  gate.sample_acquisition = {
    complete: acquisition.sampleComplete,
    retrieved_at: OBSERVED_AT,
    request_errors: acquisition.request_errors || [],
  };
  gate.gate.publication_allowed = committeeGateAllowsPublication(gate) && acquisition.sampleComplete;
  gate.gate.publication_status = gate.gate.publication_allowed ? "published" : "held";
  const graph = buildCommitteeGraph(acquisition.rows || [], people, {
    retrievedAt: OBSERVED_AT,
    gate: gate.gate,
  });
  graph.gate = gate;
  const serialized = `${JSON.stringify(graph, null, 2)}\n`;
  const receipt = receiptProjection(gate);
  for (const output of OUTPUTS) {
    mkdirSync(path.dirname(output), { recursive: true });
    await writeFile(output, serialized);
  }
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({
    outputs: OUTPUTS.map((output) => path.relative(ROOT, output)),
    receipt: path.relative(ROOT, RECEIPT),
    sample_people: sample.personIds.length,
    sample_complete: acquisition.sampleComplete,
    accepted_rows: gate.review.accepted_non_council_non_advocate_rows,
    publication: gate.gate.publication_status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
