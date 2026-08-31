// FEEDBACK-KV persistence for private report adjudication records.
//
// Keys stay off the `fb:` listing used by GET /admin/feedback. Replay is
// idempotent on command_id: the same command returns the stored state, a
// conflicting payload fails closed.

import {
  recordReportAdjudication,
  replayMatches,
} from "./report_adjudication.mjs";

export const ADJUDICATION_STATE_PREFIX = "adj:state:";
export const ADJUDICATION_COMMAND_PREFIX = "adj:cmd:";

function present(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function stateKey(reportId) {
  return `${ADJUDICATION_STATE_PREFIX}${reportId}`;
}

function commandKey(commandId) {
  return `${ADJUDICATION_COMMAND_PREFIX}${commandId}`;
}

async function readJson(store, key) {
  if (!store) return null;
  let raw;
  try { raw = await store.get(key); } catch { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function loadReportAdjudication(store, reportId) {
  const id = present(reportId);
  if (!id) return null;
  return readJson(store, stateKey(id));
}

export async function loadReportAdjudicationByCommand(store, commandId) {
  const id = present(commandId);
  if (!id) return null;
  const pointer = await readJson(store, commandKey(id));
  if (!pointer?.report_id) return null;
  return loadReportAdjudication(store, pointer.report_id);
}

export async function persistReportAdjudication(store, input) {
  if (!store) return { ok: false, error: "no-store" };
  const reportId = present(input.report_id || input.report?.id);
  const commandId = present(input.command_id);
  if (commandId) {
    const existing = await loadReportAdjudicationByCommand(store, commandId);
    if (existing) {
      if (replayMatches(existing, { ...input, report_id: reportId })) {
        return { ok: true, replayed: true, state: existing };
      }
      return { ok: false, error: "idempotency-key-conflict", state: existing };
    }
  }
  if (reportId) {
    const existingState = await loadReportAdjudication(store, reportId);
    if (existingState && commandId && existingState.command_id === commandId) {
      if (replayMatches(existingState, { ...input, report_id: reportId })) {
        return { ok: true, replayed: true, state: existingState };
      }
      return { ok: false, error: "idempotency-key-conflict", state: existingState };
    }
  }
  const recorded = recordReportAdjudication(input);
  if (!recorded.ok) return recorded;
  const { state } = recorded;
  try {
    await store.put(stateKey(state.report_id), JSON.stringify(state));
    await store.put(commandKey(state.command_id), JSON.stringify({
      report_id: state.report_id,
      command_id: state.command_id,
    }));
  } catch {
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, replayed: false, state };
}

export async function listReportAdjudications(store) {
  if (!store) return [];
  const items = [];
  let cursor;
  do {
    let page;
    try {
      page = await store.list({ prefix: ADJUDICATION_STATE_PREFIX, cursor });
    } catch {
      break;
    }
    for (const key of page.keys || []) {
      const state = await readJson(store, key.name);
      if (state) items.push(state);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  items.sort((a, b) => (String(a.recorded_at) < String(b.recorded_at) ? 1 : -1));
  return items;
}
