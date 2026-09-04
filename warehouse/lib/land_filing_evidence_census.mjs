/**
 * LDP-22: host-side census of ZAP filing-document coverage and the observable
 * RER-applicability surface.
 *
 * Pure functions only -- everything here consumes already-fetched SODA/ZAP-API
 * responses (assembled by tools/build_land_filing_evidence_census.mjs, which
 * owns all network I/O) and produces classification, manifest, and receipt
 * structures. No function in this file performs a network request, so it is
 * fully testable against bounded fixtures.
 *
 * This card measures. It does not register the filing ontology (LDP-23), does
 * not build the document collector/parser (LDP-24), does not extract RER
 * fields (LDP-25), and does not change resident UI/API/MCP (LDP-27). Every
 * measure that depends on unbuilt machinery, or on a publisher field this
 * census did not find, is reported `unknown`/`not_applicable` with a named
 * reason -- never as zero or an estimate.
 */

export const LAND_FILING_CENSUS_RECEIPT_SCHEMA = "cityscroll.land_filing_evidence_census.v1";
export const LAND_FILING_CENSUS_OBSERVATION_SCHEMA = "cityscroll.land_filing_evidence_census_observation.v1";

const UNKNOWN = "unknown";
const NOT_APPLICABLE = "not_applicable";

function typedUnknown(reason) {
  return { status: UNKNOWN, value: null, reason };
}

function typedNotApplicable(reason) {
  return { status: NOT_APPLICABLE, value: null, reason };
}

function typedMeasured(value, extra = {}) {
  return { status: "measured", value, ...extra };
}

/**
 * Action codes DCP's RER criteria chart names as ones the requirement can
 * ever attach to. Membership only bounds the census sampling frame -- it is
 * never an applicability inference. See DCP_RER_CRITERIA_SOURCE below.
 */
export const RER_CRITERIA_ACTION_CODES = Object.freeze([
  "ZM", "ZR", "ZS", "RS", "HA", "PC", "PQ", "HU", "HD", "MM", "ML", "PP", "HK",
]);

export const DCP_RER_CRITERIA_SOURCE = Object.freeze({
  title: "DCP Criteria Applicability Chart for Racial Equity Report on Housing and Opportunity submission",
  url: "https://www.nyc.gov/assets/planning/downloads/pdf/applicants/preparing-application/rer-criteria.pdf",
  names_governing_law: "Local Law 78 of 2021",
});

export const ADMIN_CODE_25_118_SOURCE = Object.freeze({
  title: "NYC Administrative Code section 25-118",
  url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-133761",
});

/**
 * Title-token vocabulary used to classify ZAP `artifacts` groups. ZAP's API
 * carries no explicit artifact-type enum (`dcp-packagetype` is observed null
 * on every sampled artifact) -- classification here is tier-2
 * ("strong normalized title plus internal document markers") at best, never
 * tier-1 ("explicit publisher type"), per the ontology's classification
 * order. A loose filename token nominates a candidate; it does not establish
 * public RER classification.
 */
export const ARTIFACT_TITLE_TOKENS = Object.freeze([
  { document_type: "racial_equity_report", pattern: /racial\s*equity\s*report/i },
  { document_type: "notice_of_receipt", pattern: /notice\s*of\s*receipt/i },
  { document_type: "notice_of_certification_or_referral", pattern: /notice\s*of\s*(certification|referral)/i },
  { document_type: "qualified_action_determination", pattern: /qualified\s*action\s*determination/i },
  { document_type: "cpc_presentation", pattern: /cpc\s*presentation/i },
  { document_type: "docket", pattern: /docket/i },
  { document_type: "type_ii_memo", pattern: /type\s*ii\s*memo/i },
]);

export function normalizeDocumentName(name) {
  return String(name || "").trim().toLocaleLowerCase();
}

/**
 * Classify one ZAP `included` relationship item's group title.
 * `relationshipType` is the JSON:API `type` ("artifacts" | "packages").
 */
