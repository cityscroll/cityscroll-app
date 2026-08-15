/**
 * Executable source-to-surface inventory for meeting records.
 *
 * This is a review contract, not a renderer. Every accepted source field has
 * one explicit materialization, document, search, and alert disposition. The
 * three producers deliberately keep different identity and publication roles.
 */

export const MEETING_SOURCE_COMPLETENESS_SCHEMA = "cityscroll.meeting_source_completeness.v1";

const DISPOSITIONS = new Set([
  "rendered",
  "materialized_support",
  "derived",
  "shadow_only",
  "intentional_omission",
]);

function rows(fields, mapping) {
  return fields.map((sourceField) => Object.freeze({
    source_field: sourceField,
    ...mapping,
  }));
}

const cityRecord = [
  ...rows(["request_id"], {
    stream: "notice",
    source_seam: "worker/src/hearings.mjs City Record SELECT",
    materialized_as: "meeting_id, source_keys, request_id, source_record.identifier",
    document_use: "canonical route, source details, and City Record notice link",
    search_use: "identity and canonical result link; not free-text",
    alert_use: "meeting identity and delivery deduplication",
    disposition: "rendered",
  }),
  ...rows(["start_date"], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "published_at",
    document_use: "intentionally omitted; it is notice publication time, not meeting time",
    search_use: "not free-text",
    alert_use: "source chronology when present",
    disposition: "materialized_support",
  }),
  ...rows(["agency_name"], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "agency and institution_refs.agency_ref when resolved",
    document_use: "Institution section with a canonical agency link when identity resolves",
    search_use: "search_text",
    alert_use: "exact agency scope",
    disposition: "rendered",
  }),
  ...rows(["type_of_notice_description", "section_name"], {
    stream: "notice",
    source_seam: "site/meeting_object_contract.mjs retainedNoticeFields",
    materialized_as: "same-named fields plus notice_type/source_section aliases",
    document_use: "Notice details",
    search_use: "search_text",
    alert_use: "meeting-lens eligibility and digest classification",
    disposition: "rendered",
  }),
  ...rows(["short_title"], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "title and decides",
    document_use: "meeting-document heading",
    search_use: "search_text and result title",
    alert_use: "digest title and keyword matching",
    disposition: "rendered",
  }),
  ...rows(["event_date"], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "event_date",
    document_use: "When line and calendar action when the ICS contract accepts it",
    search_use: "date ordering and windowing; not free-text",
    alert_use: "upcoming-event window and calendar payload",
    disposition: "rendered",
  }),
  ...rows(["building_name", "street_address_1", "street_address_2", "city", "state", "zip_code"], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs venueFromRow",
    materialized_as: "venue plus retained same-named fields",
    document_use: "Where section",
    search_use: "search_text",
    alert_use: "location matching and meeting access context",
    disposition: "rendered",
  }),
  ...rows([
    "additional_description_1", "additional_description_2", "additional_description_3",
    "other_info_1", "other_info_2", "other_info_3",
  ], {
    stream: "notice",
    source_seam: "worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "same-named fields plus description, affected_area, participation, and meeting_access derivations",
    document_use: "Notice details and derived participation/location sections",
    search_use: "search_text",
    alert_use: "keyword, place, and participation context",
    disposition: "rendered",
  }),
  ...rows(["printout_1", "printout_2", "printout_3", "source_body"], {
    stream: "notice_enrichment",
    source_seam: "worker/src/hearings.mjs enrichRuleSource and worker/src/lib/hearings.mjs normalizeHearing",
    materialized_as: "bounded description, affected_area, participation, and meeting_access derivations; raw attachment text is not republished",
    document_use: "About this meeting only when richer notice paragraphs are absent; derived participation/location sections",
    search_use: "bounded search_text through description",
    alert_use: "keyword, place, and participation context from the materialized row",
    disposition: "derived",
  }),
  ...rows(["contact_name", "contact_phone", "email"], {
    stream: "notice",
    source_seam: "site/meeting_object_contract.mjs retainedNoticeFields",
    materialized_as: "same-named fields and participation contacts when present in notice prose",
    document_use: "Contact or How to participate",
    search_use: "search_text",
    alert_use: "digest contact actions",
    disposition: "rendered",
  }),
  ...rows(["source_links", "document_links"], {
    stream: "notice_enrichment",
    source_seam: "worker/src/hearings.mjs enrichRuleSource",
    materialized_as: "same-named safe link arrays and participation derivation",
    document_use: "Related links or How to participate with canonical HTTPS targets",
    search_use: "not free-text",
    alert_use: "participation context only",
    disposition: "rendered",
  }),
  ...rows(["address_to_request", "category_description", "selection_method_description"], {
    stream: "notice",
    source_seam: "worker/src/hearings.mjs City Record SELECT",
    materialized_as: "retained same-named source value",
    document_use: "intentionally omitted because these procurement-oriented columns do not have stable meeting semantics",
    search_use: "intentionally omitted",
    alert_use: "intentionally omitted for meeting watches",
    disposition: "intentional_omission",
  }),
];

