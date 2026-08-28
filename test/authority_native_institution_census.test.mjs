import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCensus } from '../tools/check_institution_source_census.mjs';

test('institution source census is internally consistent and fail-closed', () => {
  assert.deepEqual(checkCensus(), {
    sources: 11,
    fixtures: 4,
    doe_rows: 618,
    doe_missing_rows: 0
  });
});
