/**
 * LDP-28: a committed, synthetic evaluation corpus for
 * warehouse/lib/land_filing_evidence_backtest.mjs, in the same spirit as
 * SEQRA-09's `warehouse/fixtures/seqra-baselines/` and LUP2-C7's
 * `warehouse/fixtures/land-use-prediction-v2/`: no live source, no network
 * call, no resident-facing claim about a real project. Every row is built
 * through the real LDP-23 contracts (ontology/land_use_filing.mjs) so the
 * corpus itself is contract-valid, not merely shaped like one.
 *
 * Every project key here is fictitious (`FX-####`), and every disposition,
 * BBL, and date is invented for this fixture set. This corpus exists to
 * exercise the backtest harness -- cutoff safety, project-family grouping,
 * per-family ablation, calibration, subgroup drift, and the GO/stop gate --
 * not to measure real filing evidence.
 */
import {
  buildLandUseFilingObligation,
  buildLandUseFilingDocument,
  racialEquityReportGoverningAuthority,
} from "../../../ontology/land_use_filing.mjs";

export const OBSERVATION_HORIZON = "2025-06-30T00:00:00.000Z";

export const BACKTEST_CORPUS_FOLDS = Object.freeze([
  { foldId: "fold-1", trainEnd: "2023-06-30T00:00:00.000Z", testStart: "2023-06-30T00:00:00.000Z", testEnd: "2023-12-31T00:00:00.000Z" },
  { foldId: "fold-2", trainEnd: "2023-12-31T00:00:00.000Z", testStart: "2023-12-31T00:00:00.000Z", testEnd: "2024-06-30T00:00:00.000Z" },
  { foldId: "fold-3", trainEnd: "2024-06-30T00:00:00.000Z", testStart: "2024-06-30T00:00:00.000Z", testEnd: "2024-12-31T00:00:00.000Z" },
]);

function addDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function fakeSha256(seed) {
  // A deterministic, fixture-only stand-in for a real byte hash -- 64 lowercase
  // hex characters derived from the seed string, no crypto module needed for
  // a synthetic fixture and no dependency this module would otherwise carry.
  let hex = "";
  let acc = 0;
  for (let i = 0; i < seed.length; i++) acc = (acc * 131 + seed.charCodeAt(i)) >>> 0;
  while (hex.length < 64) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    hex += acc.toString(16).padStart(8, "0");
  }
  return hex.slice(0, 64);
}

function buildObligation({ projectKey, applicabilityState, applicabilityAssertion = null, fulfillmentState, documentRefs = [], fulfillmentAssertion = null, observedAt, availableToPublicAt }) {
  return buildLandUseFilingObligation({
    obligation_id: `land_use_filing_obligation:${projectKey}:racial_equity_report`,
    project_ref: `project:${projectKey}`,
    obligation_type: "racial_equity_report",
    governing_authority: [racialEquityReportGoverningAuthority()],
    applicability: { state: applicabilityState, criteria: [], publisher_assertion: applicabilityAssertion, reconstructed_candidate: null },
    fulfillment: { state: fulfillmentState, document_refs: documentRefs, publisher_assertion: fulfillmentAssertion },
    procedural_effect: { certification_blocker: false, missing_report_notification_required: "unknown" },
    observed_at: observedAt,
    available_to_public_at: availableToPublicAt ?? observedAt,
    materialized_at: observedAt,
    source_id: "zap-api-outcomes",
    source_record_id: projectKey,
    source_vintage: observedAt,
    normalization_version: "ldp28_fixture.v1",
  });
}

function buildDocument({ projectKey, publisherDocumentId, documentType, firstObservedAt, availableToPublicAt, versionOrdinal = null, supersedes = null, supersessionBasis = null }) {
  return buildLandUseFilingDocument({
    project_ref: `project:${projectKey}`,
    document_type: documentType,
    publisher_document_id: publisherDocumentId,
    original_name: `${documentType}-${publisherDocumentId}.pdf`,
    first_observed_at: firstObservedAt,
    available_to_public_at: availableToPublicAt ?? firstObservedAt,
    retrieval_status: "fetched",
    bytes_sha256: fakeSha256(`${projectKey}:${publisherDocumentId}:${firstObservedAt}`),
    byte_length: 250_000,
    classification: { method: "explicit_publisher_type_or_group", evidence: [`fixture:${documentType}`], confidence: "high" },
    version_ordinal: versionOrdinal,
    supersedes,
    supersession_basis: supersessionBasis,
  });
}

