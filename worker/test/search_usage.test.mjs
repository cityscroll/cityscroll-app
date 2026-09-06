/**
 * Completed-search usage statistics derived from accepted execution receipts (SAH-05).
 *
 * Every specimen below is written by the real intake and read back through the real
 * authenticated stats path, so what these tests assert is what an operator would see.
 * The corpus is deliberately awkward — boundaries, retries, reloads, skew, developer
 * and preview traffic, and a rejected submission — because the claim under test is not
 * "the numbers add up on happy inputs" but "one accepted production execution counts
 * exactly once, and nothing else counts at all".
 *
 * verify: node --test worker/test/search_usage.test.mjs
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { signToken } from "optin-token";

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_EXECUTION_RECEIPT_SCHEMA,
} from "../../capabilities/search_activity.mjs";
import { handleAdminStats } from "../src/admin.mjs";
import { handleStats } from "../src/stats.mjs";
import { handleSearchActivity } from "../src/search_activity.mjs";
import {
  SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX,
  SEARCH_ACTIVITY_KEY_PREFIX,
  VISITOR_COOKIE_NAME,
  newVisitorId,
  searchExecutionDimensions,
  searchExecutionFingerprint,
} from "../src/lib/search_activity.mjs";
import {
  SEARCH_USAGE_OPTIONAL_CUTS,
  foldSearchUsage,
  readSearchUsage,
  searchUsageWindowStartMs,
} from "../src/lib/search_usage.mjs";
import {
  PUBLIC_SEARCH_USAGE_KEY,
  PUBLIC_SEARCH_USAGE_POPULATION,
  PUBLIC_SEARCH_USAGE_SCHEMA,
  projectPublicSearchUsage,
  publicSearchUsageViolations,
  readPublicSearchUsage,
  refreshPublicSearchUsageSnapshot,
} from "../src/lib/public_search_usage.mjs";
import { sessionPayload } from "../src/lib/session.mjs";
import { deriveSubscriberId } from "../src/lib/subscriptions.mjs";

const INTAKE_URL = "https://api.cityscroll.org/search-activity";
const ORIGIN = "https://cityscroll.org";
const ADMIN_KEY = "admin-secret";
const DEV_SECRET = "developer-exclusion-secret-at-least-32-chars";
const TOKEN_SECRET = "token-secret-for-session-cookies-0123456789";

/** Fixed clock. 7 days opens 2026-09-09T00:00Z; 30 days opens 2026-08-17T00:00Z. */
const NOW = "2026-09-15T12:00:00.000Z";
const WEEK_BOUNDARY = "2026-09-09T00:00:00.000Z";
const JUST_BEFORE_WEEK = "2026-09-08T23:59:59.999Z";
const MONTH_BOUNDARY = "2026-08-17T00:00:00.000Z";
const JUST_BEFORE_MONTH = "2026-08-16T23:59:59.999Z";

/** KV double with the two things this read depends on: key metadata and paging. */
function kv({ pageSize = 1000 } = {}) {
  const store = new Map();
  const metadata = new Map();
  return {
    store,
    metadata,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value, options = {}) => {
      store.set(key, value);
      if (options.metadata) metadata.set(key, JSON.parse(JSON.stringify(options.metadata)));
      else metadata.delete(key);
    },
    list: async ({ prefix = "", limit = 1000, cursor } = {}) => {
      const names = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const size = Math.min(limit, pageSize);
      const page = names.slice(start, start + size);
      const end = start + page.length;
      return {
        keys: page.map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: end >= names.length,
        cursor: String(end),
      };
    },
  };
}

function env(overrides = {}) {
  return {
    ANALYTICS_ENVIRONMENT: "production",
    ANALYTICS_DEV_KEY: DEV_SECRET,
    ADMIN_KEY,
    TOKEN_SECRET,
    ALERT_STATE: kv(),
    ...overrides,
  };
}

function submission(overrides = {}) {
  return {
    schema: SEARCH_EXECUTION_RECEIPT_SCHEMA,
    occurred_at: "2026-09-15T09:00:00.000Z",
    query: { raw: "rats", normalized: "rats" },
    search_path: "/search/",
    scope: {},
    outcome: "matched",
    rendered_count: 2,
    family_counts: { contracts: 1, meetings: 1 },
    incomplete_families: [],
    results: [
      {
        reference: "procurement:rats-abatement-2026",
        entity_type: "procurement",
        family: "contracts",
        kind: "keyword",
        rank: 1,
        title: "Rodent abatement services",
        canonical_href: "/contracts/rats-abatement-2026",
      },
      {
        reference: "meeting:cb3-rats-hearing",
        entity_type: "meeting",
        family: "meetings",
        kind: "keyword",
        rank: 2,
        title: "Public hearing on rats and refuse",
        canonical_href: "/meetings/cb3-rats-hearing",
      },
    ],
    producers: { search_method: "keyword", search_schema: "cityscroll.keyword_search_response.v1" },
    ...overrides,
  };
}

/** Three Contract rows, one family: the specimen that pins appearance semantics. */
function threeContracts(overrides = {}) {
  return submission({
    occurred_at: "2026-09-15T10:00:00.000Z",
    query: { raw: "salt shed", normalized: "salt shed" },
    rendered_count: 3,
    family_counts: { contracts: 3 },
    results: [1, 2, 3].map((rank) => ({
      reference: `procurement:salt-shed-${rank}`,
      entity_type: "procurement",
      family: "contracts",
      kind: "keyword",
      rank,
      title: `Salt shed package ${rank}`,
      canonical_href: `/contracts/salt-shed-${rank}`,
    })),
    ...overrides,
  });
}

