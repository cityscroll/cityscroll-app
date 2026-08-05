import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISTRICT_DIGEST_SECTIONS,
  districtDigestAlertsHref,
  districtDigestRows,
  groupDistrictDigestRows,
} from "../site/district_weekly_digest.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const artifact = JSON.parse(readFileSync(join(ROOT, "site/data/district_weekly_digests.json"), "utf8"));

test("district weekly artifact covers all 51 council districts with exact count/list parity", () => {
  assert.equal(artifact.schema, "district_weekly_digests.v1");
  assert.equal(Object.keys(artifact.by_council_district).length, 51);
  for (let id = 1; id <= 51; id++) {
    const record = artifact.by_council_district[String(id)];
    assert.ok(record, `district ${id}`);
    const rows = districtDigestRows(artifact, String(id));
    assert.equal(record.total, rows.length, `district ${id} preview count equals its item list`);
    assert.equal(record.total, Object.values(record.counts).reduce((n, value) => n + value, 0));
    assert.equal(new Set(rows.map((row) => row.district_item_id)).size, rows.length, "items are unique within a district");
  }
});

test("hearing actions are current or upcoming at build time", () => {
  const builtDay = artifact.built_at.slice(0, 10);
  const hearings = Object.values(artifact.by_council_district)
    .flatMap((record) => record.items)
    .filter((row) => row.district_section === "hearings");
  assert.ok(hearings.length > 0);
  assert.ok(hearings.every((row) => row.event_date >= builtDay));
});

test("action sections are positive and honest-absent", () => {
  assert.deepEqual(
    DISTRICT_DIGEST_SECTIONS.map((section) => section.label),
    [
      "Review new contract awards",
      "Attend upcoming hearings",
      "Track land use actions",
      "Review property dispositions",
    ],
  );
  const grouped = groupDistrictDigestRows([
    { district_section: "hearings", district_item_id: "hearing:1" },
    { district_section: "land", district_item_id: "land:1" },
  ]);
  assert.deepEqual(grouped.map((section) => section.id), ["hearings", "land"]);
  assert.ok(grouped.every((section) => section.items.length > 0), "empty sections do not render");
});

test("district Following URL is one shareable weekly watch", () => {
  const href = districtDigestAlertsHref("33");
  assert.match(href, /^https:\/\/api\.cityscroll\.org\/following\?/);
  const q = new URL(href).searchParams;
  assert.equal(q.get("lens"), "district");
  assert.equal(q.get("freq"), "weekly");
  assert.deepEqual(JSON.parse(q.get("filter")), { councilDistrict: "33" });
});

test("materialized payload stays under its declared transfer ceiling", () => {
  const perf = artifact.performance;
  assert.ok(perf.measured_bytes > 0);
  assert.ok(perf.target_bytes < perf.ceiling_bytes);
  assert.ok(perf.measured_bytes <= perf.ceiling_bytes, `${perf.measured_bytes} > ${perf.ceiling_bytes}`);
  assert.equal(perf.max_items_per_district, 100);
});

test("unified alerts retain district watches while Near you watches its shared scope", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  const nearView = readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8");
  const nearPage = readFileSync(join(ROOT, "site/near-you/index.html"), "utf8");
  const boot = readFileSync(join(ROOT, "site/app/boot.mjs"), "utf8");
  assert.match(index, /data-w="district"[^>]*>Follow a district</);
  assert.match(index, /id="adistrict"/);
  assert.match(boot, /targetLens==="district"/);
  assert.match(nearView, /watchFromScope/);
  assert.match(nearPage, />Watch this scope</);
});
