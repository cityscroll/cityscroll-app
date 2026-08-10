import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "../src/worker.mjs"),
  "utf8",
);

test("scheduled delivery runs before advisory daily maintenance", () => {
  const deliveryCalls = [...source.matchAll(/await runAlerts\(env\);/g)].map((match) => match.index);
  const maintenanceStart = source.indexOf("let ingestResult = null;");

  assert.equal(deliveryCalls.length, 1);
  assert.notEqual(maintenanceStart, -1);
  assert.ok(deliveryCalls[0] < maintenanceStart);
});
