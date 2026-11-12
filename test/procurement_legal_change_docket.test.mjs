// Tests for the change docket and the source watch. node:test + built-ins only.
// The modules read the engine register (ontology/procurement_legal_register.v1.json)
// and the source fixtures committed by the legal-register slice under
// test/fixtures/procurement_legal_register/sources. Nothing here touches the
// network: every fetch is an injected stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateChangeDocket, docketDue, docketAwaitingEvents, docketForRegisterEntry, DOCKET_CLOCK_NAMES,
} from "../ontology/procurement_legal_docket.mjs";
import { sha256Hex } from "../ontology/procurement_legal_register.mjs";
import { compareSourceCaptures, LEGAL_SOURCE_WATCH_RECEIPT_SCHEMA } from "../ontology/procurement_legal_source_watch.mjs";
import {
  runSourceWatch, main as cliMain, exitCodeFor, extractSection, EXIT, HOST_ALLOWLIST,
} from "../tools/check_procurement_legal_sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const register = JSON.parse(readFileSync(join(ROOT, "ontology/procurement_legal_register.v1.json"), "utf8"));
const docket = JSON.parse(readFileSync(join(ROOT, "ontology/procurement_legal_change_docket.v1.json"), "utf8"));
const targets = JSON.parse(readFileSync(join(ROOT, "ontology/procurement_legal_source_targets.v1.json"), "utf8"));
const SOURCES = join(ROOT, "test/fixtures/procurement_legal_register/sources");
const clone = (value) => structuredClone(value);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const retained = (file) => readFileSync(join(SOURCES, file), "utf8");
const allObserved = (overrides = {}) => Object.keys(register.sources.files).map((file) => ({
  source_file: file, fetched: true, status: 200, text: overrides[file] ?? retained(file),
}));

/* ---------------------------------------------------------------- (i) seed validates */

test("(i) the seed docket validates against the sibling register", () => {
  assert.equal(validateChangeDocket(docket, { register }), true);
  assert.equal(docket.schema, "cityscroll.procurement_legal_change_docket.v1");
  const ids = docket.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of docket.entries) {
    assert.deepEqual(Object.keys(entry.clocks), DOCKET_CLOCK_NAMES, `${entry.id} carries exactly the four clocks`);
  }
  // every statement of a reached clock or a date is backed by evidence the seed actually retrieved
  for (const entry of docket.entries) {
    for (const [name, clock] of Object.entries(entry.clocks)) {
      if (clock.state === "reached" || clock.date) assert.ok(clock.evidence.length > 0, `${entry.id} ${name}`);
    }
  }
  const byId = Object.fromEntries(docket.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId["nyc.charter.2026-q2.certification-effective"].status, "passed_uncertified");
  assert.equal(byId["nyc.ppb.2025-hhs-accelerator-rule"].status, "proposed");
  assert.deepEqual(byId["nyc.ppb.2025-hhs-accelerator-rule"].affects, ["nyc.ppb.3-16.a.client_services_through_hhs_accelerator"]);
  assert.equal(byId["nys.executive-law.2025-s267.mwbe-certification-reciprocity"].status, "pending_signature");
  assert.deepEqual(byId["nys.executive-law.2025-s267.mwbe-certification-reciprocity"].affects, []);
  for (const n of ["040", "055", "067", "070"]) assert.equal(byId[`nyc.admin-code.2026-ll${n}`].status, "in_force_unmodelled");
  // Question 2 does not amend 6-129: no Question 2 entry points at a 6-129 register entry
  for (const entry of docket.entries.filter((item) => item.id.startsWith("nyc.charter.2026-q2"))) {
    assert.ok(!entry.affects.some((id) => id.includes("6-129")), entry.id);
    assert.ok(!JSON.stringify(entry.clocks).includes("6-129"));
  }
  assert.deepEqual(docketForRegisterEntry(docket, "nyc.ppb.3-16.a.client_services_through_hhs_accelerator").map((e) => e.id), ["nyc.ppb.2025-hhs-accelerator-rule"]);
  assert.deepEqual(docketForRegisterEntry(docket, "nyc.charter.311.i.1.mwbe_small_purchase_ceiling.from_2023_12_08"), []);
});

/* ---------------------------------------------------------------- (ii) docketDue */

