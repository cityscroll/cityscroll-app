import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProvisionHistoryIndex,
  getProvisionAsOf,
  redesignationCopy,
} from "../site/code_provision_history.mjs";
import {
  materializeCodeChange,
  resolveCodeChangeEffectiveDate,
} from "../site/code_version_materialization.mjs";
import {
  buildExplicitLegalChangeGraph,
  extractExplicitCodeChanges,
  indexLegalChanges,
  parseRedesignationClause,
  renderLegalChangeList,
  renderLegalChangeSummary,
} from "../site/legal_change_edges.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import pagesEdge, { edgeRequestKind } from "../site/pages_edge.mjs";
import { lookupAdminCodeCitation } from "../site/admin_code.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/code_provision_history.json", import.meta.url), "utf8"));
const provision = fixtures.provision;

function materialize(name, extra = {}) {
  const fixture = fixtures[name];
  return materializeCodeChange(fixture.change, {
    provision: extra.provision === undefined ? provision : extra.provision,
    as_of: extra.as_of ?? fixture.as_of,
    enacted_at: fixture.enacted_at,
    local_law: extra.local_law,
  });
}

function graphFor(change, extra = {}) {
  return buildExplicitLegalChangeGraph({
    matter: { id: change.matter_id },
    local_law: extra.local_law || {
      id: change.legal_instrument_id,
      matter_id: change.matter_id,
      local_law_number: "123",
      enacted_at: extra.enacted_at || "2026-08-01",
      effective_at: change.effective_at,
    },
    source_text: extra.source_text || change.source.instruction_text,
    source: change.source,
    corpus_id: "nyc-administrative-code",
  });
}

test("REDESIGNATE preserves an explicit relation and formerly-paragraph copy", () => {
  const parsed = parseRedesignationClause(fixtures.redesignate_paragraph.source_text);
  assert.equal(parsed.former_label.toLowerCase(), "paragraph 7");
  assert.equal(parsed.successor_label.toLowerCase(), "paragraph 8");

  const extracted = extractExplicitCodeChanges({
    matter_id: "79102",
    legal_instrument_id: "local-law:123-2026",
    state: "enacted",
    source_ref: "council:local-law:123-2026",
    source_text: fixtures.redesignate_paragraph.source_text,
  });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].operation, "redesignate");
  assert.equal(extracted[0].redesignation.former_label.toLowerCase(), "paragraph 7");
  assert.equal(extracted[0].redesignation.successor_label.toLowerCase(), "paragraph 8");
  assert.equal(extracted[0].target.provision_id, "nyc-administrative-code:16-120");

  const result = materialize("redesignate_paragraph");
  assert.equal(result.materialization_status, "materialized");
  assert.equal(result.change.operation, "redesignate");
  assert.equal(result.redesignation.former_label, "paragraph 7");
  assert.equal(result.versions.every((version) => version.text !== "Fabricated"), true);
  assert.equal(result.provision.current_text, provision.current_text);
  assert.equal(redesignationCopy(result.change), "Formerly paragraph 7");

  const html = renderLegalChangeList([result.change]);
  assert.match(html, />REDESIGNATE</);
  assert.match(html, /Formerly paragraph 7/);
  assert.match(html, /data-redesignation="1"/);
  const page = renderAdminCodeProvisionDocument(provision, {
    changes: [result.change],
    versions: result.versions,
    as_of: "2026-11-01",
  });
  assert.match(page, /Formerly paragraph 7/);
});

