// Organization index: one entry per vendor stem (engine vendor_stem_v1) across every name-bearing
// source. Pure builder: contributions in, file texts out. Static, sharded, generation-stamped:
//
//   data/organization_index.json               manifest (schema, generation, counts, sources, shards)
//   data/organization_index/stems.json         every stem in code-point order with a source bitmask;
//                                              an entry's ordinal is its position in this list
//   data/organization_index/entries-NNN.json   full entries, same order, range-sharded (<= 256 KiB)
//   data/organization_index/ids-XX.json        published identifiers (sbs:, ein:, dol:, sca:) -> ordinals,
//                                              FNV-1a bucketed
//
// Every file carries the manifest's `generation`; a reader that sees two generations refuses.

import { createHash } from "node:crypto";
import { vendorStem } from "../../entity_resolution/normalizers/vendor_stem.mjs";
import {
  SOURCES, SOURCE_IDS, SOURCE_BY_ID, SOURCE_BY_CODE,
  INDEX_SCHEMA, ENTRY_SHARD_SCHEMA, ID_SHARD_SCHEMA, STEMS_SCHEMA, MANIFEST_PATH, DIR, STEMS_PATH, DEFAULT_LIMITS,
  IDENTIFIER_SOURCES, keyBucket, stemTokens, decodeEntry, sourceMask,
} from "../../site/organization_index_contract.mjs";
import { withheldNameNote } from "./organization_name_withholding.mjs";

export * from "../../site/organization_index_contract.mjs";

export const sha256Hex = (t) => createHash("sha256").update(t).digest("hex");

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** contributions: [{source, name, via, ref, amount, date, agency, zip, extra}] */
export function buildEntries(contributions, limits = DEFAULT_LIMITS) {
  const byStem = new Map();
  let unstemmed = 0;
  const attach = (e, c) => {
    let s = e.sources.get(c.source);
    if (!s) { s = { records: 0, via: new Set(), amount_total: 0, has_amount: false, last_date: null, refs: new Map(), zips: new Set(), programmes: new Set(), mwbe: new Map() }; e.sources.set(c.source, s); }
    s.records += 1;
    if (!c.name_withheld) s.via.add(c.via);
    if (typeof c.amount === "number") { s.amount_total += c.amount; s.has_amount = true; }
    if (c.date && (!s.last_date || c.date > s.last_date)) s.last_date = c.date;
    if (c.ref != null) { const prev = s.refs.get(c.ref); if (prev === undefined || (c.date || "") > prev) s.refs.set(c.ref, c.date || ""); }
    if (c.zip) s.zips.add(c.zip);
    for (const p of c.extra?.certification || []) s.programmes.add(p);
    const m = c.extra?.mwbe_category ?? c.extra?.prime_vendor_mwbe_category;
    if (m) s.mwbe.set(m, (s.mwbe.get(m) || 0) + 1);
  };
  for (const c of contributions) {
    if (!SOURCE_BY_ID[c.source]) throw new Error(`unknown source ${c.source}`);
    if (c.name_withheld) {
      const stem = c.index_key;
      if (!stem) throw new Error("withheld organization name is missing its published identifier");
      let e = byStem.get(stem);
      if (!e) { e = { stem, names: new Map(), sources: new Map(), name_withheld: true }; byStem.set(stem, e); }
      if (e.names.size) throw new Error("withheld organization entry collided with a published name");
      e.name_withheld = true;
      attach(e, c);
      continue;
    }
    const stem = vendorStem(c.name);
    if (!stem) { unstemmed += 1; continue; }
    let e = byStem.get(stem);
    if (e?.name_withheld) throw new Error("published name collided with a withheld organization entry");
    if (!e) { e = { stem, names: new Map(), sources: new Map() }; byStem.set(stem, e); }
    const nk = `${c.via}\u0000${c.name}`;
    e.names.set(nk, (e.names.get(nk) || 0) + 1);
    attach(e, c);
  }
  const entries = [...byStem.values()].map((e) => encodeEntry(e, limits)).sort((a, b) => cmp(a.s, b.s));
  return { entries, unstemmed };
}

