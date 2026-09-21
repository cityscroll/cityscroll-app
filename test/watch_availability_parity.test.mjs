import assert from "node:assert/strict";
import { test } from "node:test";

import { meetingsBrowseFromModel } from "../capabilities/meetings.mjs";
import { compileSub, rowsForCompiledQuery, scopedMeetingWatchRows } from "../worker/src/lib/compile.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";
import { handleFeed } from "../worker/src/feed.mjs";
import { handleMcp } from "../worker/src/mcp.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  EXCLUDED_WATCH_MEETING_IDENTITIES,
  EXPECTED_WATCH_MEETING_IDENTITIES,
  TODAY,
  WATCH_AVAILABILITY,
  WATCH_CORPUS_ROWS,
  watchCorpusEnv,
  watchCorpusModel,
} from "./helpers/watch_availability_corpus.mjs";

async function mcpBrowseMeetings() {
  const response = await handleMcp(
    new Request("https://api.cityscroll.org/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browse_meetings",
          arguments: {
            from: "2026-10-01",
            to: "2026-10-31",
            availability: WATCH_AVAILABILITY,
            limit: 25,
          },
        },
      }),
    }),
    watchCorpusEnv(),
  );
  const payload = await response.json();
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  assert.equal(payload.result.isError, undefined, JSON.stringify(payload.result));
  return payload.result.structuredContent.results;
}

async function feedResponse(pathname) {
  const filter = encodeURIComponent(JSON.stringify({ availability: WATCH_AVAILABILITY }));
  const response = await handleFeed(
    new Request(`https://api.cityscroll.org${pathname}?lens=meetings&filter=${filter}`),
    watchCorpusEnv(),
    {},
  );
  if (response.status !== 200) {
    assert.fail(`${pathname}: status ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

test("browse, MCP, preview, email compilation, JSON, Atom, and ICS accept one identity set for the frozen corpus", async () => {
  await withPinnedClock(`${TODAY}T12:00:00.000Z`, async () => {
    const prepared = prepareWatchFilter("meetings", { availability: WATCH_AVAILABILITY });
    assert.equal(prepared.ok, true);
    const watch = { lens: "meetings", filter: prepared.filter };
    const expected = EXPECTED_WATCH_MEETING_IDENTITIES.slice().sort();

    // Browse: the structured browse capability over the shared read model.
    const browse = meetingsBrowseFromModel(watchCorpusModel(), {
      from: "2026-10-01", to: "2026-10-31", availability: WATCH_AVAILABILITY,
      attendanceModes: [], limit: 25,
    });

    // MCP: the browse_meetings tool through the MCP handler, its own provider
    // and KV-loaded model — compared as an identity set, not a schema string.
    const mcpRows = await mcpBrowseMeetings();

    // Preview: the alert-preview materializer over the raw corpus.
    const preview = scopedMeetingWatchRows(watch.filter, TODAY, WATCH_CORPUS_ROWS);

    // Email compilation: the digest cron's replay pair — compileSub descriptor
    // plus rowsForCompiledQuery loading the corpus through the route read
    // model manifest — not a second call to the preview materializer.
    const compiled = compileSub(watch, TODAY);
    assert.notEqual(compiled, null);
    const emailRows = await rowsForCompiledQuery(compiled, watchCorpusEnv());

    // Feed formats: each served end to end through the feed handler over the
    // same corpus, so an excluded row must be shown absent from each format.
    const [jsonBody, atomBody, icsBody] = await Promise.all([
      feedResponse("/feed.json"),
      feedResponse("/feed.xml"),
      feedResponse("/feed.ics"),
    ]);

    const surfaces = {
      browse: browse.results.map((row) => row.meeting_id).sort(),
      mcp: mcpRows.map((row) => row.meeting_id).sort(),
      preview: preview.map((row) => row.meeting_id).sort(),
      email: emailRows.map((row) => row.meeting_id).sort(),
      feed_json: JSON.parse(jsonBody).items.map((item) => item.id).sort(),
      feed_atom: [...atomBody.matchAll(/<id>tag:[^,]+,\d{4}:([^<]+)<\/id>/g)].map((match) => match[1]).sort(),
      feed_ics: [...icsBody.matchAll(/UID:([^\r\n]+)@[^\r\n]+/g)].map((match) => match[1]).sort(),
    };
    for (const [surface, identities] of Object.entries(surfaces)) {
      assert.deepEqual(identities, expected, `${surface} accepted identities`);
    }

    // Named absence: every corpus identity availability excludes is absent
    // from every surface's payload, not merely missing from the parsed list.
    for (const id of EXCLUDED_WATCH_MEETING_IDENTITIES) {
      assert.equal(jsonBody.includes(id), false, `feed JSON carries excluded ${id}`);
      assert.equal(atomBody.includes(id), false, `feed Atom carries excluded ${id}`);
      assert.equal(icsBody.includes(id), false, `feed ICS carries excluded ${id}`);
      assert.equal(emailRows.some((row) => row.meeting_id === id), false, `email compilation carries excluded ${id}`);
      assert.equal(preview.some((row) => row.meeting_id === id), false, `preview carries excluded ${id}`);
      assert.equal(browse.results.some((row) => row.meeting_id === id), false, `browse carries excluded ${id}`);
      assert.equal(mcpRows.some((row) => row.meeting_id === id), false, `MCP carries excluded ${id}`);
    }
  });
});

test("cancellation, date-only, conflict, and reschedule updates cannot widen delivery", () => {
  const prepared = prepareWatchFilter("meetings", { availability: WATCH_AVAILABILITY });
  const rows = scopedMeetingWatchRows(prepared.filter, TODAY, WATCH_CORPUS_ROWS);
  assert.deepEqual(rows.map((row) => row.meeting_id), EXPECTED_WATCH_MEETING_IDENTITIES);
  assert.equal(rows.some((row) => row.meeting_id === "meeting:rescheduled"), false);
  assert.equal(rows.some((row) => row.status === "cancelled"), false);
  assert.equal(rows.some((row) => row.schedule?.status === "date_only"), false);
  assert.equal(rows.some((row) => row.schedule?.status === "conflicted"), false);
});
