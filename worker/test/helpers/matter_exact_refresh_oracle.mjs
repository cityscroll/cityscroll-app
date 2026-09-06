import { readFileSync } from "node:fs";

import { LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG } from "../../src/lib/legistar_source_records.mjs";

export const SNAPSHOT = JSON.parse(
  readFileSync(new URL("../../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"),
);

export const BASELINE = Object.freeze([
  { matter_id: "79163", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "P-C Item Laid Over by Comm", later_action: "P-C Item Approved by Subcommittee with Companion Resolution" },
  { matter_id: "79164", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "P-C Item Laid Over by Comm", later_action: "P-C Item Approved by Subcommittee with Companion Resolution" },
  { matter_id: "79062", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "79063", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "79064", early_event: "22567", early_notice: "20260625040", later_event: "22526", later_notice: "20260706036", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78605", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78606", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78682", early_event: "22342", early_notice: "20260408025", later_event: "22375", later_notice: "20260428021", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78409", early_event: "22300", early_notice: "20260304007", later_event: "22365", later_notice: "20260331028", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
  { matter_id: "78411", early_event: "22300", early_notice: "20260304007", later_event: "22365", later_notice: "20260331028", early_action: "Laid Over by Subcommittee", later_action: "Approved by Subcommittee" },
]);

export const START = new Date("2026-08-10T13:08:13.019Z");

export function fixtureItemId(eventId, matterId) {
  return Number(`${eventId}${String(matterId).slice(-3)}`);
}

function matterFromNotice(noticeId, matterId) {
  const record = SNAPSHOT.by_notice[noticeId];
  return (record?.matters || []).find((row) => String(row.matter_id) === String(matterId)) || null;
}

export function earlyOnlySnapshot() {
  const by_notice = {};
  for (const row of BASELINE) {
    const source = SNAPSHOT.by_notice[row.early_notice];
    if (!source) continue;
    const existing = by_notice[row.early_notice];
    const matter = (source.matters || []).find((item) => String(item.matter_id) === row.matter_id);
    if (!matter) continue;
    if (!existing) {
      by_notice[row.early_notice] = { ...source, matters: [matter] };
    } else if (!existing.matters.some((item) => String(item.matter_id) === row.matter_id)) {
      existing.matters.push(matter);
    }
  }
  return {
    schema: SNAPSHOT.schema,
    generated_at: SNAPSHOT.generated_at,
    by_notice,
  };
}

export function eventItemFor(row, which) {
  const eventId = which === "later" ? row.later_event : which === "extra" ? row.extra_event : row.early_event;
  const noticeId = which === "later" ? row.later_notice : row.early_notice;
  const action = which === "later" ? row.later_action : which === "extra" ? row.extra_action : row.early_action;
  const matter = matterFromNotice(noticeId, row.matter_id) || { title: row.matter_id };
  return {
    EventItemId: row.extra_item_id || fixtureItemId(eventId, row.matter_id),
    EventItemEventId: Number(eventId),
    EventItemMatterId: Number(row.matter_id),
    EventItemActionName: action,
    EventItemMatterName: matter.title,
    EventItemMatterUrl: matter.matter_url || `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${row.matter_id}`,
  };
}

export function eventFor(eventId, date) {
  return { EventId: Number(eventId), EventDate: date };
}

const EVENT_DATES = {
  22567: "2026-07-09T00:00:00Z",
  22526: "2026-07-14T00:00:00Z",
  22342: "2026-04-22T00:00:00Z",
  22375: "2026-05-19T00:00:00Z",
  22300: "2026-03-18T00:00:00Z",
  22365: "2026-04-14T00:00:00Z",
};

export function defaultCatalog(extra = []) {
  const itemsByMatter = new Map();
  const events = new Map();
  const historiesByMatter = new Map();
  for (const row of [...BASELINE, ...extra]) {
    const early = eventItemFor(row, "early");
    const later = eventItemFor(row, "later");
    const list = [early, later];
    if (row.extra_event) list.push(eventItemFor(row, "extra"));
    itemsByMatter.set(row.matter_id, list);
    events.set(String(row.early_event), eventFor(row.early_event, EVENT_DATES[row.early_event]));
    events.set(String(row.later_event), eventFor(row.later_event, EVENT_DATES[row.later_event]));
    if (row.extra_event) {
      events.set(String(row.extra_event), eventFor(row.extra_event, row.extra_date));
    }
    historiesByMatter.set(row.matter_id, list.map((item, index) => ({
      MatterHistoryId: Number(`${item.EventItemEventId}${index + 1}`),
      MatterHistoryEventId: item.EventItemEventId,
      MatterHistoryActionName: item.EventItemActionName,
      MatterHistoryActionDate: events.get(String(item.EventItemEventId))?.EventDate,
    })));
  }
  return { itemsByMatter, events, historiesByMatter, votesByItem: new Map() };
}

function pathnameOf(url) {
  return new URL(url).pathname.replace(/\/$/, "");
}

function search(url) {
  return new URL(url).searchParams;
}

export function createPublisherFetch(catalog, script = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    parsed.searchParams.delete("token");
    requests.push({
      path: parsed.pathname,
      skip: parsed.searchParams.get("$skip"),
      top: parsed.searchParams.get("$top"),
      filter: parsed.searchParams.get("$filter"),
    });
    if (/webapi\.legistar\.com/i.test(url) === false) {
      throw new Error(`test fetch left the publisher allowlist: ${parsed.pathname}`);
    }
    const path = pathnameOf(url);
    const skip = Number(search(url).get("$skip") || 0);
    const top = Number(search(url).get("$top") || 100);
    const page = skip > 0 && skip >= top ? 2 : 1;

    if (script.timeout) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (script.status === 403) return new Response("forbidden", { status: 403 });
    if (script.status === 429) {
      return new Response("slow down", { status: 429, headers: { "Retry-After": String(script.retryAfter || 120) } });
    }
    if (script.malformed && path.includes("EventItems")) {
      return new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (script.pageTwoFailure && page === 2) {
      return new Response("page-two", { status: 500 });
    }

    const matterMatch = /\/v1\/nyc\/Matters\/(\d+)\/Histories$/i.exec(path);
    if (matterMatch) {
      const rows = catalog.historiesByMatter.get(matterMatch[1]) || [];
      const slice = script.reorder ? [...rows].reverse().slice(skip, skip + top) : rows.slice(skip, skip + top);
      const payload = script.repeat && slice[0] ? [...slice, slice[0]] : slice;
      return Response.json(payload);
    }

    if (/\/v1\/nyc\/EventItems$/i.test(path)) {
      const filter = search(url).get("$filter") || "";
      const matterId = /EventItemMatterId eq (\d+)/.exec(filter)?.[1];
      const rows = catalog.itemsByMatter.get(matterId) || [];
      const ordered = script.reorder ? [...rows].reverse() : rows;
      const slice = ordered.slice(skip, skip + top);
      const payload = script.repeat && slice[0] ? [...slice, slice[0]] : slice;
      return Response.json(payload);
    }

    const eventMatch = /\/v1\/nyc\/Events\/(\d+)$/i.exec(path);
    if (eventMatch) {
      const row = catalog.events.get(eventMatch[1]);
      if (!row) return new Response("missing", { status: 404 });
      return Response.json(row);
    }

    const nestedItems = /\/v1\/nyc\/Events\/(\d+)\/EventItems$/i.exec(path);
    if (nestedItems) {
      const eventId = nestedItems[1];
      const rows = [...catalog.itemsByMatter.values()].flat().filter((row) => String(row.EventItemEventId) === eventId);
      return Response.json(rows);
    }

    const votes = /\/v1\/nyc\/EventItems\/(\d+)\/Votes$/i.exec(path);
    if (votes) {
      return Response.json(catalog.votesByItem.get(votes[1]) || []);
    }

    throw new Error(`unexpected publisher path ${path}`);
  };
  return { fetchImpl, requests };
}

export function retentionEnv(DB, extras = {}) {
  return {
    DB,
    [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true",
    LEGISTAR_API_TOKEN: "test-token-not-a-secret",
    ...extras,
  };
}