function packageDocuments({ projectKey, filedAt, count }) {
  const documents = [];
  let previousId = null;
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const observedAt = addDays(filedAt, (ordinal - 1) * 21);
    const publisherDocumentId = `${projectKey}-pkg-${ordinal}`;
    const doc = buildDocument({
      projectKey,
      publisherDocumentId,
      documentType: "filed_land_use_package",
      firstObservedAt: observedAt,
      versionOrdinal: ordinal,
      supersedes: previousId,
      supersessionBasis: previousId ? "explicit publisher version increment (fixture)" : null,
    });
    documents.push(doc);
    previousId = doc.document_id;
  }
  return documents;
}

/**
 * One declarative scenario -> one fully-built as-of backtest row's raw
 * ingredients (zapRow, obligations, documents, ground truth). Kept as plain
 * data here; `warehouse/lib/land_filing_evidence_backtest.mjs` (via
 * `buildAsOfFilingBacktestRow`) does the actual as-of projection, sequence
 * materialization, and leakage self-check -- this module only assembles
 * contract-valid inputs.
 */
function buildScenarioInputs(scenario) {
  const {
    projectKey,
    bbl,
    cutoff,
    filedAt,
    noticedAt,
    certifiedAt,
    applicability,
    fulfillment,
    packageVersionCount,
    documentsSourceChecked,
    hasZapRow,
    hasCeqrIdentity,
    ceqrJoinChecked,
    ceqrMilestoneCount,
    postCertificationDisposition,
    withdrawnOrInactive,
    actionType,
    procedure,
  } = scenario;

  const obligations = [];
  const documents = [];

  if (applicability !== "no_obligation_at_all") {
    const applicabilityAssertion = applicability === "known_required" || applicability === "known_not_required"
      ? { source_field: "dcp_rer_applicability_assertion", source_value: applicability === "known_required" ? "Yes" : "No", observed_at: filedAt, source_url: null }
      : null;
    const applicabilityState = applicability === "known_required" ? "required" : applicability === "known_not_required" ? "not_required" : "unknown";

    let reportDoc = null;
    if (fulfillment === "document_observed") {
      reportDoc = buildDocument({ projectKey, publisherDocumentId: `${projectKey}-rer`, documentType: "racial_equity_report", firstObservedAt: addDays(filedAt, 5) });
      documents.push(reportDoc);
    }
    const fulfillmentAssertion = fulfillment === "publisher_identifies_not_timely_filed"
      ? { source_field: "dcp_rer_late_filing_notice", source_value: "not timely filed", observed_at: addDays(filedAt, 30), source_url: null }
      : null;

    obligations.push(buildObligation({
      projectKey,
      applicabilityState,
      applicabilityAssertion,
      fulfillmentState: fulfillment,
      documentRefs: reportDoc ? [reportDoc.document_id] : [],
      fulfillmentAssertion,
      observedAt: filedAt,
    }));
  }

  documents.push(...packageDocuments({ projectKey, filedAt, count: packageVersionCount }));

  if (noticedAt) {
    documents.push(buildDocument({ projectKey, publisherDocumentId: `${projectKey}-nor`, documentType: "notice_of_receipt", firstObservedAt: addDays(noticedAt, -3) }));
  }
  if (certifiedAt) {
    documents.push(buildDocument({ projectKey, publisherDocumentId: `${projectKey}-cert-notice`, documentType: "notice_of_certification_or_referral", firstObservedAt: certifiedAt }));
  }

  // A ZAP row is a live snapshot, not an as-of-projected record: a date field
  // the real publisher would not yet show at this row's own cutoff must be
  // withheld here too, or the row builder's own leakage self-check (rightly)
  // refuses it.
  const cutoffMs = Date.parse(cutoff);
  const visibleAt = (value) => (value != null && Date.parse(value) <= cutoffMs ? value : null);

  const zapRow = hasZapRow ? {
    project_id: projectKey,
    app_filed_date: visibleAt(filedAt),
    noticed_date: visibleAt(noticedAt),
    certified_referred: visibleAt(certifiedAt),
    ceqr_number: hasCeqrIdentity ? `${cutoff.slice(0, 2)}DCP${projectKey.replace(/\D/g, "")}E` : null,
    ceqr_type: hasCeqrIdentity ? "Type I" : null,
    ceqr_leadagency: hasCeqrIdentity ? "City Planning Commission" : null,
    eas_eis: hasCeqrIdentity ? "EAS" : null,
    current_envmilestone: null,
    current_envmilestone_date: null,
  } : null;

  const ceqrJoin = ceqrJoinChecked ? {
    ceqr_key: hasCeqrIdentity ? `${cutoff.slice(0, 2)}DCP${projectKey.replace(/\D/g, "")}E` : `unmatched-${projectKey}`,
    milestones: {
      rows: Array.from({ length: ceqrMilestoneCount ?? 0 }, (_, i) => ({
        source_record_id: `${projectKey}-milestone-${i + 1}`,
        milestone_name: i === 0 ? "eas_filed" : "determination_issued",
        milestone_date: addDays(filedAt, 30 + i * 60),
        extends_zap_milestone: false,
        exact_duplicate: false,
      })),
    },
  } : null;

  return {
    projectKey,
    bbls: [bbl],
    cutoff,
    zapRow,
    zapSourceVintage: cutoff,
    obligations,
    documents,
    documentsSourceChecked,
    ceqrJoin,
    materializedAt: cutoff,
    groundTruth: {
      filedAt,
      noticedAt,
      certifiedAt,
      observationHorizon: OBSERVATION_HORIZON,
      postCertificationDisposition: postCertificationDisposition ?? null,
      withdrawnOrInactive: withdrawnOrInactive ?? null,
      actionType: actionType ?? "unknown",
      procedure: procedure ?? "unknown",
    },
  };
}