function emptySubmission(overrides = {}) {
  return submission({
    outcome: "empty",
    rendered_count: 0,
    family_counts: {},
    results: [],
    ...overrides,
  });
}

function partialSubmission(overrides = {}) {
  return submission({
    outcome: "partial",
    rendered_count: 1,
    family_counts: { contracts: 1 },
    // Land was asked for and did not answer. A coverage gap is not an appearance.
    incomplete_families: ["land"],
    results: [{
      reference: "procurement:only-answer",
      entity_type: "procurement",
      family: "contracts",
      kind: "keyword",
      rank: 1,
      title: "The one lane that answered",
      canonical_href: "/contracts/only-answer",
    }],
    ...overrides,
  });
}

function unavailableSubmission(overrides = {}) {
  return submission({
    outcome: "unavailable",
    rendered_count: 0,
    family_counts: {},
    incomplete_families: [...SEARCH_ACTIVITY_FAMILIES],
    results: [],
    ...overrides,
  });
}

function devToken(secret = DEV_SECRET, nowMs = Date.now()) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  return `v1.${timestamp}.${signature}`;
}

/** Run one awaited step against a fixed wall clock. */
async function atInstant(instant, run) {
  const realNow = Date.now;
  Date.now = () => new Date(instant).getTime();
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Record one receipt at an exact instant. The intake owns received time, so the only
 * honest way to place a specimen in a window is to run it against a fixed clock.
 */
async function recordAt(instant, target, body, headers = {}, { expect = 202 } = {}) {
  const response = await atInstant(instant, () => handleSearchActivity(new Request(INTAKE_URL, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), target));
  assert.equal(response.status, expect);
  return response;
}

function visitor(id = newVisitorId()) {
  return { id, header: `${VISITOR_COOKIE_NAME}=${id}` };
}

async function privateStats(target) {
  const response = await handleAdminStats(
    new Request(`https://api.cityscroll.org/admin/stats?key=${ADMIN_KEY}`),
    target,
    { now: NOW },
  );
  assert.equal(response.status, 200);
  return (await response.json()).search_executions;
}

async function productActivity(target) {
  const response = await handleAdminStats(
    new Request(`https://api.cityscroll.org/admin/stats?key=${ADMIN_KEY}&view=html`),
    target,
    { now: NOW },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.text();
}

/**
 * The commissioned corpus. Named identities so an assertion can say which reader it
 * means, and every awkward case the contract has to survive.
 */
async function seedCorpus(target) {
  const anna = visitor();
  const ben = visitor();
  const cara = visitor();
  const dev = visitor();
  const early = visitor();
  const oldest = visitor();

  // Signed on the same fixed clock the receipts are recorded against, so recognition
  // is decided by the contract rather than by when the suite happens to run.
  const session = await atInstant("2026-09-15T00:00:00.000Z",
    () => signToken(TOKEN_SECRET, sessionPayload("resident@example.org"), { ttlSeconds: 7 * 24 * 3600 }));

  // In the 7-day window.
  const twoFamilies = submission();
  await recordAt("2026-09-15T09:00:05.000Z", target, twoFamilies, { Cookie: anna.header });
  // Duplicate intake: the same execution, submitted twice by a retrying beacon.
  await recordAt("2026-09-15T09:00:09.000Z", target, twoFamilies, { Cookie: anna.header });
  // Reload: the same reader, the same query, a new render at a new instant.
  await recordAt("2026-09-15T09:30:00.000Z", target,
    submission({ occurred_at: "2026-09-15T09:29:00.000Z" }), { Cookie: anna.header });

  await recordAt("2026-09-15T10:00:10.000Z", target, threeContracts(), {
    Cookie: `${ben.header}; cs_session=${session}`,
  });
  await recordAt("2026-09-12T08:00:00.000Z", target,
    emptySubmission({ occurred_at: "2026-09-12T08:00:00.000Z" }), { Cookie: cara.header });
  await recordAt("2026-09-11T08:00:00.000Z", target,
    partialSubmission({ occurred_at: "2026-09-11T08:00:00.000Z" }), { Cookie: cara.header });
  // Exactly on the opening midnight of the 7-day window: inside it.
  await recordAt(WEEK_BOUNDARY, target,
    unavailableSubmission({ occurred_at: WEEK_BOUNDARY }), { Cookie: dev.header });

  // One millisecond earlier: outside 7 days, inside 30.
  await recordAt(JUST_BEFORE_WEEK, target,
    submission({ occurred_at: JUST_BEFORE_WEEK }), { Cookie: early.header });
  // Exactly on the opening midnight of the 30-day window: inside it.
  await recordAt(MONTH_BOUNDARY, target,
    submission({ occurred_at: MONTH_BOUNDARY }), { Cookie: oldest.header });
  // One millisecond earlier: aged past every window this surface reports.
  await recordAt(JUST_BEFORE_MONTH, target,
    submission({ occurred_at: JUST_BEFORE_MONTH }), { Cookie: oldest.header });

  // A clock-skewed receipt from the future belongs to no past window.
  await recordAt("2026-09-16T12:00:00.000Z", target,
    submission({ occurred_at: "2026-09-16T12:00:00.000Z" }), { Cookie: anna.header });

  // Developer traffic, carrying a valid exclusion token.
  await recordAt("2026-09-15T11:00:00.000Z", target, submission(), {
    Cookie: anna.header,
    "X-CROL-Analytics-Dev": devToken(DEV_SECRET, new Date("2026-09-15T11:00:00.000Z").getTime()),
  });

  // Test/preview traffic: a non-production environment sharing the same store.
  await recordAt("2026-09-15T11:30:00.000Z",
    { ...target, ANALYTICS_ENVIRONMENT: "preview" }, submission(), { Cookie: anna.header });

  // A rejected submission: an unknown field. Nothing is stored, so nothing can count.
  await recordAt("2026-09-15T11:45:00.000Z", target,
    { ...submission(), lens: "money" }, { Cookie: anna.header }, { expect: 400 });

  return { anna, ben, cara, dev, early, oldest };
}

// ---- A1: one accepted production execution, one completed count ----

test("each accepted production execution counts once; reloads count again, retries do not", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);

  assert.equal(usage.available, true);
  assert.equal(usage.windows.last7d.completed, 6,
    "two-family + reload + three-contracts + empty + partial + boundary-unavailable");
  assert.equal(usage.duplicate_intakes, 1, "the retried beacon folded onto its own execution");
  assert.equal(usage.future_dated_executions, 1, "the skewed receipt is held out, not counted");
  assert.equal(usage.unclassified_receipts, 0);
});

