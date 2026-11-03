/**
 * Production-scale memory regression for the 08:00 scheduled meeting refresh.
 *
 * The earlier scheduled-memory test replaced refreshMeetingOutcomes with one
 * fixed-size allocation. This test instead runs the real refresh through the
 * scheduled handler. Its fixture uses the production bounds owned by the
 * Legistar client: four 200-event pages, sixty upcoming EventItems targets,
 * and publisher-shaped item rows. The child process uses the Worker's 128 MiB
 * memory ceiling as its V8 old-space ceiling, so retaining every raw upcoming
 * EventItems response causes the pre-fix process to terminate before KV publish.
 *
 * verify: node --test worker/test/meeting_outcomes_scheduled_memory.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { refreshMeetingOutcomes } from "../src/lib/meeting_outcomes.mjs";
import { withWorkerAcquisitionReceipt } from "../src/lib/worker_acquisition_runtime.mjs";

const CHILD_FLAG = "CITYSCROLL_MEETING_MEMORY_CHILD";
const WORKER_MEMORY_MIB = 128;
const SOURCE = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
const SCHEDULED_AT = new Date("2026-10-31T08:00:00.000Z").getTime();
const EVENT_PAGE_SIZE = 200;
const EVENT_PAGES = 4;
const UPCOMING_EVENT_COUNT = 60;
const ITEMS_PER_UPCOMING_EVENT = 300;
const NOTICE_COUNT = 500;
const TEXT_BYTES_PER_ITEM = 2_048;
const PRODUCTION_EVENT_COUNT = 390;
const PRODUCTION_NOTICE_COUNT = 310;
const PRODUCTION_ITEMS_PER_UPCOMING_EVENT = 20;
const BINARY_ATTACHMENT_EVENT_COUNT = 12;
const BINARY_ATTACHMENT_BYTES = 24 * 1024;
const BINARY_ATTACHMENTS_PER_ITEM = 12;
const OLD_GENERATED_AT = "2026-10-23T09:36:10.172Z";

function textFor(index) {
  return `${String(index).padStart(6, "0")}:${"meeting agenda outcome ".repeat(96)}`
    .slice(0, TEXT_BYTES_PER_ITEM);
}

function eventRow(index) {
  const upcoming = index < UPCOMING_EVENT_COUNT;
  const day = String(1 + (index % 28)).padStart(2, "0");
  return {
    EventId: 50_000 + index,
    EventGuid: `event-guid-${index}`,
    EventBodyId: 1 + (index % 50),
    EventBodyName: `Committee ${index}`,
    EventDate: upcoming ? `2026-11-${day}T00:00:00` : `2026-08-${day}T00:00:00`,
    EventTime: "10:00 AM",
    EventLocation: "250 Broadway, New York, NY 10007",
    EventInSiteURL: `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${50_000 + index}`,
    EventAgendaStatusName: "Final",
    EventLastModifiedUtc: "2026-10-30T12:00:00.000",
  };
}

function eventItemRows(eventId) {
  return Array.from({ length: ITEMS_PER_UPCOMING_EVENT }, (_, index) => {
    const itemId = eventId * 1_000 + index;
    const text = textFor(itemId);
    return {
      EventItemId: itemId,
      EventItemEventId: eventId,
      EventItemAgendaNumber: String(index + 1),
      EventItemTitle: text,
      EventItemRollCallFlag: 0,
      EventItemMatterId: itemId,
      EventItemMatterFile: `Int ${itemId}`,
      EventItemMatterName: text,
      EventItemMatterType: "Introduction",
      EventItemMatterStatus: "Committee",
      EventItemAgendaNote: text,
      EventItemActionText: text,
      EventItemActionName: null,
      EventItemPassedFlagName: null,
    };
  });
}

function noticeRows() {
  return Array.from({ length: NOTICE_COUNT }, (_, index) => ({
    request_id: `20261031${String(index).padStart(3, "0")}`,
    start_date: "2026-10-30T00:00:00.000",
    agency_name: "Test Agency",
    type_of_notice_description: "Public Hearing",
    section_name: "Public Hearings and Meetings",
    short_title: `Unmatched public hearing ${index}`,
    event_date: "2026-10-30T00:00:00.000",
    additional_description_1: "Production-shaped City Record meeting notice.",
  }));
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch() {
  const events = Array.from({ length: EVENT_PAGE_SIZE * EVENT_PAGES }, (_, index) => eventRow(index));
  return async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "data.cityofnewyork.us") return jsonResponse(noticeRows());
    if (/\/Events$/.test(url.pathname)) {
      const skip = Number(url.searchParams.get("$skip") || 0);
      return jsonResponse(events.slice(skip, skip + EVENT_PAGE_SIZE));
    }
    const itemMatch = /\/Events\/(\d+)\/EventItems$/.exec(url.pathname);
    if (itemMatch) {
      const top = Number(url.searchParams.get("$top") || 500);
      return jsonResponse(eventItemRows(Number(itemMatch[1])).slice(0, top));
    }
    if (/\/EventItems\/\d+\/(?:Votes|Attachments)$/.test(url.pathname)) return jsonResponse([]);
    throw new Error(`unexpected fixture request ${url.pathname}`);
  };
}

function scheduledWorker(fetchImpl, env) {
  const pending = [];
  const context = {
    Date,
    AbortController,
    AbortSignal,
    Response,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
  };
  for (const match of SOURCE.matchAll(/import\s+\{([^}]+)\}\s+from\s+"[^"]+";/g)) {
    for (const entry of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      const name = entry.split(/\s+as\s+/).at(-1);
      context[name] = async (...args) => {
        if (name === "refreshMeetingOutcomes") {
          return refreshMeetingOutcomes(args[0], args[1], new Date(SCHEDULED_AT));
        }
        if (name === "withWorkerAcquisitionReceipt") return withWorkerAcquisitionReceipt(...args);
        if (name === "startMorningZapOutcomes") return {};
        return {};
      };
    }
  }
  vm.runInNewContext(
    SOURCE.replace(/^import[\s\S]*?;\s*/gm, "").replace("export default", "globalThis.worker ="),
    context,
  );
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return {
    async run(cron = "0 8 * * *") {
      await context.worker.runScheduled({ cron, scheduledTime: SCHEDULED_AT }, env, ctx);
      await Promise.all(pending);
    },
  };
}

