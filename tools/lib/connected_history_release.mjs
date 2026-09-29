/**
 * Release read-back contract for the fixed six-case connected-history dossier.
 *
 * Every capability record is derived from served (or committed) materializations
 * by the checks below; no status is a constant. The dossier is closed: expected
 * identifiers come from the six fixed cases only, and a missing case, stratum,
 * route, or scheduled cycle is reported as an open outcome, never replaced.
 */

import { SITE_LIFECYCLE_SCHEMA } from "../../site/site_lifecycle_reader.mjs";

const PARCEL_MANIFEST_SCHEMA = SITE_LIFECYCLE_SCHEMA.replace(/\.v1$/, ".manifest.v1");

export const RELEASE_READBACK_SCHEMA = "cityscroll.connected_history_release_readback.v1";

/** The squash-merge commit whose deployment opens the release read-back. */
export const RELEASE_DELIVERY = Object.freeze({
  pull_request: 2410,
  landed_commit: "1a875a22035fcce03d374bec731e14a22678265e",
});

export const PRODUCTION_HOSTS = Object.freeze(["cityscroll.org", "www.cityscroll.org"]);

export const DOSSIER_FAMILIES = Object.freeze([
  "coyle",
  "franklin-avenue",
  "kingsbridge-armory",
  "sixth-avenue",
  "thirty-first-avenue",
  "lighthouse-point",
]);

/** The only family inside Brooklyn Community Board 15. */
export const CB15_FAMILY = "coyle";

export const JOURNEY_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "desktop-keyboard", width: 1440, height: 900 }),
  Object.freeze({ name: "narrow-touch", width: 390, height: 844 }),
  Object.freeze({ name: "no-javascript", width: 1440, height: 900 }),
]);

/** Served materializations read by the capability checks, keyed by artifact. */
export const SERVED_DATA = Object.freeze({
  cohort: "/data/connected_history_evaluation_cohort.json",
  documents: "/data/connected_history_documents.json",
  relations: "/data/connected_history_relations.json",
  roles: "/data/connected_history_roles.json",
  time: "/data/connected_history_time.json",
  coverage: "/data/connected_history_coverage.json",
  parcel_manifest: "/data/site_lifecycle/manifest.json",
});

/**
 * The connected-history family's own scheduled cycle: it acquires, commits its
 * receipt (and any published change) through a pull request, and is then
 * served by the Pages deploy. Its served receipt names the run. After that
 * cycle the histories must remain discoverable with unchanged bytes. The
 * entry mirrors CONNECTED_HISTORY_CYCLE in connected_history_cycle.mjs.
 */
export const SCHEDULED_PUBLICATION_WORKFLOWS = Object.freeze([
  Object.freeze({
    workflow: "connected-history-cycle.yml",
    cron: "13 7 * * *",
    branch: () => "automation/connected-history-cycle",
    served_receipt: "/data/connected_history_cycle.json",
  }),
]);

/** Days after the release deployment within which the first cycle is read back. */
export const SCHEDULED_READBACK_WINDOW_DAYS = 7;

export const EVIDENCE_CLASSES = Object.freeze([
  "committed_materialization",
  "local_origin_rehearsal",
  "deployed_production_read_back",
]);

const RECORD_FIELDS = Object.freeze([
  "capability",
  "before_limitation",
  "route",
  "steps",
  "expected_native_ids",
  "relation_assertion",
  "negative_assertion",
  "observed",
  "destination",
  "revisions",
  "vintage",
  "evidence_class",
  "unresolved_limits",
  "realized_outcome",
]);

const MERGE_REJECTIONS = Object.freeze([
  "negative-31st-street-vs-avenue",
  "negative-coyle-parcel-assumption-merge",
  "negative-coyle-same-board-ownership",
  "negative-emmons-coyle-proximity",
  "negative-franklin-same-applicant-shortcut",
  "negative-stapleton-related-news-lighthouse",
]);

const ROLE_REJECTIONS = Object.freeze([
  "negative-dot-presentation-as-formal-board-action",
  "negative-lighthouse-chair-as-formal-board-action",
  "negative-same-applicant-spelling-beneficial-ownership",
  "negative-testimony-flags-as-resolution",
]);

const EXPECTED_RELATIONS = Object.freeze([
  ["coyle", "bsa:case:2025-54-A", "discussed_in_document", "board_document:brooklyn-cb-15:agenda-2026-01-27"],
  ["coyle", "bsa:case:2026-09-A", "discussed_in_document", "board_document:brooklyn-cb-15:minutes-2026-02-24"],
  ["franklin-avenue", "land:application:C230356ZMK", "explicitly_references", "land:application:C200184ZMK"],
  ["franklin-avenue", "land:application:C230356ZMK", "explicitly_references", "land:application:N200185ZRK"],
  ["franklin-avenue", "land:application:C230356ZMK", "explicitly_references", "land:application:C200186ZSK"],
  ["franklin-avenue", "land:application:C230356ZMK", "explicitly_references", "land:application:C200187ZSK"],
  ["kingsbridge-armory", "ceqr:13DME013X", "successive_proposal", "ceqr:08DME004X"],
  ["kingsbridge-armory", "ceqr:25DME006X", "successive_proposal", "ceqr:13DME013X"],
  ["kingsbridge-armory", "land:project:2025X0262", "shares_documented_footprint", "parcel:2032470010"],
  ["kingsbridge-armory", "land:project:2025X0262", "shares_documented_footprint", "parcel:2032470002"],
  ["sixth-avenue", "dot:corridor:sixth-avenue-lispenard-w14", "corridor_segment", "dot:corridor:sixth-avenue"],
  ["sixth-avenue", "dot:corridor:sixth-avenue-w14-w35", "corridor_segment", "dot:corridor:sixth-avenue"],
  ["sixth-avenue", "dot:corridor:sixth-avenue-watts-w59", "corridor_segment", "dot:corridor:sixth-avenue"],
  ["thirty-first-avenue", "dot:phase:31st-avenue-phase-i", "phase_component", "dot:corridor:31st-avenue-vernon-51"],
  ["thirty-first-avenue", "dot:phase:31st-avenue-phase-ii", "phase_component", "dot:corridor:31st-avenue-vernon-51"],
  ["lighthouse-point", "edc:opening:lighthouse-point-phase-1-2025-06-05", "phase_component", "edc:project:lighthouse-point"],
  ["lighthouse-point", "edc:phase:lighthouse-point-phase-2", "phase_component", "edc:project:lighthouse-point"],
]);

