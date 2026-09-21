import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const browserJourney = fileURLToPath(new URL("./site_lifecycle_journey.py", import.meta.url));

test("reciprocal site history passes the native browser journey", () => {
  execFileSync("python3", [browserJourney], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "inherit",
  });
});
