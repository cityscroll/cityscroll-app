import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOTICE_PROCUREMENT_SUBJECTS_LOOKUP_PATH,
  NOTICE_PROCUREMENT_SUBJECTS_METHOD,
  NOTICE_PROCUREMENT_SUBJECTS_SCHEMA,
  NOTICE_SUBJECT_CANONICAL_CONTINUATION,
  NOTICE_SUBJECT_SEARCH_CONTINUATION,
  NOTICE_SUBJECT_VIEW_CONTRACT_LABEL,
  buildNoticeProcurementSubjectsLookup,
  checkNoticeProcurementSubjectsLookup,
  noticeProcurementSubjectsForId,
  projectNoticeSubjectLinks,
  renderNoticeSubjectLinksHtml,
} from "../site/notice_subject_projection.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../site/procurement_read_model_shards.mjs";
import { projectNoticeObjectTarget } from "../site/notice_object_links.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const PAGES_EDGE_SOURCE = readFileSync(
  new URL("../site/pages_edge.mjs", import.meta.url),
  "utf8",
);
const NOTICE_SUBJECT_CLIENT_SOURCE = readFileSync(
  new URL("../site/notice_subject_client.mjs", import.meta.url),
  "utf8",
);
const NOTICE_SUBJECT_PROJECTION_SOURCE = readFileSync(
  fileURLToPath(new URL("../site/notice_subject_projection.mjs", import.meta.url)),
  "utf8",
);

const PILOT_PROCUREMENT_ID = "procurement:contract:CT107120258801626";
const PILOT_NOTICE_ID = "20240829105";
const PILOT_HREF = "/procurements/procurement%3Acontract%3ACT107120258801626";

const PILOT_ROW = Object.freeze({
  procurement_id: PILOT_PROCUREMENT_ID,
  source_observation_refs: Object.freeze([
    "city_record:20240829105",
    "passport_public_contracts:contract:07124E0044001:5050251",
  ]),
  compatibility: Object.freeze({
    canonical_href: PILOT_HREF,
    city_record_notice_hrefs: Object.freeze([`/notices/${PILOT_NOTICE_ID}`]),
  }),
});

const PUBLIC_COMMENT_NOTICE = Object.freeze({
  request_id: "20260710020",
  short_title: "Pesticides and Mosquito Control Products",
  agency_name: "Health and Mental Hygiene",
  section_name: "Public Comment on Contract Awards",
  type_of_notice_description: "Notice",
  additional_description_1: `
    <p>This is a notice seeking comments about the proposed contract below.</p>
    <p><strong>E-PIN:&nbsp;</strong>81626S0021001</p>
  `,
});

test("generated reverse index proves the pilot notice association before a direct link", () => {
  const lookup = buildNoticeProcurementSubjectsLookup([PILOT_ROW], {
    generatedAt: "2026-09-09T06:33:01.880Z",
    sourceModelFingerprint: "fixture-fingerprint",
  });
  assert.equal(lookup.schema, NOTICE_PROCUREMENT_SUBJECTS_SCHEMA);
  assert.equal(lookup.method, NOTICE_PROCUREMENT_SUBJECTS_METHOD);
  assert.equal(lookup.counts.notices, 1);
  assert.equal(lookup.counts.subject_links, 1);
  assert.deepEqual(noticeProcurementSubjectsForId(lookup, PILOT_NOTICE_ID), [{
    procurement_id: PILOT_PROCUREMENT_ID,
    href: PILOT_HREF,
    relation_basis: NOTICE_PROCUREMENT_SUBJECTS_METHOD,
  }]);

  const projection = projectNoticeSubjectLinks(
    { request_id: PILOT_NOTICE_ID, short_title: "Comfort Inn notice" },
    { subjectsLookup: lookup },
  );
  assert.equal(projection.state, "matched");
  assert.equal(projection.subjects.length, 1);
  assert.equal(projection.target.href, PILOT_HREF);
  assert.equal(projection.target.label, NOTICE_SUBJECT_VIEW_CONTRACT_LABEL);
  assert.equal(projection.target.continuation, NOTICE_SUBJECT_CANONICAL_CONTINUATION);
  assert.equal(projection.evidence.href, `/notices/${PILOT_NOTICE_ID}`);
  assert.match(
    renderNoticeSubjectLinksHtml(projection.subjects),
    /href="\/procurements\/procurement%3Acontract%3ACT107120258801626"/,
  );
  assert.match(renderNoticeSubjectLinksHtml(projection.subjects), />View contract</);
});

