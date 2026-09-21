import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("rendered availability controls pass the resident browser journeys", () => {
  runBrowserJourney({
    label: "rendered availability controls",
    harness: "./following_availability.py",
  });
});
