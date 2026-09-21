import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("friendly navigator release journey passes retained local browser proof", () => {
  runBrowserJourney({
    label: "friendly navigator release journey",
    harness: "./geography_navigation_release.py",
  });
});
