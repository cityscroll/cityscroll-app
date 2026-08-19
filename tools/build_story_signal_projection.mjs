#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPrivateStorySignalProjection,
  renderPrivateStorySignalPage,
} from "../site/story_signal_projection.mjs";

const SIGNALS = new URL("../site/data/comparative_story_signals.json", import.meta.url);
const OUTPUT = new URL("../site/experimental/worth-a-look/index.html", import.meta.url);

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function buildStorySignalProjectionArtifact(readModel = json(SIGNALS)) {
  return renderPrivateStorySignalPage(buildPrivateStorySignalProjection(readModel));
}

export function storySignalProjectionOutputs(readModel = json(SIGNALS)) {
  return [[fileURLToPath(OUTPUT), buildStorySignalProjectionArtifact(readModel)]];
}

export function writeStorySignalProjection({ check = false } = {}) {
  const [[path, html]] = storySignalProjectionOutputs();
  const stale = !existsSync(path) || readFileSync(path, "utf8") !== html;
  if (check && stale) {
    console.error(`stale private story-signal projection: ${path}`);
    process.exitCode = 1;
    return;
  }
  if (!check && stale) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
  console.log(stale ? "wrote private story-signal projection" : "private story-signal projection current");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeStorySignalProjection({ check: process.argv.includes("--check") });
}
