/**
 * Publisher-neutral acquisition and materialization for the fixed DOT pilot.
 *
 * This module is intentionally an acquisition boundary: resident builders consume
 * the retained materialization and never call a publisher.  A consultation round
 * owns its channels; a channel URL is not an identity.
 */
import { createBoundedCommunityBoardTransport, COMMUNITY_BOARD_TRANSPORT_DEFAULTS } from "./community_board_source_adapters.mjs";

export const CONSULTATION_SCHEMA = "cityscroll.consultation_materialization.v1";
export const CONSULTATION_SOURCE_SCHEMA = "cityscroll.consultation_source_observation.v1";
export const CONSULTATION_TRANSPORT_DEFAULTS = Object.freeze({
  ...COMMUNITY_BOARD_TRANSPORT_DEFAULTS,
  responseCapBytes: 5_000_000,
  parserVersion: "consultation_acquisition.v1",
});

const source = (id, role, url, locator, sourceHash = null, maxBytes = null) => ({
  id, role, url, source_hash: sourceHash, field_locator: locator,
  max_bytes: maxBytes,
});

// The set is closed by design. New URLs are candidates until separately reviewed.
export const DOT_PILOT_SEEDS = Object.freeze([
  {
    id: "dot-fast-buses-central-brooklyn",
    title: "Fast Buses: Central Brooklyn",
    category: "Transit service and corridor priorities",
    organizer: "NYC Department of Transportation",
    purpose: "Share priorities for bus service and corridor improvements along Church, Flatbush and Utica avenues.",
    geography: { kind: "corridor", labels: ["Church Avenue", "Flatbush Avenue", "Utica Avenue"], evidence: "organizer_project_copy" },
    deadline: { value: "2026-10-31", precision: "day", source: "questionnaire_copy" },
    sources: [
      source("fast-buses-project", "organizer_invitation", "https://nycdotprojects.info/project/fast-buses-central-brooklyn", "main h1; main article; response links", "8246f785cc670fac2e4f0834e1adc418326854b72dc6428bebbb004cc66bfb4b"),
      source("fast-buses-survey", "survey", "https://www.surveymonkey.com/r/fastbuses-centralbk", "questionnaire body: deadline and duration", "ea09ee4ebc60311680bb644fa2b4ff05843858f632416faed252a933ee1d00c7"),
      source("fast-buses-map", "feedback_map", "https://nycdotprojects.info/project-feedback-map/feedback-map-centralbk", "organizer project link; public map response affordance", "e582ecfb8e85be21db338c758e60e77a697c76fce880a024c01b70f764e72823c"),
    ],
    channels: [
      { id: "fast-buses-survey", kind: "survey", label: "Complete the questionnaire", url: "https://www.surveymonkey.com/r/fastbuses-centralbk", state: "listed", open_now: false, deadline: "2026-10-31", duration_minutes: { min: 3, max: 5 } },
      { id: "fast-buses-map", kind: "feedback_map", label: "Open the feedback map", url: "https://nycdotprojects.info/project-feedback-map/feedback-map-centralbk", state: "listed", open_now: false },
    ],
  },
  {
    id: "dot-coney-island-transportation-study",
    title: "Coney Island Transportation Study",
    category: "Street and neighborhood design",
    organizer: "NYC Department of Transportation",
    purpose: "Share transportation and street-design issues for the Coney Island study area.",
    geography: { kind: "place_label", labels: ["Coney Island"], evidence: "organizer_project_title" },
    deadline: null,
    sources: [
      source("coney-island-project", "organizer_invitation", "https://nycdotprojects.info/project/coney-island-transportation-study", "main h1; main article; response link", "77992a53a53cdb08b3c9d422aadcd618753619ceeb341289e4d11e7ba6ac335e"),
      source("coney-island-map", "feedback_map", "https://nycdotprojects.info/project-feedback-map/traffic-and-transportation-issues-map", "public map response form; no deadline claim", "8a4264663671164187adebe96248a08d8668336e3b929fb7d3b8fa0d0f28f58f"),
    ],
    channels: [
      { id: "coney-island-map", kind: "feedback_map", label: "Open the feedback map", url: "https://nycdotprojects.info/project-feedback-map/traffic-and-transportation-issues-map", state: "listed", open_now: false },
    ],
  },
  {
    id: "dot-secure-bike-parking",
    title: "Secure Bike Parking",
    category: "Facility siting",
    organizer: "NYC Department of Transportation",
    purpose: "Suggest locations for secure bicycle parking across New York City.",
    geography: { kind: "citywide", labels: ["New York City"], evidence: "organizer_program_scope" },
    deadline: null,
    sources: [
      source("secure-bike-project", "organizer_invitation", "https://nycdotprojects.info/project/secure-bike-parking-program", "main h1; main article; response link", "d20c1728b0f312ec16d30ddd42f1834df5dcd39b33b7d3be63faa3d09971bac9"),
      source("secure-bike-suggestions", "location_suggestion", "https://nycdotprojects.info/SecureBikeParking", "public location-suggestion form; administrative links excluded", "d1a7695975e9dbce45d4c83d5aab0989d26be7891186c0b0080c4b68a83c424c", 5_000_000),
    ],
    channels: [
      { id: "secure-bike-suggestions", kind: "location_suggestion", label: "Suggest a secure bike-parking location", url: "https://nycdotprojects.info/SecureBikeParking", state: "listed", open_now: false },
    ],
  },
  {
    id: "dot-public-ebike-charging",
    title: "Public E-Bike Charging",
    category: "Facility siting and program design",
    organizer: "NYC Department of Transportation",
    purpose: "Share feedback on public e-bike charging locations and program design.",
    geography: { kind: "citywide", labels: ["New York City"], evidence: "organizer_program_scope" },
    deadline: null,
    sources: [
      source("ebike-charging-project", "organizer_invitation", "https://nycdotprojects.info/project/public-e-bike-charging-pec-program", "main h1; main article; response links", "de9bfb42e170599f316bbf94a3651904f715290c378d3a3852da84937d98b382"),
      source("ebike-charging-feedback", "feedback_landing", "https://nycdotprojects.info/content/share-your-feedback", "organizer response destination", "b709c414522ab60191f4d0c187065062fbad4d4305e6b225824ea66b7eb4ad1c"),
      source("ebike-charging-form", "microsoft_form", "https://forms.office.com/g/CsmBAJsTkD?origin=lprLink", "loading shell only; no submission or open-now evidence", "328c16f08cdab133bd3639879ec8e1a9844b49f5cce5a1c0b8d96f36744b4961"),
    ],
    channels: [
      { id: "ebike-charging-feedback", kind: "feedback_page", label: "View feedback information", url: "https://nycdotprojects.info/content/share-your-feedback", state: "listed", open_now: false },
      { id: "ebike-charging-form", kind: "survey", label: "View feedback form", url: "https://forms.office.com/g/CsmBAJsTkD?origin=lprLink", state: "unresolved", open_now: false, submission_side_effects: "excluded" },
    ],
  },
]);

