import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildFollowingViewModel,
  canonicalFollowingScope,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import templates from "../site/data/watch_templates.json" with { type: "json" };
import moneyOpen from "../site/data/money_default_open.json" with { type: "json" };
import rulesOpen from "../site/data/rules_domain_observations.json" with { type: "json" };
import meetingsOpen from "../site/data/meetings_domain_observations.json" with { type: "json" };
import { mergeCanonicalProcurementBrowseRows } from "../site/contract_search_bridge.mjs";
import {
  buildResultsBackedWatchTemplateRegistry,
  countOpenMatches,
} from "../site/following_suggestions.mjs";

const registry = {
  templates: [
    {
      id: "empty-set",
      title: "Empty set",
      watches: [{ lens: "rules", filter: { agency: "Missing agency" } }],
    },
    {
      id: "live-set",
      title: "Live set",
      watches: [
        { label: "Buildings rules", lens: "rules", filter: { agency: "Buildings" } },
        { label: "Construction keywords", lens: "rules", filter: { keywords: ["construction safety"] } },
      ],
    },
  ],
};

const openSources = {
  money: { open_as_of: "2026-08-12", notices: [] },
  rules: {
    retrieved_at: "2026-08-12T12:00:00Z",
    rows: [
      { request_id: "r-open", agency_name: "Buildings", short_title: "Construction safety rule", status: "open" },
      { request_id: "r-other", agency_name: "Other agency", short_title: "Other rule", status: "open" },
      { request_id: "r-archived", agency_name: "Buildings", short_title: "Construction safety archive", status: "archived" },
    ],
  },
  meetings: { retrieved_at: "2026-08-12T12:00:00Z", rows: [] },
};

test("starter sets omit zero-result candidates and carry the true open count", () => {
  const suggested = buildResultsBackedWatchTemplateRegistry(registry, openSources, { todayISO: "2026-08-12" });
  assert.deepEqual(suggested.templates.map((template) => template.id), ["live-set"]);
  assert.equal(suggested.templates[0].matchCount, 1);
  assert.equal(suggested.templates[0].watches.length, 2);
  assert.match(suggested.templates[0].resultsHref, /^\/browse\/rules\//);

  const html = renderFollowingDocument(buildFollowingViewModel({}, suggested));
  assert.match(html, /data-pack-id="live-set"/);
  assert.match(html, /data-pack-match-count="1">1 matching records/);
  assert.match(html, /data-following-pack-watch/);
  assert.match(html, /following-pack-results-link[^>]*>.*See matches/);
  assert.doesNotMatch(html, /data-pack-id="empty-set"/);
});

test("archived-only snapshots produce no suggested sets", () => {
  const archivedSources = {
    money: { open_as_of: "2026-08-12", notices: [{ request_id: "m-old", due_date: "2026-08-01", status: "archived" }] },
    rules: { retrieved_at: "2026-08-12T12:00:00Z", rows: [{ request_id: "r-old", agency_name: "Buildings", short_title: "Construction safety", status: "archived" }] },
    meetings: { retrieved_at: "2026-08-12T12:00:00Z", rows: [{ request_id: "h-old", event_date: "2026-08-01T10:00:00Z", status: "closed" }] },
  };
  const suggested = buildResultsBackedWatchTemplateRegistry(registry, archivedSources, { todayISO: "2026-08-12" });
  assert.deepEqual(suggested.templates, []);
});

test("missing source stays null instead of becoming a fabricated zero", () => {
  const result = countOpenMatches(
    { lens: "rules", filter: { agency: "Buildings" } },
    { money: { notices: [] } },
    { todayISO: "2026-08-12" },
  );
  assert.equal(result.count, null);
});

test("the committed Worker registry is the source-row results-backed projection", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/procurement_browse_rows.json", import.meta.url), "utf8"));
  const expected = buildResultsBackedWatchTemplateRegistry(templates, {
    money: { ...moneyOpen, notices: mergeCanonicalProcurementBrowseRows(moneyOpen.notices, source.rows) },
    rules: rulesOpen,
    meetings: meetingsOpen,
  });
  const artifact = JSON.parse(readFileSync(new URL("../site/data/following_procurement_suggestions.json", import.meta.url), "utf8"));

  assert.equal(artifact.schema, "cityscroll.following_suggestions.v1");
  assert.deepEqual(
    { schema_version: artifact.schema_version, pattern: artifact.pattern, results_backed: artifact.results_backed, generated_from: artifact.generated_from, templates: artifact.templates },
    expected,
  );
  assert.equal(Object.hasOwn(artifact, "rows"), false);
});

test("watch-set cards stay a Following suggestion kind and do not subscribe on their own", () => {
  const suggested = buildResultsBackedWatchTemplateRegistry(registry, openSources, { todayISO: "2026-08-12" });
  const html = renderFollowingDocument(buildFollowingViewModel({}, suggested));
  assert.match(html, /data-following-packs-disclosure/);
  assert.match(html, /data-pack-id="live-set"/);
  assert.match(html, /Each watch is made only after you check and submit/);
  assert.doesNotMatch(html.match(/data-pack-id="live-set"[\s\S]*?<\/article>/)?.[0] || "", /data-following-subscribe-form/);
  assert.match(html, /data-pack-id="live-set"[\s\S]*following-pack-link[^>]*href="\/following\/packs\/live-set\/"/);
  const suggestion = watchFromFollowingParams(new URLSearchParams("lens=land&filter=%7B%22keywords%22%3A%5B%22rezoning%22%5D%7D&freq=weekly"));
  const direct = watchFromFollowingParams(new URLSearchParams("lens=land&q=rezoning&freq=weekly"));
  assert.deepEqual(canonicalFollowingScope(suggestion), canonicalFollowingScope(direct));
});
