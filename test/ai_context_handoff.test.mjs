import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  AI_CONTEXT_HANDOFF_DISPOSITIONS,
  AI_CONTEXT_HANDOFF_SCHEMA,
  AI_CONTEXT_MORE_TOOLS_LABEL,
  AI_CONTEXT_PRIVATE_KEYS,
  AI_CONTEXT_SETUP_PATH,
  AI_CONTEXT_UNSUPPORTED_FAMILIES,
  PAGE_FAMILY_AI_CONTEXT,
  aiContextHandoffHref,
  buildAiContextHandoff,
  buildAiContextHandoffForSurface,
  buildBrowseContractsAiContextHandoff,
  buildBrowseLandProjectsAiContextHandoff,
  buildBrowseOrganizationsAiContextHandoff,
  buildContractAiContextHandoff,
  buildEntityAiContextHandoff,
  buildLandProjectAiContextHandoff,
  buildMeetingAiContextHandoff,
  buildNoticeAiContextHandoff,
  buildSearchAiContextHandoff,
  buildUnsupportedFamilyAiContextHandoff,
  formatAiContextTask,
  pageFamilyAiContextSurfaceIds,
  parseAiContextHandoff,
  renderAiContextHandoffLink,
  renderAiContextTaskPanel,
  renderMoreToolsRegion,
  renderScopedAiContextAction,
  stripAiContextPrivateFields,
} from "../site/ai_context_handoff.mjs";
import { AI_ENDPOINT } from "../site/ai_discovery.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const CONTRACT_ID = "procurement:contract:CT107120258801626";
const NOTICE_ID = "20240829105";
const LAND_ID = "2024Q0356";
const MEETING_ID = "meeting:city_record:20260810053";
const ENTITY_ID = "agency:id:857";
const PINNED_CLOCK = "2026-09-16T12:00:00.000Z";

function publishedSurfaceIds() {
  const manifest = JSON.parse(readFileSync(new URL("../site/data/performance-classification-manifest.v1.json", import.meta.url), "utf8"));
  return manifest.surfaces.map((surface) => surface.surface_id);
}

function exactSurfaceFixture(surfaceId) {
  switch (surfaceId) {
    case "notice":
      return { request_id: NOTICE_ID };
    case "meeting":
      return { meeting_id: MEETING_ID };
    case "procurement":
      return { procurement_id: CONTRACT_ID };
    case "agency":
    case "vendor":
    case "official":
    case "committee":
    case "community-board":
      return { entity_id: ENTITY_ID };
    case "search":
    case "browse":
      return { query: "heat pumps", lenses: ["money"] };
    case "browse-meetings":
      return { query: "community board", lenses: ["meetings"] };
    case "browse-contracts":
      return { query: "heat pumps", agency: "Housing" };
    case "browse-people":
      return { query: "education" };
    case "browse-zoning":
      return { query: LAND_ID };
    default:
      return {};
  }
}