test("developer, preview, and rejected traffic never reach the production totals", async () => {
  const target = env();
  await seedCorpus(target);

  const production = [...target.ALERT_STATE.store.keys()]
    .filter((key) => key.startsWith(SEARCH_ACTIVITY_KEY_PREFIX));
  const developer = [...target.ALERT_STATE.store.keys()]
    .filter((key) => key.startsWith(SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX));
  assert.equal(developer.length, 2, "the dev-token receipt and the preview-environment receipt");
  assert.equal(production.length, 11, "the rejected submission was never stored at all");

  const usage = await privateStats(target);
  // 11 stored production receipts, minus the retry, minus the skewed one, minus the
  // two that fall outside 30 days.
  assert.equal(usage.windows.last30d.completed, 8);
  // The scan stops at the first receipt older than the widest window it reports, so the
  // one that aged past 30 days is never read — bounded work, not a silent omission.
  assert.equal(usage.executions_observed, 9);
});

// ---- A2: reconciliation and boundaries ----

test("terminal states reconcile exactly to completed searches, in both windows", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);

  for (const key of ["last7d", "last30d"]) {
    const cut = usage.windows[key];
    const summed = cut.outcomes.matched + cut.outcomes.partial + cut.outcomes.empty + cut.outcomes.unavailable;
    assert.equal(summed, cut.completed, `${key} outcomes reconcile`);
    assert.equal(cut.recognition.recognized + cut.recognition.unrecognized, cut.completed,
      `${key} recognition reconciles`);
  }

  assert.deepEqual(usage.windows.last7d.outcomes, { matched: 3, partial: 1, empty: 1, unavailable: 1 });
  assert.deepEqual(usage.windows.last30d.outcomes, { matched: 5, partial: 1, empty: 1, unavailable: 1 });
});

test("a window opens on its midnight: one millisecond earlier is a different window", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);

  assert.equal(usage.windows.last7d.starts_at, WEEK_BOUNDARY);
  assert.equal(usage.windows.last30d.starts_at, MONTH_BOUNDARY);
  assert.equal(usage.windows.last7d.ends_at, NOW);
  // The boundary receipt is inside 7 days; the one a millisecond earlier is not.
  assert.equal(usage.windows.last7d.outcomes.unavailable, 1);
  assert.equal(usage.windows.last7d.completed + 2, usage.windows.last30d.completed,
    "exactly the just-before-week and month-boundary receipts join the wider window");
});

test("the 30-day window is where retention ends, not where counting quietly stops", async () => {
  const nowMs = new Date(NOW).getTime();
  assert.equal(new Date(searchUsageWindowStartMs(nowMs, 7)).toISOString(), WEEK_BOUNDARY);
  assert.equal(new Date(searchUsageWindowStartMs(nowMs, 30)).toISOString(), MONTH_BOUNDARY);
  assert.ok(new Date(JUST_BEFORE_MONTH).getTime() < searchUsageWindowStartMs(nowMs, 30));
});

// ---- A2/A3: family appearances and distinct identities ----

test("a family appearance is an execution, never a row count and never a coverage gap", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);
  const week = usage.windows.last7d;

  // Three Contract rows in one execution are one Contract appearance; the two-family
  // execution and its reload each appear in Contracts and in Meetings.
  assert.equal(week.family_appearances.contracts, 4, "two-family + reload + three-contracts + partial");
  assert.equal(week.family_appearances.meetings, 2, "the two-family execution and its reload");
  assert.equal(week.family_appearances.land, 0,
    "Land was recorded incomplete on the partial execution; it never appeared");
  assert.match(usage.family_appearance_semantics, /Never a count of result rows/);
});

test("unique browsers and recognized accounts stay separate measures", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);

  assert.equal(usage.windows.last7d.unique_visitors, 4, "anna, ben, cara, and the boundary browser");
  assert.equal(usage.windows.last7d.recognized_accounts, 1);
  assert.equal(usage.windows.last7d.recognition.recognized, 1);
  assert.equal(usage.windows.last30d.unique_visitors, 6);
  assert.match(usage.identity_note, /not people, and they are never summed/);
});

