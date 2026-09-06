import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import { GuideSourceError, parseGuideArticle } from "../site/guide_article_source.mjs";
import {
  DEFAULT_REVIEW_INTERVAL_DAYS,
  GUIDE_REVIEW_ARTICLE_SCHEMA,
  GUIDE_REVIEW_FINDING_KINDS,
  GUIDE_REVIEW_JOB_ID,
  GUIDE_REVIEW_SCHEMA,
  buildGuideReviewReport,
  guideReviewArticleRecord,
  guideReviewDelta,
  guideReviewEventId,
  guideReviewLeaks,
  renderGuideReviewSection,
  validateGuideReviewReport,
} from "../site/guide_review_source.mjs";
import { eventId, persistScheduleResult, replayOutbox } from "../tools/external_schedule_outbox.mjs";
import { checkGuideReviewReferences, parseArgs } from "../tools/build_guide_review.mjs";

const ROOT = new URL("../", import.meta.url);
const COMMIT = "b52a5cece59b409af4b809cd58e533abd1d9b6d7";

const DEMO_MANIFEST = {
  entries: [
    { id: "semantic-search-housing", url: "search/?q=housing" },
    { id: "notice-sanitation-connected-mandate", url: "#notice/1" },
    { id: "official-marte-votes", url: "#official/2" },
  ],
};

const SOURCE_CONTRACTS = { contracts: [{ id: "city-record" }, { id: "council-legislation" }] };

const CAPABILITIES = [
  { reference: "search.federated@1" },
  { reference: "notice.get@1" },
];

const JOINS = [
  { id: "search.federated@1::semantic-search-housing", capability_reference: "search.federated@1", demo_id: "semantic-search-housing" },
  { id: "notice.get@1::notice-sanitation-connected-mandate", capability_reference: "notice.get@1", demo_id: "notice-sanitation-connected-mandate" },
];

function article(overrides = {}) {
  return {
    id: "explore-housing",
    type: "tutorial",
    url: "/guide/start-here/explore-housing/",
    title: "Explore housing across city records",
    published: "2026-09-01",
    updated: "2026-09-01",
    last_reviewed: "2026-09-01",
    demos: ["semantic-search-housing"],
    historical_demos: [],
    capabilities: ["search.federated@1"],
    source_contracts: ["city-record"],
    depends_on: ["site/search_document.mjs"],
    ...overrides,
  };
}

function report(overrides = {}) {
  return buildGuideReviewReport({
    articles: [article()],
    demoManifest: DEMO_MANIFEST,
    capabilities: CAPABILITIES,
    sourceContracts: SOURCE_CONTRACTS,
    joins: JOINS,
    checkedAt: "2026-09-05",
    observedCommit: COMMIT,
    runKey: "2026-W36",
    ...overrides,
  });
}

function kinds(built, kind) {
  return built.findings.filter((item) => item.kind === kind);
}

test("an article record carries the public review metadata and nothing else", () => {
  const record = guideReviewArticleRecord(article({ historical_demos: ["semantic-search-housing"] }));
  assert.equal(record.schema, GUIDE_REVIEW_ARTICLE_SCHEMA);
  assert.deepEqual(Object.keys(record).sort(), [
    "capabilities", "demos", "depends_on", "historical_demos", "id", "last_reviewed",
    "published", "schema", "source_contracts", "title", "type", "updated", "url",
  ]);
  assert.equal(record.last_reviewed, "2026-09-01");
  assert.deepEqual(record.demos, ["semantic-search-housing"]);
});

test("a private field has no key in an article record to arrive under", () => {
  const record = guideReviewArticleRecord(article({
    assignee: "someone",
    queue_position: 3,
    desk: "https://desk.cityscroll.org/queue/7",
  }));
  for (const key of ["assignee", "queue_position", "desk"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(record, key), false, `${key} leaked into the record`);
  }
});

test("a built report validates, is deterministic, and leaks nothing", () => {
  const first = report();
  const second = report();
  assert.equal(first.schema, GUIDE_REVIEW_SCHEMA);
  assert.deepEqual(validateGuideReviewReport(first), []);
  assert.deepEqual(guideReviewLeaks(first), []);
  assert.equal(first.content_hash, second.content_hash);
});

