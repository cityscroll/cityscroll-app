/**
 * "What this district asked city agencies for, and what they answered" — the
 * community board budget request browser, on both the board and the agency
 * side of the same record.
 *
 * The city's Office of Management and Budget publishes one row per community
 * board budget request per budget publication, so the same request appears
 * again in the next publication of the same fiscal cycle carrying the agency's
 * answer as it stood that day. CityScroll retains those publications and
 * materializes them into a register (`site/data/community_board_budget_register.json`
 * plus one document per board, written by
 * `tools/build_community_board_budget_register.mjs`). Until now the register
 * had no reader: a resident could not stand on their own board and ask what it
 * had requested, and could not stand on an agency and ask which districts had
 * asked it for something.
 *
 * This module is that reading, and it is deliberately one module for both
 * surfaces. A request has one identity — the publisher's full tracking code
 * inside one fiscal cycle — and a board page and an agency page that disagreed
 * about which requests exist would be two answers to one question.
 *
 * Four distinctions the copy holds open, because collapsing any of them is how
 * a list like this starts lying:
 *
 *  - a request is what the board asked for; a response is the written answer
 *    published for it on a date. Neither is funding, a commitment or delivery,
 *    and a supportive answer is not a project.
 *  - a priority number is the board's own ranking inside one agency and one
 *    budget type. Requests under different agencies share no scale, and nothing
 *    here is a citywide order.
 *  - an answer whose text changed only because the publisher's wrapper sentence
 *    moved is not a changed answer. The register measures both, and this
 *    reading says which one happened.
 *  - a publication the publisher dated after the day it was read is not a
 *    resident-facing answer. Only the servable publications are read here.
 *
 * Three states, kept apart: a board or agency with retained requests, one the
 * register holds none for — said about the register, never as a claim that the
 * board asked for nothing — and a register that could not be read.
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";

export const COMMUNITY_BOARD_BUDGET_REQUESTS_VIEW_SCHEMA = "cityscroll.community_board_budget_requests_view.v1";
export const AGENCY_BUDGET_REQUESTS_VIEW_SCHEMA = "cityscroll.agency_budget_requests_view.v1";

export const COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR = "board-budget-requests";
export const AGENCY_BUDGET_REQUESTS_ANCHOR = "agency-budget-requests";

/**
 * The version marker carried in the inspect payload. The schema identities
 * above name this module for its callers; the attribute payload carries only
 * this short integer, so no schema vocabulary reaches a resident-facing
 * document.
 */
export const BUDGET_REQUEST_PAYLOAD_VERSION = 1;

export const BUDGET_REQUEST_ATTRIBUTE = "data-budget-request";
export const BUDGET_REQUEST_LABELS_ATTRIBUTE = "data-budget-request-labels";
export const BUDGET_REQUEST_READY_ATTRIBUTE = "data-budget-requests-ready";
export const BUDGET_REQUEST_DIALOG_ID = "budget-request-inspect";
export const BUDGET_REQUEST_TITLE_ID = "budget-request-inspect-title";

/**
 * How many agency groups a board page opens with. The rest keep their heading,
 * their count and their own address, and open when that address is the page's
 * fragment — so choosing an agency is a real navigation the browser remembers.
 * A reader who follows a request out and comes back returns to the same agency
 * open at the same scroll offset, with no script involved.
 */
export const BUDGET_REQUEST_VISIBLE_GROUPS = 4;

/** How many boards an agency page lists before the rest move behind a disclosure. */
export const BUDGET_REQUEST_VISIBLE_BOARDS = 8;

/**
 * How many of one board's requests an agency page shows before handing off.
 *
 * An agency page states the whole population it is responsible for answering
 * and lists every board that asked, because those are the facts a reader on an
 * agency comes for. It does not restate every district's full submission: the
 * board's own page already holds that list in the board's own priority order,
 * and the handoff is a real link to exactly that scope.
 */
export const BUDGET_REQUEST_AGENCY_ROWS_PER_BOARD = 6;

/**
 * The ceiling on one published field.
 *
 * It is a guard against a malformed publisher row, not an editorial choice: it
 * sits an order of magnitude above the longest answer and the longest board
 * submission the retained publications hold, so no real record is shortened by
 * it. Shortening a published answer would be a quieter misreport than dropping
 * one, because a reader cannot see that it happened.
 */
export const BUDGET_REQUEST_TEXT_LIMIT = 20000;

export const BUDGET_REQUEST_STATES = Object.freeze({
  AVAILABLE: "available",
  NONE_RECORDED: "none_recorded",
  UNAVAILABLE: "unavailable",
});

