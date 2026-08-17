import {
  ADDRESS_INDEX_MANIFEST_SCHEMA,
  ADDRESS_INDEX_SHARD_SCHEMA,
  addressShardKey,
  normalizeStreetName,
} from "../../site/precomputed_address_geocoder.mjs";

const INCLUDED_ADDRESS_TYPES = new Set(["", "V"]);

export function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < String(line).length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function padRecord(row, columns) {
  const get = (name) => row[columns.get(name)] ?? "";
  const addressType = get("addrtype").trim();
  if (!INCLUDED_ADDRESS_TYPES.has(addressType)) return { excluded: addressType || "unknown" };
  const boro = get("boro").trim();
  const block = get("block").trim().padStart(5, "0");
  const lot = get("lot").trim().padStart(4, "0");
  const bbl = `${boro}${block}${lot}`;
  const street = normalizeStreetName(get("stname"));
  const lowSortRaw = get("lhns").trim();
  const highSortRaw = get("hhns").trim();
  if (!/^[01]\d{8}[A-Z]{2}$/.test(lowSortRaw) || !/^[01]\d{8}[A-Z]{2}$/.test(highSortRaw)) {
    return { excluded: "missing_house_range" };
  }
  if (!/^[1-5]\d{9}$/.test(bbl) || !street) return { excluded: "invalid_identity" };
  const continuous = Boolean(get("lcontpar").trim() || get("hcontpar").trim());
  const sourceParity = Number(get("parity").trim());
  const parity = continuous ? 0 : (sourceParity === 1 || sourceParity === 2 ? sourceParity : 0);
  const record = [
    Number(lowSortRaw.slice(0, 9)),
    Number(highSortRaw.slice(0, 9)),
    parity,
    bbl,
    get("zipcode").trim(),
  ];
  if (lowSortRaw.slice(9) !== "AA" || highSortRaw.slice(9) !== "AA") {
    record.push(get("lhnd").trim(), get("hhnd").trim());
  }
  return { street, record, addressType: addressType || "real" };
}

function mergeStreetRanges(records) {
  const sorted = records.sort((left, right) =>
    String(left[3]).localeCompare(String(right[3]))
    || String(left[4]).localeCompare(String(right[4]))
    || left[2] - right[2]
    || left[0] - right[0]
    || left[1] - right[1]);
  const merged = [];
  for (const record of sorted) {
    const previous = merged.at(-1);
    const step = record[2] === 0 ? 1 : 2;
    if (previous
      && previous.length === 5
      && record.length === 5
      && previous[2] === record[2]
      && previous[3] === record[3]
      && previous[4] === record[4]
      && record[0] <= previous[1] + step) {
      previous[1] = Math.max(previous[1], record[1]);
    } else if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
      merged.push(record);
    }
  }
  return merged;
}

async function eachLine(lines, visit) {
  if (lines?.[Symbol.asyncIterator]) {
    for await (const line of lines) visit(line);
  } else {
    for (const line of lines || []) visit(line);
  }
}

export async function buildAddressIndexFromPadLines(lines, {
  generatedAt = new Date().toISOString(),
  sourceSha256 = null,
  sourceVersion = "unknown",
  shardCount = 64,
} = {}) {
  let columns = null;
  let sourceRows = 0;
  let includedRows = 0;
  const excludedByType = {};
  const boroughCounts = {};
  const streetRanges = new Map();
  await eachLine(lines, (line) => {
    if (!String(line).trim()) return;
    const row = parseCsvLine(String(line).replace(/\r$/, ""));
    if (!columns) {
      columns = new Map(row.map((name, index) => [name.trim(), index]));
      for (const required of ["boro", "block", "lot", "lhnd", "lhns", "hhnd", "hhns", "stname", "addrtype", "parity", "zipcode"]) {
        if (!columns.has(required)) throw new Error(`PAD address file is missing ${required}`);
      }
      return;
    }
    sourceRows += 1;
    const shaped = padRecord(row, columns);
    if (!shaped.street) {
      excludedByType[shaped.excluded] = (excludedByType[shaped.excluded] || 0) + 1;
      return;
    }
    includedRows += 1;
    boroughCounts[shaped.record[3][0]] = (boroughCounts[shaped.record[3][0]] || 0) + 1;
    if (!streetRanges.has(shaped.street)) streetRanges.set(shaped.street, []);
    streetRanges.get(shaped.street).push(shaped.record);
  });
  if (!columns || sourceRows === 0 || includedRows === 0) throw new Error("PAD address corpus is empty");

  const shards = new Map();
  for (let index = 0; index < shardCount; index += 1) {
    const key = index.toString(16).padStart(2, "0");
    shards.set(key, { schema: ADDRESS_INDEX_SHARD_SCHEMA, key, streets: {} });
  }
  let materializedRanges = 0;
  for (const [street, records] of [...streetRanges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const key = addressShardKey(street, shardCount);
    const merged = mergeStreetRanges(records);
    materializedRanges += merged.length;
    shards.get(key).streets[street] = merged;
  }
  const manifest = {
    schema: ADDRESS_INDEX_MANIFEST_SCHEMA,
    generated_at: generatedAt,
    delivery_tier: "daily-precomputed-citywide-snapshot",
    source: {
      name: "NYC Department of City Planning Property Address Directory",
      dataset_id: "bc8t-ecyu",
      version: sourceVersion,
      download_url: "https://data.cityofnewyork.us/download/bc8t-ecyu/application%2Fzip",
      sha256: sourceSha256,
    },
    shard_count: shardCount,
    coverage: {
      source_address_rows: sourceRows,
      included_real_and_vanity_ranges: includedRows,
      materialized_ranges: materializedRanges,
      normalized_streets: streetRanges.size,
      borough_source_ranges: boroughCounts,
      excluded_by_address_type: excludedByType,
      statement: "Covers real and vanity address ranges published in this PAD snapshot. Pseudo-addresses, non-addressable names/frontages, invalid identities, and unmatched or ambiguous inputs remain unknown.",
    },
    shards: {},
  };
  for (const [key, shard] of shards) {
    const records = Object.values(shard.streets).reduce((sum, rows) => sum + rows.length, 0);
    manifest.shards[key] = {
      file: `./${key}.json`,
      records,
      streets: Object.keys(shard.streets).length,
    };
  }
  return { manifest, shards };
}
