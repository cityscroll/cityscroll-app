import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  publicPayloadFindings,
  publicPayloadTreeFindings,
  publicRecords,
  publicTextFindings,
} from "../tools/lib/public_payload_integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reported OCP build fails on identifiers and reader-visible test text", () => {
  const oldBuild = {
    mode: "fixture_warehouse",
    rows: [
      {
        request_id: "FIX005",
        pin: "PIN-FIXTURE-5",
        short_title: "Synthetic fixture row five",
        vendor_name: "FIXTURE VENDOR E",
      },
    ],
  };
  const findings = publicPayloadFindings(oldBuild, {
    source: "site/data/ocp_awards_warehouse_lookup.json",
  });
  assert.ok(findings.some((item) => item.kind === "test build mode"));
  assert.ok(findings.some((item) => item.value === "FIX005"));
  assert.ok(findings.some((item) => /Synthetic fixture/.test(item.value)));

  assert.ok(publicTextFindings("<h2>Synthetic fixture row five</h2>").length > 0);
  assert.ok(publicTextFindings("<h2>Fixture five</h2>").length > 0);
  assert.ok(publicTextFindings("<h2>Synthetic test award</h2>").length > 0);
  assert.ok(publicTextFindings("<h2>Citywide Synthetic Turf Reconstruction</h2>").length === 0);
});

test("record boundary rejects cross-dataset fixture patterns", () => {
  const rows = [
    { project_id: "2022M0258", title: "Timbale Terrace" },
    { project_id: "FIXZAP001", title: "Fixture ULURP Project One" },
    { organization_name: "ACME WIDGETS INC", organization_phone: "5550100" },
  ];
  assert.deepEqual(publicRecords(rows).map((row) => row.project_id), ["2022M0258"]);
});

test("all shipped payload trees are free of test records", () => {
  const findings = publicPayloadTreeFindings(
    [path.join(ROOT, "site/data"), path.join(ROOT, "worker/src/data")],
    { repoRoot: ROOT },
  );
  assert.deepEqual(findings, []);
});
