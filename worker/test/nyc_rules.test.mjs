import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRuleView,
  handleRules,
  looksLikeBotChallenge,
  RULES_KV_KEY,
  RULES_RSS_HEADERS,
  RULES_RSS_UA,
  RULES_RSS_URL,
  refreshRules,
  rulesViewNeedsRefresh,
} from "../src/rules.mjs";
import {
  agencyAbbr,
  classifyStage,
  joinRulesToNotices,
  matchRuleToNotice,
  normalizeRuleItem,
  parseRssItems,
  titleOverlap,
} from "../src/lib/rules.mjs";

// ---------------------------------------------------------------------------
// RSS fixture helpers
// ---------------------------------------------------------------------------

function rssItem(opts) {
  const parts = [`<title>${opts.title}</title>`];
  parts.push(`<link>${opts.url || "https://rules.cityofnewyork.us/rule/test/"}</link>`);
  parts.push(`<pubDate>${opts.pubDate || "Tue, 28 Jul 2026 12:00:00 +0000"}</pubDate>`);
  if (opts.agency_name) parts.push(`<agency_name>${opts.agency_name}</agency_name>`);
  if (opts.rule_status != null) parts.push(`<rule_status>${opts.rule_status}</rule_status>`);
  if (opts.rule_adoption_date) parts.push(`<rule_adoption_date>${opts.rule_adoption_date}</rule_adoption_date>`);
  if (opts.comment_by_date) parts.push(`<comment_by_date>${opts.comment_by_date}</comment_by_date>`);
  if (opts.hearing_date_1) parts.push(`<hearing_date_1>${opts.hearing_date_1}</hearing_date_1>`);
  if (opts.rule_short_summary) parts.push(`<rule_short_summary><![CDATA[${opts.rule_short_summary}]]></rule_short_summary>`);
  if (opts.content) parts.push(`<content:encoded><![CDATA[${opts.content}]]></content:encoded>`);
  parts.push(`<wfw:commentRss>${opts.url || "https://rules.cityofnewyork.us/rule/test/"}/feed/</wfw:commentRss>`);
  parts.push(`<slash:comments>${opts.commentCount || 0}</slash:comments>`);
  return `<item>${parts.join("")}</item>`;
}

function rssFeed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NYC Rules</title><link>https://rules.cityofnewyork.us</link>${items.join("")}</channel></rss>`;
}

function cityRecordNotice(opts) {
  return {
    request_id: opts.request_id || "CR-001",
    start_date: opts.start_date || "2026-07-28T00:00:00.000",
    agency_name: opts.agency_name || "Department of Transportation",
    type_of_notice_description: opts.type || "Agency Rules",
    section_name: "Agency Rules",
    short_title: opts.short_title || "Proposed rule amendment",
    additional_description_1: opts.additional_description_1 || "",
    additional_description_2: "",
    additional_description_3: "",
  };
}

function memoryKV() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, value); },
  };
}

// ---------------------------------------------------------------------------
// RSS parsing
// ---------------------------------------------------------------------------

test("parseRssItems extracts standard and custom fields from each item", () => {
  const xml = rssFeed([
    rssItem({
      title: "Natural Gas Detectors",
      url: "https://rules.cityofnewyork.us/rule/gas-detectors/",
      pubDate: "Tue, 28 Jul 2026 13:32:11 +0000",
      agency_name: "HPD",
      rule_status: "1",
      rule_adoption_date: "20270101",
      comment_by_date: "20250716",
      hearing_date_1: "20250716",
      rule_short_summary: "Requires natural gas detectors.",
      commentCount: 5,
    }),
  ]);
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  const raw = items[0];
  assert.equal(raw.title, "Natural Gas Detectors");
  assert.equal(raw.link, "https://rules.cityofnewyork.us/rule/gas-detectors/");
  assert.equal(raw.agency_name, "HPD");
  assert.equal(raw.rule_adoption_date, "20270101");
  assert.equal(raw.comment_by_date, "20250716");
  assert.equal(raw.hearing_date_1, "20250716");
  assert.equal(raw.rule_short_summary, "Requires natural gas detectors.");
});

