/**
 * Contracts for the public guide at /guide/.
 *
 * These cover the properties a reader depends on and a rebuild could quietly
 * break: the four reader-facing sections and what they link to, the review date
 * being a recorded editorial fact rather than a build artefact, and an article
 * staying readable without script, without images, and without asking the reader
 * to know the words the implementation uses for things.
 *
 * The explanation and reference pages add two of their own: an explanation stands
 * without a tutorial behind it, and the one inventory a reference page shows is
 * derived from the source registry rather than typed, so it cannot drift away from
 * what the site reads.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GUIDE_GROUPS, GuideSourceError, escapeHtml, parseGuideArticle, parseGuideHome } from "../site/guide_article_source.mjs";
import { GuideSourceCoverageError, guideSourceCoverageTable } from "../site/guide_source_coverage.mjs";
import { renderGuideArticle, renderGuideHome } from "../site/guide_view.mjs";
import { internalLinkFailures, loadGuide, renderGuideDocuments } from "../tools/build_guide_documents.mjs";

const { home, articles } = loadGuide();
const documents = renderGuideDocuments();
const homeHtml = readFileSync(new URL("../site/guide/index.html", import.meta.url), "utf8");
const tutorial = articles.find((article) => article.id === "T1");
const tutorialHtml = readFileSync(
  new URL("../site/guide/start/explore-housing-across-city-records/index.html", import.meta.url),
  "utf8",
);

function textOf(html) {
  // Restore the entities an author actually wrote, so a contract can be stated in
  // the words on the page rather than in their escaped form.
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
}

/* ------------------------------------------------------- the guide home */

test("the guide home offers the four reader-facing sections in order", () => {
  const headings = [...homeHtml.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1].trim());
  const groupLabels = GUIDE_GROUPS.map((group) => group.label);
  assert.deepEqual(headings.filter((heading) => groupLabels.includes(heading)), groupLabels);
  assert.deepEqual(groupLabels, ["Start here", "How to…", "Understand", "Reference"]);
});

test("the guide home links every published article", () => {
  for (const article of articles) {
    assert.ok(homeHtml.includes(`href="${article.url}"`), `home does not link ${article.id}`);
    assert.ok(homeHtml.includes(escapeHtml(article.title)), `home does not name ${article.id}`);
  }
});

test("a section with nothing in it yet says so, and does not read like a failure", () => {
  // Every section now holds an article, so the empty state can no longer be
  // reached from the real set. It is still a state the renderer can produce —
  // the next section someone opens starts empty — so it is rendered here from a
  // deliberately narrowed set rather than left uncovered.
  const startOnly = articles.filter((article) => article.type === "tutorial");
  assert.ok(startOnly.length, "the fixture needs at least one tutorial to keep one section filled");
  const text = textOf(renderGuideHome(home, startOnly));
  assert.match(text, /Articles for this section are being written/);
  for (const phrase of ["error", "unavailable", "failed", "try again"]) {
    assert.ok(!text.toLowerCase().includes(phrase), `empty-section copy suggests a failure: ${phrase}`);
  }
});

test("every internal link on a published guide page resolves", () => {
  const named = [...documents].map(([path, html]) => [path, html]);
  assert.deepEqual(internalLinkFailures(named, articles), []);
});

test("the guide home says which language it is published in", () => {
  assert.match(textOf(homeHtml), /published in English first/);
});

/* ------------------------------------------------------- the first tutorial */

test("the tutorial shows its type, purpose, reader question, review date and a way back to the task", () => {
  assert.equal(tutorial.group.label, "Start here");
  const text = textOf(tutorialHtml);
  assert.match(text, /Start here · Tutorial/);
  assert.ok(text.includes(tutorial.purpose));
  assert.ok(text.includes(tutorial.reader_question));
  assert.match(text, new RegExp(`Last reviewed ${tutorial.last_reviewed}`));
  assert.ok(tutorialHtml.includes(`href="${tutorial.return_to_task.href}"`));
  assert.ok(tutorialHtml.includes('href="/guide/"'), "an article must link back to the guide home");
  for (const source of tutorial.sources) assert.ok(tutorialHtml.includes(`href="${source.href}"`));
});