/** Native identifiers named by the fixed dossier, per family. */
const DOSSIER_NATIVE_IDS = Object.freeze({
  "coyle": ["2025-54-A", "2026-09-A", "2020K0270", "3073670011", "3073670029"],
  "franklin-avenue": ["C200184ZMK", "N200185ZRK", "C200186ZSK", "C200187ZSK", "C230356ZMK"],
  "kingsbridge-armory": ["08DME004X", "13DME013X", "25DME006X", "2025X0262"],
  "sixth-avenue": ["sixth-avenue-lispenard-w14", "sixth-avenue-w14-w35", "sixth-avenue-watts-w59"],
  "thirty-first-avenue": ["31st-avenue-phase-i", "31st-avenue-phase-ii"],
  "lighthouse-point": ["edc:project:lighthouse-point"],
});

const DOSSIER_SOURCE_HOSTS = Object.freeze([
  "a002-ceqraccess.nyc.gov",
  "a856-cityrecord.nyc.gov",
  "edc.nyc",
  "legistar.council.nyc.gov",
  "www.nyc.gov",
  "zap-api-production.herokuapp.com",
  "zap.planning.nyc.gov",
]);

const ADMISSION_CONTRADICTING_JUDGMENTS = Object.freeze(["no_relation", "false_positive", "contradicted"]);

