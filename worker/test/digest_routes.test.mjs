import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDigestRouteContract,
  DIGEST_ROUTE_CONTRACT,
  DIGEST_ROUTE_KINDS,
  digestPermalinkUrl,
  digestRedirectUrl,
} from "../src/lib/digest_routes.mjs";
import { parseRedirect } from "../src/lib/stats.mjs";

const EXPECTED_CONTRACT = {
  award: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
  entity: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
  meetings: { permalinkPathPrefix: "/meetings/", idShape: "city-record-or-composite-meeting-id" },
  money: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
  property: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
  rfp: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
  rules: { permalinkPathPrefix: "/notices/", idShape: "city-record-id" },
};

const MEETING_IDS = [
  "meeting:community_board:calendar@example.google.com::2026-09-08",
  "meeting:community_board:https://cbbronx.cityofnewyork.us/cb6/event/transportation-health-committees-2/",
];

test("every digest redirect kind round-trips to its contracted live permalink", () => {
  assertDigestRouteContract(DIGEST_ROUTE_CONTRACT, EXPECTED_CONTRACT);
  for (const kind of DIGEST_ROUTE_KINDS) {
    const ids = kind === "meetings" ? ["20260819001", ...MEETING_IDS] : ["20260819001"];
    for (const id of ids) {
      const redirect = digestRedirectUrl("https://api.cityscroll.org", kind, id);
      const parsed = parseRedirect(new URL(redirect).pathname);
      assert.deepEqual(parsed, { kind, id }, `${kind} ${id}`);
      assert.equal(
        digestPermalinkUrl(kind, id),
        `https://cityscroll.org${EXPECTED_CONTRACT[kind].permalinkPathPrefix}${encodeURIComponent(id)}`,
      );
    }
  }
});

test("route-contract assertions trip on simulated prefix and id-shape drift", () => {
  const prefixDrift = {
    ...DIGEST_ROUTE_CONTRACT,
    meetings: { ...DIGEST_ROUTE_CONTRACT.meetings, permalinkPathPrefix: "/notices/" },
  };
  assert.throws(
    () => assertDigestRouteContract(prefixDrift, EXPECTED_CONTRACT),
    /digest route contract drifted for meetings/,
  );

  const shapeDrift = {
    ...DIGEST_ROUTE_CONTRACT,
    meetings: {
      ...DIGEST_ROUTE_CONTRACT.meetings,
      idShape: { ...DIGEST_ROUTE_CONTRACT.meetings.idShape, name: "city-record-id" },
    },
  };
  assert.throws(
    () => assertDigestRouteContract(shapeDrift, EXPECTED_CONTRACT),
    /digest route contract drifted for meetings/,
  );
});
