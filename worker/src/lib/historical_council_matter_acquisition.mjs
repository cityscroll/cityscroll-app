/** Bounded acquisition and normalization for retained historical Council matters. */

import { fetchLegistarMattersByFiles } from "./legistar_client.mjs";

export const HISTORICAL_COUNCIL_MATTER_SCHEMA = "cityscroll.historical_council_matter_acquisition.v1";

function text(value, max = 2000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeMatterFile(value) {
  const normalized = text(value, 120).toUpperCase().replace(/\s+/g, " ");
  return /^\b(?:LU|RES) \d{4}-\d{4}\b$/.test(normalized) ? normalized : null;
}

/** Build bounded acquisition targets from exact entries in the project registry. */
export function historicalMatterTargetsFromProjectContext(context = {}, { projectIds = null } = {}) {
  const allowed = projectIds ? new Set(projectIds.map((id) => text(id, 40))) : null;
  const targets = [];
  for (const row of Array.isArray(context?.retained_rows) ? context.retained_rows : []) {
    const projectId = text(row?.project_id, 40);
    if (!projectId || (allowed && !allowed.has(projectId))) continue;
    const entries = row?.council_matter_files || row?.historical_matter_files || row?.council_applications || [];
    for (const entry of entries) {
      const matterFile = normalizeMatterFile(typeof entry === "string" ? entry : entry?.matter_file ?? entry?.matterFile);
      if (matterFile) targets.push({
        project_id: projectId,
        application_id: text(typeof entry === "string" ? entry : entry?.application_id ?? entry?.applicationId, 40) || null,
        matter_file: matterFile,
        source_date: text(typeof entry === "string" ? null : entry?.source_date, 80) || null,
      });
    }
  }
  return targets.filter((target, index, all) => all.findIndex((candidate) => candidate.matter_file === target.matter_file) === index);
}

function rowsFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.rows)) return response.rows;
  if (Array.isArray(response?.value)) return response.value;
  if (response && typeof response === "object") return [response];
  return [];
}

function officialUrl(row, matterId) {
  const candidate = row?.MatterInSiteURL || row?.MatterUrl || row?.MatterURL || row?.url;
  if (candidate && /^https:\/\//i.test(String(candidate))) return String(candidate);
  return /^\d+$/.test(String(matterId ?? ""))
    ? `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${matterId}`
    : null;
}

/**
 * Resolve one publisher response using the exact source-native MatterFile.
 * Similar titles, addresses, and partial application strings never resolve.
 */
export function normalizeHistoricalMatterResponse(response, { matterFile, acquiredAt, sourceDate = null } = {}) {
  const requested = normalizeMatterFile(matterFile);
  const rows = rowsFromResponse(response);
  if (!requested) return { status: "rejected", reason: "invalid-matter-file", rows: [] };
  const exact = rows.filter((row) => normalizeMatterFile(row?.MatterFile) === requested);
  if (exact.length !== 1) {
    return {
      status: exact.length > 1 ? "ambiguous" : "unresolved",
      reason: exact.length > 1 ? "ambiguous-exact-matter-file" : "no-exact-matter-file",
      requested_matter_file: requested,
      rows: [],
    };
  }
  const row = exact[0];
  const matterId = text(row.MatterId ?? row.MatterID ?? row.id, 40);
  if (!/^\d+$/.test(matterId)) return { status: "unresolved", reason: "missing-native-matter-id", rows: [] };
  const histories = Array.isArray(row.histories) ? row.histories : [];
  const historyActions = histories.map((history) => text(history?.MatterHistoryActionName ?? history?.ActionName ?? history?.Action, 240)).filter(Boolean);
  const actions = [...new Set([
    ...(Array.isArray(row.actions) ? row.actions.map((action) => text(action, 240)) : []),
    ...historyActions,
  ].filter(Boolean))];
  const actionDate = text(sourceDate || histories.at(-1)?.MatterHistoryActionDate || histories.at(-1)?.ActionDate, 80) || null;
  return {
    status: "resolved",
    reason: null,
    rows: [{
      source: "legistar_historical_matter",
      source_response: row,
      source_date: actionDate || text(row.MatterLastUpdated ?? row.MatterUpdateDate, 80) || null,
      action_date: actionDate,
      acquired_at: acquiredAt || null,
      matter_id: matterId,
      matter_file: requested,
      title: text(row.MatterName ?? row.MatterTitle ?? row.MatterText1, 500) || null,
      matter_url: officialUrl(row, matterId),
      histories,
      event_items: Array.isArray(row.event_items) ? row.event_items : [],
      events: Array.isArray(row.events) ? row.events : [],
      actions,
      outcome: text(row.MatterStatusName ?? row.MatterStatus, 240) || null,
    }],
  };
}

/**
 * Acquire exact retained targets. A missing token or publisher failure is a
 * retryable failure and returns no negative observation.
 */
export async function acquireHistoricalCouncilMatters({
  targets = [], token, fetchImpl = fetch, now = new Date(), maxTargets = 8,
} = {}) {
  const acquiredAt = new Date(now).toISOString();
  const bounded = (Array.isArray(targets) ? targets : []).slice(0, Math.max(1, Math.min(50, Number(maxTargets) || 8)));
  if (!token) return { schema: HISTORICAL_COUNCIL_MATTER_SCHEMA, ok: false, kind: "token-absent", retained_last_good: true, rows: [], unresolved: [] };
  const rows = [];
  const unresolved = [];
  for (const target of bounded) {
    const matterFile = normalizeMatterFile(target?.matter_file ?? target?.matterFile);
    const page = await fetchLegistarMattersByFiles({ matterFiles: [matterFile], token, fetchImpl, now });
    if (!page.ok) return { schema: HISTORICAL_COUNCIL_MATTER_SCHEMA, ok: false, kind: page.kind, status: page.status, retained_last_good: true, rows: [], unresolved };
    const normalized = normalizeHistoricalMatterResponse(page.rows, { matterFile, acquiredAt, sourceDate: target?.source_date });
    if (normalized.status === "resolved") rows.push(...normalized.rows);
    else unresolved.push({ matter_file: matterFile, reason: normalized.reason });
  }
  return { schema: HISTORICAL_COUNCIL_MATTER_SCHEMA, ok: true, kind: "ok", retained_last_good: false, rows, unresolved };
}
