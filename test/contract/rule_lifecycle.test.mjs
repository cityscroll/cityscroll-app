import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyStage,
  joinRulesToNotices,
  normalizeRuleActionUrl,
  normalizeRuleItem,
  parseRssItems,
} from "../../worker/src/lib/rules.mjs";

// ---------------------------------------------------------------------------
// Fixtures: one RSS item per lifecycle stage, plus matching and non-matching
// City Record notices. Dates are relative to NOW (2026-07-29).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-29T12:00:00Z");

function rssItem(opts) {
  const parts = [`<title>${opts.title}</title>`];
  parts.push(`<link>${opts.url}</link>`);
  parts.push(`<pubDate>${opts.pubDate}</pubDate>`);
  if (opts.agency_name) parts.push(`<agency_name>${opts.agency_name}</agency_name>`);
  if (opts.rule_status != null) parts.push(`<rule_status>${opts.rule_status}</rule_status>`);
  if (opts.rule_adoption_date) parts.push(`<rule_adoption_date>${opts.rule_adoption_date}</rule_adoption_date>`);
  if (opts.comment_by_date) parts.push(`<comment_by_date>${opts.comment_by_date}</comment_by_date>`);
  if (opts.hearing_date_1) parts.push(`<hearing_date_1>${opts.hearing_date_1}</hearing_date_1>`);
  if (opts.rule_short_summary) parts.push(`<rule_short_summary><![CDATA[${opts.rule_short_summary}]]></rule_short_summary>`);
  if (opts.content) parts.push(`<content:encoded><![CDATA[${opts.content}]]></content:encoded>`);
  parts.push(`<wfw:commentRss>${opts.url}feed/</wfw:commentRss>`);
  parts.push(`<slash:comments>${opts.commentCount || 0}</slash:comments>`);
  return `<item>${parts.join("")}</item>`;
}

