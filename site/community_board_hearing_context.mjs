/**
 * "The board's budget hearing is on this date, and here is what happened last
 * time" — the hearing preparation reading on a community board's page.
 *
 * A resident who wants to say something at a board's budget hearing arrives
 * with two questions. When is it, and what do I bring? This site already held
 * the second answer's raw material — the register of what this district asked
 * city agencies for and what they wrote back — and held the meeting only as a
 * broad evening with one start time. Neither on its own is much use: a start
 * time does not say which part of the evening is the budget hearing, and a
 * list of last year's requests does not say what to do with them.
 *
 * This module is the reading that connects them, and the whole of its
 * difficulty is that connecting them must not merge them.
 *
 * The fiscal year is the line. The hearing is about the coming budget; the
 * requests and the answers are the previous cycle's record. Every previous-
 * cycle fact here carries its own year, the two years are named next to each
 * other rather than blended, and the copy says in as many words that nothing
 * on last year's list is thereby on this year's agenda. A resident who came
 * away believing the board is about to debate the Cortelyou library request
 * would have been misled by this page, not helped by it.
 *
 * Three further distinctions the copy holds open:
 *
 *  - a statement passage is tied to a request by identity, not by wording.
 *    This board wrote one explanation into two different requests, so the tie
 *    is board, fiscal year, agency, budget type and the board's own priority,
 *    and the page says so where a reader could otherwise assume the words did
 *    the work.
 *  - a document with no readable text has not been read. The board's letter of
 *    comment is published as a scan; it is linked as the board published it,
 *    with the measured result, and nothing on this page reports its contents.
 *    The minutes record a vote to send that letter, which is evidence of the
 *    vote and of the letter, and of nothing inside it.
 *  - where the city's data publication and the board's own printing of the
 *    same publication do not read the same, both are shown. Picking one would
 *    be this site deciding which publisher to believe.
 *
 * And the page takes nothing. Reading it, opening a record on it and dismissing
 * that record send nothing anywhere. The one control that reaches the board is
 * the board's own registration form, which is an ordinary link to the board.
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";
import {
  BUDGET_REQUEST_LABELS_ATTRIBUTE,
  COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR,
  budgetRequestInspectLabels,
  renderBudgetRequestRecord,
} from "./community_board_budget_requests.mjs";

export const COMMUNITY_BOARD_HEARING_CONTEXT_VIEW_SCHEMA = "cityscroll.community_board_hearing_context_view.v1";
export const COMMUNITY_BOARD_HEARING_CONTEXT_ANCHOR = "board-hearing-preparation";

export const HEARING_CONTEXT_STATES = Object.freeze({
  AVAILABLE: "available",
  NONE_RECORDED: "none_recorded",
  UNAVAILABLE: "unavailable",
});

const HEARING_CONTEXT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const HEARING_CONTEXT_BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const HEARING_CONTEXT_TRACKING_CODE = /^[0-9]{9}(?:C|E|CS)$/;
const HEARING_CONTEXT_ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEARING_CONTEXT_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HEARING_CONTEXT_RTL_LANGS = new Set(["ar", "ur"]);
const HEARING_CONTEXT_SENTINEL = "\ue000";

/**
 * The ceiling on one published field, a guard against a malformed row rather
 * than an editorial choice. It sits well above the longest passage and the
 * longest published answer the retained documents hold.
 */
export const HEARING_CONTEXT_TEXT_LIMIT = 20000;

function hearingContextClean(value, max = 400) {
  return String(value ?? "")
    .replace(HEARING_CONTEXT_CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hearingContextDay(value) {
  const day = hearingContextClean(value, 10);
  return HEARING_CONTEXT_ISO_DAY.test(day) ? day : null;
}

function hearingContextEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Source text, marked as the language it was published in.
 *
 * A board's own words and an agency's own answer are English regardless of the
 * language the page around them is rendered in, so they are marked as English
 * and left in the writing direction they were published in. Translating them
 * would put this site's words in a publisher's mouth; leaving them unmarked
 * would hand a screen reader in another language a paragraph to mispronounce.
 */
function hearingContextSourceText(value) {
  const text = hearingContextClean(value, HEARING_CONTEXT_TEXT_LIMIT);
  return text ? `<span lang="en" dir="ltr">${hearingContextEsc(text)}</span>` : "";
}

function hearingContextT(lang) {
  const values = HEARING_CONTEXT_STRINGS[lang] || HEARING_CONTEXT_STRINGS.en;
  return (key, vars = {}) => String(values[key] || HEARING_CONTEXT_STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? `{${name}}` : String(vars[name])));
}

/**
 * A sentence whose only variable part is a publisher's own words.
 *
 * The sentence is translated and escaped, then the source text is placed into
 * it already marked as English, so a translated frame never claims the words
 * inside it were written in that language.
 */
function hearingContextSentence(t, key, name, value) {
  return hearingContextEsc(t(key, { [name]: HEARING_CONTEXT_SENTINEL }))
    .replace(HEARING_CONTEXT_SENTINEL, hearingContextSourceText(value));
}

function hearingContextFormatDay(value, lang) {
  const day = hearingContextDay(value);
  if (!day) return null;
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
  } catch {
    return day;
  }
}

/**
 * A published clock time, in the reader's own language.
 *
 * The board publishes "6:45 PM"; a reader whose locale writes that as "18:45"
 * should see 18:45. The value itself is the publisher's, only its rendering
 * follows the reader.
 */
function hearingContextFormatTime(value, lang) {
  const match = hearingContextClean(value, 5).match(HEARING_CONTEXT_CLOCK);
  if (!match) return null;
  try {
    return new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
      .format(new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]))));
  } catch {
    return `${match[1]}:${match[2]}`;
  }
}

function hearingContextFormatCount(value, lang) {
  try {
    return new Intl.NumberFormat(lang).format(value);
  } catch {
    return String(value);
  }
}

function hearingContextSegment(segment) {
  const startTime = hearingContextClean(segment?.start_time, 5);
  if (!HEARING_CONTEXT_CLOCK.test(startTime)) return null;
  const title = hearingContextClean(segment?.title, 400);
  if (!title) return null;
  const fiscalYear = Number.isInteger(segment?.fiscal_year) ? segment.fiscal_year : null;
  return Object.freeze({
    order: Number.isInteger(segment?.order) ? segment.order : 0,
    start_time: startTime,
    kind: ["public_hearing", "regular_meeting", "other"].includes(segment?.kind) ? segment.kind : "other",
    title,
    fiscal_year: fiscalYear,
    // A budget hearing is the segment that is a public hearing *and* names a
    // fiscal year. Neither test alone is enough: this evening also opens with a
    // public hearing that is not about the budget at all.
    budget: segment?.kind === "public_hearing" && fiscalYear !== null,
    budget_classes: Object.freeze((Array.isArray(segment?.budget_classes) ? segment.budget_classes : [])
      .map((value) => hearingContextClean(value, 20))
      .filter((value) => value === "capital" || value === "expense")),
    detail: Object.freeze((Array.isArray(segment?.detail) ? segment.detail : [])
      .map((value) => hearingContextClean(value, 1200))
      .filter(Boolean)),
  });
}

function hearingContextDocument(document) {
  const url = hearingContextClean(document?.source_url, 600);
  const title = hearingContextClean(document?.title, 300);
  if (!url || !title) return null;
  const state = ["extracted", "not_extracted", "not_attempted"].includes(document?.extraction?.state)
    ? document.extraction.state
    : "not_attempted";
  return Object.freeze({
    id: hearingContextClean(document?.id, 80),
    kind: hearingContextClean(document?.kind, 40),
    title,
    source_url: url,
    fiscal_year: Number.isInteger(document?.fiscal_year) ? document.fiscal_year : null,
    meeting_date: hearingContextDay(document?.meeting_date),
    extraction_state: state,
    extracted_characters: Number.isInteger(document?.extraction?.characters) ? document.extraction.characters : 0,
  });
}

function hearingContextPassage(passage) {
  const code = hearingContextClean(passage?.tracking_code, 20).toUpperCase();
  if (!HEARING_CONTEXT_TRACKING_CODE.test(code)) return null;
  const text = hearingContextClean(passage?.passage, HEARING_CONTEXT_TEXT_LIMIT);
  if (!text) return null;
  return Object.freeze({
    tracking_code: code,
    passage: text,
    title: hearingContextClean(passage?.title, 300) || null,
    budget_class: hearingContextClean(passage?.budget_class, 20) || null,
    rank_value: hearingContextClean(passage?.rank_value, 12) || null,
    rank_of: Number.isInteger(passage?.rank_of) ? passage.rank_of : null,
    agency_abbreviation: hearingContextClean(passage?.agency_abbreviation, 16) || null,
    agency_label: hearingContextClean(passage?.agency_label, 200) || null,
    fiscal_year: Number.isInteger(passage?.fiscal_year) ? passage.fiscal_year : null,
    identity_keys: Object.freeze((Array.isArray(passage?.identity_keys) ? passage.identity_keys : [])
      .map((value) => hearingContextClean(value, 40))
      .filter(Boolean)),
  });
}

function hearingContextDisagreement(row) {
  const code = hearingContextClean(row?.tracking_code, 20).toUpperCase();
  if (!HEARING_CONTEXT_TRACKING_CODE.test(code)) return null;
  const registerResponse = hearingContextClean(row?.register_response, HEARING_CONTEXT_TEXT_LIMIT);
  const documentResponse = hearingContextClean(row?.board_document_response, HEARING_CONTEXT_TEXT_LIMIT);
  if (!registerResponse || !documentResponse) return null;
  return Object.freeze({
    tracking_code: code,
    register_response: registerResponse,
    board_document_response: documentResponse,
    board_document_title: hearingContextClean(row?.board_document_title, 300) || null,
    board_document_url: hearingContextClean(row?.board_document_url, 600) || null,
  });
}

function hearingContextParticipation(participation) {
  return Object.freeze({
    speaking_registration_url: hearingContextClean(participation?.speaking_registration_url, 600) || null,
    passages: Object.freeze((Array.isArray(participation?.speaking_passages) ? participation.speaking_passages : [])
      .map((value) => hearingContextClean(value, 1200))
      .filter(Boolean)),
    written_testimony_passage: hearingContextClean(participation?.written_testimony_passage, 1200) || null,
    watch_urls: Object.freeze((Array.isArray(participation?.watch_urls) ? participation.watch_urls : [])
      .map((value) => hearingContextClean(value, 600))
      .filter(Boolean)),
  });
}

/**
 * The hearing preparation reading for one board, or `null` for a board this
 * reading does not cover.
 *
 * Unlike the register, which speaks for every district, this reading exists
 * only where a person has confirmed that the board publishes an agenda with
 * times and publishes its budget documents. A board with no entry gets no
 * section at all rather than an empty one, because an empty one would read as
 * "this board holds no budget hearing", which is a claim about the board
 * rather than about this site's coverage.
 */
