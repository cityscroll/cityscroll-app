import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import edgeWorker, { edgeRequestKind } from "../site/pages_edge.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";
import { renderMeetingOutcomesFirstPaint } from "../site/meeting_outcomes_static.mjs";
import { buildLegislativeMatterLookup } from "../tools/build_legislative_matter_documents.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const lookup = JSON.parse(readFileSync(new URL("../site/data/legislative_matter_lookup.json", import.meta.url), "utf8"));
// Frozen slice — scheduled refresh rewrites the live lookup when the publisher
// join window rolls; named appearance / roll-call assertions stay on this fixture.
const frozen78605Lookup = JSON.parse(readFileSync(new URL("./fixtures/legislative-matter-window-pins/civic_law_matter_78605_lookup.json", import.meta.url), "utf8"));

test("matter lookup rebuild stays coherent with the committed live lookup", () => {
  const built = buildLegislativeMatterLookup(snapshot);
  assert.deepEqual(built, lookup);
});

test("matter lookup materializes the exact LU 0056-2026 appearances", () => {
  const view = buildLegislativeMatterDocument(frozen78605Lookup, "78605");
  assert.equal(view.id, "78605");
  assert.equal(view.matter_file, "LU 0056-2026");
  // Fixture retains the 2026-05-19 approval appearance used for roll-call render.
  assert.deepEqual(view.appearances.map((row) => [row.event.event_id, row.event.date, row.outcome]), [
    ["22375", "2026-05-19", "Approved by Subcommittee"],
  ]);
});

test("matter render exposes named roll calls and fail-closed committee identity", () => {
  const view = buildLegislativeMatterDocument(frozen78605Lookup, "78605");
  const html = renderLegislativeMatterDocument(view);
  assert.match(html, /data-civic-object-kind="legislative-matter"/);
  assert.match(html, /data-matter-id="78605"/);
  // The one roll call this matter retains is the 2026-05-19 subcommittee approval.
  // A member the Council recorded as Absent is counted and labelled as not
  // present, not as an abstention.
  assert.match(html, /8 yes · 0 no · 1 not present/);
  assert.match(html, /not present, recorded as Absent/);
  assert.match(html, /Farah N\. Louis/);
  // Nine named rows on the roll-call action. The hearing-held action on the same
  // appearance recorded no roll call and says so once.
  assert.equal((html.match(/data-pivot-relation-label="votes_on"/g) || []).length, 9);
  assert.equal((html.match(/No roll call was recorded on this action\./g) || []).length, 1);
  assert.match(html, /data-committee-join-state="unresolved_no_explicit_body_id"/);
  assert.doesNotMatch(html, /href="\/committees\/34\/"/);
  assert.match(html, /Gateway\.aspx\?M=L&amp;ID=78605/);
  assert.match(html, /22375/);
});

test("committee link is emitted only for an explicit BodyId", () => {
  const payload = structuredClone(frozen78605Lookup);
  payload.matters["78605"].appearances[0].event.body_id = "34";
  const view = buildLegislativeMatterDocument(payload, "78605");
  const html = renderLegislativeMatterDocument(view);
  assert.match(html, /href="\/committees\/34\/"/);
  assert.match(html, /data-pivot-target-id="34"/);
  assert.match(html, /data-committee-join-state="matched_exact_body_id"/);
});

test("meeting outcome and Pages edge resolve the matter route", async () => {
  const meetingHtml = renderMeetingOutcomesFirstPaint(snapshot, "20260428021");
  assert.match(meetingHtml, /href="\/matters\/78605\/"/);
  assert.equal(edgeRequestKind("https://cityscroll.org/matters/78605/"), "matter");

  const env = {
    ASSETS: {
      async fetch(request) {
        if (new URL(request.url).pathname === "/data/legislative_matter_lookup.json") return Response.json(lookup);
        return new Response("missing", { status: 404 });
      },
    },
  };
  const response = await edgeWorker.fetch(new Request("https://cityscroll.org/matters/78605/"), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-matter-id="78605"/);

  const missing = await edgeWorker.fetch(new Request("https://cityscroll.org/matters/99999/"), env);
  assert.equal(missing.status, 404);
});