const communityBoard = [
  ...rows(["record_id", "source_record_id", "event_id", "publisher_identifier", "publisher_event_id", "meeting_key"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "meeting_id, source_keys, publisher_identifier, source_record_id",
    document_use: "canonical route and publisher record in Source details",
    search_use: "identity and canonical result link; not free-text",
    alert_use: "meeting identity and delivery deduplication",
    disposition: "rendered",
  }),
  ...rows(["source_url", "record_url"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "source_record.url, source_url, compatibility.publisher_href",
    document_use: "Official source link",
    search_use: "not free-text",
    alert_use: "official source action",
    disposition: "rendered",
  }),
  ...rows(["board_id", "body_id", "body", "body_name", "body_evidence"], {
    stream: "event",
    source_seam: "tools/build_community_board_meeting_index.mjs materializeCommunityBoardMeetingRow",
    materialized_as: "board_id, board_name, institution_refs.board_ref, affected_area, source provenance",
    document_use: "Institution and Near you links using canonical board identity",
    search_use: "search_text and typed board scope",
    alert_use: "typed place scope; never substituted as an agency",
    disposition: "rendered",
  }),
  ...rows(["date", "meeting_date"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "date and event_date fallback when start_at is absent",
    document_use: "When line; all-day calendar contract when no time is published",
    search_use: "date ordering and windowing; not free-text",
    alert_use: "upcoming-event window",
    disposition: "rendered",
  }),
  ...rows(["start_at"], {
    stream: "event",
    source_seam: "tools/build_community_board_meeting_index.mjs materializeCommunityBoardMeetingRow",
    materialized_as: "start_at and event_date",
    document_use: "When line and calendar action",
    search_use: "date ordering and windowing; not free-text",
    alert_use: "upcoming-event window and calendar payload",
    disposition: "rendered",
  }),
  ...rows(["end_at"], {
    stream: "event",
    source_seam: "tools/build_community_board_meeting_index.mjs materializeCommunityBoardMeetingRow",
    materialized_as: "end_at and event_end",
    document_use: "meeting-document end time",
    search_use: "not free-text",
    alert_use: "retained for future duration-aware delivery; no current filter",
    disposition: "rendered",
  }),
  ...rows(["title"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "title and short_title",
    document_use: "meeting-document heading",
    search_use: "search_text and result title",
    alert_use: "digest title and keyword matching",
    disposition: "rendered",
  }),
  ...rows(["address", "venue_name", "mode"], {
    stream: "event",
    source_seam: "tools/build_community_board_meeting_index.mjs materializeCommunityBoardMeetingRow",
    materialized_as: "venue.address, venue.name, venue.mode",
    document_use: "Where and How to participate",
    search_use: "search_text",
    alert_use: "place and access context",
    disposition: "rendered",
  }),
  ...rows(["description"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "description",
    document_use: "About this meeting",
    search_use: "search_text",
    alert_use: "keyword matching from the shared materialized row",
    disposition: "rendered",
  }),
  ...rows(["committee", "participation"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "committee and participation",
    document_use: "Institution and How to participate with safe canonical hyperlinks",
    search_use: "committee in search_text; participation URLs are not free-text",
    alert_use: "keyword context for committee and access actions for participation",
    disposition: "rendered",
  }),
  ...rows(["observed_receipt"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs normalizeObservedReceipt",
    materialized_as: "source_receipt, observed_receipt, source_record.receipt",
    document_use: "Source checked timestamp when known",
    search_use: "not free-text",
    alert_use: "snapshot freshness and honest unavailable/stale state",
    disposition: "materialized_support",
  }),
  ...rows(["record_kind", "category", "format", "publisher_identifiers"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "same-named source metadata plus source_role/notice aliases where applicable",
    document_use: "category may label Notice details; operational metadata is intentionally omitted",
    search_use: "category through notice aliases; operational metadata omitted",
    alert_use: "record-kind eligibility only",
    disposition: "materialized_support",
  }),
  ...rows(["document_id", "video_id", "publisher_matter_ids"], {
    stream: "event_union",
    source_seam: "site/community_board_source_adapters.mjs record union",
    materialized_as: "not copied onto event rows; document/video/matter identities remain in their own typed records",
    document_use: "only exact attached meeting_documents render in Agenda and materials or Minutes",
    search_use: "attached document titles only",
    alert_use: "intentionally omitted",
    disposition: "intentional_omission",
  }),
  ...rows(["organizer"], {
    stream: "event",
    source_seam: "site/community_board_source_adapters.mjs record",
    materialized_as: "contact email/phone may enter participation; organizer object is not promoted to an institution identity",
    document_use: "participation contacts only when publisher supplied",
    search_use: "intentionally omitted without a verified identity",
    alert_use: "participation contacts only",
    disposition: "derived",
  }),
];

