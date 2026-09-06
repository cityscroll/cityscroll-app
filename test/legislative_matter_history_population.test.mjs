/**
 * Every retained exact matter has a complete available history.
 *
 * The contract under test is tools/build_legislative_matter_documents.mjs and
 * the document it feeds: the retained Council meeting materialization holds 66
 * exact matters, and every one of them gets a local history rather than a
 * single privileged matter getting one while the other sixty five stay
 * invisible.
 *
 * Everything asserted here reads the committed offline corpus
 * (site/data/meeting_outcomes_snapshot.json) and the artifacts built from it.
 * The counts describe that retained corpus at its own data vintage. They are
 * not a claim about live publisher coverage, and the absence of a later action
 * for a matter is not a claim that the matter is finished.
 *
 * Coverage here is derived from the fixture's own membership: the expected
 * population is recomputed from the snapshot by a second, deliberately
 * different traversal, and the builder's output is compared against it. No test
 * in this file names a list of matters that are allowed to be published.
 *
 *   node --test test/legislative_matter_history_population.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLegislativeMatterIndex,
  buildLegislativeMatterLookup,
} from "../tools/build_legislative_matter_documents.mjs";
import edgeWorker, { edgeRequestKind } from "../site/pages_edge.mjs";
import { buildMatterAppearanceCalendarView } from "../site/legislative_matter_calendar.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";
import { publishedMatterIds, resolveMatterDestination } from "../site/legislative_matter_availability.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const snapshot = read("../site/data/meeting_outcomes_snapshot.json");
const lookup = read("../site/data/legislative_matter_lookup.json");
const index = read("../site/data/legislative_matter_index.json");

/**
 * The expected population, recomputed from the fixture by a traversal that
 * shares no code with the builder: walk every notice, collect each matter's
 * (event, notice) pairs, and let set arithmetic decide what an appearance is.
 * This is the oracle the generated artifact is measured against.
 */
function derivePopulation(source) {
  const byMatter = new Map();
  for (const [requestId, record] of Object.entries(source.by_notice || {})) {
    for (const matter of record.matters || []) {
      const id = String(matter.matter_id);
      if (!byMatter.has(id)) byMatter.set(id, []);
      byMatter.get(id).push({ event_id: String(record.event.event_id), request_id: requestId, matter, record });
    }
  }
  const matters = new Map();
  for (const [id, rows] of byMatter) {
    const events = new Map();
    for (const row of rows) {
      if (!events.has(row.event_id)) events.set(row.event_id, []);
      events.get(row.event_id).push(row);
    }
    matters.set(id, { id, rows, events });
  }
  const appearanceCounts = [...matters.values()].map((entry) => entry.events.size);
  return {
    matters,
    matter_count: matters.size,
    references: [...byMatter.values()].reduce((sum, rows) => sum + rows.length, 0),
    appearances: appearanceCounts.reduce((sum, count) => sum + count, 0),
    two_event_histories: appearanceCounts.filter((count) => count === 2).length,
    one_event_histories: appearanceCounts.filter((count) => count === 1).length,
  };
}

const population = derivePopulation(snapshot);
const built = buildLegislativeMatterLookup(snapshot);

/** Serves the committed lookup the way the Pages edge reads it. */
const lookupEnv = {
  ASSETS: {
    async fetch(request) {
      return new URL(request.url).pathname === "/data/legislative_matter_lookup.json"
        ? Response.json(lookup)
        : new Response("missing", { status: 404 });
    },
  },
};

function documentFor(matterId, payload = lookup) {
  return buildLegislativeMatterDocument(payload, matterId);
}

function htmlFor(matterId, payload = lookup) {
  return renderLegislativeMatterDocument(documentFor(matterId, payload), {
    currentHref: `https://cityscroll.org/matters/${matterId}/`,
    today: String(payload.generated_at || "").slice(0, 10),
  });
}

