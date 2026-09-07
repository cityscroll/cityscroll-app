#!/usr/bin/env node

/**
 * Acquire one board's published hearing agenda and its previous budget cycle's
 * own documents, and freeze the reading as a retained fixture.
 *
 * Nothing downstream reads the publisher. The builder, the served pages and
 * every test read the fixture written here, so a resident's read never depends
 * on a community board's web site being up on the day they look.
 *
 * Three rules make a replay safe to run unattended:
 *
 *  1. Every address is discovered, never typed. A document enters the reading
 *     only because the board's own index page links it, and the plan below
 *     names the page each one must be found on. A document the publisher has
 *     moved therefore disappears from the fixture with an explicit reason,
 *     rather than being published as a link to a page that no longer exists.
 *  2. A failed fetch never touches the retained fixture. The previous reading
 *     stands exactly as it was and the run writes a failure receipt naming the
 *     attempts and the error.
 *  3. Extraction is measured, not assumed. A document whose text layer yields
 *     nothing is retained as a document with that result recorded. It is never
 *     quoted, summarized, or described as read, and no optical character
 *     recognition is attempted here — a scanned document stays a scanned
 *     document this reading has not read.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { measureExtractionQuality } from "../warehouse/lib/document_processing.mjs";
import {
  HEARING_CONTEXT_FIXTURE_MANIFEST_SCHEMA,
  HEARING_CONTEXT_OBSERVATION_SCHEMA,
  attachStatementPassages,
  hearingClean,
  hearingComparableText,
  parseHearingAgendaSegments,
  parseHearingParticipation,
  parseNeedsStatementPassages,
  parseRatifiedResolution,
  parseRegisterDocumentResponses,
} from "../warehouse/lib/community_board_hearing_context.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIRECTORY = join(ROOT, "warehouse/fixtures/community-board-hearing-context");
export const MANIFEST_PATH = join(FIXTURE_DIRECTORY, "manifest.json");
export const RECEIPT_PATH = join(ROOT, "warehouse/receipts/proof/community_board_hearing_context_latest.json");
export const ACQUISITION_RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";

const MAX_ATTEMPTS = 3;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The boards this reading covers, and where each fact has to be found.
 *
 * The plan is deliberately explicit and small. A hearing preparation reading
 * is only worth publishing where someone has confirmed that the board prints
 * an agenda with times, publishes its budget documents, and ratifies minutes —
 * and confirming that is a person's judgement about a publisher, not something
 * to infer from a URL shape. Adding a board is adding an entry here.
 *
 * Each document names the index page it must be linked from and the pattern
 * its address must match on that page. Both have to hold: the pattern alone
 * would let a stale address survive the publisher removing it, and the index
 * alone would not say which of a dozen linked documents is the one meant.
 */
export const HEARING_CONTEXT_PLAN = Object.freeze([
  Object.freeze({
    board_id: "brooklyn-cb-14",
    board_name: "Brooklyn Community Board 14",
    publisher: "Brooklyn Community Board 14",
    time_zone: "America/New_York",
    hearing: Object.freeze({
      meeting_date: "2026-09-14",
      source_url: "https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
    }),
    previous_cycle: Object.freeze({
      fiscal_year: 2027,
      /**
       * The one request the reading walks through end to end.
       *
       * A worked example has to be chosen, and choosing it is a judgement
       * about teaching rather than a property of the data: this one is a
       * library request a resident plausibly cares about, the board wrote a
       * passage explaining it, and the published answer sends the board
       * somewhere specific rather than saying nothing. The reading fails
       * rather than substituting another request if this one stops resolving,
       * because a silently different example is a silently different lesson.
       */
      worked_example: Object.freeze({ tracking_code: "214202702C" }),
      index_urls: Object.freeze({
        budget: "https://cb14brooklyn.com/city-budget/",
        meeting: "https://cb14brooklyn.com/meeting/march-2026-board-meeting/",
      }),
      documents: Object.freeze([
        Object.freeze({
          id: "needs-statement",
          kind: "needs_statement",
          title: "Statement of Community District Needs and Community Board Budget Requests, Fiscal Year 2027",
          index: "budget",
          pattern: "FY2027_Statement-of-Community-District-Needs-and-CB-Requests_BK14.pdf",
          reads: "statement_passages",
        }),
        Object.freeze({
          id: "preliminary-register",
          kind: "budget_register",
          title: "Register of Community Board Budget Requests for the Preliminary Budget, Fiscal Year 2027",
          index: "budget",
          pattern: "CB14-Register-of-Budget-Requests-for-Preliminary-Budget-FY2027.pdf",
          reads: "register_responses",
          // The board published this register before either of the city data
          // publications this repository retains, so its answers have no
          // retained counterpart to be compared with. Comparing it against a
          // later publication's answers would report every ordinary revision
          // of the budget round as a disagreement between publishers.
          compares_to_publication: null,
        }),
        Object.freeze({
          id: "adopted-register",
          kind: "budget_register",
          title: "Register of Community Board Budget Requests for the Adopted Budget, Fiscal Year 2027",
          index: "budget",
          pattern: "FY2027_CB14-Adopted-Budget-Register-CB14.pdf",
          reads: "register_responses",
          // The board's own printing of the same publication the city data
          // release carries, which is what makes the two comparable at all.
          compares_to_publication: "20260630",
        }),
        Object.freeze({
          id: "comment-letter",
          kind: "comment_letter",
          title: "Brooklyn Community Board 14 letter of comment on the Fiscal Year 2027 preliminary budget",
          index: "budget",
          pattern: "FY2027-BK-CB14-Ltr-of-Comment.pdf",
          reads: null,
        }),
        Object.freeze({
          id: "ratified-minutes",
          kind: "minutes",
          title: "Ratified minutes of the March 9, 2026 board meeting",
          index: "meeting",
          pattern: "2026-03-09_Board-Meeting-Minutes_Addendum-ratified.pdf",
          reads: "ratified_resolution",
          meeting_date: "2026-03-09",
        }),
      ]),
    }),
  }),
]);

