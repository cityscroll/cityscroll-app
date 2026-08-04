import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractNoticeFacts, noticeFactsFallbacks } from "../worker/src/lib/notice_facts.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/notice_facts/real_notices.json", import.meta.url)));

function compact(facts) {
  return {
    identifiers: facts.identifiers.map(({ kind, value }) => ({ kind, value })),
    deadlines: facts.deadlines.map(({ kind, at }) => ({ kind, at })),
    parties: facts.parties.map(({ role, name }) => ({ role, name })),
  };
}

for (const entry of fixture.cases) {
  test(`real notice ${entry.request_id}: extracts only labeled facts`, () => {
    const facts = extractNoticeFacts(entry.row);
    assert.deepEqual(compact(facts), entry.expected);
    assert.ok(facts.procurement_method);
    assert.equal(typeof facts.procurement_method, "object");
    for (const key of ["identifiers", "deadlines", "parties"]) {
      for (const fact of facts[key]) {
        assert.equal(fact.source, "notice_body");
        assert.ok(fact.evidence.length >= 8);
      }
    }
  });
}

test("fallbacks use only a unique PIN/EPIN and unique submission deadline", () => {
  const positive = extractNoticeFacts(fixture.cases[0].row);
  assert.deepEqual(noticeFactsFallbacks(positive), {
    pin: "11203",
    due_date: "2025-07-24 23:59:00",
  });

  const procurementEpin = extractNoticeFacts(fixture.cases[1].row);
  assert.deepEqual(noticeFactsFallbacks(procurementEpin), {
    pin: "85826Y1367",
    due_date: null,
  });

  const testimony = extractNoticeFacts(fixture.cases[2].row);
  assert.deepEqual(noticeFactsFallbacks(testimony), { pin: null, due_date: null });
});

test("fixture score reports exact precision and recall for the characterized corpus", () => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const entry of fixture.cases) {
    const actual = compact(extractNoticeFacts(entry.row));
    for (const key of ["identifiers", "deadlines", "parties"]) {
      const got = new Set(actual[key].map(JSON.stringify));
      const want = new Set(entry.expected[key].map(JSON.stringify));
      tp += [...got].filter((value) => want.has(value)).length;
      fp += [...got].filter((value) => !want.has(value)).length;
      fn += [...want].filter((value) => !got.has(value)).length;
    }
  }
  assert.deepEqual({ tp, fp, fn }, { tp: 6, fp: 0, fn: 0 });
});

test("fact arrays are bounded even when a notice repeats many labeled values", () => {
  const body = Array.from({ length: 80 }, (_, index) => `EPIN: 85826Y${String(index).padStart(4, "0")}`).join("; ");
  assert.equal(extractNoticeFacts({ additional_description_1: body }).identifiers.length, 32);
});
