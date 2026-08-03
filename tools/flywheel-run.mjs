#!/usr/bin/env node
// Multi-dimension autonomous improvement flywheel entrypoint.
//
//   Monitor → Analyze → Plan (all dimensions) → reconcile ledger → emit queue
//
// Execute (agent dispatch) is intentionally external: consumers read the
// emitted JSON queue and fan out work. See docs/multi-flywheel.md.
//
// Usage:
//   node tools/flywheel-run.mjs --fixture --emit <dir>
//   node tools/flywheel-run.mjs --fixture --emit ontology/queue/out --update-ledger
//   node tools/flywheel-run.mjs --fixture --json
//   node tools/flywheel-run.mjs --fixture --dimensions coverage,data-integrity
//   node tools/flywheel-run.mjs --live --surface-load <sample.json> --dimensions surface-load

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDefaultInputs,
  runMultiFlywheel,
  planLessonFileUpdate,
} from "../ontology/flywheel_run.mjs";
import { emptyLedger } from "../ontology/card_queue.mjs";
import { applyLessonsToFile } from "../ontology/engineering_lessons.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(ROOT, "ontology/queue/ledger.json");
const DEFAULT_LESSONS = join(ROOT, "ontology/engineering-lessons.md");

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/flywheel-run.mjs (--fixture | --live --surface-load <path>) --emit <dir> [options]

Options:
  --dimensions a,b     subset of dimensions (default: all)
  --surface-load path  rendered inventory produced by tools/sample_surface_load.py
  --ledger <path>      idempotency ledger (default: ontology/queue/ledger.json)
  --update-ledger      write merged ledger back to --ledger path
  --lessons <path>     engineering-lessons.md path (default: ontology/engineering-lessons.md)
  --write-lessons      append recurring lesson classes
  --refresh-open       re-emit already-open cards with refreshed evidence
  --limit N            max cards in queue (default 50)
  --generated-at ISO   pin timestamps (default fixed epoch for determinism)
  --json               print full queue document
  --check              require existing queue.json to match (deterministic gate)

