import assert from "node:assert/strict";
import test from "node:test";

import { meetingsBrowseFromModel } from "../capabilities/meetings.mjs";
import { compileSub, rowsForCompiledQuery, scopedMeetingWatchEvaluation, scopedMeetingWatchRows } from "../worker/src/lib/compile.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";
import { handleFeed } from "../worker/src/feed.mjs";
import { handleMcp } from "../worker/src/mcp.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  AVAILABILITY,
  CROSS_SOURCE_PARITY_FIXTURE,
  EXPECTED_EXCLUSION_COUNTS,
  EXPECTED_IDENTITIES,
  PROJECTED_ROWS,
  TODAY,
  crossSourceEnv,
  crossSourceModel,
  expectedExcludedIdentities,
} from "./helpers/meeting_availability_cross_source_corpus.mjs";

function ids(rows) {
  return rows.map((row) => row.meeting_id).sort();
}

async function mcpRows() {
  const response = await handleMcp(new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.12" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "browse_meetings",
        arguments: { from: "2026-10-01", to: "2026-10-31", availability: AVAILABILITY, limit: 50 },
      },
    }),
  }), crossSourceEnv());
  const payload = await response.json();
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  assert.equal(payload.result.isError, undefined, JSON.stringify(payload.result));
  return payload.result.structuredContent.results;
}

async function feedBodies() {
  const filter = encodeURIComponent(JSON.stringify({ availability: AVAILABILITY }));
  const bodies = await Promise.all(["/feed.json", "/feed.xml", "/feed.ics"].map(async (pathname) => {
    const response = await handleFeed(new Request(`https://api.cityscroll.org${pathname}?lens=meetings&filter=${filter}`), crossSourceEnv(), {});
    const body = await response.text();
    assert.equal(response.status, 200, `${pathname}: ${body}`);
    return [pathname, body];
  }));
  return Object.fromEntries(bodies);
}

function parseFeedIdentities(bodies) {
  const unfoldedIcs = bodies["/feed.ics"].replace(/\r?\n[ ]/g, "");
  return {
    feed_json: JSON.parse(bodies["/feed.json"]).items.map((item) => item.id).sort(),
    feed_atom: [...bodies["/feed.xml"].matchAll(/<id>tag:[^,]+,\d{4}:([^<]+)<\/id>/g)].map((match) => match[1]).sort(),
    feed_ics: [...unfoldedIcs.matchAll(/UID:([^\r\n]+)@[^\r\n]+/g)].map((match) => match[1]).sort(),
  };
}

function buildParityReceipt({ surfaces, exclusions, sourceCoverage }) {
  return {
    schema: "cityscroll.meeting_availability_parity_receipt.v1",
    corpus_schema: CROSS_SOURCE_PARITY_FIXTURE.schema,
    source_coverage: sourceCoverage,
    expected: {
      accepted_identities: EXPECTED_IDENTITIES,
      exclusion_counts: EXPECTED_EXCLUSION_COUNTS,
    },
    observed: { surfaces, exclusions },
  };
}

export function assertParityReceipt(receipt) {
  for (const [surface, values] of Object.entries(receipt.observed.surfaces)) {
    assert.deepEqual(values, EXPECTED_IDENTITIES, `${surface} identity set diverged`);
  }
  assert.deepEqual(receipt.observed.exclusions, EXPECTED_EXCLUSION_COUNTS, "availability exclusion counts diverged");
  return receipt;
}

test("one retained corpus preserves meeting identities across every supported projection", async () => {
  await withPinnedClock("2026-09-01T12:00:00.000Z", async () => {
    const prepared = prepareWatchFilter("meetings", { availability: AVAILABILITY });
    assert.equal(prepared.ok, true);
    const watch = { lens: "meetings", filter: prepared.filter };
    const previewEvaluation = scopedMeetingWatchEvaluation(watch.filter, TODAY, PROJECTED_ROWS);
    const compiled = compileSub(watch, TODAY);
    assert.notEqual(compiled, null);
    const [mcp, email, bodies] = await Promise.all([
      mcpRows(),
      rowsForCompiledQuery(compiled, crossSourceEnv()),
      feedBodies(),
    ]);
    const browse = meetingsBrowseFromModel(crossSourceModel(), {
      from: "2026-10-01", to: "2026-10-31", availability: AVAILABILITY,
      attendanceModes: [], limit: 50,
    });
    const surfaces = {
      resident: ids(browse.results),
      machine: ids(mcp),
      preview: ids(scopedMeetingWatchRows(watch.filter, TODAY, PROJECTED_ROWS)),
      delivery: ids(email),
      ...parseFeedIdentities(bodies),
    };
    const receipt = buildParityReceipt({
      surfaces,
      exclusions: previewEvaluation.availability,
      sourceCoverage: crossSourceModel().sources,
    });
    assertParityReceipt(receipt);
    assert.equal(JSON.parse(JSON.stringify(receipt)).schema, "cityscroll.meeting_availability_parity_receipt.v1");
    for (const identity of expectedExcludedIdentities()) {
      for (const [surface, values] of Object.entries(surfaces)) {
        assert.equal(values.includes(identity), false, `${surface} admitted excluded ${identity}`);
      }
    }
  });
});

test("the parity runner fails loudly on identity or exclusion-count drift", () => {
  const good = buildParityReceipt({
    surfaces: Object.fromEntries(["resident", "machine", "preview", "delivery", "feed_json", "feed_atom", "feed_ics"]
      .map((surface) => [surface, EXPECTED_IDENTITIES])),
    exclusions: EXPECTED_EXCLUSION_COUNTS,
    sourceCoverage: crossSourceModel().sources,
  });
  assert.doesNotThrow(() => assertParityReceipt(good));
  assert.throws(() => assertParityReceipt({
    ...good,
    observed: { ...good.observed, surfaces: { ...good.observed.surfaces, machine: [EXPECTED_IDENTITIES[0]] } },
  }), /machine identity set diverged/);
  assert.throws(() => assertParityReceipt({
    ...good,
    observed: { ...good.observed, exclusions: { ...good.observed.exclusions, unknown_start: 0 } },
  }), /availability exclusion counts diverged/);
});
