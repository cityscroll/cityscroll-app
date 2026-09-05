/**
 * RU-03 — the rendered resident-copy boundary gate.
 *
 * The gate under test is tools/resident_copy_boundary.mjs. This suite proves
 * the two halves that make it worth having:
 *
 *   Negative controls — rendered states that MUST fail. Chief among them is a
 *   diagnostic section carrying none of the phrases the existing scan knows, so
 *   a green phrase check can no longer be mistaken for a green reader boundary.
 *
 *   Positive controls — rendered states that MUST keep passing. A copy gate
 *   whose easiest fix is deleting a real failure message, an honest zero, a
 *   fiscal-scope caveat, an affiliation line, or a requested outcome that could
 *   not be located is a worse product than no gate at all. Every one of those is
 *   asserted here as something the gate protects, not something it polices.
 *
 * Everything runs against committed fixtures and the real renderers. No network
 * read, no production fetch, and no participant study is involved in any
 * assertion below.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RESIDENT_COPY_BOUNDARY_RULES,
  RESIDENT_RECORD_PROJECTION_BOUND,
  buildResidentCopyBoundaryCorpus,
  checkResidentCopyBoundary,
  formatFinding,
  inspectResidentCopyBoundary,
} from "../tools/resident_copy_boundary.mjs";

import { ABSENCE_REASONS, renderEdgeSummaryRail } from "../site/edge_summary.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import {
  buildCommunityBoardMoneyCardView,
  buildCommunityBoardMoneyReadModel,
  renderCommunityBoardMoneyCard,
} from "../site/community_board_money.mjs";
import { OUTCOME_STATES, renderOutcomeState } from "../site/outcome_not_located_state.mjs";
import {
  followingPersonalIslandHtml,
  followingPersonalIslandProjection,
} from "../site/following_personal_state.mjs";
import { renderNodeFooter } from "../site/civic_document_chrome.mjs";

const REPO = new URL("..", import.meta.url);
const context = { fixture: "unit", file: "site/example.mjs", renderer: "renderExample" };
const rulesFired = (findings) => new Set(findings.map((item) => item.rule));

const boardSources = () => ({
  sourceRegistry: JSON.parse(readFileSync(new URL("site/data/non_council_outcome_sources/source_registry.json", REPO))),
  sourceInventory: JSON.parse(readFileSync(new URL("site/data/non_council_outcome_sources/board_source_inventory.json", REPO))),
  scorecard: JSON.parse(readFileSync(new URL("site/data/community_board_minutes_scorecard.json", REPO))),
  geography: JSON.parse(readFileSync(new URL("site/data/community_board_geography_lookup.json", REPO))),
});

/**
 * The section this product actually shipped, reconstructed from the audit
 * observation that recorded it: 276 rows, rendered by default, outside any
 * disclosure. `heading` varies so the two failure arms can be told apart.
 */
function diagnosticDumpFixture({ heading = "Official documents", rows = 276 } = {}) {
  const items = Array.from({ length: rows }, (_, index) =>
    `<li class="node-record" data-source-record-kind="record"><div class="node-record-main"><strong>Board record ${index + 1}</strong></div>`
    + `<span class="muted node-muted">Community board file · 2026-0${(index % 9) + 1}-1${index % 9} · Official board record</span></li>`).join("");
  return `<!doctype html><html lang="en"><body><main>`
    + `<section class="node-section node-card"><h2>${heading}</h2>`
    + `<ul class="node-record-list">${items}</ul></section></main></body></html>`;
}

// --- A1 -------------------------------------------------------------------
// A rendered diagnostic section fails, including when it carries none of the
// phrases the existing scan looks for.

test("A1: a diagnostic section fails on its heading register, not on any banned phrase", () => {
  const findings = inspectResidentCopyBoundary(
    diagnosticDumpFixture({ heading: "Unjoined source records (diagnostic)", rows: 3 }),
    context,
  );
  assert.ok(rulesFired(findings).has("diagnostic_section_exposed"), `expected the register rule to fire, got ${[...rulesFired(findings)].join(", ") || "nothing"}`);
  // Three rows is well inside the resident bound, so the cardinality rule is
  // silent here: this arm fires on the register alone.
  assert.ok(!rulesFired(findings).has("unbounded_record_projection"));
});