test("A1 census: declared page families equal the published surface manifest", async () => {
  await withPinnedClock(PINNED_CLOCK, async () => {
    const published = publishedSurfaceIds().slice().sort();
    const declared = pageFamilyAiContextSurfaceIds().slice().sort();
    assert.deepEqual(declared, published);

    const seen = new Set();
    for (const row of PAGE_FAMILY_AI_CONTEXT) {
      assert.ok(AI_CONTEXT_HANDOFF_DISPOSITIONS.includes(row.handoff), row.surface_id);
      assert.equal(seen.has(row.surface_id), false, `duplicate census row: ${row.surface_id}`);
      seen.add(row.surface_id);

      if (row.handoff === "exact") {
        assert.ok(Array.isArray(row.tools) && row.tools.length >= 1, row.surface_id);
        const handoff = buildAiContextHandoffForSurface(row.surface_id, exactSurfaceFixture(row.surface_id));
        assert.equal(handoff.status, "ok", row.surface_id);
        assert.equal(handoff.support, "exact", row.surface_id);
        assert.ok(handoff.tools.length >= 1, row.surface_id);
        assert.equal(handoff.setup_href, AI_CONTEXT_SETUP_PATH, row.surface_id);
      } else if (row.handoff === "unsupported") {
        assert.ok(AI_CONTEXT_UNSUPPORTED_FAMILIES.includes(row.family), row.surface_id);
        const handoff = buildAiContextHandoffForSurface(row.surface_id, { canonical_href: `/${row.surface_id}/` });
        assert.equal(handoff.status, "unsupported_family", row.surface_id);
        assert.equal(handoff.support, "unsupported", row.surface_id);
        assert.equal(handoff.tools.length, 0, row.surface_id);
        assert.equal(handoff.setup_href, AI_CONTEXT_SETUP_PATH, row.surface_id);
      } else {
        assert.equal(row.handoff, "general", row.surface_id);
        assert.equal(typeof row.reason, "string", row.surface_id);
        assert.ok(row.reason.length > 0, row.surface_id);
        const handoff = buildAiContextHandoffForSurface(row.surface_id, { canonical_href: `/${row.surface_id}/` });
        assert.equal(handoff.status, "general_setup", row.surface_id);
        assert.equal(handoff.support, "general", row.surface_id);
        assert.equal(handoff.tools.length, 0, row.surface_id);
        assert.equal(handoff.setup_href, AI_CONTEXT_SETUP_PATH, row.surface_id);
        // A1: general disposition states its census reason by value, not by length.
        assert.equal(handoff.reason, row.reason, row.surface_id);
        assert.match(handoff.task, new RegExp(row.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), row.surface_id);
        assert.match(formatAiContextTask(handoff), new RegExp(row.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), row.surface_id);
      }
    }

    // Spec-named families without a 1:1 published surface still refuse exactly.
    for (const family of AI_CONTEXT_UNSUPPORTED_FAMILIES) {
      const handoff = buildUnsupportedFamilyAiContextHandoff(family, { canonical_href: `/${family}/` });
      assert.equal(handoff.status, "unsupported_family", family);
      assert.equal(handoff.tools.length, 0, family);
      assert.equal(handoff.setup_href, AI_CONTEXT_SETUP_PATH, family);
    }

    // Existing tools that represent browse scopes stay exact rather than general.
    const contractsBrowse = buildBrowseContractsAiContextHandoff({ query: "heat pumps", agency: "Housing" });
    assert.equal(contractsBrowse.status, "ok");
    assert.deepEqual(contractsBrowse.tools, ["browse_contracts"]);
    assert.equal(contractsBrowse.arguments.query, "heat pumps");
    assert.equal(contractsBrowse.arguments.agency, "Housing");

    const orgsBrowse = buildBrowseOrganizationsAiContextHandoff({ query: "education" });
    assert.equal(orgsBrowse.status, "ok");
    assert.deepEqual(orgsBrowse.tools, ["browse_organizations"]);

    const landBrowse = buildBrowseLandProjectsAiContextHandoff({ query: LAND_ID });
    assert.equal(landBrowse.status, "ok");
    assert.deepEqual(landBrowse.tools, ["browse_land_projects"]);
  });
});
test("A2 contract, notice, and land recipes preserve exact public ids and routes", () => {
  const contract = buildContractAiContextHandoff({ procurement_id: CONTRACT_ID });
  assert.equal(contract.id, CONTRACT_ID);
  assert.equal(contract.arguments.procurement_id, CONTRACT_ID);
  assert.equal(contract.tools[0], "get_contract");
  assert.equal(contract.canonical_href, `/procurements/${encodeURIComponent(CONTRACT_ID)}`);
  assert.match(contract.task, /CT107120258801626/);

  const notice = buildNoticeAiContextHandoff({ request_id: NOTICE_ID });
  assert.equal(notice.id, NOTICE_ID);
  assert.equal(notice.arguments.request_id, NOTICE_ID);
  assert.equal(notice.tools[0], "get_notice");
  assert.equal(notice.canonical_href, `/notices/${NOTICE_ID}/`);

  const land = buildLandProjectAiContextHandoff({ project_id: LAND_ID });
  assert.equal(land.id, LAND_ID);
  assert.equal(land.arguments.project_id, LAND_ID);
  assert.deepEqual(land.tools, ["get_land_project", "get_land_decision_path"]);
  assert.equal(land.canonical_href, `/browse/zoning/#land/${LAND_ID}`);
  assert.match(land.task, /decision/);

  const search = buildSearchAiContextHandoff({
    mode: "notices",
    query: "heat pumps",
    agency: "Housing",
    min_amount: 100000,
  });
  assert.equal(search.tools[0], "search_notices");
  assert.equal(search.arguments.query, "heat pumps");
  assert.equal(search.arguments.agency, "Housing");
  assert.equal(search.arguments.min_amount, 100000);
});

test("A3 unsupported exact filters stay explicit and never broaden silently", () => {
  const handoff = buildSearchAiContextHandoff({
    query: "heat pumps",
    lenses: ["money"],
    boro: "Brooklyn",
    when: "week",
    agency: "Housing",
  });
  assert.equal(handoff.status, "unsupported_filters");
  assert.equal(handoff.support, "unsupported");
  assert.ok(handoff.unsupported_filters.includes("boro"));
  assert.ok(handoff.unsupported_filters.includes("when"));
  assert.ok(handoff.unsupported_filters.includes("agency"));
  assert.equal(handoff.setup_href, AI_CONTEXT_SETUP_PATH);
  assert.equal(handoff.tools.length, 0);
  assert.match(handoff.task, /boro/);
  assert.doesNotMatch(handoff.task, /search_federated using .*Brooklyn/);

  const byName = buildEntityAiContextHandoff({ display_name: "Department of Education" });
  assert.equal(byName.status, "missing_identity");
  assert.equal(byName.tools.length, 0);

  const rules = buildAiContextHandoff({ kind: "rules", id: "made-up" });
  assert.equal(rules.status, "unsupported_family");
});