const legistar = [
  ...rows(["EventId"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilEvent",
    materialized_as: "council_event.event_id and source_records event identity",
    document_use: "Council meeting outcome link and subject edge after strict City Record join",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "materialized_support",
  }),
  ...rows(["EventBodyName", "EventTitle"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilEvent",
    materialized_as: "council_event.body_name and council_event.title",
    document_use: "Council meeting outcomes heading after strict join",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "rendered",
  }),
  ...rows(["EventDate", "EventTime"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilEvent",
    materialized_as: "council_event.start_time and council_event.event_date",
    document_use: "Council meeting outcomes date after strict join",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts; City Record remains the event-discovery clock",
    disposition: "rendered",
  }),
  ...rows(["EventInSiteURL", "EventAgendaFile", "EventMinutesFile"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilEvent/eventDocuments",
    materialized_as: "council_event.event_url and council_event.documents",
    document_use: "canonical Legistar meeting, agenda, and minutes hyperlinks after strict join",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "rendered",
  }),
  ...rows(["EventLocation", "VenueType", "VenueName", "Building", "Room"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilLocation",
    materialized_as: "council_event.venue",
    document_use: "Council meeting outcomes location after strict join",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts; no cross-source venue substitution",
    disposition: "rendered",
  }),
  ...rows(["EventVideoStatus"], {
    stream: "events",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilEvent",
    materialized_as: "normalized event.video_status but intentionally omitted from public record",
    document_use: "intentionally omitted because status alone is not a recording URL",
    search_use: "intentionally omitted",
    alert_use: "intentionally omitted",
    disposition: "intentional_omission",
  }),
  ...rows([
    "EventItemId", "EventItemEventId", "EventItemAgendaNumber", "EventItemTitle",
    "EventItemAgendaNote", "EventItemActionText", "EventItemMatterId", "EventItemMatterFile",
    "EventItemMatterName", "EventItemMatterType", "EventItemMatterStatus",
    "EventItemActionName", "EventItemPassedFlagName", "EventItemRollCallFlag",
  ], {
    stream: "event_items",
    source_seam: "worker/src/lib/meeting_outcomes.mjs normalizeCouncilAgendaItem/assembleAgenda",
    materialized_as: "agenda_items, matters, actions, joins, and vote spines",
    document_use: "Council meeting outcome agenda/matter/action sections with canonical matter links where numeric",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "rendered",
  }),
  ...rows(["VoteEventItemId", "VotePersonId", "VotePersonName", "VoteValueName", "VoteResult"], {
    stream: "votes",
    source_seam: "worker/src/lib/legistar_client.mjs summarizeLegistarVotes and entity_resolution/officials/index.mjs",
    materialized_as: "matter vote counts, by_person, officials, votes_on, and immutable source_records",
    document_use: "Council roll-call summary and named votes after strict join; numeric VoteResult never overrides a label",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "rendered",
  }),
  ...rows(["MatterAttachmentId", "MatterAttachmentName", "MatterAttachmentHyperlink", "MatterAttachmentIsSupportingDocument"], {
    stream: "attachments",
    source_seam: "worker/src/lib/legistar_client.mjs projectLegistarAttachmentDocuments",
    materialized_as: "agenda-item documents and immutable source_records",
    document_use: "canonical attachment hyperlinks on the matched Council matter",
    search_use: "not contributed to shared meeting search",
    alert_use: "not contributed to meeting alerts",
    disposition: "rendered",
  }),
];

