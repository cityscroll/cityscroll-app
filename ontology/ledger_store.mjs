// Per-card multi-flywheel ledger storage.
//
// Source of truth is one JSON record per card under a ledger directory so two
// concurrent cranks that touch different cards produce non-overlapping diffs.
// The in-memory shape remains cityscroll.multi_flywheel_ledger.v0
// ({ schema, policy_version, updated_at, note?, cards: { [id]: entry } }).
//
// Layout when path is ontology/queue/ledger.json (or …/ledger/):
//   ontology/queue/ledger/meta.json
//   ontology/queue/ledger/cards/<safe-id>.json
//
// ledger.json becomes a thin pointer (or optional full aggregate projection).
// Cranks write only the card files they change — never rewrite the full map.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  emptyLedger,
  LEDGER_SCHEMA,
} from "./card_queue.mjs";
import { MULTI_FLYWHEEL_POLICY_VERSION } from "./dimensions/shared.mjs";

export const LEDGER_STORAGE_VERSION = "per_card_v1";
export const LEDGER_CARD_SCHEMA = "cityscroll.multi_flywheel_ledger_card.v0";
export const LEDGER_META_SCHEMA = "cityscroll.multi_flywheel_ledger_meta.v0";

/**
 * Stable filesystem name for a card id (keeps alphanumerics, turns rest into _).
 * @param {string} id
 */
export function cardIdToFilename(id) {
  const safe = String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!safe) throw new Error("card id is empty after sanitization");
  return `${safe}.json`;
}

/**
 * Resolve the directory that holds meta.json + cards/ for a ledger path.
 * Accepts either …/ledger.json or …/ledger/.
 * @param {string} ledgerPath
 */
export function ledgerStoreDir(ledgerPath) {
  const resolved = resolve(ledgerPath);
  if (resolved.endsWith(".json")) {
    return join(dirname(resolved), "ledger");
  }
  return resolved;
}

/**
 * Path to the pointer / optional aggregate next to a directory store.
 * @param {string} ledgerPath
 */
export function ledgerAggregatePath(ledgerPath) {
  const resolved = resolve(ledgerPath);
  if (resolved.endsWith(".json")) return resolved;
  return join(dirname(resolved), "ledger.json");
}

export function ledgerMetaPath(storeDir) {
  return join(storeDir, "meta.json");
}

export function ledgerCardsDir(storeDir) {
  return join(storeDir, "cards");
}

/**
 * Fold meta + per-card map-values into the classic ledger object.
 * Pure — no I/O. `cards` values are already classic map values (no storage schema).
 * @param {{ schema?: string, policy_version?: string, updated_at?: string, note?: string|null }} meta
 * @param {Record<string, object>} cards
 */
export function foldLedger(meta = {}, cards = {}) {
  const cardMap = {};
  for (const [id, entry] of Object.entries(cards || {})) {
    if (!id || !entry || typeof entry !== "object") continue;
    cardMap[id] = { ...entry };
  }
  const updatedFromCards = Object.values(cardMap)
    .map((c) => c.last_seen_at || c.fixed_at || c.last_verified_at || null)
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    schema: meta.schema || LEDGER_SCHEMA,
    policy_version: meta.policy_version || MULTI_FLYWHEEL_POLICY_VERSION,
    updated_at: meta.updated_at || updatedFromCards || "1970-01-01T00:00:00.000Z",
    ...(meta.note != null && meta.note !== "" ? { note: meta.note } : {}),
    cards: cardMap,
  };
}

/**
 * Serialize one classic map value into a per-card file document.
 * Always stamps `id` for addressability. When the classic value itself carried
 * an `id` field, set `retain_map_id` so the fold restores it.
 * @param {string} id
 * @param {object} entry — classic cards[id] value
 */
export function serializeCardEntry(id, entry = {}) {
  const classic = entry && typeof entry === "object" ? { ...entry } : {};
  const retainMapId = Object.prototype.hasOwnProperty.call(classic, "id");
  // Drop storage-only keys if a caller passed a file-shaped object through.
  delete classic.schema;
  delete classic.retain_map_id;
  return {
    schema: LEDGER_CARD_SCHEMA,
    id,
    ...(retainMapId ? { retain_map_id: true } : {}),
    ...classic,
    // Ensure file-level id is the map key (embedded classic id kept via spread
    // when retainMapId; otherwise classic had no id field).
    id,
  };
}

/**
 * Parse a per-card file document into { id, classic } where classic is the
 * cards[id] map value (storage fields removed; embedded id restored only when
 * retain_map_id is set).
 * @param {object} raw
 * @param {string} [fallbackId]
 */
export function parseCardEntry(raw, fallbackId = "") {
  const id = (raw && raw.id) || fallbackId;
  if (!id) throw new Error("card entry missing id");
  const retainMapId = raw?.retain_map_id === true;
  const classic = { ...(raw || {}) };
  delete classic.schema;
  delete classic.retain_map_id;
  if (!retainMapId) {
    delete classic.id;
  } else if (classic.id == null) {
    classic.id = id;
  }
  return { id, classic };
}