const BUDGET_REQUEST_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BUDGET_REQUEST_BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const BUDGET_REQUEST_TRACKING_CODE = /^[0-9]{9}(?:C|E|CS)$/;
const BUDGET_REQUEST_AGENCY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function budgetRequestClean(value, max = 400) {
  return String(value ?? "")
    .replace(BUDGET_REQUEST_CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function budgetRequestIsoDay(value) {
  const day = budgetRequestClean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * A group address that is stable, unique and readable in a URL.
 *
 * A bound agency uses the route identity this site already publishes it under,
 * so the address on a board page and the agency's own route are the same word.
 * A label with no institution behind it is slugified from the publisher's own
 * spelling and prefixed, so it can never collide with a route identity.
 */
export function budgetRequestGroupSlug(agency) {
  const id = budgetRequestClean(agency?.agency_id, 80);
  if (BUDGET_REQUEST_AGENCY_ID.test(id)) return id;
  const label = budgetRequestClean(agency?.source_label, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label ? `named-${label}` : null;
}

function budgetRequestAgencyHref(agencyId) {
  const id = budgetRequestClean(agencyId, 80);
  return BUDGET_REQUEST_AGENCY_ID.test(id) ? `/agencies/${encodeURIComponent(id)}/` : null;
}

function budgetRequestAgency(row) {
  const sourceLabel = budgetRequestClean(row?.source_label, 200);
  if (!sourceLabel) return null;
  const agencyId = budgetRequestClean(row?.agency_id, 80);
  const bound = row?.binding === "bound" && BUDGET_REQUEST_AGENCY_ID.test(agencyId);
  return Object.freeze({
    source_label: sourceLabel,
    agency_id: bound ? agencyId : null,
    href: bound ? budgetRequestAgencyHref(agencyId) : null,
    binding: bound ? "bound" : "unbound",
  });
}

function budgetRequestRank(rank) {
  const value = budgetRequestClean(rank?.value, 12);
  if (!value) return null;
  return Object.freeze({
    value,
    scope: budgetRequestClean(rank?.scope, 60) || "agency_and_request_class",
    district_wide: rank?.district_wide === true,
  });
}

/**
 * One request, read from the register's retained versions.
 *
 * Only the servable publications take part. The publisher's forward-dated
 * release is retained by the register for diagnosis and is excluded here for
 * the same reason it is excluded there: it is not an answer anyone has been
 * given yet.
 */
function budgetRequestRow(request, { source }) {
  const code = budgetRequestClean(request?.tracking_code, 20).toUpperCase();
  if (!BUDGET_REQUEST_TRACKING_CODE.test(code)) return null;
  const versions = (Array.isArray(request?.versions) ? request.versions : [])
    .filter((version) => version?.servable === true);
  if (!versions.length) return null;
  const latest = versions[versions.length - 1];
  const agency = budgetRequestAgency(latest?.responsible_agency);
  if (!agency) return null;

  const comparisons = new Map(
    (Array.isArray(request?.response_comparisons) ? request.response_comparisons : [])
      .map((row) => [budgetRequestClean(row?.to_publication, 20), row]),
  );
  const answers = versions.map((version, index) => {
    const previous = index > 0 ? versions[index - 1] : null;
    const comparison = previous ? comparisons.get(budgetRequestClean(version?.publication, 20)) : null;
    return Object.freeze({
      publication: budgetRequestClean(version?.publication, 20),
      publication_date: budgetRequestIsoDay(version?.publication_date),
      // The publisher's answer is carried whole. A truncated answer would be a
      // quieter misreport than an absent one: the sentence that changes an
      // answer's meaning is as often the last one as the first.
      response: budgetRequestClean(version?.response, BUDGET_REQUEST_TEXT_LIMIT) || null,
      previous_publication_date: previous ? budgetRequestIsoDay(previous?.publication_date) : null,
      // "Changed" means the answer reads differently once the publisher's own
      // wrapper sentence and round label are set aside. A publication where
      // only that wrapper moved is reported as exactly that, because reading it
      // as a new answer would invent a civic event out of a budget stage label.
      changed: comparison ? comparison.differs_after_boilerplate_removed === true : null,
      wrapper_only: comparison
        ? comparison.source_text_differs === true && comparison.differs_after_boilerplate_removed !== true
        : null,
    });
  });

  const fiscalYear = Number.isInteger(request?.fiscal_year) ? request.fiscal_year : null;
  return Object.freeze({
    tracking_code: code,
    anchor: `budget-request-${code.toLowerCase()}`,
    fiscal_year: fiscalYear,
    request_class: budgetRequestClean(request?.request_class, 40) || null,
    board_id: budgetRequestClean(request?.board_id, 80) || null,
    board_href: communityBoardPageHref(request?.board_id) || null,
    title: budgetRequestClean(latest?.request, 300) || code,
    explanation: budgetRequestClean(latest?.explanation, BUDGET_REQUEST_TEXT_LIMIT) || null,
    agency,
    rank: budgetRequestRank(latest?.rank),
    location: budgetRequestClean(latest?.location?.street, 200) || null,
    support_by: Object.freeze(
      (Array.isArray(latest?.support_by) ? latest.support_by : [])
        .map((value) => budgetRequestClean(value, 120))
        .filter(Boolean),
    ),
    answers: Object.freeze(answers),
    latest_answer: answers[answers.length - 1],
    changed_answer: answers.some((answer) => answer.changed === true),
    source_url: source.source_url,
  });
}

function budgetRequestSource(index) {
  return Object.freeze({
    publisher: budgetRequestClean(index?.source?.publisher, 200) || null,
    name: budgetRequestClean(index?.source?.name, 200) || null,
    source_url: budgetRequestClean(index?.source?.source_url, 400) || null,
    dataset_id: budgetRequestClean(index?.source?.dataset_id, 40) || null,
    as_of: budgetRequestIsoDay(index?.publication_selection?.as_of),
  });
}

function budgetRequestPublications(index) {
  const servable = new Set(
    (Array.isArray(index?.publication_selection?.servable) ? index.publication_selection.servable : [])
      .map((value) => budgetRequestClean(value, 20)),
  );
  return Object.freeze(
    (Array.isArray(index?.publications) ? index.publications : [])
      .filter((row) => servable.has(budgetRequestClean(row?.publication, 20)))
      .map((row) => Object.freeze({
        publication: budgetRequestClean(row?.publication, 20),
        publication_date: budgetRequestIsoDay(row?.publication_date),
      })),
  );
}

function budgetRequestFailure(index, document) {
  return index?.error || index?.unavailable_reason || document?.error || document?.unavailable_reason || null;
}

function budgetRequestBase(schema) {
  return {
    schema,
    state: BUDGET_REQUEST_STATES.UNAVAILABLE,
    request_count: 0,
    changed_answer_count: 0,
    fiscal_years: Object.freeze([]),
    publications: Object.freeze([]),
    source: Object.freeze({ publisher: null, name: null, source_url: null, dataset_id: null, as_of: null }),
  };
}

function budgetRequestByRank(left, right) {
  return String(left.rank?.value ?? "zz").localeCompare(String(right.rank?.value ?? "zz"))
    || left.tracking_code.localeCompare(right.tracking_code);
}

/**
 * The requests one board made, grouped by the agency responsible for answering.
 *
 * Never `null` for a board this site publishes: a board the register holds
 * nothing for gets a sentence about the register, because "nobody asked" and
 * "the register holds nothing here" are different answers.
 */
export function communityBoardBudgetRequestsForBoard(index, document, bodyId) {
  const board = budgetRequestClean(bodyId, 80);
  if (!BUDGET_REQUEST_BODY_ID.test(board)) return null;
  const base = { ...budgetRequestBase(COMMUNITY_BOARD_BUDGET_REQUESTS_VIEW_SCHEMA), body_id: board, agency_count: 0, groups: Object.freeze([]) };
  // Provenance is resolved before the failure is: a reader told the register
  // could not be read is also told where to go and read it, whenever the header
  // that names the publisher survived whatever went wrong.
  const source = budgetRequestSource(index);
  const withSource = { ...base, source, publications: budgetRequestPublications(index) };

  if (budgetRequestFailure(index, document)) {
    return Object.freeze({ ...withSource, state: BUDGET_REQUEST_STATES.UNAVAILABLE });
  }

  const rows = (Array.isArray(document?.requests) ? document.requests : [])
    .map((request) => budgetRequestRow(request, { source }))
    .filter((row) => row && row.board_id === board);
  if (!rows.length) {
    return Object.freeze({ ...withSource, state: BUDGET_REQUEST_STATES.NONE_RECORDED });
  }

  const byGroup = new Map();
  for (const row of rows) {
    const slug = budgetRequestGroupSlug(row.agency);
    if (!slug) continue;
    if (!byGroup.has(slug)) byGroup.set(slug, { slug, agency: row.agency, requests: [] });
    byGroup.get(slug).requests.push(row);
  }
  const groups = Object.freeze([...byGroup.values()]
    .map((group) => ({
      ...group,
      // Inside one agency the board's own priority order is the order that
      // means something, so the list keeps it rather than re-sorting by date
      // or by whether an answer changed.
      requests: Object.freeze([...group.requests].sort(budgetRequestByRank)),
    }))
    .sort((left, right) => (
      right.requests.length - left.requests.length
      || left.agency.source_label.localeCompare(right.agency.source_label)
    ))
    .map((group, position) => Object.freeze({
      slug: group.slug,
      anchor: `${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-${group.slug}`,
      agency: group.agency,
      request_count: group.requests.length,
      changed_answer_count: group.requests.filter((row) => row.changed_answer).length,
      collapsed: position >= BUDGET_REQUEST_VISIBLE_GROUPS,
      requests: group.requests,
    })));

  return Object.freeze({
    ...withSource,
    state: BUDGET_REQUEST_STATES.AVAILABLE,
    groups,
    request_count: rows.length,
    agency_count: groups.length,
    changed_answer_count: rows.filter((row) => row.changed_answer).length,
    fiscal_years: Object.freeze([...new Set(rows.map((row) => row.fiscal_year).filter(Number.isInteger))].sort()),
  });
}

/**
 * The requests naming one agency, grouped by the board that made them.
 *
 * The agency side reads the same per-board documents the board side does, so
 * the two surfaces cannot disagree about the population. A board keeps its own
 * priority order here: an agency page that re-ranked other people's requests
 * would be inventing a citywide order the publisher does not hold.
 */
export function agencyBudgetRequestsForAgency(index, documents, agencyId, { boardNames = {} } = {}) {
  const agency = budgetRequestClean(agencyId, 80);
  if (!BUDGET_REQUEST_AGENCY_ID.test(agency)) return null;
  const base = { ...budgetRequestBase(AGENCY_BUDGET_REQUESTS_VIEW_SCHEMA), agency_id: agency, board_count: 0, boards: Object.freeze([]) };

  const documentList = Array.isArray(documents) ? documents : [];
  const source = budgetRequestSource(index);
  const withSource = { ...base, source, publications: budgetRequestPublications(index) };
  if (budgetRequestFailure(index, null) || documentList.some((document) => budgetRequestFailure(null, document))) {
    return Object.freeze({ ...withSource, state: BUDGET_REQUEST_STATES.UNAVAILABLE });
  }

  const boards = [];
  const fiscalYears = [];
  let requestCount = 0;
  let changedCount = 0;
  for (const document of documentList) {
    const boardId = budgetRequestClean(document?.board_id, 80);
    if (!BUDGET_REQUEST_BODY_ID.test(boardId)) continue;
    const rows = (Array.isArray(document?.requests) ? document.requests : [])
      .map((request) => budgetRequestRow(request, { source }))
      .filter((row) => row && row.agency.agency_id === agency)
      .sort(budgetRequestByRank);
    if (!rows.length) continue;
    requestCount += rows.length;
    changedCount += rows.filter((row) => row.changed_answer).length;
    for (const row of rows) fiscalYears.push(row.fiscal_year);
    boards.push({
      board_id: boardId,
      display_name: budgetRequestClean(boardNames?.[boardId], 160) || boardId,
      href: communityBoardPageHref(boardId),
      request_count: rows.length,
      changed_answer_count: rows.filter((row) => row.changed_answer).length,
      requests: Object.freeze(rows),
    });
  }

  if (!boards.length) {
    return Object.freeze({ ...withSource, state: BUDGET_REQUEST_STATES.NONE_RECORDED });
  }

  const ordered = Object.freeze(boards
    .sort((left, right) => (
      right.request_count - left.request_count
      || left.board_id.localeCompare(right.board_id)
    ))
    .map((board, position) => Object.freeze({
      ...board,
      anchor: `${AGENCY_BUDGET_REQUESTS_ANCHOR}-${board.board_id}`,
      // A board's requests reached from an agency page keep the address of
      // that agency's own group on the board page, so opening one lands on the
      // scope the reader was already in rather than on the whole district.
      board_scope_href: board.href
        ? `${board.href}#${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-${agency}`
        : null,
      collapsed: position >= BUDGET_REQUEST_VISIBLE_BOARDS,
    })));

  return Object.freeze({
    ...withSource,
    state: BUDGET_REQUEST_STATES.AVAILABLE,
    boards: ordered,
    board_count: ordered.length,
    request_count: requestCount,
    changed_answer_count: changedCount,
    fiscal_years: Object.freeze([...new Set(fiscalYears.filter(Number.isInteger))].sort()),
  });
}

/**
 * The Intl locale each shipping language formats dates and counts in. Haitian
 * Creole has no CLDR locale of its own and uses fr-HT; Arabic and Urdu pin
 * Western digits with the `-u-nu-latn` extension, matching the site's own
 * language metadata.
 */
const BUDGET_REQUEST_LOCALES = Object.freeze({
  en: "en-US",
  es: "es",
  fr: "fr",
  ht: "fr-HT",
  ru: "ru",
  bn: "bn",
  "zh-Hans": "zh-Hans",
  ko: "ko",
  ar: "ar-u-nu-latn",
  ur: "ur-u-nu-latn",
  pl: "pl",
});

const BUDGET_REQUEST_RTL_LANGS = new Set(["ar", "ur"]);

function budgetRequestEsc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function budgetRequestFormatDay(value, lang) {
  const day = budgetRequestIsoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(BUDGET_REQUEST_LOCALES[lang] || BUDGET_REQUEST_LOCALES.en, {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(parsed);
  } catch (_error) {
    return day;
  }
}

function budgetRequestFormatCount(value, lang) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  try {
    return new Intl.NumberFormat(BUDGET_REQUEST_LOCALES[lang] || BUDGET_REQUEST_LOCALES.en).format(number);
  } catch (_error) {
    return String(number);
  }
}

const BUDGET_REQUEST_STRINGS = {
  en: {
    cbbr_heading: "Budget requests this district made to city agencies",
    cbbr_lede_one: "The city's budget register holds one request this board made for fiscal year {fy}.",
    cbbr_lede: "The city's budget register holds {count} requests this board made for fiscal year {fy}, addressed to {agencies} agencies.",
    cbbr_boundary: "A request is what the board asked for. A response is the written answer published for it on that date. Neither is funding, a commitment or delivery, and a request with a supportive answer is not a project.",
    cbbr_rank_boundary: "A priority number is this board's own order inside one agency and one budget type. Requests to different agencies are not on one scale, and nothing here is a citywide ranking.",
    cbbr_changed_none: "No request here carries an answer that reads differently between the two publications.",
    cbbr_changed_one: "One request carries an answer that reads differently in the later publication.",
    cbbr_changed: "{count} requests carry an answer that reads differently in the later publication.",
    cbbr_scope_lead: "Choose an agency:",
    cbbr_group_count_one: "1 request",
    cbbr_group_count: "{count} requests",
    cbbr_group_open_one: "Show this request",
    cbbr_group_open: "Show these {count} requests",
    cbbr_group_close: "Show fewer agencies",
    cbbr_agency_page: "Open this agency",
    cbbr_agency_unbound: "This site carries no page for this agency, so its name stays as the city published it.",
    cbbr_rank: "Priority {rank} among this board's {class} requests to this agency",
    cbbr_rank_plain: "Priority {rank}",
    cbbr_class_capital: "capital",
    cbbr_class_expense: "expense",
    cbbr_class_continued: "continued support",
    cbbr_fiscal_year: "Fiscal year {year}",
    cbbr_code: "Tracking code {code}",
    cbbr_answers_heading: "Answers published for this request",
    cbbr_answer_on: "Published {date}",
    cbbr_answer_changed: "This answer reads differently from the one published {date}.",
    cbbr_answer_wrapper_only: "Between {date} and this publication only the publisher's wrapper sentence changed. The answer itself reads the same.",
    cbbr_answer_same: "This answer reads the same as the one published {date}.",
    cbbr_explanation_heading: "What the board wrote",
    cbbr_location: "Location the board gave: {location}",
    cbbr_location_absent: "The board gave no location for this request.",
    cbbr_supported_by: "The board recorded support for this request from: {names}",
    cbbr_inspect: "Inspect",
    cbbr_inspect_label: "Inspect request {code} and the answers published for it",
    cbbr_close: "Close",
    cbbr_dialog_kicker: "Budget request",
    cbbr_open_request: "Open this request on the board's page",
    cbbr_source: "Source: {publisher}, {name}. Read {date}.",
    cbbr_source_link: "Open the published register",
    cbbr_empty: "The city's budget register holds no request from this board in the publications this site retains. That is what the register holds; it is not a record that this board asked for nothing.",
    cbbr_unavailable: "This board's budget requests could not be loaded, so none are shown here. That is a failure to read the register, not a board with no requests.",
    cbbr_unavailable_retry: "Reload this page to try again, or read the register at the published source.",
    abr_heading: "Community board budget requests this agency answers",
    abr_lede_one: "One community board budget request for fiscal year {fy} names this agency as the one responsible for answering it.",
    abr_lede: "{count} community board budget requests for fiscal year {fy} name this agency as the one responsible for answering them. They come from {boards} community boards.",
    abr_scope: "Each request keeps the district that made it and that board's own priority order. Nothing here is a citywide ranking, and none of it scores how the agency answered.",
    abr_board_open: "Open this board's requests to this agency",
    abr_overflow_one: "Show the other board",
    abr_overflow: "Show the other {count} boards",
    abr_overflow_close: "Show fewer boards",
    abr_empty: "The city's budget register records no community board request naming this agency in the publications this site retains.",
    abr_unavailable: "The community board budget requests naming this agency could not be loaded, so none are shown here. That is a failure to read the register, not an agency no board asked anything of.",
    abr_more_one: "One of this board's requests to this agency is listed on the board's own page.",
    abr_more: "{count} of this board's requests to this agency are listed on the board's own page.",
  },
  es: {
    cbbr_heading: "Solicitudes presupuestarias que este distrito hizo a las agencias municipales",
    cbbr_lede_one: "El registro presupuestario municipal contiene una solicitud que esta junta hizo para el año fiscal {fy}.",
    cbbr_lede: "El registro presupuestario municipal contiene {count} solicitudes que esta junta hizo para el año fiscal {fy}, dirigidas a {agencies} agencias.",
    cbbr_boundary: "Una solicitud es lo que pidió la junta. Una respuesta es la contestación escrita que se publicó para ella en esa fecha. Ninguna de las dos es financiamiento, un compromiso ni una entrega, y una solicitud con una respuesta favorable no es un proyecto.",
    cbbr_rank_boundary: "El número de prioridad es el orden propio de esta junta dentro de una agencia y un tipo de presupuesto. Las solicitudes a agencias distintas no están en una misma escala, y aquí no hay ninguna clasificación de toda la ciudad.",
    cbbr_changed_none: "Ninguna solicitud de aquí tiene una respuesta que se lea distinta entre las dos publicaciones.",
    cbbr_changed_one: "Una solicitud tiene una respuesta que se lee distinta en la publicación posterior.",
    cbbr_changed: "{count} solicitudes tienen una respuesta que se lee distinta en la publicación posterior.",
    cbbr_scope_lead: "Elija una agencia:",
    cbbr_group_count_one: "1 solicitud",
    cbbr_group_count: "{count} solicitudes",
    cbbr_group_open_one: "Mostrar esta solicitud",
    cbbr_group_open: "Mostrar estas {count} solicitudes",
    cbbr_group_close: "Mostrar menos agencias",
    cbbr_agency_page: "Abrir esta agencia",
    cbbr_agency_unbound: "Este sitio no tiene una página para esta agencia, así que su nombre se mantiene tal como lo publicó la ciudad.",
    cbbr_rank: "Prioridad {rank} entre las solicitudes de {class} de esta junta a esta agencia",
    cbbr_rank_plain: "Prioridad {rank}",
    cbbr_class_capital: "capital",
    cbbr_class_expense: "gasto",
    cbbr_class_continued: "apoyo continuado",
    cbbr_fiscal_year: "Año fiscal {year}",
    cbbr_code: "Código de seguimiento {code}",
    cbbr_answers_heading: "Respuestas publicadas para esta solicitud",
    cbbr_answer_on: "Publicada el {date}",
    cbbr_answer_changed: "Esta respuesta se lee distinta de la publicada el {date}.",
    cbbr_answer_wrapper_only: "Entre el {date} y esta publicación solo cambió la frase envolvente del publicador. La respuesta en sí se lee igual.",
    cbbr_answer_same: "Esta respuesta se lee igual que la publicada el {date}.",
    cbbr_explanation_heading: "Lo que escribió la junta",
    cbbr_location: "Ubicación indicada por la junta: {location}",
    cbbr_location_absent: "La junta no indicó ninguna ubicación para esta solicitud.",
    cbbr_supported_by: "La junta dejó constancia del apoyo a esta solicitud por parte de: {names}",
    cbbr_inspect: "Examinar",
    cbbr_inspect_label: "Examinar la solicitud {code} y las respuestas publicadas para ella",
    cbbr_close: "Cerrar",
    cbbr_dialog_kicker: "Solicitud presupuestaria",
    cbbr_open_request: "Abrir esta solicitud en la página de la junta",
    cbbr_source: "Fuente: {publisher}, {name}. Consultada el {date}.",
    cbbr_source_link: "Abrir el registro publicado",
    cbbr_empty: "El registro presupuestario municipal no contiene ninguna solicitud de esta junta en las publicaciones que este sitio conserva. Eso es lo que contiene el registro; no es constancia de que esta junta no haya pedido nada.",
    cbbr_unavailable: "No se pudieron cargar las solicitudes presupuestarias de esta junta, así que no se muestra ninguna. Es un fallo al leer el registro, no una junta sin solicitudes.",
    cbbr_unavailable_retry: "Vuelva a cargar esta página para intentarlo de nuevo, o consulte el registro en la fuente publicada.",
    abr_heading: "Solicitudes presupuestarias de juntas comunitarias que responde esta agencia",
    abr_lede_one: "Una solicitud presupuestaria de junta comunitaria para el año fiscal {fy} señala a esta agencia como la responsable de contestarla.",
    abr_lede: "{count} solicitudes presupuestarias de juntas comunitarias para el año fiscal {fy} señalan a esta agencia como la responsable de contestarlas. Provienen de {boards} juntas comunitarias.",
    abr_scope: "Cada solicitud conserva el distrito que la hizo y el orden de prioridad propio de esa junta. Aquí no hay ninguna clasificación de toda la ciudad, y nada de esto puntúa cómo respondió la agencia.",
    abr_board_open: "Abrir las solicitudes de esta junta a esta agencia",
    abr_overflow_one: "Mostrar la otra junta",
    abr_overflow: "Mostrar las otras {count} juntas",
    abr_overflow_close: "Mostrar menos juntas",
    abr_empty: "El registro presupuestario municipal no recoge ninguna solicitud de junta comunitaria que señale a esta agencia en las publicaciones que este sitio conserva.",
    abr_unavailable: "No se pudieron cargar las solicitudes presupuestarias de juntas comunitarias que señalan a esta agencia, así que no se muestra ninguna. Es un fallo al leer el registro, no una agencia a la que ninguna junta haya pedido nada.",
    abr_more_one: "Una de las solicitudes de esta junta a esta agencia figura en la página de la propia junta.",
    abr_more: "{count} de las solicitudes de esta junta a esta agencia figuran en la página de la propia junta.",
  },
  fr: {
    cbbr_heading: "Demandes budgétaires que ce district a adressées aux agences municipales",
    cbbr_lede_one: "Le registre budgétaire de la ville contient une demande faite par ce conseil pour l'exercice {fy}.",
    cbbr_lede: "Le registre budgétaire de la ville contient {count} demandes faites par ce conseil pour l'exercice {fy}, adressées à {agencies} agences.",
    cbbr_boundary: "Une demande est ce que le conseil a réclamé. Une réponse est la réponse écrite publiée pour elle à cette date. Ni l'une ni l'autre n'est un financement, un engagement ou une réalisation, et une demande assortie d'une réponse favorable n'est pas un projet.",
    cbbr_rank_boundary: "Un numéro de priorité est l'ordre propre à ce conseil au sein d'une agence et d'un type de budget. Les demandes adressées à des agences différentes ne sont pas sur une même échelle, et rien ici n'est un classement à l'échelle de la ville.",
    cbbr_changed_none: "Aucune demande ici ne porte une réponse qui se lise différemment entre les deux publications.",
    cbbr_changed_one: "Une demande porte une réponse qui se lit différemment dans la publication ultérieure.",
    cbbr_changed: "{count} demandes portent une réponse qui se lit différemment dans la publication ultérieure.",
    cbbr_scope_lead: "Choisissez une agence :",
    cbbr_group_count_one: "1 demande",
    cbbr_group_count: "{count} demandes",
    cbbr_group_open_one: "Afficher cette demande",
    cbbr_group_open: "Afficher ces {count} demandes",
    cbbr_group_close: "Afficher moins d'agences",
    cbbr_agency_page: "Ouvrir cette agence",
    cbbr_agency_unbound: "Ce site n'a pas de page pour cette agence ; son nom reste donc tel que la ville l'a publié.",
    cbbr_rank: "Priorité {rank} parmi les demandes de {class} de ce conseil à cette agence",
    cbbr_rank_plain: "Priorité {rank}",
    cbbr_class_capital: "capital",
    cbbr_class_expense: "fonctionnement",
    cbbr_class_continued: "soutien reconduit",
    cbbr_fiscal_year: "Exercice {year}",
    cbbr_code: "Code de suivi {code}",
    cbbr_answers_heading: "Réponses publiées pour cette demande",
    cbbr_answer_on: "Publiée le {date}",
    cbbr_answer_changed: "Cette réponse se lit différemment de celle publiée le {date}.",
    cbbr_answer_wrapper_only: "Entre le {date} et cette publication, seule la phrase d'encadrement de l'éditeur a changé. La réponse elle-même se lit à l'identique.",
    cbbr_answer_same: "Cette réponse se lit comme celle publiée le {date}.",
    cbbr_explanation_heading: "Ce que le conseil a écrit",
    cbbr_location: "Emplacement indiqué par le conseil : {location}",
    cbbr_location_absent: "Le conseil n'a indiqué aucun emplacement pour cette demande.",
    cbbr_supported_by: "Le conseil a consigné le soutien à cette demande de : {names}",
    cbbr_inspect: "Examiner",
    cbbr_inspect_label: "Examiner la demande {code} et les réponses publiées pour elle",
    cbbr_close: "Fermer",
    cbbr_dialog_kicker: "Demande budgétaire",
    cbbr_open_request: "Ouvrir cette demande sur la page du conseil",
    cbbr_source: "Source : {publisher}, {name}. Consultée le {date}.",
    cbbr_source_link: "Ouvrir le registre publié",
    cbbr_empty: "Le registre budgétaire de la ville ne contient aucune demande de ce conseil dans les publications que ce site conserve. C'est ce que contient le registre ; ce n'est pas la preuve que ce conseil n'a rien demandé.",
    cbbr_unavailable: "Les demandes budgétaires de ce conseil n'ont pas pu être chargées, aucune n'est donc affichée ici. C'est un échec de lecture du registre, pas un conseil sans demandes.",
    cbbr_unavailable_retry: "Rechargez cette page pour réessayer, ou consultez le registre à la source publiée.",
    abr_heading: "Demandes budgétaires des conseils de quartier auxquelles cette agence répond",
    abr_lede_one: "Une demande budgétaire de conseil de quartier pour l'exercice {fy} désigne cette agence comme responsable d'y répondre.",
    abr_lede: "{count} demandes budgétaires de conseils de quartier pour l'exercice {fy} désignent cette agence comme responsable d'y répondre. Elles proviennent de {boards} conseils de quartier.",
    abr_scope: "Chaque demande conserve le district qui l'a faite et l'ordre de priorité propre à ce conseil. Rien ici n'est un classement à l'échelle de la ville, et rien n'y note la manière dont l'agence a répondu.",
    abr_board_open: "Ouvrir les demandes de ce conseil à cette agence",
    abr_overflow_one: "Afficher l'autre conseil",
    abr_overflow: "Afficher les {count} autres conseils",
    abr_overflow_close: "Afficher moins de conseils",
    abr_empty: "Le registre budgétaire de la ville ne consigne aucune demande de conseil de quartier désignant cette agence dans les publications que ce site conserve.",
    abr_unavailable: "Les demandes budgétaires de conseils de quartier désignant cette agence n'ont pas pu être chargées, aucune n'est donc affichée ici. C'est un échec de lecture du registre, pas une agence à laquelle aucun conseil n'a rien demandé.",
    abr_more_one: "Une des demandes de ce conseil à cette agence figure sur la page du conseil lui-même.",
    abr_more: "{count} des demandes de ce conseil à cette agence figurent sur la page du conseil lui-même.",
  },
  ht: {
    cbbr_heading: "Demann bidjè distrik sa a fè bay ajans vil la",
    cbbr_lede_one: "Rejis bidjè vil la gen yon demann konsèy sa a te fè pou ane fiskal {fy}.",
    cbbr_lede: "Rejis bidjè vil la gen {count} demann konsèy sa a te fè pou ane fiskal {fy}, adrese bay {agencies} ajans.",
    cbbr_boundary: "Yon demann se sa konsèy la te mande. Yon repons se repons ekri yo te pibliye pou li nan dat sa a. Ni youn ni lòt se pa finansman, angajman oswa livrezon, epi yon demann ki gen yon repons favorab se pa yon pwojè.",
    cbbr_rank_boundary: "Yon nimewo priyorite se pwòp lòd konsèy sa a andedan yon sèl ajans ak yon sèl kalite bidjè. Demann pou ajans diferan pa sou menm echèl la, epi anyen isit la se pa yon klasman pou tout vil la.",
    cbbr_changed_none: "Okenn demann isit la pa gen yon repons ki li diferan ant de piblikasyon yo.",
    cbbr_changed_one: "Yon demann gen yon repons ki li diferan nan piblikasyon ki vin apre a.",
    cbbr_changed: "{count} demann gen yon repons ki li diferan nan piblikasyon ki vin apre a.",
    cbbr_scope_lead: "Chwazi yon ajans:",
    cbbr_group_count_one: "1 demann",
    cbbr_group_count: "{count} demann",
    cbbr_group_open_one: "Montre demann sa a",
    cbbr_group_open: "Montre {count} demann sa yo",
    cbbr_group_close: "Montre mwens ajans",
    cbbr_agency_page: "Louvri ajans sa a",
    cbbr_agency_unbound: "Sit sa a pa gen yon paj pou ajans sa a, kidonk non li rete jan vil la te pibliye l la.",
    cbbr_rank: "Priyorite {rank} pami demann {class} konsèy sa a bay ajans sa a",
    cbbr_rank_plain: "Priyorite {rank}",
    cbbr_class_capital: "kapital",
    cbbr_class_expense: "depans",
    cbbr_class_continued: "sipò kontinye",
    cbbr_fiscal_year: "Ane fiskal {year}",
    cbbr_code: "Kòd swivi {code}",
    cbbr_answers_heading: "Repons yo pibliye pou demann sa a",
    cbbr_answer_on: "Pibliye {date}",
    cbbr_answer_changed: "Repons sa a li diferan de sa yo te pibliye {date} a.",
    cbbr_answer_wrapper_only: "Ant {date} ak piblikasyon sa a, se sèlman fraz ankadreman piblikatè a ki chanje. Repons lan menm li menm jan.",
    cbbr_answer_same: "Repons sa a li menm jan ak sa yo te pibliye {date} a.",
    cbbr_explanation_heading: "Sa konsèy la te ekri",
    cbbr_location: "Kote konsèy la te bay: {location}",
    cbbr_location_absent: "Konsèy la pa t bay okenn kote pou demann sa a.",
    cbbr_supported_by: "Konsèy la anrejistre sipò pou demann sa a soti nan: {names}",
    cbbr_inspect: "Egzamine",
    cbbr_inspect_label: "Egzamine demann {code} ak repons yo pibliye pou li yo",
    cbbr_close: "Fèmen",
    cbbr_dialog_kicker: "Demann bidjè",
    cbbr_open_request: "Louvri demann sa a sou paj konsèy la",
    cbbr_source: "Sous: {publisher}, {name}. Li {date}.",
    cbbr_source_link: "Louvri rejis ki pibliye a",
    cbbr_empty: "Rejis bidjè vil la pa gen okenn demann nan men konsèy sa a nan piblikasyon sit sa a kenbe yo. Se sa rejis la genyen; se pa yon prèv ke konsèy sa a pa t mande anyen.",
    cbbr_unavailable: "Demann bidjè konsèy sa a pa t ka chaje, kidonk pa gen okenn ki parèt isit la. Se yon echèk pou li rejis la, se pa yon konsèy san demann.",
    cbbr_unavailable_retry: "Rechaje paj sa a pou eseye ankò, oswa li rejis la nan sous ki pibliye a.",
    abr_heading: "Demann bidjè konsèy kominotè ajans sa a reponn",
    abr_lede_one: "Yon demann bidjè konsèy kominotè pou ane fiskal {fy} nonmen ajans sa a kòm sa ki responsab pou reponn li.",
    abr_lede: "{count} demann bidjè konsèy kominotè pou ane fiskal {fy} nonmen ajans sa a kòm sa ki responsab pou reponn yo. Yo soti nan {boards} konsèy kominotè.",
    abr_scope: "Chak demann kenbe distrik ki te fè l la ak pwòp lòd priyorite konsèy sa a. Anyen isit la se pa yon klasman pou tout vil la, epi anyen ladan l pa bay yon nòt sou fason ajans lan te reponn.",
    abr_board_open: "Louvri demann konsèy sa a bay ajans sa a",
    abr_overflow_one: "Montre lòt konsèy la",
    abr_overflow: "Montre {count} lòt konsèy yo",
    abr_overflow_close: "Montre mwens konsèy",
    abr_empty: "Rejis bidjè vil la pa anrejistre okenn demann konsèy kominotè ki nonmen ajans sa a nan piblikasyon sit sa a kenbe yo.",
    abr_unavailable: "Demann bidjè konsèy kominotè ki nonmen ajans sa a pa t ka chaje, kidonk pa gen okenn ki parèt isit la. Se yon echèk pou li rejis la, se pa yon ajans okenn konsèy pa t mande anyen.",
    abr_more_one: "Youn nan demann konsèy sa a bay ajans sa a parèt sou pwòp paj konsèy la.",
    abr_more: "{count} nan demann konsèy sa a bay ajans sa a parèt sou pwòp paj konsèy la.",
  },
  ru: {
    cbbr_heading: "Бюджетные запросы, которые этот округ направил городским ведомствам",
    cbbr_lede_one: "Городской бюджетный реестр содержит один запрос, поданный этим советом на {fy} финансовый год.",
    cbbr_lede: "Городской бюджетный реестр содержит запросов, поданных этим советом на {fy} финансовый год: {count} — они адресованы ведомствам: {agencies}.",
    cbbr_boundary: "Запрос — это то, о чём попросил совет. Ответ — это письменный ответ, опубликованный на него в ту дату. Ни то, ни другое не является финансированием, обязательством или выполнением, а запрос с благоприятным ответом не является проектом.",
    cbbr_rank_boundary: "Номер приоритета — это собственный порядок этого совета внутри одного ведомства и одного вида бюджета. Запросы к разным ведомствам не находятся на одной шкале, и ничто здесь не является общегородским рейтингом.",
    cbbr_changed_none: "Ни один запрос здесь не имеет ответа, который читался бы иначе в двух публикациях.",
    cbbr_changed_one: "Один запрос имеет ответ, который читается иначе в более поздней публикации.",
    cbbr_changed: "Запросов с ответом, который читается иначе в более поздней публикации: {count}.",
    cbbr_scope_lead: "Выберите ведомство:",
    cbbr_group_count_one: "1 запрос",
    cbbr_group_count: "запросов: {count}",
    cbbr_group_open_one: "Показать этот запрос",
    cbbr_group_open: "Показать эти запросы: {count}",
    cbbr_group_close: "Показать меньше ведомств",
    cbbr_agency_page: "Открыть это ведомство",
    cbbr_agency_unbound: "На этом сайте нет страницы для этого ведомства, поэтому его название остаётся в том виде, в каком его опубликовал город.",
    cbbr_rank: "Приоритет {rank} среди запросов этого совета к этому ведомству по статье «{class}»",
    cbbr_rank_plain: "Приоритет {rank}",
    cbbr_class_capital: "капитальные расходы",
    cbbr_class_expense: "текущие расходы",
    cbbr_class_continued: "продолжение поддержки",
    cbbr_fiscal_year: "Финансовый год {year}",
    cbbr_code: "Учётный код {code}",
    cbbr_answers_heading: "Ответы, опубликованные на этот запрос",
    cbbr_answer_on: "Опубликовано {date}",
    cbbr_answer_changed: "Этот ответ читается иначе, чем опубликованный {date}.",
    cbbr_answer_wrapper_only: "Между {date} и этой публикацией изменилась только обрамляющая фраза издателя. Сам ответ читается так же.",
    cbbr_answer_same: "Этот ответ читается так же, как опубликованный {date}.",
    cbbr_explanation_heading: "Что написал совет",
    cbbr_location: "Место, указанное советом: {location}",
    cbbr_location_absent: "Совет не указал места для этого запроса.",
    cbbr_supported_by: "Совет зафиксировал поддержку этого запроса со стороны: {names}",
    cbbr_inspect: "Посмотреть",
    cbbr_inspect_label: "Посмотреть запрос {code} и опубликованные на него ответы",
    cbbr_close: "Закрыть",
    cbbr_dialog_kicker: "Бюджетный запрос",
    cbbr_open_request: "Открыть этот запрос на странице совета",
    cbbr_source: "Источник: {publisher}, {name}. Прочитано {date}.",
    cbbr_source_link: "Открыть опубликованный реестр",
    cbbr_empty: "Городской бюджетный реестр не содержит ни одного запроса этого совета в публикациях, которые сохраняет этот сайт. Это содержимое реестра, а не свидетельство того, что совет ни о чём не просил.",
    cbbr_unavailable: "Бюджетные запросы этого совета не удалось загрузить, поэтому здесь они не показаны. Это сбой чтения реестра, а не совет без запросов.",
    cbbr_unavailable_retry: "Перезагрузите страницу, чтобы повторить попытку, или посмотрите реестр в опубликованном источнике.",
    abr_heading: "Бюджетные запросы общественных советов, на которые отвечает это ведомство",
    abr_lede_one: "Один бюджетный запрос общественного совета на {fy} финансовый год называет это ведомство ответственным за ответ.",
    abr_lede: "Бюджетных запросов общественных советов на {fy} финансовый год, называющих это ведомство ответственным за ответ: {count}. Они поступили от общественных советов: {boards}.",
    abr_scope: "Каждый запрос сохраняет округ, который его подал, и собственный порядок приоритетов этого совета. Ничто здесь не является общегородским рейтингом и не оценивает то, как ведомство ответило.",
    abr_board_open: "Открыть запросы этого совета к этому ведомству",
    abr_overflow_one: "Показать ещё один совет",
    abr_overflow: "Показать остальные советы: {count}",
    abr_overflow_close: "Показать меньше советов",
    abr_empty: "Городской бюджетный реестр не фиксирует ни одного запроса общественного совета, называющего это ведомство, в публикациях, которые сохраняет этот сайт.",
    abr_unavailable: "Бюджетные запросы общественных советов, называющие это ведомство, не удалось загрузить, поэтому здесь они не показаны. Это сбой чтения реестра, а не ведомство, к которому ни один совет не обращался.",
    abr_more_one: "Один из запросов этого совета к этому ведомству указан на собственной странице совета.",
    abr_more: "Запросов этого совета к этому ведомству, указанных на собственной странице совета: {count}.",
  },
  bn: {
    cbbr_heading: "এই জেলা শহরের সংস্থাগুলিকে যে বাজেট অনুরোধ করেছে",
    cbbr_lede_one: "শহরের বাজেট নিবন্ধে {fy} অর্থবছরের জন্য এই বোর্ডের করা একটি অনুরোধ রয়েছে।",
    cbbr_lede: "শহরের বাজেট নিবন্ধে {fy} অর্থবছরের জন্য এই বোর্ডের করা {count}টি অনুরোধ রয়েছে, যা {agencies}টি সংস্থাকে সম্বোধিত।",
    cbbr_boundary: "অনুরোধ হলো বোর্ড যা চেয়েছে। প্রতিক্রিয়া হলো সেই তারিখে তার জন্য প্রকাশিত লিখিত উত্তর। কোনোটিই অর্থায়ন, প্রতিশ্রুতি বা সরবরাহ নয়, এবং অনুকূল উত্তরযুক্ত একটি অনুরোধ কোনো প্রকল্প নয়।",
    cbbr_rank_boundary: "অগ্রাধিকার নম্বর হলো একটি সংস্থা ও একটি বাজেট ধরনের ভিতরে এই বোর্ডের নিজস্ব ক্রম। ভিন্ন সংস্থার অনুরোধগুলি একই মাপকাঠিতে নেই, এবং এখানে শহরব্যাপী কোনো ক্রম নেই।",
    cbbr_changed_none: "এখানে কোনো অনুরোধের উত্তর দুই প্রকাশনার মধ্যে ভিন্নভাবে পড়া যায় না।",
    cbbr_changed_one: "একটি অনুরোধের উত্তর পরবর্তী প্রকাশনায় ভিন্নভাবে পড়া যায়।",
    cbbr_changed: "{count}টি অনুরোধের উত্তর পরবর্তী প্রকাশনায় ভিন্নভাবে পড়া যায়।",
    cbbr_scope_lead: "একটি সংস্থা বেছে নিন:",
    cbbr_group_count_one: "১টি অনুরোধ",
    cbbr_group_count: "{count}টি অনুরোধ",
    cbbr_group_open_one: "এই অনুরোধটি দেখান",
    cbbr_group_open: "এই {count}টি অনুরোধ দেখান",
    cbbr_group_close: "কম সংস্থা দেখান",
    cbbr_agency_page: "এই সংস্থাটি খুলুন",
    cbbr_agency_unbound: "এই সাইটে এই সংস্থার কোনো পাতা নেই, তাই শহর যেভাবে প্রকাশ করেছে নামটি সেভাবেই রাখা হয়েছে।",
    cbbr_rank: "এই সংস্থার কাছে এই বোর্ডের {class} অনুরোধগুলির মধ্যে অগ্রাধিকার {rank}",
    cbbr_rank_plain: "অগ্রাধিকার {rank}",
    cbbr_class_capital: "মূলধন",
    cbbr_class_expense: "ব্যয়",
    cbbr_class_continued: "চলমান সহায়তা",
    cbbr_fiscal_year: "অর্থবছর {year}",
    cbbr_code: "ট্র্যাকিং কোড {code}",
    cbbr_answers_heading: "এই অনুরোধের জন্য প্রকাশিত উত্তর",
    cbbr_answer_on: "প্রকাশিত {date}",
    cbbr_answer_changed: "এই উত্তরটি {date} তারিখে প্রকাশিত উত্তর থেকে ভিন্নভাবে পড়া যায়।",
    cbbr_answer_wrapper_only: "{date} ও এই প্রকাশনার মধ্যে শুধু প্রকাশকের মোড়ক বাক্যটি বদলেছে। উত্তরটি নিজে একইভাবে পড়া যায়।",
    cbbr_answer_same: "এই উত্তরটি {date} তারিখে প্রকাশিত উত্তরের মতোই পড়া যায়।",
    cbbr_explanation_heading: "বোর্ড যা লিখেছে",
    cbbr_location: "বোর্ডের দেওয়া অবস্থান: {location}",
    cbbr_location_absent: "বোর্ড এই অনুরোধের জন্য কোনো অবস্থান দেয়নি।",
    cbbr_supported_by: "বোর্ড এই অনুরোধের জন্য যাদের সমর্থন নথিভুক্ত করেছে: {names}",
    cbbr_inspect: "বিস্তারিত দেখুন",
    cbbr_inspect_label: "অনুরোধ {code} ও তার জন্য প্রকাশিত উত্তরগুলি দেখুন",
    cbbr_close: "বন্ধ করুন",
    cbbr_dialog_kicker: "বাজেট অনুরোধ",
    cbbr_open_request: "বোর্ডের পাতায় এই অনুরোধটি খুলুন",
    cbbr_source: "উৎস: {publisher}, {name}। পড়া হয়েছে {date}।",
    cbbr_source_link: "প্রকাশিত নিবন্ধ খুলুন",
    cbbr_empty: "এই সাইট যে প্রকাশনাগুলি রাখে, তাতে শহরের বাজেট নিবন্ধে এই বোর্ডের কোনো অনুরোধ নেই। এটি নিবন্ধে যা আছে তা-ই; এই বোর্ড কিছুই চায়নি, এমন নথি নয়।",
    cbbr_unavailable: "এই বোর্ডের বাজেট অনুরোধগুলি লোড করা যায়নি, তাই এখানে কিছু দেখানো হয়নি। এটি নিবন্ধ পড়তে ব্যর্থতা, অনুরোধহীন বোর্ড নয়।",
    cbbr_unavailable_retry: "আবার চেষ্টা করতে এই পাতাটি রিলোড করুন, অথবা প্রকাশিত উৎসে নিবন্ধটি পড়ুন।",
    abr_heading: "এই সংস্থা যে কমিউনিটি বোর্ড বাজেট অনুরোধের উত্তর দেয়",
    abr_lede_one: "{fy} অর্থবছরের একটি কমিউনিটি বোর্ড বাজেট অনুরোধ এই সংস্থাকে উত্তর দেওয়ার দায়িত্বপ্রাপ্ত হিসেবে উল্লেখ করে।",
    abr_lede: "{fy} অর্থবছরের {count}টি কমিউনিটি বোর্ড বাজেট অনুরোধ এই সংস্থাকে উত্তর দেওয়ার দায়িত্বপ্রাপ্ত হিসেবে উল্লেখ করে। সেগুলি {boards}টি কমিউনিটি বোর্ড থেকে এসেছে।",
    abr_scope: "প্রতিটি অনুরোধ যে জেলা তা করেছে এবং সেই বোর্ডের নিজস্ব অগ্রাধিকার ক্রম ধরে রাখে। এখানে শহরব্যাপী কোনো ক্রম নেই, এবং সংস্থা কীভাবে উত্তর দিয়েছে তার কোনো স্কোরও নেই।",
    abr_board_open: "এই সংস্থার কাছে এই বোর্ডের অনুরোধগুলি খুলুন",
    abr_overflow_one: "অন্য বোর্ডটি দেখান",
    abr_overflow: "অন্য {count}টি বোর্ড দেখান",
    abr_overflow_close: "কম বোর্ড দেখান",
    abr_empty: "এই সাইট যে প্রকাশনাগুলি রাখে, তাতে শহরের বাজেট নিবন্ধে এই সংস্থাকে উল্লেখ করা কোনো কমিউনিটি বোর্ড অনুরোধ নেই।",
    abr_unavailable: "এই সংস্থাকে উল্লেখ করা কমিউনিটি বোর্ড বাজেট অনুরোধগুলি লোড করা যায়নি, তাই এখানে কিছু দেখানো হয়নি। এটি নিবন্ধ পড়তে ব্যর্থতা, কোনো বোর্ড কিছু চায়নি এমন সংস্থা নয়।",
    abr_more_one: "এই সংস্থার কাছে এই বোর্ডের একটি অনুরোধ বোর্ডের নিজস্ব পাতায় তালিকাভুক্ত রয়েছে।",
    abr_more: "এই সংস্থার কাছে এই বোর্ডের {count}টি অনুরোধ বোর্ডের নিজস্ব পাতায় তালিকাভুক্ত রয়েছে।",
  },
  "zh-Hans": {
    cbbr_heading: "本区向市政机构提出的预算请求",
    cbbr_lede_one: "市政预算登记册中有本委员会为 {fy} 财政年度提出的 1 项请求。",
    cbbr_lede: "市政预算登记册中有本委员会为 {fy} 财政年度提出的 {count} 项请求，分别提交给 {agencies} 个机构。",
    cbbr_boundary: "请求是委员会提出的诉求。回应是当日为该请求公布的书面答复。两者都不是拨款、承诺或交付，带有支持性答复的请求也不是一个已立项的工程。",
    cbbr_rank_boundary: "优先编号是本委员会在同一机构、同一预算类别内的自定排序。提交给不同机构的请求并不在同一标尺上，此处也没有任何全市排名。",
    cbbr_changed_none: "此处没有任何请求的答复在两次公布之间读起来有所不同。",
    cbbr_changed_one: "有 1 项请求的答复在较晚一次公布中读起来有所不同。",
    cbbr_changed: "有 {count} 项请求的答复在较晚一次公布中读起来有所不同。",
    cbbr_scope_lead: "选择一个机构：",
    cbbr_group_count_one: "1 项请求",
    cbbr_group_count: "{count} 项请求",
    cbbr_group_open_one: "显示这项请求",
    cbbr_group_open: "显示这 {count} 项请求",
    cbbr_group_close: "显示较少机构",
    cbbr_agency_page: "打开该机构",
    cbbr_agency_unbound: "本网站没有该机构的页面，因此其名称保持市政部门公布的写法。",
    cbbr_rank: "在本委员会向该机构提出的{class}请求中排在第 {rank} 位",
    cbbr_rank_plain: "优先顺序 {rank}",
    cbbr_class_capital: "资本",
    cbbr_class_expense: "经常性支出",
    cbbr_class_continued: "继续支持",
    cbbr_fiscal_year: "{year} 财政年度",
    cbbr_code: "追踪编号 {code}",
    cbbr_answers_heading: "针对该请求公布的答复",
    cbbr_answer_on: "公布于 {date}",
    cbbr_answer_changed: "该答复与 {date} 公布的那份读起来不同。",
    cbbr_answer_wrapper_only: "在 {date} 与本次公布之间，只有发布方的外层套语发生了变化，答复本身读起来相同。",
    cbbr_answer_same: "该答复与 {date} 公布的那份读起来相同。",
    cbbr_explanation_heading: "委员会写下的内容",
    cbbr_location: "委员会给出的地点：{location}",
    cbbr_location_absent: "委员会未为该请求给出地点。",
    cbbr_supported_by: "委员会记录了以下各方对该请求的支持：{names}",
    cbbr_inspect: "查看详情",
    cbbr_inspect_label: "查看请求 {code} 及为其公布的答复",
    cbbr_close: "关闭",
    cbbr_dialog_kicker: "预算请求",
    cbbr_open_request: "在委员会页面上打开该请求",
    cbbr_source: "来源：{publisher}，{name}。读取于 {date}。",
    cbbr_source_link: "打开已公布的登记册",
    cbbr_empty: "在本网站保留的公布版本中，市政预算登记册没有本委员会的任何请求。这只是登记册所含的内容，并不表示本委员会没有提出过任何请求。",
    cbbr_unavailable: "本委员会的预算请求无法载入，因此此处未显示任何请求。这是读取登记册失败，而不是该委员会没有请求。",
    cbbr_unavailable_retry: "请重新载入本页重试，或前往已公布的来源查阅登记册。",
    abr_heading: "该机构答复的社区委员会预算请求",
    abr_lede_one: "{fy} 财政年度有 1 项社区委员会预算请求指明由该机构负责答复。",
    abr_lede: "{fy} 财政年度有 {count} 项社区委员会预算请求指明由该机构负责答复，来自 {boards} 个社区委员会。",
    abr_scope: "每项请求都保留提出它的辖区以及该委员会自己的优先顺序。此处没有任何全市排名，也没有对该机构答复情况的评分。",
    abr_board_open: "打开该委员会向该机构提出的请求",
    abr_overflow_one: "显示另外 1 个委员会",
    abr_overflow: "显示另外 {count} 个委员会",
    abr_overflow_close: "显示较少委员会",
    abr_empty: "在本网站保留的公布版本中，市政预算登记册没有记录任何指明该机构的社区委员会请求。",
    abr_unavailable: "指明该机构的社区委员会预算请求无法载入，因此此处未显示任何请求。这是读取登记册失败，而不是没有委员会向该机构提出过请求。",
    abr_more_one: "该委员会向该机构提出的请求中，有 1 项列在该委员会自己的页面上。",
    abr_more: "该委员会向该机构提出的请求中，有 {count} 项列在该委员会自己的页面上。",
  },
  ko: {
    cbbr_heading: "이 구가 시 기관에 제출한 예산 요청",
    cbbr_lede_one: "시 예산 등록부에는 이 위원회가 {fy} 회계연도를 위해 제출한 요청이 1건 있습니다.",
    cbbr_lede: "시 예산 등록부에는 이 위원회가 {fy} 회계연도를 위해 제출한 요청이 {count}건 있으며, {agencies}개 기관을 상대로 합니다.",
    cbbr_boundary: "요청은 위원회가 요구한 내용입니다. 응답은 그 날짜에 그 요청에 대해 공개된 서면 답변입니다. 어느 쪽도 예산 배정이나 약속, 이행이 아니며, 우호적인 답변을 받은 요청이 곧 사업이 된 것은 아닙니다.",
    cbbr_rank_boundary: "우선순위 번호는 한 기관과 한 예산 유형 안에서 이 위원회가 매긴 자체 순서입니다. 서로 다른 기관에 제출한 요청은 같은 척도 위에 있지 않으며, 여기에 시 전체 순위는 없습니다.",
    cbbr_changed_none: "여기에는 두 차례 공개 사이에 다르게 읽히는 답변을 가진 요청이 없습니다.",
    cbbr_changed_one: "요청 1건의 답변이 나중 공개본에서 다르게 읽힙니다.",
    cbbr_changed: "요청 {count}건의 답변이 나중 공개본에서 다르게 읽힙니다.",
    cbbr_scope_lead: "기관을 선택하세요:",
    cbbr_group_count_one: "요청 1건",
    cbbr_group_count: "요청 {count}건",
    cbbr_group_open_one: "이 요청 보기",
    cbbr_group_open: "이 요청 {count}건 보기",
    cbbr_group_close: "기관 적게 보기",
    cbbr_agency_page: "이 기관 열기",
    cbbr_agency_unbound: "이 사이트에는 이 기관의 페이지가 없어서, 시가 공개한 표기를 그대로 씁니다.",
    cbbr_rank: "이 위원회가 이 기관에 제출한 {class} 요청 가운데 우선순위 {rank}",
    cbbr_rank_plain: "우선순위 {rank}",
    cbbr_class_capital: "자본",
    cbbr_class_expense: "경상",
    cbbr_class_continued: "계속 지원",
    cbbr_fiscal_year: "{year} 회계연도",
    cbbr_code: "추적 번호 {code}",
    cbbr_answers_heading: "이 요청에 대해 공개된 답변",
    cbbr_answer_on: "{date} 공개",
    cbbr_answer_changed: "이 답변은 {date}에 공개된 답변과 다르게 읽힙니다.",
    cbbr_answer_wrapper_only: "{date}과 이번 공개 사이에는 발행 기관의 감싸는 문장만 바뀌었습니다. 답변 자체는 같게 읽힙니다.",
    cbbr_answer_same: "이 답변은 {date}에 공개된 답변과 같게 읽힙니다.",
    cbbr_explanation_heading: "위원회가 쓴 내용",
    cbbr_location: "위원회가 밝힌 위치: {location}",
    cbbr_location_absent: "위원회는 이 요청에 위치를 밝히지 않았습니다.",
    cbbr_supported_by: "위원회가 이 요청에 대한 지지로 기록한 곳: {names}",
    cbbr_inspect: "자세히 보기",
    cbbr_inspect_label: "요청 {code}과 그에 대해 공개된 답변 살펴보기",
    cbbr_close: "닫기",
    cbbr_dialog_kicker: "예산 요청",
    cbbr_open_request: "위원회 페이지에서 이 요청 열기",
    cbbr_source: "출처: {publisher}, {name}. {date} 열람.",
    cbbr_source_link: "공개된 등록부 열기",
    cbbr_empty: "이 사이트가 보관한 공개본에는 시 예산 등록부에 이 위원회의 요청이 없습니다. 이는 등록부에 담긴 내용일 뿐이며, 이 위원회가 아무것도 요청하지 않았다는 기록은 아닙니다.",
    cbbr_unavailable: "이 위원회의 예산 요청을 불러오지 못해 여기에는 아무것도 표시되지 않습니다. 등록부를 읽지 못한 것이지, 요청이 없는 위원회가 아닙니다.",
    cbbr_unavailable_retry: "이 페이지를 새로 고쳐 다시 시도하거나, 공개된 출처에서 등록부를 확인하세요.",
    abr_heading: "이 기관이 답변하는 커뮤니티 위원회 예산 요청",
    abr_lede_one: "{fy} 회계연도 커뮤니티 위원회 예산 요청 1건이 이 기관을 답변 책임 기관으로 지목합니다.",
    abr_lede: "{fy} 회계연도 커뮤니티 위원회 예산 요청 {count}건이 이 기관을 답변 책임 기관으로 지목하며, {boards}개 커뮤니티 위원회에서 왔습니다.",
    abr_scope: "각 요청은 그것을 제출한 지구와 그 위원회 자체의 우선순위를 그대로 유지합니다. 여기에 시 전체 순위는 없으며, 기관이 어떻게 답변했는지를 점수로 매기지도 않습니다.",
    abr_board_open: "이 위원회가 이 기관에 제출한 요청 열기",
    abr_overflow_one: "다른 위원회 1곳 보기",
    abr_overflow: "다른 위원회 {count}곳 보기",
    abr_overflow_close: "위원회 적게 보기",
    abr_empty: "이 사이트가 보관한 공개본에는 시 예산 등록부에 이 기관을 지목한 커뮤니티 위원회 요청이 없습니다.",
    abr_unavailable: "이 기관을 지목한 커뮤니티 위원회 예산 요청을 불러오지 못해 여기에는 아무것도 표시되지 않습니다. 등록부를 읽지 못한 것이지, 어떤 위원회도 요청하지 않은 기관이 아닙니다.",
    abr_more_one: "이 위원회가 이 기관에 제출한 요청 가운데 1건은 위원회 자체 페이지에 실려 있습니다.",
    abr_more: "이 위원회가 이 기관에 제출한 요청 가운데 {count}건은 위원회 자체 페이지에 실려 있습니다.",
  },
  ar: {
    cbbr_heading: "طلبات الميزانية التي قدّمها هذا الحي إلى وكالات المدينة",
    cbbr_lede_one: "يتضمن سجل ميزانية المدينة طلبًا واحدًا قدّمه هذا المجلس للسنة المالية {fy}.",
    cbbr_lede: "يتضمن سجل ميزانية المدينة {count} طلبًا قدّمها هذا المجلس للسنة المالية {fy}، موجهة إلى {agencies} وكالة.",
    cbbr_boundary: "الطلب هو ما طلبه المجلس. والرد هو الجواب المكتوب الذي نُشر له في ذلك التاريخ. وليس أي منهما تمويلًا ولا التزامًا ولا تنفيذًا، والطلب الذي حصل على جواب مؤيد ليس مشروعًا قائمًا.",
    cbbr_rank_boundary: "رقم الأولوية هو ترتيب المجلس نفسه داخل وكالة واحدة ونوع ميزانية واحد. والطلبات الموجهة إلى وكالات مختلفة ليست على مقياس واحد، ولا يوجد هنا أي ترتيب على مستوى المدينة.",
    cbbr_changed_none: "لا يحمل أي طلب هنا جوابًا يُقرأ بصورة مختلفة بين النشرتين.",
    cbbr_changed_one: "يحمل طلب واحد جوابًا يُقرأ بصورة مختلفة في النشرة الأحدث.",
    cbbr_changed: "تحمل {count} طلبات جوابًا يُقرأ بصورة مختلفة في النشرة الأحدث.",
    cbbr_scope_lead: "اختر وكالة:",
    cbbr_group_count_one: "طلب واحد",
    cbbr_group_count: "{count} طلبًا",
    cbbr_group_open_one: "إظهار هذا الطلب",
    cbbr_group_open: "إظهار هذه الطلبات البالغة {count}",
    cbbr_group_close: "إظهار عدد أقل من الوكالات",
    cbbr_agency_page: "فتح هذه الوكالة",
    cbbr_agency_unbound: "لا يحتوي هذا الموقع على صفحة لهذه الوكالة، لذا يبقى اسمها كما نشرته المدينة.",
    cbbr_rank: "الأولوية {rank} بين طلبات {class} التي قدّمها هذا المجلس إلى هذه الوكالة",
    cbbr_rank_plain: "الأولوية {rank}",
    cbbr_class_capital: "رأسمالية",
    cbbr_class_expense: "تشغيلية",
    cbbr_class_continued: "دعم مستمر",
    cbbr_fiscal_year: "السنة المالية {year}",
    cbbr_code: "رمز التتبع {code}",
    cbbr_answers_heading: "الأجوبة المنشورة عن هذا الطلب",
    cbbr_answer_on: "نُشر في {date}",
    cbbr_answer_changed: "يُقرأ هذا الجواب بصورة مختلفة عن الجواب المنشور في {date}.",
    cbbr_answer_wrapper_only: "بين {date} وهذه النشرة تغيّرت جملة الإطار الخاصة بالناشر فقط، أما الجواب نفسه فيُقرأ كما هو.",
    cbbr_answer_same: "يُقرأ هذا الجواب كما الجواب المنشور في {date}.",
    cbbr_explanation_heading: "ما كتبه المجلس",
    cbbr_location: "الموقع الذي ذكره المجلس: {location}",
    cbbr_location_absent: "لم يذكر المجلس أي موقع لهذا الطلب.",
    cbbr_supported_by: "سجّل المجلس تأييد هذا الطلب من: {names}",
    cbbr_inspect: "استعراض",
    cbbr_inspect_label: "استعراض الطلب {code} والأجوبة المنشورة عنه",
    cbbr_close: "إغلاق",
    cbbr_dialog_kicker: "طلب ميزانية",
    cbbr_open_request: "فتح هذا الطلب في صفحة المجلس",
    cbbr_source: "المصدر: {publisher}، {name}. اطُّلع عليه في {date}.",
    cbbr_source_link: "فتح السجل المنشور",
    cbbr_empty: "لا يتضمن سجل ميزانية المدينة أي طلب من هذا المجلس في النشرات التي يحتفظ بها هذا الموقع. هذا ما يحتويه السجل، وليس دليلًا على أن هذا المجلس لم يطلب شيئًا.",
    cbbr_unavailable: "تعذّر تحميل طلبات الميزانية الخاصة بهذا المجلس، لذا لا يظهر أي منها هنا. هذا إخفاق في قراءة السجل، وليس مجلسًا بلا طلبات.",
    cbbr_unavailable_retry: "أعد تحميل هذه الصفحة للمحاولة مرة أخرى، أو اطّلع على السجل في المصدر المنشور.",
    abr_heading: "طلبات ميزانية المجالس المحلية التي تجيب عنها هذه الوكالة",
    abr_lede_one: "يذكر طلب ميزانية واحد من مجلس محلي للسنة المالية {fy} هذه الوكالة بوصفها الجهة المسؤولة عن الإجابة عنه.",
    abr_lede: "تذكر {count} من طلبات ميزانية المجالس المحلية للسنة المالية {fy} هذه الوكالة بوصفها الجهة المسؤولة عن الإجابة عنها، وهي واردة من {boards} مجلسًا محليًا.",
    abr_scope: "يحتفظ كل طلب بالحي الذي قدّمه وبترتيب الأولوية الخاص بذلك المجلس. ولا يوجد هنا أي ترتيب على مستوى المدينة، ولا تقييم لطريقة إجابة الوكالة.",
    abr_board_open: "فتح طلبات هذا المجلس الموجهة إلى هذه الوكالة",
    abr_overflow_one: "إظهار المجلس الآخر",
    abr_overflow: "إظهار المجالس الأخرى البالغة {count}",
    abr_overflow_close: "إظهار عدد أقل من المجالس",
    abr_empty: "لا يسجّل سجل ميزانية المدينة أي طلب من مجلس محلي يذكر هذه الوكالة في النشرات التي يحتفظ بها هذا الموقع.",
    abr_unavailable: "تعذّر تحميل طلبات ميزانية المجالس المحلية التي تذكر هذه الوكالة، لذا لا يظهر أي منها هنا. هذا إخفاق في قراءة السجل، وليست وكالة لم يطلب منها أي مجلس شيئًا.",
    abr_more_one: "أحد طلبات هذا المجلس إلى هذه الوكالة مدرج في صفحة المجلس نفسه.",
    abr_more: "{count} من طلبات هذا المجلس إلى هذه الوكالة مدرجة في صفحة المجلس نفسه.",
  },
  ur: {
    cbbr_heading: "اس ضلع نے شہری اداروں سے جو بجٹ درخواستیں کیں",
    cbbr_lede_one: "شہر کے بجٹ رجسٹر میں اس بورڈ کی مالی سال {fy} کے لیے کی گئی ایک درخواست موجود ہے۔",
    cbbr_lede: "شہر کے بجٹ رجسٹر میں اس بورڈ کی مالی سال {fy} کے لیے کی گئی {count} درخواستیں موجود ہیں، جو {agencies} اداروں کو دی گئیں۔",
    cbbr_boundary: "درخواست وہ ہے جو بورڈ نے مانگا۔ جواب وہ تحریری جواب ہے جو اُس تاریخ کو اس کے لیے شائع ہوا۔ ان میں سے کوئی بھی فنڈنگ، وعدہ یا تکمیل نہیں، اور حمایتی جواب والی درخواست کوئی منظور شدہ منصوبہ نہیں۔",
    cbbr_rank_boundary: "ترجیحی نمبر ایک ادارے اور ایک بجٹ قسم کے اندر اس بورڈ کی اپنی ترتیب ہے۔ مختلف اداروں کو دی گئی درخواستیں ایک ہی پیمانے پر نہیں ہیں، اور یہاں شہر بھر کی کوئی درجہ بندی نہیں۔",
    cbbr_changed_none: "یہاں کسی درخواست کا جواب دونوں اشاعتوں کے درمیان مختلف نہیں پڑھا جاتا۔",
    cbbr_changed_one: "ایک درخواست کا جواب بعد کی اشاعت میں مختلف پڑھا جاتا ہے۔",
    cbbr_changed: "{count} درخواستوں کا جواب بعد کی اشاعت میں مختلف پڑھا جاتا ہے۔",
    cbbr_scope_lead: "ایک ادارہ منتخب کریں:",
    cbbr_group_count_one: "1 درخواست",
    cbbr_group_count: "{count} درخواستیں",
    cbbr_group_open_one: "یہ درخواست دکھائیں",
    cbbr_group_open: "یہ {count} درخواستیں دکھائیں",
    cbbr_group_close: "کم ادارے دکھائیں",
    cbbr_agency_page: "یہ ادارہ کھولیں",
    cbbr_agency_unbound: "اس سائٹ پر اس ادارے کا کوئی صفحہ نہیں، اس لیے اس کا نام ویسا ہی رکھا گیا ہے جیسا شہر نے شائع کیا۔",
    cbbr_rank: "اس ادارے کو دی گئی اس بورڈ کی {class} درخواستوں میں ترجیح {rank}",
    cbbr_rank_plain: "ترجیح {rank}",
    cbbr_class_capital: "سرمایہ",
    cbbr_class_expense: "اخراجات",
    cbbr_class_continued: "جاری معاونت",
    cbbr_fiscal_year: "مالی سال {year}",
    cbbr_code: "ٹریکنگ کوڈ {code}",
    cbbr_answers_heading: "اس درخواست کے لیے شائع شدہ جوابات",
    cbbr_answer_on: "{date} کو شائع ہوا",
    cbbr_answer_changed: "یہ جواب {date} کو شائع ہونے والے جواب سے مختلف پڑھا جاتا ہے۔",
    cbbr_answer_wrapper_only: "{date} اور اس اشاعت کے درمیان صرف ناشر کا احاطہ کرنے والا جملہ بدلا۔ جواب خود ویسا ہی پڑھا جاتا ہے۔",
    cbbr_answer_same: "یہ جواب {date} کو شائع ہونے والے جواب جیسا ہی پڑھا جاتا ہے۔",
    cbbr_explanation_heading: "بورڈ نے کیا لکھا",
    cbbr_location: "بورڈ کا بتایا ہوا مقام: {location}",
    cbbr_location_absent: "بورڈ نے اس درخواست کے لیے کوئی مقام نہیں بتایا۔",
    cbbr_supported_by: "بورڈ نے اس درخواست کی حمایت اِن کی جانب سے درج کی: {names}",
    cbbr_inspect: "تفصیل دیکھیں",
    cbbr_inspect_label: "درخواست {code} اور اس کے لیے شائع شدہ جوابات دیکھیں",
    cbbr_close: "بند کریں",
    cbbr_dialog_kicker: "بجٹ درخواست",
    cbbr_open_request: "بورڈ کے صفحے پر یہ درخواست کھولیں",
    cbbr_source: "ماخذ: {publisher}، {name}۔ {date} کو پڑھا گیا۔",
    cbbr_source_link: "شائع شدہ رجسٹر کھولیں",
    cbbr_empty: "اس سائٹ کے محفوظ کردہ اشاعتوں میں شہر کے بجٹ رجسٹر میں اس بورڈ کی کوئی درخواست نہیں۔ یہ رجسٹر کا مواد ہے؛ یہ اس بات کا ریکارڈ نہیں کہ اس بورڈ نے کچھ نہیں مانگا۔",
    cbbr_unavailable: "اس بورڈ کی بجٹ درخواستیں لوڈ نہیں ہو سکیں، اس لیے یہاں کوئی نہیں دکھائی گئی۔ یہ رجسٹر پڑھنے میں ناکامی ہے، درخواستوں کے بغیر بورڈ نہیں۔",
    cbbr_unavailable_retry: "دوبارہ کوشش کے لیے یہ صفحہ ری لوڈ کریں، یا شائع شدہ ماخذ پر رجسٹر پڑھیں۔",
    abr_heading: "کمیونٹی بورڈ کی وہ بجٹ درخواستیں جن کا جواب یہ ادارہ دیتا ہے",
    abr_lede_one: "مالی سال {fy} کی ایک کمیونٹی بورڈ بجٹ درخواست اس ادارے کو جواب دینے کا ذمہ دار قرار دیتی ہے۔",
    abr_lede: "مالی سال {fy} کی {count} کمیونٹی بورڈ بجٹ درخواستیں اس ادارے کو جواب دینے کا ذمہ دار قرار دیتی ہیں۔ یہ {boards} کمیونٹی بورڈز سے آئی ہیں۔",
    abr_scope: "ہر درخواست اُس ضلع اور اُس بورڈ کی اپنی ترجیحی ترتیب برقرار رکھتی ہے جس نے وہ کی۔ یہاں شہر بھر کی کوئی درجہ بندی نہیں، اور نہ ہی ادارے کے جواب دینے کے انداز کا کوئی اسکور۔",
    abr_board_open: "اس ادارے کو دی گئی اس بورڈ کی درخواستیں کھولیں",
    abr_overflow_one: "دوسرا بورڈ دکھائیں",
    abr_overflow: "باقی {count} بورڈ دکھائیں",
    abr_overflow_close: "کم بورڈ دکھائیں",
    abr_empty: "اس سائٹ کے محفوظ کردہ اشاعتوں میں شہر کا بجٹ رجسٹر اس ادارے کا نام لینے والی کوئی کمیونٹی بورڈ درخواست درج نہیں کرتا۔",
    abr_unavailable: "اس ادارے کا نام لینے والی کمیونٹی بورڈ بجٹ درخواستیں لوڈ نہیں ہو سکیں، اس لیے یہاں کوئی نہیں دکھائی گئی۔ یہ رجسٹر پڑھنے میں ناکامی ہے، ایسا ادارہ نہیں جس سے کسی بورڈ نے کچھ نہ مانگا ہو۔",
    abr_more_one: "اس ادارے کو دی گئی اس بورڈ کی ایک درخواست خود بورڈ کے صفحے پر درج ہے۔",
    abr_more: "اس ادارے کو دی گئی اس بورڈ کی {count} درخواستیں خود بورڈ کے صفحے پر درج ہیں۔",
  },
  pl: {
    cbbr_heading: "Wnioski budżetowe, które ta dzielnica złożyła do agencji miejskich",
    cbbr_lede_one: "Miejski rejestr budżetowy zawiera jeden wniosek złożony przez tę radę na rok budżetowy {fy}.",
    cbbr_lede: "Miejski rejestr budżetowy zawiera {count} wniosków złożonych przez tę radę na rok budżetowy {fy}, skierowanych do {agencies} agencji.",
    cbbr_boundary: "Wniosek to to, o co poprosiła rada. Odpowiedź to pisemna odpowiedź opublikowana dla niego w tej dacie. Żadne z nich nie jest finansowaniem, zobowiązaniem ani realizacją, a wniosek z przychylną odpowiedzią nie jest projektem.",
    cbbr_rank_boundary: "Numer priorytetu to własna kolejność tej rady w obrębie jednej agencji i jednego rodzaju budżetu. Wnioski do różnych agencji nie są na jednej skali, a nic tutaj nie jest rankingiem ogólnomiejskim.",
    cbbr_changed_none: "Żaden wniosek tutaj nie ma odpowiedzi, która czyta się inaczej między dwiema publikacjami.",
    cbbr_changed_one: "Jeden wniosek ma odpowiedź, która czyta się inaczej w późniejszej publikacji.",
    cbbr_changed: "Wniosków z odpowiedzią, która czyta się inaczej w późniejszej publikacji: {count}.",
    cbbr_scope_lead: "Wybierz agencję:",
    cbbr_group_count_one: "1 wniosek",
    cbbr_group_count: "wnioski: {count}",
    cbbr_group_open_one: "Pokaż ten wniosek",
    cbbr_group_open: "Pokaż te wnioski: {count}",
    cbbr_group_close: "Pokaż mniej agencji",
    cbbr_agency_page: "Otwórz tę agencję",
    cbbr_agency_unbound: "Ta witryna nie ma strony dla tej agencji, więc jej nazwa pozostaje w brzmieniu opublikowanym przez miasto.",
    cbbr_rank: "Priorytet {rank} wśród wniosków tej rady do tej agencji z kategorii „{class}”",
    cbbr_rank_plain: "Priorytet {rank}",
    cbbr_class_capital: "inwestycyjne",
    cbbr_class_expense: "bieżące",
    cbbr_class_continued: "kontynuacja wsparcia",
    cbbr_fiscal_year: "Rok budżetowy {year}",
    cbbr_code: "Kod ewidencyjny {code}",
    cbbr_answers_heading: "Odpowiedzi opublikowane na ten wniosek",
    cbbr_answer_on: "Opublikowano {date}",
    cbbr_answer_changed: "Ta odpowiedź czyta się inaczej niż ta opublikowana {date}.",
    cbbr_answer_wrapper_only: "Między {date} a tą publikacją zmieniło się wyłącznie zdanie ramowe wydawcy. Sama odpowiedź czyta się tak samo.",
    cbbr_answer_same: "Ta odpowiedź czyta się tak samo jak ta opublikowana {date}.",
    cbbr_explanation_heading: "Co napisała rada",
    cbbr_location: "Lokalizacja podana przez radę: {location}",
    cbbr_location_absent: "Rada nie podała lokalizacji dla tego wniosku.",
    cbbr_supported_by: "Rada odnotowała poparcie dla tego wniosku ze strony: {names}",
    cbbr_inspect: "Sprawdź",
    cbbr_inspect_label: "Sprawdź wniosek {code} i opublikowane na niego odpowiedzi",
    cbbr_close: "Zamknij",
    cbbr_dialog_kicker: "Wniosek budżetowy",
    cbbr_open_request: "Otwórz ten wniosek na stronie rady",
    cbbr_source: "Źródło: {publisher}, {name}. Odczytano {date}.",
    cbbr_source_link: "Otwórz opublikowany rejestr",
    cbbr_empty: "Miejski rejestr budżetowy nie zawiera żadnego wniosku tej rady w publikacjach, które ta witryna przechowuje. To zawartość rejestru, a nie dowód, że ta rada o nic nie wystąpiła.",
    cbbr_unavailable: "Nie udało się wczytać wniosków budżetowych tej rady, więc żaden nie jest tu pokazany. To niepowodzenie odczytu rejestru, a nie rada bez wniosków.",
    cbbr_unavailable_retry: "Odśwież tę stronę, aby spróbować ponownie, albo przeczytaj rejestr w opublikowanym źródle.",
    abr_heading: "Wnioski budżetowe rad osiedli, na które odpowiada ta agencja",
    abr_lede_one: "Jeden wniosek budżetowy rady osiedla na rok budżetowy {fy} wskazuje tę agencję jako odpowiedzialną za odpowiedź.",
    abr_lede: "Wniosków budżetowych rad osiedli na rok budżetowy {fy} wskazujących tę agencję jako odpowiedzialną za odpowiedź: {count}. Pochodzą z rad osiedli: {boards}.",
    abr_scope: "Każdy wniosek zachowuje dzielnicę, która go złożyła, i własną kolejność priorytetów tej rady. Nic tutaj nie jest rankingiem ogólnomiejskim ani oceną tego, jak agencja odpowiedziała.",
    abr_board_open: "Otwórz wnioski tej rady do tej agencji",
    abr_overflow_one: "Pokaż drugą radę",
    abr_overflow: "Pokaż pozostałe rady: {count}",
    abr_overflow_close: "Pokaż mniej rad",
    abr_empty: "Miejski rejestr budżetowy nie odnotowuje żadnego wniosku rady osiedla wskazującego tę agencję w publikacjach, które ta witryna przechowuje.",
    abr_unavailable: "Nie udało się wczytać wniosków budżetowych rad osiedli wskazujących tę agencję, więc żaden nie jest tu pokazany. To niepowodzenie odczytu rejestru, a nie agencja, do której żadna rada nic nie skierowała.",
    abr_more_one: "Jeden z wniosków tej rady do tej agencji jest wymieniony na własnej stronie rady.",
    abr_more: "Wniosków tej rady do tej agencji wymienionych na własnej stronie rady: {count}.",
  },
};

function budgetRequestT(lang) {
  const values = BUDGET_REQUEST_STRINGS[lang] || BUDGET_REQUEST_STRINGS.en;
  return (key, vars = {}) => String(values[key] || BUDGET_REQUEST_STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ""));
}

/** Publisher text keeps its own language and direction inside a translated page. */
function budgetRequestSourceText(value) {
  return `<span lang="en" dir="ltr">${budgetRequestEsc(value)}</span>`;
}

/**
 * A translated sentence with one publisher value inside it.
 *
 * The value is placed through a private-use sentinel rather than by trimming
 * the end of the sentence, so a language that puts the value first, last or in
 * the middle all render correctly and the publisher's own text keeps its bidi
 * isolation.
 */
const BUDGET_REQUEST_SENTINEL = "\ue000";

function budgetRequestSentence(t, key, name, value, vars = {}) {
  return budgetRequestEsc(t(key, { ...vars, [name]: BUDGET_REQUEST_SENTINEL }))
    .replace(BUDGET_REQUEST_SENTINEL, budgetRequestSourceText(value));
}

const BUDGET_REQUEST_CLASS_KEYS = Object.freeze({
  capital: "cbbr_class_capital",
  expense: "cbbr_class_expense",
  "continued-support": "cbbr_class_continued",
});

function budgetRequestClassLabel(requestClass, t) {
  const key = BUDGET_REQUEST_CLASS_KEYS[requestClass];
  return key ? t(key) : null;
}

/**
 * The board's own priority line.
 *
 * The publisher ranks inside one agency and one budget type, and the sentence
 * says so rather than printing a bare number a reader could mistake for a
 * citywide place in line. A rank published under any other scope falls back to
 * the plain form instead of being described with a scope it does not have.
 */
function budgetRequestRankSentence(request, t) {
  if (!request.rank) return null;
  const label = budgetRequestClassLabel(request.request_class, t);
  if (request.rank.scope !== "agency_and_request_class" || !label) {
    return t("cbbr_rank_plain", { rank: request.rank.value });
  }
  return t("cbbr_rank", { rank: request.rank.value, class: label });
}

/**
 * One published answer, with what changed since the answer before it.
 *
 * The three notes are three different findings and never collapse into one: the
 * answer reads differently, only the publisher's wrapper sentence moved, or
 * nothing changed at all. The middle case is the one that would otherwise be
 * reported as a new civic outcome when a budget stage label moved.
 */
function budgetRequestAnswerNote(answer, t, lang) {
  if (answer.changed === null) return null;
  const previous = budgetRequestFormatDay(answer.previous_publication_date, lang);
  if (!previous) return null;
  if (answer.changed) return t("cbbr_answer_changed", { date: previous });
  if (answer.wrapper_only) return t("cbbr_answer_wrapper_only", { date: previous });
  return t("cbbr_answer_same", { date: previous });
}

function budgetRequestAnswerMarkup(answer, t, lang) {
  const day = budgetRequestFormatDay(answer.publication_date, lang);
  const note = budgetRequestAnswerNote(answer, t, lang);
  const state = answer.changed === true ? "changed" : (answer.wrapper_only === true ? "wrapper_only" : "same");
  return `<li class="board-budget-request-answer" data-publication="${budgetRequestEsc(answer.publication)}"`
    + ` data-answer-state="${budgetRequestEsc(state)}">`
    + (day ? `<span class="board-budget-request-answer-date">${budgetRequestEsc(t("cbbr_answer_on", { date: day }))}</span> ` : "")
    + `<span class="board-budget-request-answer-text">${budgetRequestSourceText(answer.response || "")}</span>`
    + (note ? ` <span class="muted node-muted board-budget-request-answer-note">${budgetRequestEsc(note)}</span>` : "")
    + `</li>`;
}

/**
 * The bounded fact set the inspect control opens.
 *
 * There is no payload: the control names the request it belongs to and nothing
 * else, and the browser behaviour reads the facts back out of the row it was
 * pressed in. That is deliberate. The row is already the complete record — it
 * has to be, because a reader with no scripting gets nothing else — so a
 * payload attribute would be a second copy of the same prose on every row, and
 * two copies can disagree. Reading the rendered row instead makes the inspected
 * view provably the same record, and keeps the largest board's page from
 * carrying its own text twice.
 *
 * What the control adds is isolation: one record, away from the other hundred,
 * with the two boundary sentences beside it and its destination one explicit
 * choice away.
 */
/**
 * One request row, on either surface.
 *
 * The agency name is an ordinary anchor to that agency's own page, addressed at
 * this board's group there, so following it lands on the same pair of
 * identities the reader was already looking at. The inspect control is a native
 * button beside that anchor, never inside it, and stays invisible until the
 * boot module marks the section ready — a reader without scripting is never
 * offered an affordance that would not work, and every fact the control would
 * show is already written into the row.
 */
function budgetRequestMarkup(request, t, lang, { reciprocalHref = null, compact = false } = {}) {
  const facts = [];
  const rank = budgetRequestRankSentence(request, t);
  if (rank) facts.push(`<span class="board-budget-request-fact board-budget-request-rank">${budgetRequestEsc(rank)}</span>`);
  if (Number.isInteger(request.fiscal_year)) {
    facts.push(`<span class="board-budget-request-fact board-budget-request-fiscal-year">${budgetRequestEsc(t("cbbr_fiscal_year", { year: String(request.fiscal_year) }))}</span>`);
  }
  facts.push(`<span class="board-budget-request-fact board-budget-request-location">${
    request.location
      ? budgetRequestSentence(t, "cbbr_location", "location", request.location)
      : budgetRequestEsc(t("cbbr_location_absent"))
  }</span>`);
  const support = request.support_by.length && !compact
    ? `<p class="muted node-muted board-budget-request-support">${budgetRequestSentence(t, "cbbr_supported_by", "names", request.support_by.join(", "))}</p>`
    : "";
  // The agency surface carries the board's own words only as far as the row
  // beneath the request they belong to on that board's page. Restating every
  // district's full submission on one agency page would make the page enormous
  // without telling the reader anything the board page does not already say
  // better, and the handoff is a real link rather than a truncation.
  const explanation = request.explanation && !compact
    ? `<p class="board-budget-request-explanation">${budgetRequestSourceText(request.explanation)}</p>`
    : "";
  const answers = compact ? [request.latest_answer] : request.answers;
  const destination = reciprocalHref
    ? `<a class="ui-constellation-link board-budget-request-agency-link" href="${budgetRequestEsc(reciprocalHref)}">`
      + `${budgetRequestSourceText(request.agency.source_label)}</a>`
    : `<span class="board-budget-request-agency-name">${budgetRequestSourceText(request.agency.source_label)}</span>`;
  return `<li class="node-record board-budget-request" id="${budgetRequestEsc(request.anchor)}"`
    + ` data-tracking-code="${budgetRequestEsc(request.tracking_code)}"`
    + ` data-request-class="${budgetRequestEsc(request.request_class || "")}"`
    + ` data-fiscal-year="${budgetRequestEsc(String(request.fiscal_year ?? ""))}"`
    + ` data-agency-id="${budgetRequestEsc(request.agency.agency_id || "")}"`
    + ` data-changed-answer="${request.changed_answer ? "1" : "0"}">`
    + `<div class="node-record-main">`
    + `<strong class="board-budget-request-title" lang="en" dir="ltr">${budgetRequestEsc(request.title)}</strong> `
    + `<span class="board-budget-request-code" lang="en" dir="ltr">${budgetRequestEsc(request.tracking_code)}</span>`
    + `<button class="board-budget-request-inspect" type="button"`
    + ` ${BUDGET_REQUEST_ATTRIBUTE}="${budgetRequestEsc(request.tracking_code)}"`
    + ` aria-label="${budgetRequestEsc(t("cbbr_inspect_label", { code: request.tracking_code }))}">`
    + `${budgetRequestEsc(t("cbbr_inspect"))}</button>`
    + `</div>`
    + `<span class="muted node-muted board-budget-request-facts">${facts.join(" · ")}</span>`
    + `<p class="muted node-muted board-budget-request-answered-by">${destination}</p>`
    + explanation
    + support
    + `<p class="muted node-muted board-budget-request-answers-heading">${budgetRequestEsc(t("cbbr_answers_heading"))}</p>`
    + `<ol class="board-budget-request-answers">${answers.map((answer) => budgetRequestAnswerMarkup(answer, t, lang)).join("")}</ol>`
    + `</li>`;
}

function budgetRequestSourceMarkup(view, t, lang, className) {
  const parts = [];
  if (view.source?.publisher && view.source?.name) {
    const read = budgetRequestFormatDay(view.source.as_of, lang);
    parts.push(budgetRequestEsc(t("cbbr_source", {
      publisher: BUDGET_REQUEST_SENTINEL,
      name: view.source.name,
      date: read || "",
    })).replace(BUDGET_REQUEST_SENTINEL, budgetRequestSourceText(view.source.publisher)));
  }
  if (view.source?.source_url) {
    parts.push(`<a class="ui-constellation-link ${budgetRequestEsc(className)}-source" href="${budgetRequestEsc(view.source.source_url)}">${budgetRequestEsc(t("cbbr_source_link"))}</a>`);
  }
  if (!parts.length) return "";
  return `<p class="muted node-muted ${budgetRequestEsc(className)}-source-line">${parts.join(" ")}</p>`;
}

function budgetRequestChangedLine(view, t, lang, className) {
  if (view.publications.length < 2) return "";
  const text = view.changed_answer_count === 0
    ? t("cbbr_changed_none")
    : (view.changed_answer_count === 1
      ? t("cbbr_changed_one")
      : t("cbbr_changed", { count: budgetRequestFormatCount(view.changed_answer_count, lang) }));
  return `<p class="muted node-muted ${budgetRequestEsc(className)}-changed" data-changed-answer-count="${budgetRequestEsc(String(view.changed_answer_count))}">${budgetRequestEsc(text)}</p>`;
}

function budgetRequestLabels(t) {
  return JSON.stringify({
    v: BUDGET_REQUEST_PAYLOAD_VERSION,
    close: t("cbbr_close"),
    kicker: t("cbbr_dialog_kicker"),
    answers: t("cbbr_answers_heading"),
    explanation: t("cbbr_explanation_heading"),
    notes: [t("cbbr_boundary"), t("cbbr_rank_boundary")],
  });
}

function budgetRequestLangAttrs(lang) {
  return lang === "en" ? {} : { lang, dir: BUDGET_REQUEST_RTL_LANGS.has(lang) ? "rtl" : "ltr" };
}

/**
 * One agency's group on a board page.
 *
 * A group beyond the opening few keeps its heading, its count and its own
 * address, and opens when that address is the page's fragment. Choosing an
 * agency is therefore a real navigation the browser records: a reader who
 * follows a request out and comes back returns to the same agency open, at the
 * same scroll offset, with no script involved.
 */
function budgetRequestGroupMarkup(group, view, t, lang) {
  const headingId = `${group.anchor}-heading`;
  const count = group.request_count === 1
    ? t("cbbr_group_count_one")
    : t("cbbr_group_count", { count: budgetRequestFormatCount(group.request_count, lang) });
  const agencyLine = group.agency.href
    ? `<a class="ui-constellation-link board-budget-request-group-agency" href="${budgetRequestEsc(group.agency.href)}">${budgetRequestEsc(t("cbbr_agency_page"))}</a>`
    : `<span class="board-budget-request-group-unbound">${budgetRequestEsc(t("cbbr_agency_unbound"))}</span>`;
  const open = group.collapsed
    ? `<a class="ui-constellation-link board-budget-request-group-open" href="#${budgetRequestEsc(group.anchor)}">${
      budgetRequestEsc(group.request_count === 1
        ? t("cbbr_group_open_one")
        : t("cbbr_group_open", { count: budgetRequestFormatCount(group.request_count, lang) }))
    }</a>`
    : "";
  const close = group.collapsed
    ? `<a class="ui-constellation-link board-budget-request-group-close" href="#${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}">${budgetRequestEsc(t("cbbr_group_close"))}</a>`
    : "";
  const reciprocal = group.agency.href
    ? `${group.agency.href}#${AGENCY_BUDGET_REQUESTS_ANCHOR}-${view.body_id}`
    : null;
  return `<section class="board-budget-request-group" id="${budgetRequestEsc(group.anchor)}"`
    + ` aria-labelledby="${budgetRequestEsc(headingId)}"`
    + ` data-budget-request-group="${budgetRequestEsc(group.slug)}"`
    + ` data-agency-binding="${budgetRequestEsc(group.agency.binding)}"`
    + ` data-request-count="${budgetRequestEsc(String(group.request_count))}"`
    + (group.collapsed ? ` data-budget-request-group-collapsed="1"` : "")
    + `>`
    + `<h3 id="${budgetRequestEsc(headingId)}" lang="en" dir="ltr">${budgetRequestEsc(group.agency.source_label)}</h3>`
    + `<p class="muted node-muted board-budget-request-group-count">${budgetRequestEsc(count)} ${agencyLine}</p>`
    + open
    + `<ul class="node-record-list board-budget-request-list">${
      group.requests.map((request) => budgetRequestMarkup(request, t, lang, { reciprocalHref: reciprocal })).join("")
    }</ul>`
    + close
    + `</section>`;
}

/**
 * The board section markup, or "" when there is no board to render.
 *
 * Every destination is a plain anchor, so a modified click, a middle click and
 * the browser's own history behave the way they do anywhere else. Nothing here
 * needs scripting: the agency scope is a fragment, every fact is written into
 * the row, and the inspect button is revealed only once its behaviour is
 * listening.
 */
export function renderCommunityBoardBudgetRequestsSection(view, options = {}) {
  if (!view || view.schema !== COMMUNITY_BOARD_BUDGET_REQUESTS_VIEW_SCHEMA) return "";
  const lang = BUDGET_REQUEST_STRINGS[options.lang] ? options.lang : "en";
  const t = budgetRequestT(lang);
  const headingId = `${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-heading`;
  const common = {
    heading: t("cbbr_heading"),
    headingId,
    exportClass: "object_budget_requests",
    extraClass: "node-card civic-object-section board-budget-requests",
  };
  const attrs = (extra = {}) => ({
    id: COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR,
    "data-community-board-budget-requests": "1",
    "data-budget-requests-state": view.state,
    ...extra,
    ...budgetRequestLangAttrs(lang),
  });

  if (view.state === BUDGET_REQUEST_STATES.UNAVAILABLE) {
    return renderNodeSection({
      ...common,
      attrs: attrs(),
      body: `<p class="node-lede">${budgetRequestEsc(t("cbbr_unavailable"))}</p>`
        + `<p class="muted node-muted">${budgetRequestEsc(t("cbbr_unavailable_retry"))}</p>`
        + budgetRequestSourceMarkup(view, t, lang, "board-budget-requests"),
    });
  }

  if (view.state === BUDGET_REQUEST_STATES.NONE_RECORDED) {
    return renderNodeSection({
      ...common,
      attrs: attrs(),
      body: `<p class="node-lede">${budgetRequestEsc(t("cbbr_empty"))}</p>`
        + `<p class="muted node-muted board-budget-requests-boundary">${budgetRequestEsc(t("cbbr_boundary"))}</p>`
        + budgetRequestSourceMarkup(view, t, lang, "board-budget-requests"),
    });
  }

  const fiscalYear = view.fiscal_years.map((year) => String(year)).join(", ");
  const lede = view.request_count === 1
    ? t("cbbr_lede_one", { fy: fiscalYear })
    : t("cbbr_lede", {
      count: budgetRequestFormatCount(view.request_count, lang),
      fy: fiscalYear,
      agencies: budgetRequestFormatCount(view.agency_count, lang),
    });
  const scope = `<p class="muted node-muted board-budget-requests-scope-lead" id="${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-scope">${budgetRequestEsc(t("cbbr_scope_lead"))}</p>`
    + `<ul class="board-budget-requests-scope" aria-labelledby="${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-scope">${
      view.groups.map((group) => `<li><a class="ui-constellation-link board-budget-requests-scope-link" href="#${budgetRequestEsc(group.anchor)}">`
        + `${budgetRequestSourceText(group.agency.source_label)} <span class="board-budget-requests-scope-count">${
          budgetRequestEsc(group.request_count === 1
            ? t("cbbr_group_count_one")
            : t("cbbr_group_count", { count: budgetRequestFormatCount(group.request_count, lang) }))
        }</span></a></li>`).join("")
    }</ul>`;

  return renderNodeSection({
    ...common,
    attrs: attrs({
      "data-request-count": String(view.request_count),
      "data-agency-count": String(view.agency_count),
      "data-changed-answer-count": String(view.changed_answer_count),
      "data-fiscal-years": view.fiscal_years.join(","),
      "data-publication-count": String(view.publications.length),
      [BUDGET_REQUEST_LABELS_ATTRIBUTE]: budgetRequestLabels(t),
    }),
    body: `<p class="node-lede">${budgetRequestEsc(lede)}</p>`
      + `<p class="muted node-muted board-budget-requests-boundary">${budgetRequestEsc(t("cbbr_boundary"))}</p>`
      + `<p class="muted node-muted board-budget-requests-rank-boundary">${budgetRequestEsc(t("cbbr_rank_boundary"))}</p>`
      + budgetRequestChangedLine(view, t, lang, "board-budget-requests")
      + scope
      + view.groups.map((group) => budgetRequestGroupMarkup(group, view, t, lang)).join("")
      + budgetRequestSourceMarkup(view, t, lang, "board-budget-requests"),
  });
}

/**
 * One board's group on an agency page.
 *
 * The link out carries the agency's own address on the board page, so a reader
 * who opens it lands on this same pair of identities rather than on the whole
 * district's list.
 */
function budgetRequestBoardMarkup(board, t, lang) {
  const headingId = `${board.anchor}-heading`;
  const count = board.request_count === 1
    ? t("cbbr_group_count_one")
    : t("cbbr_group_count", { count: budgetRequestFormatCount(board.request_count, lang) });
  const destination = board.board_scope_href
    ? `<a class="ui-constellation-link agency-budget-request-board-link" href="${budgetRequestEsc(board.board_scope_href)}">${budgetRequestEsc(t("abr_board_open"))}</a>`
    : "";
  const shown = board.collapsed ? [] : board.requests.slice(0, BUDGET_REQUEST_AGENCY_ROWS_PER_BOARD);
  const remainder = board.requests.length - shown.length;
  const more = remainder > 0
    ? `<p class="muted node-muted agency-budget-request-more" data-remaining-count="${budgetRequestEsc(String(remainder))}">${
      budgetRequestEsc(remainder === 1
        ? t("abr_more_one")
        : t("abr_more", { count: budgetRequestFormatCount(remainder, lang) }))
    }</p>`
    : "";
  return `<section class="board-budget-request-group agency-budget-request-board" id="${budgetRequestEsc(board.anchor)}"`
    + ` aria-labelledby="${budgetRequestEsc(headingId)}"`
    + ` data-budget-request-board="${budgetRequestEsc(board.board_id)}"`
    + ` data-request-count="${budgetRequestEsc(String(board.request_count))}"`
    + ` data-rendered-count="${budgetRequestEsc(String(shown.length))}"`
    + (board.collapsed ? ` data-budget-request-group-collapsed="1"` : "")
    + `>`
    + `<h3 id="${budgetRequestEsc(headingId)}" lang="en" dir="ltr">${budgetRequestEsc(board.display_name)}</h3>`
    + `<p class="muted node-muted board-budget-request-group-count">${budgetRequestEsc(count)} ${destination}</p>`
    + (shown.length
      ? `<ul class="node-record-list board-budget-request-list">${
        shown.map((request) => budgetRequestMarkup(request, t, lang, { reciprocalHref: board.board_scope_href, compact: true })).join("")
      }</ul>`
      : "")
    + more
    + `</section>`;
}

/**
 * The agency section markup, or "" when there is nothing to render.
 *
 * The population here is the register's own, board by board. It is deliberately
 * not summarized into a score: how many requests an agency supported, refused
 * or completed is not a measure this register can carry, and printing one would
 * be an invention rather than a reading.
 */
export function renderAgencyBudgetRequestsSection(view, options = {}) {
  if (!view || view.schema !== AGENCY_BUDGET_REQUESTS_VIEW_SCHEMA) return "";
  const lang = BUDGET_REQUEST_STRINGS[options.lang] ? options.lang : "en";
  const t = budgetRequestT(lang);
  const headingId = `${AGENCY_BUDGET_REQUESTS_ANCHOR}-heading`;
  const common = {
    heading: t("abr_heading"),
    headingId,
    exportClass: "object_budget_requests",
    extraClass: "node-card civic-object-section agency-budget-requests",
  };
  const attrs = (extra = {}) => ({
    id: AGENCY_BUDGET_REQUESTS_ANCHOR,
    "data-agency-budget-requests": "1",
    "data-budget-requests-state": view.state,
    ...extra,
    ...budgetRequestLangAttrs(lang),
  });

  if (view.state === BUDGET_REQUEST_STATES.UNAVAILABLE) {
    return renderNodeSection({
      ...common,
      attrs: attrs(),
      body: `<p class="node-lede">${budgetRequestEsc(t("abr_unavailable"))}</p>`
        + `<p class="muted node-muted">${budgetRequestEsc(t("cbbr_unavailable_retry"))}</p>`
        + budgetRequestSourceMarkup(view, t, lang, "agency-budget-requests"),
    });
  }

  if (view.state === BUDGET_REQUEST_STATES.NONE_RECORDED) {
    return renderNodeSection({
      ...common,
      attrs: attrs(),
      body: `<p class="node-lede">${budgetRequestEsc(t("abr_empty"))}</p>`
        + `<p class="muted node-muted agency-budget-requests-boundary">${budgetRequestEsc(t("cbbr_boundary"))}</p>`
        + budgetRequestSourceMarkup(view, t, lang, "agency-budget-requests"),
    });
  }

  const fiscalYear = view.fiscal_years.map((year) => String(year)).join(", ");
  const lede = view.request_count === 1
    ? t("abr_lede_one", { fy: fiscalYear })
    : t("abr_lede", {
      count: budgetRequestFormatCount(view.request_count, lang),
      fy: fiscalYear,
      boards: budgetRequestFormatCount(view.board_count, lang),
    });

  return renderNodeSection({
    ...common,
    attrs: attrs({
      "data-request-count": String(view.request_count),
      "data-board-count": String(view.board_count),
      "data-changed-answer-count": String(view.changed_answer_count),
      "data-fiscal-years": view.fiscal_years.join(","),
      "data-publication-count": String(view.publications.length),
      [BUDGET_REQUEST_LABELS_ATTRIBUTE]: budgetRequestLabels(t),
    }),
    body: `<p class="node-lede">${budgetRequestEsc(lede)}</p>`
      + `<p class="muted node-muted agency-budget-requests-boundary">${budgetRequestEsc(t("cbbr_boundary"))}</p>`
      + `<p class="muted node-muted agency-budget-requests-scope">${budgetRequestEsc(t("abr_scope"))}</p>`
      + budgetRequestChangedLine(view, t, lang, "agency-budget-requests")
      + view.boards.map((board) => budgetRequestBoardMarkup(board, t, lang)).join("")
      + budgetRequestSourceMarkup(view, t, lang, "agency-budget-requests"),
  });
}

export { BUDGET_REQUEST_STRINGS };