function relationKey(from, relation, to) {
  return `${from} ${relation} ${to}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function dossierIds(families) {
  return sortedUnique(families.flatMap((family) => DOSSIER_NATIVE_IDS[family] || []));
}

function mentionsDossierId(subjectId) {
  const text = String(subjectId || "");
  return Object.values(DOSSIER_NATIVE_IDS).flat().some((id) => text === id || text.endsWith(`:${id}`));
}

/**
 * A retained rejection names a basis that cannot warrant a pair. It contradicts
 * an admitted relation of the same pair only when that admission has no quoted
 * source span of its own or rests on the rejected basis.
 */
function admittedOnRejectedBasis(row, rejection) {
  if (row.from !== rejection.from || row.to !== rejection.to) return false;
  const quoted = typeof row.source_span?.quote === "string" && row.source_span.quote.length > 0;
  return !quoted || row.warrant_method === rejection.basis;
}

function check(failures, condition, message) {
  if (!condition) failures.push(message);
}

function requireArtifact(artifacts, key, schema) {
  const value = artifacts?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `served ${key} materialization is missing or not a JSON object`;
  }
  if (schema && value.schema !== schema) return `served ${key} materialization has schema ${value.schema}`;
  return null;
}

function cohortCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "cohort", "cityscroll.connected_history_evaluation_cohort.v1");
  if (missing) return { failures: [missing], observed: null };
  const cohort = artifacts.cohort;
  const sample = Array.isArray(cohort.sample) ? cohort.sample : [];
  const judgments = Array.isArray(cohort.judgments) ? cohort.judgments : [];
  const leakedDemo = sample.filter((row) => mentionsDossierId(row.subject_id)).map((row) => row.subject_id);
  const lateJudgments = judgments.filter((row) => row.judged_before_tuning !== true).map((row) => row.subject_id);
  const boards = Array.isArray(cohort.boards) ? cohort.boards : [];
  check(failures, cohort.seed === "connected-history-evaluation-2026-09-16", "cohort seed differs from the recorded seed");
  check(failures, /^[a-f0-9]{64}$/.test(cohort.selection_hash || ""), "cohort selection hash is absent");
  check(failures, boards.length === 59, `cohort enumerates ${boards.length} boards, not 59`);
  check(failures, leakedDemo.length === 0, `named dossier subjects entered the held-out sample: ${leakedDemo.join(", ")}`);
  check(failures, lateJudgments.length === 0, `held-out judgments recorded after tuning: ${lateJudgments.join(", ")}`);
  const judgmentCounts = {};
  for (const row of judgments) judgmentCounts[row.judgment] = (judgmentCounts[row.judgment] || 0) + 1;
  return {
    failures,
    observed: {
      boards: boards.length,
      selection_hash: cohort.selection_hash || null,
      selected_held_out_subjects: sample.length,
      demo_excluded_subjects: cohort.denominators?.demo_excluded_subjects ?? null,
      judgment_counts: judgmentCounts,
      dossier_subjects_in_held_out_sample: leakedDemo.length,
    },
  };
}

function documentsCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "documents", "cityscroll.connected_history_documents.v1");
  if (missing) return { failures: [missing], observed: null };
  const documents = artifacts.documents;
  const observations = Array.isArray(documents.observations) ? documents.observations : [];
  const outsideDossier = observations.filter((row) => !DOSSIER_FAMILIES.includes(row.family_id)).map((row) => row.source_id);
  const substituteHosts = observations
    .filter((row) => {
      try {
        return !DOSSIER_SOURCE_HOSTS.includes(new URL(row.requested_url).hostname);
      } catch {
        return true;
      }
    })
    .map((row) => row.source_id);
  const retained = observations.filter((row) => row.retained === true);
  const failed = observations.filter((row) => row.retained !== true);
  const unexplained = failed.filter((row) => !row.reason).map((row) => row.source_id);
  const unhashed = retained.filter((row) => !/^sha256:[a-f0-9]{64}$/.test(row.content_hash || "")).map((row) => row.source_id);
  check(failures, observations.length > 0, "no dossier document observations are served");
  check(failures, outsideDossier.length === 0, `documents outside the fixed dossier: ${outsideDossier.join(", ")}`);
  check(failures, substituteHosts.length === 0, `documents from hosts outside the dossier: ${substituteHosts.join(", ")}`);
  check(failures, unexplained.length === 0, `acquisition failures without a retained reason: ${unexplained.join(", ")}`);
  check(failures, unhashed.length === 0, `retained documents without a content hash: ${unhashed.join(", ")}`);
  check(failures, (documents.counts?.acquisition_failures ?? -1) === failed.length, "acquisition failure count disagrees with observations");
  return {
    failures,
    observed: {
      sources: observations.length,
      retained: retained.length,
      acquisition_failures: failed.length,
      retained_source_ids: retained.map((row) => row.source_id).sort(),
      failure_reasons: Object.fromEntries(failed.map((row) => [row.source_id, row.reason]).sort()),
    },
    limits: failed.length
      ? [`${failed.length} of ${observations.length} fixed dossier documents are retained as acquisition failures; the affected proofs stay open and no substitute source was sought.`]
      : [],
  };
}

function relationsCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "relations", "cityscroll.connected_history_relations.v1");
  if (missing) return { failures: [missing], observed: null };
  const relations = Array.isArray(artifacts.relations.relations) ? artifacts.relations.relations : [];
  const rejections = Array.isArray(artifacts.relations.rejections) ? artifacts.relations.rejections : [];
  const admitted = new Set(relations.map((row) => relationKey(row.from, row.relation, row.to)));
  const absent = EXPECTED_RELATIONS
    .filter(([, from, relation, to]) => !admitted.has(relationKey(from, relation, to)))
    .map(([, from, relation, to]) => relationKey(from, relation, to));
  const merged = relations.filter((row) => row.identities_merged !== false).map((row) => row.candidate_id);
  const rejected = new Map(rejections.map((row) => [row.candidate_id, row]));
  const missingRejections = MERGE_REJECTIONS.filter((id) => !rejected.has(id));
  const admittedNegatives = MERGE_REJECTIONS
    .map((id) => rejected.get(id))
    .filter((row) => row && relations.some((admittedRow) => admittedOnRejectedBasis(admittedRow, row)))
    .map((row) => row.candidate_id);
  const coyle = relations.filter((row) => row.family_id === CB15_FAMILY);
  const resolvedCoyleParcel = coyle.filter((row) => row.parcel_identity !== "unresolved").map((row) => row.candidate_id);
  check(failures, absent.length === 0, `expected dossier relations absent: ${absent.join("; ")}`);
  check(failures, merged.length === 0, `relations merge identities: ${merged.join(", ")}`);
  check(failures, missingRejections.length === 0, `negative controls no longer retained: ${missingRejections.join(", ")}`);
  check(failures, admittedNegatives.length === 0, `negative controls admitted as relations: ${admittedNegatives.join(", ")}`);
  check(failures, resolvedCoyleParcel.length === 0, `Coyle parcel identity silently resolved: ${resolvedCoyleParcel.join(", ")}`);
  const perFamily = {};
  for (const family of DOSSIER_FAMILIES) perFamily[family] = relations.filter((row) => row.family_id === family).length;
  return {
    failures,
    observed: {
      admitted: relations.length,
      rejected: rejections.length,
      admitted_per_family: perFamily,
      expected_relations_present: EXPECTED_RELATIONS.length - absent.length,
      negative_controls_retained: MERGE_REJECTIONS.length - missingRejections.length,
      identities_merged: merged.length,
    },
  };
}

function rolesCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "roles", "cityscroll.connected_history_roles.v1");
  if (missing) return { failures: [missing], observed: null };
  const observations = Array.isArray(artifacts.roles.observations) ? artifacts.roles.observations : [];
  const rejections = Array.isArray(artifacts.roles.rejections) ? artifacts.roles.rejections : [];
  const rejected = new Set(rejections.map((row) => row.candidate_id));
  const formal = observations.filter((row) => row.role === "formal_board_action").map((row) => `${row.from} -> ${row.to}`);
  const owners = observations.filter((row) => row.role === "recorded_owner").map((row) => `${row.from} -> ${row.to}`);
  const applicantSubjects = observations.filter((row) => row.role === "applicant").map((row) => row.subject).sort();
  const lighthouseSpeaker = observations.find((row) => row.role === "speaker" && row.to === "edc:project:lighthouse-point");
  const missingRejections = ROLE_REJECTIONS.filter((id) => !rejected.has(id));
  check(failures, applicantSubjects.includes("land:application:C200184ZMK"), "Franklin 2021 applicant role is absent");
  check(failures, applicantSubjects.includes("land:application:C230356ZMK"), "Franklin 2024 applicant role is absent");
  check(failures, Boolean(lighthouseSpeaker), "Lighthouse Point chair statement is absent");
  check(failures, formal.length === 0, `formal board actions admitted: ${formal.join("; ")}`);
  check(failures, owners.length === 0, `recorded ownership admitted: ${owners.join("; ")}`);
  check(failures, missingRejections.length === 0, `role negative controls no longer retained: ${missingRejections.join(", ")}`);
  return {
    failures,
    observed: {
      admitted: observations.length,
      rejected: rejections.length,
      applicant_subjects: applicantSubjects,
      chair_statement_role: lighthouseSpeaker?.role || null,
      formal_board_actions_admitted: formal.length,
      missing_strata: Array.isArray(artifacts.roles.missing_strata) ? [...artifacts.roles.missing_strata].sort() : [],
    },
    limits: Array.isArray(artifacts.roles.missing_strata) && artifacts.roles.missing_strata.length
      ? [`Role strata not documented by the fixed dossier remain missing: ${[...artifacts.roles.missing_strata].sort().join(", ")}.`]
      : [],
  };
}

function timeCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "time", "cityscroll.connected_history_time_artifact.v1");
  if (missing) return { failures: [missing], observed: null };
  const observations = Array.isArray(artifacts.time.observations) ? artifacts.time.observations : [];
  const byId = new Map(observations.map((row) => [row.observation_id, row]));
  const forecast = byId.get("kingsbridge-operation-forecast-2018");
  const opening = byId.get("lighthouse-first-phase-opening-2025");
  const preliminary = byId.get("thirty-first-avenue-preliminary-period-2024");
  const pairs = Array.isArray(artifacts.time.query_pairs) ? artifacts.time.query_pairs.map((row) => row.id).sort() : [];
  const outcomes = Array.isArray(artifacts.time.dossier_outcomes) ? artifacts.time.dossier_outcomes : [];
  const substituted = outcomes.filter((row) => row.substitute_family_used !== false).map((row) => row.family_id);
  const insufficient = outcomes
    .filter((row) => row.outcome !== "retained_temporal_facts")
    .map((row) => row.family_id)
    .sort();
  check(failures, forecast?.event_class === "planned" && forecast?.value?.realized === false, "Kingsbridge 2018 operation is not held as an unrealized forecast");
  check(failures, opening?.value?.closes_parent_project === false, "Lighthouse Point first-phase opening closes the whole project");
  check(failures, preliminary?.preliminary === true, "31st Avenue before/after observations lost their preliminary status");
  check(failures, pairs.includes("franklin-proposal-epochs"), "Franklin proposal-epoch comparison is absent");
  check(failures, outcomes.length === DOSSIER_FAMILIES.length, `temporal outcomes cover ${outcomes.length} of ${DOSSIER_FAMILIES.length} families`);
  check(failures, substituted.length === 0, `substitute temporal families used: ${substituted.join(", ")}`);
  return {
    failures,
    observed: {
      observations: observations.length,
      query_pairs: pairs,
      forecast_event_class: forecast?.event_class || null,
      opening_closes_parent_project: opening?.value?.closes_parent_project ?? null,
      preliminary_measurement: preliminary?.preliminary ?? null,
      families_without_temporal_facts: insufficient,
    },
    limits: insufficient.length
      ? [`No retained dated comparison exists for ${insufficient.join(" and ")}; that outcome is reported rather than filled.`]
      : [],
  };
}

function parcelCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "parcel_manifest", PARCEL_MANIFEST_SCHEMA);
  if (missing) return { failures: [missing], observed: null };
  const manifest = artifacts.parcel_manifest;
  const shards = Array.isArray(artifacts.parcel_shards) ? artifacts.parcel_shards : [];
  const shardNames = Array.isArray(manifest.shards) ? manifest.shards : [];
  const mixed = shards.filter((row) => row?.generation !== manifest.generation).map((row) => row?.shard);
  const parcels = sortedUnique(shards.flatMap((row) => (row?.rows || []).map((entry) => entry.parcel_id)));
  const population = artifacts.parcel_population || null;
  check(failures, shards.length === shardNames.length && shardNames.length > 0, `served ${shards.length} of ${shardNames.length} parcel shards`);
  check(failures, mixed.length === 0, `parcel shards from another generation: ${mixed.join(", ")}`);
  check(failures, parcels.length === manifest.counts?.parcels, `reader traverses ${parcels.length} parcels; manifest declares ${manifest.counts?.parcels}`);
  const limits = [];
  if (population?.status && population.status !== "complete") {
    limits.push(
      `The parcel population receipt is ${population.status}; strata without a published population: ${(population.shortfalls || []).join(", ")}.`,
    );
  }
  if (population?.scheduled_observation?.awaiting_deployed_cycle === true) {
    limits.push("The scheduled parcel-history materialization has not yet been observed after deployment.");
  }
  return {
    failures,
    observed: {
      generation: manifest.generation || null,
      shards: shardNames.length,
      parcels,
      members: manifest.counts?.members ?? null,
      population_status: population?.status || null,
    },
    limits,
  };
}

function coverageCheck(artifacts) {
  const failures = [];
  const missing = requireArtifact(artifacts, "coverage", "cityscroll.connected_history_coverage.v1");
  if (missing) return { failures: [missing], observed: null };
  const coverage = artifacts.coverage;
  const snapshots = coverage.snapshots && typeof coverage.snapshots === "object" ? coverage.snapshots : {};
  const boardCounts = Object.fromEntries(Object.entries(snapshots).map(([name, value]) => [name, value?.boards?.length ?? 0]));
  const scores = [coverage.evaluation?.post_change?.precision, coverage.evaluation?.post_change?.recall].filter(Boolean);
  const unsupported = scores.filter((score) => score.denominator === 0 && score.status !== "not_estimable");
  check(failures, Object.keys(boardCounts).length > 0, "coverage snapshots are absent");
  for (const [name, count] of Object.entries(boardCounts)) check(failures, count === 59, `${name} enumerates ${count} boards, not 59`);
  check(failures, unsupported.length === 0, "a zero-denominator score is presented as estimable");
  check(failures, /never the level of civic activity/.test(coverage.interpretation?.missingness || ""), "coverage no longer disclaims civic activity levels");
  check(failures, coverage.evaluation?.post_change?.example_search_triggered === false, "coverage evaluation triggered an example search");
  return {
    failures,
    observed: {
      snapshot_board_counts: boardCounts,
      precision_status: coverage.evaluation?.post_change?.precision?.status || null,
      recall_status: coverage.evaluation?.post_change?.recall?.status || null,
    },
    limits: [
      "Coverage reports retained acquisition and discovery stages only; it does not measure or equalize civic activity between boards and does not claim citywide completeness.",
    ],
  };
}

function journeyCheck(artifacts) {
  const failures = [];
  const journeys = artifacts.journeys;
  if (!journeys || !Array.isArray(journeys.captures)) {
    return { failures: ["rendered release journeys were not measured in this read-back"], observed: null };
  }
  const byCase = new Map(journeys.captures.map((row) => [row.case, row]));
  const passed = [];
  for (const family of DOSSIER_FAMILIES) {
    for (const viewport of JOURNEY_VIEWPORTS) {
      const id = `${family}-${viewport.name}`;
      const capture = byCase.get(id);
      if (!capture) {
        failures.push(`rendered journey ${id} is absent`);
        continue;
      }
      const runtime = capture.runtime || {};
      const ok = capture.viewport?.width === viewport.width
        && capture.viewport?.height === viewport.height
        && /^[a-f0-9]{64}$/.test(capture.render_sha256 || "")
        && typeof runtime.query === "string"
        && (viewport.name === "no-javascript"
          || (runtime.horizontal_overflow === false
            && runtime.positive_tabindex_count === 0
            && /^https?:\/\//.test(runtime.official_source_destination || "")
            && /^https?:\/\//.test(runtime.continue_destination || "")));
      if (ok) passed.push(id);
      else failures.push(`rendered journey ${id} did not meet its runtime assertions`);
    }
  }
  const extra = journeys.captures
    .map((row) => row.family_id)
    .filter((family) => !DOSSIER_FAMILIES.includes(family));
  check(failures, extra.length === 0, `journeys outside the fixed dossier: ${sortedUnique(extra).join(", ")}`);
  check(failures, journeys.browser === "Chromium", "journeys were not measured in Chromium");
  return {
    failures,
    observed: {
      browser: journeys.browser || null,
      passed: passed.length,
      expected: DOSSIER_FAMILIES.length * JOURNEY_VIEWPORTS.length,
      families_passed: DOSSIER_FAMILIES.filter((family) => JOURNEY_VIEWPORTS.every((viewport) => passed.includes(`${family}-${viewport.name}`))),
    },
  };
}

/**
 * Fixed capability definitions. Each check reads only the artifacts named in
 * `reads`, so a record's observed result is reproducible from served bytes.
 */
export const CAPABILITIES = Object.freeze([
  {
    id: "frozen-evaluation-baseline",
    delivered_by: { alias: "c5bb5a59d87f9", pull_requests: [2115] },
    reads: ["cohort"],
    capability: "A frozen cross-board evaluation population and held-out sample make discovery quality measurable without swapping difficult subjects.",
    before_limitation: "No fixed denominator existed, so improvements could only be shown with attractive examples.",
    route: SERVED_DATA.cohort,
    steps: ["Read the served cohort.", "Confirm the recorded seed, selection hash and 59-board enumeration.", "Confirm no fixed dossier subject is in the held-out sample and every judgment predates tuning."],
    families: DOSSIER_FAMILIES,
    relation_assertion: "Held-out subjects are selected by the recorded seed per board and judged before tuning.",
    negative_assertion: "None of the six fixed dossier histories is counted in the held-out sample.",
    destination: SERVED_DATA.cohort,
    check: cohortCheck,
  },
  {
    id: "retained-dossier-documents",
    delivered_by: { alias: "ce34e91058d33", pull_requests: [2151, 2244] },
    reads: ["documents"],
    capability: "Official CEQR, DOT and EDC documents named by the fixed dossier are retained with hashes and dated locators, or retained as acquisition failures.",
    before_limitation: "Only the original neighborhood had retained official evidence.",
    route: SERVED_DATA.documents,
    steps: ["Read the served document observations.", "Confirm every observation belongs to a fixed family and a dossier host.", "Confirm retained documents carry hashes and failures carry reasons."],
    families: ["kingsbridge-armory", "sixth-avenue", "thirty-first-avenue", "lighthouse-point"],
    relation_assertion: "Each retained document carries its publisher hash and located source span.",
    negative_assertion: "No document outside the fixed dossier hosts is retained or substituted for a failed acquisition.",
    destination: SERVED_DATA.documents,
    check: documentsCheck,
  },
  {
    id: "typed-history-relations",
    delivered_by: { alias: "c33016345e7ed", pull_requests: [2383] },
    reads: ["relations"],
    capability: "Typed, source-backed relations connect proposals, proceedings, corridors and components while every identity stays separate.",
    before_limitation: "Related applications, cases and phases could not be traversed without merging them.",
    route: SERVED_DATA.relations,
    steps: ["Read the served relations.", "Confirm each expected dossier relation is admitted.", "Confirm every negative control is retained as a rejection and no identity is merged."],
    families: DOSSIER_FAMILIES,
    relation_assertion: EXPECTED_RELATIONS.map(([, from, relation, to]) => relationKey(from, relation, to)).join("; "),
    negative_assertion: "31st Street, Emmons Avenue, the Stapleton related-news listing, a shared applicant label, a shared board and an assumed Coyle parcel never admit a relation.",
    destination: SERVED_DATA.relations,
    check: relationsCheck,
  },
  {
    id: "time-scoped-roles",
    delivered_by: { alias: "cb955ed14a3ed", pull_requests: [2386, 2388, 2389, 2398] },
    reads: ["roles"],
    capability: "Documented participants keep source-specific roles and dates without inventing ownership or formal board positions.",
    before_limitation: "Participation was either absent or implied by a repeated label.",
    route: SERVED_DATA.roles,
    steps: ["Read the served role observations.", "Confirm Franklin applicant roles and the Lighthouse Point chair statement.", "Confirm no formal board action or recorded ownership is admitted."],
    families: ["franklin-avenue", "lighthouse-point"],
    relation_assertion: "applicant_of for C200184ZMK and C230356ZMK; a chair statement about Lighthouse Point.",
    negative_assertion: "A chair quote, a DOT presentation or testimony is never a formal board action; a shared applicant spelling is never recorded ownership.",
    destination: SERVED_DATA.roles,
    check: rolesCheck,
  },
  {
    id: "dated-history-states",
    delivered_by: { alias: "cf441d1ae90eb", pull_requests: [2390, 2391] },
    reads: ["time"],
    capability: "Reproducible as-of states separate planned, decided and realized events and keep component scope.",
    before_limitation: "A forecast, a partial opening and a preliminary measurement could read as the same kind of event.",
    route: SERVED_DATA.time,
    steps: ["Read the served temporal artifact.", "Confirm the Kingsbridge 2018 operation stays a planned forecast.", "Confirm the Lighthouse Point opening does not close the project and 31st Avenue results stay preliminary."],
    families: ["franklin-avenue", "kingsbridge-armory", "thirty-first-avenue", "lighthouse-point"],
    relation_assertion: "Franklin proposal epochs, Kingsbridge proposal epochs, Lighthouse Point component status and 31st Avenue periods are comparable as-of states.",
    negative_assertion: "The anticipated 2018 Kingsbridge operation is never shown as an opening; a first-phase opening never closes the whole project.",
    destination: SERVED_DATA.time,
    check: timeCheck,
  },
  {
    id: "parcel-history-reader",
    delivered_by: { alias: "ce1c513c690f5", pull_requests: [2381, 2384] },
    reads: ["parcel_manifest", "parcel_shards", "parcel_population"],
    capability: "Every admitted parcel is served through a generation-checked manifest reader.",
    before_limitation: "The reader loaded one shard and selected only the first parcel.",
    route: SERVED_DATA.parcel_manifest,
    steps: ["Read the served manifest.", "Read every shard it declares.", "Confirm one generation and that the reader traverses every declared parcel."],
    families: ["coyle", "kingsbridge-armory"],
    relation_assertion: "The manifest generation equals every shard generation and the parcel count equals the traversed parcels.",
    negative_assertion: "A mixed-generation shard is never read as a successful history.",
    destination: "/parcels/3073670011/",
    check: parcelCheck,
  },
  {
    id: "search-history-discovery",
    delivered_by: { alias: "cf369ad9238fe", pull_requests: [2399, 2418] },
    reads: ["journeys"],
    capability: "Search exposes each fixed history with dated events, official sources, a continuation and working Back navigation.",
    before_limitation: "A resident could not reach these histories from an address, case or project name.",
    route: "/search/?q=<fixed query>&source_scope=all#connected-history",
    steps: ["Open Search with each fixed query at the desktop-keyboard and narrow-touch viewports.", "Inspect and dismiss one event, open its official source, return, and follow the continuation.", "Repeat with scripting disabled."],
    families: DOSSIER_FAMILIES,
    relation_assertion: "Each fixed query renders its own family with at least one dated event and more than one retained identity.",
    negative_assertion: "Internal method fields never render, and an unavailable load is never shown as an empty history.",
    destination: "Official publisher source and the family continuation link",
    check: journeyCheck,
  },
  {
    id: "board-coverage-census",
    delivered_by: { alias: "cea7b8f3a22f7", pull_requests: [2410] },
    reads: ["coverage"],
    capability: "An operator census reports all 59 boards by acquisition and discovery stage against the frozen population.",
    before_limitation: "Gaps between boards were invisible, so absence could read as inactivity.",
    route: SERVED_DATA.coverage,
    steps: ["Read the served coverage census.", "Confirm every snapshot enumerates 59 boards.", "Confirm zero-denominator scores stay not estimable and the civic-activity disclaimer is present."],
    families: DOSSIER_FAMILIES,
    relation_assertion: "Each board row separates registry coverage, acquired documents, extractable records, admitted relations and discoverable histories.",
    negative_assertion: "Unknown is never measured zero, and no row claims a level of civic activity.",
    destination: "/data-sources#history-coverage",
    check: coverageCheck,
  },
]);

/** Evaluate one capability against the provided artifacts and context. */
export function evaluateCapability(definition, artifacts, context) {
  const result = definition.check(artifacts);
  const failures = [...result.failures];
  const status = failures.length === 0 ? "passed" : "failed";
  const vintage = {};
  for (const key of definition.reads) {
    const receipt = context.data?.[key];
    if (receipt) vintage[key] = receipt.generated_at ?? null;
  }
  const limits = [...(result.limits || [])];
  if (context.evidence_class !== "deployed_production_read_back") {
    limits.push("Not read from the deployed production origin in this run.");
  }
  return {
    id: definition.id,
    delivered_by: definition.delivered_by,
    capability: definition.capability,
    before_limitation: definition.before_limitation,
    route: definition.route,
    steps: definition.steps,
    expected_native_ids: dossierIds(definition.families),
    relation_assertion: definition.relation_assertion,
    negative_assertion: definition.negative_assertion,
    observed: { status, failures, result: result.observed },
    destination: definition.destination,
    revisions: {
      code: context.code_revision,
      data: Object.fromEntries(definition.reads.filter((key) => context.data?.[key]).map((key) => [key, context.data[key].sha256])),
      deploy: context.served_revision,
    },
    vintage,
    evidence_class: context.evidence_class,
    unresolved_limits: limits,
    realized_outcome: status === "passed"
      ? (limits.length ? "delivered_with_recorded_limits" : "delivered")
      : "not_realized",
  };
}

/**
 * Find admitted joins contradicted by a retained judgment or by a retained
 * rejection of the same pair. Found joins are withheld from the realized
 * count; the original judgment rows are preserved unchanged in the output.
 */
export function auditAdmittedFalsePositives(artifacts) {
  const relations = Array.isArray(artifacts.relations?.relations) ? artifacts.relations.relations : [];
  const rejections = Array.isArray(artifacts.relations?.rejections) ? artifacts.relations.rejections : [];
  const judgments = Array.isArray(artifacts.cohort?.judgments) ? artifacts.cohort.judgments : [];
  const contaminated = Array.isArray(artifacts.coverage?.evaluation?.contaminated_samples)
    ? artifacts.coverage.evaluation.contaminated_samples
    : [];
  const found = [];
  for (const row of relations) {
    const key = relationKey(row.from, row.relation, row.to);
    for (const rejection of rejections) {
      if (admittedOnRejectedBasis(row, rejection)) {
        found.push({ relation: key, basis: "retained_rejection_of_same_pair", evidence: structuredClone(rejection) });
      }
    }
    for (const judgment of judgments) {
      if (!ADMISSION_CONTRADICTING_JUDGMENTS.includes(judgment.judgment)) continue;
      const touches = judgment.subject_id === row.from || judgment.subject_id === row.to;
      const sameRelation = !judgment.relation || judgment.relation === row.relation;
      if (touches && sameRelation) {
        found.push({ relation: key, basis: "independent_source_judgment", evidence: structuredClone(judgment) });
      }
    }
  }
  return {
    judged_relations: judgments.filter((row) => row.relation).length,
    judgment_counts: judgments.reduce((counts, row) => ({ ...counts, [row.judgment]: (counts[row.judgment] || 0) + 1 }), {}),
    contaminated_samples: contaminated.length,
    admitted_false_positives: found,
    withheld_relations: sortedUnique(found.map((row) => row.relation)),
    status: found.length === 0 ? "none_found" : "withheld",
  };
}

function cronNext(cron, after) {
  const [minute, hour] = cron.split(/\s+/).map(Number);
  const next = new Date(after);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(hour, minute);
  if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Next scheduled publication attempt after an instant, from the fixed crons. */
export function nextScheduledCheck(observedAt) {
  const after = new Date(observedAt);
  const candidates = SCHEDULED_PUBLICATION_WORKFLOWS.map((entry) => cronNext(entry.cron, after));
  return new Date(Math.min(...candidates.map((value) => value.getTime()))).toISOString();
}

/**
 * Classify the scheduled acquisition -> materialization -> serving cycle.
 *
 * `observations` lists, per scheduled workflow, the runs created after the
 * release deployment with their pull request and served-ancestry facts.
 */
export function scheduledCycleStatus({ release_deployed_at: deployedAt, observed_at: observedAt, observations, journeys_passed_after_cycle: journeys, unchanged_history_bytes: unchanged, served_cycle_receipt: servedReceipt = null }) {
  const deadline = new Date(new Date(deployedAt).getTime() + SCHEDULED_READBACK_WINDOW_DAYS * 86_400_000).toISOString();
  const runs = (observations || []).flatMap((entry) => (entry.runs || []).map((run) => ({ workflow: entry.workflow, ...run })));
  const eligible = runs.filter((run) => run.event === "schedule" && run.created_at > deployedAt);
  const served = eligible.find((run) => run.conclusion === "success" && run.merge_commit && run.served_contains_merge === true);
  const base = {
    release_deployed_at: deployedAt,
    readback_deadline: deadline,
    scheduled_runs_after_release: eligible.map((run) => ({
      workflow: run.workflow,
      run_id: run.run_id,
      created_at: run.created_at,
      conclusion: run.conclusion,
      pull_request: run.pull_request ?? null,
      merge_commit: run.merge_commit ?? null,
      served_contains_merge: run.served_contains_merge ?? null,
    })),
    // The receipt the origin served during this read-back, whichever run wrote it.
    served_cycle_receipt: servedReceipt,
  };
  if (!observations) {
    return { ...base, status: "open", reason: "scheduled runs were not queried in this read-back", next_check_at: nextScheduledCheck(observedAt) };
  }
  if (!served) {
    const reason = eligible.length === 0
      ? "no scheduled publication run has started since the release deployment"
      : "no scheduled run since the release deployment has been merged and served yet";
    return { ...base, status: observedAt > deadline ? "overdue" : "open", reason, next_check_at: nextScheduledCheck(observedAt) };
  }
  const repeated = Array.isArray(journeys) ? journeys.filter((family) => family !== CB15_FAMILY) : [];
  if (repeated.length === 0 || unchanged !== true) {
    return {
      ...base,
      status: "open",
      reason: repeated.length === 0
        ? "a cycle was served but no non-CB15 journey passed after it"
        : "a cycle was served but the history materializations changed without an acquisition",
      observed_cycle: { workflow: served.workflow, run_id: served.run_id, merge_commit: served.merge_commit },
      next_check_at: nextScheduledCheck(observedAt),
    };
  }
  return {
    ...base,
    status: "observed",
    observed_cycle: { workflow: served.workflow, run_id: served.run_id, merge_commit: served.merge_commit },
    non_cb15_journeys_after_cycle: repeated,
    unchanged_history_bytes: true,
    next_check_at: null,
  };
}

/**
 * Facts read from a read-back, one per observable clause. Each is a pure
 * function of the read-back; nothing here is set by the runner.
 */
export const ACCEPTANCE_CONDITIONS = Object.freeze({
  production_origin: (readback) => readback.evidence_class === "deployed_production_read_back"
    && readback.delivery?.served_contains_delivery === true,
  complete_records: (readback) => {
    const records = readback.capabilities || [];
    return records.length === CAPABILITIES.length
      && records.every((record) => RECORD_FIELDS.every((field) => record[field] !== undefined && record[field] !== null));
  },
  all_capabilities_passed: (readback) => (readback.capabilities || []).every((record) => record.observed?.status === "passed"),
  six_journeys_passed: (readback) => {
    const journeys = (readback.capabilities || []).find((record) => record.id === "search-history-discovery");
    return journeys?.observed?.result?.families_passed?.length === DOSSIER_FAMILIES.length;
  },
  false_positives_withheld: (readback) => {
    const audit = readback.false_positive_audit || {};
    return audit.status === "none_found"
      || (audit.status === "withheld" && (audit.admitted_false_positives || []).every((row) => (audit.withheld_relations || []).includes(row.relation)));
  },
  scheduled_cycle_classified: (readback) => ["observed", "open", "overdue"].includes(readback.scheduled_cycle?.status),
  no_citywide_completeness_claim: (readback) => coverageLimits(readback).some((limit) => /does not claim citywide completeness/.test(limit)),
  no_equal_activity_claim: (readback) => coverageLimits(readback).some((limit) => /does not measure or equalize civic activity/.test(limit)),
  outcomes_reported: (readback) => {
    const records = readback.capabilities || [];
    return records.length > 0
      && records.every((record) => typeof record.realized_outcome === "string" && Array.isArray(record.unresolved_limits));
  },
  destinations_are_existing_routes: (readback) => (readback.capabilities || []).every((record) => (
    CAPABILITIES.some((definition) => definition.id === record.id && definition.destination === record.destination)
  )),
  scheduled_cycle_observed: (readback) => readback.scheduled_cycle?.status === "observed",
  scheduled_cycle_overdue: (readback) => readback.scheduled_cycle?.status === "overdue",
  observed_cycle_receipt: (readback) => Boolean(readback.scheduled_cycle?.observed_cycle?.run_id),
  dossier_only: (readback) => {
    const journeys = (readback.capabilities || []).find((record) => record.id === "search-history-discovery");
    return CAPABILITIES.every((definition) => definition.families.every((family) => DOSSIER_FAMILIES.includes(family)))
      && (journeys?.observed?.result === null || journeys?.observed?.result?.expected === DOSSIER_FAMILIES.length * JOURNEY_VIEWPORTS.length);
  },
});

function coverageLimits(readback) {
  return (readback.capabilities || []).find((record) => record.id === "board-coverage-census")?.unresolved_limits || [];
}

/**
 * Each acceptance letter split into its clauses. Every clause quotes a span
 * of its letter and names either the conditions that observe it or, when this
 * repository cannot observe it, what is unobservable. A letter reads `met` only
 * when every clause is observed and holds; when every observable clause holds
 * but one is unobservable, the letter reads its `unobserved` state instead.
 * A failed condition yields `open`, or `overdue` where the letter sets a
 * deadline that has passed.
 */
export const ACCEPTANCE_LETTERS = Object.freeze({
  A1: Object.freeze({
    letter: "Record exact query/route, steps, expected native IDs, relation and negative assertion, observed result, destination, code/data/deploy revisions, vintage and evidence class for each delivered capability; all six histories pass rendered release journeys.",
    clauses: [
      { span: "Record exact query/route, steps, expected native IDs, relation and negative assertion, observed result, destination, code/data/deploy revisions, vintage and evidence class", conditions: ["complete_records"] },
      { span: "for each delivered capability", conditions: ["complete_records", "all_capabilities_passed"] },
      { span: "all six histories pass rendered release journeys", conditions: ["production_origin", "six_journeys_passed"] },
    ],
  }),
  A2: Object.freeze({
    letter: "Correct or withhold every admitted false-positive join found in evaluation, preserving original failures; unobserved scheduled runs and unavailable public routes leave acceptance open; no claim of equal board activity or complete citywide coverage.",
    clauses: [
      { span: "Correct or withhold every admitted false-positive join found in evaluation, preserving original failures", conditions: ["false_positives_withheld"] },
      { span: "unobserved scheduled runs", conditions: ["scheduled_cycle_classified"] },
      { span: "unavailable public routes leave acceptance open", conditions: ["production_origin"] },
      { span: "no claim of equal board activity", conditions: ["no_equal_activity_claim"] },
      { span: "complete citywide coverage", conditions: ["no_citywide_completeness_claim"] },
    ],
  }),
  A3: Object.freeze({
    letter: "Deliver the release test and a read-only capability-check runner with retained outputs; observe a real scheduled acquisition, materialization and serving cycle, then repeat a journey outside Brooklyn Community Board 15 and an unchanged-source/idempotency check.",
    clauses: [
      { span: "Deliver the release test and a read-only capability-check runner with retained outputs", conditions: ["complete_records"] },
      // scheduledCycleStatus returns "observed" only after a served scheduled run,
      // a repeated journey outside the board and byte-identical history files.
      { span: "observe a real scheduled acquisition, materialization and serving cycle", conditions: ["scheduled_cycle_observed"] },
      { span: "repeat a journey outside Brooklyn Community Board 15", conditions: ["scheduled_cycle_observed"] },
      { span: "an unchanged-source/idempotency check", conditions: ["scheduled_cycle_observed"] },
    ],
  }),
  A4: Object.freeze({
    letter: "Write realized outcomes and acceptance evidence through existing realization records for later reviewers; include remaining coverage limits and do not build or publish a separate weekly update.",
    unobserved: "write_through_unobserved",
    clauses: [
      {
        span: "through existing realization records for later reviewers",
        unobservable: "The realization records live outside this repository; no read-back fact observes a write to them, their target, or what they carry.",
      },
      { span: "Write realized outcomes and acceptance evidence", conditions: ["complete_records", "outcomes_reported"] },
      { span: "include remaining coverage limits", conditions: ["outcomes_reported", "no_citywide_completeness_claim"] },
      { span: "do not build or publish a separate weekly update", conditions: ["destinations_are_existing_routes"] },
    ],
  }),
  A5: Object.freeze({
    letter: "Begin read-back at the first scheduled cycle after deployment, within seven days; retain the observed receipt or keep the obligation open with the next check date.",
    overdue: "scheduled_cycle_overdue",
    clauses: [
      { span: "Begin read-back at the first scheduled cycle after deployment, within seven days", conditions: ["scheduled_cycle_observed"] },
      { span: "retain the observed receipt", conditions: ["observed_cycle_receipt"] },
      { span: "keep the obligation open with the next check date", conditions: ["scheduled_cycle_classified"] },
    ],
  }),
  A6: Object.freeze({
    letter: "Implement from the fixed six-case dossier and existing retained inputs only; do not search for or substitute additional examples. Missing sample strata and insufficient retained evidence are reportable outcomes, never positive-example quotas.",
    clauses: [
      { span: "Implement from the fixed six-case dossier and existing retained inputs only", conditions: ["dossier_only"] },
      { span: "do not search for or substitute additional examples", conditions: ["dossier_only"] },
      { span: "Missing sample strata and insufficient retained evidence are reportable outcomes, never positive-example quotas", conditions: ["outcomes_reported"] },
    ],
  }),
});

/**
 * Names the clause-table derivation. Read-backs retained before it carry no
 * rule name and were derived by an earlier expression whose A4 read `met`
 * without observing the write-through.
 */
export const ACCEPTANCE_RULE = "letter-clauses.v1";

/** Derive one letter's state from the condition values it reads. */
export function deriveLetter(letter, values) {
  const definition = ACCEPTANCE_LETTERS[letter];
  const observable = definition.clauses.filter((clause) => clause.conditions);
  const holds = observable.every((clause) => clause.conditions.every((name) => values[name] === true));
  if (!holds) return definition.overdue && values[definition.overdue] === true ? "overdue" : "open";
  return definition.clauses.some((clause) => clause.unobservable) ? definition.unobserved : "met";
}

/** Derive acceptance from a read-back. Nothing here is set by the runner. */
export function deriveAcceptance(readback) {
  const values = Object.fromEntries(Object.entries(ACCEPTANCE_CONDITIONS).map(([name, condition]) => [name, condition(readback) === true]));
  return Object.fromEntries(Object.keys(ACCEPTANCE_LETTERS).map((letter) => [letter, deriveLetter(letter, values)]));
}

export { RECORD_FIELDS, EXPECTED_RELATIONS, MERGE_REJECTIONS, ROLE_REJECTIONS };
