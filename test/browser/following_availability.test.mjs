import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const browserJourney = fileURLToPath(new URL("./following_availability.py", import.meta.url));

test("rendered availability controls pass the resident browser journeys", () => {
  execFileSync("python3", [browserJourney], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "inherit",
  });
});