/** Compact on-disk entry. See decodeEntry for the expanded form. */
function encodeEntry(e, limits) {
  const all = [...e.names.entries()]
    .map(([k, count]) => { const [via, name] = k.split("\u0000"); return { name, via, count }; })
    .sort((a, b) => b.count - a.count || cmp(a.name, b.name));
  const n = all.filter((x) => x.via === "name");
  const d = all.filter((x) => x.via === "dba");
  const out = { s: e.stem };
  if (e.name_withheld) {
    if (all.length) throw new Error("withheld organization entry still has a name");
    out.w = 1;
  } else {
    if (n.length) out.n = n.slice(0, limits.max_name_variants).map((x) => [x.name, x.count]);
    if (d.length) out.d = d.slice(0, limits.max_name_variants).map((x) => [x.name, x.count]);
    if (n.length > limits.max_name_variants || d.length > limits.max_name_variants) out.N = all.length;
  }
  out.x = {};
  for (const id of SOURCE_IDS) {
    const s = e.sources.get(id);
    if (!s) continue;
    const src = SOURCE_BY_ID[id];
    const idKind = IDENTIFIER_SOURCES[id];
    const refs = idKind
      ? [...s.refs.keys()].sort(cmp)
      : [...s.refs.entries()].sort((a, b) => cmp(b[1], a[1]) || cmp(a[0], b[0])).map(([r]) => r).slice(0, limits.max_transaction_refs);
    const blk = { r: s.records };
    const via = [...s.via].sort();
    if (via.length && !(via.length === 1 && via[0] === "name")) blk.v = via;
    if (src.has_amounts && s.has_amount) blk.a = Math.round(s.amount_total * 100) / 100;
    if (s.last_date) blk.l = s.last_date;
    if (s.refs.size !== refs.length) blk.c = s.refs.size;
    if (refs.length) blk.i = refs;
    if (s.zips.size) blk.z = [...s.zips].sort(cmp);
    if (s.programmes.size) blk.p = [...s.programmes].sort(cmp);
    if (s.mwbe.size) blk.m = [...s.mwbe.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([v]) => v);
    out.x[src.code] = blk;
  }
  return out;
}

