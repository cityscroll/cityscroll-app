/**
 * Named render cases for the wider-project section, shared by the contract test
 * and the headless capture tool so both prove the same states.
 *
 * Every case renders through the real renderProcurementDocument() -- the exact
 * function a production procurement page calls -- over the committed
 * materialization, so a case is a statement about shipped behaviour rather than
 * a hand-written snippet.
 */

import { readFileSync } from "node:fs";

import { renderProcurementDocument } from "../../site/procurement_document.mjs";

export const MATERIALIZATION = JSON.parse(
  readFileSync(new URL("../../site/data/procurement_project_context.json", import.meta.url), "utf8"),
);

// The published day the capture cases are rendered against, so a rendered
// window or calendar is stable across runs.
export const TODAY = "2026-08-20";

/** The museum HVAC solicitation: a matched notice with a conflicting identifier. */
export const MUSEUM_REQUEST_ID = "20260810048";
/** The bundled solicitation: one component resolves, another is never joined. */
export const BUNDLE_REQUEST_ID = "20250917031";
/** The chiller replacement: matched, with the project scope published blank. */
export const BLANK_SCOPE_REQUEST_ID = "20260810049";
/** A qualification route, whose published date is not a construction bid deadline. */
export const QUALIFICATION_REQUEST_ID = "20260625051";

function noticeRow(requestId) {
  const relation = MATERIALIZATION.relations.find(
    (entry) => entry.solicitation.request_id === requestId,
  );
  if (!relation) throw new Error(`no materialized relation for notice ${requestId}`);
  return relation.solicitation;
}

/**
 * A canonical procurement object at solicitation stage, built from one
 * materialized notice identity. Only the fields a procurement page already
 * reads are set; nothing here invents a published fact.
 */
export function solicitationFixture(requestId, { amount = 12000000, opportunityDates = null } = {}) {
  const solicitation = noticeRow(requestId);
  const observationRef = `city_record:${requestId}`;
  return {
    object: {
      procurement_id: `procurement:city-record:${requestId}`,
      source_observation_refs: [observationRef],
      identity_keys: { epins: [solicitation.structured_pin] },
      // The official City Record destination the page already resolves for
      // itself, so the project section is never what keeps it on the page.
      compatibility: { city_record_notice_hrefs: [solicitation.source_url] },
    },
    observations: [{
      source_observation_ref: observationRef,
      source_system: "city_record",
      source_system_id: requestId,
      ingested_at: "2026-08-15T10:00:00Z",
      snapshot: {
        request_id: requestId,
        short_title: solicitation.title,
        type_of_notice_description: solicitation.notice_type,
        selection_method_description: solicitation.selection_method,
        agency_name: "Department of Design and Construction",
        pin: solicitation.structured_pin,
        contract_amount: amount,
        start_date: `${solicitation.published_on}T00:00:00.000`,
        due_date: solicitation.response_due ? `${solicitation.response_due}T14:00:00.000` : null,
        official_url: solicitation.source_url,
        // Constructed by this fixture, not published by the city: a page needs
        // more than one dated milestone before the shared month renderer paints
        // a calendar at all, and the calendar is where in-place inspection
        // lives. Only the cases that exercise inspection pass these.
        ...(opportunityDates || {}),
      },
    }],
  };
}

/** Render one solicitation's procurement page, with or without the materialization. */
export const CONSTRUCTED_OPPORTUNITY_DATES = Object.freeze({
  pre_bid_conference_date: "2026-08-27T10:00:00.000",
  questions_deadline: "2026-09-02T17:00:00.000",
});

export function renderCase(requestId, { materialization = MATERIALIZATION, opportunityDates = null, ...opts } = {}) {
  const { object, observations } = solicitationFixture(requestId, { opportunityDates });
  return renderProcurementDocument(object, observations, {
    today: TODAY,
    projectContextMaterialization: materialization,
    ...opts,
  });
}

export const CAPTURE_CASES = [
  {
    label: "project-context-matched",
    requestId: MUSEUM_REQUEST_ID,
    render: () => renderCase(MUSEUM_REQUEST_ID),
  },
  {
    label: "project-context-partial-component",
    requestId: BUNDLE_REQUEST_ID,
    render: () => renderCase(BUNDLE_REQUEST_ID),
  },
  {
    label: "project-context-blank-scope",
    requestId: BLANK_SCOPE_REQUEST_ID,
    render: () => renderCase(BLANK_SCOPE_REQUEST_ID),
  },
  {
    label: "project-context-qualification-route",
    requestId: QUALIFICATION_REQUEST_ID,
    render: () => renderCase(QUALIFICATION_REQUEST_ID),
  },
  {
    label: "project-context-in-place-inspection",
    requestId: MUSEUM_REQUEST_ID,
    render: () => renderCase(MUSEUM_REQUEST_ID, { opportunityDates: CONSTRUCTED_OPPORTUNITY_DATES }),
  },
  {
    label: "project-context-absent",
    requestId: MUSEUM_REQUEST_ID,
    render: () => renderCase(MUSEUM_REQUEST_ID, { materialization: null }),
  },
];