// ---- A3: the private boundary holds ----

test("the aggregate publishes counts only — no queries, rows, or identifiers", async () => {
  const target = env();
  const identities = await seedCorpus(target);
  const response = await handleAdminStats(
    new Request(`https://api.cityscroll.org/admin/stats?key=${ADMIN_KEY}`),
    target,
    { now: NOW },
  );
  const text = await response.text();

  assert.doesNotMatch(text, /rats|salt shed/, "no query text");
  assert.doesNotMatch(text, /rats-abatement-2026|cb3-rats-hearing/, "no result references");
  assert.doesNotMatch(text, /resident@example\.org|r…@example\.org/, "no account labels");
  assert.doesNotMatch(text, /subscriber:/, "no subscriber ids");
  for (const identity of Object.values(identities)) {
    assert.ok(!text.includes(identity.id), "no visitor ids");
  }
  assert.doesNotMatch(text, /execution_id|receipt_id|visitor_id/, "no per-execution detail");
});

test("seeding receipts publishes nothing on its own: the public route reads a snapshot", async () => {
  // The public boundary moved deliberately — two counts per named period are published now
  // (see "the published summary…" below). What has not moved is where they come from: the
  // receipt store is never the public route's input, so a store full of receipts and no
  // scheduled refresh publishes an honest unavailable state, not a total.
  const target = env();
  await seedCorpus(target);
  const response = await handleStats(
    new Request("https://api.cityscroll.org/stats"),
    target,
    null,
    {
      now: NOW,
      skipCacheRead: true,
      fetchImpl: async () => Response.json([{
        notice_count: "1099194",
        first_notice_date: "2003-01-02T00:00:00.000",
        latest_notice_date: "2026-08-05T00:00:00.000",
      }]),
    },
  );
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "public, max-age=900");
  assert.doesNotMatch(text, /search_executions|unique_visitors|recognized|duplicate_intakes/);
  assert.deepEqual(Object.keys(JSON.parse(text)),
    ["schema", "generated_at", "scope", "coverage", "language_coverage", "search_usage"]);
  assert.equal(JSON.parse(text).search_usage.available, false);
  assert.equal(JSON.parse(text).search_usage.unavailable_reason, "no_verified_snapshot");
});

// ---- A4: compatibility, the Desk consumer, and honest unavailability ----

test("Product Activity renders the completed-search cuts inside the existing desk page", async () => {
  const target = env();
  await seedCorpus(target);
  const html = await productActivity(target);

  assert.match(html, /<h1>Product activity<\/h1>/, "still the existing page");
  assert.match(html, /id="completed-searches-heading">Completed searches</, "a section, not a new dashboard");
  assert.match(html, /Completed searches · 7 days/, "a summary card beside the existing ones");
  // The existing summary survives intact.
  for (const label of ["Searches · 7 days", "Page views · 7 days", "Digests · 7 days",
    "Owed delivery backlog", "Search activity"]) {
    assert.ok(html.includes(label), `the desk keeps ${label}`);
  }
  assert.match(html, /Recognized accounts/);
  assert.match(html, /Unique browsers/);
  // The measure the public page publishes is readable on the desk under the same name, so
  // the two surfaces can be reconciled without translating between them.
  assert.match(html, /Searches returning records/);
  assert.match(html, /not measured/, "optional cuts say so on the surface too");
});

test("optional cuts report unavailable with a reason, never a measured zero", async () => {
  const target = env();
  await seedCorpus(target);
  const usage = await privateStats(target);

  assert.deepEqual(Object.keys(usage.optional_cuts),
    SEARCH_USAGE_OPTIONAL_CUTS.map((cut) => cut.id));
  for (const [id, cut] of Object.entries(usage.optional_cuts)) {
    assert.equal(cut.available, false, `${id} has no landed signal behind it`);
    assert.ok(cut.unavailable_reason, `${id} names why`);
    assert.ok(cut.requires, `${id} names the contract that would make it truthful`);
    assert.ok(!("last7d" in cut) && !("last30d" in cut), `${id} publishes no number it cannot defend`);
  }
});

test("an optional cut becomes a measurement the moment a landed signal supplies both windows", () => {
  const partial = foldSearchUsage([], {
    now: NOW,
    signals: { history_reruns: { last7d: 4 } },
  });
  assert.equal(partial.optional_cuts.history_reruns.available, false,
    "half a signal is not half a measurement");

  const landed = foldSearchUsage([], {
    now: NOW,
    signals: { history_reruns: { last7d: 4, last30d: 11 } },
  });
  assert.equal(landed.optional_cuts.history_reruns.available, true);
  assert.equal(landed.optional_cuts.history_reruns.last30d, 11);
});

// ---- fail-soft and store honesty ----

test("no receipt store reports unavailable, not zero completed searches", async () => {
  const usage = await readSearchUsage({}, { now: NOW });
  assert.equal(usage.available, false);
  assert.equal(usage.unavailable_reason, "no-store");
  assert.deepEqual(usage.windows, {});
});

test("a failing receipt store reports the failure rather than a confident total", async () => {
  const usage = await readSearchUsage({
    ALERT_STATE: { list: async () => { throw new Error("kv down"); } },
  }, { now: NOW });
  assert.equal(usage.available, false);
  assert.equal(usage.unavailable_reason, "read-failed");
});