function productionShapedFixture({ embeddedAttachments = false, observeHeap = () => {} } = {}) {
  const events = Array.from({ length: PRODUCTION_EVENT_COUNT }, (_, index) => eventRow(index));
  const notices = noticeRows().slice(0, PRODUCTION_NOTICE_COUNT);
  let attachmentRequests = 0;
  let eventItemRequests = 0;
  let eventItemRequestsWithAttachments = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "data.cityofnewyork.us") return jsonResponse(notices);
    if (/\/Events$/.test(url.pathname)) {
      const skip = Number(url.searchParams.get("$skip") || 0);
      return jsonResponse(events.slice(skip, skip + EVENT_PAGE_SIZE));
    }
    const itemMatch = /\/Events\/(\d+)\/EventItems$/.exec(url.pathname);
    if (itemMatch) {
      eventItemRequests += 1;
      if (url.searchParams.get("Attachments") === "1") eventItemRequestsWithAttachments += 1;
      const eventId = Number(itemMatch[1]);
      let rows = eventItemRows(eventId).slice(0, PRODUCTION_ITEMS_PER_UPCOMING_EVENT);
      // Attachments are absent by default, matching the documented request
      // default. The opt-in branch is a defensive publisher-shape stress case.
      if (embeddedAttachments && eventId < 50_000 + BINARY_ATTACHMENT_EVENT_COUNT) {
        const binary = "A".repeat(BINARY_ATTACHMENT_BYTES);
        rows = rows.map((row, itemIndex) => ({
          ...row,
          EventItemMatterAttachments: Array.from(
            { length: BINARY_ATTACHMENTS_PER_ITEM },
            (_, attachmentIndex) => ({
              MatterAttachmentId: eventId * 100_000 + itemIndex * 100 + attachmentIndex,
              MatterAttachmentName: `Attachment ${attachmentIndex}`,
              MatterAttachmentHyperlink: `https://example.com/${eventId}/${itemIndex}/${attachmentIndex}.pdf`,
              MatterAttachmentIsSupportingDocument: true,
              MatterAttachmentBinary: binary,
            }),
          ),
        }));
      }
      const response = jsonResponse(rows);
      observeHeap();
      return response;
    }
    if (/\/EventItems\/\d+\/Votes$/.test(url.pathname)) return jsonResponse([]);
    if (/\/EventItems\/\d+\/Attachments$/.test(url.pathname)) {
      attachmentRequests += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal.reason || new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return new Response(null, { status: 404 });
    }
    throw new Error(`unexpected fixture request ${url.pathname}`);
  };
  return {
    fetchImpl,
    get attachmentRequests() { return attachmentRequests; },
    get eventItemRequests() { return eventItemRequests; },
    get eventItemRequestsWithAttachments() { return eventItemRequestsWithAttachments; },
  };
}

