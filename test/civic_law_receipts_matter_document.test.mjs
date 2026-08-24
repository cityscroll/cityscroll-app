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

test("matter lookup materializes the exact LU 0056-2026 appearances", () => {
  const built = buildLegislativeMatterLookup(snapshot);
  assert.deepEqual(built, lookup);
  const view = buildLegislativeMatterDocument(lookup, "78605");
  assert.equal(view.id, "78605");
  assert.equal(view.matter_file, "LU 0056-2026");
  assert.deepEqual(view.appearances.map((row) => [row.event.event_id, row.event.date, row.outcome]), [
    ["22342", "2026-04-22", "Laid Over by Subcommittee"],
    ["22375", "2026-05-19", "Approved by Subcommittee"],
  ]);
});

test("matter render exposes named roll calls and fail-closed committee identity", () => {
  const view = buildLegislativeMatterDocument(lookup, "78605");
  const html = renderLegislativeMatterDocument(view);
  assert.match(html, /data-civic-object-kind="legislative-matter"/);
  assert.match(html, /data-matter-id="78605"/);
  assert.match(html, /8 yes · 0 no · 1 abstain/);
  assert.match(html, /Farah N\. Louis/);
  assert.equal((html.match(/data-pivot-relation-label="votes_on"/g) || []).length, 18);
  assert.match(html, /data-committee-join-state="unresolved_no_explicit_body_id"/);
  assert.doesNotMatch(html, /href="\/committees\/34\/"/);
  assert.match(html, /Gateway\.aspx\?M=L&amp;ID=78605/);
  assert.match(html, /22342/);
  assert.match(html, /22375/);
});

test("committee link is emitted only for an explicit BodyId", () => {
  const payload = structuredClone(lookup);
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
