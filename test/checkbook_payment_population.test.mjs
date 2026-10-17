import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  groupPaymentsByAgency,
  normalizeCheckbookPaymentRows,
  parseCheckbookPaymentTransactions,
  paymentTransactionId,
  reconcilePaymentPartition,
} from "../warehouse/lib/checkbook_payment_population.mjs";
import {
  expectedPaymentPageRows,
  paymentPopulationRequestXml,
  SHORT_PAGE_ATTEMPTS,
} from "../warehouse/scripts/checkbook_payment_population.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-payment-population/collector.json");

function fixtureRows() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return Object.values(fixture.pages).flatMap(parseCheckbookPaymentTransactions);
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) makeWritable(child);
    else chmodSync(child, 0o644);
  }
}

describe("independent Checkbook payment population", () => {
  it("uses a fiscal-year Spending query separate from the bounded collector", () => {
    const xml = paymentPopulationRequestXml(2026, 1, 20000);
    assert.match(xml, /<type_of_data>Spending<\/type_of_data>/);
    assert.match(xml, /<name>fiscal_year<\/name>[\s\S]*<value>2026<\/value>/);
    assert.match(xml, /<name>spending_category<\/name>[\s\S]*<value>c<\/value>/);
    assert.doesNotMatch(xml, /<name>contract_id<\/name>/);
  });

  it("preserves source fields and negative reversal rows", () => {
    const rows = fixtureRows();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].payee_name, "Alpha & Sons");
    assert.equal(rows[1].check_amount, "-25.50");
    assert.equal(rows[1].document_id, "20260000002-1-DSB-AD");
    const normalized = normalizeCheckbookPaymentRows(rows);
    assert.equal(normalized.counts.normalized_rows, 4);
    assert.equal(normalized.counts.reversal_rows, 1);
    assert.equal(normalized.rows.find((row) => row.is_reversal).check_amount, -25.5);
    assert.equal(normalized.rows[0].source_system, "checkbook_payment_population");
    assert.ok(JSON.parse(normalized.rows[0].source_fields_json).budget_code);
  });

  it("creates deterministic identities and measures duplicates without dropping evidence", () => {
    const [first] = fixtureRows();
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    assert.equal(paymentTransactionId(first), paymentTransactionId(reordered));
    const normalized = normalizeCheckbookPaymentRows([first, reordered]);
    assert.equal(normalized.rows.length, 2);
    assert.equal(normalized.counts.unique_transaction_ids, 1);
    assert.equal(normalized.counts.duplicate_transaction_rows, 2);
  });

  it("reconciles source row count and net amount, including reversals", () => {
    const source = fixtureRows();
    const normalized = normalizeCheckbookPaymentRows(source).rows;
    const reconciliation = reconcilePaymentPartition({ sourceRecordCount: 4, sourceRows: source, normalizedRows: normalized });
    assert.equal(reconciliation.source_net_check_amount, 500);
    assert.equal(reconciliation.normalized_net_check_amount, 500);
    assert.equal(reconciliation.reconciled, true);
    const groups = groupPaymentsByAgency(normalized);
    assert.deepEqual(groups.map((group) => group.agency), ["Department of Beta", "Unknown / not published", "Department of Alpha"]);
  });
});