test("no guide page prints a field name the implementation uses", () => {
  // The resident-surface catalog treats a snake_case token in rendered reader
  // copy as an implementation-schema leak, and the guide's own rule is the same:
  // a reader should never need to know what the code calls a thing. Naming a
  // query parameter in prose broke this once, so it is checked for every page
  // rather than for a list of words someone remembered.
  const snakeCase = /\b[a-z]+(?:_[a-z0-9]+)+\b/g;
  for (const [path, html] of documents) {
    const leaked = [...new Set(textOf(html).match(snakeCase) || [])];
    assert.deepEqual(leaked, [], `${path} prints implementation field name(s): ${leaked.join(", ")}`);
  }
});

/**
 * Words this codebase uses for things a reader has a plainer word for. "snapshot"
 * was on this list and is deliberately not: a reference page uses it in its
 * ordinary English sense ("not a snapshot of what this site knew then"), which is
 * exactly the writing the guide wants. The test is for implementation identifiers
 * leaking into prose, not for banning a normal word.
 */
const INTERNAL_VOCABULARY = [
  "lens", "entity_refs", "capability spine", "facet", "handoff", "projection",
  "materializ", "read model", "schema", "endpoint", "payload",
];

test("the tutorial teaches without the words the implementation uses for things", () => {
  const text = textOf(tutorialHtml).toLowerCase();
  for (const term of INTERNAL_VOCABULARY) {
    assert.ok(!text.includes(term), `tutorial uses internal vocabulary: ${term}`);
  }
});

