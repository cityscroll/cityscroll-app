import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import path from "node:path";

import {
  OFFICIAL_EVENT_GATE,
  buildOfficialCommitteeView,
  buildOfficialConnectionView,
  measureOfficialCoverage,
  officialConnectionScopeHash,
  renderOfficialCoverageHTML,
} from "../site/official_connections.mjs";
import * as CrolScope from "../site/scope_v0.mjs";

const people = JSON.parse(
  readFileSync(new URL("../site/data/people_domain_observations.json", import.meta.url), "utf8"),
);
const lookup = JSON.parse(
  readFileSync(new URL("../site/data/person_votes_lookup.json", import.meta.url), "utf8"),
);
const RECEIPT_PATH = (() => {
  const receiptDir = path.resolve(
    new URL("../site/data/legistar_sources/verification_receipts/", import.meta.url).pathname,
  );
  const candidates = readdirSync(receiptDir)
    .filter((name) => typeof name === "string" && name.startsWith("official_person_vote_retention_") && name.endsWith(".json"))
    .sort();
  const eventIds = new Set((people.rows || []).map((row) => String(row?.event_id || "").trim()).filter(Boolean));
  for (const name of candidates.slice().reverse()) {
    const candidate = path.join(receiptDir, name);
    const receipt = JSON.parse(readFileSync(candidate, "utf8"));
    const receiptEvents = new Set((receipt.by_event || []).map((row) => String(row?.event_id || "").trim()));
    if (eventIds.size && [...eventIds].every((id) => receiptEvents.has(id))) return candidate;
  }
  return path.join(receiptDir, candidates.at(-1) || "official_person_vote_retention_2026-08-02.json");
})();
const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
const RECEIPT_AUDIT = receipt.after_live_audit
  || receipt[Object.keys(receipt).find((key) => /^after_live_audit_\d{4}_\d{2}_\d{2}$/.test(key))] || {};
const RETENTION_RATE = Number.isFinite(Number(RECEIPT_AUDIT.person_vote_retention_rate))
  ? Number(RECEIPT_AUDIT.person_vote_retention_rate)
  : Number.isFinite(Number(receipt?.audit?.person_vote_retention_rate))
    ? Number(receipt.audit.person_vote_retention_rate)
    : null;
const RETAINED_ROWS = Number.isFinite(Number(RECEIPT_AUDIT.retained_person_id_rows))
  ? Number(RECEIPT_AUDIT.retained_person_id_rows)
  : Number.isFinite(Number(receipt?.audit?.retained_person_id_rows))
    ? Number(receipt.audit.retained_person_id_rows)
    : null;
const ELIGIBLE_ROWS = Number.isFinite(Number(RECEIPT_AUDIT.eligible_vote_rows))
  ? Number(RECEIPT_AUDIT.eligible_vote_rows)
  : Number.isFinite(Number(receipt?.audit?.eligible_vote_rows))
    ? Number(receipt.audit.eligible_vote_rows)
    : null;
const RETAINED_EVENT_IDS = new Set(
  (Array.isArray(receipt.by_event) ? receipt.by_event : [])
    .filter((row) => Number(row.retained_person_id_rows || 0) > 0)
    .map((row) => String(row.event_id || "").trim())
    .filter(Boolean),
).size;
const EXPECTED_READER_LABEL =
  (receipt.promotion_gate?.promoted ?? false) ? "official_decision_constellation" : "published_roll_calls_in_this_corpus";

test("official coverage measures the eligible committed cohort and gate outcome from the live receipt", () => {
  const coverage = measureOfficialCoverage(people, receipt);

  assert.equal(coverage.cohort, "materialized_legistar_roll_call_events");
  assert.equal(coverage.eligible_event_count, receipt.source_count?.event_rows_with_retained_by_person || 0);
  assert.equal(coverage.retained_event_count, RETAINED_EVENT_IDS);
  assert.equal(coverage.event_coverage_rate, Number.isFinite(coverage.retained_event_count)
    && Number.isFinite(coverage.eligible_event_count)
    && coverage.eligible_event_count > 0
      ? Number((coverage.retained_event_count / coverage.eligible_event_count).toFixed(4))
      : 0);
  assert.equal(coverage.retention_audit.eligible_vote_rows, ELIGIBLE_ROWS);
  assert.equal(coverage.retention_audit.retained_person_id_rows, RETAINED_ROWS);
  if (RETENTION_RATE == null) {
    assert.equal(coverage.retention_audit.rate, null);
  } else {
    assert.equal(coverage.retention_audit.rate, RETENTION_RATE);
  }
  assert.equal(coverage.gate.minimum_retention_rate, receipt.promotion_gate?.minimum_retention_rate);
  assert.equal(coverage.gate.minimum_distinct_events, receipt.promotion_gate?.minimum_distinct_events);
  assert.equal(coverage.gate.retention_pass, receipt.promotion_gate?.retention_pass);
  assert.equal(coverage.gate.event_count_pass, receipt.promotion_gate?.event_count_pass);
  assert.equal(coverage.gate.promoted, receipt.promotion_gate?.promoted);
  assert.equal(coverage.reader_label, EXPECTED_READER_LABEL);
});