test("a report refuses to invent a check date or a commit", () => {
  assert.throws(() => report({ checkedAt: null }), /checkedAt/);
  assert.throws(() => report({ checkedAt: "September 5" }), /checkedAt/);
  assert.throws(() => report({ observedCommit: "not-a-commit" }), /observedCommit/);
  assert.throws(() => report({ runKey: "a key with spaces" }), /runKey/);
});

test("a changed dependency raises changed_behavior and an unrelated change does not", () => {
  const hit = report({ changedPaths: ["site/search_document.mjs", "README.md"] });
  assert.equal(kinds(hit, "changed_behavior").length, 1);
  assert.deepEqual(kinds(hit, "changed_behavior")[0].evidence.changed_paths, ["site/search_document.mjs"]);

  const miss = report({ changedPaths: ["site/calendar_view.mjs"] });
  assert.equal(kinds(miss, "changed_behavior").length, 0);
});

test("a directory dependency matches a file changed inside it", () => {
  const built = report({
    articles: [article({ depends_on: ["site/demo"] })],
    changedPaths: ["site/demo/demo-links.json"],
  });
  assert.equal(kinds(built, "changed_behavior").length, 1);
});

test("a failing example is a broken_example and a passing one is silent", () => {
  const broken = report({ demoResults: { "semantic-search-housing": { status: "failed", detail: "no cited passages" } } });
  assert.equal(kinds(broken, "broken_example").length, 1);
  assert.match(kinds(broken, "broken_example")[0].detail, /no cited passages/);

  const passing = report({ demoResults: { "semantic-search-housing": { status: "ok" } } });
  assert.equal(kinds(passing, "broken_example").length, 0);
  assert.equal(kinds(passing, "check_unavailable").length, 0);
});

test("a dated example the article already frames as historical is not a breakage", () => {
  const built = report({
    articles: [article({ historical_demos: ["semantic-search-housing"] })],
    demoResults: { "semantic-search-housing": { status: "failed", detail: "the 2024 award is closed" } },
  });
  assert.equal(kinds(built, "broken_example").length, 0);
});

test("an unrunnable check says so instead of claiming a breakage", () => {
  const unavailable = report({ demoResults: { "semantic-search-housing": { status: "unavailable", detail: "the API host was unreachable" } } });
  assert.equal(kinds(unavailable, "broken_example").length, 0);
  assert.equal(kinds(unavailable, "check_unavailable").length, 1);
  assert.equal(kinds(unavailable, "check_unavailable")[0].evidence.reason, "check_unavailable");

  const notRun = report();
  assert.equal(kinds(notRun, "check_unavailable")[0].evidence.reason, "not_exercised");
});

test("an identifier that no longer resolves is an unavailable check, not a silent pass", () => {
  const built = report({
    articles: [article({
      demos: ["retired-demo"],
      capabilities: ["retired.capability@1"],
      source_contracts: ["retired-source"],
    })],
  });
  const reasons = kinds(built, "check_unavailable").map((item) => item.evidence.reason).sort();
  assert.deepEqual(reasons, ["unregistered_capability", "unregistered_demo", "unregistered_source_contract"]);
});

test("review_due separates an article updated after its review from one that simply aged", () => {
  const updatedAfter = report({ articles: [article({ updated: "2026-09-03", last_reviewed: "2026-09-01" })] });
  assert.equal(kinds(updatedAfter, "review_due")[0].evidence.reason, "updated_after_review");

  const aged = report({
    articles: [article({ updated: "2026-01-01", last_reviewed: "2026-01-01" })],
    checkedAt: "2026-09-05",
  });
  const finding = kinds(aged, "review_due")[0];
  assert.equal(finding.evidence.reason, "interval_elapsed");
  assert.equal(finding.evidence.interval_days, DEFAULT_REVIEW_INTERVAL_DAYS);
  assert.equal(finding.evidence.age_days, 247);

  const fresh = report({ articles: [article({ updated: "2026-09-01", last_reviewed: "2026-09-01" })] });
  assert.equal(kinds(fresh, "review_due").length, 0);
});

