/**
 * Browse grouping for PIN-family siblings.
 *
 * Distinct procurement objects that share a PIN/EPIN family stay separate
 * identities. Verified related-instrument pairs (p7 auto-labels, or
 * same-vendor PIN-family rows that are not on the human queue) cluster as
 * related instruments of one procurement. Distinct-vendor / needs_review
 * pairs stay separate with a related-candidate label.
 */

import { vendorStem } from "./vendor_stem.mjs";

export const PIN_SIBLING_GROUPING_VERSION = "pin_sibling_grouping_v1";
export const PIN_SIBLING_MIN_PIN_LEN = 8;
export const PIN_SIBLING_IDENTITY_CLASSES = Object.freeze([
  "related_instrument",
  "related_candidate",
]);

const SUFFIX_RE = /^(.+?)([A-Z]\d{3,4})$/;
const REST_OK_RE = /^(?:\d+|[A-Z]\d{2,6}|[A-Z]{1,2}\d{2,6})+$/;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function contractIdKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function pinKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function rowContractIdKey(row = {}) {
  const direct = contractIdKey(row.contract_id);
  if (direct) return direct;
  const id = clean(row.procurement_id);
  const match = id.match(/^procurement:contract:(.+)$/i);
  return match ? contractIdKey(match[1]) : "";
}

export function rowIdentity(row = {}) {
  return clean(row.procurement_id)
    || rowContractIdKey(row)
    || clean(row.request_id)
    || "";
}

export function strongPinKey(value) {
  const key = pinKey(value);
  return key.length >= PIN_SIBLING_MIN_PIN_LEN ? key : "";
}

function stripOneSuffix(id) {
  const match = String(id || "").match(SUFFIX_RE);
  return match ? match[1] : null;
}

export function restOkForPrefixJoin(rest) {
  if (rest == null || rest === "") return true;
  return REST_OK_RE.test(String(rest));
}

/**
 * The PIN-family predicate over already-normalized keys, so a caller comparing
 * one PIN against a large corpus can normalize the corpus once.
 */
export function pinKeysShareFamily(a, b) {
  if (!a || !b) return false;
  if (a === b) return a.length >= PIN_SIBLING_MIN_PIN_LEN;
  if (a.length < PIN_SIBLING_MIN_PIN_LEN && b.length < PIN_SIBLING_MIN_PIN_LEN) return false;
  const strippedA = stripOneSuffix(a);
  const strippedB = stripOneSuffix(b);
  if (strippedA && strippedA === b && b.length >= PIN_SIBLING_MIN_PIN_LEN) return true;
  if (strippedB && strippedB === a && a.length >= PIN_SIBLING_MIN_PIN_LEN) return true;
  if (strippedA && strippedB && strippedA === strippedB && strippedA.length >= PIN_SIBLING_MIN_PIN_LEN) {
    return true;
  }
  if (a.length >= PIN_SIBLING_MIN_PIN_LEN && b.length > a.length
    && b.startsWith(a) && restOkForPrefixJoin(b.slice(a.length))) return true;
  if (b.length >= PIN_SIBLING_MIN_PIN_LEN && a.length > b.length
    && a.startsWith(b) && restOkForPrefixJoin(a.slice(b.length))) return true;
  return false;
}

export function pinsShareFamily(left, right) {
  return pinKeysShareFamily(pinKey(left), pinKey(right));
}

export function pinIndexKeys(pin) {
  const n = pinKey(pin);
  if (n.length < PIN_SIBLING_MIN_PIN_LEN) return [];
  const keys = new Set([n]);
  const stripped = stripOneSuffix(n);
  if (stripped && stripped.length >= PIN_SIBLING_MIN_PIN_LEN) keys.add(stripped);
  for (let length = Math.min(n.length - 1, 20); length >= PIN_SIBLING_MIN_PIN_LEN; length -= 1) {
    const prefix = n.slice(0, length);
    if (restOkForPrefixJoin(n.slice(length))) keys.add(prefix);
  }
  return [...keys];
}

export function sameVendorStem(left, right) {
  const a = vendorStem(left);
  const b = vendorStem(right);
  return Boolean(a && b && a === b);
}

function pairKey(leftKey, rightKey) {
  return [leftKey, rightKey].sort().join("::");
}

export function pinSiblingReviewIndex(review = {}) {
  const pairs = [];
  const byPair = new Map();
  for (const pair of Array.isArray(review?.pairs) ? review.pairs : []) {
    const leftKey = contractIdKey(pair?.evidence?.checkbook?.contract_id);
    const rightKey = contractIdKey(pair?.evidence?.passport?.contract_id);
    if (!leftKey || !rightKey || leftKey === rightKey) continue;
    const identityClass = PIN_SIBLING_IDENTITY_CLASSES.includes(pair.identity_class)
      ? pair.identity_class
      : pair.identity_class === "same_contract" ? "related_instrument" : null;
    if (!identityClass) continue;
    const record = Object.freeze({
      pair_id: pair.pair_id || `pf:${leftKey}::${rightKey}`,
      identity_class: identityClass,
      label_source: pair.label_source || "review",
      rule: pair.rule || null,
      pin: pair.evidence?.pin || pair.evidence?.epin || null,
      leftKey,
      rightKey,
    });
    pairs.push(record);
    byPair.set(pairKey(leftKey, rightKey), record);
  }
  return Object.freeze({ pairs: Object.freeze(pairs), byPair });
}

