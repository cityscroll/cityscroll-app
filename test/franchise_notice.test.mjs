import assert from "node:assert/strict";
import test from "node:test";

import {
  inferFranchiseStageFromNotice,
  isFranchiseConcessionNoticeEligible,
} from "../site/franchise_notice.mjs";

test("shared franchise classifier keeps ordinary home solicitations out", () => {
  assert.equal(isFranchiseConcessionNoticeEligible({
    agency_name: "Housing Preservation and Development",
    short_title: "Affordable housing rehabilitation services",
    type_of_notice_description: "Solicitation",
  }), false);
});

test("shared franchise classifier retains the Property route field cases", () => {
  const notice={
    agency_name: "Franchise and Concession Review Committee",
    short_title: "Public hearing on a proposed information services franchise agreement",
    type_of_notice_description: "Public Hearings",
  };
  assert.equal(isFranchiseConcessionNoticeEligible(notice), true);
  assert.equal(inferFranchiseStageFromNotice(notice), "public_hearing");
});
