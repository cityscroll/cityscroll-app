/**
 * Community board budget request register: source-qualified requests and the
 * agency responses published against them.
 *
 * The NYC Office of Management and Budget publishes one row per community
 * board request per budget publication. Two publications in the same fiscal
 * cycle carry the same requests with the responses as they stood on each
 * publication day, so the same request can be read twice and the answer
 * compared. That comparison is the whole point of retaining the register, and
 * it is also the easiest thing to get wrong, so this module is deliberately
 * narrow about what a difference means.
 *
 * What the register establishes
 * -----------------------------
 * A board asked for something, an agency answered it in writing, and the
 * answer read one way in one publication and another way in the next. Nothing
 * more. A changed response is a changed response: it is not money, not a
 * commitment, not delivery, and not evidence that anything was built. The
 * publisher's own wrapper sentence and the round label ("Executive",
 * "Adopted") move between publications on their own, which is why every
 * comparison here is published twice — once over the source text and once with
 * only those two boilerplate differences removed — instead of collapsing to a
 * single "changed" flag a reader would have to trust.
 *
 * Identity
 * --------
 * The publisher's full tracking code identifies a request inside one fiscal
 * cycle, and only inside it. The suffix is part of the code: a continued
 * support request `...CS` is a different request from the capital request
 * `...C` that shares its digits, and this module never truncates a code to
 * make two rows meet. Across fiscal cycles the publisher mints new codes, so
 * no annual lineage is derived here — not from a repeated priority number, not
 * from a similar facility name, not from matching request text.
 *
 * Board identity uses the publisher's own borough code (1 Bronx, 2 Brooklyn,
 * 3 Manhattan, 4 Queens, 5 Staten Island). That numbering is the publisher's
 * and differs from the leading digit of a BBL; nothing here reads one as the
 * other.
 *
 * Agency identity
 * ---------------
 * The publisher writes agency names as free text. A label binds to an
 * institution this repository already carries, by exact reviewed alias only.
 * A label with no existing institution stays unbound and keeps its source
 * spelling; it never mints a new institution and it is never matched by
 * similarity.
 */

import { resolveAgencyIdentity } from "../../site/agency_identity.mjs";

export const COMMUNITY_BOARD_BUDGET_REGISTER_SCHEMA = "cityscroll.community_board_budget_register.v1";
export const COMMUNITY_BOARD_BUDGET_REGISTER_DOCUMENT_SCHEMA = "cityscroll.community_board_budget_register_document.v1";
export const COMMUNITY_BOARD_BUDGET_REGISTER_METHOD = "omb_register_full_tracking_code_within_cycle_v1";
export const COMMUNITY_BOARD_BUDGET_REGISTER_NEGATIVE_RULE =
  "A changed response text is a changed written answer and nothing else. It is not funding, a commitment, delivery, or completion, and no request is carried across fiscal cycles by a repeated priority number, a similar facility name, or matching request text.";

export const COMMUNITY_BOARD_BUDGET_REGISTER_DATASET_ID = "vn4m-mk4t";

/** The publisher's borough numbering, which is not the BBL leading digit. */
export const PUBLISHER_BOROUGH_CODES = Object.freeze({
  1: "bronx",
  2: "brooklyn",
  3: "manhattan",
  4: "queens",
  5: "staten-island",
});

/**
 * Budget request classes the publisher encodes in the tracking-code suffix.
 * `CS` is its own class and must never be read as a `C` row.
 */
export const BUDGET_REQUEST_TYPES = Object.freeze({
  C: "capital",
  E: "expense",
  CS: "continued-support",
});

/**
 * Exact publisher spellings a reviewer bound to an institution this repository
 * already carries, where the shared agency resolver does not reach them.
 *
 * Every value must already be an agency identity in this repository. Adding a
 * spelling here can only point at an institution that exists; it can never
 * create one.
 */
export const REVIEWED_PUBLISHER_AGENCY_ALIASES = Object.freeze({
  "City University of New York": "city-university",
  "Dept of Information Technology & Telecommunication": "information-technology-and-telecommunications",
  "Economic Development Corporation": "economic-development-corporation",
  "Health and Hospitals Corporation": "nyc-health-hospitals",
  "Mayor's Office of Management and Budget": "management-and-budget",
  "Transit Authority": "n-y-c-transit-authority",
});

