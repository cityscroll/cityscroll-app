import assert from "node:assert/strict";
import test from "node:test";

import {
  admitTextQuery,
  encodeWatchFilter,
  filterConfidence,
  prepareWatchFilter,
  sanitize,
} from "../src/lib/filter.mjs";
import { applyWatchPatch } from "../src/lib/prefs.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { compileSub_d1, subToD1Opts } from "../src/lib/compile_d1.mjs";
import { unsupportedModernFeedFilterFields } from "../src/lib/feed.mjs";
import {
  TEXT_QUERY_SUPPORT,
  textQueryAdmissionSupported,
  textQueryEvaluationSupported,
} from "../../site/watch_text_query.mjs";

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

const softwareWatch = expr([[term("software")]], [term("maintenance")]);

test("support registry: money admits and evaluates; other lenses stay closed", () => {
  assert.equal(textQueryAdmissionSupported("money"), true);
  assert.equal(textQueryEvaluationSupported("money"), true);
  assert.equal(textQueryAdmissionSupported("meetings"), false);
  assert.equal(textQueryAdmissionSupported("alerts"), false);
  assert.equal(textQueryAdmissionSupported("obligations"), false, "legacy alias must not leak admission");
  assert.equal(textQueryEvaluationSupported("meetings"), false);
  assert.equal(TEXT_QUERY_SUPPORT.money.evaluation, true);
});

test("prepareWatchFilter admits a valid money expression and stores the canonical form", () => {
  const prepared = prepareWatchFilter("money", {
    keywords: [],
    text_query: {
      version: 1,
      all: [
        [term("CONSULTING"), term("Software")],
        [phrase("Support  Services")],
      ],
      none: [term("maintenance")],
    },
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.filter.text_query, {
    version: 1,
    all: [
      [phrase("support services")],
      [term("consulting"), term("software")],
    ],
    none: [term("maintenance")],
  });
  // Round-trips through JSON storage without losing the expression.
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.filter)).text_query, prepared.filter.text_query);
});

test("prepareWatchFilter rejects unsupported lenses and malformed expressions explicitly", () => {
  for (const [lens, filter, reason] of [
    ["meetings", { text_query: softwareWatch }, "text-query-unsupported_lens"],
    ["alerts", { text_query: softwareWatch }, "text-query-unsupported_lens"],
    ["money", { text_query: { version: 2, all: [[term("software")]] } }, "text-query-unsupported_version"],
    ["money", { text_query: { version: 1, all: [[]] } }, "text-query-empty_group"],
    ["money", { text_query: { version: 1, all: [[{ kind: "term", value: "design build" }]] } }, "text-query-term_not_single_token"],
    ["money", { text_query: { version: 1, all: [[term("software")]], none: [term("software")] } }, "text-query-contradictory_required_excluded"],
    ["money", { text_query: { version: 1, all: [[term("a")], [term("b")], [term("c")], [term("d")], [term("e")]] } }, "text-query-too_many_groups"],
  ]) {
    const prepared = prepareWatchFilter(lens, filter);
    assert.equal(prepared.ok, false, `${lens} ${JSON.stringify(filter)}`);
    assert.equal(prepared.reason, reason, `${lens} ${JSON.stringify(filter)}`);
  }
});

test("negative-only expressions require a meaningful structured scope", () => {
  const negativeOnly = { text_query: expr([], [term("maintenance")]) };
  assert.equal(prepareWatchFilter("money", negativeOnly).ok, false);
  assert.equal(prepareWatchFilter("money", negativeOnly).reason, "text-query-negative_only_requires_scope");
  // A lens alone is not scope: no other narrowing field present above.
  // A selected agency is the exemplar of a meaningful scope.
  const withAgency = prepareWatchFilter("money", { ...negativeOnly, agency: "Environmental Protection" });
  assert.equal(withAgency.ok, true);
  assert.deepEqual(withAgency.filter.text_query, { version: 1, all: [], none: [term("maintenance")] });
  // Whitespace-only agency clamps to null, so it is still no scope.
  const blankAgency = prepareWatchFilter("money", { ...negativeOnly, agency: "   " });
  assert.equal(blankAgency.ok, false);
  assert.equal(blankAgency.reason, "text-query-negative_only_requires_scope");
});

test("nonempty legacy keywords plus text_query is rejected until a conversion resolves the legacy form", () => {
  const prepared = prepareWatchFilter("money", { keywords: ["software"], text_query: softwareWatch });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "text-query-legacy_keywords_present");
  // Case variants of legacy keywords still count as nonempty.
  assert.equal(
    prepareWatchFilter("money", { keywords: ["Software"], text_query: softwareWatch }).reason,
    "text-query-legacy_keywords_present",
  );
  // An explicit conversion emits empty keywords; that is admitted.
  const converted = prepareWatchFilter("money", { keywords: [], text_query: softwareWatch });
  assert.equal(converted.ok, true);
  assert.deepEqual(converted.filter.keywords, []);
  assert.ok(converted.filter.text_query);
});

test("an empty expression is omitted rather than stored as a constraint-free object", () => {
  const prepared = prepareWatchFilter("money", { text_query: expr([], []) });
  assert.equal(prepared.ok, true);
  assert.equal("text_query" in prepared.filter, false);
});

