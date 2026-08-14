import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const feedSource = readFileSync(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8");
const meetingsSource = readFileSync(new URL("../site/app/meetings.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      opened = true;
    } else if (source[index] === "}" && opened && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const meetingsSection = html.slice(
  html.indexOf('<section id="tab-meetings"'),
  html.indexOf("<!-- ============ ALERTS", html.indexOf('<section id="tab-meetings"')),
);

test("Meetings follows the shared lens hierarchy with meeting stage as the primary answer", () => {
  const intro = meetingsSection.indexOf('id="meetings-domain-intro"');
  const toolbar = meetingsSection.indexOf('id="meetings-toolbar"');
  const primary = meetingsSection.indexOf('id="meetingsprocessrail"');
  const resultbar = meetingsSection.indexOf('id="meetings-resultbar"');
  const results = meetingsSection.indexOf('id="meetingsfeed"');
  assert.ok(intro >= 0 && intro < toolbar);
  assert.ok(toolbar < primary && primary < resultbar && resultbar < results);
  assert.match(meetingsSection, /class="lens-method meetings-method"/);
});

test("Meetings labels its exclusive facet as Current stage and keeps progress off the list", () => {
  assert.match(meetingsSection, /id="meetings-process-label"[^>]*>Current stage</);
  assert.match(meetingsSection, /id="meetingsprocessrail"[^>]*aria-labelledby="meetings-process-label"/);
  assert.doesNotMatch(meetingsSection, /meetings-domain-stepper|lc-step-arrow/);
  assert.match(meetingsSection, /class="lens-method meetings-method"/);
});

test("Meetings keeps search and stage visible while secondary controls stay in one disclosure", () => {
  const disclosureStart = meetingsSection.indexOf('id="meetings-more-filters"');
  const disclosureEnd = meetingsSection.indexOf("</details>", disclosureStart);
  const disclosure = meetingsSection.slice(disclosureStart, disclosureEnd);
  assert.ok(meetingsSection.indexOf('id="meetingskw"') < disclosureStart);
  for (const id of [
    "meetingswhen",
    "meetingsboro",
    "meetingsneighborhood",
    "meetingslocation",
    "meetingsagency",
    "meetingsplacegrouprail",
  ]) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(disclosure, /id="meetingsprocessrail"/);
  assert.match(meetingsSection, /id="meetings-filter-badge" hidden/);
});

test("Meetings paints an exact count and keeps absent results unpainted", () => {
  const render = extractFunction(feedSource, "renderHearingExplorer");
  const count = extractFunction(feedSource, "setMeetingsResultCount");
  const filters = extractFunction(feedSource, "updateMeetingsMoreFiltersState");
  assert.match(render, /setMeetingsResultCount\(uniqueRows\.length\)/);
  assert.match(count, /results_count/);
  assert.match(render, /if\(!entries\.length\)\{[\s\S]*?el\.innerHTML="";/);
  assert.match(filters, /meetingswhen/);
  assert.match(filters, /meetingsboro/);
  assert.match(filters, /meetingsneighborhood/);
  assert.match(filters, /meetingsagency/);
  assert.match(filters, /meetingsPlaceGroupSel/);
  assert.match(filters, /property_filters_active/);
  assert.match(filters, /\["month","upcoming","past"\]/, "when=all is an internal map-drill sentinel, not a counted filter");
  assert.match(feedSource, /filterMeetingRowsByAffectedArea\(rows, filter\)/, "borough-only filtering must use current affected-area rows");
  assert.match(meetingsSection, /id="meetings-agency-scope"/, "agency scope must be a link rail");
  assert.match(feedSource, /agencyScopeLinksHTML\(\{[\s\S]*?surface:"meetings"/, "agency links must use the shared cardinality-adaptive scope grammar");
});

test("Meetings paints lifecycle material only when it is published", () => {
  const nonCouncil = extractFunction(meetingsSource, "nonCouncilHearingOutcomesHTML");
  const gap = extractFunction(meetingsSource, "meetingPhaseGapHTML");
  const panel = extractFunction(meetingsSource, "meetingPhasePanelHTML");
  const outcomes = extractFunction(meetingsSource, "meetingOutcomesHTML");
  const votes = extractFunction(meetingsSource, "meetingVotesHTML");
  assert.doesNotMatch(nonCouncil, /data-gap-class|not_published|not_yet_ingested/);
  assert.match(gap, /return "";/);
  assert.doesNotMatch(panel, /meeting_phase_empty/);
  assert.match(outcomes, /if\(!join\.matched\) return "";/);
  assert.doesNotMatch(outcomes, /meeting_outcomes_no_matters_html|meeting_outcomes_unmatched_html/);
  assert.doesNotMatch(votes, /data-person-votes-gap|meeting_outcomes_no_person_votes_html/);
});

test("Meetings uses positive public labels for notice-only entries", () => {
  const stage = extractFunction(feedSource, "meetingStageLabel");
  const card = extractFunction(feedSource, "meetingsExplorerCardHTML");
  assert.match(stage, /rule_sibling_role_notice/);
  assert.doesNotMatch(stage, /meeting_stage_unstaged/);
  assert.doesNotMatch(card, /meetings_list_no_agency|who_affected_not_stated|affected_not_stated|venue_not_stated/);
});

test("Meeting search cards use the shared bounded match-evidence renderer", () => {
  const card = extractFunction(feedSource, "meetingsExplorerCardHTML");
  const group = extractFunction(feedSource, "renderHearingGroup");
  const render = extractFunction(feedSource, "renderHearingExplorer");
  assert.match(card, /resultMatchEvidence\(title, matchText\(record\), terms\)/);
  assert.match(card, /\$\{digEvidenceHTML\(ev\)\}/);
  assert.match(group, /meetingsExplorerCardHTML\(entry,terms\)/);
  assert.match(render, /const terms=filter\.keyword\?\[filter\.keyword\]:\[\]/);
  assert.match(render, /renderHearingGroup\(scope, byPlace\[scope\]\|\|\[\],terms\)/);
  assert.match(render, /entries\.map\(entry=>meetingsExplorerCardHTML\(entry,terms\)\)/);
});

test("Meetings keeps the community-board institution pivot visible after hydration", () => {
  const render = extractFunction(feedSource, "renderHearingExplorer");
  assert.match(render, /hearingCommunityBoardPivotHTML\(\)/);
  assert.match(feedSource, /meetings_board_institution_pivot/);
});

test("Community-board scope controls stay off the initial app module path", () => {
  assert.doesNotMatch(feedSource, /from "\.\.\/community_board_scope_links\.mjs"/);
  assert.match(feedSource, /communityBoardScopeToolsPromise=import\("\.\.\/community_board_scope_links\.mjs"\)/);
  assert.match(feedSource, /renderMeetingsBoardScope\(hearingAll\|\|\[\],seq\)/);
});

test("Meeting cards render the agency constellation pivot exactly once", () => {
  const card = extractFunction(feedSource, "meetingsExplorerCardHTML");
  const agencyPivots = card.match(/pivotA\(agencyHref\(agency\),\s*agency\)/g) || [];
  assert.equal(agencyPivots.length, 1);
  assert.match(card, /<span class="tag place">\$\{pivotA\(agencyHref\(agency\), agency\)\}<\/span>/);
  assert.doesNotMatch(card, /\$\{agency\?" · "\+pivotA\(agencyHref\(agency\),agency\):""\}/);
});

test("Meetings lens chrome consumes the shared design-language tokens", () => {
  const start = html.indexOf("/* Meetings lens template */");
  const end = html.indexOf("/* Map exploration", start);
  const css = html.slice(start, end);
  assert.match(css, /var\(--color-action\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--space-3\)/);
  assert.match(css, /var\(--radius-md\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
