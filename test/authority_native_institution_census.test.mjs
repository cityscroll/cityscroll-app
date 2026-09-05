import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkCensus } from '../tools/check_institution_source_census.mjs';

const census = JSON.parse(readFileSync(
  fileURLToPath(new URL('../warehouse/fixtures/authority-native-procurement/institution_source_census.v1.json', import.meta.url)),
  'utf8',
));

test('institution source census is internally consistent and fail-closed', () => {
  // sources/fixtures/doe_canonical_rows are the committed census's own counts — this
  // gate only requires checkCensus() to still agree with the committed fixture (via its
  // sha256/count consistency checks) and that no DOE corpus has been demonstrated missing,
  // not a second hardcoded copy of population counts that drift with a routine data refresh.
  assert.deepEqual(checkCensus(), {
    sources: census.sources.length,
    fixtures: census.fixtures.length,
    doe_rows: census.doe_missing_record_census.doe_canonical_rows,
    doe_missing_rows: 0
  });
});