test("A1: a neutrally headed 276-row dump fails the boundary gate while the existing phrase scan stays green", () => {
  const html = diagnosticDumpFixture();
  const findings = inspectResidentCopyBoundary(html, context);
  const unbounded = findings.find((item) => item.rule === "unbounded_record_projection");
  assert.ok(unbounded, "expected the rendered-cardinality rule to fail this fixture");
  assert.match(unbounded.detail, /276 records/);
  // Nothing in this fixture is written in the engineering register, so the gate
  // is failing it on structure alone.
  assert.ok(!rulesFired(findings).has("diagnostic_section_exposed"));

  // The claim this card exists to make: the same markup passes the phrase gate.
  // Run the real check against the real fixture rather than asserting it from
  // memory of what its patterns contain.
  const dir = mkdtempSync(join(tmpdir(), "cs-ru03-boundary-"));
  try {
    writeFileSync(join(dir, "fixture.html"), html, "utf8");
    const output = execFileSync("python3", [
      "test/standards/no_disclaimer_slop.py", "--root", dir, "--mode", "block",
    ], { cwd: fileURLToPath(REPO), encoding: "utf8" });
    assert.match(output, /0 finding\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1: a disclosure is not a hiding place, and bounded provenance inside one stays legal", () => {
  const hidden = `<details><summary>Unjoined source records (diagnostic)</summary><ul><li class="node-record">Row</li></ul></details>`;
  assert.ok(rulesFired(inspectResidentCopyBoundary(hidden, context)).has("diagnostic_section_exposed"));

  const legitimate = `<details class="community-board-money-provenance"><summary>Sources and coverage</summary>`
    + `<div><ul><li><a href="https://www.checkbooknyc.com/">Checkbook NYC</a> · FY2026</li></ul>`
    + `<p>This card reports funds budgeted to and payments posted by this Community Board.</p></div></details>`;
  assert.deepEqual(inspectResidentCopyBoundary(legitimate, context), []);
});

test("A1: the shipped Community Board document renders neither failure", () => {
  const html = renderCommunityBoardConstellationDocument(
    buildCommunityBoardConstellationView("manhattan-cb-03", boardSources()),
  );
  const findings = inspectResidentCopyBoundary(html, {
    fixture: "manhattan-cb-03", file: "site/community_board_constellation.mjs", renderer: "renderCommunityBoardConstellationDocument",
  });
  assert.deepEqual(findings, [], findings.map(formatFinding).join("\n\n"));
});

// --- A2 -------------------------------------------------------------------
// Raw dynamic values fail in every channel a resident can reach them through;
// real records, honest zeros and named sources keep passing.

test("A2: a raw enum or field fallback in rendered text fails", () => {
  for (const leak of ["retrieval_failure", "identity_unobserved", "not_yet_ingested", "undefined", "[object Object]", "COVERAGE_STATUS"]) {
    const findings = inspectResidentCopyBoundary(`<p class="node-muted">Source status: ${leak}</p>`, context);
    assert.ok(
      rulesFired(findings).has("raw_dynamic_fallback"),
      `expected ${JSON.stringify(leak)} to fail as a raw dynamic value`,
    );
  }
});

test("A2: the machine channel keeps carrying the reason RU-02 put there", () => {
  // RU-02's whole design is a plain-language sentence for the reader with the
  // machine reason retained in a non-visible attribute. A gate that cannot tell
  // those apart would force the reason out of the data model, so this asserts
  // the exemption directly.
  const html = `<p data-source-absence-reason="retrieval_failure" data-edge-state="unknown">This source could not be checked automatically.</p>`;
  assert.deepEqual(inspectResidentCopyBoundary(html, context), []);
});

test("A2: an accessible name is held to the same words as the visible label", () => {
  const leaked = `<ul><li class="edge-summary-item" data-edge-state="unknown">`
    + `<span aria-label="Related meetings; retrieval_failure"><span>Full Board</span><span>Related meetings · Could not be checked from the current source</span></span></li></ul>`;
  const findings = inspectResidentCopyBoundary(leaked, context);
  assert.ok(rulesFired(findings).has("accessible_name_leakage"));
  assert.match(findings.find((item) => item.rule === "accessible_name_leakage").detail, /announces the machine value/);
});

test("A2: neither channel may be the only carrier of a consequential state", () => {
  const mutedForScreenReaders = `<p data-money-state="unmatched_identity" aria-hidden="true">The source has no accepted payment identity for this board.</p>`;
  assert.ok(rulesFired(inspectResidentCopyBoundary(mutedForScreenReaders, context)).has("single_channel_state"));

  const spokenOnly = `<p data-outcome-state="not_located" aria-label="No published record of this decision was found">See the meeting page</p>`;
  assert.ok(rulesFired(inspectResidentCopyBoundary(spokenOnly, context)).has("single_channel_state"));
});

test("A2: matched records, a valid zero and a named source link all pass", () => {
  const matched = renderEdgeSummaryRail([
    { edge_type: "hosts_meeting", target_kind: "meeting", state: "matched", count: 3, canonical_href: "/meetings/full-board", target_name: "Full Board" },
  ], { heading: "Connected records" });
  assert.match(matched, /Available: 3 records/);
  assert.deepEqual(inspectResidentCopyBoundary(matched, context), []);

  const zeroModel = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "valid-zero-board" }],
    adoptedBudget: null,
    paymentActuals: {
      schema: "cityscroll.community_board_payment_actuals.v1",
      generated_at: "2026-08-27T00:00:00Z",
      source: { source_system: "checkbook_payment_population", endpoint: "https://www.checkbooknyc.com/api" },
      fiscal_years: [2026],
      rows: [{ board_id: "valid-zero-board", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "empty_source_result" }],
    },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  const zeroCard = buildCommunityBoardMoneyCardView(zeroModel, "valid-zero-board");
  const zeroHtml = renderCommunityBoardMoneyCard(zeroCard);
  assert.equal(zeroCard.absence_reason, ABSENCE_REASONS.VALID_ZERO);
  assert.match(zeroHtml, /No posted payments were returned for this board in the checked source/);
  assert.deepEqual(inspectResidentCopyBoundary(zeroHtml, context), []);

  const namedSource = `<p class="edge-summary-source"><a href="https://www.checkbooknyc.com/" rel="noopener noreferrer">Checkbook NYC</a></p>`;
  assert.deepEqual(inspectResidentCopyBoundary(namedSource, context), []);
});