test("an article with no recorded review is raised rather than assumed current", () => {
  const built = report({ articles: [article({ last_reviewed: null, updated: null, published: null })] });
  assert.equal(kinds(built, "review_due")[0].evidence.reason, "never_reviewed");
});

test("a demonstrated journey no article cites is a possible_new_journey", () => {
  const built = report();
  const journeys = kinds(built, "possible_new_journey");
  assert.deepEqual(journeys.map((item) => item.subject), ["notice-sanitation-connected-mandate"]);
  assert.equal(journeys[0].article_id, null);

  const covered = report({
    articles: [article(), article({ id: "read-a-notice", demos: ["notice-sanitation-connected-mandate"] })],
  });
  assert.equal(kinds(covered, "possible_new_journey").length, 0);
});

test("the journey lane reuses the existing pairing authority rather than a second demo list", () => {
  const orphan = report({
    joins: [...JOINS, { id: "x@1::not-in-the-manifest", capability_reference: "x@1", demo_id: "not-in-the-manifest" }],
  });
  assert.equal(kinds(orphan, "possible_new_journey").length, 1);
});

test("checking never writes a review date and never mutates its inputs", () => {
  const input = Object.freeze(article());
  const built = buildGuideReviewReport({
    articles: [input],
    demoManifest: DEMO_MANIFEST,
    capabilities: CAPABILITIES,
    sourceContracts: SOURCE_CONTRACTS,
    joins: JOINS,
    changedPaths: ["site/search_document.mjs"],
    checkedAt: "2026-12-01",
    observedCommit: COMMIT,
    runKey: "2026-W49",
  });
  assert.equal(input.last_reviewed, "2026-09-01");
  assert.equal(built.articles[0].last_reviewed, "2026-09-01");
  assert.equal(built.checked_at, "2026-12-01");
  assert.notEqual(built.checked_at, built.articles[0].last_reviewed);
  for (const key of Object.keys(built)) {
    assert.equal(key.startsWith("last_reviewed"), false, "a report must not restate a review date as its own");
  }
});

test("a report that carries private review state or an editorial verdict fails validation", () => {
  const built = report();
  const withQueue = { ...built, assignee: "someone" };
  assert.ok(validateGuideReviewReport(withQueue).some((error) => /private review state in assignee/.test(error)));

  const withPath = JSON.parse(JSON.stringify(built));
  // Assembled rather than written out, so this fixture exercises the guard
  // without the test file itself carrying a machine path.
  const localPath = ["", "Users", "someone", "notes.md"].join("/");
  withPath.findings[0].detail = `See ${localPath} for the fix.`;
  assert.ok(guideReviewLeaks(withPath).some((error) => /private path/.test(error)));

  const withVerdict = JSON.parse(JSON.stringify(built));
  withVerdict.findings[0].detail = "This article was approved and rewritten.";
  assert.ok(guideReviewLeaks(withVerdict).some((error) => /editorial verdict/.test(error)));
});

test("a tampered report fails validation on identity, ordering, and hash", () => {
  const built = report({ changedPaths: ["site/search_document.mjs"] });

  const renamed = JSON.parse(JSON.stringify(built));
  renamed.findings[0].kind = "review_due";
  assert.ok(validateGuideReviewReport(renamed).some((error) => /finding_id: does not match/.test(error)));

  const duplicated = JSON.parse(JSON.stringify(built));
  duplicated.findings.push(duplicated.findings[0]);
  duplicated.finding_ids.push(duplicated.finding_ids[0]);
  assert.ok(validateGuideReviewReport(duplicated).some((error) => /duplicate findings/.test(error)));

  const rehashed = { ...built, content_hash: "0".repeat(64) };
  assert.ok(validateGuideReviewReport(rehashed).some((error) => /content_hash: does not match/.test(error)));

  const strayKey = { ...built, next_review: "2027-01-01" };
  assert.ok(validateGuideReviewReport(strayKey).some((error) => /not in the public allowlist/.test(error)));
});

test("identical observations collapse into one finding", () => {
  const built = report({
    articles: [article()],
    changedPaths: ["site/search_document.mjs", "site/search_document.mjs"],
  });
  assert.equal(kinds(built, "changed_behavior").length, 1);
  assert.equal(new Set(built.finding_ids).size, built.finding_ids.length);
});

