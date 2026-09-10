import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  TEXT_QUERY_LIMITS,
  TEXT_QUERY_SCHEMA,
  matchesTextQuery,
  textQueryTokens,
  validateTextQuery,
} from "../site/watch_text_query.mjs";

// Frozen real-record fixtures (public City Record rows) — see
// test/fixtures/watch_text_query/README.md for provenance. Exact expected ID
// sets come from the reviewed matching evidence over this retained snapshot.
const titleSnapshot = JSON.parse(readFileSync(
  new URL("./fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const meetingFixture = JSON.parse(readFileSync(
  new URL("./fixtures/watch_text_query/rat_inspection_meeting.json", import.meta.url),
  "utf8",
));

const titledRows = titleSnapshot.rows.filter((r) => r.short_title);
const awardRows = titledRows.filter((r) => r.type_of_notice_description === "Award");

assert.equal(titleSnapshot.row_count, 378, "frozen snapshot row count");
assert.equal(titledRows.length, 340, "frozen snapshot titled rows");
assert.equal(awardRows.length > 0, true);

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

function selectIds(expression, rows = titledRows) {
  return rows
    .filter((r) => matchesTextQuery([r.short_title], expression))
    .map((r) => r.request_id)
    .sort();
}

test("frozen title projection: term over award titles (E1)", () => {
  assert.deepEqual(selectIds(expr([[term("software")]]), awardRows), [
    "20260709018",
    "20260713010",
    "20260713036",
    "20260723004",
  ]);
});

test("frozen title projection: literal exclusion removes only matching titles (E2)", () => {
  assert.deepEqual(selectIds(expr([[term("software")]], [term("maintenance")]), awardRows), [
    "20260709018",
    "20260713010",
    "20260713036",
  ]);
  // The removed row is the one whose title literally contains the excluded token.
  const removed = awardRows.find((r) => r.request_id === "20260723004");
  assert.equal(removed.short_title, "SolarWinds Software Maintenance");
  // A software title without the excluded word survives.
  assert.equal(
    matchesTextQuery(["CRO-660 Software, Hardware, and Database Support Services"], expr([[term("software")]], [term("maintenance")])),
    true,
  );
});

test("frozen title projection: alternative group widens, exclusion still applies (E3)", () => {
  assert.deepEqual(
    selectIds(expr([[term("software"), term("consulting")]], [term("maintenance")]), awardRows),
    ["20260709018", "20260713010", "20260713024", "20260713036"],
  );
  // The consulting alternative excluded by 'maintenance' is IBM Maximo Upgrade,
  // Maintenance & Consulting Services.
  assert.equal(matchesTextQuery(
    ["IBM Maximo Upgrade, Maintenance & Consulting Services"],
    expr([[term("software"), term("consulting")]], [term("maintenance")]),
  ), false);
});

test("frozen title projection: two required groups stay AND, never widen to OR (E4)", () => {
  assert.deepEqual(selectIds(expr([[term("software")], [term("consulting")]]), awardRows), []);
  // Same expression with the groups in one OR group is non-empty — proving the
  // AND case is genuinely empty, not a predicate bug.
  assert.ok(selectIds(expr([[term("software"), term("consulting")]]), awardRows).length > 0);
});

test("frozen title projection: exact phrase matches adjacent token sequence only (E5)", () => {
  assert.deepEqual(selectIds(expr([[phrase("construction management")]])), [
    "20260710009",
    "20260714009",
    "20260715010",
    "20260727024",
    "20260728022",
  ]);
  // 'management' alone or 'construction' alone must not satisfy the phrase.
  assert.equal(matchesTextQuery(["General Construction Job Order Contract"], expr([[phrase("construction management")]])), false);
  assert.equal(matchesTextQuery(["Citywide Program Management Office"], expr([[phrase("construction management")]])), false);
});

test("frozen title projection: whole-token rat matches zero titles (E6)", () => {
  assert.deepEqual(selectIds(expr([[term("rat")]])), []);
});

test("whole-token rat rejects Strategy and Integrated, accepts the rat-inspection meeting (A2)", () => {
  const ratWatch = expr([[term("rat")]]);
  // Real titles where 'rat' appears only inside larger tokens.
  assert.equal(matchesTextQuery([
    "Community Violence Intervention and Prevention (CVIP) Strategy and Procurement Development RFP",
  ], ratWatch), false);
  assert.equal(matchesTextQuery(["Juvenile Justice Integrity Program Integrated Services RFP"], ratWatch), false);
  // Also pinned directly from the frozen snapshot rows.
  const integrated = titledRows.filter((r) => /integrated/i.test(r.short_title));
  assert.ok(integrated.length >= 3);
  assert.equal(integrated.every((r) => !matchesTextQuery([r.short_title], ratWatch)), true);
  // Positive control: the whole word appears in a retained public-hearing title.
  const meeting = meetingFixture.rows[0];
  assert.equal(meeting.request_id, "20260803009");
  assert.equal(matchesTextQuery([meeting.short_title], ratWatch), true);
});

test("phrases survive formatting HTML and punctuation, never span field boundaries (A2)", () => {
  const constructionManagement = expr([[phrase("construction management")]]);
  assert.equal(matchesTextQuery(["Construction <b>Management</b> services"], constructionManagement), true);
  assert.equal(matchesTextQuery(["Design-Build services"], expr([[phrase("design build")]])), true);
  assert.equal(matchesTextQuery(["Design &amp; Build services"], expr([[phrase("design build")]])), true);
  // A phrase cannot bridge the end of one field and the start of the next.
  assert.equal(matchesTextQuery(["Construction", "Management services"], constructionManagement), false);
  // Punctuation separates tokens but does not satisfy adjacency by itself.
  assert.equal(matchesTextQuery(["Construction, unrelated, Management"], constructionManagement), false);
});

test("literal atoms apply no synonym or plural expansion (A2)", () => {
  // Plurals: v1 is literal — a singular term does not match a plural-only token.
  assert.equal(matchesTextQuery(["Rats in the Park"], expr([[term("rat")]])), false);
  assert.equal(matchesTextQuery(["Support Services Renewal"], expr([[term("service")]])), false);
  // No reviewed synonym expansion (school → education) on exclusions or positives.
  assert.equal(matchesTextQuery(["School education services"], expr([[term("education")]], [term("school")])), false);
  assert.equal(matchesTextQuery(["Adult Education Program"], expr([[term("school")]])), false);
  // Excluded phrase excludes only the phrase, not its words alone.
  assert.equal(matchesTextQuery(["Software maintenance"], expr([[term("software")]], [phrase("hardware maintenance")])), true);
});

test("tokenizer strips HTML, decodes entities, NFKC-normalizes and lowercases", () => {
  assert.deepEqual(textQueryTokens("<b>Design</b>&nbsp;Build — phase&nbsp;2"), ["design", "build", "phase", "2"]);
  assert.deepEqual(textQueryTokens("SOLARWINDS Software Maintenance"), ["solarwinds", "software", "maintenance"]);
  assert.deepEqual(textQueryTokens("ﬁxes"), ["fixes"]); // NFKC composes the ligature
});

test("validation rejects malformed expressions without dropping constraints", () => {
  const reject = (raw, code) => {
    const result = validateTextQuery(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
  };
  reject(null, "not_object");
  reject([], "not_object");
  reject({ version: 1, all: [], extra: true }, "unknown_key");
  reject({ version: 2, all: [[term("software")]] }, "unsupported_version");
  reject({ version: "1", all: [[term("software")]] }, "unsupported_version");
  reject({ version: 1, all: {} }, "malformed_groups");
  reject({ version: 1, all: [[term("software")]], none: {} }, "malformed_exclusions");
  reject({ version: 1, all: [[]] }, "empty_group");
  reject({ version: 1, all: [["software"]] }, "malformed_atom");
  reject({ version: 1, all: [[{ kind: "regex", value: "software" }]] }, "unknown_atom_kind");
  reject({ version: 1, all: [[{ kind: "term", value: "software", id: 1 }]] }, "unknown_atom_key");
  reject({ version: 1, all: [[{ kind: "term", value: "" }]] }, "empty_atom");
  reject({ version: 1, all: [[{ kind: "term", value: "design build" }]] }, "term_not_single_token");
  reject({ version: 1, all: [[{ kind: "phrase", value: "   " }]] }, "empty_atom");
  reject({ version: 1, all: [[term("software")]], none: [term("software")] }, "contradictory_required_excluded");
  reject({
    version: 1,
    all: [[term("software"), term("consulting")]],
    none: [term("software"), term("consulting")],
  }, "contradictory_required_excluded");
  // A group is contradictory only when EVERY alternative is excluded.
  assert.equal(validateTextQuery({
    version: 1,
    all: [[term("software"), term("hardware")]],
    none: [term("software")],
  }).ok, true);
  // Over-limit input is rejected, never truncated.
  reject({
    version: 1,
    all: [[term("a")], [term("b")], [term("c")], [term("d")], [term("e")]],
  }, "too_many_groups");
  reject({ version: 1, all: [[term("a"), term("b"), term("c"), term("d"), term("e")]] }, "group_too_large");
  reject({
    version: 1,
    all: [[term("software")]],
    none: [term("a1"), term("b2"), term("c3"), term("d4"), term("e5"), term("f6"), term("g7"), term("h8"), term("i9")],
  }, "too_many_exclusions");
  reject({ version: 1, all: [[{ kind: "phrase", value: "a".repeat(121) }]] }, "atom_too_long");
  // 16 distinct max-length atoms stay under every per-atom bound but over the
  // whole-expression bound: rejected whole, never truncated.
  reject({
    version: 1,
    all: "abcdefghijklmnop".match(/.{4}/g).map((quad) => quad.split("").map((c) => ({ kind: "phrase", value: c.repeat(120) }))),
  }, "expression_too_long");
  // Negative-only requires a meaningful structured scope at admission.
  reject({ version: 1, all: [], none: [term("maintenance")] }, "negative_only_requires_scope");
  assert.equal(validateTextQuery(
    { version: 1, all: [], none: [term("maintenance")] },
    { structuredScope: true },
  ).ok, true);
  // Empty expression with no exclusions canonicalizes to "omit".
  assert.deepEqual(validateTextQuery({ version: 1, all: [], none: [] }), { ok: true, canonical: null });
});

test("limits match the shared contract", () => {
  assert.deepEqual(TEXT_QUERY_LIMITS, {
    maxPositiveGroups: 4,
    maxAlternativesPerGroup: 4,
    maxExclusions: 8,
    maxAtomChars: 120,
    maxTotalChars: 2000,
  });
  assert.equal(TEXT_QUERY_SCHEMA.schema, "cityscroll.watch_text_query.v1");
});

test("canonicalization: reordering and case-equivalence collapse to one identity", () => {
  const a = validateTextQuery({
    version: 1,
    all: [
      [{ kind: "term", value: "Software" }, { kind: "term", value: "CONSULTING" }],
      [{ kind: "phrase", value: "support   services" }],
    ],
    none: [{ kind: "term", value: "Maintenance" }],
  });
  const b = validateTextQuery({
    version: 1,
    all: [
      [{ kind: "phrase", value: "<b>Support Services</b>" }],
      [{ kind: "term", value: "consulting" }, { kind: "term", value: "software" }, { kind: "term", value: "software" }],
    ],
    none: [{ kind: "term", value: "maintenance" }, { kind: "term", value: "maintenance" }],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.canonical, b.canonical);
  assert.deepEqual(a.canonical, {
    version: 1,
    all: [
      [{ kind: "phrase", value: "support services" }],
      [{ kind: "term", value: "consulting" }, { kind: "term", value: "software" }],
    ],
    none: [{ kind: "term", value: "maintenance" }],
  });
  // An intentional difference stays different.
  const c = validateTextQuery({
    version: 1,
    all: [[term("software")]],
    none: [term("maintenance")],
  });
  assert.notDeepEqual(a.canonical, c.canonical);
});

test("predicate evaluates a canonical expression identically to its raw form", () => {
  const raw = expr([[term("software"), term("consulting")]], [term("maintenance")]);
  const { canonical } = validateTextQuery(raw);
  for (const title of [
    "SolarWinds Software Maintenance",
    "CRO-660 Software, Hardware, and Database Support Services",
    "IT Consulting for SNAP Payment Error Rate (CAP) Reduction",
    "IBM Maximo Upgrade, Maintenance & Consulting Services",
  ]) {
    assert.equal(
      matchesTextQuery([title], raw),
      matchesTextQuery([title], canonical),
      title,
    );
  }
});

test("empty expression is vacuously true and omitted by callers", () => {
  assert.equal(matchesTextQuery(["anything"], validateTextQuery({ version: 1, all: [], none: [] }).canonical), true);
});
