import assert from "node:assert/strict";
import test from "node:test";

import { createIncrementalList } from "../site/incremental_list.mjs";

function fakeContainer() {
  const container = { innerHTML: "", button: null };
  container.querySelector = () => container.button;
  return container;
}

test("incremental list renders the first page, grows by 24, and reports the new count", () => {
  const container = fakeContainer();
  let click = null;
  const seen = [];
  container.querySelector = () => container.button;
  const list = createIncrementalList({
    container,
    initialPageSize: 16,
    pageSize: 24,
    getItems: () => items,
    renderItems: (items) => {
      seen.push(items.length);
      return items.map(String).join(",");
    },
    renderMore: (remaining) => `more ${remaining}`,
    onMore: (result) => { click = result; },
  });
  const items = Array.from({ length: 60 }, (_, index) => index);
  const first = list.render({ items });
  container.button = { addEventListener: (_event, handler) => { container.button.click = handler; } };
  // Re-render installs the fake button after the result markup has been set.
  list.render({ items });
  container.button.click();
  assert.equal(first.shown.length, 16);
  assert.equal(click.shown.length, 40);
  assert.equal(click.remaining, 20);
  assert.deepEqual(seen, [16, 16, 40]);
});

test("incremental list uses the caller's empty renderer", () => {
  const container = fakeContainer();
  const list = createIncrementalList({
    container,
    renderEmpty: () => "empty",
  });
  list.render({ items: [] });
  assert.equal(container.innerHTML, "empty");
});