/**
 * Publisher spellings a reviewer looked at and could not bind, with the reason.
 *
 * These stay unbound on purpose. Recording the review keeps the next reader
 * from re-deciding the same label by guess, and keeps an unbound label from
 * quietly becoming a new institution this repository does not carry.
 */
export const REVIEWED_UNBOUND_PUBLISHER_AGENCIES = Object.freeze({
  "Brooklyn Public Library": "no_existing_institution",
  "CITYWIDE EVENT COORDINATION AND MANAGEMENT": "no_existing_institution",
  "Mayor's Office of Media and Entertainment": "no_existing_institution",
  "New York Public Library": "no_existing_institution",
  "Queens Borough Public Library": "no_existing_institution",
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const TRACKING_CODE = /^([1-5])(\d{2})(\d{4})(\d{2})(C|E|CS)$/;
const PUBLICATION_ID = /^\d{8}$/;

/**
 * Location columns the publisher carries, under the names this register uses.
 *
 * Only 496 of 3,809 rows in a retained publication carry a street value and
 * only 123 carry a BBL, so an observation publishes the fields the publisher
 * filled and nothing else. A field the publisher left empty is absent, not
 * zero and not a placeholder; the publisher's own `council_disctrict` spelling
 * is read once here and never repeated downstream.
 */
const LOCATION_FIELDS = Object.freeze({
  site_street: "site_street",
  cross_street_1: "cross_street_1",
  cross_street_2: "cross_street_2",
  street: "street",
  block: "block",
  lot: "lot",
  postcode: "postcode",
  latitude: "latitude",
  longitude: "longitude",
  bin: "bin",
  bbl: "bbl",
  council_district: "council_disctrict",
  census_tract: "census_tract",
  nta: "nta",
});

/** The publisher fields one register observation retains, in retained order. */
export const RETAINED_OBSERVATION_FIELDS = Object.freeze([
  "publication",
  "boro",
  "board",
  "priority",
  "tracking_code",
  "request",
  "explanation",
  "response",
  "responded_by",
  "responsible_agency",
  "support_by_1",
  "support_by_2",
  "site_street",
  "cross_street_1",
  "cross_street_2",
  "street",
  "block",
  "lot",
  "postcode",
  "latitude",
  "longitude",
  "council_disctrict",
  "bin",
  "bbl",
  "census_tract",
  "nta",
]);

function text(value, max = 20000) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A publisher value kept as published, or null when the publisher left it empty. */
function retained(value) {
  const kept = text(value);
  return kept ? kept : null;
}

/** The publication identifier as an ISO day, or null when it is not one. */
export function publicationDay(publication) {
  const id = text(publication, 8);
  if (!PUBLICATION_ID.test(id)) return null;
  const day = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
  return Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) ? day : null;
}

/**
 * The parts of a full tracking code, or null when the code is not one.
 *
 * A code that does not parse is never repaired into one that does. `2142027`
 * and `214202701` are not shortened forms of `214202701C`; they are not
 * tracking codes at all.
 */
export function parseTrackingCode(value) {
  const code = text(value, 16).toUpperCase();
  const match = TRACKING_CODE.exec(code);
  if (!match) return null;
  const [, boro, board, fiscalYear, sequence, requestType] = match;
  return Object.freeze({
    tracking_code: code,
    boro_code: boro,
    board_code: board,
    fiscal_year: Number(fiscalYear),
    sequence,
    request_type: requestType,
    request_class: BUDGET_REQUEST_TYPES[requestType],
  });
}

/** The canonical board identity for one publisher borough/board pair. */
export function boardIdFromPublisherCodes(boro, board) {
  const borough = PUBLISHER_BOROUGH_CODES[Number(text(boro, 2))];
  const district = text(board, 3).padStart(2, "0");
  if (!borough || !/^\d{2}$/.test(district) || district === "00") return null;
  return `${borough}-cb-${district}`;
}

/**
 * The comparison basis for response text as published.
 *
 * Only whitespace and letter case are neutralized, because a publisher that
 * rewraps a paragraph has not changed its answer. Every other character
 * difference counts.
 */
export function comparableResponseText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The comparison basis with the publisher's two moving boilerplate parts gone:
 * the wrapper sentence OMB puts in front of an agency position, and the round
 * label that names the publication the answer appeared in.
 *
 * A difference that survives this is a difference in the words about the
 * request. It is still not a decision, a commitment, or funding.
 */
export function boilerplateNormalizedResponseText(value) {
  return comparableResponseText(value)
    .replace(/^omb supports the agency.s position as follows:\s*/, "")
    .replace(/\bexecutive\b/g, "")
    .replace(/\badopted\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bind one publisher agency label to an institution this repository carries.
 *
 * Three outcomes and no fourth: the shared resolver reaches an identity that
 * exists here; a reviewer bound the exact spelling to one that exists here; or
 * the label stays unbound with its source spelling intact.
 */
export function resolveRegisterAgency(label, { knownAgencyIds } = {}) {
  const sourceLabel = text(label, 200);
  const known = knownAgencyIds instanceof Set ? knownAgencyIds : new Set(knownAgencyIds || []);
  if (!sourceLabel) {
    return Object.freeze({ source_label: null, agency_id: null, binding: "source_does_not_establish", method: null });
  }
  const reviewed = REVIEWED_PUBLISHER_AGENCY_ALIASES[sourceLabel];
  if (reviewed && known.has(reviewed)) {
    return Object.freeze({
      source_label: sourceLabel,
      agency_id: reviewed,
      binding: "bound",
      method: "reviewed_exact_publisher_alias",
    });
  }
  const resolved = resolveAgencyIdentity(sourceLabel);
  if (resolved?.canonical_id && known.has(resolved.canonical_id)) {
    return Object.freeze({
      source_label: sourceLabel,
      agency_id: resolved.canonical_id,
      binding: "bound",
      method: resolved.matched ? "shared_agency_alias_register" : "shared_agency_identity_exact_id",
    });
  }
  return Object.freeze({
    source_label: sourceLabel,
    agency_id: null,
    binding: "unbound",
    method: null,
    review: REVIEWED_UNBOUND_PUBLISHER_AGENCIES[sourceLabel] || "not_reviewed",
  });
}

/**
 * Split the retained publications into the ones a reader may be shown as of a
 * day, and the ones retained only as diagnostics.
 *
 * The publisher has shipped a publication dated after the day it was read. That
 * row is real and is kept exactly as published; it is simply not allowed to
 * become the latest answer, because a publication that has not happened yet
 * cannot be the current one. Its date is never rewritten to make it fit.
 */
export function selectPublications(publications, { asOf } = {}) {
  const day = text(asOf, 10);
  const rows = [...new Set((publications || []).map((value) => text(value, 8)).filter((value) => PUBLICATION_ID.test(value)))].sort();
  const servable = [];
  const diagnostic = [];
  for (const publication of rows) {
    const published = publicationDay(publication);
    if (day && published && published > day) diagnostic.push(publication);
    else servable.push(publication);
  }
  return Object.freeze({
    as_of: day || null,
    servable,
    diagnostic_only: diagnostic,
    latest: servable.length ? servable[servable.length - 1] : null,
  });
}

function observation(row, publication) {
  const kept = {};
  for (const field of RETAINED_OBSERVATION_FIELDS) kept[field] = retained(row?.[field]);
  kept.publication = text(publication, 8) || kept.publication;
  return kept;
}

/**
 * The rank the publisher published on a row, scoped to the agency and request
 * class it was published under.
 *
 * The publisher restarts these numbers per agency, so one board can hold ten
 * requests numbered 01. The scope travels with the number, and the agency and
 * request class it is scoped to are on the observation beside it; a bare "1"
 * from this register means nothing on its own and must never be rendered as a
 * district-wide ranking.
 */
export function scopedRank({ priority }) {
  const value = text(priority, 8);
  if (!value) return null;
  return Object.freeze({ value, scope: "agency_and_request_class", district_wide: false });
}

/**
 * A display title for a request whose `request` field the publisher left empty.
 *
 * The row is kept — a request with an explanation, a response and a location is
 * a real request — and the substitute is labelled derived so no reader mistakes
 * it for something the publisher wrote.
 */
export function derivedRequestTitle(row) {
  const explanation = text(row?.explanation, 400);
  if (!explanation) return null;
  const firstSentence = explanation.split(/(?<=[.!?])\s+/)[0] || explanation;
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117).trimEnd()}...` : firstSentence;
}

/** The publisher location fields that carry a value, or null when none do. */
export function publishedLocation(row) {
  const location = {};
  for (const [key, field] of Object.entries(LOCATION_FIELDS)) {
    if (row?.[field]) location[key] = row[field];
  }
  return Object.keys(location).length ? location : null;
}

function compareVersions(a, b) {
  return a.publication.localeCompare(b.publication);
}

/**
 * Materialize the register from one or more frozen publication populations.
 *
 * `publications` is an ordered list of `{ publication, rows }`, where rows are
 * the publisher's own rows for that publication. Every row is retained; a row
 * that cannot be given an identity is reported, never dropped silently.
 */
export function buildCommunityBoardBudgetRegister({
  publications = [],
  boardIds = [],
  agencyIds = [],
  asOf = null,
  acquiredAt = null,
  datasetId = COMMUNITY_BOARD_BUDGET_REGISTER_DATASET_ID,
} = {}) {
  const knownBoards = new Set(boardIds);
  const knownAgencies = new Set(agencyIds);
  const publicationIds = publications.map((entry) => text(entry?.publication, 8)).filter(Boolean);
  // The lineage table is published once per publication rather than once per
  // observation: 7,618 copies of the same dataset id would say nothing the one
  // copy does not, and would bury the differences a reader came to compare.
  const publicationLineage = publications
    .filter((entry) => text(entry?.publication, 8))
    .map((entry) => ({
      publication: text(entry.publication, 8),
      publication_date: publicationDay(entry.publication),
      dataset_id: datasetId,
      source_url: `https://data.cityofnewyork.us/d/${datasetId}`,
      retained_fixture: text(entry?.lineage?.fixture, 300) || null,
      retained_fixture_sha256: text(entry?.lineage?.sha256, 64) || null,
      published_row_count: Number.isFinite(Number(entry?.lineage?.published_row_count))
        ? Number(entry.lineage.published_row_count)
        : null,
      retained_rows: Array.isArray(entry?.rows) ? entry.rows.length : 0,
    }))
    .sort((a, b) => a.publication.localeCompare(b.publication));
  const selection = selectPublications(publicationIds, { asOf });
  const servable = new Set(selection.servable);

  const requests = new Map();
  const agencyLabels = new Map();
  const unidentified = [];
  const unboundBoardRows = [];
  let retainedRows = 0;

  for (const entry of publications) {
    const publication = text(entry?.publication, 8);
    const day = publicationDay(publication);
    for (const raw of Array.isArray(entry?.rows) ? entry.rows : []) {
      retainedRows += 1;
      const kept = observation(raw, publication);
      const identity = parseTrackingCode(kept.tracking_code);
      if (!identity) {
        unidentified.push({ publication, tracking_code: kept.tracking_code, reason: "tracking_code_not_parseable" });
        continue;
      }
      const boardId = boardIdFromPublisherCodes(kept.boro, kept.board);
      const boardKnown = Boolean(boardId) && knownBoards.has(boardId);
      if (!boardKnown) {
        unboundBoardRows.push({
          publication,
          tracking_code: identity.tracking_code,
          boro: kept.boro,
          board: kept.board,
          reason: boardId ? "board_id_not_in_registry" : "borough_or_district_not_publishable",
        });
      }
      const agency = resolveRegisterAgency(kept.responsible_agency, { knownAgencyIds: knownAgencies });
      if (agency.source_label) {
        const seen = agencyLabels.get(agency.source_label) || { ...agency, observations: 0 };
        seen.observations += 1;
        agencyLabels.set(agency.source_label, seen);
      }

      // A request identity is the full tracking code inside its own fiscal
      // cycle. The cycle stays in the key even though the code already carries
      // it, so no later publisher change can quietly merge two cycles.
      const key = `${identity.fiscal_year}:${identity.tracking_code}`;
      let request = requests.get(key);
      if (!request) {
        request = {
          tracking_code: identity.tracking_code,
          fiscal_year: identity.fiscal_year,
          request_type: identity.request_type,
          request_class: identity.request_class,
          board_id: boardKnown ? boardId : null,
          board_binding: boardKnown ? "bound" : "unbound",
          publisher_boro: kept.boro,
          publisher_board: kept.board,
          versions: [],
        };
        requests.set(key, request);
      }
      request.versions.push({
        publication,
        publication_date: day,
        servable: servable.has(publication),
        responsible_agency: agency,
        responded_by: kept.responded_by,
        request: kept.request,
        ...(kept.request ? {} : { request_title_derived: derivedRequestTitle(kept), title_is_derived: true }),
        explanation: kept.explanation,
        response: kept.response,
        rank: scopedRank({ priority: kept.priority }),
        location: publishedLocation(kept),
        ...(kept.support_by_1 || kept.support_by_2
          ? { support_by: [kept.support_by_1, kept.support_by_2].filter(Boolean) }
          : {}),
      });
    }
  }

  let sourceTextDiffers = 0;
  let normalizedDiffers = 0;
  let comparablePairs = 0;
  let derivedTitles = 0;
  let diagnosticVersions = 0;
  const rows = [];
  for (const request of [...requests.values()].sort((a, b) => (
    a.fiscal_year - b.fiscal_year || a.tracking_code.localeCompare(b.tracking_code)
  ))) {
    request.versions.sort(compareVersions);
    derivedTitles += request.versions.filter((version) => version.request_title_derived).length;
    diagnosticVersions += request.versions.filter((version) => !version.servable).length;
    // Only publications a reader may be shown are compared. An answer the
    // publisher dated in the future has not been given yet, so it cannot be
    // the thing an earlier answer changed into; it stays retained beside the
    // request and out of every count of what changed.
    const comparable = request.versions.filter((version) => version.servable);
    const comparisons = [];
    for (let index = 1; index < comparable.length; index += 1) {
      const before = comparable[index - 1];
      const after = comparable[index];
      const rawDiffers = comparableResponseText(before.response) !== comparableResponseText(after.response);
      const strippedDiffers = boilerplateNormalizedResponseText(before.response) !== boilerplateNormalizedResponseText(after.response);
      comparablePairs += 1;
      if (rawDiffers) sourceTextDiffers += 1;
      if (strippedDiffers) normalizedDiffers += 1;
      comparisons.push({
        from_publication: before.publication,
        to_publication: after.publication,
        source_text_differs: rawDiffers,
        differs_after_boilerplate_removed: strippedDiffers,
      });
    }
    rows.push({ ...request, response_comparisons: comparisons });
  }

  const boundAgencies = [...agencyLabels.values()].filter((row) => row.binding === "bound");
  const unboundAgencies = [...agencyLabels.values()].filter((row) => row.binding !== "bound");
  const boards = new Set(rows.map((row) => row.board_id).filter(Boolean));

  return {
    schema: COMMUNITY_BOARD_BUDGET_REGISTER_SCHEMA,
    method: COMMUNITY_BOARD_BUDGET_REGISTER_METHOD,
    negative_rule: COMMUNITY_BOARD_BUDGET_REGISTER_NEGATIVE_RULE,
    acquired_at: acquiredAt || null,
    // The materialization has no clock of its own: it is a pure function of the
    // retained publications, so the moment the publisher was read is also the
    // moment this artifact describes. A wall clock here would make every
    // rebuild differ and turn the staleness gate into a calendar check.
    materialized_at: acquiredAt || null,
    source: {
      publisher: "New York City Office of Management and Budget",
      name: "Register of Community Board Budget Requests",
      dataset_id: datasetId,
      source_url: `https://data.cityofnewyork.us/d/${datasetId}`,
      borough_code_map: PUBLISHER_BOROUGH_CODES,
      borough_code_note: "The publisher's borough numbering. It is not the leading digit of a BBL.",
    },
    publication_selection: selection,
    comparison_semantics: {
      source_text: "Whitespace and letter case neutralized; every other character difference counts.",
      boilerplate_removed: "Also removes the publisher's wrapper sentence and the round label that names the publication.",
      what_a_difference_means: "The written answer reads differently. It does not establish funding, a commitment, or delivery.",
    },
    publications: publicationLineage,
    counts: {
      publications: publicationIds.length,
      retained_rows: retainedRows,
      requests: rows.length,
      boards: boards.size,
      request_classes: Object.fromEntries(
        Object.keys(BUDGET_REQUEST_TYPES).map((type) => [type, rows.filter((row) => row.request_type === type).length]),
      ),
      versions_per_request: [...new Set(rows.map((row) => row.versions.length))].sort((a, b) => a - b),
      diagnostic_only_versions: diagnosticVersions,
      unidentified_rows: unidentified.length,
      rows_without_board_binding: unboundBoardRows.length,
      derived_request_titles: derivedTitles,
      agency_labels: agencyLabels.size,
      agency_labels_bound: boundAgencies.length,
      agency_labels_unbound: unboundAgencies.length,
      agency_observations_bound: boundAgencies.reduce((total, row) => total + row.observations, 0),
      comparable_version_pairs: comparablePairs,
      responses_differing_in_source_text: sourceTextDiffers,
      responses_differing_after_boilerplate_removed: normalizedDiffers,
    },
    agency_bindings: [...agencyLabels.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, row]) => ({
        source_label: label,
        agency_id: row.agency_id,
        binding: row.binding,
        method: row.method,
        review: row.review || null,
        observations: row.observations,
      })),
    unidentified_rows: unidentified,
    rows_without_board_binding: unboundBoardRows,
    requests: rows,
  };
}

