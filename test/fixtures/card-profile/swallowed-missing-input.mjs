// A deliberately badly written check, used to force the failure mode a reduced
// checkout has to prevent: it reads a tracked input, swallows the error when the
// input is absent, asserts nothing, and exits 0.
//
// Run bare in a reduced profile it prints "checked 0 rows" and succeeds, which
// is a passing check by omission. Run through
// `node tools/verify_card_profile.mjs --gate <class> -- node <this file>` the
// sentinel records the missing tracked path and the front door fails the run
// whatever this script returned.
//
// The path it reads is in the profile's deferred hydration set, so it is
// present in the full-checkout control and absent in the reduced profile.

import { readFileSync } from "node:fs";

const INPUT = "site/data/analytics_registered_contracts.json";

let rows = [];
try {
  rows = JSON.parse(readFileSync(INPUT, "utf8"));
} catch {
  // swallowed on purpose
}

console.log(`checked ${Array.isArray(rows) ? rows.length : 0} rows from ${INPUT}`);