test("receipts stored before the dimensions rode the key are hydrated, not dropped", async () => {
  const target = env();
  await recordAt("2026-09-15T09:00:00.000Z", target, submission(), { Cookie: visitor().header });
  // Simulate the pre-SAH-05 store: the receipt body is intact, its metadata is not.
  for (const key of target.ALERT_STATE.metadata.keys()) target.ALERT_STATE.metadata.delete(key);

  const usage = await readSearchUsage(target, { now: NOW });
  assert.equal(usage.windows.last7d.completed, 1);
  assert.equal(usage.scan.hydrated_receipts, 1);
  assert.equal(usage.unclassified_receipts, 0);
});

test("a corrupt retained receipt is counted nowhere and reported, never guessed at", async () => {
  const target = env();
  await recordAt("2026-09-15T09:00:00.000Z", target, submission(), { Cookie: visitor().header });
  for (const key of target.ALERT_STATE.store.keys()) {
    target.ALERT_STATE.metadata.delete(key);
    target.ALERT_STATE.store.set(key, "{not json");
  }

  const usage = await readSearchUsage(target, { now: NOW });
  assert.equal(usage.windows.last7d.completed, 0);
  assert.equal(usage.unclassified_receipts, 1);
});

test("a paged store is folded across pages, not truncated at the first one", async () => {
  const target = env({ ALERT_STATE: kv({ pageSize: 2 }) });
  for (let index = 0; index < 5; index += 1) {
    await recordAt(`2026-09-15T09:0${index}:00.000Z`, target,
      submission({ occurred_at: `2026-09-15T09:0${index}:00.000Z` }), { Cookie: visitor().header });
  }
  const usage = await readSearchUsage(target, { now: NOW });
  assert.equal(usage.windows.last7d.completed, 5);
  assert.equal(usage.scan.scan_complete, true);
});

test("aggregation dimensions stay well inside the key-metadata bound", async () => {
  // Worst case by construction: every family present, a recognized account, and a
  // full-length visitor id. Key metadata is capped at 1 KiB, and a rejected put would
  // cost the receipt itself — so the bound is pinned here rather than assumed.
  const worstCase = searchExecutionDimensions({
    execution_fingerprint: await searchExecutionFingerprint(submission(), newVisitorId()),
    outcome: "matched",
    recognition: "recognized",
    visitor_id: newVisitorId(),
    subscriber_id: await deriveSubscriberId("a-very-long-address@a-very-long-domain.example.org"),
    family_counts: Object.fromEntries(SEARCH_ACTIVITY_FAMILIES.map((family) => [family, 4])),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(worstCase)).length;
  assert.ok(bytes < 512, `dimensions serialize to ${bytes} bytes, far under the 1024-byte ceiling`);
  assert.deepEqual(worstCase.families, [...SEARCH_ACTIVITY_FAMILIES].sort());
});

// ---- the identity the counting rests on ----

test("the execution fingerprint is stable across a retry and new across a reload", async () => {
  const first = submission();
  const reload = submission({ occurred_at: "2026-09-15T09:29:00.000Z" });
  const browser = newVisitorId();
  const other = newVisitorId();

  assert.equal(
    await searchExecutionFingerprint(first, browser),
    await searchExecutionFingerprint({ ...first }, browser),
    "a retried beacon repeats every input, so it repeats the identity",
  );
  assert.notEqual(
    await searchExecutionFingerprint(first, browser),
    await searchExecutionFingerprint(reload, browser),
    "a reload is a new render at a new instant",
  );
  assert.notEqual(
    await searchExecutionFingerprint(first, browser),
    await searchExecutionFingerprint(first, other),
    "two browsers that searched alike are still two executions",
  );
});

test("the front-door scope actually requested is part of what makes an execution that execution", async () => {
  const allSources = submission();
  const contractsOnly = submission({ front_door_scope: "contracts" });
  const browser = newVisitorId();

  assert.notEqual(
    await searchExecutionFingerprint(allSources, browser),
    await searchExecutionFingerprint(contractsOnly, browser),
    "an all-sources search and a Contracts-only search are different executions even if everything else matches",
  );
  assert.equal(
    await searchExecutionFingerprint(submission({ front_door_scope: "all" }), browser),
    await searchExecutionFingerprint(submission({ front_door_scope: undefined }), browser),
    "an explicit 'all' and an absent (historical) scope are the same request",
  );
});

// ---- the published summary -------------------------------------------------------------
//
// Everything below asserts on the FINAL SERIALIZED public artifact — the bytes GET /stats
// answers with, and the bytes it puts in the edge cache — never on an intermediate object.
// A projection that looks right in memory and leaks on the way out is the failure this
// section exists to catch.

/** Measurement established well before the widest window this specimen reports. */
const MEASURED_SINCE = "2026-07-01T00:00:00.000Z";

/** An edge cache double, so the published cache entry can be read back and inspected. */
function edgeCache() {
  const entries = new Map();
  return {
    entries,
    default: {
      match: async () => null,
      put: async (request, response) => { entries.set(request.url, await response.text()); },
    },
  };
}

/** Run one step with a cache API present, the way the Worker runtime provides one. */
async function withEdgeCache(cache, run) {
  const had = "caches" in globalThis;
  const previous = globalThis.caches;
  globalThis.caches = cache;
  try {
    return await run();
  } finally {
    if (had) globalThis.caches = previous;
    else delete globalThis.caches;
  }
}

/** The public response text, exactly as a reader would receive it. */
async function publicStatsText(target, { now = NOW, cache = null } = {}) {
  const run = () => handleStats(new Request("https://api.cityscroll.org/stats"), target,
    { waitUntil: async (promise) => promise }, { now, skipCacheRead: true });
  const response = cache ? await withEdgeCache(cache, run) : await run();
  assert.equal(response.status, 200);
  return response.text();
}

async function publishedSearchUsage(target, options = {}) {
  return JSON.parse(await publicStatsText(target, options)).search_usage;
}

function publishedMetric(period, metricId) {
  return (period.metrics || []).find((metric) => metric.metric_id === metricId);
}

// ---- A1: the published counts are the accepted executions, counted once ----

test("the published summary counts each accepted production execution exactly once", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const usage = await publishedSearchUsage(target);
  assert.equal(usage.schema, PUBLIC_SEARCH_USAGE_SCHEMA);
  assert.equal(usage.available, true);

  const week = usage.periods.find((period) => period.requested_days === 7);
  const month = usage.periods.find((period) => period.requested_days === 30);
  assert.equal(publishedMetric(week, "searches_run").value, 6,
    "two-family + reload + three-contracts + empty + partial + boundary-unavailable");
  assert.equal(publishedMetric(month, "searches_run").value, 8);
  assert.equal(publishedMetric(week, "searches_returning_records").value, 4,
    "three matched executions plus the partial that still rendered a row");
  assert.equal(publishedMetric(month, "searches_returning_records").value, 6);
});

