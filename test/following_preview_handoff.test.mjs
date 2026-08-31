import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FOLLOWING_PREVIEW_HANDOFF_SCHEMA,
  followingFocusHref,
  followingPreviewHandoffFromParams,
  followingPreviewHandoffFromScope,
  pinFollowingPreviewItems,
  previewItemMatchesFocus,
  reviewedFollowingLens,
} from "../site/following_preview_handoff.mjs";
import {
  buildFollowingViewModel,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { alertsHref } from "../site/alerts_context_carry.mjs";
import { compileActionRail } from "../worker/src/lib/action_registry.mjs";

const gold = JSON.parse(readFileSync(new URL("./fixtures/following_preview_handoff/gold.v1.json", import.meta.url), "utf8"));

test("reviewed lenses fail closed instead of remapping unknown values to Contracts", () => {
  assert.equal(reviewedFollowingLens("meetings").lens, "meetings");
  assert.equal(reviewedFollowingLens("obligations").lens, "mandates");
  assert.equal(reviewedFollowingLens("award").lens, "money");
  assert.equal(reviewedFollowingLens("legal_code").lens, "legal_code");
  assert.equal(reviewedFollowingLens("not-a-lens").status, "unrecognized_scope");
  assert.equal(reviewedFollowingLens("").status, "missing_scope");
});

test("gold fixture URLs round-trip without broadening the reviewed watch", () => {
  assert.equal(gold.schema, FOLLOWING_PREVIEW_HANDOFF_SCHEMA);
  for (const row of gold.cases) {
    const parsed = followingPreviewHandoffFromParams(row.href);
    assert.equal(parsed.schema, FOLLOWING_PREVIEW_HANDOFF_SCHEMA);
    assert.equal(parsed.status, row.status, row.id);
    assert.equal(parsed.lens, row.lens, row.id);
    if (row.focusKind) {
      assert.equal(parsed.focus.kind, row.focusKind, row.id);
      assert.equal(parsed.focus.id, row.focusId, row.id);
    }
    if (row.originRoute) assert.equal(parsed.originRoute, row.originRoute, row.id);
  }
});

test("a notice-scoped handoff keeps focus and origin on the canonical Following URL", () => {
  const href = followingUrlFromWatch({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
    originRoute: "/notices/20260716009/",
  });
  const url = new URL(href);
  assert.equal(url.pathname, "/following");
  assert.equal(url.searchParams.get("lens"), "meetings");
  assert.equal(url.searchParams.get("notice"), "20260716009");
  assert.equal(url.searchParams.get("from"), "/notices/20260716009/");
  const parsed = watchFromFollowingParams(url.searchParams);
  assert.equal(parsed.lens, "meetings");
  assert.equal(parsed.filter.agency, "Transportation");
  assert.equal(parsed.noticeId, "20260716009");
  assert.equal(parsed.originRoute, "/notices/20260716009/");
  assert.equal(parsed.scopeStatus, "ok");
});

test("origin routes reject protocol-shaped and Following-loop values", () => {
  const handoff = followingPreviewHandoffFromScope({
    lens: "meetings",
    filter: {},
    originRoute: "https://evil.example/following",
  });
  assert.equal(handoff.originRoute, null);
  const loop = followingPreviewHandoffFromScope({
    lens: "meetings",
    filter: {},
    originRoute: "/following?lens=money",
  });
  assert.equal(loop.originRoute, null);
});

test("preview pinning reorders an exact match and never invents a missing row", () => {
  const handoff = followingPreviewHandoffFromScope({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
  });
  const pinned = pinFollowingPreviewItems([
    { id: "20260805001", title: "Other hearing" },
    { id: "20260716009", title: "Dining Out NYC Public Hearing" },
  ], handoff);
  assert.equal(pinned[0].id, "20260716009");
  assert.equal(previewItemMatchesFocus(pinned[0], handoff), true);
  const missing = pinFollowingPreviewItems([{ id: "20260805001", title: "Other hearing" }], handoff);
  assert.deepEqual(missing.map((row) => row.id), ["20260805001"]);
});

test("static Following renderer keeps focus, save, and honest unrecognized states", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
    originRoute: "/notices/20260716009/",
    requested: true,
    matchCount: 2,
    previewItems: [
      { id: "20260805001", title: "Other hearing", url: "/notices/20260805001/" },
      { id: "20260716009", title: "Dining Out NYC Public Hearing", url: "/notices/20260716009/" },
    ],
  }));
  assert.match(html, /data-following-preview-focus/);
  assert.match(html, /data-focus-id="20260716009"/);
  assert.match(html, /data-preview-focus="true"/);
  assert.match(html, /name="notice" value="20260716009"/);
  assert.match(html, /name="from" value="\/notices\/20260716009\//);
  assert.match(html, /data-following-subscribe-form/);
  assert.match(html, /Create watch/);
  assert.doesNotMatch(html, /data-following-suggestions/);

  const partial = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
    requested: true,
    matchCount: 0,
    previewItems: [],
  }));
  assert.match(partial, /data-following-preview-partial="true"/);
  assert.match(partial, /No matches now — still watch for new/);
  assert.match(partial, /data-following-subscribe-form/);

  const unrecognized = renderFollowingDocument(buildFollowingViewModel({
    ...watchFromFollowingParams(new URLSearchParams("lens=not-a-lens&filter=%7B%7D")),
  }));
  assert.match(unrecognized, /data-following-handoff-status="unrecognized_scope"/);
  assert.match(unrecognized, /This watch link is not recognized/);
  assert.doesNotMatch(unrecognized, /data-following-subscribe-form/);
  assert.doesNotMatch(unrecognized, /name="lens"[^>]+value="money"/);
});

test("alertsHref and action-rail destinations share one Following watch contract", () => {
  const href = alertsHref({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
  });
  assert.equal(followingFocusHref(followingPreviewHandoffFromParams(href)), "/notices/20260716009/");
  const actions = compileActionRail({
    kind: "hearing",
    request_id: "20260716009",
    agency_name: "Transportation",
    section_name: "Public Hearings and Meetings",
    type_of_notice_description: "Public Hearings",
    short_title: "Dining Out NYC Public Hearing",
  }, { today: "2026-08-01" });
  const watch = actions.find((action) => action.type === "watch");
  assert.ok(watch?.destination);
  const destination = new URL(watch.destination);
  assert.equal(destination.pathname, "/following");
  assert.equal(destination.searchParams.get("lens"), "meetings");
  assert.equal(destination.searchParams.get("notice"), "20260716009");
  assert.equal(destination.searchParams.get("from"), "/notices/20260716009/");
});
