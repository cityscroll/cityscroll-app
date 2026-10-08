#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWranglerInvoker } from "./lib/wrangler_exec.mjs";
import { publishRouteReadModels } from "./lib/worker_route_publication.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (command !== "publish") {
  throw new Error("usage: node tools/worker_route_publication.mjs publish --route-dir <dir>");
}
const routeDir = arg("--route-dir");
if (!routeDir) throw new Error("--route-dir is required");

const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
try {
  const result = await publishRouteReadModels({ routeDir, invoke });
  console.log(JSON.stringify({
    schema: "cityscroll.worker_route_publication_receipt.v1",
    decision: result.decision,
    content_version: result.content_version,
    attempted: result.attempted,
    confirmed: result.confirmed,
    writes_avoided: result.writes_avoided,
  }));
} catch (error) {
  if (error?.publication_receipt) console.error(JSON.stringify(error.publication_receipt));
  throw error;
}