export function communityBoardHearingContextForBoard(artifact, bodyId, { budgetRequests = null } = {}) {
  const board = hearingContextClean(bodyId, 80);
  if (!HEARING_CONTEXT_BODY_ID.test(board)) return null;

  const failed = artifact?.error || artifact?.unavailable_reason;
  const entry = (Array.isArray(artifact?.boards) ? artifact.boards : [])
    .find((row) => hearingContextClean(row?.board_id, 80) === board);
  if (!entry && !failed) return null;

  const base = {
    schema: COMMUNITY_BOARD_HEARING_CONTEXT_VIEW_SCHEMA,
    body_id: board,
    state: HEARING_CONTEXT_STATES.UNAVAILABLE,
    publisher: hearingContextClean(entry?.publisher, 200) || null,
    observed_at: hearingContextDay(String(artifact?.observed_at || "").slice(0, 10)),
  };
  if (failed || !entry) return Object.freeze({ ...base });

  const segments = Object.freeze((Array.isArray(entry.hearing?.segments) ? entry.hearing.segments : [])
    .map(hearingContextSegment)
    .filter(Boolean)
    .sort((left, right) => left.start_time.localeCompare(right.start_time) || left.order - right.order));
  if (!segments.length) return Object.freeze({ ...base, state: HEARING_CONTEXT_STATES.NONE_RECORDED });

  const budgetSegment = segments.find((segment) => segment.budget) || null;
  const previous = entry.previous_cycle || {};
  const passages = Object.freeze((Array.isArray(previous.statement_passages) ? previous.statement_passages : [])
    .map(hearingContextPassage)
    .filter(Boolean));
  const workedExampleCode = hearingContextClean(previous.worked_example_tracking_code, 20).toUpperCase();
  const workedExample = passages.find((passage) => passage.tracking_code === workedExampleCode) || null;

  // The worked example's own request row comes from the register reading the
  // page already carries, so the record taught here and the record listed
  // below it are the same object rather than two renderings that could drift.
  const request = (budgetRequests?.groups || [])
    .flatMap((group) => group.requests)
    .find((row) => row.tracking_code === workedExampleCode) || null;

  return Object.freeze({
    ...base,
    state: HEARING_CONTEXT_STATES.AVAILABLE,
    board_name: hearingContextClean(entry.board_name, 200) || null,
    hearing: Object.freeze({
      meeting_date: hearingContextDay(entry.hearing?.meeting_date),
      href: hearingContextClean(entry.hearing?.href, 600) || null,
      source_url: hearingContextClean(entry.hearing?.source_url, 600) || null,
      segments,
      budget_segment: budgetSegment,
      participation: hearingContextParticipation(entry.hearing?.participation),
    }),
    previous_cycle: Object.freeze({
      fiscal_year: Number.isInteger(previous.fiscal_year) ? previous.fiscal_year : null,
      request_count: Number.isInteger(previous.register_request_count) ? previous.register_request_count : 0,
      responses_compared: Number.isInteger(previous.responses_compared) ? previous.responses_compared : 0,
      documents: Object.freeze((Array.isArray(previous.documents) ? previous.documents : [])
        .map(hearingContextDocument)
        .filter(Boolean)),
      passages,
      worked_example: workedExample,
      worked_example_request: request,
      disagreements: Object.freeze((Array.isArray(previous.response_source_disagreements) ? previous.response_source_disagreements : [])
        .map(hearingContextDisagreement)
        .filter(Boolean)),
      ratified_resolution: previous.ratified_resolution
        ? Object.freeze({
          tally_text: hearingContextClean(previous.ratified_resolution.tally_text, 20) || null,
          action: hearingContextClean(previous.ratified_resolution.action, 400) || null,
          meeting_date: hearingContextDay(previous.ratified_resolution.meeting_date),
          document_url: hearingContextClean(previous.ratified_resolution.document_url, 600) || null,
        })
        : null,
    }),
  });
}