test("normalizeRuleItem converts compact dates to ISO and resolves agency abbreviation", () => {
  const raw = parseRssItems(rssFeed([rssItem({
    title: "Parking at Commercial Meters",
    agency_name: "DOT",
    comment_by_date: "20260901",
    hearing_date_1: "20260901",
    rule_short_summary: "Amend parking rules.",
  })]))[0];
  const rule = normalizeRuleItem(raw);
  assert.equal(rule.agency_abbr, "DOT");
  assert.equal(rule.comment_by_date, "2026-09-01");
  assert.equal(rule.hearing_date, "2026-09-01");
  assert.equal(rule.adoption_published_at, null);
  assert.ok(rule.summary.length > 0);
});

test("normalizeRuleItem falls back to content:encoded when custom fields are absent", () => {
  const raw = parseRssItems(rssFeed([rssItem({
    title: "Energy Code Amendments",
    content: '<p><em>Agency: </em><strong>Department of Buildings</strong></p><p><em>Comment-By Date: </em><strong>08-27-2026</strong></p><p><em>Hearing Dates: </em><strong>08-27-2026</strong></p>',
    rule_short_summary: null,
  })]))[0];
  const rule = normalizeRuleItem(raw);
  assert.equal(rule.agency_abbr, "DOB");
  assert.equal(rule.comment_by_date, "2026-08-27");
  assert.equal(rule.hearing_date, "2026-08-27");
});

test("normalizeRuleItem keeps content:encoded effective date distinct from adoption", () => {
  const raw = parseRssItems(rssFeed([rssItem({
    title: "Adopted Rule",
    content: '<p><em>Agency: </em><strong>Housing Preservation and Development</strong></p><p><em>Rule Effective Date: </em><strong>01-01-2027</strong></p><p>Notice of Adoption</p>',
    rule_adoption_date: null,
    rule_short_summary: null,
  })]))[0];
  const rule = normalizeRuleItem(raw);
  assert.equal(rule.adoption_published_at, "2026-07-28T12:00:00.000Z");
  assert.equal(rule.effective_date, "2027-01-01");
  assert.equal(rule.notice_type, "adoption");
});

// ---------------------------------------------------------------------------
// Lifecycle classification
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-29T12:00:00Z");

test("classifyStage returns proposed for a rule with no lifecycle dates", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Brand New Rule", agency_name: "DOT",
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "proposed");
});

test("classifyStage returns comment-open when comment deadline is in the future", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Open Comment", agency_name: "DOT", comment_by_date: "20260901",
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "comment-open");
});

test("classifyStage returns hearing when only a future hearing date exists", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Hearing Soon", agency_name: "DOT", hearing_date_1: "20260815",
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "hearing");
});

test("classifyStage returns adopted for an adoption item whose effective date is future", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Adopted Future", agency_name: "HPD", rule_status: "1", rule_adoption_date: "20270101",
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "adopted");
});

test("classifyStage returns effective when the official effective date has passed", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Effective Now", agency_name: "HPD", rule_status: "1", rule_adoption_date: "20260101",
    content: '<p><em>Rule Effective Date: </em><strong>02-01-2026</strong></p>',
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "effective");
});

test("classifyStage returns comment-closed when comment deadline has passed without adoption", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Closed Comments", agency_name: "DOT", comment_by_date: "20260701", hearing_date_1: "20260701",
  })]))[0]);
  assert.equal(classifyStage(rule, NOW), "comment-closed");
});

// ---------------------------------------------------------------------------
// Agency normalization
// ---------------------------------------------------------------------------

test("agencyAbbr resolves full City Record names to NYC Rules abbreviations", () => {
  assert.equal(agencyAbbr("Department of Transportation"), "DOT");
  assert.equal(agencyAbbr("Department of Buildings"), "DOB");
  assert.equal(agencyAbbr("Housing Preservation and Development"), "HPD");
  assert.equal(agencyAbbr("Department of Consumer and Worker Protection"), "DCWP");
  assert.equal(agencyAbbr("Department of Sanitation"), "DSNY");
  assert.equal(agencyAbbr("Department of City Planning"), "DCP");
  assert.equal(agencyAbbr("Taxi and Limousine Commission"), "TLC");
  assert.equal(agencyAbbr("DOT"), "DOT");
  assert.equal(agencyAbbr("Dept. of Transportation"), "DOT");
});

