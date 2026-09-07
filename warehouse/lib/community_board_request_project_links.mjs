/**
 * Reviewed links from a community board budget request to a capital project
 * the city already publishes a record for.
 *
 * A board asks an agency for something and the agency answers in writing. Some
 * of those answers name a capital project by its published project code: "the
 * agency in partnership with DDC will be reconstructing the SBS BX 6 route
 * under capital project HWX100SBC". CityScroll retains both sides of that
 * sentence — the register of requests and answers, and the city's own capital
 * observations — and until now they were two unconnected bodies of records.
 *
 * Joining them naively is worse than not joining them. Three failures are
 * specific and each has a real example in the retained data:
 *
 *   - an ordinary English or place word is also somebody's published project
 *     code. "Bathgate" is a Bronx playground in one board's request and the
 *     code of an unrelated Economic Development Corporation campus project;
 *     "LaGuardia" is an airport in one board's request and the code of a City
 *     University streetscape project. Matching on the word alone links a
 *     playground to a campus and an airport to a college.
 *   - a facility name that reads alike is not an identity. A library branch
 *     expansion request and an HVAC replacement at the same branch are
 *     different scopes with different funding, and a bridge over a subway line
 *     is not the plaza beside it.
 *   - a longer published code that begins with a shorter one is a different
 *     project. Matching on substrings turns HWX100SBCS into HWX100SBC.
 *
 * So this projection does two separate things and never lets the first stand in
 * for the second. It extracts *candidates* mechanically — a whole token,
 * carrying at least one digit, at least the minimum length, equal to a code the
 * city publishes for a capital project — and it emits a *relation* only where a
 * reviewed decision in this file records that the source passage, the agency
 * and the scope were read and survived. A digit-carrying identifier that no
 * reviewer has looked at stays a candidate: it is retained in the artifact so
 * the queue is visible, and no reader is shown it.
 *
 * What a relation is not
 * ----------------------
 * It is not fulfilment. A request naming a project, or an answer naming one,
 * says the two records mention each other; it never says the request is funded,
 * that its scope is inside the project's, or that anything was delivered. Where
 * the answer itself says the opposite — the Queens segment of one street
 * reconstruction was removed from the project and resurfaced in house — that
 * statement is retained with the relation and rendered with it, because a link
 * without it would read as the project answering the request.
 *
 * It is not a shared clock either. The request carries the publication date of
 * the answer that names the project; the project carries the reporting period
 * and the record dates of the city's own capital observation. Those are
 * different dates about different things, and both are kept.
 */

export const REQUEST_PROJECT_LINKS_SCHEMA = "cityscroll.community_board_request_project_links.v1";

/** The one relation this projection materializes. */
export const REQUEST_PROJECT_RELATION = "budget_request_names_capital_project_code";

export const REQUEST_PROJECT_METHOD = "exact_published_project_code";

/**
 * The shortest token that can be a candidate.
 *
 * Short codes collide with ordinary text: a four-character token carrying a
 * digit is as likely to be a street number or a phase label as a project code.
 * The capital-project relation already materialized for procurement notices
 * uses the same floor, and this one keeps it so the two readings cannot admit
 * different things from the same sentence.
 */
export const REQUEST_PROJECT_MINIMUM_CODE_LENGTH = 6;

/** Which published text a candidate was found in. */
export const REQUEST_PROJECT_FIELDS = Object.freeze(["response", "board_submission"]);

const REQUEST_PROJECT_TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*/g;
/**
 * The one spelling difference this projection will look through.
 *
 * Boards and agencies both write a published code with a space before its
 * digits — "HWK 876" for HWK876 — often enough that refusing it would drop real
 * references while admitting nothing safer. Closing that single gap is a stated
 * rule rather than fuzzy matching: the joined token still has to equal a
 * published code whole, and the spelling as published in the passage is
 * retained beside the code so a reader sees both.
 */
const REQUEST_PROJECT_SPACED_CODE = /\b([A-Za-z]{2,})[  ]+(\d{2,})\b/g;
const REQUEST_PROJECT_SENTENCE = /[^.;\n]+[.;\n]?/g;
const REQUEST_PROJECT_PASSAGE_LIMIT = 1200;

function requestProjectText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Every published project code named as a whole token in one passage.
 *
 * Returns the matched code alongside the spelling the passage actually carries,
 * so a normalized reference is never presented as though the publisher wrote
 * the code that way.
 */
export function requestProjectCodesInPassage(passage, publishedCodes) {
  const text = String(passage ?? "");
  if (!text) return [];
  const found = new Map();
  const consider = (raw, spelling) => {
    const token = raw.toUpperCase().replace(/^[._-]+|[._-]+$/g, "");
    if (token.length < REQUEST_PROJECT_MINIMUM_CODE_LENGTH) return;
    // An identifier with no digit is an ordinary word until proven otherwise,
    // whichever list it also happens to appear on.
    if (!/\d/.test(token)) return;
    if (!publishedCodes.has(token)) return;
    if (!found.has(token)) found.set(token, spelling);
  };
  for (const match of text.matchAll(REQUEST_PROJECT_TOKEN)) consider(match[0], match[0]);
  for (const match of text.matchAll(REQUEST_PROJECT_SPACED_CODE)) {
    consider(`${match[1]}${match[2]}`, match[0]);
  }
  return [...found].map(([code, spelling]) => ({ code, published_spelling: spelling })).sort(
    (left, right) => left.code.localeCompare(right.code),
  );
}

