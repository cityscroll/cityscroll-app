#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  COMMUNITY_BOARD_PARTICIPATION_METHOD,
  COMMUNITY_BOARD_PARTICIPATION_RECEIPT_SCHEMA,
  buildCommunityBoardParticipationLookup,
} from "../site/community_board_participation.mjs";

const ROOT = join(import.meta.dirname, "..");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const BYLAWS = join(ROOT, "site/data/community_board_bylaws.json");
const SOURCES = join(ROOT, "site/data/community_board_participation_sources.json");
const OUTPUT = join(ROOT, "site/data/community_board_participation.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_participation_latest.json");
const check = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildCommunityBoardParticipationArtifacts({
  sourceRegistry = readJson(REGISTRY),
  bylaws = readJson(BYLAWS),
  sources = readJson(SOURCES),
} = {}) {
  const generatedAt = sources.generated_at || "unknown";
  const projection = buildCommunityBoardParticipationLookup({
    sourceRegistry,
    bylaws,
    application_sources: sources.sources || [],
    as_of: generatedAt,
  });
  const payload = {
    ...projection,
    source_registry: "site/data/non_council_outcome_sources/source_registry.json",
    bylaw_source: "site/data/community_board_bylaws.json",
    application_source_registry: "site/data/community_board_participation_sources.json",
  };
  const payloadText = serialize(payload);
  const receipt = {
    schema: COMMUNITY_BOARD_PARTICIPATION_RECEIPT_SCHEMA,
    method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
    generated_at: generatedAt,
    source_registry: payload.source_registry,
    bylaw_source: payload.bylaw_source,
    application_source_registry: payload.application_source_registry,
    population: {
      board_count: payload.board_count,
      participation_rows: Object.values(payload.by_board).reduce((sum, row) => sum + row.participation.length, 0),
      application_sources: sources.sources?.length || 0,
    },
    measurement: {
      scheduled_acquisition: true,
      resident_request_time_fetch: false,
      latest_known_good_governance: true,
      unknown_application_suppresses_cta: true,
      stale_application_suppresses_cta: true,
      cross_board_inference: false,
      source_scope_is_explicit: true,
    },
    source_receipts: (sources.sources || []).map((source) => ({
      source_id: source.id,
      board_ids: source.applies_to_board_ids,
      participation_kind: source.participation_kind,
      source_url: source.source_url,
      document_id: source.document_id || null,
      locator: source.locator || null,
      observed_at: source.observed_at || null,
      effective_at: source.effective_at || null,
      receipt_status: source.receipt?.status || "unknown",
    })),
  };
  const receiptText = serialize(receipt);
  return { payload, payloadText, receipt, receiptText };
}

export function writeCommunityBoardParticipationArtifacts({ check: shouldCheck = check } = {}) {
  const artifacts = buildCommunityBoardParticipationArtifacts();
  const currentPayload = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  const currentReceipt = existsSync(RECEIPT) ? readFileSync(RECEIPT, "utf8") : null;
  if (shouldCheck) {
    if (currentPayload !== artifacts.payloadText) throw new Error("community board participation artifact is stale; run without --check");
    if (currentReceipt !== artifacts.receiptText) throw new Error("community board participation receipt is stale; run without --check");
    console.log(`community board participation is current: boards=${artifacts.payload.board_count} sha256=${sha256(currentPayload)}`);
    return artifacts;
  }
  writeFileSync(OUTPUT, artifacts.payloadText);
  writeFileSync(RECEIPT, artifacts.receiptText);
  console.log(`wrote community board participation: boards=${artifacts.payload.board_count}`);
  return artifacts;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) writeCommunityBoardParticipationArtifacts();