function renderEntryShard(generation, index, firstOrdinal, lines) {
  return `{"schema":"${ENTRY_SHARD_SCHEMA}","generation":"${generation}","shard":${index},"first_ordinal":${firstOrdinal},"entries":[\n${lines.join(",\n")}\n]}\n`;
}
function renderIdShard(generation, bucket, map) {
  const keys = [...map.keys()].sort(cmp);
  return `{"schema":"${ID_SHARD_SCHEMA}","generation":"${generation}","bucket":"${bucket}","ids":{\n${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify([...map.get(k)].sort((a, b) => a - b))}`).join(",\n")}\n}}\n`;
}

/**
 * Build the file set. Deterministic: the same contributions give byte-identical files. The generation
 * is the sha256 of the entry lines, so it changes when and only when an entry changes.
 * meta = { built_from, receipts: {source_id: {...}} }
 */
export function buildIndex(contributions, meta = {}, limits = DEFAULT_LIMITS) {
  const { entries, unstemmed } = buildEntries(contributions, limits);
  const lines = entries.map((e) => JSON.stringify(e));
  const generation = sha256Hex(lines.join("\n")).slice(0, 16);
  const files = new Map();
  const stemRow = (e) => JSON.stringify(e.w ? [e.s, sourceMask(e), 1] : [e.s, sourceMask(e)]);
  const stemsText = `{"schema":"${STEMS_SCHEMA}","generation":"${generation}","count":${entries.length},"stems":[\n${entries.map(stemRow).join(",\n")}\n]}\n`;
  files.set(STEMS_PATH, stemsText);
  const entryShards = [];
  let start = 0; let shardIndex = 0;
  while (start < entries.length) {
    let bytes = 160; let end = start;
    while (end < entries.length && (end === start || bytes + Buffer.byteLength(lines[end]) + 2 <= limits.entry_shard_max_bytes)) { bytes += Buffer.byteLength(lines[end]) + 2; end += 1; }
    const text = renderEntryShard(generation, shardIndex, start, lines.slice(start, end));
    const path = `${DIR}/entries-${String(shardIndex).padStart(3, "0")}.json`;
    files.set(path, text);
    entryShards.push({ path, first_ordinal: start, entries: end - start, first_stem: entries[start].s, last_stem: entries[end - 1].s, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
    start = end; shardIndex += 1;
  }
  const buckets = new Map();
  let idCount = 0;
  entries.forEach((e, ordinal) => {
    for (const [code, b] of Object.entries(e.x)) {
      const kind = IDENTIFIER_SOURCES[SOURCE_BY_CODE[code].id];
      if (!kind) continue;
      for (const id of b.i || []) {
        const key = `${kind}:${id}`;
        const bk = keyBucket(key, limits.id_buckets);
        if (!buckets.has(bk)) buckets.set(bk, new Map());
        const m = buckets.get(bk);
        if (!m.has(key)) { m.set(key, new Set()); idCount += 1; }
        m.get(key).add(ordinal);
      }
    }
  });
  const idShards = [];
  for (let i = 0; i < limits.id_buckets; i++) {
    const b = i.toString(16).padStart(2, "0");
    const m = buckets.get(b) || new Map();
    const text = renderIdShard(generation, b, m);
    const path = `${DIR}/ids-${b}.json`;
    files.set(path, text);
    idShards.push({ path, bucket: b, ids: m.size, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
  }
  const decoded = entries.map((e, i) => decodeEntry(e, i));
  const manifest = {
    schema: INDEX_SCHEMA,
    generation,
    stem_method: "vendor_stem_v1",
    built_from: meta.built_from ?? null,
    entry_count: entries.length,
    withheld_published_names: meta.withheld_published_names ?? 0,
    notes: withheldNameNote(meta.withheld_published_names ?? 0),
    contributions: contributions.length,
    contributions_without_stem: unstemmed,
    identifier_count: idCount,
    sources: SOURCES.map((s) => ({ ...s, receipt: meta.receipts?.[s.id] ?? null, entries: decoded.filter((e) => e.sources[s.id]).length })),
    limits: { ...limits },
    link_labels: ["same_normalized_name", "same_normalized_name_and_zip"],
    stems: { path: STEMS_PATH, bytes: Buffer.byteLength(stemsText), sha256: sha256Hex(stemsText) },
    entry_shards: entryShards,
    id_shards: idShards,
    composition: compositionOf(decoded),
  };
  files.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files, entries: decoded };
}

/** Entries by exact source combination and by number of sources. */
export function compositionOf(entries) {
  const byCombination = {};
  const bySourceCount = { "1": 0, "2": 0, "3+": 0 };
  for (const e of entries) {
    const k = e.source_ids.join("+");
    byCombination[k] = (byCombination[k] || 0) + 1;
    const n = e.source_ids.length;
    bySourceCount[n >= 3 ? "3+" : String(n)] += 1;
  }
  const sorted = Object.fromEntries(Object.entries(byCombination).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])));
  return { by_source_count: bySourceCount, by_source_combination: sorted };
}

/** Integrity of a written file set: hashes, generation, ranges, ordering. Returns problems[]. */
export function checkFiles(readText) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(readText(MANIFEST_PATH)); } catch (e) { return [`manifest unreadable: ${e.message}`]; }
  if (manifest.schema !== INDEX_SCHEMA) problems.push(`manifest schema ${manifest.schema}`);
  let prevLast = null; let total = 0;
  for (const s of manifest.entry_shards || []) {
    let t; try { t = readText(s.path); } catch { problems.push(`missing ${s.path}`); continue; }
    if (sha256Hex(t) !== s.sha256) problems.push(`sha256 mismatch ${s.path}`);
    const d = JSON.parse(t);
    if (d.generation !== manifest.generation) problems.push(`generation mismatch ${s.path}`);
    if (d.first_ordinal !== total) problems.push(`first_ordinal ${s.path}`);
    if (d.entries.length !== s.entries) problems.push(`entry count ${s.path}`);
    if (d.entries[0]?.s !== s.first_stem || d.entries.at(-1)?.s !== s.last_stem) problems.push(`range ${s.path}`);
    for (const e of d.entries) {
      if (prevLast !== null && !(e.s > prevLast)) problems.push(`order ${s.path} at ${e.s}`);
      if (e.w) {
        if (e.n || e.d) problems.push("withheld entry still has a name");
        if (!/^sbs:\d{1,9}$/.test(e.s)) problems.push("withheld entry key is not its published account id");
      } else {
        const first = (e.n && e.n[0] && e.n[0][0]) || (e.d && e.d[0] && e.d[0][0]);
        if (!first || vendorStem(first) !== e.s) problems.push(`stem ${e.s} does not equal vendorStem of its first name`);
      }
      prevLast = e.s;
    }
    total += d.entries.length;
  }
  if (total !== manifest.entry_count) problems.push(`entry_count ${total} != ${manifest.entry_count}`);
  try {
    const st = readText(manifest.stems.path);
    if (sha256Hex(st) !== manifest.stems.sha256) problems.push("sha256 mismatch stems");
    const sd = JSON.parse(st);
    if (sd.generation !== manifest.generation) problems.push("generation mismatch stems");
    if (sd.stems.length !== manifest.entry_count) problems.push("stems count");
  } catch (e) { problems.push(`stems unreadable: ${e.message}`); }
  for (const s of manifest.id_shards || []) {
    let t; try { t = readText(s.path); } catch { problems.push(`missing ${s.path}`); continue; }
    if (sha256Hex(t) !== s.sha256) problems.push(`sha256 mismatch ${s.path}`);
    if (JSON.parse(t).generation !== manifest.generation) problems.push(`generation mismatch ${s.path}`);
  }
  return problems;
}
