import assert from "node:assert/strict";
import test from "node:test";

import { runBrowserJourney } from "./browser/run_browser_journey.mjs";

test("missing browser journey harness fails with a named diagnostic", () => {
  assert.throws(
    () => runBrowserJourney({ label: "missing harness", harness: "./does-not-exist.py" }),
    /Browser journey cannot run: harness is missing/,
  );
});

test("missing Python Playwright fails instead of skipping the journey", () => {
  const previousPython = process.env.CITYSCROLL_BROWSER_PYTHON;
  process.env.CITYSCROLL_BROWSER_PYTHON = process.execPath;
  try {
    assert.throws(
      () => runBrowserJourney({ label: "missing Playwright", harness: "./following_availability.py" }),
      /Browser journey cannot run: Python Playwright is unavailable/,
    );
  } finally {
    if (previousPython === undefined) {
      delete process.env.CITYSCROLL_BROWSER_PYTHON;
    } else {
      process.env.CITYSCROLL_BROWSER_PYTHON = previousPython;
    }
  }
});
