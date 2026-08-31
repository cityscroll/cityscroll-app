import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalCodeProvisionId,
  exactProvisionWatch,
  projectProvisionWatchEvents,
  provisionFollowHref,
  provisionWatchDigestRows,
  replayProvisionWatch,
} from "../site/code_provision_watch.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import {
  buildFollowingViewModel,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { reviewedFollowingLens } from "../site/following_preview_handoff.mjs";
import { compileSub, rowsForCompiledQuery } from "../worker/src/lib/compile.mjs";
import { compileSub_d1 } from "../worker/src/lib/compile_d1.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { feedItems } from "../worker/src/lib/feed.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/code_provision_watch.json", import.meta.url), "utf8"));
const provision = fixtures.provision;

test("exact provision follow keeps the stable ref after text and current version change", () => {
  const before = exactProvisionWatch({ provision_id: provision.id, current_text: provision.current_text });
  const after = exactProvisionWatch({
    provision_id: fixtures.amended_provision.id,
    current_text: fixtures.amended_provision.current_text,
    current_version_id: fixtures.amended_provision.current_version_id,
  });
  assert.equal(before.status, "ok");
  assert.equal(before.provision_id, "nyc-administrative-code:16-120");
  assert.deepEqual(before.filter, after.filter);
  assert.equal(before.provision_id, after.provision_id);
  assert.equal(canonicalCodeProvisionId("nyc-admin-code:16-120"), before.provision_id);
  const href = provisionFollowHref(fixtures.amended_provision);
  const parsed = watchFromFollowingParams(new URL(href).searchParams);
  assert.equal(parsed.lens, "legal_code");
  assert.equal(parsed.filter.provision_id, "nyc-administrative-code:16-120");
  assert.match(href, /\/following\?/);
  assert.doesNotMatch(href, /\/subscribe/);
});