// ---------------------------------------------------------------------------
// A1 — the whole retained population is published, and the counts are the ones
// an independent traversal of the fixture produces.
// ---------------------------------------------------------------------------

test("every retained exact matter is published, with the counts the fixture itself yields", () => {
  assert.deepEqual(
    Object.keys(lookup.matters).sort(),
    [...population.matters.keys()].sort(),
    "the published population is the retained population",
  );

  const appearanceTotal = Object.values(lookup.matters)
    .reduce((sum, entry) => sum + entry.appearances.length, 0);
  const histogram = Object.values(lookup.matters)
    .map((entry) => entry.appearances.length)
    .reduce((counts, size) => counts.set(size, (counts.get(size) || 0) + 1), new Map());
  const referenceTotal = Object.values(lookup.matters)
    .reduce((sum, entry) => sum + entry.appearances
      .reduce((inner, appearance) => inner + appearance.notice_references.length, 0), 0);

  assert.equal(Object.keys(lookup.matters).length, population.matter_count);
  assert.equal(appearanceTotal, population.appearances);
  assert.equal(histogram.get(2) || 0, population.two_event_histories);
  assert.equal(histogram.get(1) || 0, population.one_event_histories);
  assert.equal(referenceTotal, population.references, "every notice reference survives coalescing");

  // The same figures stated absolutely, so a corpus that silently changes shape
  // is visible rather than self-justifying.
  assert.equal(population.matter_count, 66);
  assert.equal(population.appearances, 76);
  assert.equal(population.two_event_histories, 10);
  assert.equal(population.one_event_histories, 56);
  assert.equal(population.references, 78);

  // The committed artifact is what this builder produces from this input.
  assert.deepEqual(built, lookup, "site/data/legislative_matter_lookup.json is current");
  assert.deepEqual(buildLegislativeMatterIndex(built), index, "the published index is current");
  assert.deepEqual(
    Object.keys(index.matters).sort(),
    Object.keys(lookup.matters).sort(),
    "the index and the lookup describe one population",
  );
});

test("the matter that was already published keeps its history unchanged in shape", () => {
  const entry = lookup.matters["78605"];
  assert.equal(entry.appearances.length, 2);
  assert.deepEqual(entry.appearances.map((appearance) => appearance.event.event_id), ["22342", "22375"]);
  assert.deepEqual(entry.appearances.map((appearance) => appearance.event.date), ["2026-04-22", "2026-05-19"]);
  const view = documentFor("78605");
  assert.equal(view.appearances.length, 2);
  assert.equal(view.appearances[0].vote.person_count, 9);
});

// ---------------------------------------------------------------------------
// A2 — every published route answers, and a one-appearance page says what it
// does not know instead of implying that nothing more will happen.
// ---------------------------------------------------------------------------

