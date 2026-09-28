import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("Near You local recovery link is reachable, focused, and navigable in real Chromium", () => {
  runBrowserJourney({
    label: "Near You local recovery journey",
    harness: "./near_you_local_recovery.py",
  });
});
