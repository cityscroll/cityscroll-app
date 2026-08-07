#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TARGETS = ["action-links-live", "source-contracts-live", "digest-shadow-monitor"];

export async function auditSchedulerOwnership(root = ROOT) {
  const jobs = JSON.parse(await readFile(join(root, "tools", "external_schedule_jobs.json"), "utf8"));
  const errors = [];
  if (jobs.scheduler?.provider === "github-actions" || jobs.scheduler?.ownership !== "independent") errors.push("scheduler is not independent");
  for (const id of TARGETS) {
    const job = jobs.jobs.find((candidate) => candidate.id === id);
    if (!job) { errors.push(`missing external job: ${id}`); continue; }
    if (!job.schedule?.length || !job.runner) errors.push(`${id}: missing schedule or runner`);
    const workflow = join(root, ".github", "workflows", `${id}.yml`);
    try {
      const text = await readFile(workflow, "utf8");
      if (/^\s*schedule:/m.test(text)) errors.push(`${id}: GitHub Actions still owns a schedule`);
      if (/actions\/github-script|issues:\s*write/.test(text)) errors.push(`${id}: GitHub issue loop remains in Actions`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { ok: errors.length === 0, errors, targets: TARGETS, scheduler: jobs.scheduler };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  auditSchedulerOwnership().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