describe("payment population short-page guard", () => {
  it("computes the exact row count each page must carry for a stable publisher total", () => {
    assert.equal(expectedPaymentPageRows(1, 20_000, 1_784_794), 20_000);
    assert.equal(expectedPaymentPageRows(1_760_001, 20_000, 1_784_794), 20_000);
    assert.equal(expectedPaymentPageRows(1_780_001, 20_000, 1_784_794), 4_794);
    assert.equal(expectedPaymentPageRows(1, 2, 4), 2);
    assert.equal(expectedPaymentPageRows(3, 2, 4), 2);
    assert.equal(SHORT_PAGE_ATTEMPTS, 3);
  });

  function runFixturePage(stage, pageXml, label) {
    const base = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const fixturePath = join(stage, `${label}-fixture.json`);
    writeFileSync(fixturePath, `${JSON.stringify({
      ...base,
      pages: { "fy2026:1": base.pages["fy2026:1"], "fy2026:3": pageXml },
    }, null, 2)}\n`);
    return spawnSync(process.execPath, [
      "warehouse/scripts/checkbook_payment_population.mjs",
      "--from-fixture",
      "--fixture", fixturePath,
      "--fiscal-years", "2026",
      "--page-size", "2",
      "--stage-dir", join(stage, "out"),
      "--receipt", join(stage, "receipt.json"),
      "--output", join(stage, "payments.csv"),
    ], { cwd: ROOT, encoding: "utf8" });
  }

  it("fails closed on an empty fixture page instead of advancing past it", async () => {
    await withTempDir("checkbook-payment-empty-page", async (stage) => {
      const base = JSON.parse(readFileSync(FIXTURE, "utf8"));
      const emptyPage = String(base.pages["fy2026:3"]).replace(
        /<spending_transactions>[\s\S]*?<\/spending_transactions>/,
        "<spending_transactions></spending_transactions>",
      );
      const result = runFixturePage(stage, emptyPage, "empty-page");
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /short page for FY2026 offset 3/);
      assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /parsed row count 2 does not equal/);
    });
  });

  it("fails closed on a partial fixture page that returns fewer rows than expected", async () => {
    await withTempDir("checkbook-payment-partial-page", async (stage) => {
      const base = JSON.parse(readFileSync(FIXTURE, "utf8"));
      const full = String(base.pages["fy2026:3"]);
      const firstTx = full.match(/<transaction>[\s\S]*?<\/transaction>/)[0];
      const partialPage = full.replace(
        /<spending_transactions>[\s\S]*?<\/spending_transactions>/,
        `<spending_transactions>${firstTx}</spending_transactions>`,
      );
      const result = runFixturePage(stage, partialPage, "partial-page");
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /short page for FY2026 offset 3: parsed 1 rows, expected 2/);
      assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /parsed row count .* does not equal/);
    });
  });

  it("fails closed on a malformed success page that yields no parseable transactions", async () => {
    await withTempDir("checkbook-payment-malformed-page", async (stage) => {
      const malformedPage = [
        "<response><status><result>success</result></status>",
        "<result_records><record_count>4</record_count>",
        "<spending_transactions>NOT-A-TRANSACTION</spending_transactions>",
        "</result_records></response>",
      ].join("");
      const result = runFixturePage(stage, malformedPage, "malformed-page");
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /short page for FY2026 offset 3: parsed 0 rows, expected 2/);
      assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /parsed row count .* does not equal/);
    });
  });

  it("retries a live short page and keeps last-good when retries still miss", async () => {
    await withTempDir("checkbook-payment-short-page-retry", async (stage) => {
      const cache = join(stage, "cache");
      const mockPublisher = join(stage, "mock-publisher.mjs");
      try {
        writeFileSync(mockPublisher, `
          import { readFileSync } from "node:fs";
          const fixture = JSON.parse(readFileSync(process.env.MOCK_PAYMENT_FIXTURE, "utf8"));
          const pages = fixture.pages;
          const calls = new Map();
          const emptyOf = (xml) => xml.replace(
            /<spending_transactions>[\\s\\S]*?<\\/spending_transactions>/,
            "<spending_transactions></spending_transactions>",
          );
          globalThis.fetch = async (_url, init) => {
            const body = String(init.body);
            const year = body.match(/<name>fiscal_year<\\/name>[\\s\\S]*?<value>(\\d+)<\\/value>/)[1];
            const from = Number(body.match(/<records_from>(\\d+)<\\/records_from>/)[1]);
            const key = \`fy\${year}:\${from}\`;
            const n = (calls.get(key) || 0) + 1;
            calls.set(key, n);
            let xml = pages[key];
            if (!xml) throw new Error("missing fixture page " + key);
            if (process.env.MOCK_SHORT_PAGE_OFFSET === String(from) && n <= Number(process.env.MOCK_SHORT_PAGE_ATTEMPTS || 99)) {
              xml = emptyOf(xml);
            }
            return { ok: true, status: 200, text: async () => xml };
          };
        `);
        const environment = (overrides = {}) => ({
          ...process.env,
          CITYSCROLL_WAREHOUSE_CACHE: cache,
          MOCK_PAYMENT_FIXTURE: FIXTURE,
          MOCK_PAYMENT_OBSERVED_AT: "2026-08-26T12:00:00.000Z",
          ...overrides,
        });
        const refresh = (overrides) => spawnSync(process.execPath, [
          "--import", mockPublisher,
          "warehouse/scripts/checkbook_payment_population.mjs",
          "--refresh",
          "--page-size", "2",
          "--delay-ms", "1200",
        ], { cwd: ROOT, encoding: "utf8", env: environment(overrides) });

        const ok = refresh({ MOCK_SHORT_PAGE_OFFSET: "", MOCK_SHORT_PAGE_ATTEMPTS: "0" });
        assert.equal(ok.status, 0, ok.stderr || ok.stdout);
        const pointerPath = join(cache, "checkbook-payment-population", "current.json");
        const goodVersion = JSON.parse(readFileSync(pointerPath, "utf8")).version;

        const failed = refresh({
          MOCK_SHORT_PAGE_OFFSET: "3",
          MOCK_SHORT_PAGE_ATTEMPTS: "99",
        });
        assert.notEqual(failed.status, 0);
        assert.match(`${failed.stderr}\n${failed.stdout}`, /short page for FY2026 offset 3/);
        assert.equal(JSON.parse(readFileSync(pointerPath, "utf8")).version, goodVersion);

        const recovered = refresh({
          MOCK_SHORT_PAGE_OFFSET: "3",
          MOCK_SHORT_PAGE_ATTEMPTS: "1",
        });
        assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
        assert.match(`${recovered.stderr}\n${recovered.stdout}`, /short page FY2026 offset 3/);
        assert.notEqual(JSON.parse(readFileSync(pointerPath, "utf8")).version, goodVersion);
      } finally {
        makeWritable(cache);
      }
    });
  });
});

