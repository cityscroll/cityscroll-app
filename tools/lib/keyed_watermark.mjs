/**
 * Keyed composite watermarks for D1 partition publication.
 *
 * A watermark names the vintages of the sources that fed one partition. Two
 * published forms exist:
 *
 *   - keyed:   `name=vintage|name=vintage|...` (preferred)
 *   - legacy:  `|`-joined counts and ISO stamps with no names (agency
 *              constellation historically sorted anonymous stamps)
 *
 * Regression is judged per named source. An added, removed, or renamed source
 * is a source-set change: allowed when every shared source is >= its prior
 * value. A true regression of any shared source still refuses publication.
 *
 * Legacy unkeyed composites cannot name sources, so component disappearance is
 * treated as a source-set change rather than a regression. Scalar (single
 * instant) watermarks still refuse when the instant moves earlier.
 */

const KEYED_COMPONENT = /^([A-Za-z][A-Za-z0-9_.]*)=(.*)$/;
const INSTANT_COMPONENT = /^\d{4}-\d{2}-\d{2}/;

function isSourceName(name) {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.]*$/.test(name);
}

/** Flatten one source entry into top-level `name=value` pairs (nested `|` expanded). */
export function expandWatermarkEntry(name, value) {
  if (value == null || value === "") return [];
  const source = String(name).trim();
  if (!isSourceName(source)) throw new Error(`keyed watermark source name is invalid: ${name}`);
  const raw = String(value).trim();
  if (!raw) return [];
  if (!raw.includes("|")) return [[source, raw]];
  const nested = parseWatermarkComponents(raw);
  if (nested.keyed) {
    return Object.entries(nested.map).map(([child, childValue]) => [`${source}.${child}`, childValue]);
  }
  // Legacy anonymous nested composite: keep each leaf under a stable index so
  // the outer `|` delimiter stays unambiguous. A later keyed rebuild of the
  // nested producer replaces indices with names (a source-set change).
  return raw.split("|").map((part) => part.trim()).filter(Boolean)
    .map((part, index) => [`${source}.${index}`, part]);
}

export function composeKeyedWatermark(entries) {
  const parts = [];
  for (const [key, value] of Object.entries(entries || {})) {
    parts.push(...expandWatermarkEntry(key, value));
  }
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return parts.map(([key, value]) => `${key}=${value}`).join("|") || null;
}

export function parseWatermarkComponents(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { keyed: false, map: {}, instants: [], components: [] };
  }
  const components = value.split("|").map((part) => part.trim()).filter(Boolean);
  const map = {};
  let keyedCount = 0;
  const instants = [];
  for (const component of components) {
    const matched = component.match(KEYED_COMPONENT);
    if (matched) {
      keyedCount += 1;
      map[matched[1]] = matched[2];
      if (INSTANT_COMPONENT.test(matched[2])) {
        const ms = Date.parse(matched[2]);
        if (!Number.isNaN(ms)) instants.push(ms);
      }
      continue;
    }
    if (INSTANT_COMPONENT.test(component)) {
      const ms = Date.parse(component);
      if (!Number.isNaN(ms)) instants.push(ms);
    }
  }
  // A token is keyed when every non-count component carries a name. A leading
  // numeric count (passport selected_rows style) may still appear without a key
  // in transitional tokens; require at least one keyed component and no bare
  // instant components mixed in.
  const bareInstants = components.filter((component) => (
    !KEYED_COMPONENT.test(component) && INSTANT_COMPONENT.test(component)
  ));
  const keyed = keyedCount > 0 && bareInstants.length === 0;
  return { keyed, map: keyed ? map : {}, instants, components };
}

