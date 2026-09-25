/**
 * Local geography publication: Near You place slices and meeting details
 * activate as one generation. Parcel, assertion, and source generations are
 * publication dependencies; every emitted meeting-detail destination must
 * exist in the staged meetings id_to_slice population before activation.
 *
 * Public alias: c448e327f901f
 *
 * Verify: node --test test/local_geography_publication.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { workerMeetingGet } from "../worker/src/hearings.mjs";
import {
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
  loadMeetingRecord,
} from "../worker/src/lib/route_read_model_kv.mjs";
import {
  buildLocalGeographyPublication,
  buildMeetings,
  buildNearYou,
  canonicalMeetingDetailIdFromNearYouRecord,
  decideLocalGeographyPublicationActivation,
  localGeographyPublicationDependencies,
  residentialPlacesFromNtaLayer,
  validateMeetingDetailCompleteness,
} from "../tools/build_worker_route_read_models.mjs";

const ROOT_URL = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, ROOT_URL), "utf8"));

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const MIDWOOD_GEO = "nta2020:BK1403";
const MIDWOOD_SLICE = "geography:nta2020:BK1403:meetings";

const committedActivity = readJson("site/data/district_activity.json");
const committedMeetings = readJson("site/data/shared_meeting_read_model.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);

const FIXTURE_DEPENDENCIES = Object.freeze({
  parcel_membership_generation: "parcel-membership-test-gen",
  parcel_coordinate_vintage: "pluto_test",
  assertion_generation: "assertion-test-gen",
  source_generation: "2026-09-09T06:52:08.255Z",
});

function kv(values) {
  return {
    async get(key) {
      return values.get(key) || null;
    },
  };
}

function materializePublication(activity, meetings, version, dependencies = FIXTURE_DEPENDENCIES) {
  return buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings,
    version,
    residentialPlaces,
    dependencies,
  });
}

function storePublication(publication) {
  const values = new Map();
  for (const entry of publication.nearYou.entries) values.set(entry.key, entry.value);
  for (const entry of publication.meetings.entries) values.set(entry.key, entry.value);
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(publication.nearYou.manifest));
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(publication.meetings.manifest));
  return values;
}

test("A1 [outcome] BK1403 meeting slice carries September 23 venue basis and matching canonical detail", async () => {
  const publication = materializePublication(committedActivity, committedMeetings, "a1-midwood");
  assert.equal(publication.activation.activate, true, publication.activation.reason);
  assert.equal(
    publication.nearYou.manifest.publication_dependencies.parcel_membership_generation,
    FIXTURE_DEPENDENCIES.parcel_membership_generation,
  );
  assert.equal(
    publication.meetings.manifest.publication_dependencies.assertion_generation,
    FIXTURE_DEPENDENCIES.assertion_generation,
  );
  assert.equal(
    publication.nearYou.manifest.publication_dependencies.source_generation,
    FIXTURE_DEPENDENCIES.source_generation,
  );

  const sliceKey = publication.nearYou.manifest.slices[MIDWOOD_SLICE];
  assert.ok(sliceKey, "BK1403 meetings slice must be published");
  const slice = JSON.parse(publication.nearYou.entries.find((entry) => entry.key === sliceKey).value);
  const listIds = slice.activity?.geography_items?.by_key?.["geography:nta2020:BK1403"]?.meetings || [];
  assert.ok(listIds.includes(SEPT23_ID), "BK1403 reverse list must include September 23");
  const listRecord = slice.activity?.records?.meetings?.[SEPT23_ID];
  assert.ok(listRecord, "BK1403 slice must carry the September 23 list record");
  assert.equal(listRecord.basis, "Venue / logistics");
  assert.equal(listRecord.basis_method, "parcel_membership");
  assert.equal(canonicalMeetingDetailIdFromNearYouRecord(listRecord), SEPT23_ID);

  assert.ok(publication.meetings.manifest.id_to_slice[SEPT23_ID]);
  const detailKey = publication.meetings.manifest.id_to_slice[SEPT23_ID];
  const detailSlice = JSON.parse(
    publication.meetings.entries.find((entry) => entry.key === detailKey).value,
  );
  const detail = detailSlice.rows.find((row) => row.meeting_id === SEPT23_ID);
  assert.ok(detail, "staged meeting detail must exist for September 23");
  assert.equal(detail.title, listRecord.title);
  assert.ok(
    (detail.location_memberships || []).some(
      (membership) => membership.role === "venue" && membership.memberships?.nta2020 === "BK1403",
    ),
    "canonical detail must retain Midwood venue membership",
  );

  const values = storePublication(publication);
  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(deferred.status, 200);
  const body = await deferred.json();
  assert.equal(body.schema, "cityscroll.near_you_deferred.v1");
  assert.match(body.results_html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body.results_html, /Housing and Land Use Committee Meeting/);

  const got = await workerMeetingGet({ ALERT_STATE: kv(values) }).execute({ meetingId: SEPT23_ID });
  assert.equal(got.availability, "available");
  assert.equal(got.meeting.meeting_id, SEPT23_ID);
  assert.equal(got.meeting.title, listRecord.title);
});

test("A2 [outcome] successful activation replaces list counts, IDs, and details coherently; old reads stay consistent", async () => {
  const oldPublication = materializePublication(
    committedActivity,
    committedMeetings,
    "a2-old",
    { ...FIXTURE_DEPENDENCIES, assertion_generation: "assertion-old" },
  );
  assert.equal(oldPublication.activation.activate, true);

  const sept23Row = committedMeetings.rows.find((row) => row.meeting_id === SEPT23_ID);
  assert.ok(sept23Row);
  const reducedMeetings = {
    ...committedMeetings,
    generated_at: "2026-09-25T12:00:00.000Z",
    rows: committedMeetings.rows.filter((row) => row.meeting_id === SEPT23_ID),
  };
  const reducedActivity = structuredClone(committedActivity);
  const midwoodKey = "geography:nta2020:BK1403";
  reducedActivity.geography_items.by_key[midwoodKey] = {
    ...(reducedActivity.geography_items.by_key[midwoodKey] || {}),
    meetings: [SEPT23_ID],
  };
  reducedActivity.records.meetings = {
    [SEPT23_ID]: reducedActivity.records.meetings[SEPT23_ID],
  };
  // Drop other geography meeting memberships so list counts change with the new generation.
  for (const [key, lenses] of Object.entries(reducedActivity.geography_items.by_key || {})) {
    if (key === midwoodKey) continue;
    if (Array.isArray(lenses?.meetings)) lenses.meetings = lenses.meetings.filter((id) => id === SEPT23_ID);
  }

  const newPublication = materializePublication(
    reducedActivity,
    reducedMeetings,
    "a2-new",
    {
      ...FIXTURE_DEPENDENCIES,
      assertion_generation: "assertion-new",
      source_generation: reducedMeetings.generated_at,
    },
  );
  assert.equal(newPublication.activation.activate, true);
  assert.notEqual(
    newPublication.nearYou.manifest.publication_dependencies.assertion_generation,
    oldPublication.nearYou.manifest.publication_dependencies.assertion_generation,
  );

  const oldValues = storePublication(oldPublication);
  const newValues = storePublication(newPublication);

  const oldDeferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings`,
  ), { ALERT_STATE: kv(oldValues) });
  const oldBody = await oldDeferred.json();
  const oldCount = Number(oldBody.results_html.match(/data-results-count="(\d+)"/)?.[1] || 0);
  assert.ok(oldCount >= 1);

  const newDeferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings`,
  ), { ALERT_STATE: kv(newValues) });
  const newBody = await newDeferred.json();
  assert.match(newBody.results_html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const newCount = Number(newBody.results_html.match(/data-results-count="(\d+)"/)?.[1] || 0);
  assert.equal(newCount, 1);
  assert.notEqual(newCount, oldCount);

  const oldDetail = await loadMeetingRecord({ ALERT_STATE: kv(oldValues) }, SEPT23_ID);
  const newDetail = await loadMeetingRecord({ ALERT_STATE: kv(newValues) }, SEPT23_ID);
  assert.equal(oldDetail?.meeting_id, SEPT23_ID);
  assert.equal(newDetail?.meeting_id, SEPT23_ID);
  assert.equal(oldDetail?.title, newDetail?.title);

  // Static consumer opens the same accepted identity from the activated meeting rows.
  const staticHtml = renderMeetingDocument(newDetail, {
    schema: committedMeetings.schema,
    rows: [newDetail],
  });
  assert.ok(staticHtml);
  assert.match(staticHtml, /Housing and Land Use Committee Meeting/);
  assert.match(staticHtml, /\/meetings\/meeting%3Acommunity_board%3A/);

  // An old-version consumer that still holds the prior generation stays internally consistent.
  const staleConsumer = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings`,
  ), { ALERT_STATE: kv(oldValues) });
  assert.equal(staleConsumer.status, 200);
  const staleBody = await staleConsumer.json();
  assert.equal(
    Number(staleBody.results_html.match(/data-results-count="(\d+)"/)?.[1] || 0),
    oldCount,
  );
  const staleDetail = await workerMeetingGet({ ALERT_STATE: kv(oldValues) }).execute({
    meetingId: SEPT23_ID,
  });
  assert.equal(staleDetail.availability, "available");
  assert.equal(staleDetail.meeting.title, oldDetail.title);
});

test("A3 [boundary] missing detail or required shard refuses activation; prior local journey stays available", async () => {
  const previous = materializePublication(committedActivity, committedMeetings, "a3-previous");
  assert.equal(previous.activation.activate, true);
  const previousValues = storePublication(previous);

  const candidate = materializePublication(committedActivity, committedMeetings, "a3-candidate");
  // Drop the named detail from the staged meetings population before activation.
  const brokenMeetingsManifest = {
    ...candidate.meetings.manifest,
    id_to_slice: Object.fromEntries(
      Object.entries(candidate.meetings.manifest.id_to_slice)
        .filter(([id]) => id !== SEPT23_ID),
    ),
  };
  const missingDetail = decideLocalGeographyPublicationActivation({
    previous: {
      nearYouManifest: previous.nearYou.manifest,
      meetingsManifest: previous.meetings.manifest,
    },
    candidate: {
      nearYouManifest: candidate.nearYou.manifest,
      meetingsManifest: brokenMeetingsManifest,
      nearYouEntries: candidate.nearYou.entries,
      meetingsEntries: candidate.meetings.entries,
    },
    residentialPlaces,
    dependencies: FIXTURE_DEPENDENCIES,
  });
  assert.equal(missingDetail.activate, false);
  assert.equal(missingDetail.reason, "incomplete_meeting_details");
  assert.ok(missingDetail.missing.includes(SEPT23_ID));
  assert.equal(missingDetail.active.nearYouManifest.version, "a3-previous");
  assert.equal(missingDetail.active.meetingsManifest.version, "a3-previous");

  // Drop one required residential shard from the candidate Near You manifest.
  const incompleteNear = {
    ...candidate.nearYou.manifest,
    slices: Object.fromEntries(
      Object.entries(candidate.nearYou.manifest.slices)
        .filter(([sliceId]) => sliceId !== MIDWOOD_SLICE),
    ),
  };
  const missingShard = decideLocalGeographyPublicationActivation({
    previous: {
      nearYouManifest: previous.nearYou.manifest,
      meetingsManifest: previous.meetings.manifest,
    },
    candidate: {
      nearYouManifest: incompleteNear,
      meetingsManifest: candidate.meetings.manifest,
      nearYouEntries: candidate.nearYou.entries,
      meetingsEntries: candidate.meetings.entries,
    },
    residentialPlaces,
    dependencies: FIXTURE_DEPENDENCIES,
  });
  assert.equal(missingShard.activate, false);
  assert.equal(missingShard.reason, "incomplete_manifest");
  assert.equal(missingShard.active.nearYouManifest.version, "a3-previous");

  // Prior generation remains readable for the Midwood journey.
  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(previousValues) });
  assert.equal(deferred.status, 200);
  assert.match((await deferred.json()).results_html, /Housing and Land Use Committee Meeting/);
  const detail = await workerMeetingGet({ ALERT_STATE: kv(previousValues) }).execute({
    meetingId: SEPT23_ID,
  });
  assert.equal(detail.availability, "available");
});

test("A4 [verification] route-model builder and Worker handler cover complete, missing-detail, and interrupted cases", async () => {
  const deps = localGeographyPublicationDependencies({
    parcelManifest: {
      membership: { generated_at: "parcel-a4" },
      coordinate_vintage: "pluto_a4",
    },
    meetingGeographyPointer: { active_generation: "assertion-a4" },
    sharedMeetingModel: { generated_at: "source-a4" },
  });
  assert.deepEqual(deps, {
    parcel_membership_generation: "parcel-a4",
    parcel_coordinate_vintage: "pluto_a4",
    assertion_generation: "assertion-a4",
    source_generation: "source-a4",
  });

  const complete = buildLocalGeographyPublication({
    activity: committedActivity,
    geography: {},
    meetings: committedMeetings,
    version: "a4-complete",
    residentialPlaces,
    dependencies: deps,
  });
  assert.equal(complete.activation.activate, true);
  const completeness = validateMeetingDetailCompleteness({
    nearYou: complete.nearYou,
    meetings: complete.meetings,
  });
  assert.equal(completeness.ok, true);
  assert.equal(completeness.missing.length, 0);

  const values = storePublication(complete);
  // Named local route
  const local = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(local.status, 200);
  const localHtml = await local.text();
  assert.match(localHtml, /Midwood|BK1403|near-you/i);
  assert.match(localHtml, /data-near-deferred-href=/);

  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(deferred.status, 200);
  const deferredBody = await deferred.json();
  assert.match(deferredBody.results_html, /data-record-id=/);
  assert.match(deferredBody.results_html, /Housing and Land Use Committee Meeting/);

  // Named detail route via published-slice get_meeting (lean read: KV only).
  const reads = [];
  const instrumented = {
    ALERT_STATE: {
      get: async (key) => {
        reads.push(key);
        return values.get(key) || null;
      },
    },
  };
  const detail = await workerMeetingGet(instrumented).execute({ meetingId: SEPT23_ID });
  assert.equal(detail.availability, "available");
  assert.equal(detail.meeting.meeting_id, SEPT23_ID);
  assert.ok(reads.every((key) => key === MEETING_MANIFEST_KEY || key.startsWith("meetings:v1:")));
  assert.equal(reads.includes("hearings:location:v1"), false);

  const detailHtml = renderMeetingDocument(detail.meeting, {
    schema: committedMeetings.schema,
    rows: [detail.meeting],
  });
  assert.ok(detailHtml);
  assert.match(detailHtml, /Housing and Land Use Committee Meeting/);

  // Missing-detail candidate refuses while previous stays active.
  const previous = complete;
  const nearOnly = buildNearYou(committedActivity, {}, "a4-missing-detail", { residentialPlaces });
  const meetingsBuilt = buildMeetings(committedMeetings, "a4-missing-detail");
  const meetingsWithoutDetail = {
    ...meetingsBuilt,
    manifest: {
      ...meetingsBuilt.manifest,
      id_to_slice: Object.fromEntries(
        Object.entries(meetingsBuilt.manifest.id_to_slice).filter(([id]) => id !== SEPT23_ID),
      ),
    },
  };
  const refused = decideLocalGeographyPublicationActivation({
    previous: {
      nearYouManifest: previous.nearYou.manifest,
      meetingsManifest: previous.meetings.manifest,
    },
    candidate: {
      nearYouManifest: {
        ...nearOnly.manifest,
        publication_dependencies: deps,
      },
      meetingsManifest: {
        ...meetingsWithoutDetail.manifest,
        publication_dependencies: deps,
      },
      nearYouEntries: nearOnly.entries,
      meetingsEntries: meetingsWithoutDetail.entries,
    },
    residentialPlaces,
    dependencies: deps,
  });
  assert.equal(refused.activate, false);
  assert.equal(refused.reason, "incomplete_meeting_details");

  // Interrupted publication: publishedSliceKeys omit a required Near You key.
  const interrupted = decideLocalGeographyPublicationActivation({
    previous: {
      nearYouManifest: previous.nearYou.manifest,
      meetingsManifest: previous.meetings.manifest,
    },
    candidate: {
      nearYouManifest: complete.nearYou.manifest,
      meetingsManifest: complete.meetings.manifest,
      nearYouEntries: complete.nearYou.entries,
      meetingsEntries: complete.meetings.entries,
    },
    residentialPlaces,
    dependencies: deps,
    publishedSliceKeys: new Set(
      complete.nearYou.entries
        .map((entry) => entry.key)
        .filter((key) => !key.includes(encodeURIComponent(MIDWOOD_SLICE))),
    ),
  });
  assert.equal(interrupted.activate, false);
  assert.equal(interrupted.reason, "partial_publication");
  assert.equal(interrupted.active.nearYouManifest.version, "a4-complete");

  // Prior Midwood journey remains available after the refused candidates.
  const stillThere = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(stillThere.status, 200);
  assert.match((await stillThere.json()).results_html, /Housing and Land Use Committee Meeting/);
});
