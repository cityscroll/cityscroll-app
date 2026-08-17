import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAddressIndexFromPadLines,
  parseCsvLine,
} from "../tools/lib/geocoder_address_index.mjs";
import {
  addressShardKey,
  createPrecomputedAddressGeocoder,
  parseAddressQuery,
  resolveAddressFromShard,
} from "../site/precomputed_address_geocoder.mjs";

const fixtureUrl = new URL("fixtures/geocoder/pad-addresses.csv", import.meta.url);

async function fixtureIndex() {
  const text = await readFile(fixtureUrl, "utf8");
  return buildAddressIndexFromPadLines(text.trimEnd().split(/\r?\n/), {
    generatedAt: "2026-08-17T00:00:00.000Z",
    sourceSha256: "fixture-sha256",
    sourceVersion: "26b-fixture",
    shardCount: 64,
  });
}

test("PAD CSV parser retains padded official fields", () => {
  const row = parseCsvLine('"4","02274","0002","      120-55","QUEENS BOULEVARD                "');
  assert.deepEqual(row, ["4", "02274", "0002", "      120-55", "QUEENS BOULEVARD                "]);
});

test("citywide address query normalization handles borough, ZIP, abbreviations, and Queens hyphens", () => {
  assert.deepEqual(parseAddressQuery("120-55 Queens Blvd, Queens, NY 11415"), {
    house: "120-55",
    house_sort: 100120055,
    street: "QUEENS BLVD",
    borough_code: "4",
    zip: "11415",
  });
  assert.equal(parseAddressQuery("affordable housing")?.status, "not_full_address");
  assert.equal(addressShardKey("QUEENS BLVD"), addressShardKey("QUEENS BOULEVARD"));
  assert.equal(parseAddressQuery("123 New York Avenue, Brooklyn").street, "NEW YORK AVE");
});

test("real PAD address ranges resolve to an exact BBL while pseudo-addresses stay unknown", async () => {
  const built = await fixtureIndex();
  assert.equal(built.manifest.coverage.included_real_and_vanity_ranges, 3);
  assert.equal(built.manifest.coverage.excluded_by_address_type.Q, 1);

  const centreQuery = parseAddressQuery("9 Centre St, New York, NY 10007");
  const centre = resolveAddressFromShard(centreQuery, built.shards.get(addressShardKey(centreQuery.street)), built.manifest);
  assert.equal(centre.status, "matched");
  assert.equal(centre.bbl, "1001210001");
  assert.equal(centre.borough, "Manhattan");
  assert.equal(centre.method, "nyc_dcp_pad_snapshot");

  const queensQuery = parseAddressQuery("120-55 Queens Boulevard, Queens, NY 11415");
  const queens = resolveAddressFromShard(queensQuery, built.shards.get(addressShardKey(queensQuery.street)), built.manifest);
  assert.equal(queens.status, "matched");
  assert.equal(queens.bbl, "4022740002");

  const pseudoQuery = parseAddressQuery("140 Fulton Street, Manhattan, NY 10038");
  assert.deepEqual(
    resolveAddressFromShard(pseudoQuery, built.shards.get(addressShardKey(pseudoQuery.street)), built.manifest),
    { status: "unknown", reason: "not_covered" },
  );
});

test("ambiguous and uncovered addresses never fabricate a match", () => {
  const query = parseAddressQuery("1 Main Street");
  const key = addressShardKey(query.street);
  const shard = {
    schema: "cityscroll.address-index-shard.v1",
    key,
    streets: {
      "MAIN ST": [
        [1000, 1000, 1, "1000010001", "10001"],
        [1000, 1000, 1, "3000010001", "11201"],
      ],
    },
  };
  assert.deepEqual(resolveAddressFromShard(query, shard), {
    status: "unknown",
    reason: "ambiguous",
    candidate_count: 2,
  });
  assert.deepEqual(resolveAddressFromShard(parseAddressQuery("999 Main Street, Brooklyn"), shard), {
    status: "unknown",
    reason: "not_covered",
  });
  const suffixShard = {
    schema: "cityscroll.address-index-shard.v1",
    key,
    streets: { "MAIN ST": [[120000, 120000, 2, "3000010001", "11201", "120A", "120A"]] },
  };
  assert.equal(resolveAddressFromShard(parseAddressQuery("120A Main Street, Brooklyn"), suffixShard).status, "matched");
  assert.deepEqual(resolveAddressFromShard(parseAddressQuery("120 Main Street, Brooklyn"), suffixShard), {
    status: "unknown",
    reason: "not_covered",
  });
});

test("browser geocoder reads only the manifest and one CityScroll-owned shard", async () => {
  const built = await fixtureIndex();
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url) === "/data/address-index/manifest.json") {
      return { ok: true, json: async () => built.manifest };
    }
    const key = String(url).match(/\/([0-9a-f]{2})\.json$/)?.[1];
    const shard = key && built.shards.get(key);
    return { ok: Boolean(shard), json: async () => shard };
  };
  const geocode = createPrecomputedAddressGeocoder({ fetchImpl });
  const result = await geocode("120-55 Queens Blvd, Queens, NY 11415");
  assert.equal(result.bbl, "4022740002");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.startsWith("/data/address-index/")));
  assert.ok(requests.every((url) => !/^https?:\/\//.test(url)), "resident lookup must have zero external egress");
});