test("(ii) docketDue: 2027-01-01 inside 60 days of 2026-11-11, 2030 not; overdue until reached with evidence", () => {
  const due = docketDue(docket, { today: "2026-11-11", withinDays: 60 });
  assert.deepEqual(due.map((row) => row.id), ["nyc.charter.2026-q2.311a-quarterly-meetings"]);
  assert.equal(due[0].due[0].date, "2027-01-01");
  assert.equal(due[0].due[0].days_until, 51);
  assert.equal(due[0].due[0].overdue, false);
  assert.ok(!due.some((row) => row.id === "nyc.charter.2026-q2.326-comment-process"));

  const wide = docketDue(docket, { today: "2026-11-11", withinDays: 4000 }).map((row) => row.id);
  assert.ok(wide.includes("nyc.charter.2026-q2.326-comment-process"));

  const overdue = docketDue(docket, { today: "2027-01-02", withinDays: 0 });
  assert.deepEqual(overdue.map((row) => row.id), ["nyc.charter.2026-q2.311a-quarterly-meetings"]);
  assert.equal(overdue[0].due[0].overdue, true);
  assert.equal(overdue[0].due[0].days_until, -1);

  // marking the clock reached WITH evidence retires it; the validator forbids reached without
  const reached = clone(docket);
  const entry = reached.entries.find((item) => item.id === "nyc.charter.2026-q2.311a-quarterly-meetings");
  entry.clocks.legal_effect.state = "reached";
  entry.clocks.legal_effect.evidence = [];
  assert.throws(() => validateChangeDocket(reached, { register }), /reached without evidence/);
  entry.clocks.legal_effect.evidence = [{ url: "https://example.test/evidence", retrieved_on: "2027-01-02", quote: "in force" }];
  assert.equal(validateChangeDocket(reached, { register }), true);
  assert.deepEqual(docketDue(reached, { today: "2027-01-02", withinDays: 0 }), []);

  // closed entries never produce rows
  const closed = clone(docket);
  const closedEntry = closed.entries.find((item) => item.id === "nyc.charter.2026-q2.311a-quarterly-meetings");
  closedEntry.status = "withdrawn";
  assert.deepEqual(docketDue(closed, { today: "2026-11-11", withinDays: 60 }), []);
  assert.throws(() => docketDue(docket, { today: "2026-13-01" }), /today/);
});

/* ---------------------------------------------------------------- (iii) awaiting events */

test("(iii) the certification-triggered entry is awaiting an event and has no date", () => {
  const awaiting = docketAwaitingEvents(docket);
  const row = awaiting.find((item) => item.id === "nyc.charter.2026-q2.certification-effective" && item.clock === "legal_effect");
  assert.ok(row);
  assert.equal(row.date, null);
  assert.match(row.event, /Certification/);
  const entry = docket.entries.find((item) => item.id === row.id);
  assert.equal(entry.clocks.legal_effect.trigger, "event");
  assert.equal(entry.clocks.legal_effect.date, null);
  // dated clocks are not "awaiting"
  assert.ok(!awaiting.some((item) => item.id === "nyc.charter.2026-q2.311a-quarterly-meetings" && item.clock === "legal_effect"));
  // the PPB proposal and the bill wait on events too
  assert.ok(awaiting.some((item) => item.id === "nyc.ppb.2025-hhs-accelerator-rule" && item.clock === "legal_effect"));
  assert.ok(awaiting.some((item) => item.id.startsWith("nys.executive-law.2025-s267") && item.clock === "legal_effect"));
});

/* ---------------------------------------------------------------- (iv) source watch */

test("(iv) source watch: retained sources are all unchanged", () => {
  const receipt = compareSourceCaptures(register, allObserved(), { checkedAt: "2026-11-11T12:17:00.000Z" });
  assert.equal(receipt.schema, LEGAL_SOURCE_WATCH_RECEIPT_SCHEMA);
  assert.equal(receipt.sources.length, 7);
  assert.deepEqual(receipt.sources.map((row) => row.status), Array(7).fill("unchanged"));
  assert.deepEqual(receipt.summary, { unchanged: 7, changed: 0, fetch_failed: 0, not_checked: 0 });
  assert.equal(receipt.changes_found, false);
  assert.equal(receipt.could_not_check, false);
  assert.deepEqual(receipt.review_items, []);
  assert.equal(exitCodeFor(receipt), EXIT.CLEAN);
});