test("section redesignation keeps both identities and as-of returns old then moved text", () => {
  const extracted = extractExplicitCodeChanges({
    matter_id: "79102",
    legal_instrument_id: "local-law:123-2026",
    state: "enacted",
    source_ref: "council:local-law:123-2026",
    source_text: fixtures.redesignate_section.source_text,
  });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].redesignation.successor_provision_id, "nyc-administrative-code:16-121");

  const graph = graphFor(fixtures.redesignate_section.change, {
    source_text: fixtures.redesignate_section.source_text,
  });
  assert.ok(graph.edges.some((edge) => edge.relation === "redesignated_as"));
  assert.equal(graph.edges.find((edge) => edge.relation === "redesignated_as").to_ref, "nyc-administrative-code:16-121");

  const before = materialize("redesignate_section", { as_of: "2026-10-31" });
  assert.equal(before.materialization_status, "materialized");
  assert.equal(before.provision.status, "current");
  assert.equal(before.provision.current_text, provision.current_text);

  const after = materialize("redesignate_section", { as_of: "2026-11-01" });
  assert.equal(after.provision.status, "redesignated");
  assert.equal(after.provision.current_text, "");
  assert.equal(after.successor_provision.id, "nyc-administrative-code:16-121");
  assert.equal(after.successor_provision.current_text, provision.current_text);
  assert.equal(after.successor_versions[0].text, after.versions.find((version) => version.valid_to === "2026-11-01").text);

  const formerAsOf = getProvisionAsOf({
    provision_id: provision.id,
    versions: after.versions,
    changes: [after.change],
    as_of: "2026-10-31",
  });
  assert.equal(formerAsOf.status, "current");
  assert.equal(formerAsOf.text, provision.current_text);
  const formerAfter = getProvisionAsOf({
    provision_id: provision.id,
    versions: after.versions,
    changes: [after.change],
    as_of: "2026-11-01",
  });
  assert.equal(formerAfter.status, "redesignated");
  assert.equal(formerAfter.text, null);
  const successorAfter = getProvisionAsOf({
    provision_id: "nyc-administrative-code:16-121",
    versions: after.successor_versions,
    changes: [after.change],
    as_of: "2026-11-01",
  });
  assert.equal(successorAfter.text, provision.current_text);
  assert.match(successorAfter.redesignation_label, /Formerly section 16-120/i);
});