test("lifecycle events distinguish proposed, passed, effective, and optional rule citation", () => {
  const projected = projectProvisionWatchEvents({
    provision_id: provision.id,
    changes: [fixtures.proposed, fixtures.passed],
    rule_citations: [fixtures.rule_citation],
    as_of: "2026-11-01",
    confirmed: true,
  });
  const kinds = projected.events.map((event) => event.event_kind);
  assert.deepEqual(kinds, ["proposed", "passed", "effective", "rule_citation"]);
  const effective = projected.events.find((event) => event.event_kind === "effective");
  const passed = projected.events.find((event) => event.event_kind === "passed");
  assert.equal(passed.clock, "2026-08-01");
  assert.equal(effective.clock, "2026-11-01");
  assert.notEqual(passed.replay_key, effective.replay_key);
  assert.equal(effective.source_record, "council:local-law:123-2026");
  assert.match(effective.source_url, /^https:\/\/legistar\.council\.nyc\.gov\//);
  assert.equal(effective.source_vintage, "2026-08-01");
  const citation = projected.events.find((event) => event.event_kind === "rule_citation");
  assert.equal(citation.source_record, "nyc-rules:dot-bicycle-racks");
});

test("missing or conditional effective dates stay unresolved and do not become immediate effect", () => {
  const projected = projectProvisionWatchEvents({
    provision_id: provision.id,
    changes: [fixtures.conditional],
    as_of: "2026-08-01",
    confirmed: true,
  });
  assert.equal(projected.events.some((event) => event.event_kind === "passed"), true);
  assert.equal(projected.events.some((event) => event.event_kind === "effective"), false);
  assert.equal(projected.unresolved.some((event) => event.event_kind === "effective" && event.status === "unresolved"), true);
});

test("unsupported scopes, inferred citations, stale sources, and broadening attempts create no watch", () => {
  assert.equal(exactProvisionWatch({ lens: "legal_code", filter: { keywords: ["housing"] } }).status, "unsupported");
  assert.equal(exactProvisionWatch({
    lens: "legal_code",
    filter: { provision_id: provision.id, agency: "Sanitation" },
  }).status, "unsupported");
  assert.equal(exactProvisionWatch({ lens: "money", filter: { keywords: ["16-120"] } }).status, "unsupported");
  assert.equal(provisionFollowHref({ lens: "legal_code" }), null);
  const inferred = projectProvisionWatchEvents({
    provision_id: provision.id,
    rule_citations: [fixtures.inferred_rule_citation],
    confirmed: true,
  });
  assert.equal(inferred.events.length, 0);
  assert.equal(inferred.unresolved.some((event) => event.status === "unknown"), true);
  const stale = projectProvisionWatchEvents({
    provision_id: provision.id,
    changes: [fixtures.passed],
    as_of: "2026-11-01",
    stale: true,
    confirmed: true,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.events.length, 0);
});

test("duplicate refresh is idempotent and compile replay keeps the exact provision", async () => {
  const lookup = { changes: [fixtures.passed], rule_citations: [fixtures.rule_citation] };
  const first = provisionWatchDigestRows(lookup, {
    provision_id: provision.id,
    as_of: "2026-11-01",
    confirmed: true,
  });
  const second = provisionWatchDigestRows(lookup, {
    provision_id: provision.id,
    as_of: "2026-11-01",
    confirmed: true,
  });
  assert.deepEqual(first.map((row) => row.alert_id), second.map((row) => row.alert_id));
  assert.equal(new Set(first.map((row) => row.alert_id)).size, first.length);

  const query = compileSub({
    lens: "legal_code",
    filter: { provision_id: provision.id },
  }, "2026-11-01");
  assert.ok(query);
  assert.equal(query.kind, "legal_code");
  assert.equal(query.idField, "alert_id");
  const rows = await rowsForCompiledQuery(query, {}, async () => new Response(JSON.stringify(lookup), {
    headers: { "Content-Type": "application/json" },
  }));
  assert.ok(rows.every((row) => row.provision_id === provision.id));
  assert.equal(compileSub({ lens: "legal_code", filter: {} }, "2026-11-01"), null);
  assert.equal(compileSub({
    lens: "legal_code",
    filter: { provision_id: provision.id, keywords: ["housing"] },
  }, "2026-11-01"), null);
  assert.equal(compileSub_d1({ lens: "legal_code", filter: { provision_id: provision.id } }, "2026-11-01"), null);
});

test("Following URLs, confirmation copy, and provision pages stay exact-scope", () => {
  assert.equal(reviewedFollowingLens("legal_code").status, "ok");
  const href = followingUrlFromWatch({
    lens: "legal_code",
    filter: { provision_id: provision.id },
  }, { frequency: "weekly" });
  const parsed = watchFromFollowingParams(new URL(href).searchParams);
  assert.equal(parsed.lens, "legal_code");
  assert.equal(parsed.filter.provision_id, provision.id);
  const view = buildFollowingViewModel({
    ...parsed,
    requested: true,
    previewItems: feedItems("legal_code", provisionWatchDigestRows({
      changes: [fixtures.proposed],
    }, { provision_id: provision.id, as_of: "2026-07-15" })),
  });
  const html = renderFollowingDocument(view);
  assert.match(html, /name="lens"[^>]+value="legal_code"/);
  assert.match(html, /data-following-subscribe-form/);
  assert.match(html, /Create this watch/);
  assert.match(describeFilter("legal_code", parsed.filter), /Administrative Code § 16-120/);
  assert.equal(followingUrlFromWatch({ lens: "legal_code", filter: { keywords: ["all legislation"] } }), "/following/");
  const unknown = watchFromFollowingParams(new URLSearchParams({
    lens: "legal_code",
    filter: JSON.stringify({ keywords: ["housing"] }),
  }));
  assert.equal(unknown.scopeStatus, "unrecognized_scope");
  const page = renderAdminCodeProvisionDocument({
    ...provision,
    heading: "Receptacles",
    source: { observed_at: "2026-08-24", content_hash: "sha256:old", url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1" },
  });
  assert.match(page, /Follow Administrative Code § 16-120/);
  assert.match(page, /\/following\?/);
  assert.doesNotMatch(page, /action="https:\/\/api\.cityscroll\.org\/subscribe"/);
});

test("sanitize does not fall through an inexact provision watch to Contracts", () => {
  assert.equal(sanitize("legal_code", { provision_id: provision.id, keywords: ["housing"] }).provision_id, provision.id);
  assert.equal(sanitize("legal_code", { provision_id: provision.id }).keywords, undefined);
  assert.equal(sanitize("legal_code", { provision_id: "not-a-provision" }).provision_id, undefined);
  const replay = replayProvisionWatch({
    lens: "legal_code",
    filter: { provision_id: provision.id },
  }, { todayISO: "2026-11-01", lookup: { changes: [fixtures.passed] }, confirmed: false });
  assert.equal(replay.filter.provision_id, provision.id);
  assert.equal(replay.replayable, true);
  const subscribe = readFileSync(new URL("../worker/src/subscribe.mjs", import.meta.url), "utf8");
  assert.match(subscribe, /"legal_code"/);
  assert.match(subscribe, /unsupported-scope/);
  assert.match(subscribe, /filter\.provision_id/);
});
