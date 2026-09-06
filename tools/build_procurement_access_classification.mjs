#!/usr/bin/env node

/**
 * Access classification for the procurement pursuit decision surface
 * (card "PPD-07", research lane `access_feasibility`).
 *
 * For each solicitation field a vendor needs in order to decide whether to
 * pursue a matter, classify it `accessible`, `authenticated`, `unavailable`,
 * or `unstable` across the procurement records already committed to this
 * repository, and write the per-field, per-agency counts plus the observation
 * vintage to docs/research/procurement-access-classification/classification.json.
 *
 * The pre-registered method, its thresholds, its exclusion rules, and the
 * exact definition of each class live in
 * docs/research/procurement-access-classification/preregistration.md, whose
 * content hash is registered in site/procurement_research_lanes.json. Read
 * that first; this file implements it and nothing else.
 *
 * Hard boundaries: committed data only. No HTTP request, no browser, no
 * scraping, no credential of any kind. Nothing here reaches a network, and no
 * argument names a remote host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ACCESS_CLASSIFICATION_SCHEMA = "cityscroll.procurement_access_classification.v1";
export const ACCESS_CLASSIFICATION_RELATIVE = "docs/research/procurement-access-classification/classification.json";

/** The closed class vocabulary. A field carries exactly one of these. */
export const ACCESS_CLASSES = Object.freeze(["accessible", "authenticated", "unavailable", "unstable"]);

/**
 * Pre-registered thresholds. 30% is this repository's own existing
 * source-join usefulness threshold, reused rather than reinvented.
 */
export const ACCESS_THRESHOLDS = Object.freeze({
  min_records: 200,
  min_agencies: 10,
  min_presence_rate: 0.3,
});

const BROWSE_ROWS_RELATIVE = "site/data/procurement_browse_rows.json";
const READ_MODEL_RELATIVE = "site/data/shared_procurement_read_model.json";
const SOURCE_CONTRACTS_RELATIVE = "site/data/source_contracts.json";
const ATTACHMENT_METADATA_RELATIVE = "site/data/attachment_metadata_lookup.json";
import { readProcurementBrowsePopulation } from "./lib/procurement_browse_population_io.mjs";

function repoPath(root, relative) {
  return isAbsolute(relative) ? relative : join(root, relative);
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(repoPath(root, relative), "utf8"));
}

/** Exclusion rule 2: empty, whitespace-only, and null are all "not observed". */
function observed(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some((entry) => observed(entry));
  return String(value).trim() !== "";
}

/** Exclusion rule 1: a record with no agency label is counted, never placed. */
function agencyLabel(row) {
  for (const candidate of [row?.agency_name, row?.agency, row?.source_agency_label]) {
    const label = String(candidate ?? "").trim();
    if (label) return label;
  }
  return null;
}

/**
 * The examined fields. Each names how it is observed in committed data, which
 * committed source contracts declare it, which shipped surfaces resolve it,
 * and -- where it applies -- the committed evidence that its content sits
 * behind a publisher sign-in.
 */
