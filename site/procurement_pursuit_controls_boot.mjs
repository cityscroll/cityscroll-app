/**
 * Browser entry for the Passed/Pursuing note UI on already-rendered detail pages.
 *
 * The host markup is stamped at render time with the resolved matter key. This
 * file only binds save / clear / retry behaviour and migrates an unambiguous
 * legacy key when the page also stamped a source-alias map.
 */

import { bindAllPursuitControls } from "./procurement_pursuit_controls.mjs";

function readAliasMap(root) {
  const node = root?.querySelector?.("[data-pursuit-alias-map]");
  if (!node) return null;
  try {
    const parsed = JSON.parse(node.textContent || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function bootPursuitControls(root = typeof document === "undefined" ? null : document) {
  if (!root) return 0;
  return bindAllPursuitControls(root, { aliasMap: readAliasMap(root) });
}

const doc = typeof document === "undefined" ? null : document;
if (doc) {
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", () => bootPursuitControls(doc), { once: true });
  } else {
    bootPursuitControls(doc);
  }
}