export function classifyZapArtifactGroup({ relationshipType, groupTitle, packageTypeRaw }) {
  if (relationshipType === "packages") {
    // Every sampled `packages` item names itself "<project>_Filed LU Package_<n>"
    // and carries a `dcp-packagetype` option-set code; the option-set label
    // lookup is not documented anywhere this census reached, so the code is
    // retained verbatim rather than translated.
    return {
      document_type: "filed_land_use_package",
      method: "explicit_publisher_relationship_type",
      confidence: "high",
      matched_token: null,
      evidence: { relationship_type: "packages", package_type_raw: packageTypeRaw ?? null },
    };
  }
  const title = String(groupTitle || "");
  for (const { document_type, pattern } of ARTIFACT_TITLE_TOKENS) {
    if (pattern.test(title)) {
      return {
        document_type,
        method: "title_token_strong",
        confidence: "medium",
        matched_token: pattern.source,
        evidence: { relationship_type: "artifacts", group_title: title },
      };
    }
  }
  return {
    document_type: "unknown",
    method: "no_match",
    confidence: "low",
    matched_token: null,
    evidence: { relationship_type: "artifacts", group_title: title },
  };
}

/**
 * Extract the complete (untruncated) document manifest from one ZAP API
 * project JSON:API payload. Unlike worker/src/lib/zap_outcomes.mjs, this
 * never truncates to 40 and never dedupes by name alone -- it exists to
 * measure what that production parser currently loses, not to replace it.
 */
export function extractZapFilingManifest(payload, { projectId, buildDocumentUrl } = {}) {
  const warnings = [];
  const data = payload?.data;
  if (!data || data.type !== "projects") {
    return {
      project_id: projectId || null,
      ok: false,
      warnings: ["payload missing data.type === 'projects'"],
      dcp_applicability_raw: null,
      documents: [],
      groups: [],
      n_documents: 0,
    };
  }
  const attrs = data.attributes || {};
  const included = Array.isArray(payload.included) ? payload.included : [];
  const documents = [];
  const groups = [];
  for (const item of included) {
    const type = item?.type;
    if (type !== "artifacts" && type !== "packages") continue;
    const a = item?.attributes || {};
    const groupTitle = a["dcp-name"] ?? null;
    const groupId = type === "artifacts" ? (a["dcp-artifactsid"] ?? item.id ?? null) : (a["dcp-packageid"] ?? item.id ?? null);
    if (!groupId) warnings.push(`${type} item missing group id (title=${JSON.stringify(groupTitle)})`);
    const classification = classifyZapArtifactGroup({
      relationshipType: type,
      groupTitle,
      packageTypeRaw: a["dcp-packagetype"] ?? null,
    });
    const docsRaw = Array.isArray(a.documents) ? a.documents : [];
    if (!docsRaw.length) warnings.push(`${type} group ${groupId || "(no id)"} carries no documents[] entries`);
    for (const doc of docsRaw) {
      const sourceId = doc?.serverRelativeUrl ? String(doc.serverRelativeUrl).replace(/^\/+/, "") : null;
      if (!sourceId) warnings.push(`document under group ${groupId || "(no id)"} missing serverRelativeUrl`);
      if (!doc?.name) warnings.push(`document under group ${groupId || "(no id)"} missing name`);
      documents.push({
        name: doc?.name ?? null,
        normalized_name: normalizeDocumentName(doc?.name),
        source_id: sourceId,
        group_kind: type,
        group_id: groupId || null,
        group_title: groupTitle,
        classification,
        time_created: doc?.timeCreated ?? null,
        proxy_url: sourceId && typeof buildDocumentUrl === "function"
          ? buildDocumentUrl(type === "artifacts" ? "artifact" : "package", sourceId)
          : null,
      });
    }
    groups.push({
      group_kind: type,
      group_id: groupId || null,
      group_title: groupTitle,
      classification,
      document_count: docsRaw.length,
      package_version: type === "packages" ? (Number.isFinite(Number(a["dcp-packageversion"])) ? Number(a["dcp-packageversion"]) : null) : null,
      package_submission_date: type === "packages" ? (a["dcp-packagesubmissiondate"] ?? null) : null,
    });
  }
  return {
    project_id: projectId || attrs["dcp-name"] || null,
    ok: true,
    warnings,
    // Retained verbatim -- observed to be "Yes" on both a project carrying an
    // RER artifact and one that plainly does not, so this census does not
    // treat it as an RER-applicability signal. See applicability section of
    // the receipt for the full evidentiary finding.
    dcp_applicability_raw: attrs["dcp-applicability"] ?? null,
    public_status: attrs["dcp-publicstatus"] ?? null,
    documents,
    groups,
    n_documents: documents.length,
  };
}