const HEARING_CONTEXT_STRINGS = {
  en: {
    cbhc_heading: "Preparing to speak at this board's budget hearing",
    cbhc_lede: "The board published an agenda for {date}. One part of that evening is the budget hearing, and it is about fiscal year {year}.",
    cbhc_lede_no_budget: "The board published an agenda for {date}.",
    cbhc_agenda_heading: "What the board published for that evening",
    cbhc_kind_budget: "Budget hearing, fiscal year {year}",
    cbhc_kind_hearing: "Public hearing",
    cbhc_kind_meeting: "Regular meeting",
    cbhc_kind_other: "Agenda item",
    cbhc_classes: "Capital and expense budgets.",
    cbhc_open_meeting: "Open this meeting record",
    cbhc_open_publisher: "Read the board's own page for this meeting",
    cbhc_participation_heading: "How the board says a person takes part",
    cbhc_participation_quoted: "Quoted from the board's page for this meeting.",
    cbhc_register_link: "Open the board's form to register to speak",
    cbhc_register_boundary: "This site takes no registrations and no testimony. Reading this page, opening a record on it and closing it again send nothing to anyone. The board's own form is the only thing here that reaches the board.",
    cbhc_watch_link: "Watch this meeting",
    cbhc_previous_heading: "What this district asked for last cycle, and what came back",
    cbhc_previous_lede: "The city's register holds {count} requests this board made for fiscal year {previous}, each with the answer published for it. The hearing above is about fiscal year {upcoming}.",
    cbhc_previous_lede_no_year: "The city's register holds {count} requests this board made for fiscal year {previous}, each with the answer published for it.",
    cbhc_previous_boundary: "That is the previous cycle's record. None of it is an item on the coming agenda, and nothing here says the board will raise any of it again.",
    cbhc_previous_link: "Read all of this board's fiscal year {previous} requests",
    cbhc_example_heading: "One request, read end to end",
    cbhc_example_lede: "This is what preparing from the record looks like: the board's own explanation for one request, the answer the agency published, and the question that evidence actually supports.",
    cbhc_example_statement: "What the board wrote about it in its needs statement",
    cbhc_example_identity: "This passage is tied to this request by board, fiscal year, responsible agency, budget type and the board's own priority within that agency — not by its wording. This board wrote one explanation into two different requests, so wording alone identifies nothing.",
    cbhc_example_question: "So the question this evidence supports is about the route the answer names, not about whether the work was funded. The answer does not say that it was.",
    cbhc_documents_heading: "The documents this reading is built on",
    cbhc_document_read: "This site read this document's published text.",
    cbhc_document_unread: "This document is published as a scan. Its text yielded {count} usable characters, so this site has not read it and reports nothing from inside it.",
    cbhc_document_unread_zero: "This document is published as a scan. Its text yielded no usable characters, so this site has not read it and reports nothing from inside it.",
    cbhc_document_not_attempted: "This site did not read this document's text.",
    cbhc_open_document: "Open the published document",
    cbhc_vote_heading: "A vote the ratified minutes record",
    cbhc_vote: "At its meeting on {date} the board voted {tally} {action}.",
    cbhc_vote_boundary: "That records the vote, and that the letter was sent. It is not a record of what the letter says: the letter is the scanned document above, which this site has not read.",
    cbhc_disagreement_heading: "Where the two publishers do not print the same answer",
    cbhc_disagreement_lede: "{compared} answers were compared between the city's data publication and the board's own printing of that same publication. {count} of them read differently.",
    cbhc_disagreement_lede_one: "{compared} answers were compared between the city's data publication and the board's own printing of that same publication. One of them reads differently.",
    cbhc_disagreement_none: "{compared} answers were compared between the city's data publication and the board's own printing of that same publication. None of them read differently.",
    cbhc_disagreement_register: "As the city's data publication prints it",
    cbhc_disagreement_document: "As the board's own document prints it",
    cbhc_disagreement_boundary: "Both are kept as they were published. Showing one of them would be this site deciding which publisher to believe.",
    cbhc_source: "Source: {publisher}. Read {date}.",
    cbhc_unavailable: "This board's hearing preparation context could not be loaded, so none is shown here. The failure is in reading the retained record; the board holds its hearing either way. Reload this page to try again, or read the board's own page for the meeting.",
  },
  es: {
    cbhc_heading: "Prepararse para hablar en la audiencia presupuestaria de esta junta",
    cbhc_lede: "La junta publicó una agenda para el {date}. Una parte de esa noche es la audiencia presupuestaria, y trata sobre el año fiscal {year}.",
    cbhc_lede_no_budget: "La junta publicó una agenda para el {date}.",
    cbhc_agenda_heading: "Lo que la junta publicó para esa noche",
    cbhc_kind_budget: "Audiencia presupuestaria, año fiscal {year}",
    cbhc_kind_hearing: "Audiencia pública",
    cbhc_kind_meeting: "Reunión ordinaria",
    cbhc_kind_other: "Punto de la agenda",
    cbhc_classes: "Presupuestos de capital y de gastos.",
    cbhc_open_meeting: "Abrir el registro de esta reunión",
    cbhc_open_publisher: "Leer la página de la propia junta sobre esta reunión",
    cbhc_participation_heading: "Cómo dice la junta que se participa",
    cbhc_participation_quoted: "Citado de la página de la junta sobre esta reunión.",
    cbhc_register_link: "Abrir el formulario de la junta para inscribirse a hablar",
    cbhc_register_boundary: "Este sitio no recibe inscripciones ni testimonios. Leer esta página, abrir un registro en ella y volver a cerrarlo no envía nada a nadie. El formulario de la propia junta es lo único aquí que llega a la junta.",
    cbhc_watch_link: "Ver esta reunión",
    cbhc_previous_heading: "Lo que este distrito pidió en el ciclo anterior y lo que le respondieron",
    cbhc_previous_lede: "El registro municipal contiene {count} solicitudes que esta junta hizo para el año fiscal {previous}, cada una con la respuesta publicada. La audiencia de arriba trata sobre el año fiscal {upcoming}.",
    cbhc_previous_lede_no_year: "El registro municipal contiene {count} solicitudes que esta junta hizo para el año fiscal {previous}, cada una con la respuesta publicada.",
    cbhc_previous_boundary: "Ese es el expediente del ciclo anterior. Nada de eso es un punto de la agenda venidera, y aquí no se dice que la junta vaya a plantearlo de nuevo.",
    cbhc_previous_link: "Leer todas las solicitudes de esta junta del año fiscal {previous}",
    cbhc_example_heading: "Una solicitud, leída de principio a fin",
    cbhc_example_lede: "Así se ve prepararse a partir del expediente: la explicación de la propia junta sobre una solicitud, la respuesta que publicó la agencia y la pregunta que esa evidencia sí respalda.",
    cbhc_example_statement: "Lo que la junta escribió al respecto en su declaración de necesidades",
    cbhc_example_identity: "Este pasaje se vincula a esta solicitud por junta, año fiscal, agencia responsable, tipo de presupuesto y la prioridad de la propia junta dentro de esa agencia, no por su redacción. Esta junta escribió una misma explicación en dos solicitudes distintas, así que la redacción por sí sola no identifica nada.",
    cbhc_example_question: "Por eso la pregunta que esta evidencia respalda trata sobre la vía que nombra la respuesta, no sobre si la obra se financió. La respuesta no dice que se financiara.",
    cbhc_documents_heading: "Los documentos en los que se basa esta lectura",
    cbhc_document_read: "Este sitio leyó el texto publicado de este documento.",
    cbhc_document_unread: "Este documento se publica como una imagen escaneada. Su texto dio {count} caracteres utilizables, así que este sitio no lo ha leído y no informa nada de su contenido.",
    cbhc_document_unread_zero: "Este documento se publica como una imagen escaneada. Su texto no dio ningún carácter utilizable, así que este sitio no lo ha leído y no informa nada de su contenido.",
    cbhc_document_not_attempted: "Este sitio no leyó el texto de este documento.",
    cbhc_open_document: "Abrir el documento publicado",
    cbhc_vote_heading: "Una votación que registran las actas ratificadas",
    cbhc_vote: "En su reunión del {date}, la junta votó {tally} {action}.",
    cbhc_vote_boundary: "Eso registra la votación y que la carta se envió. No es un registro de lo que dice la carta: la carta es el documento escaneado de arriba, que este sitio no ha leído.",
    cbhc_disagreement_heading: "Donde los dos editores no imprimen la misma respuesta",
    cbhc_disagreement_lede: "Se compararon {compared} respuestas entre la publicación de datos de la ciudad y la impresión de esa misma publicación hecha por la junta. {count} de ellas se leen de manera distinta.",
    cbhc_disagreement_lede_one: "Se compararon {compared} respuestas entre la publicación de datos de la ciudad y la impresión de esa misma publicación hecha por la junta. Una de ellas se lee de manera distinta.",
    cbhc_disagreement_none: "Se compararon {compared} respuestas entre la publicación de datos de la ciudad y la impresión de esa misma publicación hecha por la junta. Ninguna se lee de manera distinta.",
    cbhc_disagreement_register: "Tal como lo imprime la publicación de datos de la ciudad",
    cbhc_disagreement_document: "Tal como lo imprime el documento de la propia junta",
    cbhc_disagreement_boundary: "Se conservan ambas tal como se publicaron. Mostrar solo una sería que este sitio decidiera a qué editor creer.",
    cbhc_source: "Fuente: {publisher}. Leído el {date}.",
    cbhc_unavailable: "No se pudo cargar el contexto de preparación para la audiencia de esta junta, así que no se muestra ninguno. El fallo está en la lectura del expediente conservado; la junta celebra su audiencia igualmente. Recargue esta página para volver a intentarlo o lea la página de la propia junta sobre la reunión.",
  },
  fr: {
    cbhc_heading: "Se préparer à prendre la parole à l'audience budgétaire de ce conseil",
    cbhc_lede: "Le conseil a publié un ordre du jour pour le {date}. L'audience budgétaire est l'un des moments de cette soirée, et elle porte sur l'exercice {year}.",
    cbhc_lede_no_budget: "Le conseil a publié un ordre du jour pour le {date}.",
    cbhc_agenda_heading: "Ce que le conseil a publié pour cette soirée",
    cbhc_kind_budget: "Audience budgétaire, exercice {year}",
    cbhc_kind_hearing: "Audience publique",
    cbhc_kind_meeting: "Réunion ordinaire",
    cbhc_kind_other: "Point à l'ordre du jour",
    cbhc_classes: "Budgets d'investissement et de fonctionnement.",
    cbhc_open_meeting: "Ouvrir la fiche de cette réunion",
    cbhc_open_publisher: "Lire la page du conseil consacrée à cette réunion",
    cbhc_participation_heading: "Comment le conseil dit qu'on participe",
    cbhc_participation_quoted: "Cité de la page du conseil consacrée à cette réunion.",
    cbhc_register_link: "Ouvrir le formulaire du conseil pour s'inscrire à prendre la parole",
    cbhc_register_boundary: "Ce site ne reçoit ni inscriptions ni témoignages. Lire cette page, y ouvrir une fiche et la refermer n'envoie rien à personne. Le formulaire du conseil est la seule chose ici qui parvienne au conseil.",
    cbhc_watch_link: "Suivre cette réunion",
    cbhc_previous_heading: "Ce que ce district a demandé au cycle précédent, et ce qui lui a été répondu",
    cbhc_previous_lede: "Le registre municipal contient {count} demandes faites par ce conseil pour l'exercice {previous}, chacune accompagnée de la réponse publiée. L'audience ci-dessus porte sur l'exercice {upcoming}.",
    cbhc_previous_lede_no_year: "Le registre municipal contient {count} demandes faites par ce conseil pour l'exercice {previous}, chacune accompagnée de la réponse publiée.",
    cbhc_previous_boundary: "Il s'agit du dossier du cycle précédent. Rien de cela ne figure à l'ordre du jour à venir, et rien ici ne dit que le conseil y reviendra.",
    cbhc_previous_link: "Lire toutes les demandes de ce conseil pour l'exercice {previous}",
    cbhc_example_heading: "Une demande, lue de bout en bout",
    cbhc_example_lede: "Voilà à quoi ressemble une préparation fondée sur le dossier : l'explication du conseil pour une demande, la réponse publiée par l'agence, et la question que ces éléments permettent réellement de poser.",
    cbhc_example_statement: "Ce que le conseil en a écrit dans son état des besoins",
    cbhc_example_identity: "Ce passage est rattaché à cette demande par le conseil, l'exercice, l'agence responsable, le type de budget et la priorité propre au conseil au sein de cette agence, et non par sa formulation. Ce conseil a écrit une même explication dans deux demandes différentes : la formulation seule n'identifie rien.",
    cbhc_example_question: "La question que ces éléments permettent de poser porte donc sur la voie que la réponse indique, et non sur le financement des travaux. La réponse ne dit pas qu'ils l'ont été.",
    cbhc_documents_heading: "Les documents sur lesquels cette lecture repose",
    cbhc_document_read: "Ce site a lu le texte publié de ce document.",
    cbhc_document_unread: "Ce document est publié sous forme numérisée. Son texte n'a donné que {count} caractères exploitables : ce site ne l'a donc pas lu et ne rapporte rien de son contenu.",
    cbhc_document_unread_zero: "Ce document est publié sous forme numérisée. Son texte n'a donné aucun caractère exploitable : ce site ne l'a donc pas lu et ne rapporte rien de son contenu.",
    cbhc_document_not_attempted: "Ce site n'a pas lu le texte de ce document.",
    cbhc_open_document: "Ouvrir le document publié",
    cbhc_vote_heading: "Un vote consigné par le procès-verbal ratifié",
    cbhc_vote: "À sa réunion du {date}, le conseil a voté {tally} {action}.",
    cbhc_vote_boundary: "Cela consigne le vote et l'envoi de la lettre. Ce n'est pas un compte rendu de son contenu : la lettre est le document numérisé ci-dessus, que ce site n'a pas lu.",
    cbhc_disagreement_heading: "Là où les deux éditeurs n'impriment pas la même réponse",
    cbhc_disagreement_lede: "{compared} réponses ont été comparées entre la publication de données de la ville et l'impression de cette même publication par le conseil. {count} d'entre elles se lisent différemment.",
    cbhc_disagreement_lede_one: "{compared} réponses ont été comparées entre la publication de données de la ville et l'impression de cette même publication par le conseil. L'une d'elles se lit différemment.",
    cbhc_disagreement_none: "{compared} réponses ont été comparées entre la publication de données de la ville et l'impression de cette même publication par le conseil. Aucune ne se lit différemment.",
    cbhc_disagreement_register: "Telle que l'imprime la publication de données de la ville",
    cbhc_disagreement_document: "Telle que l'imprime le document du conseil",
    cbhc_disagreement_boundary: "Les deux sont conservées telles qu'elles ont été publiées. N'en montrer qu'une reviendrait à ce que ce site décide quel éditeur croire.",
    cbhc_source: "Source : {publisher}. Consulté le {date}.",
    cbhc_unavailable: "Le contexte de préparation à l'audience de ce conseil n'a pas pu être chargé ; rien n'est donc affiché ici. L'échec porte sur la lecture du dossier conservé ; le conseil tient son audience quoi qu'il en soit. Rechargez cette page pour réessayer, ou lisez la page du conseil consacrée à la réunion.",
  },
  ht: {
    cbhc_heading: "Prepare pou pale nan odyans bidjè konsèy sa a",
    cbhc_lede: "Konsèy la pibliye yon ajanda pou {date}. Youn nan pati aswè sa a se odyans bidjè a, e li konsène ane fiskal {year}.",
    cbhc_lede_no_budget: "Konsèy la pibliye yon ajanda pou {date}.",
    cbhc_agenda_heading: "Sa konsèy la pibliye pou aswè sa a",
    cbhc_kind_budget: "Odyans bidjè, ane fiskal {year}",
    cbhc_kind_hearing: "Odyans piblik",
    cbhc_kind_meeting: "Reyinyon regilye",
    cbhc_kind_other: "Pwen nan ajanda a",
    cbhc_classes: "Bidjè kapital ak bidjè depans.",
    cbhc_open_meeting: "Ouvri dosye reyinyon sa a",
    cbhc_open_publisher: "Li paj konsèy la fè sou reyinyon sa a",
    cbhc_participation_heading: "Jan konsèy la di yon moun patisipe",
    cbhc_participation_quoted: "Site nan paj konsèy la sou reyinyon sa a.",
    cbhc_register_link: "Ouvri fòm konsèy la pou enskri pou pale",
    cbhc_register_boundary: "Sit sa a pa pran ni enskripsyon ni temwayaj. Li paj sa a, ouvri yon dosye sou li epi refèmen l pa voye anyen bay pèsonn. Se sèlman fòm konsèy la ki rive jwenn konsèy la.",
    cbhc_watch_link: "Gade reyinyon sa a",
    cbhc_previous_heading: "Sa distri sa a te mande sik pase a, ak sa yo te reponn",
    cbhc_previous_lede: "Rejis vil la gen {count} demann konsèy sa a te fè pou ane fiskal {previous}, chak ak repons yo pibliye pou li. Odyans anwo a konsène ane fiskal {upcoming}.",
    cbhc_previous_lede_no_year: "Rejis vil la gen {count} demann konsèy sa a te fè pou ane fiskal {previous}, chak ak repons yo pibliye pou li.",
    cbhc_previous_boundary: "Sa se dosye sik anvan an. Anyen nan sa pa yon pwen sou ajanda k ap vini an, e anyen isit la pa di konsèy la ap remonte l ankò.",
    cbhc_previous_link: "Li tout demann konsèy sa a pou ane fiskal {previous}",
    cbhc_example_heading: "Yon demann, li depi nan konmansman jiska nan fen",
    cbhc_example_lede: "Men kijan prepare ak dosye a sanble: eksplikasyon konsèy la pou yon demann, repons ajans lan pibliye, ak kesyon prèv sa a reyèlman sipòte.",
    cbhc_example_statement: "Sa konsèy la te ekri sou li nan deklarasyon bezwen li a",
    cbhc_example_identity: "Pasaj sa a mare ak demann sa a pa konsèy, ane fiskal, ajans responsab, kalite bidjè ak pwòp priyorite konsèy la nan ajans sa a — pa pa fason li ekri a. Konsèy sa a te ekri yon sèl eksplikasyon nan de demann diferan, kidonk fason li ekri a pou kont li pa idantifye anyen.",
    cbhc_example_question: "Se poutèt sa kesyon prèv sa a sipòte a konsène wout repons lan site a, pa si travay la te finanse. Repons lan pa di sa.",
    cbhc_documents_heading: "Dokiman sa yo lekti sa a chita sou yo",
    cbhc_document_read: "Sit sa a li tèks dokiman sa a pibliye a.",
    cbhc_document_unread: "Dokiman sa a pibliye kòm yon imaj eskane. Tèks li a bay {count} karaktè itilizab, kidonk sit sa a pa li l e li pa rapòte anyen ki ladan l.",
    cbhc_document_unread_zero: "Dokiman sa a pibliye kòm yon imaj eskane. Tèks li a pa bay okenn karaktè itilizab, kidonk sit sa a pa li l e li pa rapòte anyen ki ladan l.",
    cbhc_document_not_attempted: "Sit sa a pa li tèks dokiman sa a.",
    cbhc_open_document: "Ouvri dokiman yo pibliye a",
    cbhc_vote_heading: "Yon vòt minit ratifye yo anrejistre",
    cbhc_vote: "Nan reyinyon li nan dat {date}, konsèy la te vote {tally} {action}.",
    cbhc_vote_boundary: "Sa anrejistre vòt la ak lefèt ke lèt la te voye. Se pa yon dosye sou sa lèt la di: lèt la se dokiman eskane anwo a, ke sit sa a pa li.",
    cbhc_disagreement_heading: "Kote de piblikatè yo pa enprime menm repons lan",
    cbhc_disagreement_lede: "{compared} repons te konpare ant piblikasyon done vil la ak enprime konsèy la fè pou menm piblikasyon an. {count} nan yo li diferan.",
    cbhc_disagreement_lede_one: "{compared} repons te konpare ant piblikasyon done vil la ak enprime konsèy la fè pou menm piblikasyon an. Youn nan yo li diferan.",
    cbhc_disagreement_none: "{compared} repons te konpare ant piblikasyon done vil la ak enprime konsèy la fè pou menm piblikasyon an. Okenn nan yo pa li diferan.",
    cbhc_disagreement_register: "Jan piblikasyon done vil la enprime l",
    cbhc_disagreement_document: "Jan pwòp dokiman konsèy la enprime l",
    cbhc_disagreement_boundary: "Toude konsève jan yo te pibliye yo. Montre yon sèl ta vle di sit sa a deside ki piblikatè pou kwè.",
    cbhc_source: "Sous: {publisher}. Li {date}.",
    cbhc_unavailable: "Kontèks preparasyon odyans konsèy sa a pa t ka chaje, kidonk yo pa montre okenn isit la. Echèk la se nan li dosye konsève a; konsèy la fè odyans li kanmèm. Rechaje paj sa a pou eseye anko, oswa li paj konsèy la fè sou reyinyon an.",
  },
  ru: {
    cbhc_heading: "Подготовка к выступлению на бюджетных слушаниях этого совета",
    cbhc_lede: "Совет опубликовал повестку на {date}. Одна из частей этого вечера — бюджетные слушания, и они касаются {year} финансового года.",
    cbhc_lede_no_budget: "Совет опубликовал повестку на {date}.",
    cbhc_agenda_heading: "Что совет опубликовал на этот вечер",
    cbhc_kind_budget: "Бюджетные слушания, {year} финансовый год",
    cbhc_kind_hearing: "Общественные слушания",
    cbhc_kind_meeting: "Очередное заседание",
    cbhc_kind_other: "Пункт повестки",
    cbhc_classes: "Капитальный бюджет и бюджет расходов.",
    cbhc_open_meeting: "Открыть запись об этом заседании",
    cbhc_open_publisher: "Прочитать страницу самого совета об этом заседании",
    cbhc_participation_heading: "Как, по словам совета, можно принять участие",
    cbhc_participation_quoted: "Цитата со страницы совета об этом заседании.",
    cbhc_register_link: "Открыть форму совета для записи на выступление",
    cbhc_register_boundary: "Этот сайт не принимает ни записи, ни показаний. Чтение этой страницы, открытие записи на ней и её закрытие никому ничего не отправляют. Только собственная форма совета доходит до совета.",
    cbhc_watch_link: "Смотреть это заседание",
    cbhc_previous_heading: "Что этот округ просил в прошлом цикле и что ему ответили",
    cbhc_previous_lede: "Городской реестр содержит {count} запросов, направленных этим советом на {previous} финансовый год, каждый с опубликованным ответом. Слушания выше касаются {upcoming} финансового года.",
    cbhc_previous_lede_no_year: "Городской реестр содержит {count} запросов, направленных этим советом на {previous} финансовый год, каждый с опубликованным ответом.",
    cbhc_previous_boundary: "Это запись прошлого цикла. Ничто из неё не является пунктом предстоящей повестки, и здесь не говорится, что совет поднимет это снова.",
    cbhc_previous_link: "Прочитать все запросы этого совета на {previous} финансовый год",
    cbhc_example_heading: "Один запрос, прочитанный от начала до конца",
    cbhc_example_lede: "Вот как выглядит подготовка по документам: собственное пояснение совета к одному запросу, ответ, опубликованный ведомством, и вопрос, который эти данные действительно позволяют задать.",
    cbhc_example_statement: "Что совет написал об этом в своём заявлении о нуждах",
    cbhc_example_identity: "Этот отрывок связан с запросом по совету, финансовому году, ответственному ведомству, типу бюджета и собственному приоритету совета внутри этого ведомства, а не по формулировке. Этот совет вписал одно и то же пояснение в два разных запроса, поэтому одна лишь формулировка ничего не определяет.",
    cbhc_example_question: "Поэтому вопрос, который эти данные поддерживают, касается пути, названного в ответе, а не того, были ли работы профинансированы. Ответ этого не утверждает.",
    cbhc_documents_heading: "Документы, на которых построено это чтение",
    cbhc_document_read: "Этот сайт прочитал опубликованный текст этого документа.",
    cbhc_document_unread: "Этот документ опубликован как скан. Из его текста получено {count} пригодных символов, поэтому сайт его не прочитал и ничего из него не сообщает.",
    cbhc_document_unread_zero: "Этот документ опубликован как скан. Из его текста не получено ни одного пригодного символа, поэтому сайт его не прочитал и ничего из него не сообщает.",
    cbhc_document_not_attempted: "Этот сайт не читал текст этого документа.",
    cbhc_open_document: "Открыть опубликованный документ",
    cbhc_vote_heading: "Голосование, зафиксированное в утверждённом протоколе",
    cbhc_vote: "На заседании {date} совет проголосовал {tally} {action}.",
    cbhc_vote_boundary: "Это фиксирует голосование и то, что письмо было отправлено. Это не запись о содержании письма: письмо — это отсканированный документ выше, который сайт не прочитал.",
    cbhc_disagreement_heading: "Там, где два издателя печатают ответ по-разному",
    cbhc_disagreement_lede: "Сопоставлено {compared} ответов между городской публикацией данных и печатью той же публикации самим советом. {count} из них читаются иначе.",
    cbhc_disagreement_lede_one: "Сопоставлено {compared} ответов между городской публикацией данных и печатью той же публикации самим советом. Один из них читается иначе.",
    cbhc_disagreement_none: "Сопоставлено {compared} ответов между городской публикацией данных и печатью той же публикации самим советом. Ни один из них не читается иначе.",
    cbhc_disagreement_register: "Как это печатает городская публикация данных",
    cbhc_disagreement_document: "Как это печатает собственный документ совета",
    cbhc_disagreement_boundary: "Оба сохранены в том виде, в каком были опубликованы. Показать только один означало бы, что сайт решает, какому издателю верить.",
    cbhc_source: "Источник: {publisher}. Прочитано {date}.",
    cbhc_unavailable: "Контекст подготовки к слушаниям этого совета не удалось загрузить, поэтому он здесь не показан. Сбой касается чтения сохранённой записи; слушания совета в любом случае состоятся. Обновите страницу, чтобы повторить попытку, или прочитайте страницу самого совета об этом заседании.",
  },
  bn: {
    cbhc_heading: "এই বোর্ডের বাজেট শুনানিতে বলার প্রস্তুতি",
    cbhc_lede: "বোর্ড {date} তারিখের জন্য একটি আলোচ্যসূচি প্রকাশ করেছে। সেই সন্ধ্যার একটি অংশ হলো বাজেট শুনানি, এবং তা {year} অর্থবছর নিয়ে।",
    cbhc_lede_no_budget: "বোর্ড {date} তারিখের জন্য একটি আলোচ্যসূচি প্রকাশ করেছে।",
    cbhc_agenda_heading: "সেই সন্ধ্যার জন্য বোর্ড যা প্রকাশ করেছে",
    cbhc_kind_budget: "বাজেট শুনানি, {year} অর্থবছর",
    cbhc_kind_hearing: "প্রকাশ্য শুনানি",
    cbhc_kind_meeting: "নিয়মিত সভা",
    cbhc_kind_other: "আলোচ্যসূচির বিষয়",
    cbhc_classes: "মূলধন ও ব্যয় বাজেট।",
    cbhc_open_meeting: "এই সভার নথি খুলুন",
    cbhc_open_publisher: "এই সভা নিয়ে বোর্ডের নিজস্ব পাতা পড়ুন",
    cbhc_participation_heading: "বোর্ড যেভাবে অংশগ্রহণের কথা বলে",
    cbhc_participation_quoted: "এই সভা নিয়ে বোর্ডের পাতা থেকে উদ্ধৃত।",
    cbhc_register_link: "বলার জন্য নিবন্ধন করতে বোর্ডের ফর্ম খুলুন",
    cbhc_register_boundary: "এই সাইট কোনো নিবন্ধন বা সাক্ষ্য নেয় না। এই পাতা পড়া, এখানে কোনো নথি খোলা এবং আবার বন্ধ করা কারও কাছে কিছুই পাঠায় না। বোর্ডের নিজস্ব ফর্মই এখানে একমাত্র জিনিস যা বোর্ড পর্যন্ত পৌঁছায়।",
    cbhc_watch_link: "এই সভা দেখুন",
    cbhc_previous_heading: "গত চক্রে এই জেলা যা চেয়েছিল, এবং যা উত্তর এসেছিল",
    cbhc_previous_lede: "শহরের নিবন্ধনে {previous} অর্থবছরের জন্য এই বোর্ডের করা {count}টি অনুরোধ রয়েছে, প্রতিটির সঙ্গে প্রকাশিত উত্তর। উপরের শুনানিটি {upcoming} অর্থবছর নিয়ে।",
    cbhc_previous_lede_no_year: "শহরের নিবন্ধনে {previous} অর্থবছরের জন্য এই বোর্ডের করা {count}টি অনুরোধ রয়েছে, প্রতিটির সঙ্গে প্রকাশিত উত্তর।",
    cbhc_previous_boundary: "এটি গত চক্রের নথি। এর কোনোটিই আসন্ন আলোচ্যসূচির বিষয় নয়, এবং এখানে বলা হয়নি যে বোর্ড এগুলো আবার তুলবে।",
    cbhc_previous_link: "{previous} অর্থবছরের জন্য এই বোর্ডের সব অনুরোধ পড়ুন",
    cbhc_example_heading: "একটি অনুরোধ, শুরু থেকে শেষ পর্যন্ত পড়া",
    cbhc_example_lede: "নথি থেকে প্রস্তুতি নেওয়া দেখতে এমনই: একটি অনুরোধ নিয়ে বোর্ডের নিজের ব্যাখ্যা, সংস্থার প্রকাশিত উত্তর, এবং এই প্রমাণ আসলে যে প্রশ্নটি সমর্থন করে।",
    cbhc_example_statement: "বোর্ড তার চাহিদা-বিবৃতিতে এ বিষয়ে যা লিখেছিল",
    cbhc_example_identity: "এই অংশটি এই অনুরোধের সঙ্গে যুক্ত হয়েছে বোর্ড, অর্থবছর, দায়িত্বপ্রাপ্ত সংস্থা, বাজেটের ধরন এবং সেই সংস্থার ভিতরে বোর্ডের নিজস্ব অগ্রাধিকার দিয়ে — এর ভাষা দিয়ে নয়। এই বোর্ড একই ব্যাখ্যা দুটি ভিন্ন অনুরোধে লিখেছিল, তাই কেবল ভাষা কিছুই শনাক্ত করে না।",
    cbhc_example_question: "তাই এই প্রমাণ যে প্রশ্নটি সমর্থন করে তা উত্তরে উল্লেখ করা পথ নিয়ে, কাজটি অর্থায়ন পেয়েছিল কিনা তা নিয়ে নয়। উত্তর তা বলে না।",
    cbhc_documents_heading: "এই পাঠ যে নথিগুলির উপর দাঁড়িয়ে",
    cbhc_document_read: "এই সাইট এই নথির প্রকাশিত লেখা পড়েছে।",
    cbhc_document_unread: "এই নথিটি স্ক্যান হিসেবে প্রকাশিত। এর লেখা থেকে {count}টি ব্যবহারযোগ্য অক্ষর পাওয়া গেছে, তাই এই সাইট এটি পড়েনি এবং এর ভিতর থেকে কিছুই জানায় না।",
    cbhc_document_unread_zero: "এই নথিটি স্ক্যান হিসেবে প্রকাশিত। এর লেখা থেকে কোনো ব্যবহারযোগ্য অক্ষর পাওয়া যায়নি, তাই এই সাইট এটি পড়েনি এবং এর ভিতর থেকে কিছুই জানায় না।",
    cbhc_document_not_attempted: "এই সাইট এই নথির লেখা পড়েনি।",
    cbhc_open_document: "প্রকাশিত নথি খুলুন",
    cbhc_vote_heading: "অনুমোদিত কার্যবিবরণীতে লিপিবদ্ধ একটি ভোট",
    cbhc_vote: "{date} তারিখের সভায় বোর্ড {tally} ভোটে {action}।",
    cbhc_vote_boundary: "এটি ভোটটি এবং চিঠি পাঠানোর বিষয়টি লিপিবদ্ধ করে। এটি চিঠিতে কী আছে তার নথি নয়: চিঠিটি উপরের স্ক্যান করা নথি, যা এই সাইট পড়েনি।",
    cbhc_disagreement_heading: "যেখানে দুই প্রকাশক একই উত্তর ছাপায় না",
    cbhc_disagreement_lede: "শহরের তথ্য প্রকাশনা এবং বোর্ডের নিজস্ব ছাপার মধ্যে {compared}টি উত্তর তুলনা করা হয়েছে। এর মধ্যে {count}টি ভিন্নভাবে পড়া যায়।",
    cbhc_disagreement_lede_one: "শহরের তথ্য প্রকাশনা এবং বোর্ডের নিজস্ব ছাপার মধ্যে {compared}টি উত্তর তুলনা করা হয়েছে। এর মধ্যে একটি ভিন্নভাবে পড়া যায়।",
    cbhc_disagreement_none: "শহরের তথ্য প্রকাশনা এবং বোর্ডের নিজস্ব ছাপার মধ্যে {compared}টি উত্তর তুলনা করা হয়েছে। এর কোনোটিই ভিন্নভাবে পড়া যায় না।",
    cbhc_disagreement_register: "শহরের তথ্য প্রকাশনা যেভাবে ছাপে",
    cbhc_disagreement_document: "বোর্ডের নিজস্ব নথি যেভাবে ছাপে",
    cbhc_disagreement_boundary: "প্রকাশিত অবস্থাতেই দুটোই রাখা হয়েছে। একটিমাত্র দেখানো মানে হতো এই সাইট ঠিক করছে কোন প্রকাশককে বিশ্বাস করতে হবে।",
    cbhc_source: "উৎস: {publisher}। পড়া হয়েছে {date}।",
    cbhc_unavailable: "এই বোর্ডের শুনানি-প্রস্তুতির প্রেক্ষাপট লোড করা যায়নি, তাই এখানে কিছুই দেখানো হচ্ছে না। সমস্যাটি সংরক্ষিত নথি পড়ার মধ্যে; বোর্ড তার শুনানি তবুও করবে। আবার চেষ্টা করতে এই পাতাটি রিলোড করুন, অথবা সভা নিয়ে বোর্ডের নিজস্ব পাতা পড়ুন।",
  },
  "zh-Hans": {
    cbhc_heading: "为本委员会的预算听证会发言做准备",
    cbhc_lede: "委员会公布了 {date} 的议程。当晚的一个环节是预算听证会，涉及 {year} 财政年度。",
    cbhc_lede_no_budget: "委员会公布了 {date} 的议程。",
    cbhc_agenda_heading: "委员会为当晚公布的内容",
    cbhc_kind_budget: "预算听证会，{year} 财政年度",
    cbhc_kind_hearing: "公开听证会",
    cbhc_kind_meeting: "例会",
    cbhc_kind_other: "议程事项",
    cbhc_classes: "资本预算与开支预算。",
    cbhc_open_meeting: "打开本次会议记录",
    cbhc_open_publisher: "阅读委员会自己关于本次会议的页面",
    cbhc_participation_heading: "委员会说明的参与方式",
    cbhc_participation_quoted: "引自委员会关于本次会议的页面。",
    cbhc_register_link: "打开委员会的发言登记表",
    cbhc_register_boundary: "本站不接受任何登记或证词。阅读本页、在页上展开某条记录再将其关闭，都不会向任何人发送内容。此处只有委员会自己的表格会送达委员会。",
    cbhc_watch_link: "观看本次会议",
    cbhc_previous_heading: "本区上一周期提出的请求，以及得到的答复",
    cbhc_previous_lede: "市级登记册收录了本委员会为 {previous} 财政年度提出的 {count} 项请求，每项都附有公布的答复。上方的听证会涉及 {upcoming} 财政年度。",
    cbhc_previous_lede_no_year: "市级登记册收录了本委员会为 {previous} 财政年度提出的 {count} 项请求，每项都附有公布的答复。",
    cbhc_previous_boundary: "这是上一周期的记录。其中没有一项属于即将召开的会议议程，本页也没有说委员会会再次提出其中任何一项。",
    cbhc_previous_link: "阅读本委员会 {previous} 财政年度的全部请求",
    cbhc_example_heading: "一项请求，从头读到尾",
    cbhc_example_lede: "依据记录做准备是这样的：委员会自己对一项请求的说明、机构公布的答复，以及这些证据真正支持的问题。",
    cbhc_example_statement: "委员会在其需求声明中对此的记述",
    cbhc_example_identity: "这段文字与该请求的对应，依据的是委员会、财政年度、责任机构、预算类别以及委员会在该机构内的自定优先次序，而不是措辞。本委员会把同一段说明写进了两项不同的请求，因此仅凭措辞无法识别任何内容。",
    cbhc_example_question: "因此这些证据支持的问题，是答复所指出的途径，而不是这项工作是否获得拨款。答复并未这样说。",
    cbhc_documents_heading: "本次解读所依据的文件",
    cbhc_document_read: "本站读取了该文件公布的文本。",
    cbhc_document_unread: "该文件以扫描件形式公布。其文本仅得到 {count} 个可用字符，因此本站未曾读取，也不报告其中的任何内容。",
    cbhc_document_unread_zero: "该文件以扫描件形式公布。其文本未得到任何可用字符，因此本站未曾读取，也不报告其中的任何内容。",
    cbhc_document_not_attempted: "本站未读取该文件的文本。",
    cbhc_open_document: "打开已公布的文件",
    cbhc_vote_heading: "已批准会议记录所载的一次表决",
    cbhc_vote: "在 {date} 的会议上，委员会以 {tally} 表决{action}。",
    cbhc_vote_boundary: "这记录了表决本身，以及该函件已发出。它不是该函件内容的记录：函件是上方的扫描文件，本站并未读取。",
    cbhc_disagreement_heading: "两个发布方印出的答复不一致之处",
    cbhc_disagreement_lede: "在市级数据发布与委员会对同一次发布的自行印制之间，比对了 {compared} 条答复，其中 {count} 条读起来不同。",
    cbhc_disagreement_lede_one: "在市级数据发布与委员会对同一次发布的自行印制之间，比对了 {compared} 条答复，其中一条读起来不同。",
    cbhc_disagreement_none: "在市级数据发布与委员会对同一次发布的自行印制之间，比对了 {compared} 条答复，没有一条读起来不同。",
    cbhc_disagreement_register: "市级数据发布中的印文",
    cbhc_disagreement_document: "委员会自有文件中的印文",
    cbhc_disagreement_boundary: "两者都按公布原样保留。只呈现其中一个，等于由本站决定该相信哪一个发布方。",
    cbhc_source: "来源：{publisher}。读取于 {date}。",
    cbhc_unavailable: "本委员会的听证会准备资料无法载入，因此此处不作显示。失败在于读取留存记录；委员会的听证会照常举行。请重新载入本页重试，或阅读委员会自己关于该会议的页面。",
  },
  ko: {
    cbhc_heading: "이 위원회 예산 공청회에서 발언할 준비",
    cbhc_lede: "위원회가 {date} 일정의 안건을 공지했습니다. 그날 저녁의 한 부분이 예산 공청회이며, {year} 회계연도에 관한 것입니다.",
    cbhc_lede_no_budget: "위원회가 {date} 일정의 안건을 공지했습니다.",
    cbhc_agenda_heading: "위원회가 그날 저녁을 위해 공지한 내용",
    cbhc_kind_budget: "예산 공청회, {year} 회계연도",
    cbhc_kind_hearing: "공청회",
    cbhc_kind_meeting: "정기 회의",
    cbhc_kind_other: "안건 항목",
    cbhc_classes: "자본 예산과 경상 예산.",
    cbhc_open_meeting: "이 회의 기록 열기",
    cbhc_open_publisher: "이 회의에 관한 위원회 자체 페이지 읽기",
    cbhc_participation_heading: "위원회가 밝힌 참여 방법",
    cbhc_participation_quoted: "이 회의에 관한 위원회 페이지에서 인용.",
    cbhc_register_link: "발언 신청을 위한 위원회 양식 열기",
    cbhc_register_boundary: "이 사이트는 어떤 신청도 증언도 받지 않습니다. 이 페이지를 읽고, 여기서 기록 하나를 열고 다시 닫아도 누구에게도 아무것도 전송되지 않습니다. 여기서 위원회에 닿는 것은 위원회 자체 양식뿐입니다.",
    cbhc_watch_link: "이 회의 시청하기",
    cbhc_previous_heading: "이 지역구가 지난 주기에 요청한 것과 돌아온 답변",
    cbhc_previous_lede: "시 등록부에는 이 위원회가 {previous} 회계연도를 위해 제출한 요청 {count}건이 각각의 공표된 답변과 함께 있습니다. 위의 공청회는 {upcoming} 회계연도에 관한 것입니다.",
    cbhc_previous_lede_no_year: "시 등록부에는 이 위원회가 {previous} 회계연도를 위해 제출한 요청 {count}건이 각각의 공표된 답변과 함께 있습니다.",
    cbhc_previous_boundary: "이는 지난 주기의 기록입니다. 그중 어느 것도 다가오는 안건의 항목이 아니며, 위원회가 다시 제기하리라는 내용도 여기에는 없습니다.",
    cbhc_previous_link: "이 위원회의 {previous} 회계연도 요청 전체 읽기",
    cbhc_example_heading: "요청 하나를 처음부터 끝까지 읽기",
    cbhc_example_lede: "기록을 바탕으로 준비한다는 것은 이런 모습입니다. 한 요청에 대한 위원회 자체 설명, 기관이 공표한 답변, 그리고 그 근거가 실제로 뒷받침하는 질문입니다.",
    cbhc_example_statement: "위원회가 지역 수요 진술서에 적은 내용",
    cbhc_example_identity: "이 대목은 위원회, 회계연도, 담당 기관, 예산 유형, 그리고 그 기관 안에서 위원회가 매긴 우선순위로 이 요청과 연결됩니다. 문구로 연결한 것이 아닙니다. 이 위원회는 같은 설명을 서로 다른 두 요청에 적었으므로, 문구만으로는 아무것도 식별되지 않습니다.",
    cbhc_example_question: "그래서 이 근거가 뒷받침하는 질문은 답변이 가리키는 경로에 관한 것이지, 그 사업에 예산이 배정되었는지에 관한 것이 아닙니다. 답변은 그렇게 말하지 않습니다.",
    cbhc_documents_heading: "이 읽기가 근거로 삼은 문서",
    cbhc_document_read: "이 사이트는 이 문서의 공표된 본문을 읽었습니다.",
    cbhc_document_unread: "이 문서는 스캔본으로 공개되어 있습니다. 본문에서 사용 가능한 문자가 {count}자만 나와, 이 사이트는 이를 읽지 않았고 그 내용에 대해 아무것도 전하지 않습니다.",
    cbhc_document_unread_zero: "이 문서는 스캔본으로 공개되어 있습니다. 본문에서 사용 가능한 문자가 전혀 나오지 않아, 이 사이트는 이를 읽지 않았고 그 내용에 대해 아무것도 전하지 않습니다.",
    cbhc_document_not_attempted: "이 사이트는 이 문서의 본문을 읽지 않았습니다.",
    cbhc_open_document: "공표된 문서 열기",
    cbhc_vote_heading: "승인된 회의록에 기록된 표결",
    cbhc_vote: "{date} 회의에서 위원회는 {tally}로 {action} 의결했습니다.",
    cbhc_vote_boundary: "이는 표결과 서한이 발송되었다는 사실을 기록합니다. 서한의 내용에 대한 기록은 아닙니다. 그 서한은 위의 스캔 문서이며, 이 사이트는 읽지 않았습니다.",
    cbhc_disagreement_heading: "두 발행 주체의 답변 인쇄가 다른 지점",
    cbhc_disagreement_lede: "시의 데이터 공표와 위원회가 같은 공표를 자체 인쇄한 것 사이에서 답변 {compared}건을 비교했습니다. 그중 {count}건이 다르게 읽힙니다.",
    cbhc_disagreement_lede_one: "시의 데이터 공표와 위원회가 같은 공표를 자체 인쇄한 것 사이에서 답변 {compared}건을 비교했습니다. 그중 한 건이 다르게 읽힙니다.",
    cbhc_disagreement_none: "시의 데이터 공표와 위원회가 같은 공표를 자체 인쇄한 것 사이에서 답변 {compared}건을 비교했습니다. 다르게 읽히는 것은 없습니다.",
    cbhc_disagreement_register: "시의 데이터 공표에 인쇄된 대로",
    cbhc_disagreement_document: "위원회 자체 문서에 인쇄된 대로",
    cbhc_disagreement_boundary: "둘 다 공표된 그대로 보존합니다. 하나만 보여주는 것은 어느 발행 주체를 믿을지 이 사이트가 정하는 일이 됩니다.",
    cbhc_source: "출처: {publisher}. {date} 읽음.",
    cbhc_unavailable: "이 위원회의 공청회 준비 맥락을 불러오지 못해 여기에는 아무것도 표시되지 않습니다. 실패는 보관된 기록을 읽는 데서 생겼으며, 위원회의 공청회는 그대로 열립니다. 이 페이지를 새로 불러와 다시 시도하거나, 회의에 관한 위원회 자체 페이지를 읽어 보세요.",
  },
  ar: {
    cbhc_heading: "الاستعداد للتحدث في جلسة الميزانية لهذا المجلس",
    cbhc_lede: "نشر المجلس جدول أعمال ليوم {date}. أحد أجزاء تلك الأمسية هو جلسة الميزانية، وهي تخص السنة المالية {year}.",
    cbhc_lede_no_budget: "نشر المجلس جدول أعمال ليوم {date}.",
    cbhc_agenda_heading: "ما نشره المجلس لتلك الأمسية",
    cbhc_kind_budget: "جلسة ميزانية، السنة المالية {year}",
    cbhc_kind_hearing: "جلسة استماع علنية",
    cbhc_kind_meeting: "اجتماع دوري",
    cbhc_kind_other: "بند في جدول الأعمال",
    cbhc_classes: "الميزانية الرأسمالية وميزانية النفقات.",
    cbhc_open_meeting: "افتح سجل هذا الاجتماع",
    cbhc_open_publisher: "اقرأ صفحة المجلس نفسه عن هذا الاجتماع",
    cbhc_participation_heading: "كيف يقول المجلس إن المرء يشارك",
    cbhc_participation_quoted: "مقتبس من صفحة المجلس عن هذا الاجتماع.",
    cbhc_register_link: "افتح استمارة المجلس للتسجيل للتحدث",
    cbhc_register_boundary: "هذا الموقع لا يتلقى أي تسجيل ولا أي إفادة. قراءة هذه الصفحة وفتح سجل فيها وإغلاقه لا يرسل شيئًا إلى أحد. استمارة المجلس نفسها هي الشيء الوحيد هنا الذي يصل إلى المجلس.",
    cbhc_watch_link: "شاهد هذا الاجتماع",
    cbhc_previous_heading: "ما طلبته هذه المنطقة في الدورة السابقة، وما جاء من رد",
    cbhc_previous_lede: "يضم سجل المدينة {count} طلبًا قدّمها هذا المجلس للسنة المالية {previous}، مع الرد المنشور لكل منها. الجلسة أعلاه تخص السنة المالية {upcoming}.",
    cbhc_previous_lede_no_year: "يضم سجل المدينة {count} طلبًا قدّمها هذا المجلس للسنة المالية {previous}، مع الرد المنشور لكل منها.",
    cbhc_previous_boundary: "هذا سجل الدورة السابقة. لا شيء منه بندٌ في جدول الأعمال القادم، ولا يُقال هنا إن المجلس سيطرحه من جديد.",
    cbhc_previous_link: "اقرأ كل طلبات هذا المجلس للسنة المالية {previous}",
    cbhc_example_heading: "طلب واحد، مقروء من أوله إلى آخره",
    cbhc_example_lede: "هكذا يبدو الاستعداد انطلاقًا من السجل: شرح المجلس نفسه لطلب واحد، والرد الذي نشرته الجهة، والسؤال الذي تدعمه هذه الأدلة فعلًا.",
    cbhc_example_statement: "ما كتبه المجلس عنه في بيان احتياجات المنطقة",
    cbhc_example_identity: "يرتبط هذا المقطع بهذا الطلب عبر المجلس والسنة المالية والجهة المسؤولة ونوع الميزانية وأولوية المجلس نفسه داخل تلك الجهة، لا عبر صياغته. فقد كتب هذا المجلس الشرح نفسه في طلبين مختلفين، ومن ثم فالصياغة وحدها لا تحدد شيئًا.",
    cbhc_example_question: "لذا فالسؤال الذي تدعمه هذه الأدلة يخص المسار الذي يسميه الرد، لا ما إذا كان العمل قد مُوِّل. الرد لا يقول ذلك.",
    cbhc_documents_heading: "الوثائق التي تقوم عليها هذه القراءة",
    cbhc_document_read: "قرأ هذا الموقع النص المنشور لهذه الوثيقة.",
    cbhc_document_unread: "نُشرت هذه الوثيقة كصورة ممسوحة ضوئيًا. لم يعطِ نصها سوى {count} حرفًا صالحًا، فلم يقرأها هذا الموقع ولا ينقل شيئًا من داخلها.",
    cbhc_document_unread_zero: "نُشرت هذه الوثيقة كصورة ممسوحة ضوئيًا. لم يعطِ نصها أي حرف صالح، فلم يقرأها هذا الموقع ولا ينقل شيئًا من داخلها.",
    cbhc_document_not_attempted: "لم يقرأ هذا الموقع نص هذه الوثيقة.",
    cbhc_open_document: "افتح الوثيقة المنشورة",
    cbhc_vote_heading: "تصويت يسجله المحضر المصدَّق",
    cbhc_vote: "في اجتماعه بتاريخ {date} صوّت المجلس {tally} {action}.",
    cbhc_vote_boundary: "هذا يسجل التصويت وأن الرسالة أُرسلت. وهو ليس سجلًا لما تقوله الرسالة: الرسالة هي الوثيقة الممسوحة أعلاه، ولم يقرأها هذا الموقع.",
    cbhc_disagreement_heading: "حيث لا يطبع الناشران الرد نفسه",
    cbhc_disagreement_lede: "قورن {compared} ردًا بين نشرة بيانات المدينة وطباعة المجلس نفسه للنشرة ذاتها. {count} منها تُقرأ على نحو مختلف.",
    cbhc_disagreement_lede_one: "قورن {compared} ردًا بين نشرة بيانات المدينة وطباعة المجلس نفسه للنشرة ذاتها. واحد منها يُقرأ على نحو مختلف.",
    cbhc_disagreement_none: "قورن {compared} ردًا بين نشرة بيانات المدينة وطباعة المجلس نفسه للنشرة ذاتها. ولا واحد منها يُقرأ على نحو مختلف.",
    cbhc_disagreement_register: "كما تطبعه نشرة بيانات المدينة",
    cbhc_disagreement_document: "كما تطبعه وثيقة المجلس نفسه",
    cbhc_disagreement_boundary: "يُحتفظ بكليهما كما نُشرا. إظهار أحدهما وحده يعني أن يقرر هذا الموقع أي ناشر يُصدَّق.",
    cbhc_source: "المصدر: {publisher}. قُرئ في {date}.",
    cbhc_unavailable: "تعذّر تحميل سياق الاستعداد لجلسة هذا المجلس، فلا يُعرض هنا شيء. الإخفاق في قراءة السجل المحفوظ؛ والمجلس يعقد جلسته على أي حال. أعد تحميل هذه الصفحة للمحاولة مجددًا، أو اقرأ صفحة المجلس نفسه عن الاجتماع.",
  },
  ur: {
    cbhc_heading: "اس بورڈ کی بجٹ سماعت میں بولنے کی تیاری",
    cbhc_lede: "بورڈ نے {date} کے لیے ایجنڈا شائع کیا ہے۔ اُس شام کا ایک حصہ بجٹ سماعت ہے، اور یہ مالی سال {year} سے متعلق ہے۔",
    cbhc_lede_no_budget: "بورڈ نے {date} کے لیے ایجنڈا شائع کیا ہے۔",
    cbhc_agenda_heading: "بورڈ نے اُس شام کے لیے کیا شائع کیا",
    cbhc_kind_budget: "بجٹ سماعت، مالی سال {year}",
    cbhc_kind_hearing: "عوامی سماعت",
    cbhc_kind_meeting: "باقاعدہ اجلاس",
    cbhc_kind_other: "ایجنڈے کی شق",
    cbhc_classes: "کیپیٹل اور اخراجات کے بجٹ۔",
    cbhc_open_meeting: "اس اجلاس کا ریکارڈ کھولیں",
    cbhc_open_publisher: "اس اجلاس کے بارے میں بورڈ کا اپنا صفحہ پڑھیں",
    cbhc_participation_heading: "بورڈ کے مطابق شرکت کیسے کی جاتی ہے",
    cbhc_participation_quoted: "اس اجلاس کے بارے میں بورڈ کے صفحے سے نقل کردہ۔",
    cbhc_register_link: "بولنے کے لیے رجسٹریشن کا بورڈ کا فارم کھولیں",
    cbhc_register_boundary: "یہ سائٹ نہ کوئی رجسٹریشن لیتی ہے نہ کوئی گواہی۔ اس صفحے کو پڑھنا، اس پر کوئی ریکارڈ کھولنا اور دوبارہ بند کرنا کسی کو کچھ نہیں بھیجتا۔ یہاں صرف بورڈ کا اپنا فارم ہی بورڈ تک پہنچتا ہے۔",
    cbhc_watch_link: "یہ اجلاس دیکھیں",
    cbhc_previous_heading: "پچھلے دور میں اس ضلع نے کیا مانگا، اور کیا جواب آیا",
    cbhc_previous_lede: "شہر کے رجسٹر میں مالی سال {previous} کے لیے اس بورڈ کی {count} درخواستیں ہیں، ہر ایک کے ساتھ شائع شدہ جواب۔ اوپر والی سماعت مالی سال {upcoming} سے متعلق ہے۔",
    cbhc_previous_lede_no_year: "شہر کے رجسٹر میں مالی سال {previous} کے لیے اس بورڈ کی {count} درخواستیں ہیں، ہر ایک کے ساتھ شائع شدہ جواب۔",
    cbhc_previous_boundary: "یہ پچھلے دور کا ریکارڈ ہے۔ اس میں سے کوئی چیز آنے والے ایجنڈے کی شق نہیں، اور یہاں یہ نہیں کہا گیا کہ بورڈ اسے دوبارہ اٹھائے گا۔",
    cbhc_previous_link: "مالی سال {previous} کے لیے اس بورڈ کی تمام درخواستیں پڑھیں",
    cbhc_example_heading: "ایک درخواست، شروع سے آخر تک پڑھی گئی",
    cbhc_example_lede: "ریکارڈ سے تیاری کرنا ایسا لگتا ہے: ایک درخواست پر بورڈ کی اپنی وضاحت، ادارے کا شائع کردہ جواب، اور وہ سوال جسے یہ شہادت واقعی سہارا دیتی ہے۔",
    cbhc_example_statement: "بورڈ نے اپنے ضروریات نامے میں اس بارے میں کیا لکھا",
    cbhc_example_identity: "یہ اقتباس اس درخواست سے بورڈ، مالی سال، ذمہ دار ادارے، بجٹ کی قسم اور اُس ادارے کے اندر بورڈ کی اپنی ترجیح کے ذریعے جوڑا گیا ہے، الفاظ کے ذریعے نہیں۔ اس بورڈ نے ایک ہی وضاحت دو مختلف درخواستوں میں لکھی، اس لیے صرف الفاظ سے کچھ متعین نہیں ہوتا۔",
    cbhc_example_question: "چنانچہ یہ شہادت جس سوال کو سہارا دیتی ہے وہ اُس راستے کے بارے میں ہے جو جواب میں بتایا گیا، اس بارے میں نہیں کہ کام کے لیے رقم دی گئی یا نہیں۔ جواب ایسا نہیں کہتا۔",
    cbhc_documents_heading: "وہ دستاویزات جن پر یہ مطالعہ کھڑا ہے",
    cbhc_document_read: "اس سائٹ نے اس دستاویز کا شائع شدہ متن پڑھا۔",
    cbhc_document_unread: "یہ دستاویز اسکین کے طور پر شائع ہوئی ہے۔ اس کے متن سے صرف {count} قابلِ استعمال حروف ملے، اس لیے اس سائٹ نے اسے نہیں پڑھا اور اس کے اندر سے کچھ بیان نہیں کرتی۔",
    cbhc_document_unread_zero: "یہ دستاویز اسکین کے طور پر شائع ہوئی ہے۔ اس کے متن سے کوئی قابلِ استعمال حرف نہیں ملا، اس لیے اس سائٹ نے اسے نہیں پڑھا اور اس کے اندر سے کچھ بیان نہیں کرتی۔",
    cbhc_document_not_attempted: "اس سائٹ نے اس دستاویز کا متن نہیں پڑھا۔",
    cbhc_open_document: "شائع شدہ دستاویز کھولیں",
    cbhc_vote_heading: "توثیق شدہ کارروائی میں درج ایک ووٹ",
    cbhc_vote: "{date} کے اجلاس میں بورڈ نے {tally} سے {action} ووٹ دیا۔",
    cbhc_vote_boundary: "یہ ووٹ کو اور خط بھیجے جانے کو درج کرتا ہے۔ یہ اس کا ریکارڈ نہیں کہ خط میں کیا لکھا ہے: خط اوپر والی اسکین شدہ دستاویز ہے، جسے اس سائٹ نے نہیں پڑھا۔",
    cbhc_disagreement_heading: "جہاں دونوں ناشر ایک ہی جواب نہیں چھاپتے",
    cbhc_disagreement_lede: "شہر کی ڈیٹا اشاعت اور اسی اشاعت کی بورڈ کی اپنی طباعت کے درمیان {compared} جوابوں کا موازنہ کیا گیا۔ ان میں سے {count} مختلف پڑھے جاتے ہیں۔",
    cbhc_disagreement_lede_one: "شہر کی ڈیٹا اشاعت اور اسی اشاعت کی بورڈ کی اپنی طباعت کے درمیان {compared} جوابوں کا موازنہ کیا گیا۔ ان میں سے ایک مختلف پڑھا جاتا ہے۔",
    cbhc_disagreement_none: "شہر کی ڈیٹا اشاعت اور اسی اشاعت کی بورڈ کی اپنی طباعت کے درمیان {compared} جوابوں کا موازنہ کیا گیا۔ ان میں سے کوئی مختلف نہیں پڑھا جاتا۔",
    cbhc_disagreement_register: "جیسا شہر کی ڈیٹا اشاعت اسے چھاپتی ہے",
    cbhc_disagreement_document: "جیسا بورڈ کی اپنی دستاویز اسے چھاپتی ہے",
    cbhc_disagreement_boundary: "دونوں اُسی طرح محفوظ ہیں جیسے شائع ہوئے۔ صرف ایک دکھانے کا مطلب ہوتا کہ یہ سائٹ فیصلہ کرے کہ کس ناشر پر یقین کیا جائے۔",
    cbhc_source: "ماخذ: {publisher}۔ {date} کو پڑھا گیا۔",
    cbhc_unavailable: "اس بورڈ کی سماعت کی تیاری کا سیاق لوڈ نہ ہو سکا، اس لیے یہاں کچھ نہیں دکھایا جا رہا۔ ناکامی محفوظ ریکارڈ پڑھنے میں ہوئی؛ بورڈ اپنی سماعت بہرحال کرتا ہے۔ دوبارہ کوشش کے لیے یہ صفحہ دوبارہ لوڈ کریں، یا اجلاس کے بارے میں بورڈ کا اپنا صفحہ پڑھیں۔",
  },
  pl: {
    cbhc_heading: "Przygotowanie do zabrania głosu na budżetowym wysłuchaniu tej rady",
    cbhc_lede: "Rada ogłosiła porządek obrad na {date}. Jedną z części tego wieczoru jest wysłuchanie budżetowe i dotyczy ono roku budżetowego {year}.",
    cbhc_lede_no_budget: "Rada ogłosiła porządek obrad na {date}.",
    cbhc_agenda_heading: "Co rada ogłosiła na ten wieczór",
    cbhc_kind_budget: "Wysłuchanie budżetowe, rok budżetowy {year}",
    cbhc_kind_hearing: "Wysłuchanie publiczne",
    cbhc_kind_meeting: "Posiedzenie zwyczajne",
    cbhc_kind_other: "Punkt porządku obrad",
    cbhc_classes: "Budżet inwestycyjny i budżet wydatków.",
    cbhc_open_meeting: "Otwórz zapis tego posiedzenia",
    cbhc_open_publisher: "Przeczytaj własną stronę rady o tym posiedzeniu",
    cbhc_participation_heading: "Jak według rady można wziąć udział",
    cbhc_participation_quoted: "Cytat ze strony rady o tym posiedzeniu.",
    cbhc_register_link: "Otwórz formularz rady, aby zapisać się na wystąpienie",
    cbhc_register_boundary: "Ta witryna nie przyjmuje żadnych zapisów ani zeznań. Czytanie tej strony, otwarcie na niej zapisu i zamknięcie go nie wysyła nikomu niczego. Jedyną rzeczą, która dociera tu do rady, jest jej własny formularz.",
    cbhc_watch_link: "Obejrzyj to posiedzenie",
    cbhc_previous_heading: "O co ta dzielnica prosiła w poprzednim cyklu i co odpowiedziano",
    cbhc_previous_lede: "Rejestr miejski zawiera {count} wniosków złożonych przez tę radę na rok budżetowy {previous}, każdy z opublikowaną odpowiedzią. Wysłuchanie powyżej dotyczy roku budżetowego {upcoming}.",
    cbhc_previous_lede_no_year: "Rejestr miejski zawiera {count} wniosków złożonych przez tę radę na rok budżetowy {previous}, każdy z opublikowaną odpowiedzią.",
    cbhc_previous_boundary: "To zapis poprzedniego cyklu. Nic z niego nie jest punktem nadchodzącego porządku obrad i nic tutaj nie mówi, że rada podniesie to ponownie.",
    cbhc_previous_link: "Przeczytaj wszystkie wnioski tej rady na rok budżetowy {previous}",
    cbhc_example_heading: "Jeden wniosek, przeczytany od początku do końca",
    cbhc_example_lede: "Tak wygląda przygotowanie oparte na zapisie: własne wyjaśnienie rady do jednego wniosku, odpowiedź opublikowana przez urząd i pytanie, które te dowody rzeczywiście uzasadniają.",
    cbhc_example_statement: "Co rada napisała o tym w swoim zestawieniu potrzeb",
    cbhc_example_identity: "Ten fragment wiąże się z tym wnioskiem przez radę, rok budżetowy, odpowiedzialny urząd, rodzaj budżetu i własny priorytet rady w obrębie tego urzędu, a nie przez brzmienie. Ta rada wpisała jedno wyjaśnienie do dwóch różnych wniosków, więc samo brzmienie niczego nie identyfikuje.",
    cbhc_example_question: "Dlatego pytanie, które te dowody uzasadniają, dotyczy drogi wskazanej w odpowiedzi, a nie tego, czy prace sfinansowano. Odpowiedź tego nie mówi.",
    cbhc_documents_heading: "Dokumenty, na których opiera się ten odczyt",
    cbhc_document_read: "Ta witryna przeczytała opublikowany tekst tego dokumentu.",
    cbhc_document_unread: "Ten dokument opublikowano jako skan. Jego tekst dał {count} użytecznych znaków, więc ta witryna go nie przeczytała i niczego z jego wnętrza nie relacjonuje.",
    cbhc_document_unread_zero: "Ten dokument opublikowano jako skan. Jego tekst nie dał żadnego użytecznego znaku, więc ta witryna go nie przeczytała i niczego z jego wnętrza nie relacjonuje.",
    cbhc_document_not_attempted: "Ta witryna nie czytała tekstu tego dokumentu.",
    cbhc_open_document: "Otwórz opublikowany dokument",
    cbhc_vote_heading: "Głosowanie odnotowane w zatwierdzonym protokole",
    cbhc_vote: "Na posiedzeniu {date} rada zagłosowała {tally} {action}.",
    cbhc_vote_boundary: "To odnotowuje głosowanie i to, że pismo wysłano. Nie jest to zapis treści pisma: pismem jest zeskanowany dokument powyżej, którego ta witryna nie przeczytała.",
    cbhc_disagreement_heading: "Tam, gdzie obaj wydawcy nie drukują tej samej odpowiedzi",
    cbhc_disagreement_lede: "Porównano {compared} odpowiedzi między miejską publikacją danych a własnym wydrukiem tej samej publikacji przez radę. {count} z nich brzmi inaczej.",
    cbhc_disagreement_lede_one: "Porównano {compared} odpowiedzi między miejską publikacją danych a własnym wydrukiem tej samej publikacji przez radę. Jedna z nich brzmi inaczej.",
    cbhc_disagreement_none: "Porównano {compared} odpowiedzi między miejską publikacją danych a własnym wydrukiem tej samej publikacji przez radę. Żadna z nich nie brzmi inaczej.",
    cbhc_disagreement_register: "Tak, jak drukuje to miejska publikacja danych",
    cbhc_disagreement_document: "Tak, jak drukuje to własny dokument rady",
    cbhc_disagreement_boundary: "Oba zachowano w postaci opublikowanej. Pokazanie jednego oznaczałoby, że ta witryna rozstrzyga, któremu wydawcy wierzyć.",
    cbhc_source: "Źródło: {publisher}. Odczytano {date}.",
    cbhc_unavailable: "Kontekstu przygotowania do wysłuchania tej rady nie udało się wczytać, więc nic tu nie jest pokazane. Niepowodzenie dotyczy odczytu zachowanego zapisu; rada i tak przeprowadza swoje wysłuchanie. Przeładuj tę stronę, aby spróbować ponownie, albo przeczytaj własną stronę rady o tym posiedzeniu.",
  },
};