export function acquisitionContext({
  directory = FIXTURE_DIRECTORY,
  receiptPath = RECEIPT_PATH,
  fetchImpl = fetch,
  extractText = pdfText,
  extractWordBoxes = pdfWordBoxes,
  now = () => new Date(),
} = {}) {
  return { directory, receiptPath, fetchImpl, extractText, extractWordBoxes, now };
}

/**
 * One fetch, with the receipt a later reader needs to judge it.
 *
 * The bytes are hashed here rather than downstream. A hash taken next to the
 * response is evidence about what was served; a hash taken after the bytes have
 * been parsed and re-serialized is evidence about this program.
 */
async function fetchDocument(url, context, { attempt = 1 } = {}) {
  try {
    const response = await context.fetchImpl(url, { redirect: "follow" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      ok: true,
      bytes,
      receipt: {
        source_url: url,
        fetch_status: String(response.status),
        content_type: hearingClean(response.headers.get("content-type"), 120) || null,
        content_length: bytes.length,
        content_sha256: sha256(bytes),
      },
    };
  } catch (error) {
    if (attempt < MAX_ATTEMPTS) return fetchDocument(url, context, { attempt: attempt + 1 });
    return { ok: false, error: hearingClean(error?.message || String(error), 300), receipt: { source_url: url } };
  }
}

/** Every address an index page links, so a plan pattern can be checked against it. */
export function linkedAddresses(html, baseUrl) {
  const found = new Set();
  for (const match of String(html ?? "").matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    try {
      const url = new URL(match[1].replace(/&#0?38;|&amp;/gi, "&"), baseUrl);
      if (url.protocol === "https:") found.add(url.href);
    } catch {
      // A malformed address on the publisher's page is not this program's to fix.
    }
  }
  return [...found];
}

function runPoppler(command, bytes, args, outputSuffix) {
  const stem = join(tmpdir(), `cityscroll-hearing-${process.pid}-${Date.now()}`);
  const input = `${stem}.pdf`;
  const output = `${stem}${outputSuffix}`;
  writeFileSync(input, bytes);
  try {
    execFileSync(command, [...args, input, output], { stdio: ["ignore", "ignore", "pipe"] });
    return existsSync(output) ? readFileSync(output, "utf8") : null;
  } catch {
    return null;
  } finally {
    for (const path of [input, output]) if (existsSync(path)) rmSync(path);
  }
}

/** The document's own text layer. No optical recognition is attempted. */
export function pdfText(bytes) {
  return runPoppler("pdftotext", bytes, ["-layout"], ".txt");
}

/** The same text with every word's position, which two-column tables need. */
export function pdfWordBoxes(bytes) {
  return runPoppler("pdftotext", bytes, ["-bbox-layout"], ".html");
}

/**
 * What a document's text layer actually yielded.
 *
 * The character count is kept even when it is zero, because "this document
 * produced twenty-six characters of page separators" is the fact that stops a
 * later reader from assuming the document was read and quietly reporting
 * nothing from it.
 */
function extractionResult(text, { attempted }) {
  if (!attempted) {
    return { state: "not_attempted", characters: 0, quality_state: null, reasons: [], ocr_attempted: false };
  }
  const value = String(text ?? "");
  const measured = measureExtractionQuality(value);
  const usable = value.trim().length;
  return {
    state: usable > 0 && measured.quality_state !== "low" ? "extracted" : "not_extracted",
    characters: usable,
    quality_state: measured.quality_state,
    reasons: measured.reasons,
    ocr_attempted: false,
  };
}

function registerRequests(boardId, root = ROOT) {
  const path = join(root, "site/data/community_board_budget_register", `${boardId}.json`);
  if (!existsSync(path)) throw new Error(`no retained budget register document for ${boardId}`);
  const document = JSON.parse(readFileSync(path, "utf8"));
  return (document.requests || []).map((request) => {
    const latest = (request.versions || []).filter((version) => version.servable).at(-1) || {};
    return {
      tracking_code: request.tracking_code,
      fiscal_year: request.fiscal_year,
      request_class: request.request_class,
      agency_label: latest.responsible_agency?.source_label || null,
      rank_value: latest.rank?.value || null,
      responses: Object.fromEntries((request.versions || [])
        .filter((version) => version.servable && version.response)
        .map((version) => [version.publication, version.response])),
    };
  });
}

export async function acquireBoard(plan, context = acquisitionContext()) {
  const observedAt = context.now().toISOString();
  const requests = registerRequests(plan.board_id);
  const failures = [];

  const meeting = await fetchDocument(plan.hearing.source_url, context);
  if (!meeting.ok) throw new Error(`hearing page could not be read: ${meeting.error}`);
  const meetingHtml = meeting.bytes.toString("utf8");
  const segments = parseHearingAgendaSegments(meetingHtml);
  if (!segments.length) throw new Error("the hearing page carries no agenda this reading can parse");
  const participation = parseHearingParticipation(meetingHtml, plan.hearing.source_url);

  const indexes = new Map();
  for (const [name, url] of Object.entries(plan.previous_cycle.index_urls)) {
    const page = await fetchDocument(url, context);
    if (!page.ok) throw new Error(`index page ${url} could not be read: ${page.error}`);
    indexes.set(name, { url, addresses: linkedAddresses(page.bytes.toString("utf8"), url), receipt: page.receipt });
  }

  const documents = [];
  let statementPassages = [];
  const registerResponses = [];
  let ratifiedResolution = null;

  for (const planned of plan.previous_cycle.documents) {
    const index = indexes.get(planned.index);
    const url = index.addresses.find((address) => address.endsWith(planned.pattern)) || null;
    if (!url) {
      // The publisher no longer links this document where it was found. Saying
      // so is the honest outcome; keeping the old address would publish a link
      // this run just failed to confirm.
      failures.push({ document_id: planned.id, reason: "not_linked_from_index", index_url: index.url });
      continue;
    }
    const fetched = await fetchDocument(url, context);
    if (!fetched.ok) {
      failures.push({ document_id: planned.id, reason: "fetch_failed", source_url: url, error: fetched.error });
      continue;
    }
    const isPdf = /pdf/i.test(fetched.receipt.content_type || "") || url.toLowerCase().endsWith(".pdf");
    const text = isPdf ? context.extractText(fetched.bytes) : fetched.bytes.toString("utf8");
    const extraction = extractionResult(text, { attempted: isPdf });

    documents.push({
      id: planned.id,
      kind: planned.kind,
      title: planned.title,
      fiscal_year: plan.previous_cycle.fiscal_year,
      source_url: url,
      index_url: index.url,
      ...(planned.meeting_date ? { meeting_date: planned.meeting_date } : {}),
      receipt: { ...fetched.receipt, observed_at: observedAt },
      extraction,
    });

    if (extraction.state !== "extracted") continue;
    if (planned.reads === "statement_passages") {
      statementPassages = parseNeedsStatementPassages(text);
    } else if (planned.reads === "register_responses") {
      const boxes = context.extractWordBoxes(fetched.bytes);
      for (const row of parseRegisterDocumentResponses(boxes || "")) {
        registerResponses.push({ document_id: planned.id, publication: planned.compares_to_publication || null, ...row });
      }
    } else if (planned.reads === "ratified_resolution") {
      const resolution = parseRatifiedResolution(text);
      if (resolution) ratifiedResolution = { document_id: planned.id, ...resolution };
    }
  }

  const { attached, unattached } = attachStatementPassages({ passages: statementPassages, requests });

  const workedExampleCode = plan.previous_cycle.worked_example.tracking_code;
  if (!attached.some((passage) => passage.tracking_code === workedExampleCode)) {
    throw new Error(`the worked example ${workedExampleCode} has no statement passage tied to it under the identity keys`);
  }

  // The two publishers' renderings of one answer are compared here and both
  // are kept. Only a board document printing a publication the register also
  // retains takes part, because those are the only two renderings that are of
  // the same thing. The comparison neutralizes case, spacing and the
  // publisher's typography, so what is reported as a disagreement is a
  // disagreement in words rather than in typesetting.
  const byCode = new Map(requests.map((request) => [request.tracking_code, request]));
  const compared = registerResponses.filter((row) => row.publication && byCode.get(row.tracking_code)?.responses?.[row.publication]);
  const disagreements = compared
    .filter((row) => (
      hearingComparableText(byCode.get(row.tracking_code).responses[row.publication]) !== hearingComparableText(row.response)
    ))
    .map((row) => ({
      tracking_code: row.tracking_code,
      publication: row.publication,
      board_document_id: row.document_id,
      board_document_response: row.response,
      register_response: byCode.get(row.tracking_code).responses[row.publication],
    }))
    .sort((left, right) => left.tracking_code.localeCompare(right.tracking_code));

  return {
    schema: HEARING_CONTEXT_OBSERVATION_SCHEMA,
    board_id: plan.board_id,
    board_name: plan.board_name,
    publisher: plan.publisher,
    observed_at: observedAt,
    hearing: {
      meeting_date: plan.hearing.meeting_date,
      time_zone: plan.time_zone,
      source_url: plan.hearing.source_url,
      receipt: { ...meeting.receipt, observed_at: observedAt },
      segments,
      participation,
    },
    previous_cycle: {
      fiscal_year: plan.previous_cycle.fiscal_year,
      worked_example_tracking_code: workedExampleCode,
      register_request_count: requests.length,
      documents,
      document_failures: failures,
      statement_passages: attached.sort((left, right) => left.tracking_code.localeCompare(right.tracking_code)),
      statement_passages_unattached: unattached,
      board_document_responses: Object.fromEntries(
        [...new Set(registerResponses.map((row) => row.document_id))]
          .map((id) => [id, registerResponses.filter((row) => row.document_id === id).length]),
      ),
      responses_compared: compared.length,
      response_source_disagreements: disagreements,
      ratified_resolution: ratifiedResolution,
    },
  };
}

function fixturePath(boardId, context) {
  return join(context.directory, `${boardId}.json`);
}

export async function acquireHearingContext(context = acquisitionContext()) {
  const startedAt = context.now().toISOString();
  const written = [];
  try {
    const observations = [];
    for (const plan of HEARING_CONTEXT_PLAN) observations.push(await acquireBoard(plan, context));
    mkdirSync(context.directory, { recursive: true });
    const boards = [];
    for (const observation of observations) {
      const text = serialize(observation);
      writeFileSync(fixturePath(observation.board_id, context), text);
      written.push(observation.board_id);
      boards.push({
        board_id: observation.board_id,
        fixture: `${observation.board_id}.json`,
        sha256: sha256(text),
        observed_at: observation.observed_at,
        hearing_date: observation.hearing.meeting_date,
        segment_count: observation.hearing.segments.length,
        document_count: observation.previous_cycle.documents.length,
      });
    }
    const manifest = {
      schema: HEARING_CONTEXT_FIXTURE_MANIFEST_SCHEMA,
      observed_at: startedAt,
      boards,
    };
    writeFileSync(join(context.directory, "manifest.json"), serialize(manifest));
    const receipt = {
      schema: ACQUISITION_RECEIPT_SCHEMA,
      source_contract_id: "non-council-board-minutes",
      status: "succeeded",
      started_at: startedAt,
      observed_at: startedAt,
      boards: written,
      error: null,
    };
    mkdirSync(dirname(context.receiptPath), { recursive: true });
    writeFileSync(context.receiptPath, serialize(receipt));
    return { manifest, receipt };
  } catch (error) {
    const receipt = {
      schema: ACQUISITION_RECEIPT_SCHEMA,
      source_contract_id: "non-council-board-minutes",
      status: "failed",
      started_at: startedAt,
      observed_at: null,
      boards: written,
      error: hearingClean(error?.message || String(error), 400),
    };
    mkdirSync(dirname(context.receiptPath), { recursive: true });
    writeFileSync(context.receiptPath, serialize(receipt));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifest } = await acquireHearingContext();
  for (const board of manifest.boards) {
    console.log(`${board.board_id}: ${board.segment_count} agenda segment(s), ${board.document_count} document(s)`);
  }
  console.log(`Retained under ${relative(ROOT, FIXTURE_DIRECTORY)}`);
}