// --- A3 -------------------------------------------------------------------
// Retained positive controls. Each asserts the copy is still rendered AND that
// the gate does not object to it.

test("A3: a failed read keeps its message and an actionable recovery", () => {
  for (const state of ["unavailable", "error"]) {
    const projection = followingPersonalIslandProjection(state);
    assert.equal(projection.recovery.kind, "retry");
    const html = followingPersonalIslandHtml(state);
    assert.match(html, /Try again/);
    assert.deepEqual(inspectResidentCopyBoundary(html, { ...context, file: "site/following_personal_state.mjs", renderer: "followingPersonalIslandHtml" }), []);
  }
});

test("A3: incompatible fiscal years stay beside the figures", () => {
  const model = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "fiscal-scope-board" }],
    adoptedBudget: {
      schema: "cityscroll.community_board_adopted_budget.v1",
      generated_at: "2026-08-27T00:00:00Z",
      source: { source_system: "expense_budget", pinned_slice: { fiscal_year: 2026 } },
      coverage: { accepted_board_facts: 1 },
      rows: [{ board_id: "fiscal-scope-board", fiscal_year: 2027, adopted_amount: 100000 }],
    },
    paymentActuals: {
      schema: "cityscroll.community_board_payment_actuals.v1",
      generated_at: "2026-08-27T00:00:00Z",
      source: { source_system: "checkbook_payment_population", endpoint: "https://www.checkbooknyc.com/api" },
      fiscal_years: [2026],
      rows: [{ board_id: "fiscal-scope-board", fiscal_year: 2026, posted_payment_amount: 5000, payment_count: 2, distinct_payee_count: 1, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "posted_through_source_vintage" }],
    },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  const card = buildCommunityBoardMoneyCardView(model, "fiscal-scope-board");
  assert.equal(card.state, "separate_fiscal_years");
  const html = renderCommunityBoardMoneyCard(card);
  assert.match(html, /different fiscal years and are shown separately/);
  assert.match(html, /FY2027/);
  assert.match(html, /FY2026/);
  assert.deepEqual(inspectResidentCopyBoundary(html, { ...context, file: "site/community_board_money.mjs", renderer: "renderCommunityBoardMoneyCard" }), []);
});