test("one verified contract target keeps the original source evidence distinct", () => {
  const lookup = buildNoticeProcurementSubjectsLookup([PILOT_ROW]);
  const projection = projectNoticeSubjectLinks(
    { request_id: PILOT_NOTICE_ID },
    { subjectsLookup: lookup },
  );
  assert.notEqual(projection.target.href, projection.evidence.href);
  assert.equal(projection.evidence.kind, "notice");
  assert.equal(projection.evidence.id, PILOT_NOTICE_ID);
});

test("multiple accepted subjects stay explicit without an automatic first choice", () => {
  const lookup = buildNoticeProcurementSubjectsLookup([
    PILOT_ROW,
    {
      procurement_id: "procurement:contract:CTSECOND",
      compatibility: {
        canonical_href: "/procurements/procurement%3Acontract%3ACTSECOND",
        city_record_notice_hrefs: [`/notices/${PILOT_NOTICE_ID}`],
      },
    },
  ]);
  const projection = projectNoticeSubjectLinks(
    { request_id: PILOT_NOTICE_ID },
    { subjectsLookup: lookup },
  );
  assert.equal(projection.state, "matched");
  assert.equal(projection.subjects.length, 2);
  assert.equal(projection.target, null);
  const html = renderNoticeSubjectLinksHtml(projection.subjects);
  assert.match(html, /data-notice-subject-count="2"/);
  assert.equal((html.match(/class="act primary notice-subject-link"/g) || []).length, 2);
  assert.match(html, />View contract</);
  assert.doesNotMatch(html, /meta http-equiv="refresh"/i);
});

test("missing or unavailable lookup leaves a readable notice-only projection", () => {
  const missing = projectNoticeSubjectLinks({
    request_id: "20240101001",
    short_title: "Unmatched award notice",
    type_of_notice_description: "Award",
  }, { subjectsLookup: null });
  assert.equal(missing.state, "notice_only");
  assert.equal(missing.subjects.length, 0);
  assert.equal(missing.target.kind, "notice");
  assert.equal(renderNoticeSubjectLinksHtml(missing.subjects), "");

  const emptyLookup = buildNoticeProcurementSubjectsLookup([]);
  const stillMissing = projectNoticeSubjectLinks(
    { request_id: "20240101001" },
    { subjectsLookup: emptyLookup },
  );
  assert.equal(stillMissing.state, "notice_only");
  assert.equal(stillMissing.subjects.length, 0);
});

test("public-comment search targets remain labeled as searches", () => {
  const legacy = projectNoticeObjectTarget(PUBLIC_COMMENT_NOTICE);
  assert.equal(legacy.target.href, "/browse/contracts/?mode=award&q=81626S0021001");

  const projection = projectNoticeSubjectLinks(PUBLIC_COMMENT_NOTICE, {
    subjectsLookup: buildNoticeProcurementSubjectsLookup([]),
  });
  assert.equal(projection.state, "matched");
  assert.equal(projection.subjects.length, 1);
  assert.equal(projection.subjects[0].continuation, NOTICE_SUBJECT_SEARCH_CONTINUATION);
  assert.equal(projection.subjects[0].href, legacy.target.href);
  assert.match(projection.subjects[0].label, /Contract award/);
  assert.doesNotMatch(projection.subjects[0].label, /^View contract$/);
  assert.match(
    renderNoticeSubjectLinksHtml(projection.subjects),
    /data-notice-subject-continuation="search"/,
  );
});

