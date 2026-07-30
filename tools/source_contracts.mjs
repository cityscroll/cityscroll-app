import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REGISTRY_PATH = fileURLToPath(new URL("../site/data/source_contracts.json", import.meta.url));
export const DOC_PATH = fileURLToPath(new URL("../docs/data-sources.md", import.meta.url));
export const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
export const SHAPE_FIXTURE_PATH = fileURLToPath(new URL("../test/fixtures/source_contracts/source-shapes.json", import.meta.url));
export const README_BEGIN = "<!-- BEGIN GENERATED SOURCE CONTRACTS -->";
export const README_END = "<!-- END GENERATED SOURCE CONTRACTS -->";

const ALLOWED_STATUS = new Set(["live", "build-time", "manual", "disabled"]);
const ALLOWED_KIND = new Set(["socrata", "checkbook", "arcgis", "geosearch", "html", "mocs-disabled", "rss"]);
const ALLOWED_DELIVERY_TIERS = new Set(["inline-at-build", "edge-materialized", "live-only"]);

export function loadSourceContracts() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

export function loadSourceContractFixtures() {
  return JSON.parse(readFileSync(SHAPE_FIXTURE_PATH, "utf8"));
}

export function validateSourceContracts(registry) {
  const errors = [];
  if (registry?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!Array.isArray(registry?.contracts) || registry.contracts.length === 0) {
    errors.push("contracts must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  for (const contract of registry.contracts) {
    const label = contract?.id || "(missing id)";
    for (const field of ["id", "name", "owner", "status", "scope", "kind", "landing_page", "publisher_cadence", "product_freshness", "used_for", "delivery_tier"]) {
      if (!contract?.[field]) errors.push(`${label}: missing ${field}`);
    }
    if (ids.has(contract.id)) errors.push(`${label}: duplicate id`);
    ids.add(contract.id);
    if (!ALLOWED_STATUS.has(contract.status)) errors.push(`${label}: invalid status ${contract.status}`);
    if (!ALLOWED_KIND.has(contract.kind)) errors.push(`${label}: invalid kind ${contract.kind}`);
    if (!ALLOWED_DELIVERY_TIERS.has(contract.delivery_tier)) {
      errors.push(`${label}: invalid delivery_tier ${contract.delivery_tier}`);
    }
    if (!Array.isArray(contract.code_references) || contract.code_references.length === 0) {
      errors.push(`${label}: code_references must be non-empty`);
    }

    if (contract.kind === "socrata") {
      if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(contract.dataset_id || "")) {
        errors.push(`${label}: invalid Socrata dataset_id`);
      }
      if (!Array.isArray(contract.required_fields) || contract.required_fields.length === 0) {
        errors.push(`${label}: required_fields must be non-empty`);
      }
      if (!(Number(contract.max_stale_days) > 0)) errors.push(`${label}: max_stale_days must be positive`);
    }
    if (["checkbook", "arcgis", "geosearch", "rss"].includes(contract.kind) && !contract.endpoint) {
      errors.push(`${label}: missing endpoint`);
    }
    if (contract.status === "disabled" && !contract.gap) errors.push(`${label}: disabled sources need a specific gap`);
  }
  return errors;
}

function contractIdentifier(contract) {
  if (contract.kind === "socrata") return contract.dataset_id;
  if (contract.kind === "checkbook") return contract.data_type;
  if (contract.kind === "arcgis") {
    return new URL(contract.endpoint).pathname.split("/arcgis/rest/services/")[1] || "";
  }
  if (contract.kind === "geosearch") return new URL(contract.endpoint).pathname.replace(/^\/+/, "");
  if (contract.kind === "html") {
    return new URL(contract.landing_page).pathname.split("/").filter(Boolean).at(-1) || "";
  }
  if (contract.kind === "mocs-disabled") return contract.legacy_dataset_ids.join("|");
  if (contract.kind === "rss") return new URL(contract.endpoint).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return "";
}