function rssFeed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NYC Rules</title>${items.join("")}</channel></rss>`;
}

const FIXTURES = {
  proposed: {
    rss: rssItem({
      title: "New Vendor License Rule",
      url: "https://rules.cityofnewyork.us/rule/vendor-license/",
      pubDate: "Mon, 28 Jul 2026 15:00:00 +0000",
      agency_name: "DCWP",
      rule_short_summary: "Proposed rule establishing a new vendor license waitlist.",
    }),
    notice: {
      request_id: "CR-proposed-001",
      start_date: "2026-07-28T00:00:00.000",
      agency_name: "Department of Consumer and Worker Protection",
      section_name: "Agency Rules",
      type_of_notice_description: "Agency Rules",
      short_title: "New Vendor License Rule Waitlist",
    },
  },
  commentOpen: {
    rss: rssItem({
      title: "Commercial Meter Parking",
      url: "https://rules.cityofnewyork.us/rule/meter-parking/",
      pubDate: "Thu, 23 Jul 2026 16:18:07 +0000",
      agency_name: "DOT",
      comment_by_date: "20260901",
      hearing_date_1: "20260901",
      rule_short_summary: "Allow for-hire vehicles at commercial parking meters.",
      commentCount: 0,
    }),
    notice: {
      request_id: "CR-comment-001",
      start_date: "2026-07-23T00:00:00.000",
      agency_name: "Department of Transportation",
      section_name: "Agency Rules",
      type_of_notice_description: "Agency Rules",
      short_title: "Commercial Meter Parking for For-Hire Vehicles",
    },
  },
  hearing: {
    rss: rssItem({
      title: "Energy Conservation Code",
      url: "https://rules.cityofnewyork.us/rule/energy-code/",
      pubDate: "Thu, 23 Jul 2026 14:08:48 +0000",
      agency_name: "DOB",
      hearing_date_1: "20260827",
      rule_short_summary: "Amend the NYC Energy Conservation Code.",
      commentCount: 6,
    }),
    notice: {
      request_id: "CR-hearing-001",
      start_date: "2026-07-23T00:00:00.000",
      agency_name: "Department of Buildings",
      section_name: "Agency Rules",
      type_of_notice_description: "Public Hearings",
      short_title: "Energy Conservation Code Amendments",
    },
  },
  adopted: {
    rss: rssItem({
      title: "Natural Gas Detectors",
      url: "https://rules.cityofnewyork.us/rule/gas-detectors/",
      pubDate: "Tue, 28 Jul 2026 13:32:11 +0000",
      agency_name: "HPD",
      rule_status: "1",
      rule_adoption_date: "20270101",
      comment_by_date: "20250716",
      hearing_date_1: "20250716",
      rule_short_summary: "Requires natural gas detecting devices in multiple dwellings.",
      commentCount: 5,
    }),
    notice: {
      request_id: "CR-adopted-001",
      start_date: "2026-07-28T00:00:00.000",
      agency_name: "Housing Preservation and Development",
      section_name: "Agency Rules",
      type_of_notice_description: "Agency Rules",
      short_title: "Natural Gas Detector Requirements",
    },
  },
  effective: {
    rss: rssItem({
      title: "Sidewalk Cafe Regulation Update",
      url: "https://rules.cityofnewyork.us/rule/sidewalk-cafe/",
      pubDate: "Mon, 20 Jul 2026 15:05:56 +0000",
      agency_name: "DCP",
      rule_status: "1",
      rule_adoption_date: "20260615",
      content: "<em>Rule Effective Date:</em> <strong>06-15-2026</strong>",
      comment_by_date: "20260501",
      hearing_date_1: "20260501",
      rule_short_summary: "Updated sidewalk cafe regulations.",
      commentCount: 12,
    }),
    notice: {
      request_id: "CR-effective-001",
      start_date: "2026-07-20T00:00:00.000",
      agency_name: "Department of City Planning",
      section_name: "Agency Rules",
      type_of_notice_description: "Agency Rules",
      short_title: "Sidewalk Cafe Regulation Update",
    },
  },
};

function parseRss(xml) {
  return normalizeRuleItem(parseRssItems(rssFeed([xml]))[0]);
}

// ---------------------------------------------------------------------------
// Lifecycle stage classification preserves official links and dates
// ---------------------------------------------------------------------------

test("proposed: rule with no lifecycle dates classifies as proposed and preserves URL", () => {
  const rule = parseRss(FIXTURES.proposed.rss);
  assert.equal(classifyStage(rule, NOW), "proposed");
  assert.equal(rule.url, "https://rules.cityofnewyork.us/rule/vendor-license/");
  assert.equal(rule.agency_abbr, "DCWP");
});

test("comment-open: future comment deadline classifies as comment-open with official comment link", () => {
  const rule = parseRss(FIXTURES.commentOpen.rss);
  assert.equal(classifyStage(rule, NOW), "comment-open");
  assert.equal(rule.comment_by_date, "2026-09-01");
  assert.equal(rule.hearing_date, "2026-09-01");
  assert.equal(rule.url, "https://rules.cityofnewyork.us/rule/meter-parking/");
  assert.ok(rule.comment_url);
});

test("NYC Rules comment feed URLs normalize to the resident-facing rule page", () => {
  const rule = normalizeRuleItem({
    title: "Amendments Related to the NYC Energy Conservation Code",
    link: "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/",
    commentRss: "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/feed/",
    comment_by_date: "20260824",
  });

  assert.equal(
    rule.comment_url,
    "https://rules.cityofnewyork.us/rule/amendments-related-to-the-nyc-energy-conservation-code/",
  );
});

test("NYC Rules URL normalization removes sibling RSS artifacts without dropping page parameters", () => {
  assert.equal(
    normalizeRuleActionUrl("https://rules.cityofnewyork.us/rule/example/?format=rss"),
    "https://rules.cityofnewyork.us/rule/example/",
  );
  assert.equal(
    normalizeRuleActionUrl("https://rules.cityofnewyork.us/rule/example/?format="),
    "https://rules.cityofnewyork.us/rule/example/",
  );
  assert.equal(
    normalizeRuleActionUrl("https://rules.cityofnewyork.us/rule/example/?feed=atom&lang=es"),
    "https://rules.cityofnewyork.us/rule/example/?lang=es",
  );
  assert.equal(
    normalizeRuleActionUrl("https://rules.cityofnewyork.us/rule/example/?format=html"),
    "https://rules.cityofnewyork.us/rule/example/?format=html",
  );
});

test("hearing: future hearing date without open comment classifies as hearing", () => {
  const rule = parseRss(FIXTURES.hearing.rss);
  assert.equal(classifyStage(rule, NOW), "hearing");
  assert.equal(rule.hearing_date, "2026-08-27");
  assert.equal(rule.url, "https://rules.cityofnewyork.us/rule/energy-code/");
});

test("adopted: adoption publication with a future effective date remains adopted", () => {
  const rule = parseRss(FIXTURES.adopted.rss);
  assert.equal(classifyStage(rule, NOW), "adopted");
  assert.equal(rule.effective_date, "2027-01-01");
  assert.equal(rule.adoption_published_at, "2026-07-28T13:32:11.000Z");
  assert.equal(rule.rule_status, "1");
  assert.equal(rule.url, "https://rules.cityofnewyork.us/rule/gas-detectors/");
});

test("effective: official effective date classifies as effective without collapsing adoption", () => {
  const rule = parseRss(FIXTURES.effective.rss);
  assert.equal(classifyStage(rule, NOW), "effective");
  assert.equal(rule.effective_date, "2026-06-15");
  assert.equal(rule.adoption_published_at, "2026-07-20T15:05:56.000Z");
  assert.equal(rule.effective_date, "2026-06-15");
  assert.equal(rule.url, "https://rules.cityofnewyork.us/rule/sidewalk-cafe/");
});

// ---------------------------------------------------------------------------
// Join: matched records link to official comment/adoption pages
// ---------------------------------------------------------------------------

test("matched join preserves the official NYC Rules URL and comment link without copying comments", () => {
  const rule = parseRss(FIXTURES.commentOpen.rss);
  const { matched } = joinRulesToNotices([rule], [FIXTURES.commentOpen.notice], NOW);
  assert.equal(matched.length, 1);
  const m = matched[0];
  assert.equal(m.rule.url, "https://rules.cityofnewyork.us/rule/meter-parking/");
  assert.equal(m.rule.comment_url, "https://rules.cityofnewyork.us/rule/meter-parking/");
  assert.equal(m.rule.comment_count, 0);
  assert.equal(m.rule.summary, "Allow for-hire vehicles at commercial parking meters.");
  assert.equal(m.stage, "comment-open");
  assert.ok(m.join.confidence === "high" || m.join.confidence === "medium");
  assert.equal(m.city_record.request_id, "CR-comment-001");
});

test("all five lifecycle stages join correctly to their City Record notices", () => {
  const rules = Object.values(FIXTURES).map((f) => parseRss(f.rss));
  const notices = Object.values(FIXTURES).map((f) => f.notice);
  const { matched, unmatchedNotices, unmatchedRules } = joinRulesToNotices(rules, notices, NOW);

  assert.equal(matched.length, 5);
  assert.equal(unmatchedNotices.length, 0);
  assert.equal(unmatchedRules.length, 0);

  const stages = matched.map((m) => m.stage).sort();
  assert.deepEqual(stages, ["adopted", "comment-open", "effective", "hearing", "proposed"]);
});

// ---------------------------------------------------------------------------
// Unmatched joins are explicit — never blank or silent
// ---------------------------------------------------------------------------

test("unmatched City Record notice gets an explicit no-match reason", () => {
  const rule = parseRss(FIXTURES.commentOpen.rss);
  const unmatchedNotice = FIXTURES.hearing.notice;
  const { unmatchedNotices } = joinRulesToNotices([rule], [unmatchedNotice], NOW);
  assert.equal(unmatchedNotices.length, 1);
  assert.ok(unmatchedNotices[0].request_id);
});

test("unmatched NYC Rules item gets an explicit no-match reason", () => {
  const rule = parseRss(FIXTURES.proposed.rss);
  const { unmatchedRules } = joinRulesToNotices([rule], [], NOW);
  assert.equal(unmatchedRules.length, 1);
  assert.ok(unmatchedRules[0].rule.url);
  assert.ok(unmatchedRules[0].stage);
});

test("cross-agency items never match even with similar titles", () => {
  const rule = parseRss(FIXTURES.commentOpen.rss);
  const { matched, unmatchedNotices } = joinRulesToNotices([rule], [FIXTURES.adopted.notice], NOW);
  assert.equal(matched.length, 0);
  assert.equal(unmatchedNotices.length, 1);
});

// ---------------------------------------------------------------------------
// Official links and dates are preserved through the join, not synthesized
// ---------------------------------------------------------------------------

test("the comment URL links to the resident-facing NYC Rules page, not a copied comment", () => {
  const rule = parseRss(FIXTURES.adopted.rss);
  const { matched } = joinRulesToNotices([rule], [FIXTURES.adopted.notice], NOW);
  const m = matched[0];
  assert.ok(m.rule.comment_url.includes("rules.cityofnewyork.us"));
  assert.equal(m.rule.comment_count, 5);
  assert.ok(!m.rule.summary.includes("comment text"));
});

test("adoption publication and effective dates from the RSS remain distinct", () => {
  const adoptedRule = parseRss(FIXTURES.adopted.rss);
  assert.equal(adoptedRule.effective_date, "2027-01-01");

  const effectiveRule = parseRss(FIXTURES.effective.rss);
  assert.equal(effectiveRule.effective_date, "2026-06-15");
  assert.equal(effectiveRule.effective_date, "2026-06-15");

  const proposedRule = parseRss(FIXTURES.proposed.rss);
  assert.equal(proposedRule.adoption_published_at, null);
  assert.equal(proposedRule.comment_by_date, null);
});