const FIELD_SPECS = Object.freeze([
  {
    id: "solicitation_title",
    label: "Solicitation title",
    observe: { from: "browse_row", pick: (row) => row.short_title },
    source_contract_fields: [["city-record", "short_title"], ["passport-public-rfx", "procurement_name"], ["mta-current-opportunities", "title"]],
    product_surfaces: ["site/procurement_alert_atom.mjs"],
  },
  {
    id: "publishing_agency",
    label: "Publishing agency",
    observe: { from: "browse_row", pick: (row) => row.agency_name },
    source_contract_fields: [["city-record", "agency_name"], ["passport-public-rfx", "agency"], ["mta-current-opportunities", "agency"]],
    product_surfaces: ["site/procurement_alert_atom.mjs"],
  },
  {
    id: "solicitation_identifier",
    label: "Solicitation identifier (PIN or EPIN)",
    observe: { from: "browse_row", pick: (row) => row.pin },
    source_contract_fields: [["passport-public-rfx", "epin"], ["passport-public-contracts", "epin"]],
    product_surfaces: ["site/procurement_pursuit_snapshot.mjs"],
  },
  {
    id: "procurement_method",
    label: "Procurement method",
    observe: { from: "browse_row", pick: (row) => row.selection_method_description },
    source_contract_fields: [["passport-public-rfx", "procurement_method"]],
    product_surfaces: ["site/mwbe_goal_surface.mjs"],
  },
  {
    id: "published_amount",
    label: "Published amount",
    observe: { from: "browse_row", pick: (row) => row.contract_amount },
    source_contract_fields: [["passport-public-contracts", "current_amount"], ["checkbook-contracts", "prime_contract_current_amount"]],
    product_surfaces: ["site/procurement_alert_atom.mjs"],
    scope_note:
      "In this corpus the observed amount is an award or registration value, not a solicitation estimate. The class describes reachability of a published amount, not its stage.",
  },
  {
    id: "official_notice_pointer",
    label: "Official notice pointer",
    observe: { from: "browse_row", pick: (row) => (row.notice_evidence || []).map((entry) => entry?.href) },
    source_contract_fields: [["city-record", "request_id"]],
    product_surfaces: ["site/procurement_document.mjs", "site/procurement_facet_links.mjs"],
  },
  {
    id: "response_due_date",
    label: "Response due date",
    observe: { from: "observation", pick: (snapshot) => snapshot.due_date },
    source_contract_fields: [["passport-public-rfx", "due_date"]],
    product_surfaces: ["site/procurement_opportunity_window.mjs", "site/procurement_process_events.mjs"],
  },
  {
    id: "solicitation_release_date",
    label: "Solicitation release date",
    observe: { from: "observation", pick: (snapshot) => snapshot.release_date ?? snapshot.issue_date },
    source_contract_fields: [["passport-public-rfx", "release_date"], ["mta-current-opportunities", "opening_date"]],
    product_surfaces: ["site/procurement_opportunity_window.mjs"],
  },
  {
    id: "published_contact",
    label: "Published contact",
    observe: { from: "observation", pick: (snapshot) => snapshot.contact_name ?? snapshot.contact },
    source_contract_fields: [],
    product_surfaces: ["site/procurement_pursuit_snapshot.mjs"],
  },
  {
    id: "pre_bid_conference",
    label: "Pre-bid or pre-proposal conference",
    observe: { from: "observation", pick: (snapshot) => snapshot.pre_bid_conference },
    source_contract_fields: [],
    product_surfaces: ["site/procurement_pursuit_snapshot.mjs", "site/procurement_process_events.mjs"],
  },
  {
    id: "certification_goal_marker",
    label: "Certification goal marker",
    observe: { from: "observation", pick: (snapshot) => snapshot.mwbe_goal ?? snapshot.certification_goal },
    source_contract_fields: [],
    product_surfaces: ["site/mwbe_goal_surface.mjs"],
  },
  {
    id: "solicitation_package_documents",
    label: "Solicitation package documents",
    observe: { from: "attachment_metadata" },
    source_contract_fields: [["city-record", "document_links"]],
    product_surfaces: ["site/procurement_document.mjs"],
    per_agency_note:
      "The committed attachment metadata is keyed by notice request identifier and carries no agency label, so this field has no per-agency count. Its class does not rest on that count.",
    sign_in_system: "PASSPort",
    sign_in_evidence: [
      "site/data/source_contracts.json passport-public-rfx join_measurement: the public RFx dump carries no document-URL column (0 of 1470 modern solicitations; 0 of a 50-record kill sample).",
      "site/data/source_contracts.json city-record attachment_metadata.export_cliff: the publisher's document_links export is effectively empty from 2025 onward, and portal sampling of modern Procurement notices found no files.",
      "site/procurement_pursuit_snapshot.mjs already tells a vendor that the package requires signing in to the vendor portal.",
    ],
  },
  {
    id: "qa_content",
    label: "Question and answer content",
    observe: { from: "observation", pick: (snapshot) => snapshot.qa_content ?? snapshot.questions_and_answers ?? snapshot.qa },
    source_contract_fields: [],
    product_surfaces: ["site/procurement_pursuit_snapshot.mjs"],
    sign_in_system: "PASSPort",
    sign_in_evidence: [
      "site/procurement_pursuit_snapshot.mjs already tells a vendor that question and answer content requires signing in to the vendor portal, and lists it in the constant disclosure of what cannot be verified from public records.",
    ],
  },
  {
    id: "amendment_documents",
    label: "Amendment documents",
    observe: { from: "observation", pick: (snapshot) => snapshot.amendment_documents ?? snapshot.amendments ?? snapshot.addenda },
    source_contract_fields: [],
    product_surfaces: [],
    register_note:
      "The shipped pursuit snapshot names amendment documents in its constant disclosure of what cannot be verified. Naming a known unknown is not the same as resolving a field: no committed source contract declares one and no committed observation carries one.",
  },
  {
    id: "published_bid_results",
    label: "Published bid results",
    observe: { from: "observation", pick: (snapshot) => snapshot.opening_date, only_sources: ["mta_bid_results"] },
    source_contract_fields: [["bid-tabulations-historical", "bid_opening_date"], ["mta-bid-results", "opening_date"]],
    product_surfaces: [],
    coverage_note:
      "site/data/source_contracts.json bid-tabulations-historical is disabled for product reads: strict joins reach 9.07% of the historical overlap window and 0% of records since 2025, both below this repository's 30% usefulness threshold.",
  },
]);