test("edge notice render exposes View contract for the pilot and keeps the official source", () => {
  const lookup = buildNoticeProcurementSubjectsLookup([PILOT_ROW]);
  const html = renderEdgeNotice(
    {
      request_id: PILOT_NOTICE_ID,
      short_title: "City Sanctuary Facility for Families with Children",
      type_of_notice_description: "Award",
      agency_name: "Homeless Services",
      start_date: "2024-08-29",
    },
    PILOT_NOTICE_ID,
    null,
    null,
    { subjectsLookup: lookup },
  );
  assert.match(html, /data-notice-subject-continuation="canonical"/);
  assert.match(html, /href="\/procurements\/procurement%3Acontract%3ACT107120258801626"/);
  assert.match(html, />View contract</);
  assert.match(html, /a856-cityrecord\.nyc\.gov\/RequestDetail\/20240829105/);
  assert.doesNotMatch(html, /href="\/browse\/contracts\/\?mode=award/);
});

test("shard publication attaches the reverse-index descriptor without inventing relations", () => {
  const model = {
    schema: "cityscroll.shared_procurement_read_model.v1",
    version: 1,
    generated_at: "2026-09-09T06:33:01.880Z",
    coherence_receipt: { source_model_fingerprint: "fixture-fingerprint" },
    observations: [],
    rows: [PILOT_ROW, {
      procurement_id: "procurement:contract:CTNONE",
      compatibility: {
        canonical_href: "/procurements/procurement%3Acontract%3ACTNONE",
        city_record_notice_hrefs: [],
      },
    }],
  };
  const artifacts = buildSharedProcurementReadModelShardArtifacts(model);
  assert.equal(artifacts.manifest.notice_procurement_subjects.schema, NOTICE_PROCUREMENT_SUBJECTS_SCHEMA);
  assert.equal(artifacts.manifest.notice_procurement_subjects.notice_count, 1);
  assert.equal(artifacts.manifest.notice_procurement_subjects.subject_link_count, 1);
  assert.equal(artifacts.noticeSubjects.by_notice[PILOT_NOTICE_ID][0].procurement_id, PILOT_PROCUREMENT_ID);
  assert.equal(artifacts.noticeSubjects.by_notice["missing"], undefined);
});

test("A6: notice-subject reader path uses the bounded lookup and never scans shards or publishers", () => {
  // Pages Function loads the reverse index from published ASSETS at request time so
  // the multi-megabyte JSON stays out of the Cloudflare Functions bundle.
  assert.doesNotMatch(
    PAGES_EDGE_SOURCE,
    /import noticeProcurementSubjectsLookup from "\.\/data\/notice_procurement_subjects_lookup\.json"/,
  );
  assert.match(
    PAGES_EDGE_SOURCE,
    /NOTICE_PROCUREMENT_SUBJECTS_LOOKUP_PATH/,
  );
  assert.match(
    PAGES_EDGE_SOURCE,
    /staticAsset\(\s*env,\s*request,\s*`\/\$\{NOTICE_PROCUREMENT_SUBJECTS_LOOKUP_PATH\}`\s*\)/,
  );
  assert.match(
    PAGES_EDGE_SOURCE,
    /subjectsLookup:\s*options\.subjectsLookup\s*\|\|\s*null/,
  );
  assert.match(
    NOTICE_SUBJECT_CLIENT_SOURCE,
    /import\("\.\/data\/notice_procurement_subjects_lookup\.json"/,
  );
  assert.equal(NOTICE_PROCUREMENT_SUBJECTS_LOOKUP_PATH, "data/notice_procurement_subjects_lookup.json");

  // The projection module is the whole subject-resolution path: keyed lookup only,
  // no publisher host and no procurement-shard walk at request time.
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /a856-cityrecord\.nyc\.gov/);
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /data\.cityofnewyork\.us/);
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /passport\.cityofnewyork\.us/);
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /shared_procurement_read_model\//);
  assert.doesNotMatch(NOTICE_SUBJECT_PROJECTION_SOURCE, /procurementShardPathForId/);
  assert.doesNotMatch(NOTICE_SUBJECT_CLIENT_SOURCE, /shared_procurement_read_model\//);
  assert.doesNotMatch(NOTICE_SUBJECT_CLIENT_SOURCE, /procurementShardPathForId/);
  assert.match(NOTICE_SUBJECT_PROJECTION_SOURCE, /lookup\.by_notice\?\.\[id\]/);

  const lookup = buildNoticeProcurementSubjectsLookup([PILOT_ROW]);
  assert.deepEqual(noticeProcurementSubjectsForId(lookup, PILOT_NOTICE_ID), [{
    procurement_id: PILOT_PROCUREMENT_ID,
    href: PILOT_HREF,
    relation_basis: NOTICE_PROCUREMENT_SUBJECTS_METHOD,
  }]);
  assert.deepEqual(noticeProcurementSubjectsForId(lookup, "missing-notice"), []);
});

