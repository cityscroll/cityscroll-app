import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOLICITATION_COVERAGE_CAP,
  mergeSolicitationCoverageRows,
  solicitationRecentParams,
} from "../src/lib/solicitation_coverage.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { compileSub_d1, subToD1Opts } from "../src/lib/compile_d1.mjs";
import { buildNoticesQuery } from "../src/lib/notices.mjs";

test("mergeSolicitationCoverageRows keeps due-date rows first and adds recent-only ids", () => {
  const due = [
    { digest_id: "due-1", due_date: "2026-09-12" },
    { digest_id: "shared", due_date: "2026-09-13" },
  ];
  const recent = [
    { digest_id: "shared", start_date: "2026-09-09" },
    { digest_id: "recent-1", start_date: "2026-09-09" },
  ];
  const merged = mergeSolicitationCoverageRows(due, recent);
  assert.deepEqual(merged.map((row) => row.digest_id), ["due-1", "shared", "recent-1"]);
});

test("mergeSolicitationCoverageRows caps the union", () => {
  const due = Array.from({ length: 25 }, (_, i) => ({ digest_id: `due-${i}` }));
  const recent = Array.from({ length: 25 }, (_, i) => ({ digest_id: `recent-${i}` }));
  const merged = mergeSolicitationCoverageRows(due, recent, { cap: SOLICITATION_COVERAGE_CAP });
  assert.equal(merged.length, 50);
  assert.equal(merged[0].digest_id, "due-0");
  assert.equal(merged[25].digest_id, "recent-0");
});

test("money solicitation compile adds a recent start_date page beside due_date ASC", () => {
  const q = compileSub({ lens: "money", filter: { keywords: ["construction"] } }, "2026-09-10");
  assert.equal(q.kind, "rfp");
  assert.equal(q.params["$order"], "due_date ASC");
  assert.equal(q.recentParams["$order"], "start_date DESC");
  assert.equal(q.recentParams["$where"], q.params["$where"]);
  assert.equal(q.recentParams["$q"], "construction");
  assert.deepEqual(solicitationRecentParams(q.params)["$order"], "start_date DESC");
});

test("D1 solicitation primary page is due_date ASC with a start_date coverage page", () => {
  const opts = subToD1Opts({ lens: "money", filter: { keywords: ["construction"] } }, "2026-09-10");
  assert.equal(opts.noticeType, "Solicitation");
  assert.equal(opts.orderBy, "due_date");
  assert.equal(opts.coverageOrderBy, "start_date");
  const compiled = compileSub_d1({ lens: "money", filter: { keywords: ["construction"] } }, "2026-09-10");
  assert.equal(compiled.opts.orderBy, "due_date");
  assert.equal(compiled.coverageOpts.orderBy, "start_date");
  assert.match(buildNoticesQuery(compiled.opts).sql, /ORDER BY due_date ASC/);
  assert.match(buildNoticesQuery(compiled.coverageOpts).sql, /ORDER BY start_date DESC/);
});

test("D1 awards stay recency-ordered and do not grow a coverage page", () => {
  const opts = subToD1Opts({ lens: "money", filter: { minAmount: 500000, keywords: ["construction"] } }, "2026-09-10");
  assert.equal(opts.noticeType, "Award");
  assert.equal(opts.orderBy, "start_date");
  assert.equal(opts.coverageOrderBy, undefined);
  const compiled = compileSub_d1({ lens: "money", filter: { minAmount: 500000 } }, "2026-09-10");
  assert.equal(compiled.coverageOpts, null);
});
