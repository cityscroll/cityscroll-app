// Shared phase-state kernel: fixture cases, refusal bounds, and 64-case identity.
//
//   node --test test/phase_state_kernel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { phaseStates } from "../site/phase_state_kernel.mjs";

const ORDER = Object.freeze(["solicitation", "award", "registration", "payment"]);
const PARITY_ORDER = Object.freeze(["p0", "p1", "p2", "p3"]);
const LETTER = Object.freeze({ passed: "P", current: "C", future: "F" });

// Recorded output of the five spines' own phaseState source on every combination of
// four phases, a current phase, and which phases carry material (64 cases). The five
// agreed at the pinned baseline; the kernel must reproduce that string.
const BASELINE_GOLDEN =
  "CFFF CFFF CPFF CPFF CFPF CFPF CPPF CPPF CFFP CFFP CPFP CPFP CFPP CFPP CPPP CPPP " +
  "PCFF PCFF PCFF PCFF PCPF PCPF PCPF PCPF PCFP PCFP PCFP PCFP PCPP PCPP PCPP PCPP " +
  "PPCF PPCF PPCF PPCF PPCF PPCF PPCF PPCF PPCP PPCP PPCP PPCP PPCP PPCP PPCP PPCP " +
  "PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC PPPC";

const CASES = [
  {
    id: "material-up-to-current",
    current: "award",
    material: ["solicitation", "award"],
    rule: "material-passes",
    want: ["passed", "current", "future", "future"],
  },
  {
    id: "material-after-current",
    current: "award",
    material: ["award", "payment"],
    rule: "material-passes",
    want: ["passed", "current", "future", "passed"],
  },
  {
    id: "nothing-yet",
    current: "solicitation",
    material: [],
    rule: "material-passes",
    want: ["current", "future", "future", "future"],
  },
  {
    id: "last-phase-current",
    current: "payment",
    material: [],
    rule: "material-passes",
    want: ["passed", "passed", "passed", "current"],
  },
  {
    id: "strict-ignores-later-material",
    current: "award",
    material: ["award", "payment"],
    rule: "strict",
    want: ["passed", "current", "future", "future"],
  },
  {
    id: "strict-current-needs-material",
    current: "award",
    material: [],
    rule: "strict",
    want: ["passed", "future", "future", "future"],
  },
  {
    id: "strict-ordinary",
    current: "registration",
    material: ["solicitation", "registration"],
    rule: "strict",
    want: ["passed", "passed", "current", "future"],
  },
];

const NEGATIVES = [
  {
    id: "unknown-current",
    args: { order: ORDER, current: "closeout", material: [], rule: "material-passes" },
    name: "RangeError",
  },
  {
    id: "duplicate-phase",
    args: { order: ["a", "a", "b"], current: "a", material: [], rule: "material-passes" },
    name: "TypeError",
  },
  {
    id: "unknown-rule",
    args: { order: ORDER, current: "award", material: [], rule: "optimistic" },
    name: "TypeError",
  },
];

const WIRED_SPINES = [
  "site/matter_phase_spine.mjs",
  "site/vendor_phase_spine.mjs",
  "site/procurement_phase_spine.mjs",
  "site/meeting_phase_spine.mjs",
  "site/rules_phase_spine.mjs",
];

const UNTOUCHED_SPINES = [
  "site/land_phase_spine.mjs",
  "site/subsidy_phase_spine.mjs",
  "site/paper_trail_phase.mjs",
  "site/exam_phase_spine.mjs",
  "site/franchise_phase_spine.mjs",
  "site/property_phase_spine.mjs",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const c of CASES) {
  test(`phaseStates ${c.id}`, () => {
    const got = phaseStates({
      order: ORDER,
      current: c.current,
      material: c.material,
      rule: c.rule,
    }).map((row) => row.state);
    assert.deepEqual(got, c.want);
  });
}

for (const c of NEGATIVES) {
  test(`phaseStates refuses ${c.id}`, () => {
    assert.throws(() => phaseStates(c.args), { name: c.name });
  });
}

test("phaseStates matches the five-spine baseline on all 64 small cases", () => {
  const cases = [];
  for (const current of PARITY_ORDER) {
    for (let mask = 0; mask < 2 ** PARITY_ORDER.length; mask++) {
      cases.push({
        current,
        material: PARITY_ORDER.filter((_, i) => mask & (1 << i)),
      });
    }
  }
  assert.equal(cases.length, 64);
  const kernel = cases
    .map((c) =>
      phaseStates({
        order: PARITY_ORDER,
        current: c.current,
        material: c.material,
        rule: "material-passes",
      })
        .map((p) => LETTER[p.state])
        .join(""),
    )
    .join(" ");
  assert.equal(kernel, BASELINE_GOLDEN);
});

test("five spines call the shared kernel with material-passes and drop local phaseState", () => {
  for (const rel of WIRED_SPINES) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.match(text, /from ["']\.\/phase_state_kernel\.mjs["']/);
    assert.match(text, /phaseStates\s*\(/);
    assert.match(text, /material-passes/);
    assert.equal(text.includes("function phaseState(id)"), false, rel);
  }
});

test("out-of-scope spines keep their prior phaseState shape", () => {
  for (const rel of UNTOUCHED_SPINES) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.equal(text.includes("phase_state_kernel"), false, rel);
  }
  assert.match(
    readFileSync(join(root, "site/land_phase_spine.mjs"), "utf8"),
    /function phaseState\(id\)/,
  );
  assert.match(
    readFileSync(join(root, "site/subsidy_phase_spine.mjs"), "utf8"),
    /function phaseState\(id\)/,
  );
});