export const MEETING_SOURCE_COMPLETENESS = Object.freeze({
  schema: MEETING_SOURCE_COMPLETENESS_SCHEMA,
  producers: Object.freeze({
    city_record: Object.freeze({
      role: "source-qualified meeting producer",
      fields: Object.freeze(cityRecord),
    }),
    community_board: Object.freeze({
      role: "source-qualified meeting producer",
      fields: Object.freeze(communityBoard),
    }),
    legistar: Object.freeze({
      role: "strictly joined Council outcome enrichment; never an inferred standalone meeting identity",
      fields: Object.freeze(legistar),
    }),
  }),
});

export function meetingSourceFieldNames(producer, stream = null) {
  const fields = MEETING_SOURCE_COMPLETENESS.producers[producer]?.fields || [];
  return fields.filter((row) => !stream || row.stream === stream).map((row) => row.source_field);
}

export function auditMeetingSourceCompleteness(inventory = MEETING_SOURCE_COMPLETENESS) {
  const errors = [];
  if (inventory?.schema !== MEETING_SOURCE_COMPLETENESS_SCHEMA) errors.push("schema is missing or unsupported");
  for (const producer of ["city_record", "community_board", "legistar"]) {
    const entry = inventory?.producers?.[producer];
    if (!entry) {
      errors.push(`${producer}: producer is missing`);
      continue;
    }
    if (!entry.role) errors.push(`${producer}: role is missing`);
    const seen = new Set();
    for (const field of entry.fields || []) {
      const name = String(field?.source_field || "").trim();
      if (!name) errors.push(`${producer}: unnamed source field`);
      if (seen.has(name)) errors.push(`${producer}.${name}: duplicate source field`);
      seen.add(name);
      for (const key of ["stream", "source_seam", "materialized_as", "document_use", "search_use", "alert_use"]) {
        if (!String(field?.[key] || "").trim()) errors.push(`${producer}.${name}: ${key} is missing`);
      }
      if (!DISPOSITIONS.has(field?.disposition)) errors.push(`${producer}.${name}: disposition is missing or unsupported`);
    }
    if (!seen.size) errors.push(`${producer}: field inventory is empty`);
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