test("(iv) source watch: one flipped character inside a quote is changed and names the broken quote", () => {
  const entry = register.entries.find((item) => item.id === "nyc.ppb.3-08.a.small_purchase_limit");
  const text = retained("ppb-3-08.md");
  const at = text.indexOf(entry.authority.quote.slice(0, 60));
  assert.ok(at >= 0);
  const position = at + 20;
  const flipped = `${text.slice(0, position)}${text[position] === "Q" ? "R" : "Q"}${text.slice(position + 1)}`;
  const receipt = compareSourceCaptures(register, allObserved({ "ppb-3-08.md": flipped }));
  const row = receipt.sources.find((item) => item.source_file === "ppb-3-08.md");
  assert.equal(row.status, "changed");
  assert.ok(row.broken_quotes.some((item) => item.entry_id === "nyc.ppb.3-08.a.small_purchase_limit" && item.field === "quote"));
  const threeEight = register.entries.filter((item) => item.authority.source_file === "ppb-3-08.md").map((item) => item.id).sort();
  assert.deepEqual(row.affected_entry_ids, threeEight);
  assert.equal(receipt.summary.changed, 1);
  assert.equal(receipt.summary.unchanged, 6);
  assert.equal(receipt.changes_found, true);
  const item = receipt.review_items.find((value) => value.source_file === "ppb-3-08.md");
  assert.equal(item.kind, "quote_broken");
  assert.ok(item.broken_quote_entry_ids.includes("nyc.ppb.3-08.a.small_purchase_limit"));
  assert.equal(exitCodeFor(receipt), EXIT.CHANGES);
});

test("(iv) source watch: a change outside every quote is changed with no broken quote", () => {
  const text = retained("ppb-3-08.md").replace("**Citation:** § 3-08", "**Citation:** § 3-09");
  assert.notEqual(text, retained("ppb-3-08.md"));
  const receipt = compareSourceCaptures(register, allObserved({ "ppb-3-08.md": text }));
  const row = receipt.sources.find((item) => item.source_file === "ppb-3-08.md");
  assert.equal(row.status, "changed");
  assert.deepEqual(row.broken_quotes, []);
  assert.equal(receipt.review_items[0].kind, "source_changed");
});

test("(iv) source watch: fetch failure is fetch_failed and not unchanged; never-observed is not_checked", () => {
  const observations = allObserved().filter((item) => item.source_file !== "ppb-1-02.md");
  observations.find((item) => item.source_file === "charter-311.md").fetched = false;
  observations.find((item) => item.source_file === "charter-311.md").status = 503;
  observations.find((item) => item.source_file === "charter-311.md").text = undefined;
  observations.find((item) => item.source_file === "ppb-3-04.md").status = 200;
  const receipt = compareSourceCaptures(register, observations);
  const status = Object.fromEntries(receipt.sources.map((row) => [row.source_file, row.status]));
  assert.equal(status["charter-311.md"], "fetch_failed");
  assert.equal(status["ppb-1-02.md"], "not_checked");
  assert.equal(status["ppb-3-04.md"], "unchanged");
  assert.equal(receipt.summary.unchanged, 5);
  assert.equal(receipt.could_not_check, true);
  assert.equal(receipt.changes_found, false);
  assert.equal(exitCodeFor(receipt), EXIT.COULD_NOT_CHECK);
  assert.ok(receipt.review_items.some((item) => item.kind === "fetch_failed" && item.source_file === "charter-311.md"));
  // a 200 with an empty body and a 404 with text are also failures, not silence
  const odd = compareSourceCaptures(register, [
    { source_file: "charter-311.md", fetched: true, status: 200, text: "" },
    { source_file: "ppb-1-01.md", fetched: true, status: 404, text: retained("ppb-1-01.md") },
  ]);
  assert.equal(odd.sources.find((row) => row.source_file === "charter-311.md").status, "fetch_failed");
  assert.equal(odd.sources.find((row) => row.source_file === "ppb-1-01.md").status, "fetch_failed");
  // changed + failed together get the distinct combined exit code
  const both = compareSourceCaptures(register, [
    { source_file: "ppb-3-08.md", fetched: true, status: 200, text: "different" },
  ]);
  assert.equal(exitCodeFor(both), EXIT.BOTH);
});

test("(iv) source watch: CRLF and BOM are the only normalisation, so a real edit is never hidden", () => {
  const crlf = retained("ppb-3-16.md").replace(/\n/g, "\r\n");
  const receipt = compareSourceCaptures(register, allObserved({ "ppb-3-16.md": `﻿${crlf}` }));
  assert.equal(receipt.sources.find((row) => row.source_file === "ppb-3-16.md").status, "unchanged");
  const spaced = compareSourceCaptures(register, allObserved({ "ppb-3-16.md": `${retained("ppb-3-16.md")} ` }));
  assert.equal(spaced.sources.find((row) => row.source_file === "ppb-3-16.md").status, "changed");
});

/* ---------------------------------------------------------------- (v) register untouched */