test("the published counts reconcile with the authenticated aggregate at the same cutoff", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const published = await publishedSearchUsage(target);
  const private_ = await privateStats(target);

  for (const days of [7, 30]) {
    const period = published.periods.find((entry) => entry.requested_days === days);
    const cut = private_.windows[`last${days}d`];
    assert.equal(publishedMetric(period, "searches_run").value, cut.completed,
      `${days}d searches run matches the private aggregate`);
    assert.equal(publishedMetric(period, "searches_returning_records").value, cut.returned_records,
      `${days}d searches returning records matches the private aggregate`);
    assert.equal(period.starts_at, cut.starts_at, `${days}d covers the same span`);
    assert.equal(period.ends_at, cut.ends_at);
  }
  // Terminal states still reconcile privately; the public surface publishes neither.
  assert.deepEqual(private_.windows.last7d.outcomes, { matched: 3, partial: 1, empty: 1, unavailable: 1 });
  assert.deepEqual(private_.windows.last30d.outcomes, { matched: 5, partial: 1, empty: 1, unavailable: 1 });
});

test("a duplicate intake adds nothing to the published count; a reload adds one", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const before = publishedMetric(
    (await publishedSearchUsage(target)).periods.find((period) => period.requested_days === 7),
    "searches_run").value;

  // The same execution again: every input repeats, so the fingerprint repeats.
  await recordAt("2026-09-15T09:45:00.000Z", target, submission(), { Cookie: visitor().header });
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const afterRetry = publishedMetric(
    (await publishedSearchUsage(target)).periods.find((period) => period.requested_days === 7),
    "searches_run").value;
  assert.equal(afterRetry, before + 1,
    "a different browser searching alike is a second execution, not a retry of the first");

  const browser = visitor();
  const twice = submission({ occurred_at: "2026-09-15T10:30:00.000Z" });
  await recordAt("2026-09-15T10:30:05.000Z", target, twice, { Cookie: browser.header });
  await recordAt("2026-09-15T10:30:09.000Z", target, twice, { Cookie: browser.header });
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const afterDuplicate = publishedMetric(
    (await publishedSearchUsage(target)).periods.find((period) => period.requested_days === 7),
    "searches_run").value;
  assert.equal(afterDuplicate, afterRetry + 1, "two intakes of one execution published one count");
});

// ---- A2: what the counts are, and what they are not ----

test("the published summary names its population and never folds in the legacy input counters", async () => {
  const target = env({
    SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE,
    NL_METER: kv(),
  });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const baseline = await publishedSearchUsage(target);

  // Legacy "someone asked" counters answer a different question. Moving them must not
  // move a receipt-derived total by one.
  await target.NL_METER.put("stats:nl_search:2026-09-15", "500");
  await target.ALERT_STATE.put("stats:search_run:2026-09-15", "500");
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const after = await publishedSearchUsage(target);

  assert.deepEqual(after.periods, baseline.periods, "input counters are not completed searches");
  assert.match(after.measurement.population, /Accepted production search-execution receipts/);
  assert.equal(after.measurement.population, PUBLIC_SEARCH_USAGE_POPULATION);
  assert.match(after.measurement.subset_rule, /never added/);

  const week = after.periods.find((period) => period.requested_days === 7);
  assert.deepEqual(week.metrics.map((metric) => metric.metric_id),
    ["searches_run", "searches_returning_records"]);
  assert.equal(week.metrics[0].label_key, "stats_search_use_run_label");
  assert.equal(week.metrics[1].label_key, "stats_search_use_returning_label");
  assert.ok(publishedMetric(week, "searches_returning_records").value
    <= publishedMetric(week, "searches_run").value, "the subset never exceeds its population");
});