test("all 66 published matter routes resolve", async () => {
  const ids = Object.keys(lookup.matters);
  assert.equal(ids.length, 66);
  const statuses = new Map();
  for (const id of ids) {
    assert.equal(edgeRequestKind(`https://cityscroll.org/matters/${id}/`), "matter");
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org/matters/${id}/`), lookupEnv);
    statuses.set(id, response.status);
    if (response.status === 200) {
      const body = await response.text();
      assert.match(body, new RegExp(`data-matter-id="${id}"`), `${id} renders its own identity`);
    }
  }
  assert.deepEqual([...new Set(statuses.values())], [200], "no published matter route answers anything but 200");
});

test("a single-appearance history states what has been located without claiming nothing follows", () => {
  const singles = Object.values(lookup.matters).filter((entry) => entry.appearances.length === 1);
  assert.equal(singles.length, 56);

  const html = htmlFor("79200");
  assert.equal(documentFor("79200").appearances.length, 1, "79200 is the single-appearance canary");
  assert.match(html, /No later official step has been located for it\./);
  assert.match(html, /not a finding that the matter is settled/);
  assert.match(html, /data-matter-appearance-count="1"/);

  // The page must not convert an absence of retained records into an outcome.
  for (const claim of [
    /no (?:further|future|later|additional) action (?:exists|will|is expected)/i,
    /nothing (?:further|more) (?:happened|will happen)/i,
    /\bcase closed\b/i,
    /\bconcluded\b/i,
    /\bfinal action\b/i,
  ]) {
    assert.doesNotMatch(html, claim, `a one-appearance page must not assert ${claim}`);
  }

  // And every single-appearance page carries the same disclosure, not just this one.
  for (const entry of singles) {
    assert.match(htmlFor(entry.matter_id), /No later official step has been located for it\./);
  }
});

// ---------------------------------------------------------------------------
// A3 — one event, however many notices announced it.
// ---------------------------------------------------------------------------

test("two notices for one meeting produce one appearance with both references kept", () => {
  const references = ["20260422047", "20260430007"];
  for (const matterId of ["78758", "78759"]) {
    const entry = lookup.matters[matterId];
    assert.equal(entry.appearances.length, 1, `${matterId} attends event 22396 once`);
    const [appearance] = entry.appearances;
    assert.equal(appearance.event.event_id, "22396");
    assert.deepEqual(
      appearance.notice_references.map((notice) => notice.request_id).sort(),
      references,
      `${matterId} keeps both notice references as provenance`,
    );
    assert.deepEqual(appearance.source_receipt.request_ids.sort(), references);

    const html = htmlFor(matterId);
    for (const requestId of references) {
      assert.match(html, new RegExp(`data-notice-reference="${requestId}"`), `${requestId} is inspectable`);
      assert.match(html, new RegExp(`href="/notices/${requestId}/"`));
    }
    assert.match(html, /data-notice-reference-count="2"/);
    assert.match(html, /not separate hearings/);
    assert.equal((html.match(/data-matter-appearance="22396"/g) || []).length, 1, "one appearance, not two");

    // The calendar reads the same appearance list, so a repeated reference
    // cannot inflate a month cell either.
    const calendar = buildMatterAppearanceCalendarView(documentFor(matterId), { today: "2026-08-10" });
    assert.equal(calendar.render, false, "one appearance does not meet the density rule");
  }

  // The two matters stay separate identities sharing one event, not one merged
  // record: same event, same day, different matter, different address.
  assert.notEqual(lookup.matters["78758"].matter_href, lookup.matters["78759"].matter_href);
  assert.notEqual(lookup.matters["78758"].title, lookup.matters["78759"].title);
});

// ---------------------------------------------------------------------------
// A4 — identity is the publisher id; the label is only a label.
// ---------------------------------------------------------------------------

function syntheticSnapshot(records) {
  const by_notice = {};
  for (const [requestId, record] of Object.entries(records)) {
    by_notice[requestId] = {
      request_id: requestId,
      snapshot_state: "present",
      event: record.event,
      matters: record.matters,
    };
  }
  return { schema: "cityscroll.meeting_outcomes_snapshot.v1", generated_at: "2026-08-10T13:08:13.019Z", by_notice };
}

const EVENT_ONE = {
  event_id: "90001",
  name: "Subcommittee on Zoning and Franchises",
  date: "2026-03-02",
  url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=90001",
  documents: [],
};
const EVENT_TWO = {
  event_id: "90002",
  name: "Subcommittee on Zoning and Franchises",
  date: "2026-04-06",
  url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=90002",
  documents: [],
};

test("identical titles on different matter ids stay separate histories", () => {
  const sharedTitle = "Zoning, 1 Example Plaza, Queens (C 260001 ZMQ).";
  const result = buildLegislativeMatterLookup(syntheticSnapshot({
    90000001: {
      event: EVENT_ONE,
      matters: [
        {
          matter_id: "910001",
          matter_file: "LU 0001-2026",
          title: sharedTitle,
          matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=910001",
          actions: ["Laid Over by Subcommittee"],
          outcome: "Laid Over by Subcommittee",
          votes: null,
        },
        {
          matter_id: "910002",
          matter_file: "LU 0002-2026",
          title: sharedTitle,
          matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=910002",
          actions: ["Hearing Held by Committee"],
          outcome: "Hearing Held by Committee",
          votes: null,
        },
      ],
    },
  }));
  assert.deepEqual(Object.keys(result.matters).sort(), ["910001", "910002"]);
  assert.equal(result.matters["910001"].title, result.matters["910002"].title);
  assert.notEqual(result.matters["910001"].matter_ref, result.matters["910002"].matter_ref);
  assert.deepEqual(result.matters["910001"].appearances.map((a) => a.event.event_id), ["90001"]);
  assert.deepEqual(result.matters["910002"].appearances.map((a) => a.event.event_id), ["90001"]);
  assert.deepEqual(result.identity_collisions, []);
});

test("a renamed matter keeps one history, shows the latest label, and records the earlier one", () => {
  const result = buildLegislativeMatterLookup(syntheticSnapshot({
    90000001: {
      event: EVENT_ONE,
      matters: [{
        matter_id: "910003",
        matter_file: "LU 0003-2026",
        title: "Zoning, 2 Example Plaza, Queens (C 260002 ZMQ).",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=910003",
        actions: ["Laid Over by Subcommittee"],
        outcome: "Laid Over by Subcommittee",
        votes: null,
      }],
    },
    90000002: {
      event: EVENT_TWO,
      matters: [{
        matter_id: "910003",
        matter_file: "LU 0003-2026 (A)",
        title: "Zoning, 2 Example Plaza (amended), Queens (C 260002 ZMQ).",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=910003",
        actions: ["Approved by Subcommittee"],
        outcome: "Approved by Subcommittee",
        votes: null,
      }],
    },
  }));

  const entry = result.matters["910003"];
  assert.ok(entry, "a changed label does not fail the build");
  assert.equal(entry.appearances.length, 2, "one identity, one history");
  assert.equal(entry.matter_file, "LU 0003-2026 (A)", "the latest observed label is displayed");
  assert.match(entry.title, /amended/);
  assert.equal(entry.label_revisions.length, 1);
  assert.equal(entry.label_revisions[0].matter_file, "LU 0003-2026");
  assert.equal(entry.label_revisions[0].observed_event_date, "2026-03-02");

  const html = renderLegislativeMatterDocument(buildLegislativeMatterDocument(result, "910003"), { today: "2026-08-10" });
  assert.match(html, /LU 0003-2026 \(A\)/);
  assert.match(html, /Previously listed as LU 0003-2026/);
});

test("a matter id claimed by two publisher tenants publishes neither and says so", () => {
  const result = buildLegislativeMatterLookup(syntheticSnapshot({
    90000001: {
      event: EVENT_ONE,
      matters: [{
        matter_id: "910004",
        matter_file: "LU 0004-2026",
        title: "One tenant's matter.",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=910004",
        actions: ["Laid Over by Subcommittee"],
        outcome: "Laid Over by Subcommittee",
        votes: null,
      }],
    },
    90000002: {
      event: EVENT_TWO,
      matters: [{
        matter_id: "910004",
        matter_file: "ITEM 0004-2026",
        title: "Another tenant's matter that happens to share a number.",
        matter_url: "https://elsewhere.legistar.com/Gateway.aspx?M=L&ID=910004",
        actions: ["Hearing Held by Committee"],
        outcome: "Hearing Held by Committee",
        votes: null,
      }],
    },
  }));
  assert.equal(result.matters["910004"], undefined, "an ambiguous id addresses no route");
  assert.deepEqual(result.identity_collisions, [{
    matter_id: "910004",
    reason: "same_matter_id_across_publisher_tenants",
    claimants: ["legistar:elsewhere:matter:910004", "legistar:nyc:matter:910004"],
  }]);
  assert.deepEqual(lookup.identity_collisions, [], "the retained corpus has no such ambiguity");
});

// ---------------------------------------------------------------------------
// A5 — the ten retained sequences read in source-event order, and the page says
// only what the record says.
// ---------------------------------------------------------------------------

test("every two-event history shows the earlier laid-over step before the later approval", () => {
  const sequences = Object.values(lookup.matters).filter((entry) => entry.appearances.length === 2);
  assert.equal(sequences.length, 10);
  for (const entry of sequences) {
    const [earlier, later] = entry.appearances;
    assert.ok(earlier.event.date < later.event.date, `${entry.matter_id} is ordered by source event date`);
    assert.match(earlier.outcome, /Laid Over/i, `${entry.matter_id} begins laid over`);
    assert.match(later.outcome, /Approved by Subcommittee/i, `${entry.matter_id} ends approved by subcommittee`);

    // The rendered order matches the retained order, so a reader meets the
    // earlier step first.
    const html = htmlFor(entry.matter_id);
    assert.ok(
      html.indexOf(`data-matter-appearance="${earlier.event.event_id}"`)
        < html.indexOf(`data-matter-appearance="${later.event.event_id}"`),
      `${entry.matter_id} renders the earlier appearance first`,
    );
  }
});

test("a subcommittee approval is never described as adoption, an agency reply, or a result of testimony", () => {
  for (const entry of Object.values(lookup.matters)) {
    const html = htmlFor(entry.matter_id);
    for (const claim of [
      /final adoption/i,
      /adopted by the council/i,
      /enacted/i,
      /became law/i,
      /agency (?:response|replied|responded)/i,
      /testimony|testif/i,
      /because (?:you|residents) spoke/i,
      /your (?:comment|testimony)/i,
    ]) {
      assert.doesNotMatch(html, claim, `${entry.matter_id} must not claim ${claim}`);
    }
  }
});

// ---------------------------------------------------------------------------
// A6 — coverage comes from the fixture, and nothing is privileged by name.
// ---------------------------------------------------------------------------

test("the builder publishes by membership rather than by a named target", () => {
  const source = readFileSync(new URL("../tools/build_legislative_matter_documents.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /"7[0-9]{4}"/, "no matter id is named in the builder");
  assert.doesNotMatch(source, /\bTARGET\b/, "no privileged publication target remains");
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|https?:\/\/[a-z]/i, "the builder reads no publisher");

  // A matter that leaves the corpus leaves the publication, and one that enters
  // it is published, with no list to edit in either direction.
  const trimmed = {
    ...snapshot,
    by_notice: Object.fromEntries(
      Object.entries(snapshot.by_notice).filter(([requestId]) => requestId !== "20260707022"),
    ),
  };
  const rebuilt = buildLegislativeMatterLookup(trimmed);
  const expected = derivePopulation(trimmed);
  assert.deepEqual(Object.keys(rebuilt.matters).sort(), [...expected.matters.keys()].sort());
  assert.ok(!Object.hasOwn(rebuilt.matters, "79200"), "dropping the only notice for a matter unpublishes it");
});

test("the shared availability rule answers over the published population", () => {
  const published = publishedMatterIds();
  assert.deepEqual([...published].sort(), Object.keys(lookup.matters).sort());
  for (const id of Object.keys(lookup.matters)) {
    const destination = resolveMatterDestination({ matter_id: id });
    assert.equal(destination.availability, "local_history");
    assert.equal(destination.href, `/matters/${id}/`);
  }
});

// ---------------------------------------------------------------------------
// Provenance, presentation parity, and failure states.
// ---------------------------------------------------------------------------

test("every appearance keeps its publisher event, its notices, and its source vintage", () => {
  for (const entry of Object.values(lookup.matters)) {
    assert.match(entry.matter_ref, /^legistar:nyc:matter:\d+$/);
    assert.equal(entry.publisher_tenant, "nyc");
    assert.match(entry.matter_href, /^https:\/\/nyc\.legistar\.com\//);
    for (const appearance of entry.appearances) {
      assert.ok(appearance.event.event_id, "an appearance has a native event identity");
      assert.match(appearance.event.url, /^https:\/\//);
      assert.equal(appearance.source_receipt.snapshot_generated_at, snapshot.generated_at);
      assert.equal(appearance.source_receipt.input_artifact, "site/data/meeting_outcomes_snapshot.json");
      assert.ok(appearance.notice_references.length >= 1);
      for (const notice of appearance.notice_references) {
        assert.equal(snapshot.by_notice[notice.request_id].event.event_id, appearance.event.event_id);
      }
    }
  }
  assert.equal(lookup.generated_at, snapshot.generated_at);
  assert.equal(index.generated_at, snapshot.generated_at);
});

test("the calendar and the appearance list stay one presentation of one evidence set", () => {
  for (const entry of Object.values(lookup.matters)) {
    const view = documentFor(entry.matter_id);
    const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-08-10" });
    const html = htmlFor(entry.matter_id);
    // Below the shared density rule, no calendar furniture is drawn — and the
    // appearance list is always there regardless.
    assert.equal(calendar.render, false, `${entry.matter_id} does not meet the density rule`);
    assert.match(html, /id="matter-appearances"/);
    assert.equal(
      (html.match(/class="matter-appearance"/g) || []).length,
      entry.appearances.length,
      `${entry.matter_id} lists every retained appearance`,
    );
  }
});

test("the render manifest describes every capture without committing an image", () => {
  const manifest = read("../docs/evidence/legislative-matter-history-population/manifest.json");
  assert.equal(manifest.schema, "cityscroll.legislative_matter_history_evidence.v1");
  assert.equal(manifest.engineering_record, "cityscroll-engineering/legislative-matter-history-population");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.data_vintage, snapshot.generated_at);
  assert.equal(manifest.published_matter_count, Object.keys(lookup.matters).length);

  const specimens = new Set();
  const viewports = new Set();
  for (const row of manifest.files) {
    for (const field of ["name", "specimen", "route", "viewport", "revision", "data_vintage", "assertion", "observations", "sha256", "axe"]) {
      assert.ok(row[field] !== undefined, `${row.name} is missing ${field}`);
    }
    assert.match(row.name, /\.png$/);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.match(row.route, /^\/matters\/\d+\/$/);
    assert.equal(row.axe.passes, true, `${row.name} has an accessibility violation`);
    assert.doesNotMatch(JSON.stringify(row), /testimon|subscrib|final adoption/i);
    specimens.add(row.specimen);
    viewports.add(row.viewport.join("x"));
  }
  assert.deepEqual([...viewports].sort(), ["1440x900", "390x844"]);
  for (const specimen of [
    "single-appearance-history",
    "two-appearance-history",
    "coalesced-notice-references",
    "unpublished-identity",
    "without-scripting",
    "keyboard-and-return",
    "modified-click",
    "two-hundred-percent-zoom",
  ]) {
    assert.ok(specimens.has(specimen), `missing capture specimen ${specimen}`);
  }
});

test("an unavailable generation is a stated absence, not a broken page", async () => {
  const emptyEnv = { ASSETS: { async fetch() { return new Response("missing", { status: 404 }); } } };
  const missing = await edgeWorker.fetch(new Request("https://cityscroll.org/matters/79200/"), emptyEnv);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /not in the current CityScroll materialization/);

  const malformedEnv = {
    ASSETS: { async fetch() { return Response.json({ schema: "something.else.v1", matters: {} }); } },
  };
  const malformed = await edgeWorker.fetch(new Request("https://cityscroll.org/matters/79200/"), malformedEnv);
  assert.equal(malformed.status, 404);

  // An identity the generation does not carry answers 404 rather than an empty
  // history that looks like a matter with nothing in it.
  const absent = await edgeWorker.fetch(new Request("https://cityscroll.org/matters/999999/"), lookupEnv);
  assert.equal(absent.status, 404);
  assert.equal(documentFor("999999"), null);
});