test("(v) the register is deep-equal before and after every watch and docket call, and tolerates being frozen", () => {
  const before = clone(register);
  const frozen = deepFreeze(clone(register));
  const flipped = retained("ppb-3-08.md").replace("small purchases", "small purchasez");
  for (const observations of [allObserved(), allObserved({ "ppb-3-08.md": flipped }), [], [{ source_file: "ppb-1-01.md", fetched: false, status: null }]]) {
    compareSourceCaptures(frozen, observations);
    compareSourceCaptures(register, observations);
    assert.deepEqual(register, before);
  }
  validateChangeDocket(docket, { register: frozen });
  validateChangeDocket(docket, { register });
  docketDue(docket, { today: "2026-11-11" });
  docketAwaitingEvents(docket);
  docketForRegisterEntry(docket, "x");
  assert.deepEqual(register, before);
  // review statuses are never upgraded or downgraded
  const receipt = compareSourceCaptures(register, allObserved({ "ppb-3-08.md": flipped }));
  assert.equal(receipt.mutates_register, false);
  assert.equal(register.entries.filter((e) => e.review.status === "source_checked").length, 23);
  assert.equal(register.entries.filter((e) => e.review.status === "unreviewed").length, 15);
  assert.ok(!JSON.stringify(receipt).includes('"review_status"'));
});

/* ---------------------------------------------------------------- (vi) CLI with stub fetch */

const REPO = "https://raw.githubusercontent.com/BetaNYC/nyc-charter-laws-rules/main/data/index/";

function section(file) { return retained(file); }
function filler(label, count = 60) {
  return Array.from({ length: count }, (_, i) => `## § ${i + 1}-99 ${label} filler ${i}.\n\n**Citation:** x\n\nfiller body ${"y".repeat(200)}\n\n---\n`).join("\n");
}
/** Build aggregate files whose retained sections sit between filler sections, with real byte offsets. */
function buildAggregates() {
  const make = (head, files) => {
    const parts = [`${head}\n\n---\n`, filler(head, 9000)];
    for (const file of files) parts.push(section(file), filler(`after-${file}`, 3));
    const text = parts.join("\n");
    return text;
  };
  const aggregates = {
    "markdown/admin_code.md": make("# Admin", ["admin-code-6-129.md"]),
    "markdown/charter.md": make("# Charter", ["charter-311.md"]),
    "markdown/rules.md": make("# Rules", ["ppb-1-01.md", "ppb-1-02.md", "ppb-3-04.md", "ppb-3-08.md", "ppb-3-16.md"]),
  };
  const stubTargets = clone(targets);
  for (const target of stubTargets.targets) {
    const buffer = Buffer.from(aggregates[target.aggregate]);
    const at = buffer.indexOf(Buffer.from(`\n${target.heading}\n`));
    assert.ok(at >= 0, target.source_file);
    target.hint_offset = at + 1;
    // a decoy with the same section number under another title must never be picked
    target.expected_bytes = Buffer.byteLength(section(target.source_file));
  }
  return { aggregates: Object.fromEntries(Object.entries(aggregates).map(([k, v]) => [k, Buffer.from(v)])), stubTargets };
}

function makeStub(aggregates, { etag = "e1", behaviour = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", range: init.headers?.Range || null });
    const parsed = new URL(url);
    const key = parsed.pathname.split("/data/index/")[1];
    const hook = behaviour[key] || behaviour["*"];
    if (hook) {
      const override = await hook({ url, init, calls });
      if (override) return override;
    }
    const body = aggregates[key];
    if (!body) return new Response("nope", { status: 404 });
    const headers = { etag: `"${etag}-${key}"`, "content-length": String(body.length) };
    if (init.method === "HEAD") return new Response(null, { status: 200, headers });
    const range = init.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      return new Response(slice, { status: 206, headers: { ...headers, "content-length": String(slice.length), "content-range": `bytes ${start}-${end}/${body.length}` } });
    }
    return new Response(body, { status: 200, headers });
  };
  return { fetchImpl, calls };
}

// Scratch dirs are tracked and removed on exit/SIGTERM/SIGINT so a gate's
// leaked-temp snapshot stays clean (mirrors tools/lib/with_temp_dir.mjs).
const TEMP_DIRS = new Set();
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "cityscroll-docket-watch-")); TEMP_DIRS.add(dir); return dir; };
function cleanupTempDirs() {
  for (const dir of [...TEMP_DIRS]) { try { rmSync(dir, { recursive: true, force: true }); TEMP_DIRS.delete(dir); } catch { /* retry on a later signal */ } }
}
process.on("exit", cleanupTempDirs);
process.on("SIGTERM", () => { cleanupTempDirs(); process.exit(143); });
process.on("SIGINT", () => { cleanupTempDirs(); process.exit(130); });

