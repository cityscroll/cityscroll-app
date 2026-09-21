import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("scoped consultation detail returns the complete search state through native Back", () => {
  runBrowserJourney({
    label: "scoped consultation search return",
    harness: "./consultation_search_journey.py",
  });
});
