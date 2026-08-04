/**
 * Rules association monitor pack — templates, action bands, participation, blurbs.
 *
 *   node --test test/rules_association_monitor.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  normalizeWatchTemplateRegistry,
  getWatchTemplate,
  templateSubscribePayloads,
  describeWatchLine,
  normalizeFilter,
} from "../site/watch_templates.mjs";
import {
  classifyRulesActionBand,
  groupEntriesByActionBand,
  groupDigestRowsByActionBand,
  rulesActionBandLabel,
  daysUntil,
} from "../site/rules_action_bands.mjs";
import {
  hasOpenCommentWindow,
  buildRulesParticipationPath,
  assembleScaffoldDraft,
  participationScaffoldFields,
} from "../site/rules_participation.mjs";
import { buildMemberBlurb } from "../site/rules_member_blurb.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(ROOT, "site/data/watch_templates.json"), "utf8"),
);
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
const html = readFileSync(join(ROOT, "site/index.html"), "utf8");

const t = (key, vars = {}) => {
  const map = {
    rule_band_comment_open: "Comment window open",
    rule_band_comment_open_days: `Comment window open (${vars.n} days left)`,
    rule_band_hearing: "Hearing scheduled — attend",
    rule_band_hearing_dated: `Hearing scheduled — attend on ${vars.date}`,
    rule_band_adopted: "Adopted",
    rule_band_adopted_effective: `Adopted — takes effect ${vars.date}`,
    rule_band_other: "Other rule notices",
  };
  return map[key] || key;
};

test("registry ships four association verticals as data", () => {
  const norm = normalizeWatchTemplateRegistry(registry);
  assert.equal(norm.templates.length, 4);
  const ids = norm.templates.map((x) => x.id).sort();
  assert.deepEqual(ids, [
    "child-care",
    "construction-safety",
    "for-hire-vehicles",
    "restaurants",
  ]);
  for (const tpl of norm.templates) {
    assert.ok(tpl.serves.length > 20, `${tpl.id} has audience description`);
    assert.ok(tpl.watches.length >= 1, `${tpl.id} has watches`);
    for (const w of tpl.watches) {
      assert.equal(w.lens, "rules");
      assert.ok(w.filter && typeof w.filter === "object");
    }
  }
});

test("template subscribe payloads match existing /subscribe shape", () => {
  const tpl = getWatchTemplate(registry, "restaurants");
  const payloads = templateSubscribePayloads(tpl, {
    email: "assoc@example.org",
    freq: "daily",
    lang: "en",
  });
  assert.equal(payloads.length, 2);
  for (const p of payloads) {
    assert.equal(p.email, "assoc@example.org");
    assert.equal(p.lens, "rules");
    assert.equal(p.freq, "daily");
    assert.ok(p.filter);
  }
  assert.equal(payloads[0].filter.agency, "Health and Mental Hygiene");
  assert.ok(Array.isArray(payloads[1].filter.keywords));
});

test("normalizeFilter drops empty keywords and keeps agency", () => {
  assert.deepEqual(normalizeFilter({ agency: "Buildings", keywords: [] }), {
    agency: "Buildings",
  });
  assert.deepEqual(normalizeFilter({ keywords: ["a", "  ", "b"] }), {
    keywords: ["a", "b"],
  });
});

test("action bands classify comment open / hearing / adopted", () => {
  const now = "2026-07-01";
  const open = classifyRulesActionBand(
    {
      fine_stage: "comment-open",
      comment_by_date: "2026-07-15",
      comment_url: "https://rules.cityofnewyork.us/rule/example#comment",
    },
    { now },
  );
  assert.equal(open.band_id, "comment_open");
  assert.equal(open.days_left, 14);
  assert.ok(open.action_url.includes("rules.cityofnewyork.us"));

  const hearing = classifyRulesActionBand(
    { fine_stage: "hearing", hearing_date: "2026-07-10", rule_url: "https://rules.cityofnewyork.us/rule/h" },
    { now },
  );
  assert.equal(hearing.band_id, "hearing");

  const adopted = classifyRulesActionBand(
    {
      fine_stage: "adopted",
      effective_date: "2026-09-01",
    },
    { now },
  );
  assert.equal(adopted.band_id, "adopted");
});

test("groupEntriesByActionBand orders act-now first", () => {
  const groups = groupEntriesByActionBand(
    [
      { fine_stage: "adopted", title: "A", primary: { request_id: "1" } },
      {
        fine_stage: "comment-open",
        comment_by_date: "2026-08-01",
        title: "B",
        primary: { request_id: "2" },
      },
      { fine_stage: "hearing", hearing_date: "2026-07-20", title: "C", primary: { request_id: "3" } },
    ],
    { now: "2026-07-01" },
  );
  assert.deepEqual(
    groups.map((g) => g.band_id),
    ["comment_open", "hearing", "adopted"],
  );
  assert.match(rulesActionBandLabel(groups[0], t), /Comment window open/);
  assert.ok(daysUntil("2026-07-02", "2026-07-01") === 1);
});

test("digest row grouping stamps action_band on entries", () => {
  const groups = groupDigestRowsByActionBand(
    [
      { request_id: "20260706044", short_title: "TLC proposal", agency_name: "Taxi and Limousine Commission" },
      { request_id: "20260707025", short_title: "Sidewalk sheds", agency_name: "Buildings" },
    ],
    {
      now: "2026-07-01",
      rulesById: {
        "20260706044": {
          stage: "comment-open",
          nyc_rules: {
            comment_by_date: "2026-07-20",
            comment_url: "https://rules.cityofnewyork.us/tlc",
          },
        },
        "20260707025": {
          stage: "adopted",
          nyc_rules: { effective_date: "2026-08-01", url: "https://rules.cityofnewyork.us/dob" },
        },
      },
    },
  );
  assert.equal(groups[0].band_id, "comment_open");
  assert.equal(groups[0].entries[0].action_band.band_id, "comment_open");
  assert.equal(groups[1].band_id, "adopted");
});

test("open comment window builds shepherded participation path with scaffold", () => {
  const rec = {
    stage: "comment-open",
    agency: "Health and Mental Hygiene",
    title: "Food service grade posting rules",
    nyc_rules: {
      comment_by_date: "2026-08-15",
      comment_url: "https://rules.cityofnewyork.us/dohmh-food#comment",
      url: "https://rules.cityofnewyork.us/dohmh-food",
    },
  };
  assert.equal(hasOpenCommentWindow(rec, { now: "2026-07-01" }), true);
  const path = buildRulesParticipationPath(rec, null, { now: "2026-07-01" });
  assert.ok(path);
  assert.equal(path.open, true);
  assert.ok(path.submit_url.includes("rules.cityofnewyork.us"));
  assert.equal(path.scaffold.length, 3);
  assert.deepEqual(
    path.scaffold.map((s) => s.id),
    ["who", "how_affects", "ask"],
  );
  assert.equal(participationScaffoldFields().length, 3);
  const draft = assembleScaffoldDraft(path, {
    who: "I own a restaurant in Brooklyn.",
    how_affects: "Grade posting changes our window displays.",
    ask: "Please clarify the effective date for existing permits.",
  });
  assert.match(draft, /I own a restaurant/);
  assert.match(draft, /Grade posting/);
  assert.match(draft, /clarify the effective date/);
  // Closed window → null
  assert.equal(
    buildRulesParticipationPath(
      { ...rec, nyc_rules: { ...rec.nyc_rules, comment_by_date: "2026-06-01" } },
      null,
      { now: "2026-07-01" },
    ),
    null,
  );
});

test("member blurbs weave notice specifics on three real-shaped notices", () => {
  const cases = [
    {
      notice: {
        request_id: "20260706044",
        agency_name: "Taxi and Limousine Commission",
        short_title: "Driver Relief Penalty Reduction and Medallion Relief Program Rule Proposal.",
        type_of_notice_description: "Proposed Rule Making",
        additional_description_1:
          "The Taxi and Limousine Commission proposes rules reducing certain driver penalties and extending medallion relief terms for eligible licensees.",
      },
      rec: {
        stage: "comment-open",
        nyc_rules: {
          comment_by_date: "2026-07-25",
          comment_url: "https://rules.cityofnewyork.us/tlc-relief#comment",
          url: "https://rules.cityofnewyork.us/tlc-relief",
        },
      },
      must: [/Taxi and Limousine/, /Driver Relief|penalty|medallion/i, /July 25|comment/i, /for-hire|fleet|driver/i],
    },
    {
      notice: {
        request_id: "20260707025",
        agency_name: "Buildings",
        short_title: "Final Rule - Amendment of Rules relating to Sidewalk Sheds",
        type_of_notice_description: "Adoption of Rules",
        additional_description_1:
          "The Department of Buildings adopts amendments to sidewalk shed design and inspection requirements for construction sites.",
      },
      rec: {
        stage: "adopted",
        nyc_rules: {
          effective_date: "2026-09-01",
          url: "https://rules.cityofnewyork.us/dob-sheds",
        },
      },
      must: [/Buildings/, /sidewalk shed/i, /adopted|effective|September/i, /contractor|construction/i],
    },
    {
      notice: {
        request_id: "20260618004",
        agency_name: "Health and Mental Hygiene",
        short_title: "Notice of Public Hearing and Opportunity to Comment on Proposed Amendments to Food Service Establishment Rules",
        type_of_notice_description: "Public Hearings",
        additional_description_1:
          "DOHMH will hold a public hearing on proposed amendments to food service establishment sanitary rules affecting restaurants and caterers.",
      },
      rec: {
        stage: "comment-open",
        nyc_rules: {
          comment_by_date: "2026-08-01",
          hearing_date: "2026-07-22",
          comment_url: "https://rules.cityofnewyork.us/dohmh-fse#comment",
          url: "https://rules.cityofnewyork.us/dohmh-fse",
        },
      },
      must: [/Health and Mental Hygiene/, /food service|restaurant/i, /comment|August|July/i],
    },
  ];

  for (const c of cases) {
    const blurb = buildMemberBlurb(c.notice, c.rec, {
      now: "2026-07-01",
      siteBase: "https://cityscroll.org",
    });
    assert.ok(blurb?.text, `blurb for ${c.notice.request_id}`);
    // Anti-sterile: not a bare shell with empty braces / placeholder-only lines.
    assert.ok(!/\{[a-z_]+\}/.test(blurb.text), "no unfilled template tokens");
    assert.ok(blurb.text.length > 120, "reads as a full paragraph");
    assert.match(blurb.text, new RegExp(c.notice.request_id));
    for (const re of c.must) {
      assert.match(blurb.text, re, `${c.notice.request_id} should match ${re}`);
    }
  }
});

test("UI wires templates, action bands, participation, and blurb chrome", () => {
  assert.match(html, /id="watch-templates"/);
  assert.match(html, /data-watch-templates/);
  assert.match(html, /rules-action-band-note/);
  assert.match(i18n, /watch_tpl_heading:/);
  assert.match(i18n, /rule_band_comment_open_days:/);
  assert.match(i18n, /rule_part_scaffold_who_label:/);
  assert.match(i18n, /rule_member_blurb_copy:/);
  assert.match(SITE_SOURCE, /initWatchTemplates/);
  assert.match(SITE_SOURCE, /groupEntriesByActionBand/);
  assert.match(SITE_SOURCE, /buildRulesParticipationPath/);
  assert.match(SITE_SOURCE, /buildMemberBlurb/);
  assert.match(SITE_SOURCE, /rule-participation/);
  assert.match(SITE_SOURCE, /rule-member-blurb/);
});

test("describeWatchLine prefers explicit labels", () => {
  assert.equal(
    describeWatchLine({ label: "DOHMH Agency Rules", lens: "rules", filter: {} }),
    "DOHMH Agency Rules",
  );
});
