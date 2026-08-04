import assert from "node:assert/strict";
import { test } from "node:test";

import { propertyAuctionExportRows } from "../site/property_saved_search.mjs";

const auction = {
  kind: "notice",
  process_stage: "auction_or_rfp",
  bbl: "3025180036",
  primary: {
    request_id: "auction-1",
    start_date: "2026-08-01T00:00:00.000",
    event_date: "2026-08-20T00:00:00.000",
    disposition_stage: "auction_or_rfp",
    property_location: {
      scope: "local",
      boroughs: ["Brooklyn"],
      neighborhoods: ["Greenpoint"],
      addresses: [{ label: "1 Commercial Street" }],
      tax_lots: [{ block: "2518", lots: ["36"] }],
      bbls: ["3025180036"],
    },
  },
};

test("auction export is parcel-exact and omits unpublished fields", () => {
  const rows = propertyAuctionExportRows([
    auction,
    { ...auction, process_stage: "hearing", primary: { ...auction.primary, request_id: "hearing-1", disposition_stage: "hearing" } },
  ]);

  assert.equal(rows.length, 1, "only the one auction/sale-stage parcel in the view exports");
  assert.deepEqual(rows[0], {
    address: "1 Commercial Street",
    block: "2518",
    lot: "36",
    bbl: "3025180036",
    stage: "auction_or_rfp",
    posted: "2026-08-01",
    event_date: "2026-08-20",
    close_date: "",
    source_link: "https://a856-cityrecord.nyc.gov/RequestDetail/auction-1",
  });
  assert.equal(rows[0].close_date, "", "an unpublished date stays empty");
});

test("count-equals-list law: one export row per eligible parcel in the saved-search view", () => {
  const second = {
    ...auction,
    bbl: "1006440001",
    primary: {
      ...auction.primary,
      request_id: "award-1",
      disposition_stage: "award_or_conveyance",
      property_location: {
        ...auction.primary.property_location,
        addresses: [],
        tax_lots: [{ block: "644", lots: ["1"] }],
        bbls: ["1006440001"],
      },
    },
    process_stage: "award_or_conveyance",
  };
  const visible = [auction, second];
  const rows = propertyAuctionExportRows(visible);
  assert.equal(rows.length, visible.length);
  assert.equal(rows[1].address, "", "honest-absent fields do not receive placeholder copy");
});

test("a multi-lot saved-search entry exports every represented parcel once", () => {
  const multiLot = {
    ...auction,
    bbl: null,
    primary: {
      ...auction.primary,
      property_location: {
        ...auction.primary.property_location,
        tax_lots: [{ block: "2518", lots: ["36", "37"] }],
        bbls: ["3025180036", "3025180037"],
      },
    },
  };
  const rows = propertyAuctionExportRows([multiLot]);
  assert.deepEqual(rows.map((row) => row.bbl), ["3025180036", "3025180037"]);
  assert.equal(rows.length, 2);
});