test("a repeated window produces no new work and a fixed one resolves", () => {
  const first = report({ changedPaths: ["site/search_document.mjs"] });
  const repeat = report({ changedPaths: ["site/search_document.mjs"] });
  const repeatDelta = guideReviewDelta(first, repeat);
  assert.deepEqual(repeatDelta.new_ids, []);
  assert.equal(repeatDelta.persisting_ids.length, first.finding_ids.length);

  const reviewed = report({
    articles: [article({ last_reviewed: "2026-09-05" })],
    demoResults: { "semantic-search-housing": { status: "ok" } },
  });
  const fixedDelta = guideReviewDelta(first, reviewed);
  assert.ok(fixedDelta.resolved_ids.length > 0);
  assert.equal(fixedDelta.resolved_ids.includes(kinds(first, "changed_behavior")[0].finding_id), true);
});

test("the review lane keys replay on the same event identity every other job uses", () => {
  const built = report();
  assert.equal(built.job_id, GUIDE_REVIEW_JOB_ID);
  assert.equal(built.event_id, eventId(GUIDE_REVIEW_JOB_ID, built.run_key));
  assert.equal(built.event_id, guideReviewEventId(built.run_key));
});

test("replaying the same run leaves one event and reaches no outward surface", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "guide-review-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const built = report();
  const refuse = () => { throw new Error("the rehearsal must not reach GitHub"); };
  const github = {
    listIssues: refuse, listComments: refuse, createIssue: refuse, createComment: refuse, updateIssue: refuse,
  };
  const result = {
    observed_at: `${built.checked_at}T00:00:00Z`,
    status: "findings",
    content_hash: built.content_hash,
  };

  const first = await persistScheduleResult({
    stateDir, jobId: GUIDE_REVIEW_JOB_ID, runKey: built.run_key, result, issue: { mode: "none" },
  });
  assert.equal(first.event.event_id, built.event_id);
  assert.equal((await replayOutbox({ stateDir, github })).delivered, 1);

  const second = await persistScheduleResult({
    stateDir, jobId: GUIDE_REVIEW_JOB_ID, runKey: built.run_key, result, issue: { mode: "none" },
  });
  assert.equal(second.event.event_id, first.event.event_id);
  assert.equal(second.event.status, "delivered");
  assert.equal((await replayOutbox({ stateDir, github })).delivered, 0);
});

