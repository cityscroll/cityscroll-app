import test from "node:test";
import assert from "node:assert/strict";
import {
  RFX_PORTAL,
  cleanPassportRfpId,
  passportRfxHandoffUrl,
} from "../worker/src/lib/passport_parse.mjs";
import { solicitationHandoff } from "../worker/src/lib/action_registry.mjs";

test("cleanPassportRfpId accepts numeric ids and strips BOM", () => {
  assert.equal(cleanPassportRfpId("36426"), "36426");
  assert.equal(cleanPassportRfpId("\uFEFF37808"), "37808");
  assert.equal(cleanPassportRfpId("RFX-88"), null);
  assert.equal(cleanPassportRfpId(""), null);
  assert.equal(cleanPassportRfpId(null), null);
});

test("passportRfxHandoffUrl deep-links numeric rfp_id; else browse portal", () => {
  assert.equal(
    passportRfxHandoffUrl("36426"),
    "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
  );
  assert.equal(passportRfxHandoffUrl(null), RFX_PORTAL);
  assert.equal(passportRfxHandoffUrl("nope"), RFX_PORTAL);
});

test("solicitationHandoff uses extranet when rfp_id is on matched detail", () => {
  const handoff = solicitationHandoff({
    kind: "solicitation",
    pin: "06827Y0513",
    rfx_detail: {
      status: "matched",
      portal: RFX_PORTAL,
      detail: { epin: "06827Y0513", rfp_id: "37808", rfx_status: "Released" },
    },
  });
  assert.match(handoff.destination, /process_manage_extranet\/37808$/);
});
