#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUTPUT = new URL("../site/data/exam_sources/title_code_alias_registry.json", import.meta.url);
const OBSERVED_ON = "2026-08-06";
const JOBS = {
  dataset_id: "kpav-sd4t",
  landing_page: "https://data.cityofnewyork.us/d/kpav-sd4t",
  resource_url: "https://data.cityofnewyork.us/resource/kpav-sd4t.json",
};
const TITLES = {
  dataset_id: "nzjr-3966",
  landing_page: "https://data.cityofnewyork.us/d/nzjr-3966",
  resource_url: "https://data.cityofnewyork.us/resource/nzjr-3966.json",
};

export function normalizeTitleLabel(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

function clean(value) {
  return String(value ?? "").trim();
}

function code(value) {
  return clean(value).toUpperCase();
}

function sourceSummary(spec, metadata, rows, fields) {
  const populated = rows.filter((row) => fields.every((field) => clean(row[field]))).length;
  return {
    dataset_id: spec.dataset_id,
    landing_page: spec.landing_page,
    resource_url: spec.resource_url,
    rows: rows.length,
    rows_with_required_fields: populated,
    rows_updated_at: metadata?.rowsUpdatedAt
      ? new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString()
      : null,
    fields,
  };
}

function canonicalIdentity(rows) {
  const byCode = new Map();
  for (const row of rows) {
    const titleCode = code(row.title);
    const description = normalizeTitleLabel(row.descr);
    if (!titleCode || !description) continue;
    const identity = byCode.get(titleCode) || {
      title_code: titleCode,
      descriptions: new Set(),
      assignment_levels: new Set(),
      standard_hours: new Set(),
    };
    identity.descriptions.add(description);
    if (clean(row.asg_lvl)) identity.assignment_levels.add(clean(row.asg_lvl));
    if (clean(row.std_hrs)) identity.standard_hours.add(Number(row.std_hrs));
    byCode.set(titleCode, identity);
  }
  return new Map([...byCode].map(([titleCode, identity]) => [titleCode, {
    title_code: titleCode,
    descriptions: [...identity.descriptions].sort(),
    assignment_levels: [...identity.assignment_levels].sort(),
    standard_hours: [...identity.standard_hours].sort((a, b) => a - b),
  }]));
}

export function buildTitleCodeAliasRegistry({
  jobsRows = [],
  canonicalRows = [],
  jobsMetadata = {},
  canonicalMetadata = {},
  generatedAt = OBSERVED_ON,
} = {}) {
  const canonical = canonicalIdentity(canonicalRows);
  const canonicalCodesByDescription = new Map();
  for (const identity of canonical.values()) {
    for (const description of identity.descriptions) {
      const codes = canonicalCodesByDescription.get(description) || new Set();
      codes.add(identity.title_code);
      canonicalCodesByDescription.set(description, codes);
    }
  }
  const pairs = new Map();
  for (const row of jobsRows) {
    const alias = normalizeTitleLabel(row.civil_service_title);
    const titleCode = code(row.title_code_no);
    if (!alias || !titleCode) continue;
    const identity = canonical.get(titleCode);
    // A source label is accepted only when the canonical publisher confirms
    // the same code and exact normalized description. No fuzzy title merge is
    // allowed to enter the alias registry.
    if (!identity || identity.descriptions.length !== 1 || identity.descriptions[0] !== alias
      || canonicalCodesByDescription.get(alias)?.size !== 1) continue;
    const key = `${alias}::${titleCode}`;
    const entry = pairs.get(key) || {
      alias,
      title_code: titleCode,
      agencies: new Set(),
      source_record_ids: new Set(),
      postings: 0,
    };
    if (clean(row.agency)) entry.agencies.add(clean(row.agency));
    if (clean(row.job_id)) entry.source_record_ids.add(clean(row.job_id));
    entry.postings += 1;
    pairs.set(key, entry);
  }

  const aliases = [...pairs.values()]
    .map((entry) => ({
      alias: entry.alias,
      normalized_alias: entry.alias,
      title_code: entry.title_code,
      canonical_title: canonical.get(entry.title_code).descriptions[0],
      agencies: [...entry.agencies].sort(),
      postings: entry.postings,
      source_record_ids: [...entry.source_record_ids].sort(),
      provenance: {
        source_system: "nyc_jobs",
        dataset_id: JOBS.dataset_id,
        label_field: "civil_service_title",
        code_field: "title_code_no",
        agency_field: "agency",
      },
    }))
    .sort((left, right) => left.alias.localeCompare(right.alias) || left.title_code.localeCompare(right.title_code));

  const codesByAlias = new Map();
  for (const row of aliases) {
    const codes = codesByAlias.get(row.normalized_alias) || new Set();
    codes.add(row.title_code);
    codesByAlias.set(row.normalized_alias, codes);
  }

  return {
    schema_version: 1,
    schema: "cityscroll.title_code_alias_registry.v1",
    generated_at: generatedAt,
    status: "publisher_labeled_exact_aliases",
    public_surfaces_changed: false,
    operative_links_enabled: false,
    policy: "Only exact normalized labels backed by both publisher datasets enter this registry; candidates and inferences remain review-only.",
    sources: {
      jobs_nyc_postings: sourceSummary(JOBS, jobsMetadata, jobsRows, ["civil_service_title", "title_code_no", "agency"]),
      civil_service_titles: sourceSummary(TITLES, canonicalMetadata, canonicalRows, ["title", "descr"]),
    },
    canonical_titles: [...canonical.values()].sort((left, right) => left.title_code.localeCompare(right.title_code)),
    canonical_label_index: Object.fromEntries([...canonicalCodesByDescription]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, codes]) => [label, [...codes].sort()])),
    aliases,
    alias_index: Object.fromEntries([...codesByAlias].sort(([left], [right]) => left.localeCompare(right)).map(([alias, codes]) => [alias, [...codes].sort()])),
    measures: {
      canonical_title_codes: canonical.size,
      exact_alias_pairs: aliases.length,
      exact_alias_labels: codesByAlias.size,
      ambiguous_alias_labels: [...codesByAlias.values()].filter((codes) => codes.size > 1).length,
      source_rows_accepted: aliases.reduce((sum, row) => sum + row.postings, 0),
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchSource(spec) {
  const [metadata, rows] = await Promise.all([
    fetchJson(`https://data.cityofnewyork.us/api/views/${spec.dataset_id}`),
    fetchJson(`${spec.resource_url}?$limit=50000`),
  ]);
  assert.ok(Array.isArray(rows), `${spec.dataset_id} response must be an array`);
  return { metadata, rows };
}

async function main() {
  if (process.argv.includes("--check")) {
    const artifact = JSON.parse(await readFile(OUTPUT, "utf8"));
    assert.equal(artifact.schema, "cityscroll.title_code_alias_registry.v1");
    assert.ok(artifact.sources?.jobs_nyc_postings?.rows > 0);
    assert.ok(artifact.sources?.civil_service_titles?.rows > 0);
    assert.ok(artifact.aliases?.length > 0);
    console.log("title-code alias registry is present");
    return;
  }
  const [jobs, titles] = await Promise.all([fetchSource(JOBS), fetchSource(TITLES)]);
  const artifact = buildTitleCodeAliasRegistry({
    jobsRows: jobs.rows,
    canonicalRows: titles.rows,
    jobsMetadata: jobs.metadata,
    canonicalMetadata: titles.metadata,
  });
  await writeFile(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(OUTPUT)}`);
  console.log(JSON.stringify(artifact.measures, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