function hearingContextLangAttrs(lang) {
  return lang === "en" ? {} : { lang, dir: HEARING_CONTEXT_RTL_LANGS.has(lang) ? "rtl" : "ltr" };
}

function hearingContextSegmentLabel(segment, t) {
  if (segment.budget) return t("cbhc_kind_budget", { year: String(segment.fiscal_year) });
  if (segment.kind === "public_hearing") return t("cbhc_kind_hearing");
  if (segment.kind === "regular_meeting") return t("cbhc_kind_meeting");
  return t("cbhc_kind_other");
}

function hearingContextAgendaMarkup(view, t, lang) {
  const rows = view.hearing.segments.map((segment) => {
    const time = hearingContextFormatTime(segment.start_time, lang) || segment.start_time;
    const classes = segment.budget && segment.budget_classes.length === 2
      ? `<span class="muted node-muted board-hearing-segment-classes">${hearingContextEsc(t("cbhc_classes"))}</span>`
      : "";
    const detail = segment.detail
      .map((value) => `<p class="board-hearing-segment-detail">${hearingContextSourceText(value)}</p>`)
      .join("");
    return `<li class="node-record board-hearing-segment"${segment.budget ? ' data-hearing-budget-segment="1"' : ""}`
      + ` data-hearing-segment-kind="${hearingContextEsc(segment.kind)}"`
      + ` data-hearing-segment-start="${hearingContextEsc(segment.start_time)}"`
      + (segment.fiscal_year === null ? "" : ` data-hearing-segment-fiscal-year="${hearingContextEsc(String(segment.fiscal_year))}"`)
      + `>`
      + `<div class="node-record-main">`
      + `<strong class="board-hearing-segment-time">${hearingContextEsc(time)}</strong> `
      + `<span class="board-hearing-segment-label">${hearingContextEsc(hearingContextSegmentLabel(segment, t))}</span>`
      + `</div>`
      + `<p class="board-hearing-segment-title">${hearingContextSourceText(segment.title)}</p>`
      + classes
      + detail
      + `</li>`;
  }).join("");

  const links = [];
  if (view.hearing.href) {
    links.push(`<a class="ui-constellation-link board-hearing-meeting-link" href="${hearingContextEsc(view.hearing.href)}">${hearingContextEsc(t("cbhc_open_meeting"))}</a>`);
  }
  if (view.hearing.source_url) {
    links.push(`<a class="ui-constellation-link board-hearing-publisher-link" href="${hearingContextEsc(view.hearing.source_url)}">${hearingContextEsc(t("cbhc_open_publisher"))}</a>`);
  }
  return `<h3 class="board-hearing-agenda-heading">${hearingContextEsc(t("cbhc_agenda_heading"))}</h3>`
    + `<ol class="node-record-list board-hearing-segments">${rows}</ol>`
    + (links.length ? `<p class="board-hearing-agenda-links">${links.join(" · ")}</p>` : "");
}

