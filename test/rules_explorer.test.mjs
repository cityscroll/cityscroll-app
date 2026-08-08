import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Rules domain explorer — process-stage ontology, multi-notice grouping, next-action keys.
 *
 *   node --test test/rules_explorer.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RULES_PROCESS_STAGES,
  buildRulesExplorerEntries,
  classifyCityRecordRuleStage,
  countRulesProcessStages,
  entryCurrentProcessStage,
  filterRulesExplorerEntries,
  pickLaterRuleStage,
  rulePlainLanguageExcerpt,
  ruleStageToPhase,
  rulesAgencyName,
  rulesOfficialLinks,
  rulesProcessControlModel,
  rulesProcessActionKey,
  rulesProcessFilterKey,
  rulesProcessStage,
} from "../site/rules_explorer.mjs";
import {
  isConfidentMultiNoticeRulemaking,
  stitchRulemakingRecord,
} from "../site/rules_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_APP_SOURCE = readFileSync(join(ROOT, "site/app/rules.mjs"), "utf8");
const CURRENT_UNSTAGED = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/rules_stage/20260728026.json"),
  "utf8",
)).record;

const MULTI_PROPOSAL = {
  request_id: "20260301011",
  title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-03-01",
  stage: "comment-open",
  agency: "Department of Housing Preservation and Development",
  join: { matched: true },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=gas",
    comment_url: "https://rules.cityofnewyork.us/?p=gas#comment",
    comment_by_date: "2026-05-01",
    hearing_date: "2026-04-20",
  },
  events: [
    {
      event_type: "proposal_published",
      valid_at: "2026-03-01",
      source_url: "https://rules.cityofnewyork.us/?p=gas",
      status: "occurred",
    },
    {
      event_type: "comment_close",
      valid_at: "2026-05-01",
      source_url: "https://rules.cityofnewyork.us/?p=gas#comment",
      status: "scheduled",
    },
  ],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "proposal",
  },
  related_notices: [
    {
      request_id: "20260415011",
      role: "hearing",
      title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-04-15",
      event_date: "2026-04-20",
      stage: "hearing",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260701011",
      role: "adoption",
      title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-07-01",
      stage: "adopted",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const MULTI_HEARING = {
  request_id: "20260415011",
  title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-04-15",
  stage: "hearing",
  agency: "Department of Housing Preservation and Development",
  join: { matched: false },
  nyc_rules: null,
  events: [
    {
      event_type: "public_hearing",
      valid_at: "2026-04-20",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260415011",
      status: "scheduled",
    },
  ],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "hearing",
  },
  related_notices: [
    {
      request_id: "20260301011",
      role: "proposal",
      title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-03-01",
      stage: "comment-open",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260701011",
      role: "adoption",
      title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-07-01",
      stage: "adopted",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const MULTI_ADOPTION = {
  request_id: "20260701011",
  title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-07-01",
  stage: "adopted",
  agency: "Department of Housing Preservation and Development",
  join: { matched: true },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=gas",
    adoption_published_at: "2026-07-01",
  },
  events: [
    {
      event_type: "adoption",
      valid_at: "2026-07-01",
      published_at: "2026-07-01",
      source_url: "https://rules.cityofnewyork.us/?p=gas",
      status: "occurred",
    },
  ],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "adoption",
  },
  related_notices: [
    {
      request_id: "20260301011",
      role: "proposal",
      title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-03-01",
      stage: "comment-open",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260415011",
      role: "hearing",
      title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-04-15",
      event_date: "2026-04-20",
      stage: "hearing",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const SINGLE_OPEN = {
  request_id: "20260714029",
  stage: "comment-open",
  join: { matched: true },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=9001",
    comment_url: "https://rules.cityofnewyork.us/?p=9001#comment",
    comment_by_date: "2026-09-15",
  },
  events: [],
  rulemaking_subject_ref: "rulemaking:notice:20260714029",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 1,
    method: "singleton",
  },
  related_notices: [],
};

function noticeRow(id, title, agency, startDate) {
  return {
    request_id: id,
    short_title: title,
    agency_name: agency,
    start_date: startDate,
    section_name: "Agency Rules",
    type_of_notice_description: "Agency Rules",
    additional_description_1: title,
  };
}

test("RULES_PROCESS_STAGES is the ops-ontology rail (not a flat notice wall)", () => {
  const keys = RULES_PROCESS_STAGES.map(([k]) => k);
  assert.deepEqual(keys, [
    "all",
    "proposal",
    "public_process",
    "adoption",
    "effective",
    "unstaged",
  ]);
  assert.equal(rulesProcessActionKey("proposal", "proposed"), "rule_phase_action_proposal");
  assert.equal(rulesProcessActionKey("public_process", "comment-open"), "rule_action_comment");
  assert.equal(rulesProcessActionKey("public_process", "hearing"), "rule_action_attend_hearing");
  assert.equal(
    rulesProcessActionKey("public_process", "comment-closed"),
    "rule_action_open_notice",
    "closed comment is status beside a neutral action, never the action label",
  );
  assert.equal(rulesProcessActionKey("adoption", "adopted"), "rule_phase_action_adoption");
  assert.equal(rulesProcessActionKey(null, null), "rule_action_open_notice");
});

test("ruleStageToPhase maps fine stages onto the four rulemaking phases", () => {
  assert.equal(ruleStageToPhase("proposed"), "proposal");
  assert.equal(ruleStageToPhase("comment-open"), "public_process");
  assert.equal(ruleStageToPhase("hearing"), "public_process");
  assert.equal(ruleStageToPhase("comment-closed"), "public_process");
  assert.equal(ruleStageToPhase("adopted"), "adoption");
  assert.equal(ruleStageToPhase("effective"), "effective");
  assert.equal(ruleStageToPhase("unknown"), null);
  assert.equal(ruleStageToPhase(null), null);
  assert.equal(pickLaterRuleStage("proposed", "adopted"), "adopted");
  assert.equal(pickLaterRuleStage("effective", "comment-open"), "effective");
});

test("buildRulesExplorerEntries collapses multi-notice rulemakings to one card", () => {
  const notices = [
    noticeRow(
      "20260301011",
      "Proposed Rule — Natural Gas Detectors in Dwelling Units",
      "Department of Housing Preservation and Development",
      "2026-03-01",
    ),
    noticeRow(
      "20260415011",
      "Public Hearing on Natural Gas Detectors in Dwelling Units",
      "Department of Housing Preservation and Development",
      "2026-04-15",
    ),
    noticeRow(
      "20260701011",
      "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
      "Department of Housing Preservation and Development",
      "2026-07-01",
    ),
    noticeRow(
      "20260714029",
      "Commercial Meter Parking for For-Hire Vehicles",
      "Department of Transportation",
      "2026-07-14",
    ),
  ];
  const rulesView = {
    rules: [MULTI_PROPOSAL, MULTI_HEARING, MULTI_ADOPTION, SINGLE_OPEN],
  };
  const entries = buildRulesExplorerEntries(notices, rulesView);
  assert.ok(entries.length >= 2);
  const multi = entries.filter((e) => e.kind === "rulemaking" && e.notice_count > 1);
  assert.equal(multi.length, 1, "expected one multi-notice rulemaking entry");
  assert.equal(multi[0].subject_ref, "rulemaking:hpd:natural-gas-detectors");
  assert.equal(multi[0].members.length, 3);
  assert.ok(multi[0].action_key);
  assert.ok(multi[0].agency);
  assert.ok(
    multi[0].process_stage === "public_process"
      || multi[0].process_stage === "adoption"
      || multi[0].process_stage === "proposal",
  );
  // Collapse reduces list length vs raw notices.
  assert.ok(entries.length < notices.length);
  const single = entries.find((e) => e.primary?.request_id === "20260714029");
  assert.ok(single);
  assert.equal(single.kind, "notice");
  assert.equal(single.fine_stage, "comment-open");
  assert.equal(single.action_key, "rule_action_comment");
  assert.ok(single.comment_url);
});

test("low-confidence multi-notice joins do not collapse", () => {
  const notices = [
    noticeRow("a", "Title A", "DOT", "2026-01-01"),
    noticeRow("b", "Title B", "DOT", "2026-02-01"),
  ];
  const rulesView = {
    rules: [
      {
        request_id: "a",
        stage: "proposed",
        rulemaking_subject_ref: "rulemaking:dot:ambiguous",
        rulemaking_join: {
          matched: true,
          confidence: "low",
          notice_count: 2,
        },
        related_notices: [
          {
            request_id: "b",
            role: "notice",
            join: { matched: true, confidence: "low" },
          },
        ],
      },
      {
        request_id: "b",
        stage: "proposed",
        rulemaking_subject_ref: "rulemaking:dot:ambiguous",
        rulemaking_join: {
          matched: true,
          confidence: "low",
          notice_count: 2,
        },
        related_notices: [],
      },
    ],
  };
  assert.equal(isConfidentMultiNoticeRulemaking(rulesView.rules[0]), false);
  const entries = buildRulesExplorerEntries(notices, rulesView);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.kind === "notice"));
});

test("filterRulesExplorerEntries respects process phase and keeps multi-notice under earlier phases", () => {
  const notices = [
    noticeRow(
      "20260301011",
      "Proposed Rule — Natural Gas Detectors",
      "HPD",
      "2026-03-01",
    ),
    noticeRow(
      "20260415011",
      "Public Hearing on Natural Gas Detectors",
      "HPD",
      "2026-04-15",
    ),
    noticeRow(
      "20260701011",
      "Notice of Adoption — Natural Gas Detectors",
      "HPD",
      "2026-07-01",
    ),
  ];
  // Stamp fine stages on rows so earlier-phase filter can match members.
  notices[0]._ruleStage = MULTI_PROPOSAL;
  notices[1]._ruleStage = MULTI_HEARING;
  notices[2]._ruleStage = MULTI_ADOPTION;
  const all = buildRulesExplorerEntries(notices, {
    rules: [MULTI_PROPOSAL, MULTI_HEARING, MULTI_ADOPTION],
  });
  assert.equal(all.length, 1);
  const publicProcess = filterRulesExplorerEntries(all, { process: "public_process" });
  assert.equal(publicProcess.length, 1);
  const adoption = filterRulesExplorerEntries(all, { process: "adoption" });
  assert.equal(adoption.length, 1);
  const effective = filterRulesExplorerEntries(all, { process: "effective" });
  assert.equal(effective.length, 0);
  const counts = countRulesProcessStages(all);
  assert.equal(counts.all, 1);
  assert.equal(counts.proposal, 0);
  assert.equal(counts.public_process, 1);
  assert.equal(counts.adoption, 1);
  assert.equal(counts.effective, 0);
  for (const key of ["proposal", "public_process", "adoption", "effective", "unstaged"]) {
    assert.equal(
      counts[key],
      filterRulesExplorerEntries(all, { process: key }).length,
      `count-equals-list for ${key}`,
    );
  }
});

test("rulesProcessControlModel keeps lifecycle stages ordered and Unstaged outside the sequence", () => {
  const control = rulesProcessControlModel({
    all: 166,
    proposal: 130,
    public_process: 20,
    adoption: 6,
    effective: 9,
    unstaged: 1,
  }, "public_process");
  assert.deepEqual(control.lifecycle.map((item) => item.id), [
    "proposal",
    "public_process",
    "adoption",
    "effective",
  ]);
  assert.equal(control.all.count, 166);
  assert.equal(control.all.pressed, false);
  assert.equal(control.lifecycle[1].count, 20);
  assert.equal(control.lifecycle[1].pressed, true);
  assert.equal(control.unstaged.id, "unstaged");
  assert.equal(control.unstaged.count, 1);
  assert.equal(control.lifecycle.some((item) => item.id === "unstaged"), false);
  assert.equal(rulesProcessControlModel({ all: 1, unstaged: 0 }).unstaged, null);
});

test("rulePlainLanguageExcerpt prefers a verbatim what-the-rule-does sentence", () => {
  const source = [
    "Pursuant to the authority vested in the Department by sections 1043 and 2903 of the New York City Charter, the Department adopts the following rule.",
    "Statement of Basis and Purpose.",
    "This rule requires food-delivery apps to show workers how each payment was calculated.",
    "The rule takes effect 30 days after publication.",
  ].join(" ");
  assert.equal(
    rulePlainLanguageExcerpt(source),
    "This rule requires food-delivery apps to show workers how each payment was calculated.",
  );
});

test("rulePlainLanguageExcerpt never paraphrases and falls back to the first source sentence", () => {
  const source = "<p>Restaurants must post the new allergen notice.</p><p>Comments close September 1.</p>";
  assert.equal(
    rulePlainLanguageExcerpt(source),
    "Restaurants must post the new allergen notice.",
  );
  assert.equal(rulePlainLanguageExcerpt(""), "");
});

test("rulesProcessStage / filter key map materialization stage onto process rail", () => {
  assert.equal(
    rulesProcessStage({ _ruleStage: { stage: "comment-open" } }),
    "public_process",
  );
  assert.equal(rulesProcessFilterKey({ _ruleStage: { stage: null } }), "unstaged");
  assert.equal(rulesProcessFilterKey({ _ruleStage: { stage: "unknown" } }), "unstaged");
  assert.equal(rulesAgencyName({ agency_name: "DOT" }), "DOT");
  const links = rulesOfficialLinks({
    nyc_rules: {
      url: "https://rules.cityofnewyork.us/?p=1",
      comment_url: "https://rules.cityofnewyork.us/?p=1#c",
      comment_by_date: "2026-09-01",
    },
  });
  assert.equal(links.comment_by_date, "2026-09-01");
  assert.match(links.comment_url, /#c$/);
});

test("current Unstaged regression: a read-model delta Public Hearing classifies into public process", () => {
  assert.equal(classifyCityRecordRuleStage(CURRENT_UNSTAGED), "hearing");
  assert.equal(rulesProcessStage(CURRENT_UNSTAGED), "public_process");
  const entries = buildRulesExplorerEntries([structuredClone(CURRENT_UNSTAGED)], { rules: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fine_stage, "hearing");
  assert.equal(entries[0].process_stage, "public_process");
  assert.equal(entries[0].process_filter, "public_process");
});

test("entryCurrentProcessStage prefers the latest matched process phase", () => {
  const stitched = stitchRulemakingRecord(MULTI_PROPOSAL, new Map([
    ["20260301011", MULTI_PROPOSAL],
    ["20260415011", MULTI_HEARING],
    ["20260701011", MULTI_ADOPTION],
  ]));
  assert.ok(stitched.multi_notice);
  // Stitched stage is later of members (adoption).
  const phase = entryCurrentProcessStage(stitched, [
    { _ruleStage: MULTI_PROPOSAL },
    { _ruleStage: MULTI_ADOPTION },
  ]);
  assert.ok(phase === "adoption" || phase === "public_process");
});

test("public Rules domain presents chain membership as an ordinary facet", () => {
  const index = SITE_SOURCE;
  assert.equal((index.match(/id="rulesprocessrail"/g) || []).length, 1);
  assert.match(index, /rules-domain-intro/);
  assert.doesNotMatch(index, /rules-domain-stepper/);
  assert.match(index, />Includes phase</);
  assert.match(index, /rules-stage-facets/);
  assert.match(index, /rules-stage-unmatched/);
  assert.match(index, /aria-pressed=/);
  assert.match(index, /#rulesprocessrail \.chip\[aria-pressed="true"\]/);
  assert.match(index, /function rulesExplorerCardHTML/);
  assert.match(index, /buildRulesExplorerEntries/);
  assert.match(index, /rulesProcessSel/);
  assert.match(index, /function renderRulesExplorer/);
  // Detail phase spine remains.
  assert.match(index, /buildRulesPhaseView|rules_phase_spine/);
  assert.match(index, /rule-phase-stepper|rule-spine-lead/);

  const cardTemplate = RULES_APP_SOURCE.slice(
    RULES_APP_SOURCE.indexOf("function rulesExplorerCardHTML"),
    RULES_APP_SOURCE.indexOf("let rulesActionBandToolsPromise"),
  );
  assert.doesNotMatch(cardTemplate, /ruleStageChip\(/);
  assert.doesNotMatch(cardTemplate, /rules-action-lead/);
  assert.match(cardTemplate, /data-card-fact/);
  const processLineTemplate = cardTemplate.slice(
    cardTemplate.indexOf('const processLine='),
    cardTemplate.indexOf('// Next-action lead'),
  );
  assert.match(processLineTemplate, /class="rules-process-line"/);
  assert.match(processLineTemplate, /class="tag open"/);
  assert.doesNotMatch(processLineTemplate, /tag place|ui-constellation-link|rules_list_no_agency/);
  assert.match(cardTemplate, /<div class="ftype">\$\{r\.type_of_notice_description[^\n]+pivotA\(agencyHref\(agency\), agency\)/);

  const processControlTemplate = RULES_APP_SOURCE.slice(
    RULES_APP_SOURCE.indexOf("function rulesProcessControlHTML"),
    RULES_APP_SOURCE.indexOf("async function renderRulesExplorer"),
  );
  assert.match(processControlTemplate, /chiprow rules-stage-facets/);
  assert.doesNotMatch(processControlTemplate, /lc-step|lc-step-arrow|→|<ol/);
});