export function classifyBrowsePinSiblingPair(left = {}, right = {}, reviewIndex = pinSiblingReviewIndex()) {
  const leftId = rowIdentity(left);
  const rightId = rowIdentity(right);
  if (!leftId || !rightId || leftId === rightId) return null;

  const leftContract = rowContractIdKey(left);
  const rightContract = rowContractIdKey(right);
  const reviewed = leftContract && rightContract
    ? reviewIndex.byPair.get(pairKey(leftContract, rightContract))
    : null;
  if (reviewed?.identity_class === "needs_review" || reviewed?.identity_class === "related_candidate") {
    return {
      identity_class: "related_candidate",
      label_source: "review",
      rule: reviewed.rule || "needs_review",
      pin: strongPinKey(left.pin) || strongPinKey(right.pin) || pinKey(reviewed.pin),
    };
  }
  if (reviewed?.identity_class === "related_instrument") {
    return {
      identity_class: "related_instrument",
      label_source: "review",
      rule: reviewed.rule || "related_instrument",
      pin: strongPinKey(left.pin) || strongPinKey(right.pin) || pinKey(reviewed.pin),
    };
  }

  if (!pinsShareFamily(left.pin, right.pin)) return null;
  const pin = strongPinKey(left.pin) || strongPinKey(right.pin);
  if (sameVendorStem(left.vendor_name, right.vendor_name)) {
    return {
      identity_class: "related_instrument",
      label_source: "pin_family",
      rule: "same_vendor_pin_family",
      pin,
    };
  }
  return {
    identity_class: "related_candidate",
    label_source: "pin_family",
    rule: "shared_pin_distinct_vendor",
    pin,
  };
}

function displayPin(members, fallback) {
  const pins = members.map((row) => strongPinKey(row.pin)).filter(Boolean)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return pins[0] || pinKey(fallback) || "";
}

function clusterLabelSource(memberIndexes, pairClass) {
  for (let i = 0; i < memberIndexes.length; i += 1) {
    for (let j = i + 1; j < memberIndexes.length; j += 1) {
      const classified = pairClass.get(pairKey(String(memberIndexes[i]), String(memberIndexes[j])));
      if (classified?.label_source === "review") return "review";
    }
  }
  return "pin_family";
}

/**
 * Project browse rows into display entries without merging procurement_ids.
 * @returns {Array<{kind:"item"|"related_instrument", item?:object, members?:object[], identity_class?:string, pin?:string, candidate?:object}>}
 */
export function groupPinSiblingRows(rows = [], options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const reviewIndex = options.reviewIndex || pinSiblingReviewIndex(options.review);
  const parent = list.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    let walk = index;
    while (parent[walk] !== cursor) {
      const next = parent[walk];
      parent[walk] = cursor;
      walk = next;
    }
    return cursor;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[a] = b;
  };

  const byKey = new Map();
  list.forEach((row, index) => {
    for (const key of pinIndexKeys(row?.pin)) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(index);
      else byKey.set(key, [index]);
    }
  });

  const pairClass = new Map();
  const markPair = (i, j, classified) => {
    pairClass.set(pairKey(String(i), String(j)), classified);
  };

  list.forEach((row, index) => {
    const seen = new Set([index]);
    for (const key of pinIndexKeys(row?.pin)) {
      for (const otherIndex of byKey.get(key) || []) {
        if (seen.has(otherIndex) || otherIndex <= index) continue;
        seen.add(otherIndex);
        const classified = classifyBrowsePinSiblingPair(row, list[otherIndex], reviewIndex);
        if (!classified) continue;
        markPair(index, otherIndex, classified);
        if (classified.identity_class === "related_instrument") union(index, otherIndex);
      }
    }
  });

  for (const pair of reviewIndex.pairs) {
    if (pair.identity_class !== "related_instrument") continue;
    const leftIndex = list.findIndex((row) => rowContractIdKey(row) === pair.leftKey);
    const rightIndex = list.findIndex((row) => rowContractIdKey(row) === pair.rightKey);
    if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) continue;
    markPair(leftIndex, rightIndex, {
      identity_class: "related_instrument",
      label_source: "review",
      rule: pair.rule || "related_instrument",
      pin: strongPinKey(list[leftIndex].pin) || strongPinKey(list[rightIndex].pin) || pinKey(pair.pin),
    });
    union(leftIndex, rightIndex);
  }

  const membersByRoot = new Map();
  list.forEach((_, index) => {
    const root = find(index);
    const members = membersByRoot.get(root);
    if (members) members.push(index);
    else membersByRoot.set(root, [index]);
  });

  const clustered = new Set();
  const entries = [];
  list.forEach((row, index) => {
    const root = find(index);
    const members = membersByRoot.get(root) || [index];
    if (members.length > 1) {
      if (clustered.has(root)) return;
      clustered.add(root);
      const clusteredRows = members.map((member) => list[member]);
      const identities = clusteredRows.map(rowIdentity).filter(Boolean);
      entries.push({
        kind: "related_instrument",
        identity_class: "related_instrument",
        label_source: clusterLabelSource(members, pairClass),
        pin: displayPin(clusteredRows),
        members: clusteredRows,
        procurement_ids: identities,
        count: clusteredRows.length,
      });
      return;
    }
    const candidatePeers = [];
    list.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const classified = pairClass.get(pairKey(String(index), String(otherIndex)));
      if (classified?.identity_class === "related_candidate") {
        candidatePeers.push({
          procurement_id: rowIdentity(other),
          pin: classified.pin,
          rule: classified.rule,
        });
      }
    });
    entries.push({
      kind: "item",
      item: row,
      ...(candidatePeers.length ? {
        candidate: {
          identity_class: "related_candidate",
          pin: candidatePeers[0].pin || strongPinKey(row.pin),
          peers: candidatePeers,
        },
      } : {}),
    });
  });
  return entries;
}
