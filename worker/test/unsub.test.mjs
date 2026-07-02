// Regression guard for the List-Unsubscribe header crol-worker emits on every digest, now that
// the builders live in `optin-token` (extracted 2026-07-02). Proves the exact header string
// alerts.mjs sends is unchanged after the swap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replyAddr, listUnsubscribe } from "optin-token";

test("replyAddr extracts the address from a display-name From", () => {
  assert.equal(replyAddr("CROL-List <alerts@crol-list.org>"), "alerts@crol-list.org");
});

test("replyAddr passes through a bare address", () => {
  assert.equal(replyAddr("alerts@crol-list.org"), "alerts@crol-list.org");
});

test("listUnsubscribe builds an angle-bracketed mailto with an encoded subject", () => {
  assert.equal(
    listUnsubscribe("CROL-List <alerts@crol-list.org>", "awards-1m"),
    "<mailto:alerts@crol-list.org?subject=unsubscribe%20awards-1m>"
  );
});

test("listUnsubscribe encodes spaces in a watch id", () => {
  assert.equal(
    listUnsubscribe("alerts@crol-list.org", "rivington watch"),
    "<mailto:alerts@crol-list.org?subject=unsubscribe%20rivington%20watch>"
  );
});