test("(vi) CLI: clean run uses ranged requests, writes state, and a second run is served from the ETag cache", async () => {
  const { aggregates, stubTargets } = buildAggregates();
  const stub = makeStub(aggregates);
  const stateDir = tempDir();
  const now = new Date("2026-11-12T12:17:00Z");
  const receipt = await runSourceWatch({ register, targets: stubTargets, fetchImpl: stub.fetchImpl, stateDir, now });
  assert.deepEqual(receipt.summary, { unchanged: 7, changed: 0, fetch_failed: 0, not_checked: 0 });
  assert.equal(exitCodeFor(receipt), EXIT.CLEAN);
  assert.ok(Object.values(receipt.acquisition).every((a) => a.method === "range"), JSON.stringify(receipt.acquisition));
  const fetched = stub.calls.filter((c) => c.method === "GET");
  assert.ok(fetched.every((c) => c.range), "no full-file GET on the happy path");
  const total = Object.values(aggregates).reduce((sum, b) => sum + b.length, 0);
  const bytes = Object.values(receipt.acquisition).reduce((sum, a) => sum + a.bytes_fetched, 0);
  assert.ok(bytes < total, `ranged bytes ${bytes} stay below the aggregates ${total}`);
  assert.equal(readFileSync(join(stateDir, "last-good/ppb-3-08.md"), "utf8"), retained("ppb-3-08.md"));
  assert.equal(register.entries.length, 38);

  const second = makeStub(aggregates);
  const again = await runSourceWatch({ register, targets: stubTargets, fetchImpl: second.fetchImpl, stateDir, now });
  assert.equal(again.summary.unchanged, 7);
  assert.ok(Object.values(again.acquisition).every((a) => a.method === "cache" && a.bytes_fetched === 0));
  assert.ok(second.calls.every((c) => c.method === "HEAD"));
});

test("(vi) CLI: wrong offset hints fall back to one capped full stream per aggregate and still find the sections", async () => {
  const { aggregates, stubTargets } = buildAggregates();
  const wrong = clone(stubTargets);
  for (const target of wrong.targets) target.hint_offset = 5;
  const stub = makeStub(aggregates);
  const receipt = await runSourceWatch({ register, targets: wrong, fetchImpl: stub.fetchImpl, stateDir: null, now: new Date() });
  assert.equal(receipt.summary.unchanged, 7);
  assert.ok(Object.values(receipt.acquisition).some((a) => a.method === "full_stream"));
});

test("(vi) CLI: a changed section exits 3, records the change, and leaves last-good at the last matching text", async () => {
  const { aggregates, stubTargets } = buildAggregates();
  const stateDir = tempDir();
  await runSourceWatch({ register, targets: stubTargets, fetchImpl: makeStub(aggregates).fetchImpl, stateDir, now: new Date("2026-11-12T12:17:00Z") });
  const good = readFileSync(join(stateDir, "last-good/ppb-3-08.md"), "utf8");
  const changed = { ...aggregates };
  const text = changed["markdown/rules.md"].toString("utf8").replace("Small Purchases.\n\n**Citation:** § 3-08", "Small Purchases.\n\n**Citation:** § 3-09");
  changed["markdown/rules.md"] = Buffer.from(text);
  const receipt = await runSourceWatch({ register, targets: stubTargets, fetchImpl: makeStub(changed, { etag: "e2" }).fetchImpl, stateDir, now: new Date("2026-11-13T12:17:00Z") });
  assert.equal(receipt.sources.find((row) => row.source_file === "ppb-3-08.md").status, "changed");
  assert.equal(receipt.summary.changed, 1);
  assert.equal(exitCodeFor(receipt), EXIT.CHANGES);
  assert.equal(readFileSync(join(stateDir, "last-good/ppb-3-08.md"), "utf8"), good, "last-good is not overwritten by a non-matching observation");
  assert.match(readFileSync(join(stateDir, "observed/ppb-3-08.md"), "utf8"), /3-09/);
});

