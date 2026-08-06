/** Whether a bounded/degraded list is smaller than the count promised by its scope. */
export function scopedHistoryGap({ observed = 0, receipt = null, scoped = false } = {}) {
  const expected = Number(receipt);
  return Boolean(scoped)
    && Number.isInteger(expected)
    && expected >= 0
    && Number(observed) < expected;
}

