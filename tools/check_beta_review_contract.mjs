#!/usr/bin/env node
/** Validate the public review record before a beta-required pull request is ready. */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_LABEL = "preview:beta";
const OUTCOMES = ["Promote", "Revise", "Withdraw"];

function checked(body, outcome) {
  const pattern = new RegExp(`^- \\[([ xX])\\] ${outcome}\\b`, "m");
  return pattern.exec(body)?.[1]?.toLowerCase() === "x";
}

function field(body, label) {
  const pattern = new RegExp(`^${label}:\\s*([^\\n]*)`, "mi");
  return pattern.exec(body)?.[1]?.trim() || "";
}

function section(body, start, end = null) {
  const startMatch = new RegExp(`^${start}:\\s*\\n`, "mi").exec(body);
  if (!startMatch) return "";
  const tail = body.slice(startMatch.index + startMatch[0].length);
  const stops = [tail.search(/^#{1,6}\s/m)];
  if (end) stops.push(tail.search(new RegExp(`^${end}:`, "mi")));
  const validStops = stops.filter((index) => index >= 0);
  const stop = validStops.length ? Math.min(...validStops) : tail.length;
  return tail.slice(0, stop).trim();
}

function meaningful(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateBetaReview({ number, draft, labels, body }) {
  const names = labels.map((label) =>
    typeof label === "string" ? label : label?.name,
  );
  if (!names.includes(REQUIRED_LABEL) || draft) return [];

  const text = body || "";
  const errors = [];
  const expectedAlias = `https://pr-${number}.crol-list-beta.pages.dev`;
  if (field(text, "Beta link").replace(/\/$/, "") !== expectedAlias) {
    errors.push(`Beta link must use this pull request's stable preview alias: ${expectedAlias}`);
  }

  if (!realDate(field(text, "Review deadline"))) {
    errors.push("Review deadline must be a real YYYY-MM-DD date");
  }

  if (
    !/React ✅ if you would be comfortable shipping this\./.test(text) ||
    !/screen, concern, and preferred change/.test(text)
  ) {
    errors.push("The group-chat reaction and objection prompt is missing");
  }

  const selected = OUTCOMES.filter((outcome) => checked(text, outcome));
  if (selected.length !== 1) {
    errors.push("Select exactly one site owner outcome");
  } else if (selected[0] !== "Promote") {
    errors.push(
      `A ${selected[0]} outcome must remain draft; only Promote may become ready`,
    );
  }

  if (!meaningful(section(text, "Outcome summary", "Objection disposition"))) {
    errors.push("A public-safe outcome summary is required");
  }
  if (!meaningful(section(text, "Objection disposition"))) {
    errors.push("An objection disposition is required, including no-response cases");
  }
  return errors;
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
    console.log("beta review contract green");
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