// ---------------------------------------------------------------------------
// Title overlap
// ---------------------------------------------------------------------------

test("titleOverlap measures shared meaningful tokens", () => {
  assert.ok(titleOverlap("FHV and Taxi Parking at Commercial Meters", "Taxi Parking at Commercial Vehicle Meters") > 0.4);
  assert.ok(titleOverlap("FHV Parking", "Energy Conservation Code") === 0);
});

// ---------------------------------------------------------------------------
// Join logic
// ---------------------------------------------------------------------------

test("matchRuleToNotice returns a high-confidence match on agency + date + title", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Taxi Parking at Commercial Meters",
    agency_name: "DOT",
    pubDate: "Thu, 23 Jul 2026 16:18:07 +0000",
    comment_by_date: "20260901",
  })]))[0]);
  const notice = cityRecordNotice({
    request_id: "CR-100",
    agency_name: "Department of Transportation",
    short_title: "Taxi Parking at Commercial Meters and Commercial Vehicle Markings",
    start_date: "2026-07-23T00:00:00.000",
  });
  const result = matchRuleToNotice(rule, notice, NOW);
  assert.ok(result.matched);
  assert.equal(result.confidence, "high");
});

test("matchRuleToNotice rejects different agencies", () => {
  const rule = normalizeRuleItem(parseRssItems(rssFeed([rssItem({
    title: "Gas Detectors", agency_name: "HPD",
  })]))[0]);
  const notice = cityRecordNotice({ agency_name: "Department of Transportation" });
  const result = matchRuleToNotice(rule, notice, NOW);
  assert.ok(!result.matched);
});

test("joinRulesToNotices marks unmatched notices and rules explicitly", () => {
  const rules = [
    normalizeRuleItem(parseRssItems(rssFeed([rssItem({
      title: "Unmatched RSS Rule", agency_name: "DSNY", comment_by_date: "20260901",
    })]))[0]),
  ];
  const notices = [
    cityRecordNotice({ request_id: "CR-unmatched", agency_name: "Department of Transportation" }),
  ];
  const { matched, unmatchedNotices, unmatchedRules } = joinRulesToNotices(rules, notices, NOW);
  assert.equal(matched.length, 0);
  assert.equal(unmatchedNotices.length, 1);
  assert.equal(unmatchedRules.length, 1);
});

// ---------------------------------------------------------------------------
// Materialized view build
// ---------------------------------------------------------------------------

