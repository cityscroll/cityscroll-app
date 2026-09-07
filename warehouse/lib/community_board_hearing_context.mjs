/**
 * Hearing preparation context: one board's published hearing agenda, and the
 * previous budget cycle's own record read alongside it.
 *
 * A resident who wants to speak at a community board's budget hearing needs
 * two things this repository already touches separately. The first is the
 * agenda the board actually published — which hearing starts when, which
 * fiscal year it is about, and how a person registers to speak or files
 * written testimony. The second is the record of what the same board asked the
 * city for in the previous cycle and what the agencies wrote back, so a
 * resident arrives with a question grounded in a document rather than an
 * impression.
 *
 * The whole difficulty is holding those two apart while showing them together.
 *
 * What this module establishes
 * ----------------------------
 * A board published an agenda with named segments and start times; the board
 * published documents for an earlier fiscal year; and specific passages of the
 * board's own needs statement can be tied to specific requests in the city's
 * register. Nothing here establishes that a previous-cycle request is on the
 * coming agenda, that a request will be raised again, or that any answer an
 * agency wrote is funding, a commitment or delivery.
 *
 * Fiscal years are the load-bearing distinction. The hearing announced for one
 * fiscal year and the register retained for the previous one are different
 * populations, and a reader choosing material for the coming hearing has to be
 * able to see which is which. Every previous-cycle fact carried here is
 * stamped with the fiscal year it belongs to, and the two years are never
 * merged into one list.
 *
 * How a statement passage is tied to a request
 * --------------------------------------------
 * Not by its text. A board can and does write one explanation into two
 * requests — a capital request and an expense request to the same agency, at
 * the same priority, can carry byte-identical prose — so matching on the
 * explanation alone produces a passage attached to the wrong record with no
 * visible symptom. A passage is tied only when the board, the fiscal year, the
 * responsible agency, the budget class, and the board's own priority within
 * that agency and class all agree, and the retained passage text is kept
 * alongside the tie so the join can be re-checked rather than trusted. A
 * passage whose identity is ambiguous under those keys is retained unattached,
 * with the reason.
 *
 * Two source versions of one answer
 * ---------------------------------
 * The city's data publication and the board's own published register PDF do
 * not always print the same answer for the same request. Where they differ,
 * both are retained and labelled by the source they came from. Overwriting
 * either with the other would be a silent editorial decision about which
 * publisher to believe.
 *
 * Documents that did not extract
 * ------------------------------
 * A scanned document that yields no usable text is retained as a document, at
 * its published address, with the measured extraction result stated. It is
 * never described as read, quoted from, or summarized. A vote recorded in
 * minutes to send a letter is evidence of the vote and of the letter's
 * existence — never evidence of what the letter says.
 */

export const HEARING_CONTEXT_OBSERVATION_SCHEMA = "cityscroll.community_board_hearing_context_observation.v1";
export const HEARING_CONTEXT_FIXTURE_MANIFEST_SCHEMA = "cityscroll.community_board_hearing_context_fixtures.v1";
export const HEARING_CONTEXT_SCHEMA = "cityscroll.community_board_hearing_context.v1";

/** Segment kinds the agenda parser will name. Anything else stays generic. */
export const HEARING_SEGMENT_KINDS = Object.freeze(["public_hearing", "regular_meeting", "other"]);

/** How a retained document's text extraction came out. */
export const HEARING_DOCUMENT_EXTRACTION_STATES = Object.freeze(["extracted", "not_extracted", "not_attempted"]);

