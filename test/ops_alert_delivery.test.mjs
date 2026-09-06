// The served-artifact freshness guard detects staleness and then delivers an
// owner alert. Delivering from inside the comparison put the finding text on
// the delivery command line, and a real finding is large enough that the
// operating system refuses to start a program carrying it — so a genuine
// staleness incident read as a quiet hour and the run read as a delivery error.
//
// These tests hold the three properties that repair depends on: the payload
// never travels on the command line at any size, a refused delivery surfaces as
// a delivery failure carrying the finding, and a clean comparison sends nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DELIVERY_ACCEPTED,
  DELIVERY_NOT_ATTEMPTED,
  DELIVERY_REFUSED,
  buildDeliveryReceipt,
  buildOpsAlertPayload,
  deliverOpsAlert,
  idempotencyKeyFor,
  summarizeDelivery,
} from "../tools/ops_alert_delivery.mjs";
import { syntheticFreshnessFinding } from "../tools/force_freshness_finding.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../tools/deliver_ops_alert.mjs", import.meta.url));

// A single argument or environment entry is capped at 128 KiB on Linux, which
// is the limit the old command-line delivery hit.
const ARGUMENT_LIMIT_BYTES = 128 * 1024;

const RUN_URL = "https://github.com/cityscroll/cityscroll-app/actions/runs/33574860994";

function workspace() {
  return mkdtempSync(join(tmpdir(), "ops-alert-delivery-"));
}

async function endpoint(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/admin/ops-alert`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cliArguments(dir, findingsPath, { finding = "true" } = {}) {
  return [
    CLI,
    "--findings-file", findingsPath,
    "--receipt", join(dir, "ops-alert-delivery-receipt.json"),
    "--marker", join(dir, "ops-alert-sent-marker.json"),
    "--endpoint", "PLACEHOLDER",
    "--source-revision", "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
    "--workflow", "Served artifact freshness",
    "--run-id", "33574860994",
    "--run-url", RUN_URL,
    "--finding", finding,
  ];
}

test("a finding larger than the command-argument limit is delivered in the request body, never on the command line", async () => {
  const dir = workspace();
  const findingsPath = join(dir, "freshness-findings.txt");
  const findingsText = syntheticFreshnessFinding();
  writeFileSync(findingsPath, findingsText, "utf8");
  assert.ok(
    Buffer.byteLength(findingsText) > ARGUMENT_LIMIT_BYTES,
    "the specimen finding must exceed the limit that refused the original delivery",
  );

  let received = null;
  const relay = await endpoint((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received = { body, authorization: req.headers.authorization, idempotency: req.headers["idempotency-key"] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sent: true }));
    });
  });

  try {
    const argv = cliArguments(dir, findingsPath);
    argv[argv.indexOf("PLACEHOLDER")] = relay.url;
    // Every argument is a flag or a path, so the command line stays small no
    // matter how large the finding is.
    const argvBytes = argv.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
    assert.ok(argvBytes < 4096, `command line grew to ${argvBytes} bytes`);
    for (const value of argv) {
      assert.ok(!value.includes("padding line"), "the finding text must never appear as an argument");
    }

    const { stdout } = await run(process.execPath, argv, {
      env: { ...process.env, CITYSCROLL_ADMIN_KEY: "test-admin-key", GITHUB_OUTPUT: "" },
    });
    assert.match(stdout, /Delivery: accepted/);

    assert.ok(received, "the endpoint received the alert");
    assert.equal(received.authorization, "Bearer test-admin-key");
    const payload = JSON.parse(received.body);
    assert.equal(payload.guard, "served-artifact-freshness");
    assert.equal(payload.stage, "served_artifact_freshness");
    assert.equal(payload.findings.length, 20);
    assert.match(payload.findings[0], /forced served-artifact freshness finding/);
    assert.equal(payload.workflow_run_url, RUN_URL);
    assert.equal(payload.receipt_url, `${RUN_URL}#artifacts`);
    assert.equal(received.idempotency, idempotencyKeyFor(payload));

    const receipt = JSON.parse(readFileSync(join(dir, "ops-alert-delivery-receipt.json"), "utf8"));
    assert.equal(receipt.delivery_outcome, DELIVERY_ACCEPTED);
    assert.equal(receipt.finding_present, true);
    assert.equal(receipt.run_id, "33574860994");
    assert.equal(receipt.source_revision, "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace");
  } finally {
    await relay.close();
  }
});

