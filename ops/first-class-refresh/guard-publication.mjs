#!/usr/bin/env node
// Acquisition success is distinct from publication eligibility. Preserve the
// verified population when a refresh loses observed boards or attachment proof.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { combineCommunityBoardMeetingIndex } from "../../site/community_board_meeting_index_shards.mjs";
import { readCommunityBoardMeetingIndex } from "../../tools/lib/community_board_meeting_index_io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX = "site/data/community_board_meeting_index.json";
const RULES = "site/data/rules_domain_observations.json";
const OUTCOMES = "site/data/meeting_outcomes_snapshot.json";

export function unboundRollCalls(snapshot) {
  const findings = [];
  for (const record of Object.values(snapshot.by_notice || {})) {
    for (const matter of record.matters || []) {
      for (const action of matter.item_actions || []) {
        if (!(action.votes?.person_count > 0)) continue;
        if (!action.votes.event_id || !action.votes.event_item_id
          || String(action.votes.event_id || "") !== String(record.event?.event_id || "")
          || String(action.votes.event_item_id || "") !== String(action.agenda_item_id || "")) {
          findings.push({ event_id: record.event?.event_id, matter_id: matter.matter_id, agenda_item_id: action.agenda_item_id });
        }
      }
    }
  }
  return findings;
}

function classifyEmptyBoardCause(receipt) {
  const reason = receipt?.state_reason || receipt?.observed_receipt?.reason || null;
  const fetchStatus = String(receipt?.observed_receipt?.fetch_status || "");
  const invariants = receipt?.acquisition_invariants || null;
  if (receipt?.state === "unavailable" || reason === "http_error" || /^[45]\d\d$/.test(fetchStatus)) {
    return {
      cause_class: "publisher_change",
      cause: `publisher retrieval failed: ${reason || fetchStatus || "unavailable"}`,
    };
  }
  if (reason === "challenge_html") {
    return {
      cause_class: "parser_regression",
      cause: "response matched challenge_html while still returning publisher HTML; detector rejected extractable events",
    };
  }
  if (invariants?.presence?.ok && !invariants?.population?.ok) {
    return {
      cause_class: "parser_regression",
      cause: "presence succeeded with zero extractable meetings (population invariant failed)",
    };
  }
  return {
    cause_class: "unresolved",
    cause: "no events extracted; publisher window change versus parser regression is not established",
  };
}

export function meetingPublicationFindings(previous, current) {
  const findings = [];
  for (const [board, rows] of Object.entries(previous.by_board || {})) {
    const count = current.by_board?.[board]?.length || 0;
    if (!rows.length || count) continue;
    const receipt = current.receipts?.find((row) => row.board_id === board && row.role === "upcoming_meetings");
    const classified = classifyEmptyBoardCause(receipt);
    findings.push({
      board, previous: rows.length, attempted: count,
      source_url: receipt?.source_url || null,
      http_status: receipt?.observed_receipt?.fetch_status || null,
      cause_class: classified.cause_class,
      cause: classified.cause,
      presence_ok: receipt?.acquisition_invariants?.presence?.ok ?? null,
      population_ok: receipt?.acquisition_invariants?.population?.ok ?? null,
    });
  }
  if (current.rows.length < previous.rows.length * 0.8 && !findings.length) {
    findings.push({ cause: "meeting population fell by more than 20%; cause not established", previous: previous.rows.length, attempted: current.rows.length });
  }
  return findings;
}

function hasAttachmentProof(row) {
  return row?.rule_evidence_densify?.method === "city_record_getfile_pdf_v1"
    && (row.rule_evidence?.body_topic_keys?.length || row.rule_evidence?.citation_keys?.length);
}

export function missingAttachmentProof(previous, current) {
  const currentById = new Map(current.rows.map((row) => [String(row.request_id), row]));
  return previous.rows.filter(hasAttachmentProof)
    .filter((row) => currentById.has(String(row.request_id)) && !hasAttachmentProof(currentById.get(String(row.request_id))))
    .map((row) => String(row.request_id)).sort();
}

export function guardPublication({ root = ROOT, baselineRef = "HEAD" } = {}) {
  const baselineBytes = (path) => {
    const result = spawnSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Cannot read publication baseline for ${path}`);
    return result.stdout;
  };
  const baselineJson = (path) => JSON.parse(baselineBytes(path));
  const read = (path) => JSON.parse(readFileSync(join(root, path)));
  const restore = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), baselineBytes(path));
  };
  const manifest = baselineJson(INDEX);
  const shards = manifest.shards || [];
  for (const shard of shards) {
    if (!/^community_board_meeting_index\/shard-\d+\.json$/.test(shard.path)) throw new Error("Unexpected baseline meeting shard path");
  }
  const previous = shards.length
    ? combineCommunityBoardMeetingIndex(manifest, shards.map((shard) => baselineJson(`site/data/${shard.path}`)))
    : manifest;
  const current = readCommunityBoardMeetingIndex(join(root, INDEX));
  const findings = meetingPublicationFindings(previous, current);
  const report = { schema: "cityscroll.refresh_publication_findings.v1", findings: [], retained_artifacts: [] };
  const previousOutcomes = baselineJson(OUTCOMES);
  const previousUnbound = new Set(unboundRollCalls(previousOutcomes).map((row) => JSON.stringify(row)));
  const unbound = unboundRollCalls(read(OUTCOMES)).filter((row) => !previousUnbound.has(JSON.stringify(row)));
  if (unbound.length) {
    restore(OUTCOMES);
    report.retained_artifacts.push(OUTCOMES);
    report.findings.push({ artifact: OUTCOMES, disposition: "retained last verified agenda-item vote evidence", cause: "new named roll calls lack exact event and agenda-item provenance", unbound_count: unbound.length, examples: unbound.slice(0, 5), retained_vintage: previousOutcomes.generated_at });
  }
  if (findings.length) {
    restore(INDEX);
    for (const shard of shards) restore(`site/data/${shard.path}`);
    report.retained_artifacts.push(INDEX);
    report.findings.push({
      artifact: INDEX, disposition: "retained last verified population",
      previous_count: previous.rows.length, attempted_count: current.rows.length,
      retained_vintage: previous.generated_at, attempted_vintage: current.generated_at,
      causes: findings,
    });
  }
  const previousRules = baselineJson(RULES);
  const missing = missingAttachmentProof(previousRules, read(RULES));
  if (missing.length) {
    // This is an explicit acquisition step, before the materialization-only
    // rebuild. Never substitute the synthetic attachment test fixture.
    const result = spawnSync(process.execPath, ["tools/densify_rule_evidence_attachments.mjs", "--ids", missing.join(","), "--limit", String(missing.length)], {
      cwd: root, stdio: "inherit", timeout: 240_000,
    });
    const remaining = missingAttachmentProof(previousRules, read(RULES));
    if (result.status !== 0 || remaining.length) {
      restore(RULES);
      report.retained_artifacts.push(RULES);
      report.findings.push({ artifact: RULES, disposition: "retained last verified attachment evidence", missing_ids: remaining, acquisition_exit: result.status, cause: "live attachment acquisition did not restore the previously observed proof", retained_vintage: previousRules.generated_at });
    }
  }
  const out = join(root, ".artifacts/first-class-publication-findings.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (report.findings.length) {
    const summary = `\n### Dataset publication findings\n\n${report.findings.map((finding) => `- ${finding.artifact}: ${JSON.stringify(finding)}`).join("\n")}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--baseline-ref");
  guardPublication({ baselineRef: index < 0 ? "HEAD" : process.argv[index + 1] });
}
