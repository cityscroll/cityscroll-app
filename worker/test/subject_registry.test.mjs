/**
 * Characterization: subject registry + cross_subject_link_rate.
 *
 * verify:
 *   node --test worker/test/subject_registry.test.mjs worker/test/checkbook_lifecycle.test.mjs worker/test/civic_time_contract.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { assembleLifecycle } from "../src/lib/checkbook_lifecycle.mjs";
import { mapFixtureDoc } from "../src/lib/civic_time.mjs";
import { labelOcpDisagreements } from "../src/lib/claim_layer.mjs";
import { subjectRefForActionObject } from "../src/lib/action_log.mjs";
import {
  SUBJECT_REGISTRY_VERSION,
  attachSubjectRefToClaims,
  formatSubjectRef,
  linksFromCivicFixtureDoc,
  linksFromLifecycle,
  linksFromMeetingRecord,
  linksFromProcurementPair,
  linksFromRuleRecord,
  makeSubjectLink,
  measureCrossSubjectLinkRate,
  measureRulesMeetingsSubjectLinkRate,
  migrateLegacySubjectRef,
  parseSubjectRef,
  resolveConnectedSubjects,
  rulesNativeId,
  subjectRefFromSourceRecord,
  subjectRefsUnchanged,
  subjectsConnected,
} from "../src/lib/subject_registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = JSON.parse(
  readFileSync(join(ROOT, "worker/test/fixtures/subject-registry/pin_bearing_awards.json"), "utf8"),
);
const MONEY_DOC = JSON.parse(
  readFileSync(join(ROOT, "worker/test/fixtures/civic-time/money_award.json"), "utf8"),
);

test("parse/format subject_ref is closed and never rewrites kind or id", () => {
  assert.deepEqual(parseSubjectRef("notice:20240723114"), {
    kind: "notice",
    id: "20240723114",
    ref: "notice:20240723114",
  });
  assert.equal(formatSubjectRef("contract", "CT107120248803393"), "contract:CT107120248803393");
  assert.equal(parseSubjectRef("mystery:xyz"), null, "unknown kind fails closed");
  assert.equal(parseSubjectRef("notice:"), null);
  assert.equal(formatSubjectRef("notice", "bad id"), null, "whitespace id rejected");
  // Silent rewrite would map notice → contract; registry must not.
  assert.notEqual(
    formatSubjectRef("notice", "20240723114"),
    formatSubjectRef("contract", "CT107120248803393"),
  );
});

test("legacy obligation graph refs migrate narrowly without rewriting watch storage ids", () => {
  assert.equal(
    migrateLegacySubjectRef("obligation:53408-003"),
    "mandate:53408-003",
  );
  assert.equal(
    migrateLegacySubjectRef("obligation:53408-003:2026-09-30"),
    "obligation:53408-003:2026-09-30",
    "deadline watch identity remains an explicit storage alias",
  );
  assert.equal(migrateLegacySubjectRef("notice:53408-003"), "notice:53408-003");
  assert.equal(migrateLegacySubjectRef("unrelated:53408-003"), "unrelated:53408-003");
  assert.equal(migrateLegacySubjectRef(null), null);
});

test("source_record and action-log objects map onto the same subject vocabulary", () => {
  assert.equal(
    subjectRefFromSourceRecord({ source_system: "city_record", source_system_id: "20260623008" }),
    "notice:20260623008",
  );
  assert.equal(
    subjectRefFromSourceRecord({
      source_system: "checkbook",
      source_system_id: "CT184120268807929",
      contract_id: "CT184120268807929",
    }),
    "contract:CT184120268807929",
  );
  assert.equal(
    subjectRefForActionObject({ type: "entity_pair", id: "pair-hntb-truncation" }),
    "entity-pair:pair-hntb-truncation",
  );
  assert.equal(subjectRefForActionObject({ type: "watch", id: "w1" }), null);
});

test("money civic-time fixture keeps split subject_refs and connects them with a typed link", () => {
  const events = mapFixtureDoc(MONEY_DOC);
  const subjects = [...new Set(events.map((e) => e.subject_ref))].sort();
  assert.deepEqual(subjects, ["contract:CT107120248803393", "notice:20240723114"]);

  const links = linksFromCivicFixtureDoc(MONEY_DOC);
  assert.ok(links.length >= 1, "fixture subject_links must parse");
  assert.equal(links[0].type, "registered_as");
  assert.equal(links[0].from, "notice:20240723114");
  assert.equal(links[0].to, "contract:CT107120248803393");
  assert.equal(
    subjectsConnected("notice:20240723114", "contract:CT107120248803393", links),
    true,
  );

  // Remapping the same fixture does not rewrite subject_ref on stable event ids.
  const again = mapFixtureDoc(MONEY_DOC);
  const check = subjectRefsUnchanged(events, again);
  assert.equal(check.ok, true, JSON.stringify(check.violations));
});

test("assembleLifecycle stamps subject_refs + notice→contract link for CT107120248803393", () => {
  const notice = {
    request_id: "20231222103",
    agency_name: "Homeless Services",
    type_of_notice_description: "Award",
    start_date: "2023-12-28",
    short_title: "Families with Children City Sanctuary",
    pin: "07123E0076001",
    vendor_name: "Housing Options",
    contract_amount: "24438023",
  };
  const registered = [
    {
      id: "CT107120248803393",
      vendor: "HOUSING OPTIONS",
      current: 24438023,
      original: 24438023,
      spent: 14496646.77,
      registered: "2023-12-21",
      start: "2023-04-25",
      end: "2028-06-30",
    },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
  ];
  const result = assembleLifecycle(notice, [], registered, [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  assert.equal(result.subject_refs.notice, "notice:20231222103");
  assert.equal(result.subject_refs.contract, "contract:CT107120248803393");
  assert.equal(result.subject_refs.pin, "pin:07123E0076001");
  assert.ok(result.subject_links.some((l) => l.type === "registered_as"));
  assert.equal(
    subjectsConnected("notice:20231222103", "contract:CT107120248803393", result.subject_links),
    true,
  );
  const connected = resolveConnectedSubjects("notice:20231222103", result.subject_links);
  assert.ok(connected.includes("contract:CT107120248803393"));
  assert.ok(connected.includes("pin:07123E0076001"));
});

test("claim layer can pin multi-source assertions to the same subject_ref as civic-time", () => {
  const labeled = labelOcpDisagreements(
    [{ field: "amount", city_record: 100, ocp: 200 }],
    { subject_ref: "notice:20240723114", city_source_system_id: "20240723114" },
  );
  assert.equal(labeled[0].claim_layer.subject_ref, "notice:20240723114");
  const withAttach = attachSubjectRefToClaims(labeled[0].claim_layer.assertions, "notice:20240723114");
  assert.ok(withAttach.every((c) => c.subject_ref === "notice:20240723114"));
});

test("cross_subject_link_rate: product surface moves from 0 → 1 on field cases", () => {
  // Baseline: identity only, no product links → rate 0.
  const bare = CASES.cases.map((c) => ({ ...c, subject_links: [] }));
  const before = measureCrossSubjectLinkRate(bare);
  assert.equal(before.eligible, 3);
  assert.equal(before.linked, 0);
  assert.equal(before.rate, 0);
  assert.equal(before.metric, "cross_subject_link_rate");
  assert.equal(before.version, SUBJECT_REGISTRY_VERSION);

  // Product surface: lifecycle assemble + money fixture links.
  const productCases = CASES.cases.map((c) => {
    if (c.id === "field-housing-options-20231222103" || c.id === "field-hntb-20260623008") {
      const notice = {
        request_id: c.notice_id,
        agency_name: "Agency",
        type_of_notice_description: "Award",
        start_date: "2025-01-01",
        short_title: "Award",
        pin: c.pin,
        vendor_name: "Vendor",
        contract_amount: "1",
      };
      const registered = [
        {
          id: c.contract_id,
          vendor: "VENDOR",
          current: 1,
          original: 1,
          spent: 0,
          registered: "2025-02-01",
        },
      ];
      const lifecycle = assembleLifecycle(notice, [], registered, [], {
        lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
      });
      return { ...c, lifecycle };
    }
    // Money fixture path: civic-time subject_links.
    return {
      ...c,
      subject_links: linksFromCivicFixtureDoc(MONEY_DOC),
    };
  });

  const after = measureCrossSubjectLinkRate(productCases);
  assert.equal(after.eligible, 3);
  assert.equal(after.linked, 3);
  assert.equal(after.rate, 1);
  assert.ok(
    after.cases.every((row) => row.linked === true),
    "every PIN-bearing award field case must connect notice→contract",
  );
});

test("linksFromProcurementPair builds expected edges without rewriting subjects", () => {
  const { subject_refs, subject_links } = linksFromProcurementPair({
    notice_id: "20260623008",
    contract_id: "CT184120268807929",
    pin: "84124P0003001",
  });
  assert.equal(subject_refs.notice, "notice:20260623008");
  assert.equal(subject_refs.contract, "contract:CT184120268807929");
  assert.ok(subject_links.some((l) => l.type === "registered_as"));
  assert.ok(subject_links.some((l) => l.type === "shares_authority_key"));
  // makeSubjectLink rejects kind/type mismatches rather than coercing.
  assert.equal(
    makeSubjectLink({
      type: "registered_as",
      from: "contract:CT1",
      to: "notice:1",
    }),
    null,
  );
});

test("ambiguous multi-id registration does not invent a confident contract subject link", () => {
  const notice = {
    request_id: "X",
    agency_name: "A",
    type_of_notice_description: "Award",
    start_date: "2025-01-01",
    short_title: "S",
    pin: "84124P0003001",
    vendor_name: "V",
    contract_amount: "100",
  };
  const registered = [
    { id: "CT-AAA", vendor: "V1", current: 1000000, original: 1000000, registered: "2025-04-01" },
    { id: "CT-BBB", vendor: "V2", current: 2000000, original: 2000000, registered: "2025-04-05" },
  ];
  const result = assembleLifecycle(notice, [], registered, [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  assert.equal(result.subject_refs.notice, "notice:X");
  assert.equal(result.subject_refs.contract, undefined);
  assert.ok(!result.subject_links.some((l) => l.type === "registered_as"));
  // PIN edge from notice may still exist.
  assert.ok(result.subject_links.some((l) => l.type === "shares_authority_key"));
});

// ---------------------------------------------------------------------------
// Rules + meeting-outcomes subject stamps (catchup Target 9)
// ---------------------------------------------------------------------------

const RULES_FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "worker/test/fixtures/entity-intelligence/rules_materialized_v2.json"), "utf8"),
);
const MEETINGS_FIXTURE = JSON.parse(
  readFileSync(
    join(ROOT, "worker/test/fixtures/entity-intelligence/meeting_outcomes_materialized_v2.json"),
    "utf8",
  ),
);

test("rulesNativeId prefers guid then url and never invents", () => {
  assert.equal(
    rulesNativeId({ guid: "https://rules.cityofnewyork.us/?p=9991", url: "https://example.com/x" }),
    "https://rules.cityofnewyork.us/?p=9991",
  );
  assert.equal(rulesNativeId({ url: "https://rules.cityofnewyork.us/rule/dot/" }), "https://rules.cityofnewyork.us/rule/dot/");
  assert.equal(rulesNativeId({}), null);
  assert.equal(rulesNativeId({ guid: "has spaces" }), null);
});

test("linksFromRuleRecord stamps notice↔rules only on matched joins with real rules id", () => {
  const matched = RULES_FIXTURE.rules.find((r) => r.join?.matched);
  assert.ok(matched, "fixture must include a matched rules record");
  const { subject_refs, subject_links } = linksFromRuleRecord(matched);

  assert.equal(subject_refs.notice, "notice:20260714029");
  assert.equal(subject_refs.rules, "rules:https://rules.cityofnewyork.us/?p=9991");
  assert.equal(subject_links.length, 1);
  assert.equal(subject_links[0].type, "about_notice");
  assert.equal(subject_links[0].from, subject_refs.rules);
  assert.equal(subject_links[0].to, subject_refs.notice);
  assert.equal(subject_links[0].evidence.basis, "rules_rss_city_record_join");
  assert.equal(
    subjectsConnected(subject_refs.notice, subject_refs.rules, subject_links),
    true,
  );
  const connected = resolveConnectedSubjects(subject_refs.notice, subject_links);
  assert.ok(connected.includes(subject_refs.rules));

  // Unmatched City Record notice: notice only, no speculative rules peer or link.
  const unmatched = RULES_FIXTURE.rules.find((r) => r.join && !r.join.matched);
  assert.ok(unmatched);
  const bare = linksFromRuleRecord(unmatched);
  assert.equal(bare.subject_refs.notice, "notice:20260521021");
  assert.equal(bare.subject_refs.rules, undefined);
  assert.equal(bare.subject_links.length, 0);
});

test("linksFromMeetingRecord stamps notice↔legistar-event only on matched joins", () => {
  const matched = MEETINGS_FIXTURE.records.find((r) => r.join?.matched);
  assert.ok(matched, "fixture must include a matched meeting-outcomes record");
  const { subject_refs, subject_links } = linksFromMeetingRecord(matched);

  assert.equal(subject_refs.notice, "notice:20260706036");
  assert.equal(subject_refs["legistar-event"], "legistar-event:22526");
  assert.equal(subject_links.length, 1);
  assert.equal(subject_links[0].type, "about_notice");
  assert.equal(subject_links[0].from, "legistar-event:22526");
  assert.equal(subject_links[0].to, "notice:20260706036");
  assert.equal(subject_links[0].evidence.basis, "legistar_city_record_join");
  assert.equal(
    subjectsConnected("notice:20260706036", "legistar-event:22526", subject_links),
    true,
  );

  // Unmatched non-Council hearing: notice only — no invented legistar-event.
  const unmatched = MEETINGS_FIXTURE.records.find((r) => r.join && !r.join.matched);
  assert.ok(unmatched);
  const bare = linksFromMeetingRecord(unmatched);
  assert.equal(bare.subject_refs.notice, "notice:20260716022");
  assert.equal(bare.subject_refs["legistar-event"], undefined);
  assert.equal(bare.subject_links.length, 0);
});

test("rules_meetings_subject_link_rate: product stamps connect matched peers only", () => {
  const product = [
    (() => {
      const row = RULES_FIXTURE.rules.find((r) => r.join?.matched);
      return { ...row, ...linksFromRuleRecord(row) };
    })(),
    (() => {
      const row = MEETINGS_FIXTURE.records.find((r) => r.join?.matched);
      return { ...row, ...linksFromMeetingRecord(row) };
    })(),
    (() => {
      const row = MEETINGS_FIXTURE.records.find((r) => r.join && !r.join.matched);
      return { ...row, ...linksFromMeetingRecord(row) };
    })(),
  ];
  const measured = measureRulesMeetingsSubjectLinkRate(product);
  assert.equal(measured.metric, "rules_meetings_subject_link_rate");
  assert.equal(measured.version, SUBJECT_REGISTRY_VERSION);
  // Matched rules + matched meeting are eligible; unmatched notice alone is not.
  assert.equal(measured.eligible, 2);
  assert.equal(measured.linked, 2);
  assert.equal(measured.rate, 1);

  // Bare identity without product links → eligible but rate 0.
  const bare = [
    RULES_FIXTURE.rules.find((r) => r.join?.matched),
    MEETINGS_FIXTURE.records.find((r) => r.join?.matched),
  ].map((row) => ({ ...row, subject_links: [] }));
  const before = measureRulesMeetingsSubjectLinkRate(bare);
  assert.equal(before.eligible, 2);
  assert.equal(before.linked, 0);
  assert.equal(before.rate, 0);
});