function productionShapedPriorState() {
  const oldSnapshot = JSON.stringify({
    schema_version: 4,
    generated_at: OLD_GENERATED_AT,
    counts: { records: PRODUCTION_NOTICE_COUNT, event_rows: PRODUCTION_EVENT_COUNT },
    records: [],
  });
  const values = new Map([["meeting-outcomes:materialized:v2", oldSnapshot]]);
  for (let day = 0; day < 11; day += 1) {
    const observedAt = new Date(Date.parse("2026-10-24T13:00:00.000Z") + day * 86_400_000).toISOString();
    const runId = `scheduled-13:${observedAt}`;
    values.set(`source-health:acquisition:nyc-council-legistar:${runId}`, JSON.stringify({
      schema: "cityscroll.source_acquisition_receipt.v1",
      source_contract_id: "nyc-council-legistar",
      observed_at: observedAt,
      status: "failed",
      run_id: runId,
      publisher_clock_basis: null,
      publisher_updated_at: null,
      adapter: "worker-scheduled-refresh",
      exact_error: "scheduled refresh failed before publication",
    }));
  }
  return {
    values,
    binding: {
      async get(key) { return values.get(key) || null; },
      async put(key, value) { values.set(key, value); },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
          list_complete: true,
        };
      },
    },
  };
}

