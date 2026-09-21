import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("reciprocal site history passes the native browser journey", () => {
  runBrowserJourney({
    label: "reciprocal site history",
    harness: "./site_lifecycle_journey.py",
  });
});