test("A3: affiliation and privacy copy are protected, not policed", () => {
  const footer = renderNodeFooter();
  assert.match(footer, /CityScroll is an unofficial reading aid\./);
  assert.deepEqual(inspectResidentCopyBoundary(footer, { ...context, file: "site/civic_document_chrome.mjs", renderer: "renderNodeFooter" }), []);

  const privacy = `<p class="inv-footer-note">Sharing uploads a read-only snapshot (90-day link). Nothing else ever leaves this browser.</p>`;
  assert.deepEqual(inspectResidentCopyBoundary(privacy, context), []);
});

test("A3: a requested outcome that could not be located keeps its own state and next action", () => {
  const payload = { schema: "cityscroll.non_council_outcome_lookup.v1", generated_at: "2026-08-27T00:00:00Z", coverage: { scope: "community board records" }, rows: [] };
  const notice = { request_id: "ru03-fixture-request", event_date: "2026-05-14", start_date: "2026-05-01", body_id: "manhattan-cb-03" };
  const html = renderOutcomeState(payload, notice.request_id, notice, { lang: "en" });
  assert.match(html, new RegExp(`data-outcome-state="${OUTCOME_STATES.NOT_LOCATED}"`));
  assert.match(html, /Outcome not found/);
  // It stays distinct from a sourced "the body took no action" record.
  assert.doesNotMatch(html, /Recorded: no action taken/);
  // And it offers the one follow-up the product can actually deliver.
  assert.match(html, /Follow this community board|Next step/i);
  assert.deepEqual(inspectResidentCopyBoundary(html, { ...context, file: "site/outcome_not_located_state.mjs", renderer: "renderOutcomeState" }), []);
});

// --- A4 -------------------------------------------------------------------
// Diagnostics an implementer can act on, run from the seam that already exists,
// with no way to wave a finding through.

test("A4: every finding names the offending file and the owning renderer", () => {
  const [item] = inspectResidentCopyBoundary(diagnosticDumpFixture(), {
    fixture: "community-board-document:manhattan-cb-03",
    file: "site/community_board_constellation.mjs",
    renderer: "renderCommunityBoardConstellationDocument",
    state: "partial",
  });
  assert.equal(item.file, "site/community_board_constellation.mjs");
  assert.equal(item.renderer, "renderCommunityBoardConstellationDocument");
  const rendered = formatFinding(item);
  assert.match(rendered, /site\/community_board_constellation\.mjs/);
  assert.match(rendered, /renderer: renderCommunityBoardConstellationDocument\(\)/);
  assert.match(rendered, /fixture: community-board-document:manhattan-cb-03 \(state=partial\)/);
  assert.match(rendered, /fix: /);
});

test("A4: there is no allowlist escape", () => {
  const html = diagnosticDumpFixture({ heading: "Unjoined source records (diagnostic)", rows: 3 });
  const baseline = inspectResidentCopyBoundary(html, context);
  assert.ok(baseline.length);
  // Options that look like an escape hatch in neighbouring gates are inert here.
  for (const escape of [
    { allowlist: ["diagnostic_section_exposed"] },
    { allowlist_file: "test/standards/no_disclaimer_slop_allowlist.txt" },
    { ignore: true, mode: "warn" },
  ]) {
    assert.deepEqual(
      inspectResidentCopyBoundary(html, { ...context, ...escape }).map((item) => item.rule),
      baseline.map((item) => item.rule),
      "an allowlist-shaped option must not suppress a finding",
    );
  }
  // And no rule carries a per-copy exception list of its own.
  for (const rule of RESIDENT_COPY_BOUNDARY_RULES) {
    assert.ok(!Object.hasOwn(rule, "allowlist"), `${rule.id} must not own an allowlist`);
  }
});

test("A4: the gate runs from the existing preflight seam", () => {
  const preflight = readFileSync(new URL("tools/preflight-required-checks.sh", REPO), "utf8");
  assert.match(preflight, /node tools\/resident_copy_boundary\.mjs --check/);
  // It sits with the plain-language gate it extends, not in a new lane.
  const plainLanguage = preflight.indexOf("no_disclaimer_slop.py");
  const boundary = preflight.indexOf("resident_copy_boundary.mjs");
  assert.ok(plainLanguage !== -1 && boundary > plainLanguage);
});