Emits under --emit:
  queue.json           ranked, deduplicated card queue (machine contract)
  cards.jsonl          one card per line
  receipt.json         run summary (dimensions + metrics + hash)
  cards/*.md           human-readable card files`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixture: false,
    live: false,
    surfaceLoad: null,
    emit: null,
    dimensions: null,
    ledger: DEFAULT_LEDGER,
    updateLedger: false,
    lessons: DEFAULT_LESSONS,
    writeLessons: false,
    refreshOpen: false,
    limit: 50,
    generatedAt: "1970-01-01T00:00:00.000Z",
    json: false,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = true;
    else if (a === "--live") args.live = true;
    else if (a === "--surface-load") args.surfaceLoad = resolve(argv[++i]);
    else if (a === "--emit") args.emit = resolve(argv[++i]);
    else if (a === "--dimensions") {
      args.dimensions = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--ledger") args.ledger = resolve(argv[++i]);
    else if (a === "--update-ledger") args.updateLedger = true;
    else if (a === "--lessons") args.lessons = resolve(argv[++i]);
    else if (a === "--write-lessons") args.writeLessons = true;
    else if (a === "--refresh-open") args.refreshOpen = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--generated-at") args.generatedAt = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.cards || typeof raw.cards !== "object") {
    return { ...emptyLedger(), ...raw, cards: {} };
  }
  return raw;
}

function renderCardMarkdown(card) {
  return [
    "---",
    `id: ${card.id}`,
    `title: ${JSON.stringify(card.title)}`,
    `status: ${card.status}`,
    `dimension: ${card.dimension}`,
    `rank: ${card.rank}`,
    `verify: ${JSON.stringify(card.verify)}`,
    `demo_win: ${JSON.stringify(card.demo_win)}`,
    `lesson_class: ${card.lesson_class == null ? "null" : JSON.stringify(card.lesson_class)}`,
    `emitted_by: ${card.emitted_by}`,
    `policy_version: ${card.policy_version}`,
    "---",
    "",
    "### Demo win",
    "",
    card.demo_win || "",
    "",
    "### Evidence",
    "```json",
    JSON.stringify(card.evidence || {}, null, 2),
    "```",
    "",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    usage(error.message);
    return;
  }
  if (args.help) {
    usage();
    return;
  }
  if (args.fixture === args.live) {
    usage("choose exactly one of --fixture or --live");
    return;
  }
  if (args.live && !args.surfaceLoad) {
    usage("--live requires --surface-load <path>");
    return;
  }
  if (!args.emit && !args.json) {
    usage("require --emit <dir> or --json");
    return;
  }

  const inputs = loadDefaultInputs(ROOT, {
    mode: args.live ? "live" : "fixture",
    surfaceLoadPath: args.surfaceLoad,
  });
  const ledger = loadLedger(args.ledger);
  const result = runMultiFlywheel({
    inputs,
    ledger,
    dimensions: args.dimensions,
    generated_at: args.generatedAt,
    refresh_open: args.refreshOpen,
    limit: args.limit,
    ledger_path: args.ledger,
  });

  const { queue, ledger: nextLedger, lessons } = result;
  const receipt = {
    schema: "cityscroll.multi_flywheel_receipt.v0",
    generated_at: queue.generated_at,
    mode: queue.mode,
    queue_hash: queue.content_hash,
    dimensions_run: result.dimensions_run,
    raw_card_count: result.raw_card_count,
    emitted: queue.stats.card_count,
    skipped: queue.stats.skipped,
    regressions: queue.stats.regressions,
    by_dimension: queue.stats.by_dimension,
    dimension_metrics: queue.dimension_metrics,
    lessons: lessons.map((l) => ({
      lesson_class: l.lesson_class,
      count: l.count,
    })),
  };

  if (args.emit) {
    const queuePath = join(args.emit, "queue.json");
    const queueText = `${JSON.stringify(queue, null, 2)}\n`;
    if (args.check) {
      if (!existsSync(queuePath)) {
        console.error("flywheel-run --check requires existing queue.json");
        process.exitCode = 1;
        return;
      }
      if (readFileSync(queuePath, "utf8") !== queueText) {
        console.error("flywheel-run queue drift vs existing queue.json");
        process.exitCode = 1;
        if (args.json) process.stdout.write(queueText);
        return;
      }
    } else {
      mkdirSync(args.emit, { recursive: true });
      const cardsDir = join(args.emit, "cards");
      mkdirSync(cardsDir, { recursive: true });
      for (const name of readdirSync(cardsDir)) {
        if (name.endsWith(".md")) unlinkSync(join(cardsDir, name));
      }
      writeFileSync(queuePath, queueText);
      writeFileSync(
        join(args.emit, "cards.jsonl"),
        `${queue.cards.map((c) => JSON.stringify(c)).join("\n")}${queue.cards.length ? "\n" : ""}`,
      );
      writeFileSync(join(args.emit, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      for (const card of queue.cards) {
        const safe = card.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
        writeFileSync(
          join(cardsDir, `${String(card.rank).padStart(2, "0")}-${safe}.md`),
          renderCardMarkdown(card),
        );
      }
    }
  }

  if (args.updateLedger) {
    writeFileSync(args.ledger, `${JSON.stringify(nextLedger, null, 2)}\n`);
  }

  if (args.writeLessons && lessons.length) {
    const applied = applyLessonsToFile(args.lessons, queue.cards, {
      date: String(args.generatedAt).slice(0, 10),
      dryRun: false,
    });
    console.error(
      `lessons appended=${applied.appended.join(",") || "—"} skipped=${applied.skipped.join(",") || "—"}`,
    );
  } else if (lessons.length) {
    const plan = planLessonFileUpdate(null, lessons, {
      date: String(args.generatedAt).slice(0, 10),
    });
    console.error(`lessons pending (pass --write-lessons): ${plan.appended.join(", ")}`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(queue, null, 2)}\n`);
  } else {
    console.log(
      `multi-flywheel emitted=${queue.stats.card_count} raw=${result.raw_card_count} skipped=${queue.stats.skipped} hash=${queue.content_hash}${args.emit ? ` out=${args.emit}` : ""}`,
    );
    for (const card of queue.cards.slice(0, 8)) {
      console.log(`  #${card.rank} [${card.dimension}] ${card.id}`);
    }
    if (queue.cards.length > 8) console.log(`  … ${queue.cards.length - 8} more`);
  }
}

main();