test("family appearances stay private: the published summary carries none of them", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const text = await publicStatsText(target);
  for (const family of SEARCH_ACTIVITY_FAMILIES) {
    assert.equal(JSON.parse(text).search_usage && JSON.stringify(JSON.parse(text).search_usage).includes(family), false,
      `${family} is not published in this slice`);
  }
  // The contract they would be published under is already pinned privately.
  const private_ = await privateStats(target);
  assert.equal(private_.windows.last7d.family_appearances.contracts, 4);
  assert.equal(private_.windows.last7d.family_appearances.meetings, 2);
  assert.equal(private_.windows.last7d.family_appearances.land, 0);
});

// ---- A3: boundaries, coverage, and the states that are not a zero ----

test("a published period opens on its own midnight and says which days it covers", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const usage = await publishedSearchUsage(target);

  const week = usage.periods.find((period) => period.requested_days === 7);
  const month = usage.periods.find((period) => period.requested_days === 30);
  assert.equal(week.starts_at, WEEK_BOUNDARY);
  assert.equal(week.ends_at, NOW);
  assert.equal(month.starts_at, MONTH_BOUNDARY);
  assert.equal(week.coverage, "complete");
  assert.equal(month.coverage, "complete");
});

test("a complete empty period publishes zero; nothing else does", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  // Nothing recorded at all, and measurement established well before both windows.
  const result = await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  assert.equal(result.verified, true);

  const usage = await publishedSearchUsage(target);
  for (const period of usage.periods) {
    assert.equal(period.state, "measured");
    assert.equal(period.coverage, "complete");
    for (const metric of period.metrics) assert.equal(metric.value, 0);
  }
});

test("a telemetry start inside a period publishes the shorter verified period, not the wider one", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: "2026-09-11T00:00:00.000Z" });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const usage = await publishedSearchUsage(target);

  const week = usage.periods.find((period) => period.requested_days === 7);
  assert.equal(week.coverage, "partial", "the 7-day window opens before measurement did");
  assert.equal(week.starts_at, "2026-09-11T00:00:00.000Z", "it names the day counting began");
  // Three matched on the 15th, the empty one on the 12th, the partial on the 11th.
  assert.equal(publishedMetric(week, "searches_run").value, 5);
  assert.equal(publishedMetric(week, "searches_returning_records").value, 4);
  assert.equal(usage.measurement.measured_since, "2026-09-11T00:00:00.000Z");

  const month = usage.periods.find((period) => period.requested_days === 30);
  assert.equal(month.coverage, "partial");
  assert.equal(month.starts_at, "2026-09-11T00:00:00.000Z");
  assert.equal(publishedMetric(month, "searches_run").value, 5,
    "a wider label may not carry a wider number than measurement supports");
});

test("no established measurement start publishes no period at all", async () => {
  const target = env();
  await seedCorpus(target);
  // Reading with nothing configured and no prior refresh: the aggregate still reports the
  // receipts it holds, and the projection publishes none of it.
  const usage = projectPublicSearchUsage(await readSearchUsage(target, { now: NOW }), { now: NOW });
  assert.equal(usage.available, false);
  assert.equal(usage.unavailable_reason, "measurement_start_unknown");
  for (const period of usage.periods) {
    for (const metric of period.metrics) assert.equal(metric.value, null, "never a zero");
  }
});

test("a capped scan is published as unavailable, never as a smaller-looking total", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  const usage = projectPublicSearchUsage({
    ...(await readSearchUsage(target, { now: NOW, measuredSince: MEASURED_SINCE })),
    scan: { keys_seen: 5000, hydrated_receipts: 0, scan_complete: false, key_ceiling: 5000, hydrate_ceiling: 200 },
  }, { now: NOW });

  assert.equal(usage.available, false);
  assert.equal(usage.measurement.state, "incomplete");
  for (const period of usage.periods) {
    assert.equal(period.unavailable_reason, "measurement_incomplete");
    for (const metric of period.metrics) assert.equal(metric.value, null);
  }
});

test("a corrupt retained receipt makes the period unavailable rather than a confident zero", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await recordAt("2026-09-15T09:00:00.000Z", target, submission(), { Cookie: visitor().header });
  for (const key of target.ALERT_STATE.store.keys()) {
    if (!key.startsWith(SEARCH_ACTIVITY_KEY_PREFIX)) continue;
    target.ALERT_STATE.metadata.delete(key);
    target.ALERT_STATE.store.set(key, "{not json");
  }
  const result = await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  assert.equal(result.verified, false);

  const usage = await publishedSearchUsage(target);
  assert.equal(usage.available, false);
  assert.equal(usage.refresh.state, "failed");
  assert.equal(usage.refresh.failure_reason, "measurement_incomplete");
});

test("a failed refresh keeps the last verified snapshot standing and records the failure", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const verified = await publishedSearchUsage(target);
  assert.equal(verified.refresh.state, "fresh");

  // The receipt store fails on the next scheduled refresh. The stored snapshot outlives it.
  const listing = target.ALERT_STATE.list;
  target.ALERT_STATE.list = async () => { throw new Error("kv down"); };
  const failed = await refreshPublicSearchUsageSnapshot(target, { now: "2026-09-15T13:00:00.000Z" });
  target.ALERT_STATE.list = listing;
  assert.equal(failed.verified, false);

  const after = await publishedSearchUsage(target, { now: "2026-09-15T13:00:00.000Z" });
  assert.equal(after.available, true, "the last verified figures stay published");
  assert.deepEqual(after.periods, verified.periods);
  assert.equal(after.refresh.state, "failed");
  assert.equal(after.refresh.failure_reason, "measurement_unavailable");
  assert.equal(after.refresh.verified_at, verified.refresh.verified_at);
  assert.equal(after.refresh.attempted_at, "2026-09-15T13:00:00.000Z");
});