test("A7: subject links stay ordinary anchors and the notice route keeps canonical metadata", () => {
  const lookup = buildNoticeProcurementSubjectsLookup([PILOT_ROW]);
  const projection = projectNoticeSubjectLinks(
    { request_id: PILOT_NOTICE_ID },
    { subjectsLookup: lookup },
  );
  const html = renderNoticeSubjectLinksHtml(projection.subjects);
  assert.match(html, /<a class="act primary notice-subject-link" href="\/procurements\/procurement%3Acontract%3ACT107120258801626"/);
  assert.doesNotMatch(html, /\starget=/i);
  assert.doesNotMatch(html, /\sonclick=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(NOTICE_SUBJECT_CLIENT_SOURCE, /notice-subject-link[\s\S]{0,120}addEventListener\(\s*["']click["']/);
  assert.doesNotMatch(NOTICE_SUBJECT_CLIENT_SOURCE, /preventDefault\(\)[\s\S]{0,160}notice-subject-link/);

  assert.match(
    PAGES_EDGE_SOURCE,
    /const canonical = `https:\/\/cityscroll\.org\/notices\/\$\{encodeURIComponent\(id\)\}`;/,
  );
  assert.match(
    PAGES_EDGE_SOURCE,
    /\.on\('link\[rel="canonical"\]',\s*\{\s*element\(element\)\s*\{\s*element\.setAttribute\("href",\s*canonical\)/,
  );
  assert.match(
    PAGES_EDGE_SOURCE,
    /\.on\('meta\[property="og:url"\]',\s*\{\s*element\(element\)\s*\{\s*element\.setAttribute\("content",\s*canonical\)/,
  );
});

test("A8: build/check mode detects a stale fingerprint and an incoherent projection", async () => {
  await withPinnedClock("2026-09-16T12:00:00.000Z", () => {
    const generatedAt = testClockISOString();
    const coherent = buildNoticeProcurementSubjectsLookup([PILOT_ROW], {
      generatedAt,
      sourceModelFingerprint: "fixture-fingerprint",
    });
    const artifacts = buildSharedProcurementReadModelShardArtifacts({
      schema: "cityscroll.shared_procurement_read_model.v1",
      version: 1,
      generated_at: generatedAt,
      coherence_receipt: { source_model_fingerprint: "fixture-fingerprint" },
      observations: [],
      rows: [PILOT_ROW],
    });
    assert.equal(
      checkNoticeProcurementSubjectsLookup(coherent, {
        expectedSourceModelFingerprint: "fixture-fingerprint",
        expectedGeneratedAt: generatedAt,
        rebuildFromRows: [PILOT_ROW],
        manifestDescriptor: artifacts.manifest.notice_procurement_subjects,
      }).ok,
      true,
    );

    const staleFingerprint = {
      ...coherent,
      source_model_fingerprint: "stale-fingerprint",
    };
    const staleResult = checkNoticeProcurementSubjectsLookup(staleFingerprint, {
      expectedSourceModelFingerprint: "fixture-fingerprint",
      expectedGeneratedAt: generatedAt,
      rebuildFromRows: [PILOT_ROW],
    });
    assert.equal(staleResult.ok, false);
    assert.ok(staleResult.findings.some((item) => item.code === "source_fingerprint_mismatch"));

    const incoherentCounts = {
      ...coherent,
      counts: { notices: 0, subject_links: 99 },
    };
    const incoherentResult = checkNoticeProcurementSubjectsLookup(incoherentCounts, {
      expectedSourceModelFingerprint: "fixture-fingerprint",
    });
    assert.equal(incoherentResult.ok, false);
    assert.ok(incoherentResult.findings.some((item) => item.code === "notice_count_mismatch"));
    assert.ok(incoherentResult.findings.some((item) => item.code === "subject_link_count_mismatch"));
  });
});
