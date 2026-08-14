import assert from "node:assert/strict";
import { test } from "node:test";

import { landRecordApplicantHTML, landRecordPlaceHTML } from "../site/land_record_links.mjs";

test("land record links resolve the published DOT applicant spelling", () => {
  const html = landRecordApplicantHTML("NYC DOT Department of Transportation");
  assert.match(html, /href="\/agencies\/transportation\/"/);
  assert.match(html, /NYC DOT Department of Transportation/);
  assert.match(html, /data-link-confidence="strong"/);
});

test("unresolved land applicants remain honest plain text", () => {
  const html = landRecordApplicantHTML("An Organization Without A Profile");
  assert.equal(html, "An Organization Without A Profile");
  assert.doesNotMatch(html, /href=/);
});

test("land record place identifiers use existing near-you scope routes", () => {
  const options = { knownCommunityDistricts: new Set(["Q05"]), knownCouncilDistricts: new Set(["30"]) };
  assert.match(landRecordPlaceHTML("borough", "Queens"), /href="\/near-you\/\?v=0&amp;lens=land&amp;boro=Queens"/);
  assert.match(landRecordPlaceHTML("community", "Q05", options), /href="\/near-you\/\?v=0&amp;lens=land&amp;cd=Q05"/);
  assert.match(landRecordPlaceHTML("council", "30", options), /href="\/near-you\/\?v=0&amp;lens=land&amp;council=30"/);
});

test("unresolved land place identifiers remain plain text", () => {
  const options = { knownCommunityDistricts: new Set(["Q05"]), knownCouncilDistricts: new Set(["30"]) };
  assert.equal(landRecordPlaceHTML("borough", "Atlantis"), "Atlantis");
  assert.equal(landRecordPlaceHTML("community", "Q99", options), "CD Q99");
  assert.equal(landRecordPlaceHTML("council", "99", options), "Council District 99");
});