function vintageOrder(left, right) {
  const leftInstant = INSTANT_COMPONENT.test(left) ? Date.parse(left) : Number.NaN;
  const rightInstant = INSTANT_COMPONENT.test(right) ? Date.parse(right) : Number.NaN;
  if (!Number.isNaN(leftInstant) && !Number.isNaN(rightInstant)) {
    return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compare two watermark tokens. Returns a structured change record; never
 * throws. Callers refuse publication when `regressed` is true.
 */
export function compareWatermarks(priorValue, currentValue) {
  const prior = parseWatermarkComponents(priorValue);
  const current = parseWatermarkComponents(currentValue);
  const empty = {
    regressed: false,
    source_set_changed: false,
    format_changed: false,
    shared_regressed: [],
    added: [],
    removed: [],
    prior_keyed: prior.keyed,
    current_keyed: current.keyed,
  };

  if (prior.instants.length === 0 || current.instants.length === 0) {
    return { ...empty, regressed: true, shared_regressed: ["__missing_instant__"] };
  }

  // Preferred path: both sides name their sources.
  if (prior.keyed && current.keyed) {
    const priorKeys = new Set(Object.keys(prior.map));
    const currentKeys = new Set(Object.keys(current.map));
    const added = [...currentKeys].filter((key) => !priorKeys.has(key)).sort();
    const removed = [...priorKeys].filter((key) => !currentKeys.has(key)).sort();
    const shared_regressed = [...priorKeys]
      .filter((key) => currentKeys.has(key) && vintageOrder(current.map[key], prior.map[key]) < 0)
      .sort();
    return {
      regressed: shared_regressed.length > 0,
      source_set_changed: added.length > 0 || removed.length > 0,
      format_changed: false,
      shared_regressed,
      added,
      removed,
      prior_keyed: true,
      current_keyed: true,
    };
  }

  const format_changed = prior.keyed !== current.keyed;

  // Scalar legacy / single-instant: refuse a backward move.
  if (prior.instants.length === 1 && current.instants.length === 1) {
    return {
      ...empty,
      format_changed,
      regressed: current.instants[0] < prior.instants[0],
      shared_regressed: current.instants[0] < prior.instants[0] ? ["__scalar__"] : [],
    };
  }

  // One side keyed, the other legacy: format migration. Shared regression cannot
  // be named; allow the transition and record the set change so receipts stay
  // honest. A later keyed-to-keyed publish restores per-source refusal.
  if (format_changed) {
    return {
      regressed: false,
      source_set_changed: true,
      format_changed: true,
      shared_regressed: [],
      added: current.keyed ? Object.keys(current.map).sort() : [],
      removed: prior.keyed ? Object.keys(prior.map).sort() : [],
      prior_keyed: prior.keyed,
      current_keyed: current.keyed,
    };
  }

  // Legacy unkeyed multi-component: component disappearance is a source-set
  // change, not a regression. Positional alignment after a set change is what
  // falsely refused the agency-obligations refresh. Without names we cannot
  // prove a shared source moved backwards, so we allow the set change.
  const priorBag = multiset(prior.instants);
  const currentBag = multiset(current.instants);
  const shared = [...priorBag.keys()].filter((key) => currentBag.has(key));
  const removedCount = [...priorBag.entries()]
    .reduce((sum, [key, count]) => sum + Math.max(0, count - (currentBag.get(key) || 0)), 0);
  const addedCount = [...currentBag.entries()]
    .reduce((sum, [key, count]) => sum + Math.max(0, count - (priorBag.get(key) || 0)), 0);
  return {
    regressed: false,
    source_set_changed: removedCount > 0 || addedCount > 0 || shared.length !== priorBag.size,
    format_changed: false,
    shared_regressed: [],
    added: addedCount > 0 ? [`__legacy_added__:${addedCount}`] : [],
    removed: removedCount > 0 ? [`__legacy_removed__:${removedCount}`] : [],
    prior_keyed: false,
    current_keyed: false,
  };
}

function multiset(values) {
  const bag = new Map();
  for (const value of values) {
    const key = String(value);
    bag.set(key, (bag.get(key) || 0) + 1);
  }
  return bag;
}

/** True when the current watermark regresses any shared source relative to prior. */
export function watermarkRegressedByCompare(priorValue, currentValue) {
  return compareWatermarks(priorValue, currentValue).regressed;
}
