/**
 * Committed Now fixtures for the action-naming contract.
 *
 * One card of every `act_by` kind the Now surface can compile, plus an event
 * with no compiled action, so a rendered lane exercises each naming case at
 * once: an internal page that carries response instructions, an external
 * submission portal, an external landing page, an internal notice reached from
 * a property objection deadline, and the ordinary way on from an event.
 *
 * Shared by `test/now_view.test.mjs` and by the harness the evidence capture
 * drives, so the assertion and the capture describe the same cards.
 */

export const NOW_ACTION_SCENT_TODAY = "2026-08-03";

export function nowActionScentSources() {
  return {
    money: {
      status: "available",
      notices: [{
        request_id: "bid-open",
        short_title: "Bridge inspection services",
        agency_name: "Transportation",
        type_of_notice_description: "Solicitation",
        due_date: "2026-08-04T14:00:00",
        selection_method_description: "Competitive Sealed Bids",
      }],
    },
    staffing: {
      status: "available",
      exams: [{
        exam_number: "7001",
        title: "Housing Inspector",
        eligibility: "open_competitive",
        schedule_status: "scheduled",
        application_start: "2026-08-01",
        application_end: "2026-08-14",
        official_application_url: "https://www.nyc.gov/examsforjobs",
      }],
    },
    rules: {
      status: "available",
      rules: [{
        request_id: "rule-comment",
        agency: "Buildings",
        title: "Energy code amendments",
        stage: "comment-open",
        city_record: { request_id: "rule-comment", event_date: "2026-08-07" },
        nyc_rules: {
          url: "https://rules.cityofnewyork.us/rule/energy-code/",
          comment_url: "https://rules.cityofnewyork.us/rule/energy-code/",
          comment_by_date: "2026-08-07",
        },
        events: [{
          event_type: "comment_close",
          valid_at: "2026-08-07",
          source_field: "comment_by_date",
          status: "scheduled",
        }],
      }],
    },
    property: {
      status: "available",
      properties: [{
        request_id: "property-actions",
        short_title: "City-owned parcel disposition",
        agency_name: "Housing Preservation and Development",
        section_name: "Property Disposition",
        disposition_stage: "auction_or_rfp",
        commercial: {
          timed_events: [{
            kind: "objection_deadline",
            deadline: "2026-08-06",
            confidence: "high",
            date_source: "literal",
            source_field: "additional_description_1",
            source_span: { text: "Objections must be submitted by August 6, 2026." },
          }],
        },
        property_location: { scope: "local", boroughs: ["Bronx"] },
      }],
    },
    meetings: {
      status: "available",
      hearings: [{
        request_id: "hearing-next",
        agency: "Landmarks Preservation Commission",
        title: "Public hearing agenda",
        event_date: "2026-08-04T09:00:00",
        source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/hearing-next",
      }],
    },
    land: { status: "available" },
  };
}
