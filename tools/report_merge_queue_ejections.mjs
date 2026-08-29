#!/usr/bin/env node
/**
 * Snapshot GitHub's native merge-queue removals after the repo-side cap
 * reconciliation. The report deliberately observes GitHub only: an external
 * seater is a separate control-plane concern and is not queried here.
 *
 * Usage:
 *   node tools/report_merge_queue_ejections.mjs
 *   node tools/report_merge_queue_ejections.mjs --write
 *   node tools/report_merge_queue_ejections.mjs --observed-at 2026-08-16T21:30:00Z
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");
const GITHUB_REMOVAL_DOC =
  "https://docs.github.com/en/graphql/reference/pulls#removedfrommergequeueevent";

function parseArgs(argv) {
  const args = { write: false, observedAt: new Date().toISOString() };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--observed-at") args.observedAt = argv[++index];
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function assertTimestamp(value, label) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function countBy(rows, key) {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const value = row[key] || "unknown";
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function sameMergeQueue(left, right) {
  const fields = [
    "merge_method",
    "grouping_strategy",
    "max_entries_to_build",
    "min_entries_to_merge",
    "max_entries_to_merge",
    "min_entries_to_merge_wait_minutes",
    "check_response_timeout_minutes",
  ];
  return fields.every((field) => left?.[field] === right?.[field]);
}

export function buildMergeQueueEjectionReport({
  policy,
  ruleset,
  pullRequests,
  since,
  observedAt,
}) {
  assertTimestamp(since, "since");
  assertTimestamp(observedAt, "observedAt");
  if (Date.parse(observedAt) < Date.parse(since)) {
    throw new Error("observedAt must not precede since");
  }

  const mergeRule = ruleset.rules?.find((rule) => rule.type === "merge_queue");
  const checksRule = ruleset.rules?.find(
    (rule) => rule.type === "required_status_checks",
  );
  if (!mergeRule || !checksRule) {
    throw new Error("live ruleset is missing merge_queue or required_status_checks");
  }
  const liveChecks = (
    checksRule.parameters?.required_status_checks || []
  ).map((check) => check.context);
  const livePolicyMatches =
    sameMergeQueue(mergeRule.parameters, policy.merge_queue) &&
    sameSet(liveChecks, policy.required_status_checks);

  const events = [];
  for (const pullRequest of pullRequests) {
    const timeline = pullRequest.timelineItems;
    if (timeline?.pageInfo?.hasNextPage) {
      throw new Error(
        `pull request #${pullRequest.number} has more than 100 queue-removal events`,
      );
    }
    for (const event of timeline?.nodes || []) {
      if (
        event.createdAt < since ||
        event.createdAt > observedAt
      ) continue;
      events.push({
        pull_request: pullRequest.number,
        pull_request_url: pullRequest.url,
        created_at: event.createdAt,
        reason: event.reason || "unknown",
        actor: event.actor?.login || null,
      });
    }
  }
  events.sort((left, right) =>
    left.created_at.localeCompare(right.created_at) ||
    left.pull_request - right.pull_request,
  );

  const merged = events.filter((event) => event.reason === "merged");
  const ejections = events.filter((event) => event.reason !== "merged");
  const manualRemovals = ejections.filter((event) => event.reason === "manual");
  const automaticEjections = ejections.filter(
    (event) => event.reason !== "manual" && event.actor === "github-merge-queue",
  );

  return {
    schema: "cityscroll.merge-queue-ejection-report.v1",
    observed_at: observedAt,
    window: { started_at: since, ended_at: observedAt },
    repository: policy.repository,
    capacity: {
      model: "one_native_train",
      max_entries_to_build: policy.merge_queue.max_entries_to_build,
      larger_train_proposed: false,
    },
    ruleset_proof: {
      source_url: `https://api.github.com/repos/${policy.repository}/rulesets/${policy.ruleset_id}`,
      ruleset_id: policy.ruleset_id,
      live_matches_committed_policy: livePolicyMatches,
      live_merge_queue: mergeRule.parameters,
      committed_merge_queue: policy.merge_queue,
      live_required_status_checks: liveChecks,
      committed_required_status_checks: policy.required_status_checks,
    },
    queue_removal_proof: {
      source: "GitHub GraphQL PullRequest.timelineItems",
      source_documentation: GITHUB_REMOVAL_DOC,
      event_type: "RemovedFromMergeQueueEvent",
      pull_requests_scanned: pullRequests.length,
      removal_events_observed: events.length,
      successful_dequeues_after_merge: merged.length,
      ejections: ejections.length,
      automatic_ejections: automaticEjections.length,
      manual_removals: manualRemovals.length,
      ejections_by_reason: countBy(ejections, "reason"),
    },
    scope: {
      included: "GitHub native merge-queue ruleset and pull-request removal events",
      excluded:
        "External scheduler/seater implementation and telemetry; that control-plane decision is outside the CityScroll app lane.",
    },
    ejection_events: ejections,
  };
}

function runGhJson(args) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function fetchLiveInputs(policy, since) {
  const ruleset = runGhJson([
    "api",
    `repos/${policy.repository}/rulesets/${policy.ruleset_id}`,
  ]);
  const searchSince = since.slice(0, 10);
  const query = `query($endCursor:String){
    search(query:"repo:${policy.repository} is:pr updated:>=${searchSince}", type:ISSUE, first:100, after:$endCursor) {
      issueCount
      nodes {
        ... on PullRequest {
          number
          url
          timelineItems(first:100, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]) {
            nodes {
              ... on RemovedFromMergeQueueEvent {
                createdAt
                reason
                actor { login }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const pages = runGhJson([
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-F",
    "endCursor=null",
    "-f",
    `query=${query}`,
  ]);
  const issueCount = pages[0]?.data?.search?.issueCount || 0;
  if (issueCount > 1000) {
    throw new Error(
      `GitHub search matched ${issueCount} pull requests; narrow the observation window below the 1000-result cap`,
    );
  }
  const pullRequests = pages.flatMap((page) => page.data.search.nodes);
  return { ruleset, pullRequests };
}

function main() {
  const args = parseArgs(process.argv);
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
  const since = policy.ejection_observation?.started_at;
  const { ruleset, pullRequests } = fetchLiveInputs(policy, since);
  const report = buildMergeQueueEjectionReport({
    policy,
    ruleset,
    pullRequests,
    since,
    observedAt: args.observedAt,
  });
  if (!report.ruleset_proof.live_matches_committed_policy) {
    throw new Error("live merge-queue ruleset has drifted from committed policy");
  }
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args.write) {
    const outputPath = path.join(ROOT, policy.ejection_observation.report_path);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered);
    console.log(`wrote ${path.relative(ROOT, outputPath)}`);
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
