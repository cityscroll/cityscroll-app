#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REGISTRY_PATH = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const INVENTORY_PATH = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const RECEIPT_PATH = join(ROOT, "site/data/non_council_outcome_sources/verification_receipts/community_board_sources_2026-08-13.json");
const RESOURCE_MATRIX_PATH = join(ROOT, "docs/evidence/community-board-resources/resource-matrix-2026-08-13.json");
const CB15_EVIDENCE_PATH = join(ROOT, "docs/evidence/community-board-resources/cb15-destination-evidence-2026-08-13.json");
const INVENTORY_SCHEMA = "cityscroll.community_board_source_inventory.v1";
const RECEIPT_SCHEMA = "cityscroll.community_board_source_receipt.v1";
const RESOURCE_MATRIX_SCHEMA = "cityscroll.community_board_resource_matrix.v1";
const CB15_EVIDENCE_SCHEMA = "cityscroll.community_board_destination_evidence.v1";
const OBSERVED_ON = "2026-08-13";
const RECEIPT_REF = "site/data/non_council_outcome_sources/verification_receipts/community_board_sources_2026-08-13.json";
const ROLES = ["upcoming_meetings", "minutes", "committees", "roster", "bylaws"];
const RESOURCE_TASKS = ["calendar", "agenda", "minutes", "committees", "roster", "bylaws", "contact"];

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function unknownArchiveDepth() { return { status: "unknown", earliest_year: null, latest_year: null }; }
function isUrl(value) { return typeof value === "string" && /^https:\/\//.test(value); }

function sourceOrigin(url) {
  if (!url) return null;
  if (/cityrecord\.nyc\.gov|a856-cityrecord\.nyc\.gov/i.test(url)) return "city_record";
  if (/airtable|drive\.google|calendar\.google|dropbox|vimeo|youtube/i.test(url)) return "third_party_storage";
  if (/nyc\.gov/i.test(url)) return "nyc_official";
  return "board_owned_official";
}

function publisherFor(board, origin) {
  if (origin === "nyc_official") return "NYC Community Boards";
  if (origin === "city_record") return "City Record";
  if (origin === "third_party_storage") return board.name;
  if (origin === "board_owned_official") return board.name;
  return null;
}

function fetchability(fetchMode) {
  if (!fetchMode) return "unknown";
  return /browser|api/i.test(fetchMode) ? "browser_required" : "machine_fetchable";
}

function roleRecord(board, role, raw, registryRole) {
  const source = { ...(raw || {}), ...(registryRole || {}) };
  const url = source.url || source.source_url || null;
  const origin = sourceOrigin(url);
  const observed = Boolean(url);
  const stableKey = role === "upcoming_meetings"
    ? "publisher_event_id|start_at"
    : "publisher_document_id|document_url";
  const archiveDepth = source.archive_depth
    || (role === "minutes" && board.source_url === url ? board.archive_depth : null)
    || unknownArchiveDepth();
  return {
    source_type: role,
    ...(source.adapter ? { adapter: source.adapter } : {}),
    publisher: publisherFor(board, origin),
    publisher_kind: origin,
    url: isUrl(url) ? url : null,
    format: source.format || null,
    fetch_mode: source.fetch_mode || null,
    access_constraint: source.access_constraint || null,
    seen_on: OBSERVED_ON,
    archive_depth: archiveDepth,
    stable_key: observed ? stableKey : null,
    stable_event_key: role === "upcoming_meetings" && observed ? stableKey : null,
    stable_document_key: role === "minutes" && observed ? stableKey : null,
    status: observed ? "verified" : "absent_in_pass",
    verification: {
      status: observed ? "observed" : "not_observed",
      seen_on: OBSERVED_ON,
      fetchability: observed ? fetchability(source.fetch_mode) : "unknown",
      access_note: source.verification?.access_note === "browser_required"
        ? "browser_protected"
        : source.verification?.access_note || source.access_constraint || null,
      receipt_ref: RECEIPT_REF,
      reason: observed ? null : "not_observed_in_pass",
    },
  };
}

function sourceRolesFromRegistry(registryRow, oldRow) {
  const oldRoles = {
    upcoming_meetings: oldRow?.upcoming,
    minutes: oldRow?.minutes,
    committees: oldRow?.committees,
    roster: oldRow?.roster,
    bylaws: oldRow?.bylaws,
  };
  const registryRoles = registryRow.source_roles || {};
  return Object.fromEntries(ROLES.map((role) => [role, roleRecord(
    registryRow,
    role,
    oldRoles[role],
    registryRoles[role],
  )]));
}

function resourceDestination(task, source, { fallback = null, sourceRole = null, reason = null } = {}) {
  const url = isUrl(source?.url) ? source.url : null;
  return {
    task,
    url,
    source_role: sourceRole,
    publisher: source?.publisher || null,
    publisher_kind: source?.publisher_kind || null,
    format: source?.format || null,
    observed_on: source?.seen_on || OBSERVED_ON,
    status: url ? "verified_destination" : "not_observed",
    verification: {
      status: url ? "observed_url" : "not_observed",
      content_current: false,
      receipt_ref: url ? (source?.verification?.receipt_ref || RECEIPT_REF) : RECEIPT_REF,
      reason: url ? null : (reason || "no_explicit_destination_in_reviewed_pass"),
    },
    ...(fallback ? { fallback } : {}),
  };
}

function agendaSource(upcoming, minutes) {
  const candidates = [upcoming, minutes].filter((source) => isUrl(source?.url));
  return candidates.find((source) => /agenda/i.test(`${source.url} ${source.format || ""}`)) || null;
}

function contactDestination(registryRow) {
  const homepage = isUrl(registryRow.homepage_url)
    ? resourceDestination("contact", {
      url: registryRow.homepage_url,
      publisher: publisherFor(registryRow, sourceOrigin(registryRow.homepage_url)),
      publisher_kind: sourceOrigin(registryRow.homepage_url),
      format: "official board homepage",
      seen_on: OBSERVED_ON,
      verification: { receipt_ref: RECEIPT_REF },
    }, { sourceRole: "homepage_url" })
    : null;
  const directory = isUrl(registryRow.directory_url)
    ? {
      task: "contact_fallback",
      url: registryRow.directory_url,
      source_role: "directory_url",
      publisher: "NYC Community Boards",
      publisher_kind: "nyc_official",
      format: "official city directory entry",
      observed_on: OBSERVED_ON,
      status: "verified_destination",
      verification: {
        status: "observed_url",
        content_current: false,
        receipt_ref: RECEIPT_REF,
        reason: null,
      },
    }
    : null;
  if (homepage) return { ...homepage, fallback: directory };
  return directory ? resourceDestination("contact", directory, { sourceRole: "directory_url" }) : resourceDestination("contact", null, { sourceRole: null });
}

function resourceTasksForBoard(registryRow, sourceRoles) {
  const upcoming = sourceRoles.upcoming_meetings;
  const minutes = sourceRoles.minutes;
  const agenda = agendaSource(upcoming, minutes);
  return [
    resourceDestination("calendar", upcoming, { sourceRole: "upcoming_meetings" }),
    resourceDestination("agenda", agenda, {
      sourceRole: agenda === upcoming ? "upcoming_meetings" : agenda === minutes ? "minutes" : null,
      reason: "no_explicit_agenda_destination_in_reviewed_pass",
    }),
    resourceDestination("minutes", minutes, { sourceRole: "minutes" }),
    resourceDestination("committees", sourceRoles.committees, { sourceRole: "committees" }),
    resourceDestination("roster", sourceRoles.roster, { sourceRole: "roster" }),
    resourceDestination("bylaws", sourceRoles.bylaws, { sourceRole: "bylaws" }),
    contactDestination(registryRow),
  ];
}

function assertRoster(registry) {
  const boards = registry.sources.filter((row) => row.body_type === "community_board");
  if (boards.length !== 59) throw new Error(`expected 59 roster boards, found ${boards.length}`);
  const ids = new Set(boards.map((row) => row.body_id));
  if (ids.size !== 59) throw new Error("official roster has duplicate board IDs");
  const expected = ["Bronx:12", "Brooklyn:18", "Manhattan:12", "Queens:14", "Staten Island:3"];
  const actual = Object.entries(boards.reduce((counts, row) => {
    counts[row.borough] = (counts[row.borough] || 0) + 1;
    return counts;
  }, {})).map(([borough, count]) => `${borough}:${count}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`official roster borough counts changed: ${actual.join(",")}`);
  return boards;
}

function build(registry, existing) {
  const oldById = new Map((existing.boards || []).map((row) => [row.id, row]));
  const boards = assertRoster(registry).map((registryRow) => {
    const old = oldById.get(registryRow.body_id) || {};
    const sources = sourceRolesFromRegistry(registryRow, old);
    return {
      id: registryRow.body_id,
      name: registryRow.name,
      borough: registryRow.borough,
      district: registryRow.district,
      home: registryRow.homepage_url || old.home || null,
      observed: OBSERVED_ON,
      upcoming: sources.upcoming_meetings,
      minutes: sources.minutes,
      committees: sources.committees,
      roster: sources.roster,
      bylaws: sources.bylaws,
      resource_tasks: resourceTasksForBoard(registryRow, sources),
    };
  });
  return {
    schema: INVENTORY_SCHEMA,
    observed_on: OBSERVED_ON,
    policy: {
      source_registry: "site/data/non_council_outcome_sources/source_registry.json",
      roster: "source_registry.sources where body_type=community_board",
      source_urls_are_explicit: true,
      no_url_inference: true,
      inventory_only_is_not_absent_publication: true,
      source_registry_is_url_authority: true,
      publisher_kinds: ["nyc_official", "board_owned_official", "city_record", "third_party_storage"],
    },
    resource_matrix: {
      schema: RESOURCE_MATRIX_SCHEMA,
      observed_on: OBSERVED_ON,
      tasks: RESOURCE_TASKS,
      destination_status: "reviewed_destination_only",
      content_current_is_not_asserted: true,
      identity: "board_id is the exact source-registry body_id; tasks never cross board identities",
    },
    coverage: { boards: 59, source_roles: ROLES },
    boards,
  };
}

function resourceMatrix(inventory) {
  return {
    schema: RESOURCE_MATRIX_SCHEMA,
    observed_on: inventory.observed_on,
    source_vintage: RECEIPT_REF,
    scope: { board_count: inventory.boards.length, board_identity: "source_registry.body_id" },
    tasks: RESOURCE_TASKS,
    policy: {
      status_means_reviewed_destination: true,
      link_does_not_prove_current_content: true,
      missing_task_is_not_publication_absence: true,
    },
    boards: inventory.boards.map((board) => ({
      board_id: board.id,
      name: board.name,
      borough: board.borough,
      district: board.district,
      destinations: board.resource_tasks,
    })),
  };
}

function cb15Evidence(inventory) {
  const board = inventory.boards.find((row) => row.id === "brooklyn-cb-15");
  return {
    schema: CB15_EVIDENCE_SCHEMA,
    observed_on: inventory.observed_on,
    source_vintage: RECEIPT_REF,
    board_id: board.id,
    route: "/community-boards/brooklyn-cb-15/",
    assertion: "The board page receives every reviewed official destination for this exact board identity; a destination link does not assert that its publisher has current content.",
    destinations: board.resource_tasks.filter((task) => task.url).map((task) => ({
      task: task.task,
      url: task.url,
      source_role: task.source_role,
      publisher: task.publisher,
      observed_on: task.observed_on,
      fallback: task.fallback?.url || null,
    })),
  };
}

function withRegistryRoles(registry, inventory) {
  const byId = new Map(inventory.boards.map((row) => [row.id, row]));
  return {
    ...registry,
    sources: registry.sources.map((row) => {
      if (row.body_type !== "community_board") return row;
      const board = byId.get(row.body_id);
      const roles = Object.fromEntries(ROLES.map((role) => {
        const value = board[role === "upcoming_meetings" ? "upcoming" : role];
        return [role, { ...value, source_type: role }];
      }));
      return { ...row, source_roles: roles };
    }),
  };
}

function buildReceipt(inventory) {
  const sources = [];
  for (const board of inventory.boards) {
    for (const role of ROLES) {
      const value = board[role === "upcoming_meetings" ? "upcoming" : role];
      sources.push({
        board_id: board.id,
        role,
        publisher: value.publisher,
        publisher_kind: value.publisher_kind,
        url: value.url,
        seen_on: value.seen_on,
        format: value.format,
        fetchability: value.verification.fetchability,
        access_note: value.verification.access_note,
        status: value.verification.status,
        reason: value.verification.reason,
      });
    }
  }
  return {
    schema: RECEIPT_SCHEMA,
    seen_on: OBSERVED_ON,
    roster_source: "https://www.nyc.gov/site/communityboards/about/borough-boards.page",
    inventory: "site/data/non_council_outcome_sources/board_source_inventory.json",
    sources,
  };
}

const check = process.argv.includes("--check");
const registry = readJson(REGISTRY_PATH);
const existing = readJson(INVENTORY_PATH);
const inventory = build(registry, existing);
const registryWithRoles = withRegistryRoles(registry, inventory);
const receipt = buildReceipt(inventory);
const matrix = resourceMatrix(inventory);
const cb15 = cb15Evidence(inventory);

if (check) {
  if (JSON.stringify(existing) !== JSON.stringify(inventory)) throw new Error("board source inventory is stale; run without --check");
  const committedRegistry = readJson(REGISTRY_PATH);
  if (JSON.stringify(committedRegistry) !== JSON.stringify(registryWithRoles)) throw new Error("source registry board roles are stale; run without --check");
  const committedReceipt = readJson(RECEIPT_PATH);
  if (JSON.stringify(committedReceipt) !== JSON.stringify(receipt)) throw new Error("community board source receipt is stale; run without --check");
  const committedMatrix = readJson(RESOURCE_MATRIX_PATH);
  if (JSON.stringify(committedMatrix) !== JSON.stringify(matrix)) throw new Error("community board resource matrix is stale; run without --check");
  const committedCb15 = readJson(CB15_EVIDENCE_PATH);
  if (JSON.stringify(committedCb15) !== JSON.stringify(cb15)) throw new Error("CB15 destination evidence is stale; run without --check");
  console.log(`checked ${inventory.boards.length} boards and ${receipt.sources.length} role receipts`);
} else {
  writeJson(REGISTRY_PATH, registryWithRoles);
  writeJson(INVENTORY_PATH, inventory);
  writeJson(RECEIPT_PATH, receipt);
  writeJson(RESOURCE_MATRIX_PATH, matrix);
  writeJson(CB15_EVIDENCE_PATH, cb15);
  console.log(`wrote ${inventory.boards.length} boards and ${receipt.sources.length} role receipts`);
}
