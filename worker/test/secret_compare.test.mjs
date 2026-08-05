// Constant-time comparison used by scoped admin auth (SHADOW_STATUS_KEY / ADMIN_KEY).
// verify: node --test worker/test/secret_compare.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { timingSafeEqualString } from "../src/lib/secret_compare.mjs";

test("equal strings compare true, unequal compare false", () => {
  assert.equal(timingSafeEqualString("abc123", "abc123"), true);
  assert.equal(timingSafeEqualString("abc123", "abc124"), false);
  assert.equal(timingSafeEqualString("abc123", "abc12"), false);
  assert.equal(timingSafeEqualString("abc12", "abc123"), false);
});

test("prefix differences do not early-exit (longer equal-prefix strings still differ)", () => {
  assert.equal(timingSafeEqualString("aaaaaaaaaa", "aaaaaaaaab"), false);
  assert.equal(timingSafeEqualString("aaaaaaaaaa", "aaaaaaaaaa"), true);
});

test("empty / null / undefined inputs never throw and compare against empty", () => {
  assert.equal(timingSafeEqualString("", ""), true);
  assert.equal(timingSafeEqualString("", "x"), false);
  assert.equal(timingSafeEqualString(undefined, undefined), true);
  assert.equal(timingSafeEqualString(null, null), true);
  assert.equal(timingSafeEqualString(undefined, "x"), false);
  assert.equal(timingSafeEqualString("x", undefined), false);
});

test("non-string inputs are coerced to strings for comparison", () => {
  assert.equal(timingSafeEqualString(123, 123), true);
  assert.equal(timingSafeEqualString(123, "123"), true);
  assert.equal(timingSafeEqualString(123, 124), false);
});
