import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Cloudflare-native release control-plane contract is internally consistent", () => {
  const result = spawnSync(process.execPath, ["tools/audit_deploy_control_plane.mjs", "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