function verifyDeclarations(spec, contractsById) {
  const declared = [];
  for (const [contractId, field] of spec.source_contract_fields || []) {
    const contract = contractsById.get(contractId);
    if (!contract) continue;
    const required = Array.isArray(contract.required_fields) ? contract.required_fields : [];
    declared.push({
      contract_id: contractId,
      field,
      status: contract.status || null,
      in_required_fields: required.includes(field),
    });
  }
  return declared;
}

function classify(spec, sample, declarations) {
  if ((spec.sign_in_evidence || []).length) {
    return {
      class: "authenticated",
      reason: "A committed measurement or the shipped product's own disclosure records that this field's content is reachable only after signing in to the publisher's system.",
    };
  }
  const declared = declarations.length > 0 || (spec.product_surfaces || []).length > 0;
  if (!declared && sample.records_observed === 0) {
    return {
      class: "unavailable",
      reason: "No committed source contract declares this field and no committed observation carries it. This states what the public sources this repository observes carry; it is not a claim that a publisher withholds the field.",
    };
  }
  const meetsRecords = sample.records_observed >= ACCESS_THRESHOLDS.min_records;
  const meetsAgencies = sample.agencies_observed >= ACCESS_THRESHOLDS.min_agencies;
  const meetsRate = sample.presence_rate >= ACCESS_THRESHOLDS.min_presence_rate;
  if (meetsRecords && meetsAgencies && meetsRate) {
    return {
      class: "accessible",
      reason: `Observed on ${sample.records_observed} committed records across ${sample.agencies_observed} agencies, a presence rate of ${sample.presence_rate.toFixed(3)} within the ${sample.records_examined} records examined.`,
    };
  }
  const shortfalls = [];
  const plural = (count, noun) => count === 1 ? `${count} ${noun}` : `${count} ${noun === "agency" ? "agencies" : `${noun}s`}`;
  if (!meetsRecords) shortfalls.push(`${plural(sample.records_observed, "observed record")} is below the ${ACCESS_THRESHOLDS.min_records}-record threshold`);
  if (!meetsAgencies) shortfalls.push(`${plural(sample.agencies_observed, "agency")} is below the ${ACCESS_THRESHOLDS.min_agencies}-agency threshold`);
  if (!meetsRate) shortfalls.push(`a presence rate of ${sample.presence_rate.toFixed(3)} is below ${ACCESS_THRESHOLDS.min_presence_rate}`);
  return {
    class: "unstable",
    reason: `The committed record cannot tell: ${shortfalls.join("; ")}. This says the sample is too thin to classify, not that the field is absent from the publisher.`,
  };
}