describe("payment population fixture acquisition", () => {
  it("writes a named population receipt and normalized CSV", async () => {
    await withTempDir("checkbook-payment-population-test", async (stage) => {
      const receipt = join(stage, "receipt.json");
      const output = join(stage, "payments.csv");
      const run = spawnSync(process.execPath, [
        "warehouse/scripts/checkbook_payment_population.mjs",
        "--from-fixture",
        "--fiscal-years", "2026",
        "--page-size", "2",
        "--stage-dir", stage,
        "--receipt", receipt,
        "--output", output,
      ], { cwd: ROOT, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const body = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(body.status, "complete");
      assert.equal(body.population_contract.id, "cityscroll.checkbook.payments.fiscal_year.v1");
      assert.equal(body.collector_boundary.no_graph_publication, true);
      assert.equal(body.population.publisher_record_count, 4);
      assert.equal(body.reconciliation.reconciled, true);
      assert.equal(body.population.reversal_rows, 1);
      assert.equal(body.reconciliation.source_net_check_amount, 500);
      assert.equal(body.source.acquisition_mode, "fixture");
      assert.ok(existsSync(output));
      assert.equal(readFileSync(output, "utf8").trim().split("\n").length, 5);
      assert.equal(body.source.pulled_at, "2026-08-26T12:00:00.000Z");
      const publicProjection = join(ROOT, "site/data/analytics_payments.json");
      const lastGoodPublicProjection = readFileSync(publicProjection, "utf8");
      const publicResult = spawnSync(process.execPath, [
        "tools/build_analytical_payments.mjs", "--input", output, "--receipt", receipt,
      ], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(publicResult.status, 0);
      assert.match(publicResult.stderr, /public .* requires live-publisher .* provenance/i);
      assert.equal(readFileSync(publicProjection, "utf8"), lastGoodPublicProjection);
      const cache = join(stage, "cache");
      const cacheResult = spawnSync(process.execPath, [
        "warehouse/scripts/publish_payment_input.mjs", cache, output, receipt,
      ], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(cacheResult.status, 0);
      assert.match(cacheResult.stderr, /shared .* cache requires live-publisher .* provenance/i);
      assert.equal(existsSync(join(cache, "checkbook-payment-population", "current.json")), false);
      const projection = join(stage, "projection.json");
      const project = () => spawnSync(process.execPath, [
        "tools/build_analytical_payments.mjs", "--input", output,
        "--receipt", receipt, "--output", projection,
      ], { cwd: ROOT, encoding: "utf8" });
      assert.equal(project().status, 0);
      const projected = readFileSync(projection, "utf8");
      const completeCsv = readFileSync(output, "utf8");
      const payload = JSON.parse(projected);
      assert.equal(payload.snapshot_date, body.source.pulled_at);
      assert.equal(payload.generated_at, body.source.pulled_at);
      assert.equal(payload.population.source_rows, 4);
      // Rebuilding a retained population must not make its source date newer.
      assert.equal(project().status, 0);
      assert.equal(readFileSync(projection, "utf8"), projected);
      const truncated = `${completeCsv.trimEnd().split("\n").slice(0, -1).join("\n")}\n`;
      const tampered = completeCsv.replace("Department of Alpha", "Department of Omega");
      assert.notEqual(tampered, completeCsv);
      for (const [invalidCsv, expectedError] of [
        [truncated, /row count/i],
        [tampered, /checksum/i],
      ]) {
        writeFileSync(output, invalidCsv);
        const rejected = project();
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, expectedError);
        assert.equal(readFileSync(projection, "utf8"), projected);
      }
      writeFileSync(output, completeCsv);
      for (const invalid of [
        { ...body, status: "failed" },
        { ...body, source: { ...body.source, pulled_at: null } },
      ]) {
        writeFileSync(receipt, JSON.stringify(invalid));
        assert.notEqual(project().status, 0);
        assert.equal(readFileSync(projection, "utf8"), projected);
      }
      const reused = spawnSync(process.execPath, [
        "warehouse/scripts/checkbook_payment_population.mjs", "--from-fixture",
        "--reuse-pages", "--fiscal-years", "2026", "--page-size", "2",
        "--stage-dir", stage, "--receipt", receipt, "--output", output,
      ], { cwd: ROOT, encoding: "utf8" });
      assert.equal(reused.status, 0, reused.stderr);
      assert.equal(JSON.parse(readFileSync(receipt, "utf8")).source.pulled_at, null);
      assert.notEqual(project().status, 0, "undated reused pages must not become fresh");
      assert.equal(readFileSync(projection, "utf8"), projected);
    });
  });

  it("rejects fixture acquisition through production output defaults", () => {
    const result = spawnSync(process.execPath, [
      "warehouse/scripts/checkbook_payment_population.mjs", "--from-fixture",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires isolated .* paths/i);
  });

  it("refreshes a configured shared cache atomically and preserves its last good version", async () => {
    await withTempDir("checkbook-payment-shared-refresh", async (stage) => {
      const cache = join(stage, "cache");
      const projection = join(stage, "projection.json");
      const mockPublisher = join(stage, "mock-publisher.mjs");
      try {
        writeFileSync(mockPublisher, `
        import { readFileSync } from "node:fs";
        const fixture = JSON.parse(readFileSync(process.env.MOCK_PAYMENT_FIXTURE, "utf8"));
        const transactions = Object.values(fixture.pages)
          .flatMap((xml) => xml.match(/<transaction>[\\s\\S]*?<\\/transaction>/g) || [])
          .join("");
        const first = Object.values(fixture.pages)[0];
        let xml = first.replace(
          /<spending_transactions>[\\s\\S]*?<\\/spending_transactions>/,
          \`<spending_transactions>\${transactions}</spending_transactions>\`,
        );
        xml = xml.replace("<check_amount>125.50</check_amount>",
          \`<check_amount>\${process.env.MOCK_PAYMENT_AMOUNT}</check_amount>\`);
        if (process.env.MOCK_PAYMENT_FAILURE === "count-drift") {
          xml = xml.replace("<record_count>4</record_count>", "<record_count>5</record_count>");
        }
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [process.env.MOCK_PAYMENT_OBSERVED_AT])); }
          static now() { return NativeDate.now(); }
        };
        globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => xml });
      `);
        const environment = (overrides = {}) => ({
        ...process.env,
        CITYSCROLL_WAREHOUSE_CACHE: cache,
        MOCK_PAYMENT_FIXTURE: FIXTURE,
        MOCK_PAYMENT_AMOUNT: "125.50",
        MOCK_PAYMENT_OBSERVED_AT: "2026-08-26T12:00:00.000Z",
        ...overrides,
      });
        const refresh = (overrides) => spawnSync(process.execPath, [
        "--import", mockPublisher,
        "warehouse/scripts/checkbook_payment_population.mjs", "--refresh",
      ], { cwd: ROOT, encoding: "utf8", env: environment(overrides) });
        const project = () => spawnSync(process.execPath, [
        "tools/build_analytical_payments.mjs", "--output", projection,
      ], { cwd: ROOT, encoding: "utf8", env: environment() });
        const pointer = () => JSON.parse(readFileSync(join(
        cache, "checkbook-payment-population", "current.json",
      ), "utf8")).version;
        const currentReceipt = () => JSON.parse(readFileSync(join(
        cache, "checkbook-payment-population", "versions", pointer(), "receipt.json",
      ), "utf8"));

        const first = refresh();
        assert.equal(first.status, 0, first.stderr || first.stdout);
        const firstVersion = pointer();
        assert.equal(currentReceipt().status, "complete");
        assert.equal(currentReceipt().reconciliation.reconciled, true);

        const second = refresh({
          MOCK_PAYMENT_AMOUNT: "150.50",
          MOCK_PAYMENT_OBSERVED_AT: "2026-08-27T12:00:00.000Z",
        });
        assert.equal(second.status, 0, second.stderr || second.stdout);
        const secondVersion = pointer();
        assert.notEqual(secondVersion, firstVersion);
        assert.equal(currentReceipt().source.pulled_at, "2026-08-27T12:00:00.000Z");
        assert.equal(project().status, 0);
        const lastGoodProjection = readFileSync(projection, "utf8");
        assert.equal(JSON.parse(lastGoodProjection).population.actual_payment_amount, 525);

        const failed = refresh({
          MOCK_PAYMENT_AMOUNT: "175.50",
          MOCK_PAYMENT_OBSERVED_AT: "2026-08-28T12:00:00.000Z",
          MOCK_PAYMENT_FAILURE: "count-drift",
        });
        assert.notEqual(failed.status, 0);
        assert.equal(pointer(), secondVersion);
        assert.equal(project().status, 0);
        assert.equal(readFileSync(projection, "utf8"), lastGoodProjection);
      } finally {
        makeWritable(cache);
      }
    });
  });
});