test("the consumer section groups findings and keeps checking apart from reviewing", () => {
  const text = renderGuideReviewSection(report({
    changedPaths: ["site/search_document.mjs"],
    demoResults: { "semantic-search-housing": { status: "failed", detail: "no cited passages" } },
  }));
  assert.match(text, /^## Guide review$/m);
  assert.match(text, /Last checked 2026-09-05 at b52a5cece59b/);
  assert.match(text, /review date stays a human record and nothing here changes it/);
  assert.match(text, /### Articles whose code changed \(1\)/);
  assert.match(text, /### Examples that did not behave as described \(1\)/);
  assert.match(text, /Nothing above has been acted on\./);
  assert.equal(/approved|publish/i.test(text), false);
});

test("a clear run says so without inventing work", () => {
  const text = renderGuideReviewSection(report({
    articles: [article({ last_reviewed: "2026-09-05" })],
    demoResults: { "semantic-search-housing": { status: "ok" } },
    joins: [JOINS[0]],
  }));
  assert.match(text, /No guide findings this run across 1 articles\./);
});

test("the finding vocabulary is the closed, sorted set the consumer expects", () => {
  assert.deepEqual([...GUIDE_REVIEW_FINDING_KINDS], [...GUIDE_REVIEW_FINDING_KINDS].sort());
  assert.deepEqual([...GUIDE_REVIEW_FINDING_KINDS], [
    "broken_example", "changed_behavior", "check_unavailable", "possible_new_journey", "review_due",
  ]);
  const built = report({ changedPaths: ["site/search_document.mjs"] });
  for (const item of built.findings) assert.ok(GUIDE_REVIEW_FINDING_KINDS.includes(item.kind));
});

test("malformed review metadata fails the guide build rather than reaching the report", () => {
  const head = [
    "---",
    "id: T9",
    "type: tutorial",
    "url: /guide/start/example/",
    "title: An example article",
    "page_title: An example article \u00b7 CityScroll",
    "description: A description that runs long enough to satisfy the page-metadata gate every guide document has to pass before this build will render it.",
    "reader_question: How do I read one of these records?",
    "purpose: Show how one record is read end to end.",
    "return_to_task: Try it yourself | /search/",
    "last_reviewed: 2026-09-01",
  ];
  const body = ["---", "", "## A section", "", "Some prose.", ""];
  const source = (extra) => [...head, ...extra, ...body].join("\n");

  assert.throws(() => parseGuideArticle("t.md", source(["published: last Tuesday"])), GuideSourceError);
  assert.throws(() => parseGuideArticle("t.md", source(["assignee: someone"])), /unknown front-matter key/);
  const localPathFixture = ["", "Users", "someone", "notes.md"].join("/");
  assert.throws(
    () => parseGuideArticle("t.md", source([`correction: see ${localPathFixture}`])),
    /private path, host, or credential/,
  );
  assert.throws(() => parseGuideArticle("t.md", source(["demos:", "  - Not An Id"])), GuideSourceError);
  assert.throws(
    () => parseGuideArticle("t.md", source(["published: 2026-09-02", "updated: 2026-09-01"])),
    GuideSourceError,
  );
  assert.throws(
    () => parseGuideArticle("t.md", source(["demos:", "  - a-demo", "historical_demos:", "  - b-demo"])),
    GuideSourceError,
  );
  assert.doesNotThrow(() => parseGuideArticle("t.md", source([
    "published: 2026-08-01",
    "updated: 2026-09-01",
    "demos:",
    "  - a-demo",
  ])));
});

test("a review date older than the update date is a finding, not a build failure", () => {
  const built = report({ articles: [article({ updated: "2026-09-04", last_reviewed: "2026-09-01" })] });
  assert.equal(kinds(built, "review_due").length, 1);
  assert.deepEqual(validateGuideReviewReport(built), []);
});

test("every identifier the tracked guide sources cite still resolves", () => {
  assert.deepEqual(checkGuideReviewReferences(), []);
});

test("the command line refuses an argument it does not understand", () => {
  assert.deepEqual(parseArgs(["--check"]), { check: true });
  assert.deepEqual(parseArgs(["--checked-at=2026-09-05"]), { "checked-at": "2026-09-05" });
  assert.throws(() => parseArgs(["-c"]), /unrecognized argument/);
});

test("the review lane adds no scheduler, mail route, or delivery change of its own", () => {
  const jobs = JSON.parse(readFileSync(new URL("tools/external_schedule_jobs.json", ROOT), "utf8"));
  assert.equal(jobs.scheduler.ownership, "independent");
  const ids = jobs.jobs.map((job) => job.id);
  assert.equal(ids.includes(GUIDE_REVIEW_JOB_ID), false, "the guide review lane must not register a schedule here");

  const tool = readFileSync(new URL("tools/build_guide_review.mjs", ROOT), "utf8");
  assert.equal(/setInterval|setTimeout|cron|launchd/i.test(tool), false, "the review tool must not schedule itself");
  assert.equal(/createGitHubClient|GITHUB_TOKEN|sendMail|recipients|subscribers/.test(tool), false);
  assert.match(tool, /mode: "none"/);
  assert.match(tool, /NO_MUTATION_CLIENT/);

  const source = readFileSync(new URL("site/guide_review_source.mjs", ROOT), "utf8");
  assert.equal(/Date\.now|new Date\(\)/.test(source), false, "the review projection must not read a clock");
});

test("the capability references the report accepts are the ones the registry publishes", () => {
  const published = new Set(CAPABILITY_REGISTRY.map((row) => row.reference));
  assert.ok(published.has("search.federated@1"));
  const built = report({
    articles: [article({ capabilities: ["search.federated@1"] })],
    capabilities: CAPABILITY_REGISTRY,
  });
  assert.equal(kinds(built, "check_unavailable").filter((item) => item.evidence.reason === "unregistered_capability").length, 0);
});