function multiSourceFetch(rssXml, cityRows, onRulesFetch) {
  return async (url, init) => {
    if (url.startsWith("https://rules.cityofnewyork.us/")) {
      if (onRulesFetch) onRulesFetch(url, init);
      return new Response(rssXml, { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    }
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify(cityRows), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

test("buildRuleView joins RSS items to City Record notices and preserves official links", async () => {
  const rss = rssFeed([
    rssItem({
      title: "Taxi Parking at Commercial Meters",
      url: "https://rules.cityofnewyork.us/rule/taxi-parking/",
      pubDate: "Thu, 23 Jul 2026 16:18:07 +0000",
      agency_name: "DOT",
      comment_by_date: "20260901",
      hearing_date_1: "20260901",
      rule_short_summary: "Amend commercial parking rules.",
      commentCount: 3,
    }),
    rssItem({
      title: "Unmatched Energy Code",
      url: "https://rules.cityofnewyork.us/rule/energy-code/",
      agency_name: "DOB",
      comment_by_date: "20260827",
    }),
  ]);
  const crRows = [
    cityRecordNotice({
      request_id: "CR-100",
      agency_name: "Department of Transportation",
      short_title: "Taxi Parking at Commercial Meters and Vehicle Markings",
      start_date: "2026-07-23T00:00:00.000",
    }),
    cityRecordNotice({
      request_id: "CR-200",
      agency_name: "Department of Sanitation",
      short_title: "Waste zone implementation dates",
      start_date: "2026-07-15T00:00:00.000",
    }),
  ];

  const view = await buildRuleView(multiSourceFetch(rss, crRows), NOW);

  assert.equal(view.schema_version, 2);
  assert.equal(view.source.enrichment.status, "ok");
  assert.equal(view.counts.total, 3);
  assert.equal(view.counts.matched, 1);
  assert.equal(view.counts.unmatched_notices, 1);
  assert.equal(view.counts.unmatched_rules, 1);

  const matched = view.rules.find((r) => r.join.matched);
  assert.ok(matched);
  assert.equal(matched.city_record.request_id, "CR-100");
  assert.equal(matched.nyc_rules.url, "https://rules.cityofnewyork.us/rule/taxi-parking/");
  assert.equal(matched.nyc_rules.comment_by_date, "2026-09-01");
  assert.equal(matched.nyc_rules.hearing_date, "2026-09-01");
  assert.deepEqual(matched.events.map((event) => event.event_type), [
    "proposal_published", "public_hearing", "comment_close",
  ]);
  assert.equal(matched.events.find((event) => event.event_type === "comment_close").alert.eligible, true);
  assert.equal(matched.stage, "comment-open");

  const unmatchedNotice = view.rules.find((r) => r.city_record && !r.join.matched);
  assert.ok(unmatchedNotice);
  assert.ok(unmatchedNotice.join.reason);
  assert.equal(unmatchedNotice.nyc_rules, null);
  assert.deepEqual(unmatchedNotice.events, []);

  const unmatchedRule = view.rules.find((r) => !r.city_record);
  assert.ok(unmatchedRule);
  assert.ok(unmatchedRule.join.reason);
  assert.ok(unmatchedRule.nyc_rules.url);
});

// ---------------------------------------------------------------------------
// Egress headers (empty UA → Cloudflare 403 on rules.cityofnewyork.us)
// ---------------------------------------------------------------------------

test("looksLikeBotChallenge detects Cloudflare interstitial HTML", () => {
  assert.equal(looksLikeBotChallenge("<!DOCTYPE html><title>Just a moment...</title>"), true);
  assert.equal(looksLikeBotChallenge('challenge-platform" data-ray'), true);
  assert.equal(looksLikeBotChallenge(rssFeed([rssItem({ title: "Ok", agency_name: "DOT" })])), false);
});

test("buildRuleView sends identifying User-Agent and Accept on the NYC Rules RSS request", async () => {
  let rulesInit = null;
  const rss = rssFeed([rssItem({
    title: "Metered Parking",
    agency_name: "DOT",
    comment_by_date: "20260901",
  })]);
  const view = await buildRuleView(
    multiSourceFetch(rss, [], (url, init) => {
      rulesInit = { url, init };
    }),
    NOW,
  );
  assert.equal(view.source.enrichment.status, "ok");
  assert.ok(rulesInit, "Rules RSS fetch should have been called");
  assert.equal(rulesInit.url, RULES_RSS_URL);
  assert.equal(rulesInit.init?.headers?.["User-Agent"], RULES_RSS_UA);
  assert.equal(rulesInit.init?.headers?.Accept, RULES_RSS_HEADERS.Accept);
  assert.match(RULES_RSS_UA, /cityscroll\.org/i);
  assert.ok(view.counts.unmatched_rules >= 1 || view.counts.matched >= 0);
  assert.ok(view.rules.some((r) => r.nyc_rules));
});

test("buildRuleView marks enrichment stale when RSS returns Cloudflare bot-challenge HTML", async () => {
  const challengeHtml = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
</head><body>Enable JavaScript</body></html>`;
  const fetchImpl = async (url) => {
    if (url.startsWith("https://rules.cityofnewyork.us/")) {
      return new Response(challengeHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([
        cityRecordNotice({ request_id: "CR-only", short_title: "City Record only rule" }),
      ]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const view = await buildRuleView(fetchImpl, NOW);
  assert.equal(view.source.enrichment.status, "stale");
  assert.match(view.source.enrichment.error, /bot challenge/i);
  assert.equal(view.counts.matched, 0);
  assert.equal(view.counts.unmatched_notices, 1);
  assert.equal(view.counts.unmatched_rules, 0);
});

// ---------------------------------------------------------------------------
// Stale RSS fallback
// ---------------------------------------------------------------------------

test("buildRuleView falls back to City Record only when RSS is unreachable", async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith("https://rules.cityofnewyork.us/")) {
      return new Response("502 Bad Gateway", { status: 502 });
    }
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([
        cityRecordNotice({ request_id: "CR-only", short_title: "City Record only rule" }),
      ]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const view = await buildRuleView(fetchImpl, NOW);
  assert.equal(view.source.enrichment.status, "stale");
  assert.ok(view.source.enrichment.error);
  assert.equal(view.counts.total, 1);
  assert.equal(view.counts.matched, 0);
  assert.equal(view.counts.unmatched_notices, 1);
  assert.equal(view.counts.unmatched_rules, 0);

  const record = view.rules[0];
  assert.ok(!record.join.matched);
  assert.ok(record.join.reason);
  assert.equal(record.city_record.request_id, "CR-only");
});

// ---------------------------------------------------------------------------
// KV round-trip + serve
// ---------------------------------------------------------------------------

test("rulesViewNeedsRefresh retries young views whose RSS enrichment is still stale", () => {
  const nowMs = Date.parse("2026-08-01T18:00:00.000Z");
  assert.equal(rulesViewNeedsRefresh(null, nowMs), true);
  assert.equal(rulesViewNeedsRefresh({ generated_at: "2026-08-01T17:00:00.000Z", source: { enrichment: { status: "ok" } } }, nowMs), false);
  assert.equal(rulesViewNeedsRefresh({
    generated_at: "2026-08-01T17:00:00.000Z",
    source: { enrichment: { status: "stale", error: "NYC Rules RSS 403" } },
  }, nowMs), true);
  // Older than MAX_AGE_MS (~36h) even when enrichment is ok.
  assert.equal(rulesViewNeedsRefresh({
    generated_at: "2026-07-30T17:00:00.000Z",
    source: { enrichment: { status: "ok" } },
  }, nowMs), true);
});

test("refresh writes the view to KV and the read route serves it", async () => {
  const rss = rssFeed([rssItem({
    title: "Test Rule", agency_name: "DOT", comment_by_date: "20260901",
  })]);
  const crRows = [cityRecordNotice({
    request_id: "CR-roundtrip",
    agency_name: "Department of Transportation",
    short_title: "Test Rule",
  })];
  const kv = memoryKV();

  // handleRules live-refreshes when generated_at is older than MAX_AGE_MS (~36h)
  // or enrichment is still stale. Use wall-clock "now" and an ok enrichment write
  // so the route serves the fixture write, not a live upstream pull.
  const result = await refreshRules({ ALERT_STATE: kv }, multiSourceFetch(rss, crRows), new Date());
  assert.equal(result.status, "success");
  assert.ok(kv.values.has(RULES_KV_KEY));

  const response = await handleRules(
    new Request("https://api.cityscroll.org/rules"),
    { ALERT_STATE: kv },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "public, max-age=1800");
  const body = await response.json();
  assert.ok(body.rules.length > 0);
  assert.equal(body.source.enrichment.status, "ok");
});

test("refreshRules returns skipped when no KV binding is configured", async () => {
  const rss = rssFeed([rssItem({ title: "Test", agency_name: "DOT" })]);
  const result = await refreshRules({}, multiSourceFetch(rss, []), NOW);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-kv");
});

test("handleRules rejects non-GET methods", async () => {
  const response = await handleRules(
    new Request("https://api.cityscroll.org/rules", { method: "POST" }),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(response.status, 405);
});

test("handleRules returns 503 when KV is not configured", async () => {
  const response = await handleRules(
    new Request("https://api.cityscroll.org/rules"),
    {},
  );
  assert.equal(response.status, 503);
});
