import assert from "node:assert/strict";
import test from "node:test";

import { scopedHistoryGap } from "../site/money_scope_consistency.mjs";

test("scoped degraded lists report a gap when observed rows trail the receipt", () => {
  assert.equal(scopedHistoryGap({ observed: 0, receipt: 26, scoped: true }), true);
  assert.equal(scopedHistoryGap({ observed: 4, receipt: 26, scoped: true }), true);
  assert.equal(scopedHistoryGap({ observed: 26, receipt: 26, scoped: true }), false);
});

test("unscoped degraded lists keep the existing recent-window notice", () => {
  assert.equal(scopedHistoryGap({ observed: 0, receipt: null, scoped: false }), false);
  assert.equal(scopedHistoryGap({ observed: 4, receipt: 26, scoped: false }), false);
});