/** Why a statement passage is not tied to a request. */
export const HEARING_PASSAGE_UNATTACHED_REASONS = Object.freeze([
  "no_matching_request",
  "ambiguous_identity",
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function hearingClean(value, max = 400) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The publisher's typographic characters flattened to their plain equivalents.
 *
 * Only used for comparing two renderings of one sentence — a PDF text layer
 * and an HTML page disagree about curly quotes and dash widths without either
 * being a different sentence. The retained text always keeps what the
 * publisher wrote.
 */
export function hearingComparableText(value) {
  return hearingClean(value, 40_000)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function hearingStripTags(value, max = 4_000) {
  return hearingClean(decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " ")), max)
    // A tag boundary inside a sentence — the publisher emphasises a clause and
    // then punctuates outside the emphasis — leaves a space in front of the
    // punctuation once the tag is gone. Closing it up restores the sentence
    // the publisher wrote rather than editing it.
    .replace(/\s+([,.;:!?])/g, "$1");
}

function stripScriptAndStyle(html) {
  return String(html ?? "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function httpsUrl(value, base = null) {
  const raw = hearingClean(decodeEntities(value), 2_000);
  if (!raw) return null;
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A published clock time on a 12-hour agenda line, as 24-hour "HH:MM".
 *
 * Returns null rather than guessing: an agenda line with no time is a line
 * this reading has nothing to say about, and inventing midnight for it would
 * put a fabricated start time in front of a resident.
 */
export function hearingParseClockTime(value) {
  const match = hearingClean(value, 40).match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = match[3].toLowerCase();
  const hour24 = meridiem === "p" ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function segmentKind(title) {
  const text = hearingClean(title, 400).toLowerCase();
  if (/public hearing/.test(text)) return "public_hearing";
  if (/regular (monthly )?meeting|board meeting/.test(text)) return "regular_meeting";
  return "other";
}

/**
 * The fiscal year a segment names, taken only from an explicit written year.
 *
 * "Fiscal Year 2028" and "FY2028" both count. A bare four-digit year does not:
 * a street number, a founding date or a document revision would all pass that
 * test, and a wrong fiscal year here is the single most misleading thing this
 * reading could publish.
 */
export function hearingParseFiscalYear(value) {
  const text = hearingClean(value, 600);
  const match = text.match(/\b(?:fiscal\s+year|fy)\s*(\d{4})\b/i);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100 ? year : null;
}

/** Which budget classes a segment names in words. */
export function hearingParseBudgetClasses(value) {
  const text = hearingClean(value, 600).toLowerCase();
  const classes = [];
  if (/\bcapital\b/.test(text)) classes.push("capital");
  if (/\bexpense\b/.test(text)) classes.push("expense");
  return classes;
}

/**
 * The agenda segments a board published for one meeting.
 *
 * The board's agenda is an explicit list on the published page, so this reads
 * that list and nothing else. It does not infer a schedule from a meeting's
 * start and end time, and it does not split a title on prose it happens to
 * find elsewhere on the page: a segment exists here only because the publisher
 * wrote it as a segment, with a start time and a title on one line.
 */
export function parseHearingAgendaSegments(html) {
  const page = stripScriptAndStyle(html);
  const list = page.match(/<ul\b[^>]*class="[^"]*\bschedule-ul\b[^"]*"[^>]*>([\s\S]*?)<\/ul>\s*(?:<\/div>|<p\b)/i);
  if (!list) return [];
  const segments = [];
  // Each segment opens with the only emphasised run in its list item, so the
  // emphasised runs are the segment boundaries. Splitting on list items
  // instead would cut a segment away from its own sub-list, which is where
  // the publisher writes the detail that belongs to it.
  const headings = [...list[1].matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)];
  const items = headings.map((match, index) => ({
    strong: match,
    body: list[1].slice(match.index + match[0].length, index + 1 < headings.length ? headings[index + 1].index : list[1].length),
  }));
  for (const item of items) {
    const heading = hearingStripTags(item.strong[1], 400);
    const split = heading.match(/^(\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?)\s*[–—-]\s*(.+)$/);
    if (!split) continue;
    const startTime = hearingParseClockTime(split[1]);
    const title = hearingClean(split[2], 400);
    if (!startTime || !title) continue;
    const detail = [...item.body.matchAll(/<li\b[^>]*class="[^"]*\bagenda-text\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((match) => hearingStripTags(match[1], 1_200))
      .filter(Boolean);
    segments.push({
      order: segments.length + 1,
      start_time: startTime,
      kind: segmentKind(title),
      title,
      fiscal_year: hearingParseFiscalYear(title),
      budget_classes: hearingParseBudgetClasses(title),
      detail,
    });
  }
  return segments;
}

const SPEAKING_HEADING = /pre-?register to speak|register to speak/i;
const WATCH_HEADING = /watch the meeting/i;

/**
 * One disclosure panel of the published page, by its heading.
 *
 * The board writes its participation instructions inside collapsible panels
 * whose headings are stable prose. Reading a panel by its heading keeps the
 * instructions attached to the heading the publisher filed them under, so a
 * panel that moves or disappears produces nothing rather than the wrong prose.
 */
function participationPanel(page, pattern) {
  const headings = [...page.matchAll(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi)];
  for (let index = 0; index < headings.length; index += 1) {
    const text = hearingStripTags(headings[index][1], 200);
    if (!pattern.test(text)) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : page.length;
    return { heading: text, html: page.slice(start, end) };
  }
  return null;
}

/**
 * How a person takes part, as the publisher wrote it.
 *
 * Every field here is a quotation or an address lifted from the page, never a
 * paraphrase: the difference between "you may submit written testimony" and
 * "written testimony is accepted" is exactly the kind of drift that turns an
 * official instruction into this site's opinion about an official instruction.
 */
export function parseHearingParticipation(html, sourceUrl) {
  const page = stripScriptAndStyle(html);
  const speaking = participationPanel(page, SPEAKING_HEADING);
  const watch = participationPanel(page, WATCH_HEADING);
  const registrationUrls = [];
  const passages = [];
  let writtenTestimony = null;

  if (speaking) {
    for (const match of speaking.html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = httpsUrl(match[1], sourceUrl);
      const label = hearingStripTags(match[2], 160);
      if (!url || !label) continue;
      if (/\bform\b|sign up|register|use this link/i.test(`${label} ${url}`)) registrationUrls.push(url);
    }
    for (const match of speaking.html.matchAll(/<iframe\b[^>]*\b(?:data-)?src\s*=\s*"([^"]+)"[^>]*>/gi)) {
      const url = httpsUrl(match[1], sourceUrl);
      // An embedded form is the form itself; its canonical address is the same
      // resource without the host's embed wrapper, which is what a person
      // opening it in their own browser needs.
      if (url && /\/embed\//.test(url)) registrationUrls.push(url.replace("/embed/", "/"));
    }
    for (const match of speaking.html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = hearingStripTags(match[1], 1_200);
      if (!text || text.startsWith("(")) continue;
      passages.push(text);
      if (/written testimony/i.test(text)) writtenTestimony = text;
    }
  }

  const watchUrls = [];
  if (watch) {
    for (const match of watch.html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = httpsUrl(match[1], sourceUrl);
      if (url) watchUrls.push(url);
    }
  }

  const unique = (values) => [...new Set(values.filter(Boolean))];
  return {
    speaking_registration_url: unique(registrationUrls)[0] || null,
    speaking_registration_heading: speaking?.heading || null,
    speaking_passages: passages.slice(0, 6),
    written_testimony_passage: writtenTestimony,
    watch_urls: unique(watchUrls).slice(0, 4),
    watch_heading: watch?.heading || null,
  };
}

const STATEMENT_SECTION_HEADING = /^\s*\d+\.\s+SUMMARY OF PRIORITIZED BUDGET REQUESTS\s*$/;
const STATEMENT_CLASS_HEADING = /^\s*(CAPITAL|EXPENSE) BUDGET REQUESTS\s*$/;
const STATEMENT_AGENCY_HEADING = /^\s*([A-Z][A-Za-z'&.,\- ]{3,80}?)\s*\(([A-Z][A-Za-z0-9&/-]{1,12})\)\s*$/;
const STATEMENT_ENTRY = /^\s{2,}(\d{1,2}) of (\d{1,2})\s{2,}(.+?)\s{2,}([A-Z][A-Za-z0-9&/-]{1,12})\s*$/;
const STATEMENT_PAGE_NUMBER = /^\s*\d{1,4}\s*$/;

/**
 * The board's own needs statement, read as passages rather than as prose.
 *
 * The statement's final section prints one entry per prioritized request: the
 * board's rank within an agency and budget class, the board's title for it,
 * the agency's short form, the city's request class on the following line, and
 * then the board's written explanation. That structure is the identity — the
 * rank and the class are printed next to the passage — so it is read as
 * structure and every field is carried, not just the prose.
 *
 * Only the summary section is read. Earlier sections of the statement discuss
 * the same subjects in narrative form without the identity keys beside them,
 * and a passage lifted from there could not be tied to a request honestly.
 */
export function parseNeedsStatementPassages(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const passages = [];
  let inSection = false;
  let budgetClass = null;
  let agency = null;
  let current = null;
  const flush = () => {
    if (!current) return;
    const passage = hearingClean(current.buffer.join(" "), 8_000);
    if (passage) passages.push({ ...current.entry, passage });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ").replace(/\f/g, "");
    if (STATEMENT_SECTION_HEADING.test(line)) {
      flush();
      inSection = true;
      budgetClass = null;
      agency = null;
      continue;
    }
    if (!inSection) continue;

    const classHeading = line.match(STATEMENT_CLASS_HEADING);
    if (classHeading) {
      flush();
      budgetClass = classHeading[1].toLowerCase();
      agency = null;
      continue;
    }

    const entry = line.match(STATEMENT_ENTRY);
    if (entry && budgetClass) {
      flush();
      const abbreviation = hearingClean(entry[4], 16);
      current = {
        entry: {
          budget_class: budgetClass,
          // The entry line carries its own agency short form, and the section
          // heading above it carries the long one. The long form is kept only
          // when the two agree: the statement prints at least one heading
          // without its short form, and carrying the previous heading forward
          // would put the wrong agency's name on a passage.
          statement_agency_label: agency?.abbreviation === abbreviation ? agency.label : null,
          agency_abbreviation: abbreviation,
          rank_value: String(Number(entry[1])).padStart(2, "0"),
          rank_of: Number(entry[2]),
          title: hearingClean(entry[3], 300),
          request_class_label: null,
        },
        buffer: [],
        seenRequestClass: false,
      };
      continue;
    }

    const agencyHeading = line.match(STATEMENT_AGENCY_HEADING);
    if (agencyHeading) {
      flush();
      agency = { label: hearingClean(agencyHeading[1], 160), abbreviation: hearingClean(agencyHeading[2], 16) };
      continue;
    }

    if (!current) continue;
    if (STATEMENT_PAGE_NUMBER.test(line)) continue;
    const value = hearingClean(line, 1_000);
    if (!value) continue;
    // The line directly under an entry repeats the city's own request class.
    // It is the class, not part of what the board wrote, so it is carried as a
    // separate field rather than pushed into the passage.
    if (!current.seenRequestClass) {
      current.entry.request_class_label = value;
      current.seenRequestClass = true;
      continue;
    }
    current.buffer.push(value);
  }
  flush();
  return passages;
}

const REGISTER_RESPONSE_HEADER = /\b(?:Adopted|Preliminary|Executive|Agency)(?: Budget)? Response\b/;
const REGISTER_ROW_ANCHOR = /\b(\d{9}(?:CS|C|E))\s+Request:/;

/**
 * One page of a word-box rendering, regrouped into printed rows.
 *
 * The renderer's own line grouping cannot be used: on a two-column page it
 * sometimes emits each column as its own line and sometimes merges both
 * columns into one, which is exactly the difference that decides whether a
 * response is read whole or truncated. Words carry their own coordinates,
 * though, so rows are rebuilt here from the words up — everything printed at
 * the same height is one row — and the column split happens inside a row.
 */
function pageWordRows(pageMarkup, { rowTolerance = 1.5 } = {}) {
  const words = [...pageMarkup.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([\s\S]*?)<\/word>/g)]
    .map((word) => ({ x: Number(word[1]), y: Number(word[2]), text: decodeEntities(word[3]) }))
    .filter((word) => word.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const rows = [];
  for (const word of words) {
    const row = rows[rows.length - 1];
    if (row && word.y - row.y <= rowTolerance) {
      row.words.push(word);
      continue;
    }
    rows.push({ y: word.y, words: [word] });
  }
  for (const row of rows) row.words.sort((left, right) => left.x - right.x);
  return rows;
}

function joinWords(words) {
  return hearingClean(words.map((word) => word.text).join(" "), 4_000);
}

/**
 * The board's own published register PDF, read for the response column.
 *
 * The register prints the request and the agency's answer side by side. Read
 * as flowed text the two columns interleave, and the character offset where
 * one ends and the other begins moves from page to page, so a reading built on
 * that offset splices half of one sentence into the other with no visible
 * symptom: "this year" comes out as "this ar". The publisher's own layout is
 * unambiguous, though, and a word-box rendering preserves it, because every
 * word carries the horizontal position it was laid out at.
 *
 * So the column boundary is taken from each page's own response header, and a
 * response is the words of a printed row that begin at or after it. A response
 * belongs to the request whose row it sits beside — vertical position, which
 * is what a reader of the printed page uses. A page with no header contributes
 * nothing rather than a guess, and a page whose rows carry no tracking code
 * contributes nothing either.
 *
 * The result is the publisher's own rendering of the answer, kept separate
 * from the city data publication's rendering of the same answer rather than
 * merged with it.
 */
export function parseRegisterDocumentResponses(wordBoxMarkup, { columnTolerance = 0.5 } = {}) {
  const collected = new Map();
  for (const page of String(wordBoxMarkup ?? "").matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)) {
    const rows = pageWordRows(page[1]);
    let columnStart = null;
    let headerY = null;
    for (const row of rows) {
      const text = joinWords(row.words);
      const header = text.match(REGISTER_RESPONSE_HEADER);
      if (header) {
        // The header phrase's own first word marks the column, so the boundary
        // is read from the printed table rather than assumed from the page.
        const offset = row.words.findIndex((word, index) => (
          joinWords(row.words.slice(index)).startsWith(header[0])
        ));
        if (offset >= 0) {
          columnStart = row.words[offset].x - columnTolerance;
          headerY = row.y;
        }
        continue;
      }
      if (columnStart === null || row.y <= headerY) continue;
      const left = row.words.filter((word) => word.x < columnStart);
      const right = row.words.filter((word) => word.x >= columnStart);
      const anchor = joinWords(left).match(REGISTER_ROW_ANCHOR);
      if (anchor) collected.set(anchor[1], collected.get(anchor[1]) || []);
      const current = [...collected.keys()].pop();
      if (!current || !right.length) continue;
      collected.get(current).push(joinWords(right));
    }
  }
  return [...collected.entries()]
    .map(([code, parts]) => ({ tracking_code: code, response: hearingClean(parts.join(" "), 8_000) }))
    .filter((row) => row.response);
}

const RESOLVED_LINE = /RESOLVED\s*\((\d{1,3})\s*-\s*(\d{1,3})\s*-\s*(\d{1,3})\)\s*(?:to\s+)?(.*?)(?:\.|\s*\(Addendum|$)/i;

/**
 * A recorded board vote, read only from an explicit resolution line.
 *
 * The tally and the action come from one sentence the board ratified. Where
 * that sentence is absent this returns null: a date near a document is not a
 * vote, and a vote to send a letter is never read here as evidence of what the
 * letter says.
 */
export function parseRatifiedResolution(text) {
  const match = hearingClean(text, 4_000_000).match(RESOLVED_LINE);
  if (!match) return null;
  const action = hearingClean(match[4], 400);
  if (!action) return null;
  return {
    tally: {
      in_favor: Number(match[1]),
      opposed: Number(match[2]),
      abstaining: Number(match[3]),
    },
    tally_text: `${Number(match[1])}-${Number(match[2])}-${Number(match[3])}`,
    action: `to ${action}`,
  };
}

/**
 * How the needs statement's agency short forms bind to the register's labels.
 *
 * The two publications name the same agencies differently — one prints "FDNY"
 * under a heading reading "Fire Department of New York", the other publishes
 * "Fire Department" — so a binding is needed, and every binding here is one a
 * person reviewed. No fuzzy or partial matching stands behind this table: a
 * short form with no reviewed binding produces no tie at all, which is the
 * right outcome for a statement heading whose agency this repository has not
 * confirmed. The statement's "SCA" is deliberately absent for that reason: the
 * register carries no label under which those entries can be placed without
 * guessing that a school construction entry belongs to the education
 * department's requests.
 */
export const NEEDS_STATEMENT_AGENCY_BINDINGS = Object.freeze({
  ACS: "Administration for Children's Services",
  BPL: "Brooklyn Public Library",
  DCP: "Department of City Planning",
  DCWP: "Department of Consumer and Worker Protection",
  DEP: "Department of Environmental Protection",
  DFTA: "Department for the Aging",
  DHS: "Department of Homeless Services",
  DOB: "Department of Buildings",
  DOHMH: "Department of Health and Mental Hygiene",
  DOT: "Department of Transportation",
  DPR: "Department of Parks and Recreation",
  DSNY: "Department of Sanitation",
  DYCD: "Department of Youth & Community Development",
  FDNY: "Fire Department",
  HHC: "Health and Hospitals Corporation",
  HPD: "Department of Housing Preservation & Development",
  HRA: "Human Resources Administration",
  NYCTA: "Transit Authority",
  NYPD: "Police Department",
  OMB: "Mayor's Office of Management and Budget",
  SBS: "Department of Small Business Services",
});

/**
 * A statement passage tied to a register request, or explicitly not tied.
 *
 * The keys are the board, the fiscal year, the responsible agency, the budget
 * class and the board's priority within that agency and class. All five must
 * agree, and the retained passage travels with the tie so a later reader can
 * re-check it. Where more than one request satisfies the keys the passage is
 * kept unattached and says so: an arbitrary pick would be invisible, and this
 * is precisely the case where two requests carry the same words.
 */
export function attachStatementPassages({
  passages = [],
  requests = [],
  agencyAbbreviations = NEEDS_STATEMENT_AGENCY_BINDINGS,
} = {}) {
  const candidates = requests.map((request) => ({
    tracking_code: request.tracking_code,
    fiscal_year: request.fiscal_year,
    request_class: request.request_class,
    agency_label: request.agency_label,
    rank_value: request.rank_value,
  }));
  const attached = [];
  const unattached = [];
  for (const passage of passages) {
    const expected = hearingClean(agencyAbbreviations[passage.agency_abbreviation] || "", 200);
    if (!expected) {
      unattached.push({ ...passage, reason: "no_matching_request", candidate_tracking_codes: [] });
      continue;
    }
    const matches = candidates.filter((request) => (
      request.request_class === passage.budget_class
      && request.rank_value === passage.rank_value
      && hearingComparableText(request.agency_label) === hearingComparableText(expected)
    ));
    if (matches.length === 1) {
      attached.push({
        ...passage,
        tracking_code: matches[0].tracking_code,
        fiscal_year: matches[0].fiscal_year,
        agency_label: matches[0].agency_label,
        identity_keys: ["board_id", "fiscal_year", "responsible_agency", "budget_class", "board_priority"],
      });
      continue;
    }
    unattached.push({
      ...passage,
      reason: matches.length ? "ambiguous_identity" : "no_matching_request",
      candidate_tracking_codes: matches.map((request) => request.tracking_code),
    });
  }
  return { attached, unattached };
}
