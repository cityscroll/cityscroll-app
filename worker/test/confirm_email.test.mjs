import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFilter } from "../src/lib/confirm_email.mjs";
import { subCanonical } from "../src/lib/subscriptions.mjs";

test("describeFilter renders a money threshold query", () => {
  assert.equal(
    describeFilter("money", { minAmount: 1000000, keywords: ["construction"] }),
    "contract money — about “construction” · ≥ $1,000,000"
  );
});

test("describeFilter renders a person lookup with the recovered name", () => {
  assert.equal(
    describeFilter("people", { lookupType: "person", keywords: ["rodriguez"] }),
    "people & roles — a person named “rodriguez”"
  );
});

test("describeFilter renders a land query with borough + status", () => {
  assert.equal(
    describeFilter("land", { boro: "Brooklyn", keywords: ["rezoning"], status: "all" }),
    "land & rezonings — about “rezoning” · in Brooklyn · including closed"
  );
});

test("describeFilter falls back to 'all notices' when empty", () => {
  assert.equal(describeFilter("rules", {}), "rules & notices — all notices");
});

test("subCanonical is stable regardless of email case/whitespace", () => {
  const a = subCanonical({ email: " A@B.com ", lens: "money", filter: { minAmount: 1000000 } });
  const b = subCanonical({ email: "a@b.com", lens: "money", filter: { minAmount: 1000000 } });
  assert.equal(a, b);
});
