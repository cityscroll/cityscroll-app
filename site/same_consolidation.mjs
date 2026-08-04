/**
 * Lens-neutral small-multiples collapse for exact displayed-field repetition.
 *
 * A surface declares every displayed field plus the field(s) allowed to vary.
 * The returned view model keeps every original row inside either an item or a
 * threshold-sized group; callers remain free to export the untouched source rows.
 */

function optionList(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function contract(options = {}) {
  const fields = optionList(options.fields).map(String);
  const except = new Set(optionList(options.except).map(String));
  if (!fields.length) throw new TypeError("same-consolidation requires displayed fields");
  if (!except.size) throw new TypeError("same-consolidation requires at least one differing field");
  for (const field of except) {
    if (!fields.includes(field)) {
      throw new TypeError(`same-consolidation differing field is not displayed: ${field}`);
    }
  }
  const threshold = Math.max(2, Number(options.threshold) || 3);
  const normalize = typeof options.normalize === "function"
    ? options.normalize
    : (value) => value == null ? "" : String(value);
  return { fields, except, threshold, normalize };
}

function valueFor(row, field, normalize) {
  return normalize(row?.[field], field, row);
}

function signature(row, fields, except, normalize) {
  return JSON.stringify(fields
    .filter((field) => !except.has(field))
    .map((field) => [field, valueFor(row, field, normalize)]));
}

function bucketsFor(rows, options) {
  const config = contract(options);
  const buckets = new Map();
  rows.forEach((row, index) => {
    const key = signature(row, config.fields, config.except, config.normalize);
    const bucket = buckets.get(key) || { key, firstIndex: index, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  });
  return { buckets, config };
}

/**
 * Collapse threshold-sized same-except-k groups without losing source rows.
 * @returns {Array<{kind:"same-except-item",item:object}|{kind:"same-except-group",count:number,members:object[],shared:object,differing:object}>}
 */
export function groupSameExcept(rows, options = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const { buckets, config } = bucketsFor(source, options);
  const grouped = new Set();
  const entries = [];

  source.forEach((row, index) => {
    const key = signature(row, config.fields, config.except, config.normalize);
    const bucket = buckets.get(key);
    if (bucket.rows.length < config.threshold) {
      entries.push({ kind: "same-except-item", item: row });
      return;
    }
    if (grouped.has(key)) return;
    grouped.add(key);
    const shared = {};
    const differing = {};
    for (const field of config.fields) {
      if (config.except.has(field)) {
        differing[field] = bucket.rows.map((member) => member?.[field]);
      } else {
        shared[field] = row?.[field];
      }
    }
    entries.push({
      kind: "same-except-group",
      key,
      count: bucket.rows.length,
      members: [...bucket.rows],
      shared,
      differing,
      firstIndex: index,
    });
  });
  return entries;
}

function rawRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.kind === "same-except-group") return null;
  if (entry.kind === "same-except-item") return entry.item || null;
  return entry;
}

/**
 * Detector for a rendered view model that left threshold-sized repetition loose.
 * Consolidated group entries are intentionally opaque; individual entries are
 * checked with the same exact displayed-field contract used by the grouper.
 */
export function repeatedSameExceptFindings(entries, options = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map(rawRow).filter(Boolean);
  const { buckets, config } = bucketsFor(rows, options);
  return [...buckets.values()]
    .filter((bucket) => bucket.rows.length >= config.threshold)
    .map((bucket) => ({
      kind: "unconsolidated-same-except",
      count: bucket.rows.length,
      differing_fields: [...config.except],
      request_ids: bucket.rows.map((row) => row.request_id).filter(Boolean),
      sample: bucket.rows[0],
    }));
}