/**
 * Split a materialized register into the header every reader starts from and
 * one document per board.
 *
 * Two reasons, and they point the same way. A board page wants one board, not
 * 3,809 requests across the city, so the per-board document is the read a
 * resident surface actually makes. And the register is re-acquired on a
 * schedule: the acquisition clock has to move every run for the freshness gate
 * to mean anything, so it lives in the small header while the request bodies —
 * which change only when the publisher issues a new publication — stay
 * byte-identical between refreshes instead of being rewritten wholesale.
 *
 * Each board document carries no clock of its own. Its vintage is the header's,
 * and the header names its digest, so a document can never be read as fresher
 * than the acquisition that produced it.
 */
export function shardCommunityBoardBudgetRegister(model, { documentPath = (boardId) => `${boardId}.json`, digest = null } = {}) {
  const { requests, ...header } = model;
  const byBoard = new Map();
  const unplaced = [];
  for (const request of requests) {
    if (!request.board_id) {
      unplaced.push(request);
      continue;
    }
    if (!byBoard.has(request.board_id)) byBoard.set(request.board_id, []);
    byBoard.get(request.board_id).push(request);
  }

  const documents = new Map();
  const index = [];
  for (const boardId of [...byBoard.keys()].sort()) {
    const rows = byBoard.get(boardId);
    const document = {
      schema: COMMUNITY_BOARD_BUDGET_REGISTER_DOCUMENT_SCHEMA,
      method: model.method,
      negative_rule: model.negative_rule,
      board_id: boardId,
      publications: model.publication_selection,
      request_count: rows.length,
      requests: rows,
    };
    documents.set(boardId, document);
    index.push({
      board_id: boardId,
      request_count: rows.length,
      document: documentPath(boardId),
      sha256: digest ? digest(document) : null,
    });
  }

  return {
    index: {
      ...header,
      boards: index,
      // A request the publisher gave a board identity this repository does not
      // carry has no document to live in, so it stays on the header rather
      // than being dropped or filed under a board it does not belong to.
      requests_without_a_board_document: unplaced,
    },
    documents,
  };
}