// --- A5 -------------------------------------------------------------------
// Bounded fixtures across sparse, partial and error states, plus translated
// labels and locale fallback. Nothing here reads the network.

test("A5: the corpus covers sparse, partial and error states and passes as shipped", () => {
  const fixtures = buildResidentCopyBoundaryCorpus();
  assert.ok(fixtures.length >= 12, `expected a bounded but real corpus, got ${fixtures.length}`);
  assert.deepEqual([...new Set(fixtures.map((fixture) => fixture.state))].sort(), ["error", "partial", "sparse"]);
  for (const fixture of fixtures) {
    assert.ok(fixture.file.startsWith("site/"), `${fixture.id} must name its owning file`);
    assert.ok(fixture.renderer, `${fixture.id} must name its owning renderer`);
  }
  const findings = checkResidentCopyBoundary(fixtures);
  assert.deepEqual(findings, [], findings.map(formatFinding).join("\n\n"));
});

test("A5: a translated locale renders translated copy and a locale without a dictionary falls back to English", () => {
  const payload = { schema: "cityscroll.non_council_outcome_lookup.v1", generated_at: "2026-08-27T00:00:00Z", coverage: { scope: "community board records" }, rows: [] };
  const notice = { request_id: "ru03-fixture-request", event_date: "2026-05-14", start_date: "2026-05-01", body_id: "manhattan-cb-03" };

  const french = renderOutcomeState(payload, notice.request_id, notice, { lang: "fr" });
  assert.match(french, /Résultat introuvable/);
  assert.deepEqual(inspectResidentCopyBoundary(french, { ...context, locale: "fr" }), []);

  // A locale this renderer has no dictionary for takes the English fallback
  // arm. Falling back to a real sentence is correct and must stay passing; only
  // falling back to the key itself is a failure.
  const fallback = renderOutcomeState(payload, notice.request_id, notice, { lang: "de" });
  assert.match(fallback, /Outcome not found/);
  assert.deepEqual(inspectResidentCopyBoundary(fallback, { ...context, locale: "de" }), []);
});

test("A5: a dynamic label that falls through to its raw key fails", () => {
  // localizedT()'s chain is `values[key] || STRINGS.en[key] || key`. The first
  // two arms are exercised against the real renderer above; this fixture is the
  // third arm's output, which no dictionary in the tree currently produces.
  const leaked = `<section data-outcome-state="not_located" aria-label="onl_not_located_heading">`
    + `<div class="chain-h">onl_not_located_heading</div></section>`;
  const findings = inspectResidentCopyBoundary(leaked, { ...context, locale: "ko" });
  assert.ok(rulesFired(findings).has("untranslated_dynamic_label"));
  assert.equal(findings.find((item) => item.rule === "untranslated_dynamic_label").locale, "ko");

  // Every shipping locale the renderer knows resolves all of its keys today.
  for (const lang of ["en", "es", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur", "zh-Hans"]) {
    const html = renderOutcomeState(
      { schema: "cityscroll.non_council_outcome_lookup.v1", generated_at: "2026-08-27T00:00:00Z", coverage: {}, rows: [] },
      "ru03-fixture-request",
      { request_id: "ru03-fixture-request", event_date: "2026-05-14", body_id: "manhattan-cb-03" },
      { lang },
    );
    const findings = inspectResidentCopyBoundary(html, { ...context, locale: lang });
    assert.deepEqual(findings, [], `${lang}: ${findings.map(formatFinding).join("\n")}`);
  }
});

test("A5: RU-02's absence distinctions survive the gate unflattened", () => {
  // The gate must not become a reason to collapse these back into one caveat.
  const rendered = [
    { state: "empty", target_kind: "meeting" },
    { state: "empty", target_kind: "meeting", absence_reason: ABSENCE_REASONS.RECORDED_NEGATIVE },
    { state: "unknown", absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE },
    { state: "unknown", absence_reason: ABSENCE_REASONS.UNSEARCHED },
    { state: "unknown" },
  ].map((record) => renderEdgeSummaryRail([{ edge_type: "hosts_meeting", ...record }], { heading: "Connected records" }));

  for (const html of rendered) {
    assert.deepEqual(inspectResidentCopyBoundary(html, context), []);
  }
  const visible = rendered.map((html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  assert.equal(new Set(visible).size, visible.length, "each absence reason must keep its own rendered copy");
});
