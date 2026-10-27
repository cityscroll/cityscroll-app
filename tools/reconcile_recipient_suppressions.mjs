#!/usr/bin/env node

/**
 * Reconcile the mail provider's recipient suppression export into the D1
 * recipient_suppressions authority (worker/migrations/0036), with an
 * idempotent dry-run/apply receipt.
 *
 * This tool never contacts the provider: the suppression export is produced
 * out of band and passed in as a fixture file. Apply mode writes only to the
 * local/provisioned sqlite database named by --db.
 *
 * Usage:
 *   node tools/reconcile_recipient_suppressions.mjs --input export.json --db path.sqlite
 *   node tools/reconcile_recipient_suppressions.mjs --input export.json --db path.sqlite --apply
 *
 * Fixture format:
 *   { "authority": "<provider snapshot token or ISO timestamp>",
 *     "pages": [ { "entries": [ { "email": "...", "reason": "...", "suppressed_at": "..." } ] } ] }
 * A flat { "authority": ..., "entries": [...] } is accepted as a single page.
 *
 * The receipt prints to stdout and carries counts only — never addresses.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { reconcileRecipientSuppressions } from "../worker/src/lib/recipient_suppression.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = path.join(ROOT, "worker", "migrations", "0036_recipient_delivery_trust.sql");

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            async first() { return statement.get(...params) || null; },
            async all() { return { results: statement.all(...params) }; },
          };
        },
      };
    },
  };
}

async function* fixturePages(fixture) {
  if (Array.isArray(fixture.pages)) {
    for (const page of fixture.pages) yield { entries: Array.isArray(page?.entries) ? page.entries : [] };
  } else {
    yield { entries: Array.isArray(fixture.entries) ? fixture.entries : [] };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.db) {
    console.log("usage: reconcile_recipient_suppressions.mjs --input export.json --db path.sqlite [--apply]");
    process.exit(args.help ? 0 : 2);
  }
  const fixture = JSON.parse(readFileSync(args.input, "utf8"));
  const sqlite = new DatabaseSync(args.db);
  sqlite.exec(readFileSync(MIGRATION, "utf8"));
  const receipt = await reconcileRecipientSuppressions(d1FromSqlite(sqlite), fixturePages(fixture), {
    mode: args.apply ? "apply" : "dry-run",
    authority: fixture.authority,
  });
  console.log(JSON.stringify(receipt, null, 2));
  sqlite.close();
  if (receipt.status !== "ok") process.exit(1);
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
