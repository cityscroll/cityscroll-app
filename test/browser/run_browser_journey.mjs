import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function outputFrom(error) {
  const stderr = error?.stderr?.toString().trim();
  const stdout = error?.stdout?.toString().trim();
  return [stderr, stdout].filter(Boolean).join("\n");
}

function assertPythonPlaywright(python) {
  try {
    execFileSync(python, ["-c", "import playwright"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = outputFrom(error);
    throw new Error(
      `Browser journey cannot run: Python Playwright is unavailable for ${python}. ` +
        (details || "Install the repository-pinned browser environment before running this journey."),
    );
  }
}

export function runBrowserJourney({ label, harness }) {
  const python = process.env.CITYSCROLL_BROWSER_PYTHON || "python3";
  const harnessPath = fileURLToPath(new URL(harness, import.meta.url));

  if (!existsSync(harnessPath)) {
    throw new Error(`Browser journey cannot run: harness is missing at ${harnessPath}.`);
  }

  assertPythonPlaywright(python);
  try {
    execFileSync(python, [harnessPath], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (error) {
    const details = outputFrom(error);
    throw new Error(
      `Browser journey failed: ${label}. ` +
        (details || "The harness exited without a diagnostic; inspect the browser setup and journey output."),
    );
  }
}
