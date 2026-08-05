import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OFFICIAL_EVENT_GATE,
  buildOfficialConnectionView,
  measureOfficialCoverage,
  officialConnectionScopeHash,
} from "../site/official_connections.mjs";
import * as CrolScope from "../site/scope_v0.mjs";

const people = JSON.parse(
  readFileSync(new URL("../site/data/people_domain_observations.json", import.meta.url), "utf8"),
);
const lookup = JSON.parse(
  readFileSync(new URL("../site/data/person_votes_lookup.json", import.meta.url), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    new URL(
      "../site/data/legistar_sources/verification_receipts/official_person_vote_retention_2026-08-02.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("official coverage measures the eligible committed cohort without promoting six events", () => {
  const coverage = measureOfficialCoverage(people, receipt);

  assert.equal(coverage.cohort, "materialized_legistar_roll_call_events");
  assert.equal(coverage.eligible_event_count, 6);
  assert.equal(coverage.retained_event_count, 6);
  assert.equal(coverage.event_coverage_rate, 1);
  assert.equal(coverage.retention_audit.eligible_vote_rows, 49);
  assert.equal(coverage.retention_audit.retained_person_id_rows, 49);
  assert.equal(coverage.retention_audit.rate, 1);
  assert.equal(coverage.gate.minimum_retention_rate, 0.95);
  assert.equal(coverage.gate.minimum_distinct_events, 30);
  assert.equal(coverage.gate.retention_pass, true);
  assert.equal(coverage.gate.event_count_pass, false);
  assert.equal(coverage.gate.promoted, false);
  assert.equal(coverage.reader_label, "published_roll_calls_in_this_corpus");
});

test("official lookup carries reproducible coverage and fixed promotion bars", () => {
  assert.deepEqual(lookup.coverage, measureOfficialCoverage(people, receipt));
  assert.deepEqual(lookup.coverage.gate, {
    minimum_retention_rate: OFFICIAL_EVENT_GATE.minimum_retention_rate,
    minimum_distinct_events: OFFICIAL_EVENT_GATE.minimum_distinct_events,
    retention_pass: true,
    event_count_pass: false,
    promoted: false,
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
  assert.equal(view.coverage.gate.promoted, false);
  assert.equal(view.reader_label, "published_roll_calls_in_this_corpus");
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
