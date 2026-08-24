// Small local-development floors. Production requests require the versioned
// ALERT_STATE route-read-model manifests; these rows keep unit tests and
// `wrangler dev` useful when no KV binding is present.

export const NEAR_YOU_FLOOR = Object.freeze({
  schema: "cityscroll.near_you_slice.v1",
  version: "local-floor",
  boundary_vintage: "2026-05-26",
  built_at: "2026-08-22T00:00:00.000Z",
  levels: ["borough", "community_district", "council_district"],
  lenses: ["land", "property", "rules", "meetings", "money"],
  by_level: {
    borough: { Queens: { land: 0, property: 0, rules: 0, meetings: 1, money: 0 }, Manhattan: { land: 0, property: 0, rules: 0, meetings: 0, money: 1 } },
    community_district: {},
    council_district: {},
  },
  citywide: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
  virtual: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
  unlocated: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
  district_items: {
    by_level: { borough: { Queens: { meetings: ["floor-meeting"] }, Manhattan: { money: ["floor-contract"] } }, community_district: {}, council_district: {} },
    citywide: {},
    virtual: {},
    unlocated: {},
  },
  geography_items: {
    schema: "cityscroll.geography_items.v1",
    public_types: [],
    definitions: {},
    by_key: {},
  },
  records: {
    meetings: {
      "floor-meeting": {
        id: "floor-meeting",
        title: "Near You meeting",
        agency: "Transportation",
        type: "Public Hearings",
        date: "2026-09-03T11:00:00.000",
        status: null,
        basis: "Affected area",
        confidence: "strong",
        basis_method: "stamped",
        route: "/#notice/floor-meeting",
        meeting_origin: "city_record_notice",
        source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/floor-meeting",
        placement_methods: ["stamped"],
        place: { geographies: [{ key: "geography:borough:4", type: "borough", id: "4", label: "Queens", visibility: "public" }] },
      },
    },
    money: {
      "floor-contract": {
        id: "floor-contract",
        title: "Contract response address example",
        agency: "Design and Construction",
        type: "Solicitation",
        date: "2026-09-03T11:00:00.000",
        status: null,
        basis: "Located by submission address",
        confidence: "strong",
        basis_method: "submission_address",
        route: "/#notice/floor-contract",
        place: { geographies: [{ key: "geography:borough:1", type: "borough", id: "1", label: "Manhattan", visibility: "public" }] },
      },
    },
  },
  basis_layers: {
    contract_action_address: {
      basis_label: "Contract response address",
      records: { money: { "floor-contract": {
        id: "floor-contract",
        title: "Contract response address example",
        agency: "Design and Construction",
        type: "Solicitation",
        date: "2026-09-03T11:00:00.000",
        status: null,
        basis: "Located by submission address",
        confidence: "strong",
        basis_method: "submission_address",
        route: "/#notice/floor-contract",
        place: { geographies: [{ key: "geography:borough:1", type: "borough", id: "1", label: "Manhattan", visibility: "public" }] },
      } } },
      district_items: { by_level: { borough: { Manhattan: { money: ["floor-contract"] } }, community_district: {}, council_district: {} }, citywide: {}, virtual: {}, unlocated: {} },
      by_level: { borough: { Manhattan: { money: 1 } }, community_district: {}, council_district: {} },
      citywide: {}, virtual: {}, unlocated: {},
    },
  },
  explanation_paths: { records: 0, candidates: 0 },
});

export const MEETING_FLOOR_ROWS = Object.freeze([
  Object.freeze({
    meeting_id: "meeting:community_board:https://example.test/meeting/landmarks-2/",
    source_system: "community_board",
    board_id: "manhattan-cb-07",
    title: "LANDMARKS 2 public meeting",
    search_text: "LANDMARKS 2 public meeting Manhattan Community Board Meetings Washington Square",
    event_date: "2030-01-15T19:00:00-05:00",
    affected_area: { boroughs: ["Manhattan"], scope: "local" },
    agency: null,
    source_url: "https://example.test/meeting/landmarks-2",
  }),
]);

export const MEETING_ICS_FLOOR = Object.freeze({
  meeting_id: "meeting:community_board:https://cbbronx.cityofnewyork.us/cb6/event/transportation-health-committees-2/",
  source_system: "community_board",
  board_id: "bronx-cb-06",
  title: "Transportation & Health Committees",
  event_date: "2030-01-15T19:00:00-05:00",
  venue: { mode: "in_person", building: "Board District Office", address: "1 Bronx Street, Bronx, NY" },
  participation: { links: [], remote_join_url: null, emails: [], phones: [] },
  source_url: "https://cbbronx.cityofnewyork.us/cb6/event/transportation-health-committees-2/",
});
