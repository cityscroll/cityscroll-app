// One idempotent command boundary for a private entity-pair review action.
// Disposition, verdict/effect, and command receipt commit in one D1 batch. The
// privacy-safe action log is deliberately projected by the caller afterward.

import { versionedAssertionId } from "../../../entity_resolution/provenance_graph.mjs";
import {
  CURATION_REVIEW_POLICY_VERSION,
  buildCurationVerdictReceipt,
} from "../../../entity_resolution/review/curation_verdicts.mjs";
import {
  buildFalseSplitDisposition,
  falseSplitDispositionInsert,
  publicFalseSplitDisposition,
  readFalseSplitDispositions,
} from "./false_split_evidence.mjs";
import {
  curationVerdictInsert,
  readCurationVerdicts,
} from "./curation_verdicts.mjs";

export const CURATION_REVIEW_COMMAND_SCHEMA_VERSION = "cityscroll.curation-review-command.v1";
export const CURATION_ASSERTION_VERSION = "1";

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DECISION_MAP = Object.freeze({ same: "ACCEPT", different: "REJECT", defer: "REVIEW" });
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function selfAssertedActorRef(actor) {
  return `curator:self_asserted:${(await sha256(clean(actor).toLowerCase())).slice(0, 40)}`;
}

function goldSide(side = {}) {
  return {
    source_system: side.source_system,
    source_system_id: side.source_system_id,
    display_name: side.vendor_name || side.display_name,
    observed_fields: side.observed_fields || {},
  };
}

function assertionIdentity(pair) {
  const assertionKey = `vendor_identity:${pair.id}`;
  return {
    assertion_key: assertionKey,
    assertion_id: versionedAssertionId(assertionKey, CURATION_ASSERTION_VERSION),
  };
}

function evidenceRefs(pair) {
  return [pair.left, pair.right].map((side) => ({
    kind: "source_record",
    id: clean(side?.source_record_id),
  }));
}

async function commandPayload({ commandId, event, pair, assertion, actorRef }) {
  return JSON.stringify({
    schema_version: CURATION_REVIEW_COMMAND_SCHEMA_VERSION,
    command_id: commandId,
    pair_id: pair.id,
    assertion_id: assertion.assertion_id,
    actor_ref: actorRef,
    actor_attestation: "self_asserted",
    decision: event.decision,
    note_sha256: await sha256(event.note || ""),
    review_session_sha256: await sha256(event.review_session || ""),
    evidence_refs: evidenceRefs(pair),
    model_version: pair.matcher_version,
    rule_version: CURATION_REVIEW_POLICY_VERSION,
  });
}

function commandInsert(db, command) {
  return db.prepare(
    `INSERT INTO curation_review_command
       (id, schema_version, pair_id, assertion_id, disposition_event_id,
        verdict_receipt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    command.id,
    command.schema_version,
    command.pair_id,
    command.assertion_id,
    command.disposition_event_id,
    command.verdict_receipt_id,
    command.payload_json,
    command.created_at,
  );
}

async function readCommand(db, id) {
  const result = await db.prepare(
    `SELECT id, schema_version, pair_id, assertion_id, disposition_event_id,
            verdict_receipt_id, payload_json, created_at
       FROM curation_review_command
      WHERE id = ?`,
  ).bind(id).all();
  return result?.results?.[0] || null;
}

async function replayResult(db, command, expectedPayload) {
  if (command.payload_json !== expectedPayload) return { error: "idempotency-key-conflict" };
  const [events, verdicts] = await Promise.all([
    readFalseSplitDispositions(db, [command.pair_id]),
    readCurationVerdicts(db, [command.pair_id]),
  ]);
  const event = events.find((candidate) => candidate.id === command.disposition_event_id);
  const verdict = verdicts.find((candidate) => candidate.id === command.verdict_receipt_id);
  if (!event || !verdict) throw new Error("curation-command-incomplete");
  return {
    command: {
      id: command.id,
      schema_version: command.schema_version,
      assertion_id: command.assertion_id,
      actor_attestation: "self_asserted",
      replayed: true,
    },
    event: publicFalseSplitDisposition(event),
    verdict,
  };
}

/**
 * Commit one review click. The idempotency key is scoped to the complete
 * normalized request: replay returns the first result; key reuse with changed
 * input fails without mutating any authoritative row.
 */
export async function commitCurationReviewCommand(db, pair, input = {}, opts = {}) {
  if (!db) return { error: "no-store" };
  if (typeof db.batch !== "function") return { error: "atomic-batch-required" };
  const commandId = clean(opts.id || input.command_id || input.idempotency_key);
  if (!COMMAND_ID.test(commandId)) return { error: "command-id-required" };

  const event = buildFalseSplitDisposition(pair, input, {
    id: commandId,
    now: opts.now,
  });
  if (event.error) return event;
  const assertion = assertionIdentity(pair);
  const actorRef = await selfAssertedActorRef(event.actor);
  const payload = await commandPayload({ commandId, event, pair, assertion, actorRef });

  const existing = await readCommand(db, commandId);
  if (existing) return replayResult(db, existing, payload);

  const priorVerdicts = await readCurationVerdicts(db, [pair.id]);
  const previous = priorVerdicts.at(-1) || null;
  const verdictDecision = DECISION_MAP[event.decision];
  const verdict = buildCurationVerdictReceipt({
    id: commandId,
    actor: actorRef,
    decision: verdictDecision,
    target: {
      kind: "entity_pair",
      id: pair.id,
      assertion_id: assertion.assertion_id,
      edge_family: "vendor_identity",
      gold_candidate: {
        entity_type: "vendor",
        left: goldSide(pair.left),
        right: goldSide(pair.right),
      },
    },
    evidence_refs: evidenceRefs(pair),
    model_version: pair.matcher_version,
    rule_version: CURATION_REVIEW_POLICY_VERSION,
    review_policy: verdictDecision === "REVIEW"
      ? {
          version: CURATION_REVIEW_POLICY_VERSION,
          status: "not_applicable",
          reasons: ["operator_deferred", "actor_self_asserted"],
        }
      : {
          version: CURATION_REVIEW_POLICY_VERSION,
          status: "satisfied",
          reasons: ["admin_key_review_complete", "actor_self_asserted"],
        },
    reverses_receipt_id: previous?.id || null,
    timestamp: event.created_at,
  });
  if (verdict.error) return verdict;

  const command = {
    id: commandId,
    schema_version: CURATION_REVIEW_COMMAND_SCHEMA_VERSION,
    pair_id: pair.id,
    assertion_id: assertion.assertion_id,
    disposition_event_id: event.id,
    verdict_receipt_id: verdict.id,
    payload_json: payload,
    created_at: event.created_at,
  };

  try {
    await db.batch([
      falseSplitDispositionInsert(db, event),
      curationVerdictInsert(db, verdict),
      commandInsert(db, command),
    ]);
  } catch (error) {
    // A concurrent retry can lose the primary-key race after our first read.
    // D1 rolls its failed batch back; return the winner only when payloads match.
    const winner = await readCommand(db, commandId);
    if (winner) return replayResult(db, winner, payload);
    throw error;
  }

  return {
    command: {
      id: command.id,
      schema_version: command.schema_version,
      assertion_id: command.assertion_id,
      actor_attestation: "self_asserted",
      replayed: false,
    },
    event: publicFalseSplitDisposition(event),
    verdict,
  };
}