test("(vi) CLI: a host that is not on the allowlist is refused, including through a redirect", async () => {
  assert.deepEqual([...HOST_ALLOWLIST], ["raw.githubusercontent.com"]);
  const { aggregates, stubTargets } = buildAggregates();
  const evil = clone(stubTargets);
  evil.mirror.raw_base = "https://evil.example.test/data/index/";
  const stub = makeStub(aggregates);
  const receipt = await runSourceWatch({ register, targets: evil, fetchImpl: stub.fetchImpl, stateDir: null, now: new Date() });
  assert.equal(stub.calls.length, 0, "the refused host is never contacted");
  assert.equal(receipt.summary.fetch_failed, 7);
  assert.ok(receipt.sources.every((row) => /host_not_allowed/.test(row.reason)));
  assert.equal(exitCodeFor(receipt), EXIT.COULD_NOT_CHECK);

  const redirecting = makeStub(aggregates, { behaviour: { "markdown/charter.md": async () => new Response(null, { status: 302, headers: { location: "https://evil.example.test/x" } }) } });
  const viaRedirect = await runSourceWatch({ register, targets: stubTargets, fetchImpl: redirecting.fetchImpl, stateDir: null, now: new Date() });
  assert.match(viaRedirect.sources.find((row) => row.source_file === "charter-311.md").reason, /host_not_allowed/);
  assert.ok(!redirecting.calls.some((c) => c.url.includes("evil.example.test")));
  assert.equal(viaRedirect.summary.unchanged, 6);

  const loop = makeStub(aggregates, { behaviour: { "markdown/charter.md": async () => new Response(null, { status: 302, headers: { location: `${REPO}markdown/charter.md` } }) } });
  const looped = await runSourceWatch({ register, targets: stubTargets, fetchImpl: loop.fetchImpl, stateDir: null, now: new Date() });
  assert.match(looped.sources.find((row) => row.source_file === "charter-311.md").reason, /too_many_redirects/);
});

test("(vi) CLI: an oversize body is refused (declared and streamed) and reported as could-not-check", async () => {
  const { aggregates, stubTargets } = buildAggregates();
  const small = await runSourceWatch({ register, targets: stubTargets, fetchImpl: makeStub(aggregates).fetchImpl, stateDir: null, now: new Date(), limits: { windowMaxBytes: 500, fullMaxBytes: 500 } });
  assert.ok(small.sources.every((row) => row.status === "fetch_failed"));
  assert.ok(small.sources.some((row) => /oversize/.test(row.reason)));
  assert.equal(exitCodeFor(small), EXIT.COULD_NOT_CHECK);
  // no declared length: the stream itself is capped
  const noLength = makeStub(aggregates, { behaviour: { "*": async ({ init }) => (init.method === "HEAD" ? null : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4000)); controller.enqueue(new Uint8Array(4000)); controller.close(); },
  }), { status: 206 })) } });
  const streamed = await runSourceWatch({ register, targets: stubTargets, fetchImpl: noLength.fetchImpl, stateDir: null, now: new Date(), limits: { windowMaxBytes: 1000, fullMaxBytes: 1000 } });
  assert.ok(streamed.sources.some((row) => /oversize/.test(row.reason)));
});

test("(vi) CLI: a timeout is could-not-check with its own exit code, and last-good is left byte-identical", async () => {
  const { aggregates, stubTargets } = buildAggregates();
  const stateDir = tempDir();
  await runSourceWatch({ register, targets: stubTargets, fetchImpl: makeStub(aggregates).fetchImpl, stateDir, now: new Date("2026-11-12T12:17:00Z") });
  const snapshot = (name) => readFileSync(join(stateDir, name), "utf8");
  const before = { good: snapshot("last-good/ppb-3-08.md"), observed: snapshot("observed/ppb-3-08.md"), index: snapshot("index.json") };

  const hanging = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const receipt = await runSourceWatch({ register, targets: stubTargets, fetchImpl: hanging, stateDir, now: new Date("2026-11-13T12:17:00Z"), limits: { timeoutMs: 20, attempts: 1 } });
  assert.ok(receipt.sources.every((row) => row.status === "fetch_failed" && /timeout/.test(row.reason)));
  assert.equal(receipt.summary.unchanged, 0, "a timeout is never counted as unchanged");
  assert.equal(exitCodeFor(receipt), EXIT.COULD_NOT_CHECK);
  assert.notEqual(EXIT.COULD_NOT_CHECK, EXIT.CHANGES);
  assert.deepEqual({ good: snapshot("last-good/ppb-3-08.md"), observed: snapshot("observed/ppb-3-08.md"), index: snapshot("index.json") }, before);

  // a 503 is retried once, then reported
  let attempts = 0;
  const flaky = makeStub(aggregates, { behaviour: { "markdown/charter.md": async () => { attempts += 1; return new Response("x", { status: 503 }); } } });
  const r503 = await runSourceWatch({ register, targets: stubTargets, fetchImpl: flaky.fetchImpl, stateDir: null, now: new Date(), limits: { attempts: 2 } });
  assert.equal(attempts, 2);
  assert.equal(r503.sources.find((row) => row.source_file === "charter-311.md").status, "fetch_failed");
});

