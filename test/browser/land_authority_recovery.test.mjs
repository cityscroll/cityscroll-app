import test from "node:test";
import { runBrowserJourney } from "./run_browser_journey.mjs";

test("Land detail authority agrees with retained timeline through recovery states", () => {
  runBrowserJourney({
    label: "Land detail authority recovery",
    harness: "./land_authority_recovery.py",
  });
});