function hearingContextParticipationMarkup(view, t) {
  const participation = view.hearing.participation;
  const passages = participation.passages
    .map((value) => `<p class="board-hearing-participation-passage">${hearingContextSourceText(value)}</p>`)
    .join("");
  const register = participation.speaking_registration_url
    ? `<p class="board-hearing-participation-action"><a class="ui-constellation-link board-hearing-register-link"`
      + ` href="${hearingContextEsc(participation.speaking_registration_url)}" rel="noopener">`
      + `${hearingContextEsc(t("cbhc_register_link"))}</a></p>`
    : "";
  const watch = participation.watch_urls
    .map((url) => `<a class="ui-constellation-link board-hearing-watch-link" href="${hearingContextEsc(url)}" rel="noopener">${hearingContextEsc(t("cbhc_watch_link"))}</a>`)
    .join(" · ");
  if (!passages && !register && !watch) return "";
  return `<h3 class="board-hearing-participation-heading">${hearingContextEsc(t("cbhc_participation_heading"))}</h3>`
    + passages
    + (passages ? `<p class="muted node-muted board-hearing-participation-quoted">${hearingContextEsc(t("cbhc_participation_quoted"))}</p>` : "")
    + register
    + (watch ? `<p class="board-hearing-participation-watch">${watch}</p>` : "")
    + `<p class="muted node-muted board-hearing-participation-boundary">${hearingContextEsc(t("cbhc_register_boundary"))}</p>`;
}

