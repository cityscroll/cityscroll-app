#!/usr/bin/env node
/** Validate technical preview provenance for ready beta-labeled pull requests. */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_LABEL = "preview:beta";

export function validateBetaReview({ number, draft, labels, body }) {
  const names = labels.map((label) =>
    typeof label === "string" ? label : label?.name,
  );
  if (!names.includes(REQUIRED_LABEL) || draft) return [];

  const expectedAlias = `https://pr-${number}.crol-list-beta.pages.dev`;
  if (!(body || "").includes(expectedAlias)) {
    return [
      `Ready beta preview must name this pull request's stable preview alias: ${expectedAlias}`,
    ];
  }
  return [];
}

function main() {
  const eventPath = process.argv[2] || process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GitHub event path is required");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (!event.pull_request) return;
  const errors = validateBetaReview({
    number: event.pull_request.number,
    draft: event.pull_request.draft,
    labels: event.pull_request.labels || [],
    body: event.pull_request.body || "",
  });
  if (errors.length) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
  } else {
    console.log("beta preview alias contract green");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