test("one finding produces exactly one alert even when the delivery is repeated", async () => {
  const dir = workspace();
  const findingsPath = join(dir, "freshness-findings.txt");
  writeFileSync(findingsPath, "artifact hash mismatch\n", "utf8");

  let posts = 0;
  const relay = await endpoint((req, res) => {
    req.resume();
    req.on("end", () => {
      posts += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    const argv = cliArguments(dir, findingsPath);
    argv[argv.indexOf("PLACEHOLDER")] = relay.url;
    const env = { ...process.env, CITYSCROLL_ADMIN_KEY: "test-admin-key", GITHUB_OUTPUT: "" };
    await run(process.execPath, argv, { env });
    await run(process.execPath, argv, { env });
    assert.equal(posts, 1, "a repeated delivery must not send a second alert");

    const receipt = JSON.parse(readFileSync(join(dir, "ops-alert-delivery-receipt.json"), "utf8"));
    assert.equal(receipt.delivery_outcome, DELIVERY_ACCEPTED);
    assert.equal(receipt.reused_marker, true);
  } finally {
    await relay.close();
  }
});

test("a refused delivery fails on its own account and carries the finding it could not deliver", async () => {
  const dir = workspace();
  const findingsPath = join(dir, "freshness-findings.txt");
  writeFileSync(findingsPath, "artifact hash mismatch\nserved artifact is 3 deploys behind main\n", "utf8");

  const relay = await endpoint((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "validated-run-and-receipt-links-required" }));
    });
  });

  try {
    const argv = cliArguments(dir, findingsPath);
    argv[argv.indexOf("PLACEHOLDER")] = relay.url;
    const failure = await run(process.execPath, argv, {
      env: { ...process.env, CITYSCROLL_ADMIN_KEY: "test-admin-key", GITHUB_OUTPUT: "" },
    }).then(() => null, (error) => error);
    assert.ok(failure, "a refused delivery must fail the step");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /owner alert refused/);
    assert.match(failure.stderr, /status 400/);
    // The finding survives the delivery failure rather than vanishing with it.
    assert.match(failure.stderr, /artifact hash mismatch/);
    assert.match(failure.stderr, /served artifact is 3 deploys behind main/);

    const receipt = JSON.parse(readFileSync(join(dir, "ops-alert-delivery-receipt.json"), "utf8"));
    assert.equal(receipt.delivery_outcome, DELIVERY_REFUSED);
    assert.equal(receipt.finding_present, true);
    assert.deepEqual(receipt.findings, ["artifact hash mismatch", "served artifact is 3 deploys behind main"]);
    assert.equal(receipt.status, "FAIL");
    assert.match(summarizeDelivery(receipt), /Finding present: yes \(2 lines\)\. Delivery: refused\./);
  } finally {
    await relay.close();
  }
});

test("a clean comparison attempts no delivery at all", async () => {
  const dir = workspace();
  const findingsPath = join(dir, "freshness-findings.txt");
  writeFileSync(findingsPath, "", "utf8");

  let posts = 0;
  const relay = await endpoint((req, res) => {
    req.resume();
    req.on("end", () => {
      posts += 1;
      res.writeHead(200).end("{}");
    });
  });

  try {
    const argv = cliArguments(dir, findingsPath, { finding: "false" });
    argv[argv.indexOf("PLACEHOLDER")] = relay.url;
    const { stdout } = await run(process.execPath, argv, {
      env: { ...process.env, CITYSCROLL_ADMIN_KEY: "test-admin-key", GITHUB_OUTPUT: "" },
    });
    assert.equal(posts, 0, "a healthy comparison must send nothing");
    assert.match(stdout, /Finding present: no\. Delivery: not attempted\./);

    const receipt = JSON.parse(readFileSync(join(dir, "ops-alert-delivery-receipt.json"), "utf8"));
    assert.equal(receipt.delivery_outcome, DELIVERY_NOT_ATTEMPTED);
    assert.equal(receipt.finding_present, false);
    assert.equal(receipt.delivery_attempted, false);
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.outcome, "");
  } finally {
    await relay.close();
  }
});

test("a missing admin key is reported as a delivery that was never attempted, not as a clean run", async () => {
  const delivery = await deliverOpsAlert({
    payload: buildOpsAlertPayload({ findingsText: "artifact hash mismatch", observedAt: "2026-09-02T00:34:05.000Z" }),
    adminKey: "",
    fetchImpl: () => { throw new Error("the endpoint must not be called without a key"); },
  });
  assert.equal(delivery.delivery_outcome, DELIVERY_NOT_ATTEMPTED);
  assert.equal(delivery.attempted, false);

  const receipt = buildDeliveryReceipt({
    findingPresent: true,
    findings: ["artifact hash mismatch"],
    delivery,
    observedAt: "2026-09-02T00:34:05.000Z",
  });
  assert.equal(receipt.status, "FAIL");
  assert.match(summarizeDelivery(receipt), /Finding present: yes \(1 line\)\. Delivery: not attempted\./);
});

test("the forced-finding hook keeps real findings ahead of the padding that sizes the text", () => {
  const text = syntheticFreshnessFinding({ existingText: "artifact hash mismatch\nserved artifact is 3 deploys behind main\n" });
  const lines = text.split("\n").filter(Boolean);
  assert.match(lines[0], /this run is a delivery check, not an assessment that the served artifact is stale/);
  assert.equal(lines[1], "artifact hash mismatch");
  assert.equal(lines[2], "served artifact is 3 deploys behind main");
  assert.match(lines[3], /padding line/);
  assert.ok(Buffer.byteLength(text) > ARGUMENT_LIMIT_BYTES);
  // The alert the owner receives still leads with the real findings.
  const payload = buildOpsAlertPayload({ findingsText: text, observedAt: "2026-09-02T00:34:05.000Z" });
  assert.equal(payload.findings[1], "artifact hash mismatch");
  assert.equal(payload.findings[2], "served artifact is 3 deploys behind main");
});

test("the retained receipt carries the endpoint's own answer, so delivery is confirmable from it", async () => {
  const dir = workspace();
  const findingsPath = join(dir, "freshness-findings.txt");
  writeFileSync(findingsPath, "artifact hash mismatch\n", "utf8");
  const relay = await endpoint((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sent: true, signature: "a1b2c3" }));
    });
  });
  try {
    const argv = cliArguments(dir, findingsPath);
    argv[argv.indexOf("PLACEHOLDER")] = relay.url;
    await run(process.execPath, argv, {
      env: { ...process.env, CITYSCROLL_ADMIN_KEY: "test-admin-key", GITHUB_OUTPUT: "" },
    });
    const receipt = JSON.parse(readFileSync(join(dir, "ops-alert-delivery-receipt.json"), "utf8"));
    assert.equal(receipt.response_status, 200);
    assert.deepEqual(JSON.parse(receipt.response_body), { ok: true, sent: true, signature: "a1b2c3" });
    assert.ok(!JSON.stringify(receipt).includes("test-admin-key"), "the receipt must never carry the key");
  } finally {
    await relay.close();
  }
});