export function validateSourceContractFixtures(registry, fixtures) {
  const errors = [];
  if (fixtures?.schema_version !== 1) errors.push("source-shape fixture schema_version must be 1");
  if (!fixtures?.observed_on || !Number.isFinite(Date.parse(fixtures.observed_on))) {
    errors.push("source-shape fixtures need an observed_on date");
  }
  if (!Array.isArray(fixtures?.sources)) {
    errors.push("source-shape fixtures must contain a sources array");
    return errors;
  }

  const byId = new Map();
  for (const fixture of fixtures.sources) {
    if (!fixture?.id) {
      errors.push("source-shape fixture is missing id");
      continue;
    }
    if (byId.has(fixture.id)) errors.push(`${fixture.id}: duplicate source-shape fixture`);
    byId.set(fixture.id, fixture);
  }

  for (const contract of registry.contracts || []) {
    const fixture = byId.get(contract.id);
    if (!fixture) {
      errors.push(`${contract.id}: missing recorded source-shape fixture`);
      continue;
    }
    byId.delete(contract.id);
    if (fixture.kind !== contract.kind) {
      errors.push(`${contract.id}: fixture kind ${fixture.kind} does not match ${contract.kind}`);
    }
    if (fixture.identifier !== contractIdentifier(contract)) {
      errors.push(`${contract.id}: fixture identifier does not match the registry`);
    }

    const fields = new Set(fixture.fields || []);
    const missing = (contract.required_fields || []).filter((field) => !fields.has(field));
    if (missing.length) errors.push(`${contract.id}: fixture is missing fields ${missing.join(", ")}`);

    if (contract.kind === "socrata") {
      // "filter" is a Socrata filtered view of a dataset — still tabular JSON.
      if (!["dataset", "table", "filter"].includes(fixture.asset_type)) {
        errors.push(`${contract.id}: fixture is not tabular Socrata metadata`);
      }
      if (fixture.sample_type !== "array<object>") {
        errors.push(`${contract.id}: fixture does not record a tabular JSON sample`);
      }
    } else if (contract.kind === "checkbook" && fixture.response_type !== "xml-recordset") {
      errors.push(`${contract.id}: fixture does not record a Checkbook XML recordset`);
    } else if (contract.kind === "arcgis") {
      if (fixture.asset_type !== "Feature Layer" || fixture.sample_type !== "FeatureCollection") {
        errors.push(`${contract.id}: fixture does not record a tabular ArcGIS feature layer`);
      }
    } else if (contract.kind === "geosearch" && fixture.response_type !== "FeatureCollection") {
      errors.push(`${contract.id}: fixture does not record a GeoSearch FeatureCollection`);
    } else if (contract.kind === "html" && fixture.response_type !== "text/html") {
      errors.push(`${contract.id}: fixture does not record an HTML publication`);
    } else if (contract.kind === "rss" && fixture.response_type !== "application/rss+xml") {
      errors.push(`${contract.id}: fixture does not record an RSS feed`);
    } else if (contract.kind === "mocs-disabled") {
      if (
        fixture.configured_asset_type !== "href"
        || fixture.configured_status !== 403
        || fixture.documented_status !== 404
      ) {
        errors.push(`${contract.id}: fixture does not record the retired MOCS field case`);
      }
    }
  }

  for (const id of byId.keys()) errors.push(`${id}: source-shape fixture has no registry contract`);
  return errors;
}

function mdCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sourceRef(contract) {
  const machine = contract.dataset_id
    ? ` \`${contract.dataset_id}\``
    : contract.data_type
      ? ` \`${contract.data_type}\``
      : "";
  return `[${contract.name}](${contract.landing_page})${machine}`;
}

export function awardCoverage(registryEntries) {
  const entries = Object.entries(registryEntries);
  const abo = entries.filter(([, value]) => value.kind === "abo");
  return {
    aliases: abo.length,
    authorities: new Set(abo.map(([, value]) => value.authority)).size,
    sourcePairs: new Set(abo.map(([, value]) => `${value.dataset}:${value.authority}`)).size,
    nycha: entries.filter(([, value]) => value.kind === "checkbook-nycha").length,
    absent: entries.filter(([, value]) => value.kind === "absent").length,
    datasets: [...new Set(abo.map(([, value]) => value.dataset))].sort(),
  };
}

export function renderReadmeSourceBlock(registry, coverage) {
  const runtime = registry.contracts.filter((contract) => contract.status === "live" && contract.scope === "runtime");
  const rows = runtime.map((contract) => (
    `| ${sourceRef(contract)} | ${mdCell(contract.used_for)} | ${mdCell(contract.product_freshness)} |`
  ));
  return [
    README_BEGIN,
    "",
    "The executable registry is [`site/data/source_contracts.json`](site/data/source_contracts.json);",
    "[the generated source ledger](docs/data-sources.md) records coverage, cadence, freshness,",
    "required fields, and known gaps. Required pull-request checks validate recorded upstream",
    "shapes; a separate daily workflow runs the live verifier and reports publisher drift.",
    "",
    "| Live source | Used for | Product freshness |",
    "|---|---|---|",
    ...rows,
    "",
    `The external-award registry currently maps ${coverage.aliases} agency names to ${coverage.authorities} distinct ABO authorities across \`${coverage.datasets.join("`, `")}\`, adds ${coverage.nycha} exact NYCHA mapping, and records ${coverage.absent} verified coverage gaps. ABO joins remain possible matches rather than exact contract identity.`,
    "",
    "MOCS Local Law 63 plan rows are disabled. The current official page publishes rotating",
    "per-agency spreadsheets without a stable machine manifest; the former configured dataset is",
    "non-tabular, and the former documented dataset does not exist. CityScroll does not show",
    "official plan forecasts until a source passes the executable contract.",
    "",
    README_END,
  ].join("\n");
}

