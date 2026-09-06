#!/usr/bin/env node
/**
 * Render the real `/matters/:id/` responses for history-population evidence.
 *
 * The pages are produced by the same Pages-edge handler production serves,
 * reading the committed published generation, so a capture drives the bytes a
 * reader receives rather than a rebuilt approximation. The not-found body for
 * an identity the generation does not publish is rendered the same way.
 *
 * Prints JSON; tools/capture_legislative_matter_history_evidence.py writes the
 * pages to an ignored local directory and drives them in a real engine.
 *
 *   node tools/render_legislative_matter_history_fixtures.mjs
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import edgeWorker from "../site/pages_edge.mjs";

const lookup = JSON.parse(readFileSync(new URL("../site/data/legislative_matter_lookup.json", import.meta.url), "utf8"));

const env = {
  ASSETS: {
    async fetch(request) {
      return new URL(request.url).pathname === "/data/legislative_matter_lookup.json"
        ? Response.json(lookup)
        : new Response("missing", { status: 404 });
    },
  },
};

/**
 * One specimen per state a reader can meet on a matter history. The first three
 * are retained matters; the last is an identity the generation does not carry,
 * which is a stated absence rather than an empty history.
 */
export const HISTORY_FIXTURES = Object.freeze({
  "single-appearance-history": { matter_id: "79200", basis: "retained" },
  "two-appearance-history": { matter_id: "78605", basis: "retained" },
  "coalesced-notice-references": { matter_id: "78758", basis: "retained" },
  "unpublished-identity": { matter_id: "909090", basis: "constructed_boundary" },
});

export async function renderHistoryFixtures() {
  const fixtures = {};
  for (const [name, spec] of Object.entries(HISTORY_FIXTURES)) {
    const route = `/matters/${spec.matter_id}/`;
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org${route}`), env);
    fixtures[name] = {
      matter_id: spec.matter_id,
      basis: spec.basis,
      route,
      status: response.status,
      html: await response.text(),
    };
  }
  return { data_vintage: lookup.generated_at, published_matter_count: Object.keys(lookup.matters).length, fixtures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await renderHistoryFixtures(), null, 2)}\n`);
}