function hearingContextPreviousMarkup(view, t, lang) {
  const previous = view.previous_cycle;
  if (!previous.request_count || previous.fiscal_year === null) return "";
  const upcoming = view.hearing.budget_segment?.fiscal_year ?? null;
  const count = hearingContextFormatCount(previous.request_count, lang);
  const lede = upcoming === null
    ? t("cbhc_previous_lede_no_year", { count, previous: String(previous.fiscal_year) })
    : t("cbhc_previous_lede", { count, previous: String(previous.fiscal_year), upcoming: String(upcoming) });
  return `<h3 class="board-hearing-previous-heading">${hearingContextEsc(t("cbhc_previous_heading"))}</h3>`
    + `<p class="node-lede board-hearing-previous-lede"`
    + ` data-previous-fiscal-year="${hearingContextEsc(String(previous.fiscal_year))}"`
    + (upcoming === null ? "" : ` data-upcoming-fiscal-year="${hearingContextEsc(String(upcoming))}"`)
    + `>${hearingContextEsc(lede)}</p>`
    + `<p class="muted node-muted board-hearing-previous-boundary">${hearingContextEsc(t("cbhc_previous_boundary"))}</p>`
    + `<p class="board-hearing-previous-link"><a class="ui-constellation-link" href="#${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}">`
    + `${hearingContextEsc(t("cbhc_previous_link", { previous: String(previous.fiscal_year) }))}</a></p>`;
}