test("the tutorial promises observable checkpoints, never a fixed number of results", () => {
  const text = textOf(tutorialHtml);
  assert.ok(text.split("Checkpoint").length - 1 >= 5, "a tutorial this long needs checkpoints throughout");
  const counted = text.match(/\b\d[\d,]*\s+(results?|matches|records)\b/i);
  assert.equal(counted, null, `tutorial promises a live count: ${counted && counted[0]}`);
  assert.match(text, /your numbers will\s+not match anyone else's|Read the shape,\s+not the totals/);
});

test("the tutorial says where the product itself needs script", () => {
  assert.match(textOf(tutorialHtml), /needs JavaScript switched on/);
});

/* ------------------------------------------------------- the how-to guides */

const howTos = articles.filter((article) => article.type === "how-to");
const howToHtml = new Map(howTos.map((article) => [
  article.id,
  readFileSync(new URL(`../site${article.url}index.html`, import.meta.url), "utf8"),
]));

/** Split an article body into its `## ` sections, in order, as plain text. */
function sections(article) {
  const parts = article.bodyHtml.split(/<h2>/).slice(1);
  return parts.map((part) => {
    const heading = part.slice(0, part.indexOf("</h2>"));
    const body = part.slice(part.indexOf("</h2>") + 5);
    return { heading: textOf(heading).trim(), body, text: textOf(body).trim() };
  });
}

/**
 * The five articles written against the everyday-tasks acceptance criteria. Some
 * contracts below are house rules every how-to keeps; a few are specific to what
 * this set was commissioned to prove, and those say so where they are scoped.
 */
const EVERYDAY_TASK_IDS = ["H1", "H2", "H3", "H4", "H5"];
const everydayTasks = howTos.filter((article) => EVERYDAY_TASK_IDS.includes(article.id));

test("the everyday-task how-tos are published and addressed as how-to guides", () => {
  assert.deepEqual(everydayTasks.map((article) => article.id), EVERYDAY_TASK_IDS);
  for (const article of howTos) {
    assert.equal(article.group.label, "How to…");
    assert.match(article.url, /^\/guide\/how-to\/[a-z0-9-]+\/$/);
  }
});

// A how-to opens by saying what it is for, in one of these forms, and never with a
// step. Both spellings are in use; a third would be a decision, not a typo.
const OPENING_HEADINGS = ["Your task", "What this is for"];

test("every how-to opens with the task, its prerequisites and a real product entry link", () => {
  for (const article of howTos) {
    const parts = sections(article);
    const [task, prerequisites] = parts;
    assert.ok(
      OPENING_HEADINGS.includes(task.heading),
      `${article.id} opens with ${JSON.stringify(task.heading)} rather than saying what it is for`,
    );
    assert.ok(task.text.length > 80, `${article.id} states its task too thinly`);
    assert.equal(prerequisites.heading, "Before you start", `${article.id} does not state prerequisites second`);
    // The place the reader starts has to be reachable from the opening, not found
    // at the end. Some articles name it among the prerequisites and some at the
    // first step, which is the same promise made one section later.
    const opening = parts.slice(0, 3).map((part) => part.body).join("");
    const entries = [...opening.matchAll(/href="(\/[^"#?]*)/g)]
      .map((match) => match[1])
      .filter((href) => !href.startsWith("/guide/"));
    assert.ok(entries.length, `${article.id} names no product entry point in its opening`);
  }
});

test("every how-to ends on a state the reader can observe, with checkpoints on the way", () => {
  for (const article of howTos) {
    const parts = sections(article);
    const last = parts[parts.length - 1];
    // The last section either states the state the reader can check, or hands them
    // the same method to use on a record of their own. Either way the article ends
    // on the reader rather than in the middle of a procedure.
    assert.match(
      last.heading,
      /^(You are done when|Do this\b)/,
      `${article.id} ends on ${JSON.stringify(last.heading)} rather than on the reader`,
    );
    assert.ok(last.text.length > 80, `${article.id} ends too thinly to be checkable`);
    const checkpoints = (howToHtml.get(article.id).match(/class="guide-checkpoint"/g) || []).length;
    assert.ok(checkpoints >= 3, `${article.id} has ${checkpoints} checkpoints`);
  }
});

test("every how-to says what to do when there is nothing, or the answer is unknown", () => {
  for (const article of howTos) {
    const absence = sections(article).find((part) => /^When /.test(part.heading));
    assert.ok(absence, `${article.id} has no section for the empty or unknown case`);
    assert.ok(absence.text.length > 200, `${article.id} treats absence too briefly`);
  }
});

test("every how-to separates a source that could not be read from one with nothing in it", () => {
  // The two look identical on screen and mean opposite things: one is a finding
  // about the city, the other is a finding about today's network. An article that
  // conflated them would teach a reader to draw a conclusion from an outage.
  const unreadable = [
    /could not be reached/i,
    /could not (be )?check(ed)?/i,
    /(was )?not checked/i,
    /not ready/i,
    /not available/i,
  ];
  // Scoped to this set. Whether a how-to has an unreadable-source state to describe
  // depends on its subject: a connection that carries no source document is plain
  // absence, and writing a retry into that article would describe a state it does
  // not have.
  for (const article of everydayTasks) {
    const text = textOf(howToHtml.get(article.id));
    assert.ok(
      unreadable.some((pattern) => pattern.test(text)),
      `${article.id} never distinguishes an unreadable source from an empty one`,
    );
    assert.match(text, /unknown|reload|try it again|retry/i);
  }
});

test("no how-to invents a control, a submission channel, or a promised outcome", () => {
  // Every one of these describes something the product does not do. A guide that
  // said any of them would send a reader looking for a button that is not there,
  // or promise a decision CityScroll has no part in.
  const forbidden = [
    /submit (your |a )?(testimony|comment|objection|application)[^.]{0,30}(here|through CityScroll|on this page)/i,
    /CityScroll (will|can) (file|submit|send|deliver) (your|a) /i,
    /apply (here|through CityScroll|on this page)/i,
    /(guarantee|guarantees|ensures) that (the|your)/i,
    /(we|CityScroll) will (decide|approve|reject)/i,
  ];
  for (const article of howTos) {
    const text = textOf(howToHtml.get(article.id));
    for (const pattern of forbidden) {
      assert.equal(pattern.exec(text), null, `${article.id} matches ${pattern}`);
    }
  }
});

test("every tutorial and how-to teaches without the words the implementation uses", () => {
  // Scoped to the articles that walk a resident through a task. A reference page
  // is excluded on purpose: part of its subject is the machine surface, so
  // "endpoint" there is the correct word for the thing it is pointing at, not
  // implementation vocabulary leaking into resident prose.
  const taught = articles.filter((article) => ["tutorial", "how-to"].includes(article.type));
  assert.ok(taught.length >= 6, "this contract covers the articles that teach a task");
  for (const article of taught) {
    const text = textOf(readFileSync(
      new URL(`../site${article.url}index.html`, import.meta.url), "utf8",
    )).toLowerCase();
    for (const term of INTERNAL_VOCABULARY) {
      assert.ok(!text.includes(term), `${article.id} uses internal vocabulary: ${term}`);
    }
  }
});

/* ----- H2: enrolment is one step, and a preview is not a subscription (A2) */

test("following a search is described as the one-step enrolment it is", () => {
  const text = textOf(howToHtml.get("H2"));
  assert.match(text, /no confirmation email to click/);
  assert.match(text, /The watch exists as soon as you submit it/);
  // A confirmation step would be a different product. Saying there is one, in any
  // of the ways a writer reaches for, would send a reader waiting for an email
  // that never comes.
  for (const pattern of [
    /confirm your (watch|subscription|email)/i,
    /click the link in (the|your) email to (confirm|activate)/i,
    /(until|before) you confirm/i,
  ]) {
    assert.equal(pattern.exec(text), null, `H2 describes a confirmation step: ${pattern}`);
  }
});

test("a preview is never described as a subscription, and no account rules are borrowed", () => {
  const text = textOf(howToHtml.get("H2"));
  assert.match(text, /It is not a subscription, nothing has been saved/);
  for (const pattern of [
    /preview (is|becomes|counts as|acts as) (a|an|your) (watch|subscription)/i,
    /previewing (creates|starts|saves)/i,
  ]) {
    assert.equal(pattern.exec(text), null, `H2 equates a preview with a subscription: ${pattern}`);
  }
  assert.match(text, /not the city's own account system/);
  for (const pattern of [
    /(enter|create|reset|choose) (your |a )?password/i,
    /\bsign in\b/i,
    /\blog in\b/i,
    /\byour account\b/i,
  ]) {
    assert.equal(pattern.exec(text), null, `H2 imports account rules: ${pattern}`);
  }
});

test("the manage pages are described with the two states a reader actually meets", () => {
  const text = textOf(howToHtml.get("H2"));
  assert.match(text, /open a\s+CityScroll email to see its watches/);
  assert.match(text, /invalid or has expired/);
  assert.match(text, /applies to the next digest/);
  assert.match(text, /Unsubscribing takes effect immediately/);
});

/* ----- H3: a board keeps its identity, and its coverage is stated honestly (A3) */

test("the Community Board example keeps the board's full borough-qualified identity", () => {
  const text = textOf(howToHtml.get("H3"));
  assert.match(text, /Manhattan Community Board 7/);
  assert.match(text, /numbered 1 to 18 within each borough/);
  assert.match(text, /City Council District 7/);
  assert.match(text, /numbered 1 to 51 across the whole city/);
  // A bare board number is the mistake the article exists to prevent, so every
  // mention of a board has to carry the borough that makes it an identity.
  for (const match of text.matchAll(/Community Board \d+/g)) {
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    assert.match(
      before,
      /(Manhattan|Brooklyn|Queens|Bronx|Staten Island) $/,
      `H3 names a board without its borough: ...${before}${match[0]}`,
    );
  }
});

test("the Community Board watch's coverage is described as it is actually resolved", () => {
  // The watch resolves the board to the community district it covers, selects
  // meetings tied to that district, then keeps the ones carrying the board's own
  // identity — while the link beside it opens the district, which is wider. Both
  // halves have to be on the page or the reader draws the wrong conclusion from
  // whichever one they meet first.
  const text = textOf(howToHtml.get("H3"));
  assert.match(text, /the community district that board covers/);
  assert.match(text, /keeps the ones carrying the board's own identity/);
  assert.match(text, /Coverage depends on that district link/);
  assert.match(text, /a quiet week is therefore not proof/i);
  assert.match(text, /See current matches is not a preview of your email/);
  assert.match(text, /Do not read a meeting in it as one your\s+board convened/);
  for (const pattern of [
    /every (match|meeting) (is|will be) (a|one of)? ?(meeting )?(of|convened|held) by (the|your) board/i,
    /you will receive every meeting/i,
    /all of (the|your) board's meetings/i,
  ]) {
    assert.equal(pattern.exec(text), null, `H3 overclaims board coverage: ${pattern}`);
  }
});

/* ----- H4: no confirmed external subscription, and no invented time (A4) */

test("the calendar guide claims nothing about what an external calendar did", () => {
  const text = textOf(howToHtml.get("H4"));
  assert.match(text, /CityScroll has no way to know what your calendar did with it/);
  assert.match(text, /It cannot confirm that a subscription was added/);
  for (const pattern of [
    /CityScroll (confirms|has confirmed|will confirm|verifies) (that )?(the|your|a) subscription/i,
    /(you|we) will (see|get) confirmation (from|in) (your|the) calendar/i,
    /once (CityScroll )?confirms (your|the) subscription/i,
  ]) {
    assert.equal(pattern.exec(text), null, `H4 claims an external confirmation: ${pattern}`);
  }
});

test("the calendar guide gives a date-only deadline no invented time", () => {
  const text = textOf(howToHtml.get("H4"));
  assert.match(text, /will not invent nine o'clock/);
  assert.match(text, /arrives as an all-day entry rather\s+than an invented hour/);
  // The surest way to check the article invents no time is that it contains none.
  const clock = /\b\d{1,2}:\d{2}\b/.exec(text);
  assert.equal(clock, null, `H4 states a clock time: ${clock && clock[0]}`);
});

test("one event and a continuing subscription stay two different things", () => {
  const text = textOf(howToHtml.get("H4"));
  assert.match(text, /One event is a copy\. It does not change afterwards/);
  assert.match(text, /Importing a downloaded file is not the same thing/);
  assert.match(text, /Only a\s+URL your calendar keeps fetching is a subscription/);
});

/* ----- H5: unknown project facts are stated as unknown (A5) */

test("the land-use guide separates a published date from a calculated window", () => {
  const text = textOf(howToHtml.get("H5"));
  assert.match(text, /calculated from the\s+statutory review windows/);
  assert.match(text, /It is not an appointment/);
  assert.match(text, /can say whether the city published it or CityScroll worked it out/);
});

test("the land-use guide names each way a project fact can be unknown", () => {
  const text = textOf(howToHtml.get("H5"));
  for (const state of [
    /Where this stands is unknown/,
    /No published next opportunity found/,
    /source was not checked/,
    /A document is not here yet/,
    /has not been observed/,
  ]) {
    assert.match(text, state);
  }
  assert.match(text, /An unknown stage is a statement about the evidence, not a claim that\s+nothing is happening/);
});

/* --------------------------------------- the explanations and reference pages */

const understand = articles.filter((article) => article.type === "explanation");
const reference = articles.filter((article) => article.type === "reference");
const htmlFor = (article) => documents.get(
  new URL(`../site${article.url}index.html`, import.meta.url).pathname,
);

test("every explanation and reference page stands on its own", () => {
  assert.ok(understand.length >= 4, "the Understand section is short of its articles");
  assert.ok(reference.length >= 3, "the Reference section is short of its articles");
  for (const article of [...understand, ...reference]) {
    const text = textOf(htmlFor(article));
    // Nothing may make finishing a tutorial a condition of reading the page.
    assert.ok(
      !/(after|once) you (have )?(finish|complet)/i.test(text),
      `${article.id} asks the reader to complete something first`,
    );
    assert.match(text, new RegExp(`Last reviewed ${article.last_reviewed}`));
    assert.ok(text.includes(article.reader_question), `${article.id} does not show its reader question`);
  }
});

test("a reference page is scannable — its terms are laid out in tables", () => {
  for (const article of reference) {
    const html = htmlFor(article);
    const tables = [...html.matchAll(/<table>/g)].length;
    assert.ok(tables >= 2, `${article.id} has ${tables} tables; a lookup page needs its terms laid out`);
    // A scrollable region needs a name and a way in from the keyboard.
    for (const region of html.matchAll(/<div class="guide-table"([^>]*)>/g)) {
      assert.match(region[1], /role="region"/);
      assert.match(region[1], /tabindex="0"/);
      assert.match(region[1], /aria-label="[^"]+"/);
    }
    assert.ok(!/<th(?=[\s>])(?![^>]*scope=)/.test(html), `${article.id} has a header cell with no scope`);
  }
});

test("the explanations keep unknown, closed and unpublished apart from a negative answer", () => {
  const text = understand.map((article) => textOf(htmlFor(article))).join(" ");
  for (const promise of [
    /blank is not a zero/i,
    /closed window is not (a current )?(an )?invitation/i,
    /estimate is not a deadline/i,
    /No published outcome is not a decision/i,
  ]) {
    assert.match(text, promise);
  }
});

test("the reference pages link their owners instead of restating them", () => {
  const controls = reference.find((article) => article.id === "R2");
  const sources = reference.find((article) => article.id === "R3");
  // Machine parameters belong to the API page; source health to the registry.
  assert.ok(htmlFor(controls).includes('href="/api.html"'), "R2 does not point at the API page");
  assert.ok(htmlFor(sources).includes('href="/stats.html"'), "R3 does not point at the stats page");
  assert.ok(
    htmlFor(sources).includes("docs/data-sources.md"),
    "R3 does not link the published source ledger",
  );
});

test("the source inventory a reference page shows is derived, not typed", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../site/data/source_contracts.json", import.meta.url), "utf8"),
  );
  const table = guideSourceCoverageTable(registry);
  const published = registry.contracts.filter(
    (contract) => contract.health_policy.public_visibility === "public",
  );
  assert.ok(table.caption.includes(String(published.length)));
  // Every counted source is accounted for by exactly one row.
  const counted = table.rows.reduce((total, row) => total + Number(row[2]), 0);
  assert.equal(counted, published.length);
  const html = htmlFor(reference.find((article) => article.id === "R3"));
  assert.ok(html.includes(table.caption), "the page does not show the derived table");
  // A number nobody generated is the failure this is guarding against.
  assert.ok(
    !/\b\d{2,} (sources|public sources|contracts)\b/.test(
      textOf(html).replace(table.caption, " "),
    ),
    "the page states a source count of its own beside the derived one",
  );
});

test("a refresh mode with no plain-language meaning stops the build", () => {
  assert.throws(
    () => guideSourceCoverageTable({
      contracts: [{
        id: "invented",
        health_policy: { public_visibility: "public" },
        freshness_contract: { mode: "whenever" },
      }],
    }),
    GuideSourceCoverageError,
  );
  assert.throws(() => guideSourceCoverageTable({ contracts: [] }), GuideSourceCoverageError);
});

test("the first unfamiliar term in the tutorial has somewhere to go", () => {
  const destinations = [...understand, ...reference].map((article) => article.url);
  assert.ok(
    destinations.some((url) => tutorialHtml.includes(`href="${url}"`)),
    "the tutorial sends a reader to no explanation or reference page",
  );
});

/* ------------------------------------------------------- rebuild behaviour */

test("guide documents carry no script and no images", () => {
  for (const [path, html] of documents) {
    assert.ok(!/<script\b/i.test(html), `${path} ships script`);
    assert.ok(!/\son[a-z]+=/i.test(html), `${path} carries an inline event handler`);
    assert.ok(!/<img\b/i.test(html), `${path} ships an image`);
  }
});

test("an unchanged rebuild reproduces the same bytes", () => {
  const again = renderGuideDocuments();
  for (const [path, html] of documents) assert.equal(again.get(path), html);
});

test("every review date on a page was recorded in a source", () => {
  const recorded = new Set([home.last_reviewed, ...articles.map((article) => article.last_reviewed)]);
  for (const [path, html] of documents) {
    const dates = [...html.matchAll(/Last reviewed (\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
    assert.ok(dates.length, `${path} shows no review date`);
    for (const date of dates) {
      assert.ok(recorded.has(date), `${path} shows a review date no source recorded: ${date}`);
    }
  }
});

test("nothing on the guide's build path can read a clock", () => {
  // A rebuild that could ask the system what day it is could move a review date
  // without an editor deciding to. The dates are parsed from the sources, so the
  // modules that produce a guide page have no business holding a clock at all.
  for (const module of ["site/guide_article_source.mjs", "site/guide_view.mjs", "tools/build_guide_documents.mjs"]) {
    const source = readFileSync(new URL(`../${module}`, import.meta.url), "utf8");
    for (const clock of ["new Date", "Date.now", "toISOString", "toLocaleDateString", "hrtime"]) {
      assert.ok(!source.includes(clock), `${module} reads a clock (${clock})`);
    }
  }
});

test("the tracked documents match their sources", () => {
  assert.equal(documents.get(new URL("../site/guide/index.html", import.meta.url).pathname), homeHtml);
});

/* ------------------------------------------------------- source format */

const MINIMAL = `---
id: T9
type: tutorial
title: A short walk
page_title: A short walk · CityScroll
url: /guide/start/a-short-walk/
reader_question: How does this work?
purpose: A very short example.
description: ${"x".repeat(130)}
last_reviewed: 2026-09-05
return_to_task: Go back to the search | /search/
---

## A heading

Some prose.
`;

function withField(source, key, value) {
  return source.replace(new RegExp(`^${key}: .*$`, "m"), value === null ? "" : `${key}: ${value}`);
}

test("an article source is accepted when it carries everything a reader is shown", () => {
  const article = parseGuideArticle("fixture.md", MINIMAL);
  assert.equal(article.group.label, "Start here");
  assert.match(article.bodyHtml, /<h2>A heading<\/h2>/);
  assert.match(article.bodyHtml, /<p>Some prose\.<\/p>/);
});

test("an article without an editorially recorded review date is rejected", () => {
  assert.throws(() => parseGuideArticle("fixture.md", withField(MINIMAL, "last_reviewed", null)), GuideSourceError);
  assert.throws(
    () => parseGuideArticle("fixture.md", withField(MINIMAL, "last_reviewed", "today")),
    /last_reviewed must be an explicit YYYY-MM-DD date/,
  );
});

test("an article is rejected when its type, address or metadata would mislead a reader", () => {
  assert.throws(() => parseGuideArticle("fixture.md", withField(MINIMAL, "type", "essay")), /unknown type/);
  assert.throws(
    () => parseGuideArticle("fixture.md", withField(MINIMAL, "url", "/guide/how-to/a-short-walk/")),
    /url must start with \/guide\/start\//,
  );
  assert.throws(
    () => parseGuideArticle("fixture.md", withField(MINIMAL, "description", "too short")),
    /description must be 120-160 characters/,
  );
  assert.throws(
    () => parseGuideArticle("fixture.md", withField(MINIMAL, "return_to_task", "Go back to the search")),
    /return_to_task must be written as "label \| href"/,
  );
});

test("author text cannot inject markup, and unsupported syntax fails the build", () => {
  const escaped = parseGuideArticle("fixture.md", MINIMAL.replace("Some prose.", "Some <b>prose</b> & more."));
  assert.match(escaped.bodyHtml, /&lt;b&gt;prose&lt;\/b&gt; &amp; more\./);
  assert.throws(
    () => parseGuideArticle("fixture.md", MINIMAL.replace("Some prose.", "*** a rule ***")),
    /unsupported block/,
  );
});

test("a link in prose renders with its label, and an outside link is marked as leaving the site", () => {
  const article = parseGuideArticle(
    "fixture.md",
    MINIMAL.replace("Some prose.", "See [the official record](https://a856-cityrecord.nyc.gov/) and [Browse](/browse/)."),
  );
  assert.match(article.bodyHtml, /<a href="https:\/\/a856-cityrecord\.nyc\.gov\/" target="_blank" rel="noopener noreferrer">the official record<\/a>/);
  assert.match(article.bodyHtml, /<a href="\/browse\/">Browse<\/a>/);
});

test("the guide home source must carry every reader-facing section", () => {
  const source = readFileSync(new URL("../site/guide/_home.md", import.meta.url), "utf8");
  assert.doesNotThrow(() => parseGuideHome("site/guide/_home.md", source));
  assert.throws(
    () => parseGuideHome("fixture.md", source.replace("## Reference", "## Look it up")),
    /missing a "## Reference" section/,
  );
});

test("rendering is a pure function of the parsed sources", () => {
  assert.equal(renderGuideHome(home, articles), renderGuideHome(home, articles));
  assert.equal(renderGuideArticle(tutorial), renderGuideArticle(tutorial));
});

test("a list item wrapped across lines stays one item", () => {
  const article = parseGuideArticle(
    "fixture.md",
    MINIMAL.replace("Some prose.", "- A point that runs\n  onto a second line.\n- A second point."),
  );
  assert.match(article.bodyHtml, /<ul><li>A point that runs onto a second line\.<\/li><li>A second point\.<\/li><\/ul>/);
});

test("a table renders with header cells and a named region, and a malformed one fails", () => {
  const article = parseGuideArticle("fixture.md", MINIMAL.replace(
    "Some prose.",
    "| Term | Meaning |\n| --- | --- |\n| Notice | One published item |",
  ));
  assert.match(article.bodyHtml, /<div class="guide-table" role="region" tabindex="0" aria-label="A heading">/);
  assert.match(article.bodyHtml, /<th scope="col">Term<\/th>/);
  assert.match(article.bodyHtml, /<td>One published item<\/td>/);
  assert.throws(
    () => parseGuideArticle("fixture.md", MINIMAL.replace("Some prose.", "| Term | Meaning |\n| Notice | One |")),
    /a table needs a header row, a --- divider row/,
  );
  assert.throws(
    () => parseGuideArticle("fixture.md", MINIMAL.replace(
      "Some prose.",
      "| Term | Meaning |\n| --- | --- |\n| Notice |",
    )),
    /table row has 1 cells but the header has 2/,
  );
});

test("a table with no heading above it is rejected rather than left unnamed", () => {
  assert.throws(
    () => parseGuideArticle("fixture.md", MINIMAL.replace(
      "## A heading\n\nSome prose.",
      "| Term | Meaning |\n| --- | --- |\n| Notice | One published item |",
    )),
    /a table needs a name/,
  );
});

test("a generated table is placed by name, and an unknown name fails the build", () => {
  const source = MINIMAL.replace("Some prose.", "::: made-up-table");
  assert.throws(() => parseGuideArticle("fixture.md", source), /no owner generates a "made-up-table" table/);
  const article = parseGuideArticle("fixture.md", source, {
    "made-up-table": { caption: "Two things", columns: ["One", "Two"], rows: [["a", "b"]] },
  });
  assert.match(article.bodyHtml, /<caption>Two things<\/caption>/);
  assert.match(article.bodyHtml, /aria-label="Two things"/);
});