/** Structural checks a materialized register must pass before it is written. */
export function validateCommunityBoardBudgetRegister(model) {
  const errors = [];
  if (model?.schema !== COMMUNITY_BOARD_BUDGET_REGISTER_SCHEMA) errors.push("wrong schema");
  if (!Array.isArray(model?.requests) || !model.requests.length) errors.push("register has no requests");
  const seen = new Set();
  for (const request of model?.requests || []) {
    const key = `${request.fiscal_year}:${request.tracking_code}`;
    if (seen.has(key)) errors.push(`duplicate request identity ${key}`);
    seen.add(key);
    if (!parseTrackingCode(request.tracking_code)) errors.push(`unparseable tracking code ${request.tracking_code}`);
    if (request.board_binding === "bound" && !request.board_id) errors.push(`${request.tracking_code}: bound board without an id`);
    const publications = request.versions.map((version) => version.publication);
    if (new Set(publications).size !== publications.length) errors.push(`${request.tracking_code}: repeated publication`);
    for (const version of request.versions) {
      if (version.responsible_agency?.binding === "bound" && !version.responsible_agency.agency_id) {
        errors.push(`${request.tracking_code}: bound agency without an id`);
      }
      if (version.request && version.request_title_derived) {
        errors.push(`${request.tracking_code}: derived title published beside a source request`);
      }
    }
  }
  const servable = model?.publication_selection?.servable || [];
  for (const publication of model?.publication_selection?.diagnostic_only || []) {
    if (servable.includes(publication)) errors.push(`${publication}: publication is both servable and diagnostic-only`);
  }
  return Object.freeze({ ok: errors.length === 0, errors });
}