/**
 * The worked example: one request read from the board's own words through to
 * the question the published answer actually supports.
 *
 * The request row is the register reading's own row markup, so the record
 * taught here is the same object the list below shows, with the same inspect
 * control and the same ordinary link out. It is rendered only when both halves
 * are present: a passage with no request, or a request with no passage, would
 * be a lesson with a step missing.
 */
function hearingContextExampleMarkup(view, t, lang) {
  const previous = view.previous_cycle;
  const passage = previous.worked_example;
  const request = previous.worked_example_request;
  if (!passage || !request) return "";
  return `<h3 class="board-hearing-example-heading">${hearingContextEsc(t("cbhc_example_heading"))}</h3>`
    + `<p class="node-lede board-hearing-example-lede">${hearingContextEsc(t("cbhc_example_lede"))}</p>`
    + `<ul class="node-record-list board-budget-request-list board-hearing-example-list">`
    + renderBudgetRequestRecord(request, { lang, reciprocalHref: request.agency?.href || null })
    + `</ul>`
    + `<p class="muted node-muted board-hearing-example-statement-heading">${hearingContextEsc(t("cbhc_example_statement"))}</p>`
    + `<blockquote class="board-hearing-example-statement" data-statement-tracking-code="${hearingContextEsc(passage.tracking_code)}">`
    + `<p>${hearingContextSourceText(passage.passage)}</p></blockquote>`
    + `<p class="muted node-muted board-hearing-example-identity"`
    + ` data-identity-keys="${hearingContextEsc(passage.identity_keys.join(" "))}">`
    + `${hearingContextEsc(t("cbhc_example_identity"))}</p>`
    + `<p class="board-hearing-example-question">${hearingContextEsc(t("cbhc_example_question"))}</p>`;
}

