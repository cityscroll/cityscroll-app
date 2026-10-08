import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { contentAddressedEntry } from "./build_worker_route_read_models.mjs";
import {
  ROUTE_PUBLICATION_STATE_KEY,
  publishRouteReadModels,
} from "./lib/worker_route_publication.mjs";

function fixture(version = "generation-1", nearRows = [{ id: "near-1" }]) {
  const dir = mkdtempSync(join(tmpdir(), "route-publication-fixture-"));
  const near = contentAddressedEntry("near-you", "borough:Queens:meetings", {
    schema_version: 1, kind: "near-you", slice_id: "borough:Queens", lens: "meetings",
    activity: { records: { meetings: Object.fromEntries(nearRows.map((row) => [row.id, row])) } },
  });
  const meeting = contentAddressedEntry("meetings", "2026-10", {
    schema_version: 1, kind: "meetings", month: "2026-10", rows: [{ meeting_id: "meeting:1" }],
  });
  writeFileSync(join(dir, "near-you.bulk.json"), JSON.stringify([near]));
  writeFileSync(join(dir, "meetings.bulk.json"), JSON.stringify([meeting]));
  writeFileSync(join(dir, "near-you.manifest.json"), JSON.stringify({
    schema_version: 1, kind: "near-you", version, slices: { "borough:Queens:meetings": near.key },
  }));
  writeFileSync(join(dir, "meetings.manifest.json"), JSON.stringify({
    schema_version: 1, kind: "meetings", version, slices: { "2026-10": meeting.key },
    id_to_slice: { "meeting:1": meeting.key },
  }));
  writeFileSync(join(dir, "route-read-model-receipt.json"), JSON.stringify({
    version, generated_at: "2026-10-08T00:00:00Z",
  }));
  return dir;
}

function fakeWrangler({ failAtPut = null } = {}) {
  const values = new Map();
  const calls = [];
  let puts = 0;
  return {
    values,
    calls,
    async invoke(args) {
      calls.push([...args]);
      if (args.slice(0, 4).join(" ") === `kv key get ${ROUTE_PUBLICATION_STATE_KEY}`) {
        return { stdout: values.get(ROUTE_PUBLICATION_STATE_KEY) || "" };
      }
      puts += 1;
      if (puts === failAtPut) throw new Error("injected publication failure");
      if (args[1] === "bulk") {
        for (const row of JSON.parse(readFileSync(args[3], "utf8"))) values.set(row.key, row.value);
      } else if (args[1] === "key" && args[2] === "put") {
        const path = args[args.indexOf("--path") + 1];
        values.set(args[3], readFileSync(path, "utf8"));
      }
      return { stdout: "" };
    },
  };
}

test("an identical code-only release performs no route or manifest puts", async () => {
  const dir = fixture();
  const remote = fakeWrangler();
  try {
    const first = await publishRouteReadModels({ routeDir: dir, invoke: remote.invoke });
    assert.equal(first.confirmed.route_key_puts, 2);
    assert.equal(first.confirmed.manifest_puts, 2);
    const callsAfterFirst = remote.calls.length;

    // Incidental receipt time is not part of the deterministic content version.
    writeFileSync(join(dir, "route-read-model-receipt.json"), JSON.stringify({
      version: "generation-1", generated_at: "2026-10-08T23:59:59Z",
    }));
    const second = await publishRouteReadModels({ routeDir: dir, invoke: remote.invoke });
    assert.equal(second.decision, "unchanged-content");
    assert.deepEqual(second.confirmed, { route_key_puts: 0, manifest_puts: 0, state_puts: 0 });
    assert.equal(remote.calls.length, callsAfterFirst + 1, "second publication performs only the state read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write never advances state and an exact retry completes safely", async () => {
  const baseline = fixture();
  const changed = fixture("generation-2", [{ id: "near-2" }]);
  const remote = fakeWrangler();
  try {
    await publishRouteReadModels({ routeDir: baseline, invoke: remote.invoke });
    const prior = remote.values.get(ROUTE_PUBLICATION_STATE_KEY);
    const failing = fakeWrangler({ failAtPut: 2 });
    failing.values.set(ROUTE_PUBLICATION_STATE_KEY, prior);
    await assert.rejects(
      () => publishRouteReadModels({ routeDir: changed, invoke: failing.invoke }),
      (error) => {
        assert.equal(error.publication_receipt.state_advanced, false);
        return true;
      },
    );
    assert.equal(failing.values.get(ROUTE_PUBLICATION_STATE_KEY), prior);
    const retried = await publishRouteReadModels({ routeDir: changed, invoke: failing.invoke });
    assert.equal(retried.confirmed.state_puts, 1);
    assert.notEqual(failing.values.get(ROUTE_PUBLICATION_STATE_KEY), prior);
  } finally {
    rmSync(baseline, { recursive: true, force: true });
    rmSync(changed, { recursive: true, force: true });
  }
});
