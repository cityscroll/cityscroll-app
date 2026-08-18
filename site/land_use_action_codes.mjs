/**
 * Extract uppercase action codes from a ZAP row / outcome record.
 * Accepts `actions` as a string ("ZM,ZR"), array of strings, or array of
 * `{ action: "PQ" }` objects from /zap-outcomes.
 */
export function landUseActionCodes(record = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const code = String(raw ?? "").replace(/\s+/g, " ").trim().toUpperCase();
    if (!code || seen.has(code)) return;
    if (!/^[A-Z0-9]{1,4}$/.test(code)) return;
    seen.add(code);
    out.push(code);
  };

  const actions = record.actions;
  if (typeof actions === "string") {
    for (const part of actions.split(/[^A-Za-z0-9]+/)) push(part);
  } else if (Array.isArray(actions)) {
    for (const row of actions) {
      if (typeof row === "string") push(row);
      else if (row && typeof row === "object") push(row.action || row.code || row.action_code);
    }
  }

  const openDataActions = record.open_data?.actions;
  if (typeof openDataActions === "string") {
    for (const part of openDataActions.split(/[^A-Za-z0-9]+/)) push(part);
  }

  return out;
}