test("A4 one More tools record action and one scoped action, without duplicates", () => {
  const handoff = buildNoticeAiContextHandoff({ request_id: NOTICE_ID });
  const region = renderMoreToolsRegion({
    body: `<button type="button" id="dcopy">Copy link</button>`,
    handoff,
  });
  assert.match(region, new RegExp(`<summary>${AI_CONTEXT_MORE_TOOLS_LABEL}</summary>`));
  assert.equal(region.match(/data-ai-context-handoff="/g)?.length, 1);
  assert.match(region, /data-more-tools="1"/);
  assert.match(region, /Investigate with an assistant/);
  assert.match(region, new RegExp(NOTICE_ID));

  const again = renderMoreToolsRegion({ handoff });
  assert.equal(again.match(/data-ai-context-handoff="/g)?.length, 1);

  const scoped = renderScopedAiContextAction(buildSearchAiContextHandoff({ query: "heat pumps" }));
  assert.match(scoped, /data-ai-context-scope="1"/);
  assert.equal(scoped.match(/data-ai-context-handoff="/g)?.length, 1);
  assert.doesNotMatch(scoped, /data-more-tools/);
});

test("A5 public context is allowlisted; private fields and hostile URLs are removed", () => {
  const cleaned = stripAiContextPrivateFields({
    request_id: NOTICE_ID,
    token: "watch-secret",
    email: "person@example.com",
    note: "private desk note",
    session_id: "sess-1",
    return_url: "https://evil.example/return",
  });
  for (const key of AI_CONTEXT_PRIVATE_KEYS) assert.equal(cleaned[key], undefined);
  assert.equal(cleaned.request_id, NOTICE_ID);

  const handoff = buildNoticeAiContextHandoff({
    request_id: NOTICE_ID,
    token: "watch-secret",
    email: "person@example.com",
    private_note: "do not publish",
    session_id: "sess-1",
    return_url: "https://evil.example/return",
    canonical_href: "https://evil.example/notices/1",
  });
  assert.equal(handoff.status, "ok");
  assert.equal(handoff.canonical_href, `/notices/${NOTICE_ID}/`);
  const task = formatAiContextTask(handoff);
  assert.doesNotMatch(task, /watch-secret|person@example\.com|sess-1|evil\.example|private desk/i);
  assert.match(task, /never connects an account|Do not create a watch/i);

  const href = aiContextHandoffHref(handoff);
  assert.ok(href.startsWith(AI_CONTEXT_SETUP_PATH));
  assert.doesNotMatch(href, /token=|email=|session|return=/);
  assert.equal(parseAiContextHandoff(`${href}&token=abc&email=a@b.c&return=https://evil.example`).id, NOTICE_ID);

  const link = renderAiContextHandoffLink(handoff, { label: `<script>` });
  assert.match(link, /&lt;script&gt;/);
  assert.doesNotMatch(link, /<script>/);
});

test("A6 setup page and discovery suites remain reachable deliverables", async () => {
  const html = await readFile(new URL("../site/use-with-ai/index.html", import.meta.url), "utf8");
  assert.match(html, /data-ai-context-mount|ai_context_handoff/);
  assert.match(html, new RegExp(AI_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /data-copy-endpoint/);

  const panel = renderAiContextTaskPanel(buildContractAiContextHandoff({ procurement_id: CONTRACT_ID }));
  assert.match(panel, /data-ai-context-panel="1"/);
  assert.match(panel, /data-copy-ai-context-task/);
  assert.match(panel, /CT107120258801626/);
  assert.match(panel, /get_contract/);
});

test("URL round-trip keeps land decision-path tools and meeting identity", () => {
  const land = buildLandProjectAiContextHandoff({ project_id: LAND_ID });
  const parsedLand = parseAiContextHandoff(aiContextHandoffHref(land));
  assert.equal(parsedLand.id, LAND_ID);
  assert.deepEqual(parsedLand.tools, ["get_land_project", "get_land_decision_path"]);

  const meeting = buildMeetingAiContextHandoff({ meeting_id: MEETING_ID });
  const parsedMeeting = parseAiContextHandoff(aiContextHandoffHref(meeting));
  assert.equal(parsedMeeting.id, MEETING_ID);
  assert.equal(parsedMeeting.tools[0], "get_meeting");
});
