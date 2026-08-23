/**
 * Authenticated PIN-family verify desk.
 * verify: node --test worker/test/pin_family_verify.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAdminPinFamilyVerify } from "../src/admin.mjs";
import {
  PIN_FAMILY_VERIFY_VERSION,
  pinFamilyVerdictInput,
} from "../src/lib/pin_family_verify.mjs";

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return statement.run(...args); },
          };
        },
      };
    },
  };
}

function fixtureEnv() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0024_pin_family_verify.sql", import.meta.url), "utf8"));
  return { sqlite, env: { ADMIN_KEY: "secret", DB: d1(sqlite) } };
}

const jsonRequest = (url, method = "GET", body) => new Request(url, {
  method,
  headers: { accept: "application/json", "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});

test("verdict input accepts one-click aliases and rejects unknown decisions", () => {
  assert.equal(pinFamilyVerdictInput({
    pair_id: "pf:a::b", actor: "captain", decision: "same",
  }).decision, "same_contract");
  assert.equal(pinFamilyVerdictInput({
    pair_id: "pf:a::b", actor: "captain", decision: "related",
  }).decision, "related_instrument");
  assert.equal(pinFamilyVerdictInput({
    pair_id: "pf:a::b", actor: "captain", decision: "merge",
  }).error, "invalid-decision");
});

test("GET /admin/pin-family-verify lists only the 6 genuinely ambiguous pairs", async () => {
  const { env } = fixtureEnv();
  assert.equal(
    (await handleAdminPinFamilyVerify(jsonRequest("https://w/admin/pin-family-verify"), {})).status,
    404,
  );
  assert.equal(
    (await handleAdminPinFamilyVerify(jsonRequest("https://w/admin/pin-family-verify?key=nope"), env)).status,
    401,
  );
  const res = await handleAdminPinFamilyVerify(
    jsonRequest("https://w/admin/pin-family-verify?key=secret"),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, PIN_FAMILY_VERIFY_VERSION);
  assert.equal(body.metrics.pin_family_id_mismatches, 42);
  assert.equal(body.metrics.needs_review, 6);
  assert.equal(body.count, 6);
  assert.ok(body.pairs.every((pair) => pair.identity_class === "needs_review"));
  assert.ok(body.pairs.some((pair) => pair.evidence.checkbook.vendor === "DTN LLC"));
  assert.ok(body.pairs.some((pair) => pair.evidence.passport.vendor === "LOCKWOOD KESSLER & BARTLETT INC"));
});

test("POST writes an append-only same-contract / related-instrument verdict", async () => {
  const { env } = fixtureEnv();
  const listed = await handleAdminPinFamilyVerify(
    jsonRequest("https://w/admin/pin-family-verify?key=secret"),
    env,
  );
  const queue = await listed.json();
  const pairId = queue.pairs[0].pair_id;
  const saved = await handleAdminPinFamilyVerify(
    jsonRequest("https://w/admin/pin-family-verify?key=secret", "POST", {
      pair_id: pairId,
      actor: "captain",
      decision: "related_instrument",
      note: "Distinct vendors; shared PIN is a sibling or collision.",
    }),
    env,
  );
  assert.equal(saved.status, 201);
  const event = await saved.json();
  assert.equal(event.pair_id, pairId);
  assert.equal(event.decision, "related_instrument");
  assert.equal(event.actor, "captain");

  const html = await handleAdminPinFamilyVerify(
    new Request("https://w/admin/pin-family-verify?key=secret", {
      headers: { accept: "text/html" },
    }),
    env,
  );
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.match(page, /PIN-family contract verify/);
  assert.match(page, /Same contract/);
  assert.match(page, /Related instrument/);
  assert.match(page, /DTN LLC/);
  assert.doesNotMatch(page, /WSP USA INC/);
});