test("(vi) CLI main(): exit codes and receipt file", async () => {
  const dir = tempDir();
  const { aggregates, stubTargets } = buildAggregates();
  writeFileSync(join(dir, "register.json"), JSON.stringify(register));
  writeFileSync(join(dir, "targets.json"), JSON.stringify(stubTargets));
  const out = { write() {} };
  const sink = [];
  const stdout = { write: (text) => sink.push(text) };
  const code = await cliMain(["--register", join(dir, "register.json"), "--targets", join(dir, "targets.json"), "--state-dir", join(dir, "state"), "--out", join(dir, "receipt.json")],
    { fetchImpl: makeStub(aggregates).fetchImpl, stdout, stderr: out, now: new Date("2026-11-12T12:17:00Z") });
  assert.equal(code, EXIT.CLEAN);
  assert.equal(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).schema, LEGAL_SOURCE_WATCH_RECEIPT_SCHEMA);
  assert.equal(await cliMain([], { fetchImpl: makeStub(aggregates).fetchImpl, stdout, stderr: out }), EXIT.USAGE);
  assert.equal(await cliMain(["--register", join(dir, "missing.json"), "--targets", join(dir, "targets.json")], { fetchImpl: makeStub(aggregates).fetchImpl, stdout, stderr: out }), EXIT.USAGE);
  assert.deepEqual(new Set([EXIT.CLEAN, EXIT.USAGE, EXIT.CHANGES, EXIT.COULD_NOT_CHECK, EXIT.BOTH]).size, 5);
});

test("(vi) extractSection: duplicate section numbers under other titles are not confused", () => {
  const text = "# R\n\n---\n\n## § 3-08 Other Title.\n\nold\n\n---\n\n## § 3-08 Small Purchases.\n\nbody\n\n---\n\n## § 3-09 Next.\n";
  const found = extractSection(Buffer.from(text), "## § 3-08 Small Purchases.", { atStart: true, atEof: true });
  assert.equal(found.text, "## § 3-08 Small Purchases.\n\nbody\n\n---\n");
  const twice = `${text}\n## § 3-08 Small Purchases.\n\nagain\n`;
  assert.equal(extractSection(Buffer.from(twice), "## § 3-08 Small Purchases.", { atStart: true, atEof: true }).miss, "ambiguous_heading");
  assert.equal(extractSection(Buffer.from("zzz"), "## § 3-08 Small Purchases.", { atStart: false, atEof: false }).miss, "heading_not_in_window");
});

test("(vi) targets cover every register source and the seed offsets name real headings", () => {
  const files = Object.keys(register.sources.files).sort();
  assert.deepEqual(targets.targets.map((t) => t.source_file).sort(), files);
  for (const target of targets.targets) {
    assert.ok(target.heading.startsWith("## "));
    assert.ok(retained(target.source_file).startsWith(`${target.heading}\n`), `${target.source_file} heading is the first line of the retained capture`);
    assert.equal(Buffer.byteLength(retained(target.source_file)), target.expected_bytes);
    assert.equal(sha256Hex(retained(target.source_file)), register.sources.files[target.source_file].sha256);
    assert.equal(target.expected_bytes, register.sources.files[target.source_file].bytes);
    assert.ok(target.aggregate.startsWith("markdown/"));
  }
  assert.ok(targets.mirror.raw_base.startsWith("https://raw.githubusercontent.com/"));
});

/* ---------------------------------------------------------------- optional: the real mirror aggregates */

test("(vi) optional replay: sections cut from real mirror aggregates reproduce the retained captures byte for byte", { skip: !process.env.MIRROR_DIR }, async () => {
  const dir = process.env.MIRROR_DIR;
  const aggregates = {
    "markdown/admin_code.md": readFileSync(join(dir, "admin_code.md")),
    "markdown/charter.md": readFileSync(join(dir, "charter.md")),
    "markdown/rules.md": readFileSync(join(dir, "rules.md")),
  };
  const stub = makeStub(aggregates);
  const receipt = await runSourceWatch({ register, targets, fetchImpl: stub.fetchImpl, stateDir: null, now: new Date() });
  assert.deepEqual(receipt.summary, { unchanged: 7, changed: 0, fetch_failed: 0, not_checked: 0 });
  assert.ok(Object.values(receipt.acquisition).every((a) => a.method === "range"), JSON.stringify(receipt.acquisition));
});

/* ---------------------------------------------------------------- (vii) validator failure controls */

function mutated(fn) {
  const copy = clone(docket);
  fn(copy);
  return copy;
}
const certification = (d) => d.entries.find((e) => e.id === "nyc.charter.2026-q2.certification-effective");