function countBrowseField(rows, pick) {
  const perAgency = new Map();
  let recordsObserved = 0;
  for (const row of rows) {
    if (!observed(pick(row))) continue;
    recordsObserved += 1;
    const agency = agencyLabel(row);
    if (!agency) continue;
    perAgency.set(agency, (perAgency.get(agency) || 0) + 1);
  }
  return { recordsObserved, perAgency };
}

function countObservationField(observations, spec) {
  const perAgency = new Map();
  let recordsObserved = 0;
  for (const observation of observations) {
    if (spec.observe.only_sources && !spec.observe.only_sources.includes(observation.source_system)) continue;
    const snapshot = observation.snapshot || {};
    if (!observed(spec.observe.pick(snapshot))) continue;
    recordsObserved += 1;
    const agency = agencyLabel(snapshot);
    if (!agency) continue;
    perAgency.set(agency, (perAgency.get(agency) || 0) + 1);
  }
  return { recordsObserved, perAgency };
}

function sortedObject(map) {
  const out = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key);
  return out;
}

export function buildAccessClassification({ root = ROOT } = {}) {
  const browse = readProcurementBrowsePopulation(repoPath(root, BROWSE_ROWS_RELATIVE));
  const readModel = readJson(root, READ_MODEL_RELATIVE);
  const contracts = readJson(root, SOURCE_CONTRACTS_RELATIVE);
  const attachments = readJson(root, ATTACHMENT_METADATA_RELATIVE);

  const rows = Array.isArray(browse.rows) ? browse.rows : [];
  const contractsById = new Map((contracts.contracts || []).map((entry) => [entry.id, entry]));

  const observations = [];
  for (const shard of readModel.shards || []) {
    const relative = join("site/data", shard.path);
    if (!existsSync(repoPath(root, relative))) continue;
    const parsed = readJson(root, relative);
    for (const observation of parsed.observations || []) observations.push(observation);
  }

  const corpusAgencies = new Set();
  for (const row of rows) {
    const agency = agencyLabel(row);
    if (agency) corpusAgencies.add(agency);
  }

  const attachmentNotices = Object.keys(attachments.notices || {});

  const fields = FIELD_SPECS.map((spec) => {
    let recordsExamined = 0;
    let counted = { recordsObserved: 0, perAgency: new Map() };
    let universe = "";
    if (spec.observe.from === "browse_row") {
      recordsExamined = rows.length;
      counted = countBrowseField(rows, spec.observe.pick);
      universe = `${BROWSE_ROWS_RELATIVE} (committed procurement browse projection)`;
    } else if (spec.observe.from === "observation") {
      const pool = spec.observe.only_sources
        ? observations.filter((observation) => spec.observe.only_sources.includes(observation.source_system))
        : observations;
      recordsExamined = pool.length;
      counted = countObservationField(observations, spec);
      universe = spec.observe.only_sources
        ? `${READ_MODEL_RELATIVE} shards, source systems ${spec.observe.only_sources.join(", ")}`
        : `${READ_MODEL_RELATIVE} shards (all committed source observations)`;
    } else if (spec.observe.from === "attachment_metadata") {
      recordsExamined = rows.length;
      counted = { recordsObserved: attachmentNotices.length, perAgency: new Map() };
      universe = `${ATTACHMENT_METADATA_RELATIVE} (committed attachment metadata), against the ${BROWSE_ROWS_RELATIVE} record universe`;
    } else {
      recordsExamined = rows.length;
      universe = `${BROWSE_ROWS_RELATIVE} (committed procurement browse projection); no committed source carries this field`;
    }

    const sample = {
      universe,
      records_examined: recordsExamined,
      records_observed: counted.recordsObserved,
      agencies_observed: counted.perAgency.size,
      presence_rate: recordsExamined > 0 ? counted.recordsObserved / recordsExamined : 0,
    };
    const declarations = verifyDeclarations(spec, contractsById);
    const verdict = classify(spec, sample, declarations);

    return {
      id: spec.id,
      label: spec.label,
      class: verdict.class,
      basis: verdict.reason,
      sample,
      per_agency: sortedObject(counted.perAgency),
      declared_by: {
        source_contracts: declarations,
        product_surfaces: spec.product_surfaces || [],
      },
      sign_in_evidence: spec.sign_in_evidence || [],
      ...(spec.sign_in_system ? { sign_in_system: spec.sign_in_system } : {}),
      ...(spec.scope_note ? { scope_note: spec.scope_note } : {}),
      ...(spec.register_note ? { register_note: spec.register_note } : {}),
      ...(spec.coverage_note ? { coverage_note: spec.coverage_note } : {}),
      ...(spec.per_agency_note ? { per_agency_note: spec.per_agency_note } : {}),
    };
  });

  const byClass = Object.fromEntries(ACCESS_CLASSES.map((name) => [name, 0]));
  for (const field of fields) byClass[field.class] += 1;

  return {
    schema: ACCESS_CLASSIFICATION_SCHEMA,
    card: "PPD-07",
    lane: "access_feasibility",
    preregistration: "docs/research/procurement-access-classification/preregistration.md",
    generated_by: "node tools/build_procurement_access_classification.mjs --write",
    method_note:
      "Committed data only. No live retrieval, no scraping, and no credential automation of any kind is part of this lane. A field the committed corpus cannot answer for is classed unstable with the shortfall stated, rather than resolved by reaching for a network.",
    observation_vintage: {
      browse_projection_generated_at: browse.generated_at || null,
      read_model_generated_at: readModel.generated_at || null,
      source_contracts_document: contracts.generated_document || null,
      attachment_metadata_built_at: attachments.built_at || null,
    },
    corpus: {
      records: rows.length,
      agencies: corpusAgencies.size,
      source_observations: observations.length,
      inputs: [BROWSE_ROWS_RELATIVE, READ_MODEL_RELATIVE, SOURCE_CONTRACTS_RELATIVE, ATTACHMENT_METADATA_RELATIVE],
    },
    classes: ACCESS_CLASSES,
    thresholds: ACCESS_THRESHOLDS,
    fields,
    summary: {
      fields_total: fields.length,
      by_class: byClass,
    },
  };
}

