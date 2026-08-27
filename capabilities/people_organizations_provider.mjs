// Transport-neutral provider projection for the bounded People and
// organizations browse capability. Delivery adapters supply the read model;
// this module owns identity admission, matching, pagination, and coverage.

import {
  ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  ORGANIZATIONS_BROWSE_LIMITS,
  PEOPLE_ORGANIZATION_ROW_KINDS,
} from "./people_organizations.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function modelRows(model) {
  if (!model || typeof model !== "object" || !Array.isArray(model.rows)) {
    throw new Error("people organizations read model is unavailable");
  }
  const ids = new Set();
  for (const row of model.rows) {
    if (!row?.id || ids.has(row.id) || !PEOPLE_ORGANIZATION_ROW_KINDS.includes(row.kind) || !row.label) {
      throw new Error("people organizations identity guard failed");
    }
    ids.add(row.id);
  }
  return model.rows;
}

function freshness(model) {
  return { as_of: model.generated_at || "unknown", generated_at: model.generated_at || null };
}

function coverage(model) {
  return {
    state: model.generated_at ? "published" : "unknown",
    read_model_schema: model.schema,
    row_kinds: model.row_kinds,
    relation_states: model.relation_states,
    counts: model.counts,
  };
}

function publicModelRow(row) {
  // search_text is a presentation/index field, not public row meaning.
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== "search_text"));
}

function encodeCursor(id) {
  return btoa(id).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - cursor.length % 4) % 4);
    return atob(padded) || null;
  } catch {
    return null;
  }
}

function searchValue(row) {
  return clean(row.search_text || [row.id, row.label, row.detail, row.agency, row.title_code]
    .filter(Boolean).join(" ")).toLocaleLowerCase();
}

/** Execute the organizations.browse@1 provider against an already loaded model. */
export function organizationsBrowseFromModel(model, input) {
  const rows = modelRows(model);
  const cursorId = decodeCursor(input.cursor);
  if (input.cursor && !cursorId) throw new Error("invalid cursor");
  const query = clean(input.query).toLocaleLowerCase();
  const matches = rows.filter((row) => (
    (!input.kind || row.kind === input.kind)
    && (!query || query.split(/\s+/).every((term) => searchValue(row).includes(term)))
  ));
  const start = cursorId ? matches.findIndex((row) => row.id === cursorId) + 1 : 0;
  if (cursorId && start === 0) throw new Error("invalid cursor");
  const limit = input.limit || ORGANIZATIONS_BROWSE_LIMITS.default;
  const resultRows = matches.slice(start, start + limit);
  const truncated = start + resultRows.length < matches.length;
  return {
    capability_reference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
    availability: resultRows.length ? "complete" : "empty",
    results: resultRows.map(publicModelRow),
    total_matches: matches.length,
    pagination: {
      limit,
      returned: resultRows.length,
      truncated,
      next_cursor: truncated ? encodeCursor(resultRows.at(-1).id) : null,
    },
    coverage: coverage(model),
    freshness: freshness(model),
    error: null,
  };
}
