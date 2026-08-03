/**
 * Characterization: civic-time event contract.
 * verify: node --test worker/test/civic_time_contract.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  EVENT_KIND_REGISTRY,
  RFX_PRODUCTION_EVENT_KINDS,
  attachMoneyCivicEvents,
  clockTable,
  clocksFromTemporalAction,
  isRegisteredEventKind,
  listEventKinds,
  makeEventId,
  mapCivicEvent,
  mapFixtureDoc,
  mapLandSpineToCivic,
  mapMeetingRecordToCivic,
  mapMoneyLifecycleToCivic,
  mapPassportRfxToCivic,
  mapRuleSpineToCivic,
  matchedRfxDetail,
  moneySpineAdapterCoverage,
  publicDiff,
  rfxSpineAdapterCoverage,
  semanticDiff,
} from "../src/lib/civic_time.mjs";
import { deriveRuleEvents, normalizeRuleItem, parseRssItems } from "../src/lib/rules.mjs";
import {
  buildLandEventSpine,
  joinCityRecordLandNotices,
  parseZapApiProject,
} from "../src/lib/zap_outcomes.mjs";
import { assembleLifecycle } from "../src/lib/checkbook_lifecycle.mjs";
import { enrichLifecycleWithPassport } from "../src/lib/passport_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = join(ROOT, "worker/test/fixtures/civic-time");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const LENS_FIXTURES = {
  money: "money_award.json",
  rules: "rules_comment_open.json",
  land: "land_zap_milestone.json",
  meetings: "meetings_council.json",
};

test("event-kind registry is bounded and covers money/rules/land/meetings/people/property", () => {
  const lenses = new Set(Object.values(EVENT_KIND_REGISTRY).map((m) => m.lens));
  assert.deepEqual([...lenses].sort(), ["land", "meetings", "money", "people", "property", "rules"]);
  assert.equal(isRegisteredEventKind("rules.comment_close"), true);
  assert.equal(isRegisteredEventKind("staffing.list_established"), true);
  assert.equal(isRegisteredEventKind("meetings.non_council_notice"), true);
  assert.equal(isRegisteredEventKind("meetings.non_council_hearing"), true);
  assert.equal(isRegisteredEventKind("property.disposition_hearing"), true);
  assert.equal(isRegisteredEventKind("property.auction_or_rfp"), true);
  assert.equal(isRegisteredEventKind("property.award_or_conveyance"), true);
  // Tax-lien-sale kinds stay out of this registry until that domain lands separately.
  assert.equal(isRegisteredEventKind("property.lien_sale"), false);
  assert.equal(isRegisteredEventKind("procurement.award_and_amendment"), false);
  assert.ok(listEventKinds("rules").every((k) => k.lens === "rules"));
  assert.ok(listEventKinds("people").every((k) => k.lens === "people"));
  assert.ok(listEventKinds("property").every((k) => k.lens === "property"));
});

test("four lens fixtures map with explicit clock labels and null unknowns", () => {
  for (const [lens, file] of Object.entries(LENS_FIXTURES)) {
    const doc = loadFixture(file);
    assert.equal(doc.lens, lens);
    const events = mapFixtureDoc(doc);
    assert.ok(events.length >= 1, `${lens} should emit events`);
    for (const event of events) {
      assert.equal(event.schema_version, 1);
      assert.ok(isRegisteredEventKind(event.event_kind));
      assert.match(event.event_id, /^cte:[a-f0-9]{24}$/);
      assert.match(event.payload_hash, /^[a-f0-9]{64}$/);
      // Clocks are always named (null when unknown) — never omitted.
      for (const clock of ["valid_at", "valid_from", "valid_to", "published_at", "observed_at", "processed_at"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(event, clock), `${lens} missing ${clock}`);
      }
    }
    // Fixture-level clock annotations when present
    for (const assertion of doc.assertions) {
      if (assertion.clocks) {
        const table = clockTable(assertion);
        for (const row of table) {
          assert.ok(
            ["valid", "publication", "observation", "processing"].includes(row.clock),
            `bad clock ${row.clock} on ${lens}`,
          );
        }
      }
    }
  }
});

test("mapper refuses unknown event kinds and does not invent publication from processing", () => {
  assert.throws(
    () =>
      mapCivicEvent({
        event_kind: "procurement.mystery_stage",
        subject_ref: "notice:1",
        source_record_ref: "x",
        source_revision: "r1",
        valid_at: "2026-01-01",
      }),
    /unknown event_kind/,
  );

  // Explicit processing without publication stays null publication.
  const env = mapCivicEvent({
    event_kind: "procurement.award_registered",
    subject_ref: "contract:CT1",
    source_record_ref: "checkbook:CT1",
    source_revision: "rev-a",
    valid_at: "2024-08-01",
    published_at: null,
    observed_at: "2024-08-02T00:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(env.published_at, null);
  assert.equal(env.processed_at, "2026-08-01T12:00:00.000Z");
  assert.equal(env.valid_at, "2024-08-01");
});

test("same source revision maps twice with byte-stable event_id and payload_hash", () => {
  const doc = loadFixture("rules_comment_open.json");
  const a = mapFixtureDoc(doc, { run_id: "run-a" });
  const b = mapFixtureDoc(doc, { run_id: "run-b" });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].event_id, b[i].event_id);
    assert.equal(a[i].payload_hash, b[i].payload_hash);
    // run_id may differ; identity does not depend on it
    assert.equal(a[i].source_revision, b[i].source_revision);
  }
  const again = makeEventId({
    subject_ref: a[0].subject_ref,
    event_kind: a[0].event_kind,
    source_revision: a[0].source_revision,
  });
  assert.equal(again, a[0].event_id);
});

test("revised source revision supersedes prior comment_close without silent overwrite", () => {
  const baseline = mapFixtureDoc(loadFixture("rules_comment_open.json"));
  const revisedDoc = loadFixture("rules_comment_revised.json");
  // Wire supersedes to the baseline comment_close event id.
  const priorComment = baseline.find((e) => e.event_kind === "rules.comment_close");
  assert.ok(priorComment);
  const assertions = revisedDoc.assertions.map((a) => {
    if (a.event_kind === "rules.comment_close") {
      return { ...a, supersedes_event_id: priorComment.event_id };
    }
    return a;
  });
  const revised = mapFixtureDoc({ ...revisedDoc, assertions });
  const diff = publicDiff(semanticDiff(baseline, revised));

  assert.equal(diff.counts.superseded, 1);
  assert.equal(diff.superseded[0].previous.event_kind, "rules.comment_close");
  assert.equal(diff.superseded[0].current.event_kind, "rules.comment_close");
  assert.notEqual(diff.superseded[0].previous.event_id, diff.superseded[0].current.event_id);
  assert.equal(diff.superseded[0].current.supersedes_event_id, priorComment.event_id);
  assert.equal(diff.superseded[0].current.valid_at, "2026-09-22");
  assert.equal(diff.superseded[0].previous.valid_at, "2026-09-15");
  // Unchanged proposal + hearing remain current
  assert.ok(diff.counts.unchanged >= 2);
  // History is additive: both event ids exist across the two runs
  assert.ok(baseline.some((e) => e.event_id === priorComment.event_id));
  assert.ok(revised.some((e) => e.event_id === diff.superseded[0].current.event_id));
});

test("empty previous run reports all current events as added", () => {
  const money = mapFixtureDoc(loadFixture("money_award.json"));
  const diff = publicDiff(semanticDiff([], money));
  assert.equal(diff.counts.added, money.length);
  assert.equal(diff.counts.unchanged, 0);
  assert.equal(diff.counts.superseded, 0);
});

test("fixture corpus is complete for the four lenses", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("expected"));
  for (const name of Object.values(LENS_FIXTURES)) {
    assert.ok(files.includes(name), `missing fixture ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Product-spine adapters (rules / land / meetings / alert clocks)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-01T12:00:00Z");

function parseRuleItem(fields = "") {
  const xml = `<rss><channel><item>
    <title>Commercial meter parking</title>
    <link>https://rules.cityofnewyork.us/rule/meter-parking/</link>
    <pubDate>Thu, 23 Jul 2026 16:18:07 +0000</pubDate>
    <agency_name>DOT</agency_name>
    ${fields}
  </item></channel></rss>`;
  return normalizeRuleItem(parseRssItems(xml)[0]);
}

test("rules spine adapter maps deriveRuleEvents without collapsing stages", () => {
  const rule = {
    ...parseRuleItem(`
    <comment_by_date>20260820</comment_by_date>
    <hearing_date_1>20260818</hearing_date_1>`),
    request_id: "20260715001",
  };
  const spine = deriveRuleEvents(rule, NOW);
  const civic = mapRuleSpineToCivic(rule, spine, {
    observed_at: "2026-07-24T08:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(
    civic.map((e) => e.event_kind),
    ["rules.proposal_published", "rules.public_hearing", "rules.comment_close"],
  );
  const comment = civic.find((e) => e.event_kind === "rules.comment_close");
  assert.equal(comment.valid_at, "2026-08-20");
  assert.equal(comment.subject_ref, "notice:20260715001");
  assert.equal(comment.observed_at, "2026-07-24T08:00:00.000Z");
  // Same spine twice is idempotent
  const again = mapRuleSpineToCivic(rule, spine, {
    observed_at: "2026-07-24T08:00:00.000Z",
    processed_at: "2026-08-02T00:00:00.000Z",
    run_id: "other-run",
  });
  assert.equal(again[0].event_id, civic[0].event_id);
  assert.equal(again[0].payload_hash, civic[0].payload_hash);
});

test("land spine adapter maps ZAP + City Record events with honest clocks", () => {
  const payload = JSON.parse(readFileSync(
    join(ROOT, "test/fixtures/zap_outcomes/joined_timbale_terrace.json"),
    "utf8",
  ));
  const record = parseZapApiProject(payload);
  record.open_data = {
    project_id: "2022M0258",
    ulurp_numbers: "240046HAM; 240047PQM",
    current_milestone: "City Council Review",
    current_milestone_date: "2024-02-01T00:00:00.000",
  };
  const notices = joinCityRecordLandNotices(
    [{
      request_id: "20230912001",
      start_date: "2023-09-12T00:00:00.000",
      event_date: "2023-09-26T18:30:00.000",
      section_name: "Public Hearings and Meetings",
      agency_name: "City Planning",
      type_of_notice_description: "Public Hearings",
      short_title: "Timbale Terrace",
      additional_description_1: "Public hearing for ULURP Nos. C 240046 HAM and C 240047 PQM.",
    }],
    record.open_data.ulurp_numbers,
  );
  const spine = buildLandEventSpine(record, { cityRecordNotices: notices, noticeLookupStatus: "ok" });
  const civic = mapLandSpineToCivic(spine, {
    project_id: "2022M0258",
    observed_at: "2024-02-01T00:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.ok(civic.length >= 3);
  assert.ok(civic.every((e) => e.subject_ref === "project:2022M0258"));
  assert.ok(civic.some((e) => e.event_kind === "land.zap_milestone"));
  assert.ok(civic.some((e) => e.event_kind === "land.city_record_notice"));
  assert.ok(civic.some((e) => e.event_kind === "land.city_record_hearing"));
  const noticePub = civic.find((e) => e.event_kind === "land.city_record_notice");
  assert.equal(noticePub.valid_at, null);
  assert.equal(noticePub.published_at, "2023-09-12");
  const hearing = civic.find((e) => e.event_kind === "land.city_record_hearing");
  assert.equal(hearing.valid_at, "2023-09-26");
});

test("meetings spine adapter maps council event + action + votes", () => {
  const record = {
    notice: {
      request_id: "20260706036",
      start_date: "2026-07-01T00:00:00.000",
    },
    council_event: {
      event_id: "22526",
      event_date: "2026-07-06",
      start_time: "2026-07-06T10:00:00",
      title: "Committee hearing",
    },
    agenda_items: [{
      event_item_id: "90001",
      action_name: "Approved by Committee",
      action_date: "2026-07-06",
      matters: [{
        matter_id: "m1",
        votes: [{ VoteValueName: "Affirmative" }, { VoteValueName: "Negative" }],
      }],
    }],
  };
  const civic = mapMeetingRecordToCivic(record, {
    observed_at: "2026-07-07T06:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(
    civic.map((e) => e.event_kind),
    ["meetings.council_event", "meetings.agenda_item_action", "meetings.roll_call_vote"],
  );
  assert.equal(civic[0].subject_ref, "legistar-event:22526");
  assert.equal(civic[0].valid_at, "2026-07-06");
  assert.equal(civic[0].published_at, "2026-07-01T00:00:00.000");
});

test("alert temporal_action clocks map event/publication/recorded without inventing processing", () => {
  const clocks = clocksFromTemporalAction({
    kind: "rules-comment-open",
    event_at: "2026-09-15",
    publication_at: "2026-07-15T15:30:00.000Z",
    recorded_at: "2026-08-01T09:00:00.000Z",
    url: "https://rules.cityofnewyork.us/rule/example/",
  });
  assert.deepEqual(clocks, [
    { field: "valid_at", value: "2026-09-15", clock: "valid" },
    { field: "published_at", value: "2026-07-15T15:30:00.000Z", clock: "publication" },
    { field: "observed_at", value: "2026-08-01T09:00:00.000Z", clock: "observation" },
  ]);
  // No processing clock invented
  assert.ok(!clocks.some((row) => row.clock === "processing"));
});

// ---------------------------------------------------------------------------
// Money lifecycle production adapter
// ---------------------------------------------------------------------------

const MILLENNIUM_NOTICE = {
  request_id: "20240723114",
  agency_name: "Homeless Services",
  type_of_notice_description: "Award",
  pin: "07124N0022001",
  vendor_name: "Acacia Network Housing Inc.",
  contract_amount: "7397875",
  short_title: "NAE-Millennium Adult Family Facility",
  start_date: "2024-07-29",
};

test("money lifecycle adapter: notice 20240723114 emits notice_published + award_registered with stable event_id", () => {
  const registered = [{
    id: "CT1-071-20258800377",
    vendor: "ACACIA",
    registered: "2024-07-22",
    original: 7397875,
    current: 7397875,
    spent: 4018484.1,
  }];
  const lifecycle = assembleLifecycle(MILLENNIUM_NOTICE, [], registered, null, {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "error" },
  });
  const meta = {
    observed_at: "2024-08-02T14:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
    run_id: "money-field-case",
  };
  const civic = mapMoneyLifecycleToCivic(lifecycle, MILLENNIUM_NOTICE, meta);
  const kinds = civic.map((e) => e.event_kind);
  assert.ok(kinds.includes("procurement.notice_published"), "award notice publication");
  assert.ok(kinds.includes("procurement.award_registered"), "Checkbook/PASSPort registration");
  assert.ok(kinds.includes("procurement.payment"), "from_registered payment assertion");
  assert.ok(civic.length >= 2, "fixture gate: ≥2 envelopes");

  const noticeEv = civic.find((e) => e.event_kind === "procurement.notice_published");
  assert.equal(noticeEv.subject_ref, "notice:20240723114");
  assert.equal(noticeEv.published_at, "2024-07-29");
  assert.equal(noticeEv.valid_at, null);

  const regEv = civic.find((e) => e.event_kind === "procurement.award_registered");
  assert.equal(regEv.subject_ref, "contract:CT1-071-20258800377");
  assert.equal(regEv.valid_at, "2024-07-22");

  const payEv = civic.find((e) => e.event_kind === "procurement.payment");
  assert.equal(payEv.status, "from_registered");
  assert.notEqual(payEv.valid_at, null);

  // Idempotent event_id / payload_hash across runs (processing clock may differ)
  const again = mapMoneyLifecycleToCivic(lifecycle, MILLENNIUM_NOTICE, {
    ...meta,
    processed_at: "2026-08-02T00:00:00.000Z",
    run_id: "money-field-case-rerun",
  });
  assert.equal(again.length, civic.length);
  for (let i = 0; i < civic.length; i++) {
    assert.equal(again[i].event_id, civic[i].event_id);
    assert.equal(again[i].payload_hash, civic[i].payload_hash);
  }

  const attached = attachMoneyCivicEvents(lifecycle, MILLENNIUM_NOTICE, meta);
  assert.ok(Array.isArray(attached.civic_events));
  assert.equal(attached.civic_events.length, civic.length);
});

test("money lifecycle adapter: unavailable payment never invents a payment event", () => {
  const lifecycle = {
    timeline: [
      {
        stage: "award",
        status: "matched",
        source: "city-record",
        date: "2024-07-29",
        detail: { request_id: "20240723114" },
      },
      {
        stage: "payment",
        status: "matched",
        source: "checkbook-spending",
        date: null,
        detail: { payment_state: "unavailable", total_spent: null },
      },
    ],
  };
  const civic = mapMoneyLifecycleToCivic(lifecycle, MILLENNIUM_NOTICE, {
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.ok(civic.some((e) => e.event_kind === "procurement.notice_published"));
  assert.ok(!civic.some((e) => e.event_kind === "procurement.payment"));
});

test("money_spine_adapter_coverage > 0 on field-case procurement lifecycles", () => {
  const hntbNotice = {
    request_id: "20260623008",
    agency_name: "Transportation",
    type_of_notice_description: "Award",
    pin: "84124P0003001",
    vendor_name: "HNTB NEW YORK ENGINEERING AND ARCHITECTURE PC",
    contract_amount: "13533763.08",
    short_title: "CM Services",
    start_date: "2026-06-23",
  };
  const pairs = [
    {
      notice: MILLENNIUM_NOTICE,
      lifecycle: assembleLifecycle(
        MILLENNIUM_NOTICE,
        [],
        [{
          id: "CT1-071-20258800377",
          vendor: "ACACIA",
          registered: "2024-07-22",
          original: 7397875,
          current: 7397875,
          spent: 4018484.1,
        }],
        null,
        {
          pinStrategy: "exact",
          lookupStatus: { pending: "ok", registered: "ok", spending: "error" },
        },
      ),
    },
    {
      notice: hntbNotice,
      lifecycle: assembleLifecycle(
        hntbNotice,
        [],
        [{
          id: "CT184120268807929",
          vendor: "HNTB",
          registered: "2026-06-22",
          original: 13533763.08,
          current: 13533763.08,
          spent: 0,
          start: "2024-10-11",
          end: "2032-10-10",
        }],
        [],
        {
          pinStrategy: "exact",
          lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
        },
      ),
    },
    {
      notice: {
        request_id: "20231222103",
        agency_name: "Housing Preservation",
        type_of_notice_description: "Award",
        pin: "07123E0076001",
        start_date: "2023-12-22",
        short_title: "Housing Options",
      },
      lifecycle: assembleLifecycle(
        {
          request_id: "20231222103",
          agency_name: "Housing Preservation",
          type_of_notice_description: "Award",
          pin: "07123E0076001",
          start_date: "2023-12-22",
          short_title: "Housing Options",
        },
        [],
        [
          {
            id: "CT107120248803393",
            vendor: "HOUSING OPTIONS",
            registered: "2023-12-21",
            original: 24438023,
            current: 24438023,
            spent: 14496646.77,
            vendorRecordType: "Prime Vendor",
          },
          {
            id: "CT107120248803393",
            vendor: "SUBCO",
            registered: "2023-12-21",
            original: 0,
            current: 0,
            spent: 0,
            vendorRecordType: "Sub Vendor",
          },
        ],
        [{ amount: 100, date: "2024-01-15", contractId: "CT107120248803393" }],
        {
          pinStrategy: "exact",
          lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
        },
      ),
    },
  ];

  const metric = moneySpineAdapterCoverage(pairs);
  // Baseline before this adapter was 0; production path must move the metric above zero.
  assert.ok(metric.with_lifecycle >= 3, `expected field cases, got ${metric.with_lifecycle}`);
  assert.ok(metric.coverage > 0, `money_spine_adapter_coverage must be >0, got ${metric.coverage}`);
  assert.equal(metric.coverage, 1, "all three field cases emit ≥1 Money civic event");
  assert.ok(metric.kinds["procurement.notice_published"] >= 1);
  assert.ok(metric.kinds["procurement.award_registered"] >= 1);
  assert.ok(metric.kinds["procurement.payment"] >= 1);
});

// ---------------------------------------------------------------------------
// PASSPort RFx solicitation production spine (open → addenda → due → award)
// ---------------------------------------------------------------------------

const RFX_SOLICITATION_NOTICE = {
  request_id: "20260707026",
  pin: "81026B0003",
  type_of_notice_description: "Solicitation",
  agency_name: "Buildings",
  start_date: "2026-07-28T00:00:00.000",
  short_title: "81026B0003-Records Remediation Project",
};

const RFX_PASSPORT_ROW = {
  rfp_id: "36426",
  epin: "81026B0003",
  epin_norm: "81026B0003",
  procurement_name: "81026B0003-Records remediation project",
  agency: "DEPARTMENT OF BUILDINGS",
  rfx_status: "Released",
  release_date: "7/28/2026 9:00:00 AM",
  due_date: "8/18/2026 1:00:00 PM",
  procurement_method: "Competitive Sealed Bid",
  main_commodity: "Historical Preservation Services",
  industry: "Professional Services",
};

function lifecycleWithMatchedRfx(notice = RFX_SOLICITATION_NOTICE, rfx = RFX_PASSPORT_ROW) {
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  return enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [rfx],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
}

test("RFx production kinds are registered on the money lens", () => {
  for (const kind of RFX_PRODUCTION_EVENT_KINDS) {
    assert.equal(isRegisteredEventKind(kind), true, kind);
    assert.equal(EVENT_KIND_REGISTRY[kind].lens, "money");
  }
});

test("matched RFx field case emits open + due; never invents addenda without a publisher date", () => {
  const lifecycle = lifecycleWithMatchedRfx();
  assert.equal(matchedRfxDetail(lifecycle)?.detail?.epin, "81026B0003");

  const meta = {
    observed_at: "2026-07-29T12:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
    run_id: "rfx-field-case",
  };
  const rfxOnly = mapPassportRfxToCivic(lifecycle, RFX_SOLICITATION_NOTICE, meta);
  const kinds = rfxOnly.map((e) => e.event_kind);
  assert.ok(kinds.includes("procurement.solicitation_opened"));
  assert.ok(kinds.includes("procurement.solicitation_due"));
  assert.ok(!kinds.includes("procurement.solicitation_addenda"), "no addenda date on public_rfx_data");

  const opened = rfxOnly.find((e) => e.event_kind === "procurement.solicitation_opened");
  assert.equal(opened.subject_ref, "notice:20260707026");
  assert.equal(opened.valid_at, "2026-07-28");
  assert.equal(opened.published_at, "2026-07-28");
  assert.equal(opened.source_field, "release_date");
  assert.match(opened.source_record_ref, /^passport-rfx:/);

  const due = rfxOnly.find((e) => e.event_kind === "procurement.solicitation_due");
  assert.equal(due.valid_at, "2026-08-18");
  assert.equal(due.published_at, null);
  assert.equal(due.source_field, "due_date");

  // Full money adapter includes City Record notice_published + RFx open/due
  const civic = mapMoneyLifecycleToCivic(lifecycle, RFX_SOLICITATION_NOTICE, meta);
  assert.ok(civic.some((e) => e.event_kind === "procurement.notice_published"));
  assert.ok(civic.some((e) => e.event_kind === "procurement.solicitation_opened"));
  assert.ok(civic.some((e) => e.event_kind === "procurement.solicitation_due"));

  // Idempotent event_id / payload_hash across re-runs
  const again = mapPassportRfxToCivic(lifecycle, RFX_SOLICITATION_NOTICE, {
    ...meta,
    processed_at: "2026-08-02T00:00:00.000Z",
    run_id: "rfx-field-case-rerun",
  });
  assert.equal(again.length, rfxOnly.length);
  for (let i = 0; i < rfxOnly.length; i++) {
    assert.equal(again[i].event_id, rfxOnly[i].event_id);
    assert.equal(again[i].payload_hash, rfxOnly[i].payload_hash);
  }
});

test("addenda emits only when an explicit publisher date is present on the RFx row", () => {
  const lifecycle = lifecycleWithMatchedRfx(RFX_SOLICITATION_NOTICE, {
    ...RFX_PASSPORT_ROW,
    addenda_date: "8/01/2026 10:00:00 AM",
  });
  const events = mapPassportRfxToCivic(lifecycle, RFX_SOLICITATION_NOTICE, {
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  const addenda = events.find((e) => e.event_kind === "procurement.solicitation_addenda");
  assert.ok(addenda);
  assert.equal(addenda.valid_at, "2026-08-01");
  assert.equal(addenda.source_field, "addenda_date");
});

test("unmatched RFx emits no solicitation production events", () => {
  const base = assembleLifecycle(RFX_SOLICITATION_NOTICE, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, RFX_SOLICITATION_NOTICE, {
    contracts: [],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  assert.equal(matchedRfxDetail(enriched), null);
  const events = mapPassportRfxToCivic(enriched, RFX_SOLICITATION_NOTICE, {});
  assert.equal(events.length, 0);
});

test("rfx_spine_adapter_coverage moves from 0 to 1.0 on matched RFx field cases", () => {
  const pairs = [
    {
      notice: RFX_SOLICITATION_NOTICE,
      lifecycle: lifecycleWithMatchedRfx(),
    },
    {
      notice: {
        request_id: "20260723031",
        pin: "81626W0043001",
        type_of_notice_description: "Award",
        agency_name: "Health and Mental Hygiene",
        start_date: "2026-07-30T00:00:00.000",
        short_title: "Catering Services",
      },
      // Award notice with RFx still joined (live solicitation detail on award path)
      lifecycle: enrichLifecycleWithPassport(
        assembleLifecycle(
          {
            request_id: "20260723031",
            pin: "81626W0043001",
            type_of_notice_description: "Award",
            agency_name: "Health and Mental Hygiene",
            start_date: "2026-07-30T00:00:00.000",
            short_title: "Catering Services",
          },
          [],
          [],
          [],
          {
            pinStrategy: "exact",
            lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
          },
        ),
        {
          request_id: "20260723031",
          pin: "81626W0043001",
          type_of_notice_description: "Award",
          agency_name: "Health and Mental Hygiene",
          start_date: "2026-07-30T00:00:00.000",
        },
        {
          contracts: [],
          rfx: [
            {
              rfp_id: "999",
              epin: "81626W0043001",
              epin_norm: "81626W0043001",
              rfx_status: "Closed",
              release_date: "6/01/2026",
              due_date: "7/01/2026",
            },
          ],
          lookupStatus: { contracts: "ok", rfx: "ok" },
        },
      ),
    },
    {
      notice: RFX_SOLICITATION_NOTICE,
      // Unmatched control — excluded from denominator
      lifecycle: enrichLifecycleWithPassport(
        assembleLifecycle(RFX_SOLICITATION_NOTICE, [], [], [], {
          pinStrategy: "exact",
          lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
        }),
        RFX_SOLICITATION_NOTICE,
        { contracts: [], rfx: [], lookupStatus: { contracts: "ok", rfx: "ok" } },
      ),
    },
  ];

  const metric = rfxSpineAdapterCoverage(pairs);
  assert.equal(metric.with_rfx, 2, "two matched RFx lifecycles");
  assert.equal(metric.with_rfx_events, 2);
  assert.equal(metric.coverage, 1, "rfx_spine_adapter_coverage must be 1.0 on field cases");
  assert.equal(metric.open_due_pair_rate, 1, "both dates present → open+due pair");
  assert.ok(metric.kinds["procurement.solicitation_opened"] >= 2);
  assert.ok(metric.kinds["procurement.solicitation_due"] >= 2);
  assert.equal(metric.kinds["procurement.solicitation_addenda"], 0);
  assert.equal(metric.gaps.addenda_not_published, 2);
});