/**
 * Split a classic ledger object into meta + classic card map (pure).
 * @param {object} ledger
 */
export function splitLedger(ledger = {}) {
  const cards = {};
  for (const [id, entry] of Object.entries(ledger.cards || {})) {
    cards[id] = entry && typeof entry === "object" ? { ...entry } : {};
  }
  const meta = {
    schema: LEDGER_META_SCHEMA,
    storage: LEDGER_STORAGE_VERSION,
    ledger_schema: ledger.schema || LEDGER_SCHEMA,
    policy_version: ledger.policy_version || MULTI_FLYWHEEL_POLICY_VERSION,
    updated_at: ledger.updated_at || "1970-01-01T00:00:00.000Z",
    ...(ledger.note != null && ledger.note !== "" ? { note: ledger.note } : {}),
    card_count: Object.keys(cards).length,
  };
  return { meta, cards };
}

/**
 * True when the directory store already has at least one card file.
 * @param {string} storeDir
 */
export function hasPerCardStore(storeDir) {
  const cardsDir = ledgerCardsDir(storeDir);
  if (!existsSync(cardsDir)) return false;
  return readdirSync(cardsDir).some((name) => name.endsWith(".json"));
}

/**
 * Load classic card map values from a cards directory.
 * @param {string} cardsDir
 * @returns {Record<string, object>}
 */
export function readCardEntries(cardsDir) {
  if (!existsSync(cardsDir)) return {};
  const out = {};
  for (const name of readdirSync(cardsDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(cardsDir, name), "utf8"));
    const { id, classic } = parseCardEntry(raw, name.replace(/\.json$/, ""));
    out[id] = classic;
  }
  return out;
}

/**
 * Load a ledger from either a per-card directory store or a legacy monolithic file.
 * When both exist, the per-card store wins (source of truth).
 *
 * @param {string} ledgerPath — path to ledger.json or a ledger/ directory
 */
export function loadLedgerStore(ledgerPath) {
  const storeDir = ledgerStoreDir(ledgerPath);
  const aggregatePath = ledgerAggregatePath(ledgerPath);

  if (hasPerCardStore(storeDir)) {
    const metaPath = ledgerMetaPath(storeDir);
    let meta = {
      schema: LEDGER_META_SCHEMA,
      storage: LEDGER_STORAGE_VERSION,
      ledger_schema: LEDGER_SCHEMA,
      policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
      updated_at: "1970-01-01T00:00:00.000Z",
    };
    if (existsSync(metaPath)) {
      meta = { ...meta, ...JSON.parse(readFileSync(metaPath, "utf8")) };
    }
    const cards = readCardEntries(ledgerCardsDir(storeDir));
    return foldLedger(
      {
        schema: meta.ledger_schema || LEDGER_SCHEMA,
        policy_version: meta.policy_version,
        updated_at: meta.updated_at,
        note: meta.note,
      },
      cards,
    );
  }

  // Legacy / temp-file mode: a single JSON document with a cards map.
  if (existsSync(aggregatePath) && statSync(aggregatePath).isFile()) {
    const raw = JSON.parse(readFileSync(aggregatePath, "utf8"));
    // Thin pointer (no cards map) without a directory store → empty ledger.
    if (raw.storage === LEDGER_STORAGE_VERSION && (!raw.cards || typeof raw.cards !== "object")) {
      return emptyLedger({ updated_at: raw.updated_at });
    }
    if (!raw.cards || typeof raw.cards !== "object") {
      return { ...emptyLedger(), ...raw, cards: {} };
    }
    return raw;
  }

  return emptyLedger();
}

/**
 * Write only the named card ids (or every card when dirtyIds is null) into the
 * per-card store. Does not rewrite untouched card files — concurrent cranks that
 * touch different cards therefore produce non-overlapping diffs.
 *
 * Also refreshes meta.json. Optionally writes a full aggregate projection when
 * writeAggregate is true (default false for merge safety). Always keeps a thin
 * pointer at ledger.json when the path ends in ledger.json.
 *
 * @param {string} ledgerPath
 * @param {object} ledger — classic in-memory ledger
 * @param {{ dirtyIds?: string[]|null, writeAggregate?: boolean, removeMissing?: boolean, writePointer?: boolean }} [opts]
 */
