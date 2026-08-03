import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Characterization: client inv merge helpers + anonymous localStorage path
// stay available when there is no recognized session (no server write).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = SITE_SOURCE;
const I18N = fs.readFileSync(path.join(ROOT, "site/i18n.js"), "utf8");
const SHIPPING_LANGS = ["ar", "bn", "es", "fr", "ht", "ko", "pl", "ru", "ur", "zh-Hans"];

test("index.html defines inv merge + session boot (magic-link recognition)", () => {
  assert.match(INDEX, /function invMergeStores/);
  assert.match(INDEX, /function sessionBoot/);
  assert.match(INDEX, /sessionStripUrlToken/);
  assert.match(INDEX, /history\.replaceState/);
  assert.match(INDEX, /id="sessionBanner"/);
  assert.match(INDEX, /session_not_you/);
  assert.match(INDEX, /credentials\s*=\s*"include"/);
  assert.match(INDEX, /\/pins/);
});

test("anonymous invSave still writes localStorage only (server push gated)", () => {
  // invSave always localStorage; invScheduleServerSave only when invSessionRecognized.
  assert.match(INDEX, /function invSave\(s\)\{\s*try\{ localStorage\.setItem\(INVKEY/);
  assert.match(INDEX, /if\(invSessionRecognized\) invScheduleServerSave\(s\)/);
});

test("session banner is dismissible and has a not-you affordance", () => {
  assert.match(INDEX, /id="sessionNotYou"/);
  assert.match(INDEX, /id="sessionDismiss"/);
  assert.match(INDEX, /id="sessionManage"/);
  assert.match(INDEX, /role="status"/);
  assert.match(INDEX, /sessionLogout/);
  assert.match(INDEX, /t\("session_signed_in",\s*\{\s*email:/);
  assert.match(INDEX, /session\.prefsUrl/);
});

test("session identity and watch-management copy ships in every locale", () => {
  assert.match(I18N, /session_signed_in:\s*"[^"]*\{email\}/);
  assert.match(I18N, /session_manage_watches:/);
  for (const lang of SHIPPING_LANGS) {
    const dict = fs.readFileSync(path.join(ROOT, `site/i18n/lang/${lang}.js`), "utf8");
    assert.match(dict, /session_signed_in:\s*"[^"]*\{email\}/, `${lang} names the account`);
    assert.match(dict, /session_manage_watches:/, `${lang} translates Manage watches`);
  }
});

// Pure merge logic mirrored from the client (keep in sync with invMergeStores).
function invItemKey(it) { return String(it?.t || "") + "|" + String(it?.id || ""); }
function invMergeItems(a, b) {
  const map = new Map();
  for (const it of [...(a || []), ...(b || [])]) {
    if (!it || !it.id || !it.t) continue;
    const k = invItemKey(it);
    const prev = map.get(k);
    if (!prev) { map.set(k, { ...it }); continue; }
    map.set(k, {
      ...prev,
      note: (it.note || "").length >= (prev.note || "").length ? it.note : prev.note,
    });
  }
  return [...map.values()];
}
function invMergeStores(local, server) {
  if (!local && !server) return { current: "inv1", invs: { inv1: { items: [] } } };
  if (!local) return server;
  if (!server) return local;
  const invs = {};
  const ids = new Set([...Object.keys(local.invs || {}), ...Object.keys(server.invs || {})]);
  for (const id of ids) {
    const la = (local.invs || {})[id], lb = (server.invs || {})[id];
    if (la && lb) invs[id] = { ...la, items: invMergeItems(la.items, lb.items) };
    else invs[id] = la || lb;
  }
  return { current: local.current || server.current, invs };
}

test("client merge semantics: union + dedupe by type+id", () => {
  const local = { current: "inv1", invs: { inv1: { items: [{ t: "notice", id: "1", note: "" }, { t: "notice", id: "2", note: "a" }] } } };
  const server = { current: "inv1", invs: { inv1: { items: [{ t: "notice", id: "2", note: "bb" }, { t: "agency", id: "a1", note: "" }] } } };
  const m = invMergeStores(local, server);
  assert.equal(m.invs.inv1.items.length, 3);
  const n2 = m.invs.inv1.items.find((i) => i.id === "2");
  assert.equal(n2.note, "bb");
});
