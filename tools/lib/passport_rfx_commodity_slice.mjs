// A committed slice of the public PASSPort RFx dump: each EPIN with the main commodity label
// PASSPort states for it, and when it was read.
//
// PASSPort Public refuses the hosted build runners (HTTP 403 from its CDN to datacenter
// addresses; the same request from a residential host returns 200). The open-solicitation
// category join needs only two RFx columns, so a host that can read the dump records them here,
// and a build that is refused joins against this slice and says so, with the slice's own date.
// The slice holds what PASSPort published; nothing in it is derived or guessed.

import { RFX_DATA_URL } from "../../worker/src/lib/passport_parse.mjs";

export const PASSPORT_RFX_COMMODITY_SLICE_SCHEMA = "cityscroll.passport_rfx_commodity_slice.v1";
export const PASSPORT_RFX_COMMODITY_SLICE_PATH = "site/data/passport_sources/rfx_commodity_slice.json";
// The dump carried 12,640 RFx rows (11,316 distinct EPIN and label pairs) on 2026-11-25.
export const PASSPORT_RFX_COMMODITY_SLICE_MAX_ROWS = 60_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const label = (value) => (typeof value === "string" ? value : "");

/** Build the slice from rows as `parseRfxDump` returns them. */
export function buildPassportRfxCommoditySlice(rfxRows, { observedAt }) {
  if (!Array.isArray(rfxRows) || rfxRows.length === 0) throw new Error("rfx commodity slice: no RFx rows");
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) throw new Error("rfx commodity slice: observedAt must be a timestamp");
  const pairs = new Map();
  for (const row of rfxRows) {
    const epin = typeof row?.epin === "string" ? row.epin.trim() : "";
    if (!epin) continue;
    const text = label(row.main_commodity);
    pairs.set(JSON.stringify([epin, text]), [epin, text]);
  }
  const sorted = [...pairs.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  if (sorted.length > PASSPORT_RFX_COMMODITY_SLICE_MAX_ROWS) throw new Error(`rfx commodity slice: ${sorted.length} rows exceeds the bound`);
  const labels = [...new Set(sorted.map(([, text]) => text))].sort();
  const at = new Map(labels.map((text, i) => [text, i]));
  return {
    schema: PASSPORT_RFX_COMMODITY_SLICE_SCHEMA,
    source: "passport_public_rfx",
    source_url: RFX_DATA_URL,
    observed_at: observed.toISOString(),
    as_of: observed.toISOString().slice(0, 10),
    note: "Each PASSPort Public RFx EPIN with its main commodity label exactly as published (an empty label is published as empty). Read by the open-solicitation category join only when the live dump refuses the build host.",
    source_rows: rfxRows.length,
    labels,
    rows: sorted.map(([epin, text]) => [epin, at.get(text)]),
  };
}

/** One row per line so a daily refresh diffs by EPIN. */
export function renderPassportRfxCommoditySlice(slice) {
  const { labels, rows, ...head } = slice;
  const lines = Object.entries(head).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  lines.push(`  "labels": [\n${labels.map((text) => `    ${JSON.stringify(text)}`).join(",\n")}\n  ],`);
  lines.push(`  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  ]`);
  return `{\n${lines.join("\n")}\n}\n`;
}

/** The slice as join rows `{ epin, main_commodity }`. Throws on anything malformed. */
export function rfxRowsFromCommoditySlice(slice) {
  if (slice?.schema !== PASSPORT_RFX_COMMODITY_SLICE_SCHEMA) throw new Error("rfx commodity slice: unexpected schema");
  if (!DAY.test(String(slice.as_of)) || Number.isNaN(new Date(slice.observed_at).getTime())) {
    throw new Error("rfx commodity slice: missing observation date");
  }
  if (!Array.isArray(slice.labels) || !slice.labels.every((text) => typeof text === "string")) {
    throw new Error("rfx commodity slice: labels must be strings");
  }
  if (!Array.isArray(slice.rows) || slice.rows.length === 0) throw new Error("rfx commodity slice: no rows");
  if (slice.rows.length > PASSPORT_RFX_COMMODITY_SLICE_MAX_ROWS) throw new Error("rfx commodity slice: too many rows");
  return slice.rows.map((row) => {
    const [epin, index] = Array.isArray(row) ? row : [];
    if (typeof epin !== "string" || !epin || !Number.isInteger(index) || index < 0 || index >= slice.labels.length) {
      throw new Error("rfx commodity slice: row has no EPIN or an unknown label");
    }
    return { epin, main_commodity: slice.labels[index] };
  });
}