test("as-of returns old text before an amendment and new text on or after it", () => {
  const result = materialize("safe_amend");
  const before = getProvisionAsOf({
    provision_id: provision.id,
    versions: result.versions,
    changes: [result.change],
    as_of: "2026-10-31",
  });
  const onDate = getProvisionAsOf({
    provision_id: provision.id,
    versions: result.versions,
    changes: [result.change],
    as_of: "2026-11-01",
  });
  assert.equal(before.text, provision.current_text);
  assert.equal(before.used_publisher_current_text, false);
  assert.equal(onDate.text, "New statutory text.\nSecond paragraph.");
  const pageBefore = renderAdminCodeProvisionDocument(provision, {
    changes: [result.change],
    versions: result.versions,
    as_of: "2026-10-31",
  });
  const currentSection = pageBefore.match(/<section aria-labelledby="current-text">[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(currentSection, /Old statutory text/);
  assert.doesNotMatch(currentSection, /New statutory text/);
  assert.match(pageBefore, /name="as_of"/);
});

test("REPEAL preserves historical addressability and links the repealing law", () => {
  const result = materialize("safe_repeal");
  const historical = getProvisionAsOf({
    provision_id: provision.id,
    versions: result.versions,
    changes: [result.change],
    as_of: "2026-10-31",
  });
  const repealed = getProvisionAsOf({
    provision_id: provision.id,
    versions: result.versions,
    changes: [result.change],
    as_of: "2026-11-01",
  });
  assert.equal(historical.text, provision.current_text);
  assert.equal(repealed.status, "repealed");
  assert.equal(repealed.text, null);
  const html = renderLegalChangeList([result.change]);
  assert.match(html, /Repealing law/);
  assert.match(html, /href="\/matters\/79102\/"/);
  const page = renderAdminCodeProvisionDocument(provision, {
    changes: [result.change],
    versions: result.versions,
    as_of: "2026-11-01",
  });
  assert.match(page, /repealed \/ inactive|Status: repealed/);
  assert.match(page, /Repealing law/);
});

test("law and provision indexes keep source links and do not replace historical text", () => {
  const amend = materialize("safe_amend");
  const add = materialize("safe_add", { provision: null });
  const graphs = [
    graphFor(fixtures.safe_amend.change),
    graphFor(fixtures.safe_add.change),
  ];
  const index = buildProvisionHistoryIndex({
    graphs,
    versions: {
      [provision.id]: amend.versions,
      [add.provision.id]: add.versions,
    },
    provisions: {
      [provision.id]: provision,
      [add.provision.id]: add.provision,
    },
  });
  assert.ok(index.by_law["local-law:123-2026"].provision_ids.includes(provision.id));
  assert.ok(index.by_law["local-law:123-2026"].provision_ids.includes(add.provision.id));
  assert.ok(index.by_provision[provision.id].source_urls[0].includes("legistar.council.nyc.gov"));
  const legalIndex = indexLegalChanges(graphs);
  assert.ok(legalIndex.by_law["local-law:123-2026"].length >= 1);

  const historical = getProvisionAsOf({
    provision_id: provision.id,
    versions: amend.versions,
    changes: [amend.change],
    as_of: "2026-10-31",
  });
  assert.notEqual(historical.text, "New statutory text.\nSecond paragraph.");
  const summary = renderLegalChangeSummary(graphs[0]);
  assert.match(summary, /What this law changed/);
  assert.match(summary, /href="\/administrative-code\/16-120\//);
});

test("delayed and partial/conditional dates keep enacted visibility off current-law text", () => {
  const delayedDate = resolveCodeChangeEffectiveDate(fixtures.delayed.change, {
    enacted_at: fixtures.delayed.enacted_at,
  });
  assert.equal(delayedDate.effective_at, "2026-10-30");
  const delayed = materialize("delayed");
  assert.equal(delayed.change.state, "enacted");
  const asOfEnactment = getProvisionAsOf({
    provision_id: provision.id,
    versions: delayed.versions,
    changes: [delayed.change],
    as_of: "2026-08-01",
  });
  const asOfEffective = getProvisionAsOf({
    provision_id: provision.id,
    versions: delayed.versions,
    changes: [delayed.change],
    as_of: "2026-10-30",
  });
  assert.equal(asOfEnactment.text, provision.current_text);
  assert.equal(asOfEffective.text, "New statutory text.\nSecond paragraph.");

  const partial = materialize("partial");
  assert.equal(partial.materialization_status, "unresolved");
  assert.equal(partial.change.id, fixtures.partial.change.id);
  assert.doesNotMatch(JSON.stringify(partial.versions), /New statutory text/);

  const conditional = materialize("conditional");
  assert.equal(conditional.materialization_status, "unresolved");
  assert.equal(conditional.change.materialization_status, "unresolved");
});

test("failed patch retains the CodeChange and emits no new version", () => {
  const result = materialize("patch_failure");
  assert.equal(result.materialization_status, "unresolved");
  assert.equal(result.change.id, fixtures.patch_failure.change.id);
  assert.equal(result.versions.length, 1);
  assert.doesNotMatch(result.versions[0].text, /Fabricated/);
  const asOf = getProvisionAsOf({
    provision_id: provision.id,
    versions: result.versions,
    changes: [result.change],
    as_of: "2026-11-01",
  });
  assert.notEqual(asOf.text, "Fabricated text must not appear.");
});

test("unknown validity is not backfilled from observation time or current publisher text", () => {
  const asOf = getProvisionAsOf({
    provision_id: provision.id,
    provision,
    versions: [fixtures.unknown_validity_version],
    as_of: "2019-01-01",
  });
  assert.equal(asOf.status, "unknown");
  assert.equal(asOf.text, null);
  assert.equal(asOf.used_publisher_current_text, false);
  assert.match(asOf.reason, /known legal validity/);
  const page = renderAdminCodeProvisionDocument(provision, {
    versions: [fixtures.unknown_validity_version],
    as_of: "2019-01-01",
  });
  assert.doesNotMatch(page, /Publisher snapshot that must not backfill/);
  assert.match(page, /data-provision-as-of-status="unknown"/);
});

test("Pages edge as-of query is a legal-code document route", async () => {
  const entry = lookupAdminCodeCitation("16-120");
  const shard = JSON.parse(readFileSync(new URL(`../site/data/legal_code/${entry.shard}`, import.meta.url)));
  const row = shard.rows.find((candidate) => candidate.id === entry.id);
  const response = await pagesEdge.fetch(
    new Request("https://cityscroll.org/administrative-code/16-120/?as_of=2020-01-01"),
    {
      ASSETS: {
        async fetch(request) {
          assert.equal(new URL(request.url).pathname, `/data/legal_code/${entry.shard}`);
          return new Response(JSON.stringify({ rows: [row] }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    },
  );
  assert.equal(edgeRequestKind("https://cityscroll.org/administrative-code/16-120/?as_of=2020-01-01"), "legal-code");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /name="as_of"/);
  assert.match(html, /data-provision-as-of="2020-01-01"/);
  assert.match(html, /data-provision-as-of-status="unknown"/);
});