const ACTION_TYPES = ["ZM", "ZS", "ZC", "UDAAP"];
const PROCEDURES = ["ulurp", "non_ulurp_administrative"];

/**
 * 36 scenarios spanning 2021-2024 so every fold in BACKTEST_CORPUS_FOLDS has
 * a non-trivial train and test population, plus a handful of BBL-sharing
 * pairs placed deliberately across a fold boundary to exercise
 * family/leakage exclusion, and a small set of named edge cases the card's
 * own acceptance criteria name directly (A1, A2, A3/A4, A6).
 */
function buildScenarioTable() {
  const scenarios = [];
  const boroughs = ["1", "2", "3", "4", "5"];

  const cycleWindows = [
    { label: "2021", filedYear: 2021, filedMonth: 2, cutoffOffsetDays: 400 },
    { label: "2022", filedYear: 2022, filedMonth: 2, cutoffOffsetDays: 400 },
    { label: "2023h1", filedYear: 2022, filedMonth: 11, cutoffOffsetDays: 220 },
    { label: "2023h2", filedYear: 2023, filedMonth: 5, cutoffOffsetDays: 220 },
    { label: "2024h1", filedYear: 2023, filedMonth: 11, cutoffOffsetDays: 220 },
    { label: "2024h2", filedYear: 2024, filedMonth: 5, cutoffOffsetDays: 220 },
  ];

  const applicabilityCycle = ["known_required", "known_required", "known_not_required", "unknown_no_assertion", "unknown_no_assertion", "known_required"];
  const fulfillmentCycle = ["document_observed", "not_observed", "document_observed", "not_checked", "publisher_identifies_not_timely_filed", "source_unavailable"];

  let index = 0;
  for (const window of cycleWindows) {
    for (let member = 0; member < 6; member++) {
      index += 1;
      const projectKey = `FX-${window.label}-${String(member + 1).padStart(2, "0")}`;
      const bbl = `${boroughs[member % boroughs.length]}${String(10_000_000 + index * 37).padStart(8, "0")}`;
      const filedAt = new Date(Date.UTC(window.filedYear, window.filedMonth - 1, 5 + member)).toISOString();
      const cutoff = addDays(filedAt, window.cutoffOffsetDays);
      const noticedAt = member % 5 === 4 ? null : addDays(filedAt, 60 + member * 5);
      // Roughly two-thirds certified within the fixture's own horizon, so
      // every duration/binary target has both events and censored rows.
      const certifiedAt = member % 3 === 2 ? null : addDays(filedAt, 180 + member * 15);
      const applicability = applicabilityCycle[member];
      const fulfillment = fulfillmentCycle[member];
      const packageVersionCount = member % 4; // 0..3, so churn features see real variety including zero and single-version "no interval" rows
      const documentsSourceChecked = !(window.label === "2022" && member === 3); // one explicit "manifest never checked" row
      const hasZapRow = !(window.label === "2021" && member === 5); // one explicit "no ZAP row at all" row
      const hasCeqrIdentity = member % 2 === 0;
      const ceqrJoinChecked = !(window.label === "2023h1" && member === 1); // one explicit "CEQR join never checked" row
      const ceqrMilestoneCount = ceqrJoinChecked ? member % 3 : null;
      const postCertificationDisposition = certifiedAt ? (member % 2 === 0 ? "approved" : "modified") : null;
      const withdrawnOrInactive = certifiedAt ? false : (member % 3 === 0 ? true : null);

      scenarios.push({
        projectKey,
        bbl,
        cutoff,
        filedAt,
        noticedAt,
        certifiedAt,
        applicability,
        fulfillment,
        packageVersionCount,
        documentsSourceChecked,
        hasZapRow,
        hasCeqrIdentity,
        ceqrJoinChecked,
        ceqrMilestoneCount,
        postCertificationDisposition,
        withdrawnOrInactive,
        actionType: ACTION_TYPES[member % ACTION_TYPES.length],
        procedure: PROCEDURES[member % PROCEDURES.length],
      });
    }
  }

  // A2/G2: two explicit family pairs sharing a BBL, one straddling the
  // fold-1/fold-2 boundary and one straddling fold-2/fold-3, so the fold
  // builder's family-disjointness exclusion has a real conflict to catch in
  // more than one fold.
  const sharedBblEarly = scenarios.find((s) => s.projectKey === "FX-2023h1-01").bbl;
  scenarios.push({
    ...buildRelatedAmendment(scenarios.find((s) => s.projectKey === "FX-2023h1-01"), "FX-2023h2-related-01", "2023h2"),
    bbl: sharedBblEarly,
  });
  const sharedBblLate = scenarios.find((s) => s.projectKey === "FX-2024h1-01").bbl;
  scenarios.push({
    ...buildRelatedAmendment(scenarios.find((s) => s.projectKey === "FX-2024h1-01"), "FX-2024h2-related-01", "2024h2"),
    bbl: sharedBblLate,
  });

  // G1/A1: a row whose applicability is entirely absent (no obligation was
  // ever registered for this project) -- the census's own "explicit unknown"
  // finding, carried all the way through to a feature row.
  scenarios.push({
    projectKey: "FX-no-obligation-01",
    bbl: "1099999901",
    cutoff: "2024-03-01T00:00:00.000Z",
    filedAt: "2023-08-01T00:00:00.000Z",
    noticedAt: "2023-10-01T00:00:00.000Z",
    certifiedAt: "2024-01-15T00:00:00.000Z",
    applicability: "no_obligation_at_all",
    fulfillment: "not_checked",
    packageVersionCount: 1,
    documentsSourceChecked: true,
    hasZapRow: true,
    hasCeqrIdentity: false,
    ceqrJoinChecked: false,
    ceqrMilestoneCount: null,
    postCertificationDisposition: "approved",
    withdrawnOrInactive: false,
    actionType: "ZM",
    procedure: "ulurp",
  });

  return scenarios;
}

function buildRelatedAmendment(original, projectKey, windowLabel) {
  const filedAt = addDays(original.filedAt, 200);
  const cutoff = addDays(filedAt, 220);
  return {
    projectKey,
    cutoff,
    filedAt,
    noticedAt: addDays(filedAt, 65),
    certifiedAt: addDays(filedAt, 200),
    applicability: "known_required",
    fulfillment: "document_observed",
    packageVersionCount: 2,
    documentsSourceChecked: true,
    hasZapRow: true,
    hasCeqrIdentity: true,
    ceqrJoinChecked: true,
    ceqrMilestoneCount: 1,
    postCertificationDisposition: "modified",
    withdrawnOrInactive: false,
    actionType: "ZM",
    procedure: "ulurp",
  };
}

export const BACKTEST_CORPUS_SCENARIOS = Object.freeze(buildScenarioTable());

export const BACKTEST_CORPUS_ROW_INPUTS = Object.freeze(BACKTEST_CORPUS_SCENARIOS.map((scenario) => buildScenarioInputs(scenario)));

export const BACKTEST_CORPUS_PROJECTS = Object.freeze(BACKTEST_CORPUS_ROW_INPUTS.map((row) => ({ projectKey: row.projectKey, bbls: row.bbls })));