export function renderSourceDocument(registry, coverage) {
  const rows = registry.contracts.map((contract) => {
    const source = sourceRef(contract);
    const freshness = `${contract.publisher_cadence}. ${contract.product_freshness}`;
    return `| ${mdCell(contract.status)} | ${mdCell(contract.delivery_tier)} | ${source} | ${mdCell(contract.used_for)} | ${mdCell(freshness)} |`;
  });
  return [
    "<!-- Generated by tools/generate_source_docs.mjs from site/data/source_contracts.json. Do not edit by hand. -->",
    "",
    "# CityScroll source contracts",
    "",
    "This ledger names each civic-data source used by the live product or a committed build.",
    "The machine-readable registry is the source of truth. A source marked **live** must expose",
    "its contracted fields and pass its freshness limit. Manual and disabled sources are kept",
    "visible so a webpage or broken identifier cannot be mistaken for a working feed.",
    "",
    "| Status | Delivery tier | Source | Product use | Publisher and product freshness |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## External-award coverage",
    "",
    `The runtime registry maps ${coverage.aliases} City Record agency names to ${coverage.authorities} distinct Authorities Budget Office authorities (${coverage.sourcePairs} distinct dataset-and-authority pulls) across \`${coverage.datasets.join("`, `")}\`. It also contains ${coverage.nycha} exact NYCHA mapping and ${coverage.absent} explicit gaps. ABO matches are fuzzy: vendor, date, and amount can support a possible match, but do not establish exact contract identity.`,
    "",
    "## Procurement-plan gap",
    "",
    "MOCS Local Law 63 plan rows are disabled. The current official page publishes current",
    "per-agency spreadsheets, but it does not provide a stable tabular endpoint or machine",
    "manifest for those changing files. The old runtime ID (`egea-b8r5`) is a non-tabular link",
    "asset, and the old documented ID (`whpb-ebtd`) does not exist. CityScroll purges old",
    "`plan:` cache entries and excludes them from forecasts. Checkbook contract-term estimates",
    "remain available and are labeled as estimates.",
    "",
    "## Verification",
    "",
    "Run:",
    "",
    "```sh",
    "node tools/verify_source_contracts.mjs",
    "node tools/generate_source_docs.mjs --check",
    "node tools/verify_source_contracts.mjs --live",
    "```",
    "",
    "The first command validates the registry against committed source-shape fixtures without",
    "network access. Pull-request CI requires that deterministic check. A daily scheduled workflow",
    "runs the live verifier for source type, required fields, bounded sample rows, and declared",
    "freshness metadata; it opens or updates an issue when the upstream contract drifts. The live",
    "check also rechecks the two retired MOCS IDs and the official LL63 page, so a source recovery",
    "or a new machine publication becomes an explicit contract review instead of silently changing",
    "product behavior.",
    "",
  ].join("\n");
}

export function replaceReadmeSourceBlock(readme, block) {
  if (readme.includes(README_BEGIN) && readme.includes(README_END)) {
    const start = readme.indexOf(README_BEGIN);
    const end = readme.indexOf(README_END, start) + README_END.length;
    return `${readme.slice(0, start)}${block}${readme.slice(end)}`;
  }

  const heading = "## Data Sources";
  const next = "\n---";
  const start = readme.indexOf(heading);
  if (start < 0) throw new Error("README Data Sources heading not found");
  const end = readme.indexOf(next, start);
  if (end < 0) throw new Error("README Data Sources section terminator not found");
  return `${readme.slice(0, start + heading.length)}\n\n${block}\n${readme.slice(end)}`;
}

export function verifyCodeReferences(registry) {
  const errors = [];
  for (const contract of registry.contracts) {
    for (const reference of contract.code_references || []) {
      let source;
      try {
        const repositoryPath = new URL(`../${reference.path}`, import.meta.url);
        const publicTreePath = new URL(`../site/${reference.path}`, import.meta.url);
        source = readFileSync(
          existsSync(repositoryPath) ? repositoryPath : publicTreePath,
          "utf8",
        );
      } catch {
        errors.push(`${contract.id}: missing code reference ${reference.path}`);
        continue;
      }
      if (!source.includes(reference.contains)) {
        errors.push(`${contract.id}: ${reference.path} no longer contains ${JSON.stringify(reference.contains)}`);
      }
    }
  }
  return errors;
}

export function classifyMocsFieldCase(metadata, configuredResponse, documentedResponse) {
  return {
    configuredNonTabular:
      metadata?.assetType === "href"
      && Array.isArray(metadata?.columns)
      && metadata.columns.length === 0
      && configuredResponse?.status === 403
      && /non-tabular/i.test(configuredResponse?.body?.message || ""),
    documentedMissing:
      documentedResponse?.status === 404
      && documentedResponse?.body?.code === "dataset.missing",
  };
}
