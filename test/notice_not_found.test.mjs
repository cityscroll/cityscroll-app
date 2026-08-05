import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cityRecordRequestIdIsValid,
  cityRecordRequestUrl,
} from "../site/city_record_id.mjs";

test("City Record links require a valid request id", () => {
  assert.equal(cityRecordRequestIdIsValid("20260716022"), true);
  assert.equal(
    cityRecordRequestUrl("20260716022"),
    "https://a856-cityrecord.nyc.gov/RequestDetail/20260716022",
  );
  for (const value of ["FIX005", "synthetic-open-2026", "2026-0716022", "", null]) {
    assert.equal(cityRecordRequestIdIsValid(value), false);
    assert.equal(cityRecordRequestUrl(value), null);
  }
});

test("notice-not-found action uses the validated URL helper", () => {
  const source = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("if(!r){"), source.indexOf("// Header", source.indexOf("if(!r){")));
  assert.match(block, /cityRecordRequestUrl\(id\)/);
  assert.doesNotMatch(block, /REQ_URL\(id\)/);
});