test("a snapshot nobody could re-verify stops being published once its receipts have aged out", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const stale = await readPublicSearchUsage(target, { now: "2026-09-17T00:00:00.000Z" });
  assert.equal(stale.available, true);
  assert.equal(stale.refresh.state, "stale", "older than a day, still true about its own days");

  const expired = await readPublicSearchUsage(target, { now: "2026-09-30T00:00:00.000Z" });
  assert.equal(expired.available, false);
  assert.equal(expired.unavailable_reason, "snapshot_expired");
  assert.deepEqual(expired.periods, []);
});

test("a public read never scans the receipt store", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  let listed = 0;
  const listing = target.ALERT_STATE.list.bind(target.ALERT_STATE);
  target.ALERT_STATE.list = async (...args) => { listed += 1; return listing(...args); };
  const usage = await publishedSearchUsage(target);
  assert.equal(listed, 0, "the scheduled refresh already did that work");
  assert.equal(usage.available, true);
});

// ---- A4: the boundary, checked on the bytes that leave ----

test("the published JSON and the edge cache entry carry nothing that identifies anyone", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  const identities = await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const cache = edgeCache();
  const text = await publicStatsText(target, { cache });
  const cached = [...cache.entries.values()];
  assert.equal(cached.length, 1, "the response is cached under one versioned key");

  for (const serialized of [text, ...cached]) {
    assert.doesNotMatch(serialized, /rats|salt shed/, "no query text");
    assert.doesNotMatch(serialized, /rats-abatement-2026|cb3-rats-hearing|only-answer/, "no result trace");
    assert.doesNotMatch(serialized, /resident@example\.org|r…@example\.org/, "no account label");
    assert.doesNotMatch(serialized, /rcpt_|exec_|exf_|subscriber:/, "no receipt or execution ids");
    assert.doesNotMatch(serialized, /recognized_accounts|unique_visitors|recognition/, "no identity counts");
    assert.doesNotMatch(serialized, /\/admin|cs_session|cs_visitor|ADMIN_KEY/, "no private route or credential");
    assert.doesNotMatch(serialized, /keys_seen|hydrate|unclassified|key_ceiling/, "no scan diagnostics");
    for (const identity of Object.values(identities)) {
      assert.equal(serialized.includes(identity.id), false, "no visitor ids");
    }
  }
});

test("the published summary is a closed serialization, checked before it is served", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  const usage = await publishedSearchUsage(target);
  assert.deepEqual(publicSearchUsageViolations(usage), []);

  // Anything the allowlist does not name is refused, whatever it is called.
  assert.ok(publicSearchUsageViolations({ ...usage, note: "hello" }).length,
    "an added top-level field is refused");
  assert.ok(publicSearchUsageViolations({
    ...usage,
    measurement: { ...usage.measurement, population: "resident@example.org searched for rats" },
  }).length, "free text in a declared field is refused");

  // A stored snapshot that fails the check is not served, and does not become a zero.
  const stored = JSON.parse(await target.ALERT_STATE.get(PUBLIC_SEARCH_USAGE_KEY));
  stored.artifact.periods[0].leaked_query = "rats";
  await target.ALERT_STATE.put(PUBLIC_SEARCH_USAGE_KEY, JSON.stringify(stored));
  const refused = await readPublicSearchUsage(target, { now: NOW });
  assert.equal(refused.available, false);
  assert.equal(refused.unavailable_reason, "snapshot_rejected");
  assert.deepEqual(refused.periods, []);
});

test("publishing counts does not open the private surfaces: they still require the key", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });

  for (const path of ["/admin/stats", "/admin/stats?key=wrong", "/admin/stats?view=html"]) {
    const response = await handleAdminStats(new Request(`https://api.cityscroll.org${path}`), target, { now: NOW });
    assert.notEqual(response.status, 200, `${path} must not answer without the admin key`);
    const body = await response.text();
    assert.doesNotMatch(body, /rats|resident@example\.org|search_executions/);
  }
  // And the authenticated surface still carries everything the public one does not.
  const private_ = await privateStats(target);
  assert.equal(private_.windows.last7d.recognized_accounts, 1);
  assert.equal(private_.windows.last7d.unique_visitors, 4);
});

test("the public scope statement says what is published and what stays private", async () => {
  const target = env({ SEARCH_ACTIVITY_MEASURED_SINCE: MEASURED_SINCE });
  await seedCorpus(target);
  await refreshPublicSearchUsageSnapshot(target, { now: NOW });
  const body = JSON.parse(await publicStatsText(target));

  assert.match(body.scope, /searches run and searches returning records/);
  assert.match(body.scope, /Search queries, results, readers, subscribers and delivery operations are private/);
  assert.deepEqual(Object.keys(body),
    ["schema", "generated_at", "scope", "coverage", "language_coverage", "search_usage"]);
  for (const removed of ["subscriptions", "digests", "nl_search", "history", "usage", "search_executions"]) {
    assert.equal(Object.hasOwn(body, removed), false, `${removed} must remain private`);
  }
});