export function writeLedgerStore(ledgerPath, ledger, opts = {}) {
  const dirtyIds = opts.dirtyIds === undefined ? null : opts.dirtyIds;
  const writeAggregate = opts.writeAggregate === true;
  const removeMissing = opts.removeMissing === true;
  const writePointer = opts.writePointer !== false;
  const storeDir = ledgerStoreDir(ledgerPath);
  const cardsDir = ledgerCardsDir(storeDir);
  mkdirSync(cardsDir, { recursive: true });

  const { meta, cards } = splitLedger(ledger);
  const idsToWrite =
    dirtyIds == null
      ? Object.keys(cards)
      : [...new Set(dirtyIds.filter((id) => id && cards[id]))];

  for (const id of idsToWrite) {
    const file = join(cardsDir, cardIdToFilename(id));
    writeFileSync(file, `${JSON.stringify(serializeCardEntry(id, cards[id]), null, 2)}\n`);
  }

  if (removeMissing) {
    const keep = new Set(Object.keys(cards).map(cardIdToFilename));
    for (const name of readdirSync(cardsDir)) {
      if (!name.endsWith(".json")) continue;
      if (!keep.has(name)) unlinkSync(join(cardsDir, name));
    }
  }

  // Meta is shared; keep it small so rare conflicts are cheap to resolve.
  const metaOut = {
    schema: LEDGER_META_SCHEMA,
    storage: LEDGER_STORAGE_VERSION,
    ledger_schema: meta.ledger_schema || LEDGER_SCHEMA,
    policy_version: meta.policy_version,
    updated_at: meta.updated_at,
    ...(meta.note != null && meta.note !== "" ? { note: meta.note } : {}),
    card_count: Object.keys(cards).length,
  };
  writeFileSync(ledgerMetaPath(storeDir), `${JSON.stringify(metaOut, null, 2)}\n`);

  const aggregatePath = ledgerAggregatePath(ledgerPath);
  if (writeAggregate) {
    writeFileSync(
      aggregatePath,
      `${JSON.stringify(
        foldLedger(
          {
            schema: metaOut.ledger_schema,
            policy_version: metaOut.policy_version,
            updated_at: metaOut.updated_at,
            note: metaOut.note,
          },
          cards,
        ),
        null,
        2,
      )}\n`,
    );
  } else if (writePointer && aggregatePath.endsWith("ledger.json")) {
    writeFileSync(
      aggregatePath,
      `${JSON.stringify(
        {
          schema: LEDGER_SCHEMA,
          storage: LEDGER_STORAGE_VERSION,
          policy_version: metaOut.policy_version,
          updated_at: metaOut.updated_at,
          ...(metaOut.note != null && metaOut.note !== "" ? { note: metaOut.note } : {}),
          cards_dir: "ledger/cards",
          meta_path: "ledger/meta.json",
          card_count: metaOut.card_count,
          note_storage:
            "Source of truth is ontology/queue/ledger/cards/<id>.json (one record per card). Fold with ontology/ledger_store.mjs loadLedgerStore.",
        },
        null,
        2,
      )}\n`,
    );
  }

  return {
    storeDir,
    cardsDir,
    written: idsToWrite,
    card_count: Object.keys(cards).length,
  };
}

/**
 * Diff two classic ledgers; return card ids whose JSON projection changed.
 * @param {object} before
 * @param {object} after
 */
export function dirtyCardIds(before = {}, after = {}) {
  const ids = new Set([
    ...Object.keys(before.cards || {}),
    ...Object.keys(after.cards || {}),
  ]);
  const dirty = [];
  for (const id of ids) {
    const a = before.cards?.[id];
    const b = after.cards?.[id];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) dirty.push(id);
  }
  return dirty.sort();
}

/**
 * Migrate a monolithic ledger file into the per-card store and write a thin
 * pointer at the aggregate path.
 * @param {string} ledgerPath
 * @param {{ writeAggregate?: boolean }} [opts]
 */
export function migrateMonolithicLedger(ledgerPath, opts = {}) {
  const writeAggregate = opts.writeAggregate === true;
  const aggregatePath = ledgerAggregatePath(ledgerPath);
  const storeDir = ledgerStoreDir(ledgerPath);

  // Prefer an existing per-card store (idempotent).
  if (hasPerCardStore(storeDir)) {
    // If aggregate is still a full monolithic dump, replace with pointer.
    if (existsSync(aggregatePath)) {
      const raw = JSON.parse(readFileSync(aggregatePath, "utf8"));
      if (raw.cards && typeof raw.cards === "object" && Object.keys(raw.cards).length) {
        const ledger = loadLedgerStore(ledgerPath);
        writeLedgerStore(ledgerPath, ledger, {
          dirtyIds: [],
          writeAggregate,
          writePointer: !writeAggregate,
        });
        return {
          migrated: true,
          reason: "pointer_refreshed",
          card_count: Object.keys(ledger.cards).length,
          ledger,
        };
      }
    }
    return { migrated: false, reason: "already_per_card", ledger: loadLedgerStore(ledgerPath) };
  }

  let ledger = emptyLedger();
  if (existsSync(aggregatePath)) {
    const raw = JSON.parse(readFileSync(aggregatePath, "utf8"));
    if (raw.cards && typeof raw.cards === "object") {
      ledger = raw;
    }
  }

  const result = writeLedgerStore(ledgerPath, ledger, {
    dirtyIds: null,
    writeAggregate,
    writePointer: !writeAggregate,
    removeMissing: true,
  });
  return { migrated: true, ...result, ledger };
}

/**
 * Rebuild the classic aggregate object from the per-card store (pure projection).
 * @param {string} ledgerPath
 */
export function rebuildAggregateFromStore(ledgerPath) {
  return loadLedgerStore(ledgerPath);
}