/**
 * Candidates in one published field, each with the sentence that carries it.
 *
 * The sentence is quoted from the publisher's own text and never shortened: the
 * clause that changes what a reference means is as often the last one as the
 * first.
 */
export function requestProjectCandidatesInField(value, publishedCodes) {
  const text = String(value ?? "");
  if (!text.trim()) return [];
  const candidates = new Map();
  for (const match of text.match(REQUEST_PROJECT_SENTENCE) || []) {
    const sentence = requestProjectText(match);
    if (!sentence) continue;
    for (const hit of requestProjectCodesInPassage(sentence, publishedCodes)) {
      if (candidates.has(hit.code)) continue;
      candidates.set(hit.code, { ...hit, passage: sentence.slice(0, REQUEST_PROJECT_PASSAGE_LIMIT) });
    }
  }
  // A code the whole field carries but no single sentence does (the sentence
  // splitter met an abbreviation) is still a candidate, quoted from the field.
  for (const hit of requestProjectCodesInPassage(text, publishedCodes)) {
    if (candidates.has(hit.code)) continue;
    candidates.set(hit.code, { ...hit, passage: requestProjectText(text).slice(0, REQUEST_PROJECT_PASSAGE_LIMIT) });
  }
  return [...candidates.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * Every candidate one request carries, across the publications a reader is
 * served.
 *
 * A candidate is one published project code, whichever published field named
 * it. A code an answer and the board's own submission both name is one
 * candidate carrying both passages, not two: the request references one
 * project once.
 */
export function requestProjectCandidates(request, publishedCodes) {
  const versions = (Array.isArray(request?.versions) ? request.versions : [])
    .filter((version) => version?.servable === true);
  const byCode = new Map();
  for (const version of versions) {
    const fields = [
      ["response", version?.response],
      ["board_submission", version?.explanation],
    ];
    for (const [field, value] of fields) {
      for (const hit of requestProjectCandidatesInField(value, publishedCodes)) {
        const entry = byCode.get(hit.code) || { project_code: hit.code, named_in: [], passages: [] };
        if (!entry.named_in.includes(field)) entry.named_in.push(field);
        entry.passages.push({
          named_in: field,
          publication: String(version.publication),
          publication_date: String(version.publication_date),
          published_spelling: hit.published_spelling,
          passage: hit.passage,
        });
        byCode.set(hit.code, entry);
      }
    }
  }
  for (const entry of byCode.values()) {
    // Response first, because an answer naming a project is the agency's own
    // reference and the board's submission is the board's.
    entry.named_in.sort((left, right) => REQUEST_PROJECT_FIELDS.indexOf(left) - REQUEST_PROJECT_FIELDS.indexOf(right));
  }
  return [...byCode.values()].sort((left, right) => left.project_code.localeCompare(right.project_code));
}

/** The day these decisions were read against the retained publications. */
export const REQUEST_PROJECT_REVIEWED_ON = "2026-09-07";

/**
 * The reviewed relations.
 *
 * Every entry names a request by the publisher's full tracking code inside its
 * board, the capital project by its published code *and* its managing agency —
 * because one code can be published under two managing agencies and those are
 * two projects — and records what was actually read: the agency evidence, the
 * scope evidence, and where the passage and the project record do not say the
 * same thing, the difference in the reviewer's own words. That last field is
 * not decoration. It is the sentence that stops a link from reading as an
 * answer to the request.
 *
 * The materializer refuses to emit a relation whose code is not still a
 * candidate in the field this entry claims, so an entry cannot outlive the
 * passage it was written from.
 */
export const REQUEST_PROJECT_REVIEWED_LINKS = Object.freeze([
  {
    board_id: "bronx-cb-03",
    tracking_code: "103202717C",
    project_code: "HWX100SBC",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names Design and Construction as the agency doing the work in partnership with Transportation, and the retained project record is managed by Design and Construction and sponsored by Transportation.",
    scope_evidence: "The answer describes reconstruction of the SBS BX 6 route; the retained project is the South Bronx East-West Crosstown Select Bus Service project, whose published scope is bus pads, bus bulbs, curb and median extensions and pedestrian islands.",
    scope_difference: "The answer also states the agency does not understand the request as written and needs more information, so naming the project is not agreement with what the board asked for.",
    scope_difference_quote: "The agency does not understand the request as written and requires more clarification.",
  },
  {
    board_id: "bronx-cb-10",
    tracking_code: "110202705C",
    project_code: "SEX200400",
    managing_agency: "DDC",
    named_in: "board_submission",
    agency_evidence: "The board names the project as a Design and Construction project, and the retained project record is managed by Design and Construction and sponsored by Environmental Protection, the agency responsible for answering this request.",
    scope_evidence: "The board names storm flooding on Minnieford Avenue; the retained project is storm and sanitary sewers in the Minnieford Avenue area, recorded in this same district.",
    scope_difference: "The board names the project in order to ask that its limits be extended; the published answer does not name it and does not support the request, so the project record is not an answer to it.",
    scope_difference_quote: "PLEASE CONTACT THE AGENCY DIRECTLY AND PROMPTLY FOR MORE INFORMATION.",
  },
  {
    board_id: "brooklyn-cb-03",
    tracking_code: "203202719C",
    project_code: "HWTRK1",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer places the work at Design and Construction, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for roadway repair and restoration on a Brooklyn corridor; the retained project is trench restoration in the borough of Brooklyn including full street reconstruction.",
    scope_difference: "The answer describes the project as in design; the retained capital observation, taken on its own later date, records it in construction procurement. Both are kept with their own dates rather than reconciled.",
    scope_difference_quote: "Reconstruction of this block is funded and part of HWTRK1 which is currently in Design at DDC.",
  },
  {
    board_id: "brooklyn-cb-04",
    tracking_code: "204202703CS",
    project_code: "HWK876",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "Both the board and the answer name the project code, and the retained project record is managed by Design and Construction and sponsored by Environmental Protection and Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for a roadbed on the named project to be completed; the retained project is the reconstruction of Wyckoff Avenue from Flushing Avenue to Cooper Avenue, recorded in this district.",
    scope_difference: "The answer says construction is scheduled to start in 2026 and the start date is not yet set. The retained capital observation, on its own date, still records the project in design.",
    scope_difference_quote: "HWK876 is scheduled to start construction in 2026.",
  },
  {
    board_id: "brooklyn-cb-04",
    tracking_code: "204202704CS",
    project_code: "HWK876",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the project code, and the retained project record is managed by Design and Construction and sponsored by Environmental Protection and Transportation, the agency responsible for answering this request.",
    scope_evidence: "The answer states that Wyckoff Avenue from Flushing Avenue to Cooper Avenue is included in the named project, which is the retained project's own published extent.",
    scope_difference: "The answer says construction is scheduled to start in 2026 and the start date is not yet set. The retained capital observation, on its own date, still records the project in design.",
    scope_difference_quote: "Wyckoff Ave, Flushing to Cooper Ave is included in HWK876 which will be starting construction in 2026.",
  },
  {
    board_id: "brooklyn-cb-06",
    tracking_code: "206202703CS",
    project_code: "SEK20068",
    managing_agency: "DDC",
    named_in: "board_submission",
    agency_evidence: "The board names the project number in full; the retained project record is managed by Design and Construction and recorded in this district, and Environmental Protection, the agency responsible for answering, is the sewer authority the request addresses.",
    scope_evidence: "The board asks for design and repair of the 9th Street and Second Avenue corridors by the Gowanus Canal; the retained project is new storm and combined sewers and water main work in 9th Street.",
    scope_difference: "The published answer does not name the project and does not support the request. The most recent retained capital observation of this project is from an earlier release than the current one, so its figures are older than the rest of this reading.",
    scope_difference_quote: "PLEASE CONTACT THE AGENCY DIRECTLY AND PROMPTLY FOR MORE INFORMATION.",
  },
  {
    board_id: "brooklyn-cb-06",
    tracking_code: "206202704CS",
    project_code: "SEK20068",
    managing_agency: "DDC",
    named_in: "board_submission",
    agency_evidence: "The board names the project number in full; the retained project record is managed by Design and Construction and recorded in this district, and Environmental Protection, the agency responsible for answering, is the sewer authority the request addresses.",
    scope_evidence: "The board asks for design and repair of the 9th Street and Second Avenue corridors by the Gowanus Canal; the retained project is new storm and combined sewers and water main work in 9th Street.",
    scope_difference: "The published answer does not name the project and does not support the request. The most recent retained capital observation of this project is from an earlier release than the current one, so its figures are older than the rest of this reading.",
    scope_difference_quote: "PLEASE CONTACT THE AGENCY DIRECTLY AND PROMPTLY FOR MORE INFORMATION.",
  },
  {
    board_id: "brooklyn-cb-06",
    tracking_code: "206202705CS",
    project_code: "HWK700B",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the project code, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for traffic calming alongside the street reconstruction it names; the retained project is the reconstruction of Columbia Street, phase 2, recorded in this district, and the answer states the project will include curb extensions, pedestrian safety islands and bike infrastructure.",
    scope_difference: "The board asks for the reconstruction project's scope to be expanded. The answer lists what the project already includes; it does not say the board's additions were accepted.",
    scope_difference_quote: "The HWK700B capital project will include several safety measures in the form of curb extensions, pedestrian safety islands, and bike infrastructure.",
  },
  {
    board_id: "brooklyn-cb-06",
    tracking_code: "206202706CS",
    project_code: "HWK1669B",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the project code, and the reviewed record is the one managed by Design and Construction and sponsored by Transportation. The same code is also published under Transportation as a separate row, and that row is a different record, not this one.",
    scope_evidence: "The board asks for medians on 4th Avenue; the answer states the medians between Atlantic Avenue and 8th Street will be raised and upgraded as part of the named phase, and the retained project is the redesign of 4th Avenue from Atlantic Avenue to 64th Street.",
    scope_difference: "The board asks for medians between Pacific Street and 8th Street. The answer describes work between Atlantic Avenue and 8th Street, which is not the same extent.",
    scope_difference_quote: "The medians on 4th Avenue between Atlantic Avenue and 8th Street will be raised and upgraded as part of HWK1669B Phase B which is currently in design.",
  },
  {
    board_id: "brooklyn-cb-18",
    tracking_code: "218202701CS",
    project_code: "HWK614D",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the project code, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for reconstruction of Avenue K between Bergen and Ralph Avenues; the retained project is the reconstruction of the Bergen Avenue area including storm sewers, water mains, street lighting and traffic signal work, recorded in this district.",
    scope_difference: "The answer says this work will be completed as part of the named project. The retained capital observation, on its own later date, records the project in close-out, and neither statement is a record that this board's street was built.",
    scope_difference_quote: "This work will be completed as part of an already-funded capital project (HWK614D) that is currently under construction.",
  },
  {
    board_id: "brooklyn-cb-18",
    tracking_code: "218202702CS",
    project_code: "HWK614D",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the project code, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for reconstruction of Bergen Avenue between named cross streets; the retained project is the reconstruction of the Bergen Avenue area, recorded in this district.",
    scope_difference: "The answer to this request is that the agency does not support it but can address the need another way, and names the project as that other way. Naming the project is therefore explicitly not agreement with what the board asked for.",
    scope_difference_quote: "Agency does not support but can address the need alternatively",
  },
  {
    board_id: "manhattan-cb-02",
    tracking_code: "302202716C",
    project_code: "HWPR19MC1",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the code, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for pedestrian ramps at two Manhattan corners; the retained project is complex pedestrian ramp upgrades in Manhattan.",
    scope_difference: "The answer says the corner was added to a ramp database for future repairs under the named record and describes it as in preliminary design. The retained capital observation, on its own later date, records the project in construction, and neither says these two corners are in the work now under way.",
    scope_difference_quote: "this corner has been added to the pedestrian ramp database for future repairs under contract HWPR19MC1",
  },
  {
    board_id: "queens-cb-04",
    tracking_code: "404202702CS",
    project_code: "HWD10311",
    managing_agency: "DDC",
    named_in: "response",
    agency_evidence: "The answer names the code and the project's own name, and the retained project record is managed by Design and Construction and sponsored by Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks about the 111th Street center island malls; the retained project is 111th Street safety improvements in Queens, recorded across this district and its neighbour.",
    scope_difference: "The answer says the board's comments will be considered by a project already in design. It does not say the malls are in that project's scope.",
    scope_difference_quote: "A current capital project, HWD10311 111th Street Safety Improvements, is in design and these comments will be considered.",
  },
  {
    board_id: "queens-cb-05",
    tracking_code: "405202714C",
    project_code: "RWQ005",
    managing_agency: "DDC",
    named_in: "board_submission",
    agency_evidence: "The board names the project code in full, and the retained project record is managed by Design and Construction and recorded in this borough.",
    scope_evidence: "The board names the completed reconstruction of the Cooper Avenue underpass retaining walls; the retained project is the Cooper Avenue retaining wall, and the retained capital observation records it completed.",
    scope_difference: "The board names this project to say it did not solve the flooding, and asks for different work. The published answer refers the request to Environmental Protection. The project is prior work the board is arguing from, not an answer to the request.",
    scope_difference_quote: "This request has been addressed by NYC DEP.",
  },
  {
    board_id: "queens-cb-05",
    tracking_code: "405202716C",
    project_code: "HWK876",
    managing_agency: "DDC",
    named_in: "board_submission",
    agency_evidence: "The board names the project code, spelled with a space before its digits, and the retained project record is managed by Design and Construction and sponsored by Environmental Protection and Transportation, the agency responsible for answering this request.",
    scope_evidence: "The board asks for the reconstruction of Wyckoff Avenue from Flushing Avenue to Cooper Avenue, which is the retained project's own published extent across the Brooklyn and Queens border.",
    scope_difference: "The answer states that the capital project within Brooklyn is ongoing but the Queens segment was removed from it and improved by in-house resurfacing. The retained project record therefore does not describe work in this district, and it is recorded against the Brooklyn district on its own separately dated observation.",
    scope_difference_quote: "However, as noted the Queens segment was removed and improved via in-house resurfacing.",
  },
  {
    board_id: "staten-island-cb-02",
    tracking_code: "502202702CS",
    project_code: "MIBBNC05B",
    managing_agency: "DEP",
    named_in: "board_submission",
    agency_evidence: "The board names the project number in full, and the retained project record is managed by Environmental Protection, the agency responsible for answering this request.",
    scope_evidence: "The board asks for this project to be moved into the next fiscal year's budget; the retained project is new storm and replacement sanitary sewers and distribution water main on Hylan Boulevard, recorded in this district.",
    scope_difference: "The answer says the ten-year capital plan is full and the agency cannot guarantee the revenue to move the date, so the project record is not a statement that the request was granted.",
    scope_difference_quote: "Our ten year capital plan is full right now and we cannot guarantee if there will be enough additional revenue from water & sewer bills to move up the date for this project.",
  },
]);

/**
 * Candidates that were read and refused, and the associations a reader might
 * expect that this reading will not make.
 *
 * Keeping refusals in the artifact is the point. An absent link is invisible,
 * and an invisible refusal is indistinguishable from never having looked.
 *
 *   ordinary_word_published_as_code   the code is a word the request uses in
 *                                     its ordinary sense. It carries no digit,
 *                                     so the candidate rule never proposes it,
 *                                     and the entry records why.
 *   name_similarity_only              a facility, street or place name reads
 *                                     alike. Neither text publishes the code.
 *   no_published_identifier           the request names a project in prose and
 *                                     no published identifier at all.
 *   scope_not_established             the code is a candidate — a whole
 *                                     published code the text names — and the
 *                                     review could not place the request inside
 *                                     the project's published extent.
 */
export const REQUEST_PROJECT_REVIEWED_REFUSALS = Object.freeze([
  {
    board_id: "bronx-cb-06",
    tracking_code: "106202704C",
    project_code: "BATHGATE",
    refusal_class: "ordinary_word_published_as_code",
    refused_because: "The request is about a Bronx playground of that name, answered by Parks and Recreation. The published code of the same spelling belongs to an Economic Development Corporation campus project. The word carries no digit, so it is never a candidate here.",
  },
  {
    board_id: "bronx-cb-07",
    tracking_code: "107202734E",
    project_code: "LAGUARDIA",
    refusal_class: "ordinary_word_published_as_code",
    refused_because: "The request asks for a bus route to an airport of that name, answered by the transit authority. The published code of the same spelling belongs to a City University streetscape project. The word carries no digit, so it is never a candidate here.",
  },
  {
    board_id: "brooklyn-cb-14",
    tracking_code: "214202702C",
    project_code: "LBM25CTIF",
    refusal_class: "name_similarity_only",
    refused_because: "The request asks for a building rehabilitation and expansion of a library branch; the published project of that code is an HVAC replacement at the same branch. Neither text publishes the other's identifier, and a rehabilitation and a mechanical replacement are different scopes with different funding.",
  },
  {
    board_id: "brooklyn-cb-14",
    tracking_code: "214202708C",
    project_code: "HBK243140",
    refusal_class: "name_similarity_only",
    refused_because: "The request describes bridges the board wants rehabilitated and the purview complications around a plaza of the same street name; the published project of that code is the carriageway over a subway line. The request publishes no identifier, and a shared street name is not an identity.",
  },
  {
    board_id: "brooklyn-cb-14",
    tracking_code: "214202701CS",
    project_code: null,
    refusal_class: "no_published_identifier",
    refused_because: "The request names a memorial by name and states the board's understanding that capital funding is in place. No published project identifier appears in the request or in the answer, so there is nothing to resolve and nothing is proposed.",
  },
  {
    board_id: "queens-cb-12",
    tracking_code: "412202704CS",
    project_code: "HWQ121B3",
    refusal_class: "scope_not_established",
    refused_because: "The board names this whole published code, so it is a candidate. The retained project's published description bounds two street grids by 155th and 157th Streets, and the location the request names is far east of them. The published answer does not name the project either. Scope was not established, so no link is offered.",
  },
]);

export const REQUEST_PROJECT_NEGATIVE_RULE = "A link between a request and a capital project is a reference the published text makes, and nothing else. It is never funding, inclusion in the project's scope, a commitment, delivery or fulfilment of the request, and a request and a project keep the separate dates their own publishers gave them.";

export const REQUEST_PROJECT_POLICY = Object.freeze({
  join: "a whole published capital project code named in the answer or in the board's own submission, scoped to one managing agency",
  minimum_code_length: REQUEST_PROJECT_MINIMUM_CODE_LENGTH,
  identifier_must_carry_a_digit: true,
  name_similarity_is_not_a_relation: true,
  substring_of_a_longer_code_is_not_that_code: true,
  candidates_remain_unlinked_until_reviewed: true,
  reviewed_scope_and_agency_required: true,
  amounts_are_whole_project_figures: "the project's own budget and recorded spending, never a figure about this request",
  dates_are_each_publisher_s_own: "the answer's publication date and the capital observation's reporting and record dates are kept apart",
  relation_is_not_fulfilment: true,
});

function requestProjectDay(value) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function requestProjectAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * The capital observations, reduced to one record per managing agency and
 * published code: the latest retained release that carries it.
 *
 * Two rows under one code and two managing agencies are two records and stay
 * that way; collapsing them would silently pick one component to stand for the
 * project.
 */
export function requestProjectCapitalIndex(rows) {
  const index = new Map();
  let latestRelease = "";
  for (const row of rows || []) {
    const code = String(row?.fms_id || "").trim().toUpperCase();
    const agency = String(row?.agency || "").trim().toUpperCase();
    const release = String(row?.reporting_period || "").trim();
    if (!code || !agency || !release) continue;
    if (release > latestRelease) latestRelease = release;
    const key = `${agency}|${code}`;
    const held = index.get(key);
    if (!held || release > held.row.reporting_period) index.set(key, { row, releases: (held?.releases || 0) + 1 });
    else index.set(key, { row: held.row, releases: held.releases + 1 });
  }
  return {
    latest_release: latestRelease,
    published_codes: new Set([...index.keys()].map((key) => key.split("|")[1])),
    project_count: index.size,
    get(managingAgency, projectCode) {
      return index.get(`${String(managingAgency).toUpperCase()}|${String(projectCode).toUpperCase()}`) || null;
    },
    managingAgenciesFor(projectCode) {
      const wanted = String(projectCode).toUpperCase();
      return [...index.keys()]
        .filter((key) => key.endsWith(`|${wanted}`))
        .map((key) => key.split("|")[0])
        .sort();
    },
  };
}

/** The dated record stamps the capital history publishes for one project. */
function requestProjectObservationDates(history, managingAgency, projectCode) {
  const entries = Array.isArray(history?.financial_projects) ? history.financial_projects : [];
  const entry = entries.find((row) => (
    String(row?.managing_agency || "").toUpperCase() === String(managingAgency).toUpperCase()
    && String(row?.fms_id || "").toUpperCase() === String(projectCode).toUpperCase()
  ));
  const after = entry?.after || null;
  return {
    agency_data_date: requestProjectDay(after?.agency_data_date),
    financial_data_date: requestProjectDay(after?.financial_data_date),
  };
}

function requestProjectSponsors(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function requestProjectAgencyRoute(routes, code) {
  const entry = routes?.[String(code || "").toUpperCase()];
  if (!entry?.agency_id || !entry?.href) return { code: String(code || "").toUpperCase(), agency_id: null, href: null, name: null };
  return { code: String(code).toUpperCase(), agency_id: entry.agency_id, href: entry.href, name: entry.name || null };
}

/**
 * The publisher's own sentence a relation's scope difference is stated in.
 *
 * The reviewer's reasoning stays in the materialization for anyone reading it;
 * what a resident is shown is the published wording itself. So a reviewed
 * difference names a passage the publisher actually wrote, and this resolves it
 * against the retained publications rather than trusting the review: a quote
 * that is no longer verbatim in a servable version stops the build.
 */
function requestProjectQuote(request, quote) {
  const wanted = String(quote ?? "");
  if (!wanted) return null;
  const versions = (Array.isArray(request?.versions) ? request.versions : [])
    .filter((version) => version?.servable === true);
  for (const version of [...versions].reverse()) {
    for (const [field, value] of [["response", version?.response], ["board_submission", version?.explanation]]) {
      if (typeof value === "string" && value.includes(wanted)) {
        return {
          named_in: field,
          publication: String(version.publication),
          publication_date: String(version.publication_date),
          quote: wanted,
        };
      }
    }
  }
  return null;
}

function requestProjectRequestFacts(request) {
  const versions = (request.versions || []).filter((version) => version?.servable === true);
  const latest = versions[versions.length - 1];
  const agency = latest?.responsible_agency || {};
  return {
    board_id: String(request.board_id),
    tracking_code: String(request.tracking_code),
    fiscal_year: Number.isInteger(request.fiscal_year) ? request.fiscal_year : null,
    request_class: request.request_class ? String(request.request_class) : null,
    responsible_agency: {
      source_label: agency.source_label ? String(agency.source_label) : null,
      agency_id: agency.binding === "bound" && agency.agency_id ? String(agency.agency_id) : null,
    },
  };
}

/**
 * Materialize the reviewed relations over the committed register, the retained
 * capital observations and the capital history's record dates.
 *
 * Every reviewed decision is re-derived rather than trusted: a link whose code
 * is no longer a candidate in the field the review names, or whose project the
 * retained observations no longer publish, stops the build instead of quietly
 * disappearing from a resident's page.
 */
export function buildCommunityBoardRequestProjectLinks({
  register,
  documents,
  capitalRows,
  projectHistory,
  agencyRoutes = {},
  capitalSource,
}) {
  const capital = requestProjectCapitalIndex(capitalRows);
  const requests = new Map();
  for (const document of documents || []) {
    for (const request of document.requests || []) {
      requests.set(`${document.board_id}|${request.tracking_code}`, request);
    }
  }

  const candidatesByRequest = new Map();
  let requestsConsidered = 0;
  for (const [key, request] of requests) {
    requestsConsidered += 1;
    const found = requestProjectCandidates(request, capital.published_codes);
    if (found.length) candidatesByRequest.set(key, found);
  }

  const relations = [];
  const claimed = new Set();
  for (const reviewed of REQUEST_PROJECT_REVIEWED_LINKS) {
    const key = `${reviewed.board_id}|${reviewed.tracking_code}`;
    const request = requests.get(key);
    if (!request) throw new Error(`reviewed link names a request the register does not carry: ${key}`);
    const candidate = (candidatesByRequest.get(key) || []).find((row) => row.project_code === reviewed.project_code);
    if (!candidate) {
      throw new Error(`reviewed link ${key} -> ${reviewed.project_code} is no longer a candidate in the retained publications`);
    }
    if (!candidate.named_in.includes(reviewed.named_in)) {
      throw new Error(`reviewed link ${key} -> ${reviewed.project_code} is not named in ${reviewed.named_in}`);
    }
    const held = capital.get(reviewed.managing_agency, reviewed.project_code);
    if (!held) {
      throw new Error(`no retained capital observation for ${reviewed.managing_agency} ${reviewed.project_code}`);
    }
    const differenceQuote = requestProjectQuote(request, reviewed.scope_difference_quote);
    if (reviewed.scope_difference_quote && !differenceQuote) {
      throw new Error(`reviewed link ${key} -> ${reviewed.project_code} quotes wording no servable publication carries`);
    }
    claimed.add(`${key}|${reviewed.project_code}`);

    const row = held.row;
    const name = String(row.title || "").trim() || null;
    const description = String(row.description || "").trim() || null;
    const scope = description && description !== name ? description : null;
    const dates = requestProjectObservationDates(projectHistory, reviewed.managing_agency, reviewed.project_code);
    const sponsors = requestProjectSponsors(row.sponsor_agency);
    const alsoPublishedUnder = capital.managingAgenciesFor(reviewed.project_code)
      .filter((agency) => agency !== String(reviewed.managing_agency).toUpperCase());

    relations.push({
      relation: REQUEST_PROJECT_RELATION,
      method: REQUEST_PROJECT_METHOD,
      request: requestProjectRequestFacts(request),
      evidence: {
        project_code: reviewed.project_code,
        managing_agency: String(reviewed.managing_agency).toUpperCase(),
        match_rule: "whole published project code, scoped to one managing agency",
        named_in: candidate.named_in.slice(),
        reviewed_named_in: reviewed.named_in,
        passages: candidate.passages.slice(),
      },
      capital_project: {
        source: String(row.source || "capital_projects_dashboard"),
        source_url: capitalSource?.source_url || String(row.source_url || ""),
        landing_url: capitalSource?.landing_url || String(row.source_url || ""),
        financial_identity: {
          managing_agency: String(reviewed.managing_agency).toUpperCase(),
          project_code: reviewed.project_code,
        },
        pid: row.pid ? String(row.pid) : null,
        project_name: name,
        project_scope: scope,
        project_scope_published_blank: !description,
        project_scope_repeats_name: Boolean(description && description === name),
        current_phase: row.current_phase ? String(row.current_phase) : null,
        borough: row.borough ? String(row.borough) : null,
        community_board: row.community_board ? String(row.community_board) : null,
        project_budget: requestProjectAmount(row.budget?.amount),
        recorded_project_spending: requestProjectAmount(row.budget?.spend_to_date),
        project_forecast_completion: requestProjectDay(row.term_end),
        observation: {
          reporting_period: String(row.reporting_period),
          agency_data_date: dates.agency_data_date,
          financial_data_date: dates.financial_data_date,
          latest_retained_release: capital.latest_release,
          from_latest_retained_release: String(row.reporting_period) === capital.latest_release,
          releases_observed: held.releases,
        },
        also_published_under_managing_agencies: alsoPublishedUnder,
        agencies: {
          managing: requestProjectAgencyRoute(agencyRoutes, reviewed.managing_agency),
          sponsoring: sponsors.map((code) => requestProjectAgencyRoute(agencyRoutes, code)),
        },
      },
      review: {
        reviewed_on: REQUEST_PROJECT_REVIEWED_ON,
        agency_evidence: reviewed.agency_evidence,
        scope_evidence: reviewed.scope_evidence,
        scope_difference: reviewed.scope_difference || null,
        // What a resident is shown of that difference: the publisher's own
        // sentence, resolved to the publication that carries it.
        scope_difference_quote: differenceQuote,
      },
    });
  }

  const refusals = REQUEST_PROJECT_REVIEWED_REFUSALS.map((refusal) => {
    const key = `${refusal.board_id}|${refusal.tracking_code}`;
    const request = requests.get(key);
    if (!request) throw new Error(`reviewed refusal names a request the register does not carry: ${key}`);
    const found = candidatesByRequest.get(key) || [];
    const isCandidate = found.some((row) => row.project_code === refusal.project_code);
    if (refusal.refusal_class === "scope_not_established" && !isCandidate) {
      throw new Error(`refusal ${key} -> ${refusal.project_code} claims a reviewed candidate that the rule no longer proposes`);
    }
    if (refusal.refusal_class !== "scope_not_established" && isCandidate) {
      throw new Error(`refusal ${key} -> ${refusal.project_code} is a candidate and must be reviewed, not refused by class`);
    }
    if (refusal.refusal_class === "no_published_identifier" && found.length) {
      throw new Error(`refusal ${key} claims no published identifier but the request names one`);
    }
    return {
      request: requestProjectRequestFacts(request),
      project_code: refusal.project_code,
      refusal_class: refusal.refusal_class,
      published_as_a_project_code: refusal.project_code ? capital.published_codes.has(refusal.project_code) : false,
      was_a_candidate: isCandidate,
      refused_because: refusal.refused_because,
      reviewed_on: REQUEST_PROJECT_REVIEWED_ON,
    };
  });

  const pending = [];
  for (const [key, found] of candidatesByRequest) {
    for (const candidate of found) {
      if (claimed.has(`${key}|${candidate.project_code}`)) continue;
      if (REQUEST_PROJECT_REVIEWED_REFUSALS.some((refusal) => (
        `${refusal.board_id}|${refusal.tracking_code}` === key && refusal.project_code === candidate.project_code
      ))) continue;
      const [boardId, trackingCode] = key.split("|");
      pending.push({
        board_id: boardId,
        tracking_code: trackingCode,
        project_code: candidate.project_code,
        named_in: candidate.named_in.slice(),
        managing_agencies: capital.managingAgenciesFor(candidate.project_code),
      });
    }
  }
  pending.sort((left, right) => (
    left.board_id.localeCompare(right.board_id)
    || left.tracking_code.localeCompare(right.tracking_code)
    || left.project_code.localeCompare(right.project_code)
  ));

  relations.sort((left, right) => (
    left.request.board_id.localeCompare(right.request.board_id)
    || left.request.tracking_code.localeCompare(right.request.tracking_code)
    || left.evidence.project_code.localeCompare(right.evidence.project_code)
  ));

  return {
    schema: REQUEST_PROJECT_LINKS_SCHEMA,
    relation: REQUEST_PROJECT_RELATION,
    method: REQUEST_PROJECT_METHOD,
    negative_rule: REQUEST_PROJECT_NEGATIVE_RULE,
    policy: REQUEST_PROJECT_POLICY,
    reviewed_on: REQUEST_PROJECT_REVIEWED_ON,
    source_scope: {
      requests: {
        publisher: register?.source?.publisher || null,
        name: register?.source?.name || null,
        dataset_id: register?.source?.dataset_id || null,
        source_url: register?.source?.source_url || null,
        acquired_at: register?.acquired_at || null,
        servable_publications: (register?.publication_selection?.servable || []).slice(),
        as_of: register?.publication_selection?.as_of || null,
      },
      capital_projects: {
        source: capitalSource?.source || "capital_projects_dashboard",
        source_contract_id: capitalSource?.source_contract_id || null,
        dataset_id: capitalSource?.dataset_id || null,
        source_url: capitalSource?.source_url || null,
        landing_url: capitalSource?.landing_url || null,
        latest_retained_release: capital.latest_release,
        published_project_codes: capital.published_codes.size,
        published_projects: capital.project_count,
      },
    },
    counts: {
      requests_considered: requestsConsidered,
      requests_with_a_candidate: candidatesByRequest.size,
      candidates: [...candidatesByRequest.values()].reduce((total, rows) => total + rows.length, 0),
      relations: relations.length,
      projects_related: new Set(relations.map((row) => `${row.evidence.managing_agency}|${row.evidence.project_code}`)).size,
      boards_with_a_relation: new Set(relations.map((row) => row.request.board_id)).size,
      reviewed_refusals: refusals.length,
      candidates_pending_review: pending.length,
    },
    relations,
    reviewed_refusals: refusals,
    candidates_pending_review: pending,
  };
}

/** A materialization this reading will read. Anything else renders nothing. */
export function validateCommunityBoardRequestProjectLinks(artifact) {
  const problems = [];
  if (artifact?.schema !== REQUEST_PROJECT_LINKS_SCHEMA) problems.push("schema");
  if (artifact?.relation !== REQUEST_PROJECT_RELATION) problems.push("relation");
  if (artifact?.policy?.candidates_remain_unlinked_until_reviewed !== true) problems.push("policy.candidates_remain_unlinked_until_reviewed");
  if (artifact?.policy?.name_similarity_is_not_a_relation !== true) problems.push("policy.name_similarity_is_not_a_relation");
  if (artifact?.policy?.relation_is_not_fulfilment !== true) problems.push("policy.relation_is_not_fulfilment");
  if (!Array.isArray(artifact?.relations)) problems.push("relations");
  return problems;
}
