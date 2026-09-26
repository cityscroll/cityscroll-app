import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("signed-out Land geography Following preview matches public membership in Chromium", () => {
  runBrowserJourney({
    label: "signed-out Land geography Following preview",
    harness: "./land_watch_preview_signed_out.py",
  });
});