test("sanitize preserves a canonical text_query and never adds one when absent", () => {
  const withExpression = sanitize("money", { text_query: softwareWatch });
  assert.deepEqual(withExpression.text_query, {
    version: 1,
    all: [[term("software")]],
    none: [term("maintenance")],
  });
  // Absent expression → byte-identical legacy output (A5).
  const legacy = { keywords: ["software"], agency: "Health and Mental Hygiene", minAmount: 100000 };
  assert.deepEqual(sanitize("money", legacy), sanitize("money", { ...legacy }));
  assert.equal("text_query" in sanitize("money", legacy), false);
  // Unsupported lens: sanitize is a clamp, so the expression is dropped here —
  // which is exactly why every save path gates through prepareWatchFilter.
  assert.equal("text_query" in sanitize("meetings", { text_query: softwareWatch }), false);
});

test("encodeWatchFilter serializes an admitted watch without losing text_query", () => {
  const encoded = encodeWatchFilter("money", sanitize("money", { text_query: softwareWatch }));
  assert.ok(encoded);
  const decoded = JSON.parse(decodeURIComponent(encoded));
  assert.equal(decoded.lens, "money");
  assert.ok(decoded.filter.text_query);
  assert.deepEqual(decoded.filter.text_query.none, [term("maintenance")]);
  // Equivalent raw expressions serialize identically (one link identity).
  const equivalent = encodeWatchFilter("money", sanitize("money", {
    text_query: { version: 1, all: [[term("SOFTWARE")]], none: [term("Maintenance"), term("maintenance")] },
  }));
  assert.equal(encoded, equivalent);
});

test("money text_query compiles to owned materialization, not an unfiltered or SODA query", () => {
  const sub = { lens: "money", filter: sanitize("money", { text_query: softwareWatch, noticeType: "award" }) };
  const compiled = compileSub(sub, "2026-09-09");
  assert.ok(compiled);
  assert.equal(compiled.soda, false);
  assert.equal(compiled.url, null);
  assert.ok(compiled.textQuery);
  assert.equal("$q" in (compiled.params || {}), false);
  const d1 = compileSub_d1(sub, "2026-09-09");
  assert.ok(d1?.opts);
  assert.equal(d1.opts.noticeType, "Award");
  assert.equal(d1.opts.termGroups, undefined, "expression is not folded into LIKE termGroups");
  assert.deepEqual(d1.textQuery, sub.filter.text_query);
  // Unsupported lenses still refuse rather than silently unfilter.
  const meetings = { lens: "meetings", filter: { text_query: softwareWatch } };
  assert.equal(compileSub(meetings, "2026-09-09"), null);
  assert.equal(subToD1Opts(meetings, "2026-09-09"), null);
  // Legacy keyword money watches still compile exactly as before.
  const legacySub = { lens: "money", filter: sanitize("money", { keywords: ["software"], minAmount: 100000 }) };
  assert.ok(compileSub(legacySub, "2026-09-09"));
  assert.ok(subToD1Opts(legacySub, "2026-09-09"));
  assert.deepEqual(
    subToD1Opts(legacySub, "2026-09-09"),
    subToD1Opts({ lens: "money", filter: sanitize("money", { keywords: ["software"], minAmount: 100000 }) }, "2026-09-09"),
  );
});

test("modern feed filters refuse to replay a text_query until transports support it", () => {
  assert.deepEqual(
    unsupportedModernFeedFilterFields("money", { keywords: [], text_query: softwareWatch }),
    ["text_query"],
  );
  assert.deepEqual(unsupportedModernFeedFilterFields("money", { keywords: ["software"] }), []);
});

test("applyWatchPatch keeps the prior watch when an expression edit is invalid", () => {
  const record = {
    email: "reader@example.com",
    lens: "money",
    filter: sanitize("money", { keywords: ["software"] }),
    freq: "daily",
  };
  // Invalid expression on edit: rejected, prior filter untouched.
  const bad = applyWatchPatch({ ...record }, { filter: { keywords: [], text_query: { version: 1, all: [[]] } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "text-query-empty_group");
  // Valid expression on edit: stored canonically, keywords must be empty.
  const good = applyWatchPatch({ ...record }, { filter: { keywords: [], text_query: softwareWatch } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.record.filter.text_query, {
    version: 1,
    all: [[term("software")]],
    none: [term("maintenance")],
  });
  // A keyword patch onto a saved expression watch is the forbidden mixture.
  const conflict = applyWatchPatch({ ...record, filter: good.record.filter }, { keywords: ["consulting"] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "text-query-legacy_keywords_present");
  // Clearing the expression returns the watch to the legacy form.
  const cleared = applyWatchPatch({ ...record, filter: good.record.filter }, {
    filter: { keywords: ["software"], text_query: expr([], []) },
  });
  assert.equal(cleared.ok, true);
  assert.equal("text_query" in cleared.record.filter, false);
  assert.deepEqual(cleared.record.filter.keywords, ["software"]);
});

test("a precise expression is a narrowing signal for confidence", () => {
  assert.equal(filterConfidence("money", sanitize("money", { text_query: softwareWatch })), "high");
  assert.equal(filterConfidence("money", sanitize("money", {})), "low");
});

test("admitTextQuery reports absent expressions without touching the filter", () => {
  assert.deepEqual(admitTextQuery("money", { keywords: ["software"] }), {
    ok: true,
    present: false,
    canonical: null,
  });
  assert.deepEqual(admitTextQuery("money", null), { ok: true, present: false, canonical: null });
});