const KNOWN_BOOLEAN_FLAGS = Object.freeze(["--check", "--write"]);
const KNOWN_VALUE_FLAGS = Object.freeze(["--root", "--out"]);
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parseAccessClassificationArgv(argv = []) {
  const parsed = { check: false, write: false, root: null, out: null, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (URL_SHAPED.test(argument)) {
      parsed.errors.push(`This tool takes no URL argument; refused: ${argument}`);
      continue;
    }
    if (KNOWN_BOOLEAN_FLAGS.includes(argument)) {
      parsed[argument.slice(2)] = true;
      continue;
    }
    if (KNOWN_VALUE_FLAGS.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        parsed.errors.push(`${argument} requires a value.`);
        continue;
      }
      index += 1;
      if (URL_SHAPED.test(String(value))) {
        parsed.errors.push(`This tool takes no URL argument; refused: ${value}`);
        continue;
      }
      parsed[argument.slice(2)] = String(value);
      continue;
    }
    parsed.errors.push(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseAccessClassificationArgv(argv);
  if (parsed.errors.length) {
    for (const error of parsed.errors) console.error(error);
    return 2;
  }
  const root = resolve(parsed.root || ROOT);
  const out = parsed.out || ACCESS_CLASSIFICATION_RELATIVE;
  const built = buildAccessClassification({ root });
  const serialized = `${JSON.stringify(built, null, 2)}\n`;

  if (parsed.check) {
    const target = repoPath(root, out);
    if (!existsSync(target)) {
      console.error(`Missing classification file: ${out}`);
      return 1;
    }
    if (readFileSync(target, "utf8") !== serialized) {
      console.error(`${out} is out of date. Regenerate with: node tools/build_procurement_access_classification.mjs --write`);
      return 1;
    }
    console.log(`${out} matches the committed data it is derived from.`);
    return 0;
  }

  if (parsed.write) {
    writeFileSync(repoPath(root, out), serialized);
    console.log(`Wrote ${out}: ${built.fields.length} field(s), ${JSON.stringify(built.summary.by_class)}`);
    return 0;
  }

  console.log(serialized);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