function hearingContextDocumentState(document, t, lang) {
  if (document.extraction_state === "extracted") return t("cbhc_document_read");
  if (document.extraction_state === "not_attempted") return t("cbhc_document_not_attempted");
  return document.extracted_characters === 0
    ? t("cbhc_document_unread_zero")
    : t("cbhc_document_unread", { count: hearingContextFormatCount(document.extracted_characters, lang) });
}

function hearingContextDocumentsMarkup(view, t, lang) {
  const documents = view.previous_cycle.documents;
  if (!documents.length) return "";
  const rows = documents.map((document) => (
    `<li class="node-record board-hearing-document" data-document-id="${hearingContextEsc(document.id)}"`
    + ` data-extraction-state="${hearingContextEsc(document.extraction_state)}"`
    + ` data-extracted-characters="${hearingContextEsc(String(document.extracted_characters))}">`
    + `<div class="node-record-main"><strong class="board-hearing-document-title">${hearingContextSourceText(document.title)}</strong></div>`
    + `<p class="muted node-muted board-hearing-document-state">${hearingContextEsc(hearingContextDocumentState(document, t, lang))}</p>`
    + `<p class="board-hearing-document-link"><a class="ui-constellation-link" href="${hearingContextEsc(document.source_url)}" rel="noopener">`
    + `${hearingContextEsc(t("cbhc_open_document"))}</a></p>`
    + `</li>`
  )).join("");

  const resolution = view.previous_cycle.ratified_resolution;
  const vote = resolution?.tally_text && resolution.action && resolution.meeting_date
    ? `<h3 class="board-hearing-vote-heading">${hearingContextEsc(t("cbhc_vote_heading"))}</h3>`
      + `<p class="board-hearing-vote" data-vote-tally="${hearingContextEsc(resolution.tally_text)}">`
      + hearingContextEsc(t("cbhc_vote", {
        date: hearingContextFormatDay(resolution.meeting_date, lang) || resolution.meeting_date,
        tally: resolution.tally_text,
        action: HEARING_CONTEXT_SENTINEL,
      })).replace(HEARING_CONTEXT_SENTINEL, hearingContextSourceText(resolution.action))
      + `</p>`
      + `<p class="muted node-muted board-hearing-vote-boundary">${hearingContextEsc(t("cbhc_vote_boundary"))}</p>`
    : "";

  return `<h3 class="board-hearing-documents-heading">${hearingContextEsc(t("cbhc_documents_heading"))}</h3>`
    + `<ul class="node-record-list board-hearing-documents">${rows}</ul>`
    + vote;
}

function hearingContextDisagreementMarkup(view, t, lang) {
  const previous = view.previous_cycle;
  if (!previous.responses_compared) return "";
  const compared = hearingContextFormatCount(previous.responses_compared, lang);
  const count = previous.disagreements.length;
  const lede = count === 0
    ? t("cbhc_disagreement_none", { compared })
    : (count === 1
      ? t("cbhc_disagreement_lede_one", { compared })
      : t("cbhc_disagreement_lede", { compared, count: hearingContextFormatCount(count, lang) }));
  const rows = previous.disagreements.map((row) => (
    `<li class="node-record board-hearing-disagreement" data-tracking-code="${hearingContextEsc(row.tracking_code)}">`
    + `<div class="node-record-main"><span class="board-hearing-disagreement-code" lang="en" dir="ltr">${hearingContextEsc(row.tracking_code)}</span></div>`
    + `<p class="muted node-muted board-hearing-disagreement-register-label">${hearingContextEsc(t("cbhc_disagreement_register"))}</p>`
    + `<p class="board-hearing-disagreement-register">${hearingContextSourceText(row.register_response)}</p>`
    + `<p class="muted node-muted board-hearing-disagreement-document-label">${hearingContextEsc(t("cbhc_disagreement_document"))}</p>`
    + `<p class="board-hearing-disagreement-document">${hearingContextSourceText(row.board_document_response)}</p>`
    + (row.board_document_url
      ? `<p class="board-hearing-disagreement-link"><a class="ui-constellation-link" href="${hearingContextEsc(row.board_document_url)}" rel="noopener">${hearingContextEsc(t("cbhc_open_document"))}</a></p>`
      : "")
    + `</li>`
  )).join("");
  return `<h3 class="board-hearing-disagreement-heading">${hearingContextEsc(t("cbhc_disagreement_heading"))}</h3>`
    + `<p class="board-hearing-disagreement-lede" data-disagreement-count="${hearingContextEsc(String(count))}">${hearingContextEsc(lede)}</p>`
    + (rows ? `<ul class="node-record-list board-hearing-disagreements">${rows}</ul>` : "")
    + (rows ? `<p class="muted node-muted board-hearing-disagreement-boundary">${hearingContextEsc(t("cbhc_disagreement_boundary"))}</p>` : "");
}

function hearingContextSourceMarkup(view, t, lang) {
  if (!view.publisher) return "";
  const read = hearingContextFormatDay(view.observed_at, lang);
  const sentence = hearingContextSentence(t, "cbhc_source", "publisher", view.publisher)
    .replace("{date}", hearingContextEsc(read || ""));
  return `<p class="muted node-muted board-hearing-source-line">${sentence}</p>`;
}

/**
 * The section markup, or "" when there is no reading to render.
 *
 * Every destination is a plain anchor, so a modified click, a middle click and
 * the browser's own history behave the way they do anywhere else. Nothing here
 * needs scripting: the whole reading is written into the document, and the one
 * inspect control is revealed only once its behaviour is listening.
 */
export function renderCommunityBoardHearingContextSection(view, options = {}) {
  if (!view || view.schema !== COMMUNITY_BOARD_HEARING_CONTEXT_VIEW_SCHEMA) return "";
  const lang = HEARING_CONTEXT_STRINGS[options.lang] ? options.lang : "en";
  const t = hearingContextT(lang);
  const headingId = `${COMMUNITY_BOARD_HEARING_CONTEXT_ANCHOR}-heading`;
  const common = {
    heading: t("cbhc_heading"),
    headingId,
    exportClass: "object_hearing_preparation",
    extraClass: "node-card civic-object-section board-hearing-preparation",
  };
  const attrs = (extra = {}) => ({
    id: COMMUNITY_BOARD_HEARING_CONTEXT_ANCHOR,
    "data-community-board-hearing-context": "1",
    "data-hearing-context-state": view.state,
    ...extra,
    ...hearingContextLangAttrs(lang),
  });

  if (view.state !== HEARING_CONTEXT_STATES.AVAILABLE) {
    return renderNodeSection({
      ...common,
      attrs: attrs(),
      body: `<p class="node-lede">${hearingContextEsc(t("cbhc_unavailable"))}</p>`
        + hearingContextSourceMarkup(view, t, lang),
    });
  }

  const budgetSegment = view.hearing.budget_segment;
  const day = hearingContextFormatDay(view.hearing.meeting_date, lang) || view.hearing.meeting_date;
  const lede = budgetSegment
    ? t("cbhc_lede", { date: day, year: String(budgetSegment.fiscal_year) })
    : t("cbhc_lede_no_budget", { date: day });

  return renderNodeSection({
    ...common,
    attrs: attrs({
      "data-hearing-date": view.hearing.meeting_date || "",
      "data-hearing-fiscal-year": budgetSegment ? String(budgetSegment.fiscal_year) : "",
      [BUDGET_REQUEST_LABELS_ATTRIBUTE]: budgetRequestInspectLabels(lang),
    }),
    body: `<p class="node-lede board-hearing-lede">${hearingContextEsc(lede)}</p>`
      + hearingContextAgendaMarkup(view, t, lang)
      + hearingContextParticipationMarkup(view, t)
      + hearingContextPreviousMarkup(view, t, lang)
      + hearingContextExampleMarkup(view, t, lang)
      + hearingContextDocumentsMarkup(view, t, lang)
      + hearingContextDisagreementMarkup(view, t, lang)
      + hearingContextSourceMarkup(view, t, lang),
  });
}

export { HEARING_CONTEXT_STRINGS };