async function runChild() {
  globalThis.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peakHeap = baseline;
  const sampler = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 1);
  sampler.unref();

  const writes = [];
  const env = {
    LEGISTAR_API_TOKEN: "fixture-token",
    LEGISTAR_SOURCE_RECORD_DUAL_WRITE: "false",
    ALERT_STATE: {
      async put(key, value) {
        const numericField = (name) => Number(new RegExp(`"${name}":(\\d+)`).exec(value)?.[1]);
        writes.push({
          key,
          bytes: Buffer.byteLength(value),
          agenda_bound: key === "upcoming-council-meetings:materialized:v1"
            ? {
                configured: numericField("agenda_items_per_event_max"),
                truncated_events: numericField("events_items_truncated"),
                published_items: numericField("agenda_items"),
                observed_items: numericField("agenda_items_observed"),
              }
            : null,
        });
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      },
    },
  };
  await scheduledWorker(fixtureFetch(), env).run();
  clearInterval(sampler);
  globalThis.gc?.();
  const result = {
    baseline_mib: baseline / 1024 / 1024,
    peak_heap_mib: peakHeap / 1024 / 1024,
    retained_heap_mib: process.memoryUsage().heapUsed / 1024 / 1024,
    writes,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runEmbeddedAttachmentChild() {
  globalThis.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peakHeap = baseline;
  const observeHeap = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  const sampler = setInterval(observeHeap, 1);
  sampler.unref();

  const runs = [];
  for (const cron of ["0 8 * * *", "0 13 * * *"]) {
    const fixture = productionShapedFixture({ embeddedAttachments: true, observeHeap });
    const prior = productionShapedPriorState();
    const env = {
      LEGISTAR_API_TOKEN: "fixture-token",
      LEGISTAR_SOURCE_RECORD_DUAL_WRITE: "false",
      SCHEDULED_STEP_DEADLINE_MS: "10000",
      ALERT_STATE: prior.binding,
    };
    await scheduledWorker(fixture.fetchImpl, env).run(cron);
    observeHeap();
    const published = JSON.parse(prior.values.get("meeting-outcomes:materialized:v2"));
    runs.push({
      cron,
      published: published.generated_at !== OLD_GENERATED_AT,
      invalid_attachment_requests: fixture.attachmentRequests,
      attachment_flag_requests: fixture.eventItemRequestsWithAttachments,
      event_item_requests: fixture.eventItemRequests,
    });
  }

  clearInterval(sampler);
  globalThis.gc?.();
  process.stdout.write(`${JSON.stringify({
    baseline_mib: baseline / 1024 / 1024,
    peak_heap_mib: peakHeap / 1024 / 1024,
    retained_heap_mib: process.memoryUsage().heapUsed / 1024 / 1024,
    runs,
  })}\n`);
}

if (process.env[CHILD_FLAG] === "1") {
  await runChild();
} else if (process.env[CHILD_FLAG] === "attachments") {
  await runEmbeddedAttachmentChild();
} else {
  test("08:00 scheduled meeting refresh stays within the Worker memory limit", () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${WORKER_MEMORY_MIB}`,
      "--expose-gc",
      new URL(import.meta.url).pathname,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, [CHILD_FLAG]: "1" },
    });
    assert.equal(
      result.status,
      0,
      `scheduled refresh exceeded ${WORKER_MEMORY_MIB} MiB (status=${result.status})\n${result.stderr}`,
    );
    const measurement = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.ok(measurement.writes.some((write) => write.key === "meeting-outcomes:materialized:v2"));
    assert.deepEqual(
      measurement.writes.find((write) => write.key === "upcoming-council-meetings:materialized:v1")
        ?.agenda_bound,
      { configured: 20, truncated_events: 60, published_items: 1_200, observed_items: 1_200 },
    );
    assert.ok(
      measurement.peak_heap_mib < WORKER_MEMORY_MIB,
      `scheduled refresh peak ${measurement.peak_heap_mib.toFixed(1)} MiB exceeds ${WORKER_MEMORY_MIB} MiB`,
    );
  });

  for (const cron of ["0 8 * * *", "0 13 * * *"]) {
    test(`${cron} publishes before the deadline without unsupported attachment probes`, async () => {
      const fixture = productionShapedFixture();
      const prior = productionShapedPriorState();
      const env = {
        LEGISTAR_API_TOKEN: "fixture-token",
        LEGISTAR_SOURCE_RECORD_DUAL_WRITE: "false",
        SCHEDULED_STEP_DEADLINE_MS: "750",
        ALERT_STATE: prior.binding,
      };

      await scheduledWorker(fixture.fetchImpl, env).run(cron);

      const published = JSON.parse(prior.values.get("meeting-outcomes:materialized:v2"));
      assert.notEqual(published.generated_at, OLD_GENERATED_AT);
      assert.equal(published.counts.event_rows, PRODUCTION_EVENT_COUNT);
      assert.equal(fixture.attachmentRequests, 0);
      assert.ok(fixture.eventItemRequests > 0);
      assert.equal(fixture.eventItemRequestsWithAttachments, 0);
    });
  }

  test("embedded attachment binaries are bounded under both scheduled paths", () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${WORKER_MEMORY_MIB}`,
      "--expose-gc",
      new URL(import.meta.url).pathname,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, [CHILD_FLAG]: "attachments" },
    });
    assert.equal(
      result.status,
      0,
      `embedded attachment refresh exceeded ${WORKER_MEMORY_MIB} MiB (status=${result.status})\n${result.stderr}`,
    );
    const measurement = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.ok(measurement.runs.every((run) => run.published));
    assert.ok(measurement.runs.every((run) => run.invalid_attachment_requests === 0));
    assert.ok(measurement.runs.every((run) => run.attachment_flag_requests === 0));
    assert.ok(measurement.runs.every((run) => run.event_item_requests > 0));
    assert.ok(
      measurement.peak_heap_mib < WORKER_MEMORY_MIB,
      `embedded attachment peak ${measurement.peak_heap_mib.toFixed(1)} MiB exceeds ${WORKER_MEMORY_MIB} MiB`,
    );
  });
}