const sha256 = async (bytes) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
};

export function validateConsultationSource(sourceRecord) {
  if (!sourceRecord?.id || !sourceRecord?.url || !sourceRecord?.field_locator) throw new Error("source requires id, url and field_locator");
  if (sourceRecord.role === "administrative" || /manage|admin|edit/i.test(`${sourceRecord.role} ${sourceRecord.url}`)) throw new Error("administrative source is not a resident channel");
  if (sourceRecord.role === "microsoft_form" && sourceRecord.open_now === true) throw new Error("Microsoft form loading evidence cannot prove open_now");
  return true;
}

export function validateConsultationMaterialization(records = DOT_PILOT_SEEDS) {
  if (!Array.isArray(records) || records.length !== 4) throw new Error("the fixed DOT pilot requires exactly four consultation rounds");
  const ids = new Set();
  for (const record of records) {
    if (!record.id || ids.has(record.id) || !record.title || record.organizer !== "NYC Department of Transportation") throw new Error("invalid consultation identity");
    ids.add(record.id);
    if (!Array.isArray(record.sources) || !Array.isArray(record.channels) || record.channels.length === 0) throw new Error(`${record.id}: missing sources or channels`);
    for (const item of record.sources) validateConsultationSource(item);
    for (const channel of record.channels) {
      if (!channel.id || !channel.url || channel.open_now !== false) throw new Error(`${record.id}: channel availability must be explicit`);
      if (!record.sources.some((item) => item.url === channel.url)) throw new Error(`${record.id}: channel lacks organizer-linked source`);
    }
  }
  return true;
}

export function consultationLifecycle(record, asOf = new Date().toISOString()) {
  const day = String(asOf).slice(0, 10);
  const deadline = record?.deadline?.value || null;
  const passed = Boolean(deadline && day > deadline);
  return { invitation: "listed", current: passed ? "deadline_passed" : "unresolved", open_now: false, response_action: passed ? "removed" : "view_channel" };
}

export function materializeConsultations({ observations = [], asOf = "2026-09-14T00:00:00.000Z" } = {}) {
  validateConsultationMaterialization(DOT_PILOT_SEEDS);
  const byUrl = new Map(observations.map((item) => [item.url, item]));
  return {
    schema: CONSULTATION_SCHEMA,
    observed_at: asOf,
    source_policy: "fixed-organizer-seeds-only",
    consultations: DOT_PILOT_SEEDS.map((record) => ({
      ...record,
      sources: record.sources.map((item) => ({ ...item, observation: byUrl.get(item.url)?.observation_id || null })),
      lifecycle: consultationLifecycle(record, asOf),
    })),
  };
}

export async function acquireConsultationSources({ fetchImpl = globalThis.fetch, asOf = new Date().toISOString(), previous = null, transportOptions = {} } = {}) {
  const config = { ...CONSULTATION_TRANSPORT_DEFAULTS, ...transportOptions };
  const request = createBoundedCommunityBoardTransport(fetchImpl, config);
  const observations = [];
  for (const record of DOT_PILOT_SEEDS) for (const item of record.sources) {
    const response = await request(item.url, { method: "GET" }, { maxBytes: Math.min(item.max_bytes || config.responseCapBytes, config.responseCapBytes) });
    const bytes = response.bytes || new Uint8Array();
    observations.push({
      observation_id: `${record.id}:${item.id}`,
      consultation_id: record.id,
      source_id: item.id,
      url: item.url,
      observed_at: asOf,
      ok: response.ok,
      status: response.status,
      source_hash: response.ok ? `sha256:${await sha256(bytes)}` : null,
      receipt: response.receipt,
      failure: response.ok ? null : response.receipt.reason,
    });
  }
  const failures = observations.filter((item) => !item.ok);
  const materialization = failures.length > 0 && previous
    ? previous
    : materializeConsultations({ observations, asOf });
  return {
    materialization,
    observations,
    receipt: { schema: CONSULTATION_SOURCE_SCHEMA, observed_at: asOf, transport: { ...CONSULTATION_TRANSPORT_DEFAULTS, ...transportOptions }, request_graph: request.graph, stats: request.stats(), failures: failures.length, last_good_preserved: failures.length > 0 && Boolean(previous) },
  };
}

validateConsultationMaterialization();
