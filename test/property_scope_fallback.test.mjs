import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { propertyScopeView } from "../site/property_scope_fallback.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/property_scope/brooklyn_property_scope_empty.json", import.meta.url),
  "utf8",
));

function viewForFixture(item, extra = {}) {
  return propertyScopeView({
    ...extra,
    requestedView: item.requested_view,
    placeScoped: true,
    currentCount: item.current_count,
    archiveCount: item.archive_count,
  });
}

test("Brooklyn Property scope empties: archive-only borough scope opens its available records", () => {
  const symptom = fixture.cases.find((item) => item.id === "brooklyn-property-scope-archive-only");
  assert.ok(symptom, "the field symptom fixture is present");
  assert.equal(symptom.current_count, 0, "before behavior records the empty current view");
  assert.equal(symptom.archive_count, 46, "before behavior records the available archive");
  assert.equal(
    viewForFixture(symptom),
    symptom.expected_view,
  );
});

test("Property scope fallback keeps current matches, honest no-match states, and categories consistent", () => {
  for (const item of fixture.cases) {
    assert.equal(
      viewForFixture(item),
      item.expected_view,
      item.id,
    );
  }
});

test("an explicit archive request remains authoritative even when current records exist", () => {
  assert.equal(
    propertyScopeView({
      placeScoped: true,
      requestedView: "archive",
      currentCount: 2,
      archiveCount: 46,
    }),
    "archive",
  );
});