test("(vii) validator failure controls each reject with a specific message", () => {
  const controls = [
    ["missing clock", (d) => { delete certification(d).clocks.agency_rollout; }, /is missing clock agency_rollout/],
    ["extra clock", (d) => { certification(d).clocks.fifth = clone(certification(d).clocks.legal_effect); }, /unknown clock fifth/],
    ["dated event clock without evidence", (d) => { const c = certification(d).clocks.legal_effect; c.date = "2026-12-01"; c.evidence = []; }, /event-triggered with a date but no evidence/],
    ["date clock without a date", (d) => { certification(d).clocks.legal_effect.trigger = "date"; certification(d).clocks.legal_effect.event = null; }, /date-triggered and requires a valid date/],
    ["event clock without an event", (d) => { certification(d).clocks.legal_effect.event = ""; }, /requires an event description/],
    ["reached without evidence", (d) => { const c = certification(d).clocks.cityscroll_display; c.state = "reached"; c.evidence = []; }, /reached without evidence/],
    ["unknown clock state", (d) => { certification(d).clocks.legal_effect.state = "done"; }, /unknown state done/],
    ["evidence without retrieved_on", (d) => { certification(d).clocks.legal_effect.evidence[0].retrieved_on = "yesterday"; }, /requires retrieved_on/],
    ["dangling affects", (d) => { certification(d).affects = ["nyc.ppb.9-99.nope"]; }, /affects nyc\.ppb\.9-99\.nope which is not in the register/],
    ["empty affects without a note", (d) => { delete certification(d).affects_note; }, /requires affects_note/],
    ["adopted_into_register without adopted_as", (d) => { certification(d).status = "adopted_into_register"; }, /adopted_into_register requires adopted_as/],
    ["adopted_as that does not resolve", (d) => { certification(d).status = "adopted_into_register"; certification(d).adopted_as = "nyc.charter.9.nope@1"; }, /adopted_as nyc\.charter\.9\.nope@1 is not in the register/],
    ["adopted_as on an open entry", (d) => { certification(d).adopted_as = "nyc.charter.311.i.1.mwbe_small_purchase_ceiling.from_2023_12_08@1"; }, /has adopted_as but status is passed_uncertified/],
    ["unknown status", (d) => { certification(d).status = "maybe_law"; }, /unknown status maybe_law/],
    ["unreviewed without a reason", (d) => { certification(d).review = { status: "unreviewed", by: null, on: null }; }, /unreviewed requires a review\.reason/],
    ["source_checked without a reviewer", (d) => { certification(d).review.by = null; }, /requires a named reviewer/],
    ["duplicate id", (d) => { d.entries.push(clone(d.entries[0])); }, /duplicate entry id/],
    ["known divergence without a review item", (d) => { d.register_review_items = d.register_review_items.filter((i) => i.register_divergence_id !== "kd.ppb_3_08_effective_dates"); }, /known divergence kd\.ppb_3_08_effective_dates has no register_review_item/],
    ["review item naming an unknown divergence", (d) => { d.register_review_items[0].register_divergence_id = "kd.invented"; }, /unknown divergence kd\.invented/],
  ];
  for (const [name, mutate, pattern] of controls) {
    assert.throws(() => validateChangeDocket(mutated(mutate), { register }), pattern, name);
  }
  // adoption done properly is accepted, and the docket still does not change the register
  const adopted = mutated((d) => {
    const entry = certification(d);
    entry.status = "adopted_into_register";
    entry.adopted_as = "nyc.charter.311.i.1.mwbe_small_purchase_ceiling.from_2023_12_08@1";
  });
  const before = clone(register);
  assert.equal(validateChangeDocket(adopted, { register }), true);
  assert.deepEqual(register, before);
  assert.deepEqual(docketForRegisterEntry(adopted, "nyc.charter.311.i.1.mwbe_small_purchase_ceiling.from_2023_12_08").map((e) => e.id), ["nyc.charter.2026-q2.certification-effective"]);
  assert.ok(!docketAwaitingEvents(adopted).some((row) => row.id === "nyc.charter.2026-q2.certification-effective"));
});

/* ---------------------------------------------------------------- (viii) divergences tracked */

test("(viii) every register known_divergence id appears in register_review_items with an owner slice", () => {
  assert.equal(register.known_divergences.length, 5);
  for (const divergence of register.known_divergences) {
    const item = docket.register_review_items.find((row) => row.register_divergence_id === divergence.id);
    assert.ok(item, divergence.id);
    assert.ok(item.owner_slice && item.summary && item.id);
  }
  assert.equal(docket.register_review_items.length, 5);
});
