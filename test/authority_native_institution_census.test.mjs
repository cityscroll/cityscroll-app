import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkCensus, refreshExistingSnapshot } from '../tools/check_institution_source_census.mjs';

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

test('refresh accepts the re-reviewed DOE count and refuses a different one', () => {
  const section = census.doe_missing_record_census;
  assert.equal(section.doe_canonical_rows, 4679);
  assert.equal(section.demonstrated_missing_rows, 0);
  assert.equal(section.production_card_proposed, false);
  assert.equal(section.re_review.reviewed_at, '2026-11-27');
  assert.equal(section.re_review.reviewer, 'delegated reviewer');
  assert.equal(section.re_review.authority, 'standing site-owner direction');
  assert.equal(section.re_review.previous_doe_canonical_rows, 4628);
  assert.match(section.re_review.reason, /71 newly observed Checkbook-only contracts dated inside both windows and 20 expirations/);

  const accepted = refreshExistingSnapshot({ write: false });
  assert.equal(accepted.recordedCount, 4679);
  assert.equal(accepted.measuredCount, 4679);

  assert.throws(
    () => refreshExistingSnapshot({ recordedDoeCanonicalRows: 4628 }),
    /DOE canonical row count changed \(4628 -> 4679\)/,
  );
  assert.throws(
    () => refreshExistingSnapshot({ measuredDoeCanonicalRows: section.doe_canonical_rows + 1 }),
    /DOE canonical row count changed \(4679 -> 4680\)/,
  );
});