test("official lookup carries reproducible coverage and fixed promotion bars", () => {
  assert.deepEqual(lookup.coverage, measureOfficialCoverage(people, receipt));
  assert.deepEqual(lookup.coverage.gate, {
    minimum_retention_rate: OFFICIAL_EVENT_GATE.minimum_retention_rate,
    minimum_distinct_events: OFFICIAL_EVENT_GATE.minimum_distinct_events,
    retention_pass: receipt.promotion_gate?.retention_pass ?? false,
    event_count_pass: receipt.promotion_gate?.event_count_pass ?? false,
    promoted: receipt.promotion_gate?.promoted ?? false,
  });
});

test("official decision trail groups exact votes by event and keeps strong confidence labels", () => {
  const bag = lookup.by_person_id["7801"];
  const view = buildOfficialConnectionView(bag, lookup.coverage, {
    currentHash: "#meetings?when=month",
    scope: CrolScope,
  });

  assert.equal(view.official.ref, "entity:official:7801");
  assert.equal(view.vote_count, bag.vote_count);
  assert.ok(view.events.length >= 1);
  assert.ok(view.events.every((event) => event.event_id && event.notice_id));
  assert.ok(view.events.every((event) => event.votes.every((vote) =>
    vote.confidence === "strong" && vote.relation === "votes_on"
  )));
  assert.equal(view.coverage.gate.promoted, receipt.promotion_gate?.promoted ?? false);
  assert.equal(view.reader_label, EXPECTED_READER_LABEL);
});

test("official reader label omits promotion thresholds and audit methodology", () => {
  const bag = lookup.by_person_id["7801"];
  const view = buildOfficialConnectionView(bag, lookup.coverage, { scope: CrolScope });
  const html = renderOfficialCoverageHTML(view, {
    translate: (key) => ({
      official_coverage_bounded_label: "Published roll calls in this corpus",
      official_coverage_promoted_label: "Official decision constellation",
    })[key] || key,
  });
  assert.match(html, /Published roll calls in this corpus|Official decision constellation/);
  assert.doesNotMatch(html, /Coverage gate|promotion|retention|committed cohort|<progress/i);
});

test("official scope links round-trip the exact person identity and votes_on relation", () => {
  const bag = lookup.by_person_id["7801"];
  const view = buildOfficialConnectionView(bag, lookup.coverage, {
    currentHash: "#meetings?when=month&group=place",
    scope: CrolScope,
  });
  const all = CrolScope.scopeFromRouteHash(view.view_all_href);
  assert.deepEqual(all.facets.domains, ["meetings"]);
  assert.deepEqual(all.facets.values.entity_refs_all, ["entity:official:7801"]);
  assert.equal(all.facets.values.connection_relation, "votes_on");

  const applied = CrolScope.scopeFromRouteHash(view.apply_scope_href);
  assert.deepEqual(applied.facets.values.entity_refs_all, ["entity:official:7801"]);
  assert.equal(applied.time_window.preset, "month");
  assert.equal(applied.facets.values.group, "place");
  assert.equal(
    officialConnectionScopeHash(bag, { scope: CrolScope }),
    view.view_all_href,
  );
});

test("missing person identity never creates an official scope", () => {
  const view = buildOfficialConnectionView(
    { person_name: "Unknown", votes: [{ event_id: "1", matter_id: "2" }] },
    lookup.coverage,
    { scope: CrolScope },
  );
  assert.equal(view.official.ref, "");
  assert.equal(view.view_all_href, "");
  assert.equal(view.apply_scope_href, "");

  const nameDerived = buildOfficialConnectionView(
    { person_id: "name:unknown-member", person_name: "Unknown", votes: [] },
    lookup.coverage,
    { scope: CrolScope },
  );
  assert.equal(nameDerived.official.ref, "");
  assert.equal(nameDerived.view_all_href, "");
});

test("official committee view keeps empty and unknown graph states distinct", () => {
  const published = buildOfficialCommitteeView(
    { person_id: "7801", person_name: "Christopher Marte" },
    {
      publication: "published",
      public_edges: [{ type: "member_of", from: "official:7801", to: "committee:5261" }],
      public_reverse_edges: [{ type: "has_member", from: "committee:5261", to: "official:7801" }],
    },
  );
  assert.equal(published.state, "matched");
  assert.equal(published.edges.length, 1);
  assert.equal(published.reverse_edges.length, 1);
  assert.equal(buildOfficialCommitteeView({ person_id: "7801" }, { publication: "published" }).state, "empty");
  assert.equal(buildOfficialCommitteeView({ person_id: "7801" }, null).state, "unknown");
});