/** Group a manifest's documents by normalized name. */
function groupDocumentsByName(documents) {
  const byName = new Map();
  for (const doc of documents) {
    const key = doc.normalized_name || ` :${doc.source_id}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(doc);
  }
  return byName;
}

/**
 * Same-name/different-source-id rate: structural only (no bytes needed).
 * Denominator is distinct document names observed across the sample.
 */
export function computeSameNameDifferentIdStats(documents) {
  const byName = groupDocumentsByName(documents);
  let groupsWithMultipleIds = 0;
  const examples = [];
  for (const [name, docs] of byName) {
    const distinctIds = new Set(docs.map((d) => d.source_id).filter(Boolean));
    if (distinctIds.size > 1) {
      groupsWithMultipleIds += 1;
      if (examples.length < 10) examples.push({ name, distinct_source_ids: [...distinctIds] });
    }
  }
  const denominator = byName.size;
  return {
    denominator_distinct_names: denominator,
    numerator_names_with_multiple_ids: groupsWithMultipleIds,
    rate: denominator ? groupsWithMultipleIds / denominator : null,
    examples,
  };
}

/**
 * Same-name/different-hash rate: only computable over documents that carry a
 * `bytes_sha256` (the bounded deep-dive subset that actually fetched bytes).
 */
export function computeSameNameDifferentHashStats(documentsWithHash) {
  const withHash = documentsWithHash.filter((d) => d.bytes_sha256);
  const byName = groupDocumentsByName(withHash);
  let groupsCompared = 0;
  let groupsWithDifferentHash = 0;
  let groupsWithIdenticalHashDuplicate = 0;
  const examples = [];
  for (const [name, docs] of byName) {
    if (docs.length < 2) continue;
    groupsCompared += 1;
    const distinctHashes = new Set(docs.map((d) => d.bytes_sha256));
    if (distinctHashes.size > 1) {
      groupsWithDifferentHash += 1;
      if (examples.length < 10) examples.push({ name, distinct_hashes: [...distinctHashes] });
    } else {
      groupsWithIdenticalHashDuplicate += 1;
    }
  }
  return {
    denominator_names_with_multiple_hashed_docs: groupsCompared,
    numerator_names_with_different_hash: groupsWithDifferentHash,
    numerator_names_with_identical_hash_duplicate: groupsWithIdenticalHashDuplicate,
    rate: groupsCompared ? groupsWithDifferentHash / groupsCompared : null,
    examples,
  };
}

export function percentiles(values, ps) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return Object.fromEntries(ps.map((p) => [p, null]));
  const pick = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  return Object.fromEntries(ps.map((p) => [p, pick(p)]));
}

/**
 * Scan a set of already-classified manifests for an explicit publisher
 * "not timely filed" / "tardy" / "missing report" assertion. No structured
 * field or title token corresponding to this state was found anywhere in
 * this census's sample -- this function exists so that finding is asserted
 * mechanically (by a test), not just narrated in prose.
 */
const TARDY_TOKEN = /not\s*timely\s*filed|tardy|missing\s*report|report\s*not\s*(submitted|filed|received)/i;
export function scanForPublisherTardyAssertion(manifests) {
  const hits = [];
  for (const manifest of manifests) {
    const haystack = [manifest.dcp_applicability_raw, manifest.public_status, ...manifest.groups.map((g) => g.group_title)]
      .filter(Boolean)
      .join(" | ");
    if (TARDY_TOKEN.test(haystack)) hits.push({ project_id: manifest.project_id, haystack });
  }
  return hits;
}

/** RER-artifact-group observation bucketing, independent of any applicability field (none exists). */
export function bucketRerObservationCounts(manifests) {
  let zero = 0;
  let one = 0;
  let multiple = 0;
  for (const manifest of manifests) {
    const n = manifest.groups.filter((g) => g.classification.document_type === "racial_equity_report").length;
    if (n === 0) zero += 1;
    else if (n === 1) one += 1;
    else multiple += 1;
  }
  return { zero_rer_groups: zero, one_rer_group: one, multiple_rer_groups: multiple, sample_size: manifests.length };
}

function countBy(manifests, groupType) {
  let withGroup = 0;
  for (const manifest of manifests) {
    if (manifest.groups.some((g) => g.classification.document_type === groupType)) withGroup += 1;
  }
  return withGroup;
}

/**
 * Assemble the full LDP-22 census receipt from a retained observation
 * (produced once by `tools/build_land_filing_evidence_census.mjs --refresh`).
 * Deterministic: the same observation always yields byte-identical output
 * apart from nothing (generated_at is carried through from the observation,
 * never re-stamped here).
 */
export function buildLandFilingEvidenceCensusReceipt(observation) {
  const soda = observation.soda || {};
  const statute = observation.statute_sources || {};
  const sampleObs = observation.sample || {};
  const manifests = sampleObs.manifests || [];
  const deepDiveDocs = (observation.deep_dive?.documents) || [];
  const specimens = observation.specimen_nominations || {};

  const allSampleDocuments = manifests.flatMap((m) => m.documents);
  const documentCounts = manifests.map((m) => m.n_documents);
  const zapFetches = sampleObs.zap_api_fetches || [];
  const zapFetchSuccesses = zapFetches.filter((f) => f.http_status === 200).length;

  const sameNameId = computeSameNameDifferentIdStats(allSampleDocuments);
  const sameNameHash = computeSameNameDifferentHashStats(deepDiveDocs);
  const tardyHits = scanForPublisherTardyAssertion(manifests);
  const rerBuckets = bucketRerObservationCounts(manifests);
  const over40 = manifests.filter((m) => m.n_documents > 40).map((m) => ({ project_id: m.project_id, n_documents: m.n_documents }));

  const packageVersionCounts = manifests.map((m) => {
    const versions = m.groups.filter((g) => g.group_kind === "packages").map((g) => g.package_version).filter((v) => Number.isFinite(v));
    return versions.length ? Math.max(...versions) : 0;
  });

  const scannedDeepDive = deepDiveDocs.filter((d) => Number.isFinite(d.extracted_text_bytes) && Number.isFinite(d.pages) && d.pages > 0);
  const scannedCount = scannedDeepDive.filter((d) => (d.extracted_text_bytes / d.pages) < 40).length;

  const rerClassificationPaths = {};
  for (const m of manifests) {
    for (const g of m.groups) {
      if (g.classification.document_type !== "racial_equity_report") continue;
      const key = g.classification.method;
      rerClassificationPaths[key] = (rerClassificationPaths[key] || 0) + 1;
    }
  }

  const receipt = {
    schema: LAND_FILING_CENSUS_RECEIPT_SCHEMA,
    card: "cityscroll-land-decision-path/ldp-22-filing-evidence-census",
    generated_at: observation.materialized_at,

    source_receipt: {
      soda: {
        dataset_id: "hgx4-8ukb",
        domain: "data.cityofnewyork.us",
        dataset_metadata: soda.dataset_metadata || null,
        request_shape: "bounded SoQL aggregate queries (count/group/min-max) plus one bounded 2000-row sample-frame projection; never a full-table row export",
        response_schema: "Socrata SODA2 JSON (array of row objects for aggregates; JSON:API-unrelated)",
        pagination: {
          method: "$limit/$group, no $offset paging used",
          complete: Boolean(soda.year_breakdown?.pagination_complete)
            && Boolean(soda.borough_breakdown?.pagination_complete)
            && Boolean(soda.actions_raw_breakdown?.pagination_complete)
            && Boolean(sampleObs.frame?.pagination_complete),
          note: "Aggregate group-by queries are complete when returned rows < $limit; the sample-frame row projection is bounded and explicitly not a population census by itself.",
        },
        rate_behavior: soda.rate_behavior || null,
        collection_interval: { started_at: observation.collection_started_at, ended_at: observation.collection_ended_at },
        raw_response_hashes: [
          soda.dataset_metadata_fetch,
          soda.total_count?.fetch,
          soda.year_breakdown?.fetch,
          soda.borough_breakdown?.fetch,
          soda.project_status_breakdown?.fetch,
          soda.public_status_breakdown?.fetch,
          soda.ulurp_non_breakdown?.fetch,
          soda.actions_raw_breakdown?.fetch,
          soda.date_range?.fetch,
          soda.operative_period_proxy_count?.fetch,
          sampleObs.frame?.fetch,
        ].filter(Boolean).map((f) => ({ fetch_id: f.fetch_id, url: f.request_url_or_query, content_hash: f.content_hash, byte_count: f.byte_count, retrieved_at: f.retrieved_at, http_status: f.http_status })),
      },
      zap_api: {
        base: "https://zap-api-production.herokuapp.com",
        request_shape: "GET /projects/{project_id} per sampled project id -- no documented bulk-listing endpoint exists (probed and confirmed to error on both /projects and /projects?filter[...])",
        response_schema: "JSON:API document; data.type === 'projects', included[] carries actions|milestones|dispositions|packages|artifacts",
        included_types_observed: [...new Set(zapFetches.flatMap((f) => f.included_types || []))].sort(),
        pagination: { method: "none (single-resource fetch per project)", complete: true, note: "Not a listing endpoint; completeness is per-project, not per-page." },
        rate_behavior: sampleObs.rate_behavior || null,
        retrieval_status: { attempted: zapFetches.length, http_200: zapFetchSuccesses, non_200_or_error: zapFetches.length - zapFetchSuccesses },
        collection_interval: { started_at: sampleObs.collection_started_at, ended_at: sampleObs.collection_ended_at },
        raw_response_hashes: zapFetches.map((f) => ({ project_id: f.project_id, content_hash: f.content_hash, byte_count: f.byte_count, http_status: f.http_status, retrieved_at: f.retrieved_at, latency_ms: f.latency_ms })),
      },
      document_bytes: {
        request_shape: `GET /document/{artifact|package}/{source_id} for a bounded deep-dive subset of ${deepDiveDocs.length} documents (never the full sample)`,
        raw_response_hashes: deepDiveDocs.map((d) => ({ project_id: d.project_id, source_id: d.source_id, content_hash: d.bytes_sha256 ? `sha256:${d.bytes_sha256}` : null, byte_length: d.byte_length, http_status: d.http_status, content_type: d.content_type })),
      },
      governing_source_access: {
        admin_code_25_118: statute.admin_code_25_118 || null,
        dcp_rer_criteria_pdf: statute.dcp_rer_criteria_pdf || null,
      },
      parser_version: "land_filing_evidence_census.v1",
    },

    population: {
      total_discoverable_projects: soda.total_count
        ? typedMeasured(soda.total_count.value, { source_vintage: soda.dataset_metadata?.rows_updated_at ?? null, method: "SoQL count(*) over hgx4-8ukb" })
        : typedUnknown("SODA total-count query did not run or failed"),
      operative_period_projects: soda.operative_period_proxy_count
        ? typedMeasured(soda.operative_period_proxy_count.value, {
            denominator: soda.total_count?.value ?? null,
            method: "proxy_superset: count(*) WHERE app_filed_date >= '2021-01-01' (year Local Law 78 of 2021 was enacted)",
            exact_statutory_boundary: "unknown",
            exact_statutory_boundary_reason: "NYC Administrative Code section 25-118 primary text is behind a Cloudflare bot challenge (HTTP 403) from this host; DCP's RER criteria PDF names the governing law (Local Law 78 of 2021) but does not itself state an effective date. This proxy is a documented superset, not the exact operative-period denominator.",
          })
        : typedUnknown("operative-period proxy query did not run or failed"),
      strata: {
        by_year: soda.year_breakdown ? typedMeasured(soda.year_breakdown.rows, { field: "app_filed_date", complete: soda.year_breakdown.pagination_complete }) : typedUnknown("year breakdown query failed"),
        by_borough: soda.borough_breakdown ? typedMeasured(soda.borough_breakdown.rows, { field: "borough", complete: soda.borough_breakdown.pagination_complete }) : typedUnknown("borough breakdown query failed"),
        by_project_status: soda.project_status_breakdown ? typedMeasured(soda.project_status_breakdown.rows, { field: "project_status", complete: soda.project_status_breakdown.pagination_complete }) : typedUnknown("status breakdown query failed"),
        by_public_status: soda.public_status_breakdown ? typedMeasured(soda.public_status_breakdown.rows, { field: "public_status", complete: soda.public_status_breakdown.pagination_complete }) : typedUnknown("status breakdown query failed"),
        by_action_raw_value: soda.actions_raw_breakdown
          ? typedMeasured(soda.actions_raw_breakdown.rows, {
              field: "actions",
              complete: soda.actions_raw_breakdown.pagination_complete,
              method: "raw delimited field-value grouping -- NOT decomposed into individual per-code counts (SoQL has no array-split aggregate over this text field)",
            })
          : typedUnknown("action breakdown query failed"),
      },
      source_freshness: soda.dataset_metadata
        ? typedMeasured({ rows_updated_at: soda.dataset_metadata.rows_updated_at, metadata_updated_at: soda.dataset_metadata.metadata_updated_at }, { measured_at: observation.materialized_at })
        : typedUnknown("dataset metadata fetch failed"),
      source_failure_rate: typedMeasured(
        {
          soda_queries_attempted: (observation.soda_fetch_attempts ?? null),
          soda_queries_failed: (observation.soda_fetch_failures ?? null),
          statute_fetches_attempted: (statute.attempts ?? null),
          statute_fetches_failed: (statute.failures ?? null),
        },
        { note: "See source_receipt.governing_source_access for the specific failed statute fetches (amlegal.com Cloudflare challenge)." },
      ),
    },

    sample: {
      frame_definition: sampleObs.frame?.definition || null,
      frame_size: sampleObs.frame?.rows?.length ?? null,
      frame_pagination_complete: sampleObs.frame?.pagination_complete ?? null,
      sampling_method: sampleObs.sampling_method || null,
      sample_size: manifests.length,
      pinned_specimens: sampleObs.pinned || [],
      fetch_success_rate: zapFetches.length
        ? typedMeasured(zapFetchSuccesses / zapFetches.length, { numerator: zapFetchSuccesses, denominator: zapFetches.length })
        : typedUnknown("no ZAP API detail fetches were attempted"),
    },

    applicability: {
      publisher_field_search: {
        fields_checked: [
          "data.attributes.dcp-applicability",
          "included[].attributes (actions, milestones, dispositions, packages, artifacts) -- all keys",
        ],
        finding: "No field in the ZAP API JSON:API response is RER-specific. `dcp-applicability` was observed literally 'Yes' on both a project carrying an RER artifact group (2025Q0247) and one that has published no RER artifact at all (2026K0123), so it does not encode RER applicability. No milestone, action, disposition, or package field names Racial Equity or RER.",
        only_observed_signal: "A title-token match on an artifact group's `dcp-name` (e.g. containing 'Racial Equity Report') -- a document-observation signal, not a publisher applicability assertion.",
        portal_ui_verification: "Not completed: the public ZAP portal (zap.planning.nyc.gov) is a client-rendered SPA; its initial HTML carries no data, and browser automation in this environment failed to load it. Whether the rendered page's 'Racial Equity Report Required' label is backed by a field this census could not find, or is itself derived only from RER-document presence, is unresolved and named here as an explicit unknown.",
      },
      required: typedNotApplicable("No publisher applicability field exists to derive this state from; see publisher_field_search."),
      not_required: typedNotApplicable("No publisher applicability field exists to derive this state from; see publisher_field_search."),
      unknown: typedMeasured(manifests.length, { reason: "Every sampled project's applicability state is unknown under the five-state contract, because no publisher assertion field was found." }),
      conflicting: typedMeasured(0, { reason: "No conflicting publisher assertions are possible when no publisher assertion field exists." }),
      rer_document_observation_buckets: typedMeasured(rerBuckets, { note: "Bucketed by observed RER-titled artifact group count, independent of any applicability state (none derivable)." }),
    },

    fulfillment: {
      required_projects_with_one_observed_rer: typedNotApplicable("Depends on an applicability='required' state this census could not derive; see applicability section."),
      required_projects_with_multiple_observed_rer: typedNotApplicable("Depends on an applicability='required' state this census could not derive; see applicability section."),
      required_projects_with_no_observed_rer: typedNotApplicable("Depends on an applicability='required' state this census could not derive; see applicability section."),
      publisher_missing_or_tardy_assertions: typedMeasured(tardyHits.length, {
        denominator: manifests.length,
        method: "regex scan for tardy/missing/not-timely-filed tokens across dcp-applicability, public_status, and every artifact/package group title in the sample",
        hits: tardyHits,
        note: tardyHits.length === 0 ? "No publisher field or title token corresponding to a missing/tardy RER assertion was found anywhere in the sample." : undefined,
      }),
    },

    rer_classification_paths: typedMeasured(rerClassificationPaths, {
      note: "Every observed RER classification in this sample used method 'title_token_strong' (tier 2 of the ontology's classification order). No tier-1 (explicit publisher type) RER signal exists.",
    }),

    document_counts: manifests.length
      ? typedMeasured(percentiles(documentCounts, [50, 75, 90, 95, 99, 100]), {
          denominator: manifests.length,
          method: "untruncated artifact+package document count per sampled project (not the production parser's 40-document cutoff)",
          max_observed: Math.max(...documentCounts),
        })
      : typedUnknown("sample was empty"),

    projects_exceeding_40_documents: typedMeasured(over40.length, { denominator: manifests.length, projects: over40 }),

    same_name_different_id_rate: typedMeasured(sameNameId.rate, {
      numerator: sameNameId.numerator_names_with_multiple_ids,
      denominator: sameNameId.denominator_distinct_names,
      method: "structural: grouped sample documents by normalized name, counted names spanning >1 distinct source id (serverRelativeUrl)",
      examples: sameNameId.examples,
    }),

    same_name_different_hash_rate: deepDiveDocs.length
      ? typedMeasured(sameNameHash.rate, {
          numerator: sameNameHash.numerator_names_with_different_hash,
          denominator: sameNameHash.denominator_names_with_multiple_hashed_docs,
          identical_hash_duplicate_groups: sameNameHash.numerator_names_with_identical_hash_duplicate,
          method: "byte-level: sha256 over the bounded deep-dive document subset only, not the full structural sample",
          sample_note: `deep-dive subset size = ${deepDiveDocs.length} documents (bounded; see source_receipt.document_bytes)`,
          examples: sameNameHash.examples,
        })
      : typedUnknown("no documents were byte-fetched in the deep-dive subset"),

    media_types: {
      structural_sample: typedNotApplicable("Bytes were not fetched for the structural sample; only the deep-dive subset was byte-fetched."),
      deep_dive_subset: deepDiveDocs.length
        ? typedMeasured(
            deepDiveDocs.reduce((acc, d) => {
              const key = d.content_type || "unknown";
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {}),
            { denominator: deepDiveDocs.length },
          )
        : typedUnknown("no documents were byte-fetched"),
    },

    fetch_success_rate: {
      zap_api_project_detail: zapFetches.length
        ? typedMeasured(zapFetchSuccesses / zapFetches.length, { numerator: zapFetchSuccesses, denominator: zapFetches.length })
        : typedUnknown("no ZAP API detail fetches were attempted"),
      document_bytes: deepDiveDocs.length
        ? typedMeasured(deepDiveDocs.filter((d) => d.http_status === 200).length / deepDiveDocs.length, { numerator: deepDiveDocs.filter((d) => d.http_status === 200).length, denominator: deepDiveDocs.length })
        : typedUnknown("no document-byte fetches were attempted"),
    },

    scanned_pdf_rate: scannedDeepDive.length
      ? typedMeasured(scannedCount / scannedDeepDive.length, {
          numerator: scannedCount,
          denominator: scannedDeepDive.length,
          method: "text-native heuristic: pdftotext extracted-bytes-per-page < 40 treated as scanned/no-text-layer; measured only over the deep-dive byte-and-text-extracted subset",
          sample_note: "Not extrapolated to the full population or even the full structural sample.",
        })
      : typedUnknown("no deep-dive document had both a page count and a text extraction attempt"),

    filed_lu_package_version_counts: manifests.length
      ? typedMeasured(percentiles(packageVersionCounts, [50, 90, 100]), {
          denominator: manifests.length,
          max_observed: packageVersionCounts.length ? Math.max(...packageVersionCounts) : null,
          method: "max observed dcp-packageversion per sampled project (0 = no Filed LU Package group observed)",
        })
      : typedUnknown("sample was empty"),

    notice_of_receipt_coverage: manifests.length
      ? typedMeasured(countBy(manifests, "notice_of_receipt") / manifests.length, { numerator: countBy(manifests, "notice_of_receipt"), denominator: manifests.length, method: "title-token match on artifact group dcp-name" })
      : typedUnknown("sample was empty"),

    notice_of_certification_coverage: manifests.length
      ? typedMeasured(countBy(manifests, "notice_of_certification_or_referral") / manifests.length, { numerator: countBy(manifests, "notice_of_certification_or_referral"), denominator: manifests.length, method: "title-token match on artifact group dcp-name" })
      : typedUnknown("sample was empty"),

    ceqr_document_overlap: typedUnknown("CEQR document identity is SEQRA-04 scope and does not exist yet; no CEQR document set exists to overlap against. LDP-13's exact CEQR *project/milestone* joins are consumed unchanged and are not document-level."),

    specimens,

    go_stop_decisions: observation.go_stop_decisions || null,
  };

  return receipt;
}

/**
 * Nominate the specimens the card requires, from already-built manifests and
 * the deep-dive byte/text subset. Every non-pinned nomination is either a
 * real candidate with cited evidence, or an explicit measured-absence result
 * naming the search coverage -- never a fabricated example.
 */
export function nominateSpecimens({ manifests, deepDiveDocs, sampleActionsByProjectId }) {
  const out = {
    positive_gold: { project_id: "2025Q0247", pinned: true, evidence: "ZAP artifact group 'Racial Equity Report' with RER PDF; see gold fixture." },
    active_noticed: { project_id: "2026K0123", pinned: true, evidence: "Active/noticed project with no RER artifact group observed yet; required assertion (if any) must not be read as fulfillment." },
  };

  // not_required: a reconstructed candidate only -- action codes entirely
  // outside the DCP criteria chart's list. Never a publisher assertion.
  const notRequiredCandidate = manifests.find((m) => {
    const actions = sampleActionsByProjectId?.[m.project_id] || [];
    return actions.length > 0 && actions.every((code) => !RER_CRITERIA_ACTION_CODES.includes(code));
  });
  out.not_required = notRequiredCandidate
    ? {
        project_id: notRequiredCandidate.project_id,
        pinned: false,
        classification: "reconstructed_candidate",
        evidence: `Observed action codes ${JSON.stringify(sampleActionsByProjectId?.[notRequiredCandidate.project_id])} fall entirely outside DCP's RER criteria chart action-type list. This is a reconstructed candidate, not a publisher not-required assertion -- ZAP exposes no such assertion (see applicability.publisher_field_search).`,
      }
    : { status: "not_found", search_coverage: `Scanned ${manifests.length} sampled projects' action codes against RER_CRITERIA_ACTION_CODES; none fell entirely outside the list.` };

  const tardyHits = scanForPublisherTardyAssertion(manifests);
  out.missing_or_tardy = tardyHits.length
    ? { project_id: tardyHits[0].project_id, pinned: false, evidence: tardyHits[0].haystack }
    : { status: "not_found", search_coverage: `Regex-scanned dcp-applicability, public_status, and all artifact/package group titles across ${manifests.length} sampled projects; the publisher exposes no missing/tardy-filing field or token.` };

  // same-name/version fixture: a document basename repeated across >1 Filed
  // LU Package version within one project.
  let sameNameVersion = null;
  for (const m of manifests) {
    const byName = new Map();
    for (const doc of m.documents) {
      if (doc.group_kind !== "packages") continue;
      if (!byName.has(doc.normalized_name)) byName.set(doc.normalized_name, new Set());
      byName.get(doc.normalized_name).add(doc.group_id);
    }
    const repeated = [...byName.entries()].find(([, groupIds]) => groupIds.size > 1);
    if (repeated) {
      sameNameVersion = { project_id: m.project_id, pinned: m.project_id === "2025Q0247", document_name: repeated[0], package_group_ids: [...repeated[1]] };
      break;
    }
  }
  out.same_name_version = sameNameVersion
    || { status: "not_found", search_coverage: `Checked Filed LU Package document names for cross-version repeats across ${manifests.length} sampled projects.` };

  const scannedDoc = deepDiveDocs.find((d) => Number.isFinite(d.extracted_text_bytes) && Number.isFinite(d.pages) && d.pages > 0 && (d.extracted_text_bytes / d.pages) < 40);
  out.scanned_ocr = scannedDoc
    ? { project_id: scannedDoc.project_id, source_id: scannedDoc.source_id, pinned: false, evidence: `${scannedDoc.extracted_text_bytes} extracted text bytes over ${scannedDoc.pages} pages` }
    : { status: "not_found", search_coverage: `Text-extracted ${deepDiveDocs.filter((d) => Number.isFinite(d.pages)).length} deep-dive documents; none fell under the scanned-text-density threshold.` };

  const over40 = manifests.filter((m) => m.n_documents > 40);
  out.over_40_documents = over40.length
    ? { project_id: over40[0].project_id, pinned: false, n_documents: over40[0].n_documents }
    : { status: "not_found", search_coverage: `Checked untruncated document counts across ${manifests.length} sampled projects; none exceeded 40.` };

  return out;
}

/** Minimal shape assertion used by the receipt-fitness test. */
export function assertLandFilingCensusReceiptShape(receipt) {
  const requiredTopKeys = [
    "schema", "card", "generated_at", "source_receipt", "population", "sample",
    "applicability", "fulfillment", "rer_classification_paths", "document_counts",
    "projects_exceeding_40_documents", "same_name_different_id_rate", "same_name_different_hash_rate",
    "media_types", "fetch_success_rate", "scanned_pdf_rate", "filed_lu_package_version_counts",
    "notice_of_receipt_coverage", "notice_of_certification_coverage", "ceqr_document_overlap",
    "specimens", "go_stop_decisions",
  ];
  const missing = requiredTopKeys.filter((k) => !(k in receipt));
  if (missing.length) throw new Error(`land filing census receipt missing keys: ${missing.join(", ")}`);
  if (receipt.schema !== LAND_FILING_CENSUS_RECEIPT_SCHEMA) throw new Error(`unexpected schema ${receipt.schema}`);
  return true;
}
