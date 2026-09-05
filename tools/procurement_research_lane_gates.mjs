#!/usr/bin/env node

/**
 * Ordering and pre-registration gate for the two research lanes that sit
 * beside the procurement pursuit decision surface (card "PPD-07").
 *
 * The registry is site/procurement_research_lanes.json. This tool is what
 * makes that registry mean something: --check fails while any prerequisite
 * card is missing its own evidence, while a runnable lane's pre-registration
 * file is missing or does not match its registered content hash, or while a
 * pre-registration text carries a claim the lane is forbidden to make.
 * --register <lane> records a pre-registration's content hash into the
 * registry, which is what makes a later edit to that file detectable.
 *
 * Hard boundaries, enforced by this file's own shape and by
 * test/procurement_research_lane_gates.test.mjs:
 *   - No network client and no browser client is imported here.
 *   - No argument is a URL. A URL-shaped value is rejected, not fetched.
 *   - No credential, cookie, or sign-in flow is read, written, or simulated.
 *
 * Reused, not reinvented: encodeEntryId() from ./architecture_evidence_shards.mjs
 * is the one place that maps an architecture-evidence entry id to its shard
 * filename.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeEntryId } from "./architecture_evidence_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RESEARCH_LANES_SCHEMA = "cityscroll.procurement_research_lanes.v1";
export const RESEARCH_LANES_RELATIVE = "site/procurement_research_lanes.json";
export const EVIDENCE_SHARD_DIR = "architecture/evidence.d";

/** The only lane statuses this registry understands. */
export const RESEARCH_LANE_STATUS = Object.freeze({
  GATED: "gated",
  DEFERRED: "deferred",
});

/**
 * A pre-registration has to be able to NAME the claims it forbids without
 * tripping its own lint. Text between these two markers is the declared
 * vocabulary of forbidden claims and is excluded from the scan; everything
 * else in the document is scanned.
 */
export const VOCABULARY_FENCE_OPEN = "<!-- forbidden-claims-vocabulary:start -->";
export const VOCABULARY_FENCE_CLOSE = "<!-- forbidden-claims-vocabulary:end -->";

/**
 * Claims a pre-registered lane may not make. An observed association is a
 * statement about what co-occurs in a fixed extract; none of the readings
 * below follow from one, and each of them is the reading a reader supplies
 * for free if the text leaves room for it.
 */
export const FORBIDDEN_CLAIM_RULES = Object.freeze([
  {
    id: "causation",
    label: "causal claim",
    pattern: /\b(caus(?:e|es|ed|ing|al|ation)|because of|due to|leads? to|led to|results? in|resulted in|drives?|driven by|effect of|effects? on|explains?|explained by|attributable to|counterfactual|would have been)\b/gi,
  },
  {
    id: "favoritism",
    label: "favoritism claim",
    pattern: /\b(favor(?:itism|ed|s|ing)?|favour(?:itism|ed|s|ing)?|steered|steering|preferential|advantaged|insider|wired|rigged|rigging)\b/gi,
  },
  {
    id: "irregularity",
    label: "irregularity claim",
    pattern: /\b(irregular(?:ity|ities)?|anomal(?:y|ies|ous)|red flags?|suspicious|improper|impropriety)\b/gi,
  },
  {
    id: "illegality",
    label: "illegality claim",
    pattern: /\b(illegal(?:ity)?|unlawful|violat(?:e|es|ed|ing|ion|ions)|corrupt(?:ion)?|fraud(?:ulent)?|collusion|collusive)\b/gi,
  },
  {
    id: "bidder_count",
    label: "bidder-count claim",
    pattern: /\b(bidders?|bidder counts?|number of bidders|bid counts?|response counts?)\b/gi,
  },
]);

function text(value) {
  return String(value ?? "").trim();
}

/** Drop the declared forbidden-claims vocabulary before linting. */
export function stripVocabularyFences(source) {
  const body = String(source ?? "");
  let out = "";
  let index = 0;
  for (;;) {
    const open = body.indexOf(VOCABULARY_FENCE_OPEN, index);
    if (open < 0) {
      out += body.slice(index);
      return out;
    }
    out += body.slice(index, open);
    const close = body.indexOf(VOCABULARY_FENCE_CLOSE, open);
    if (close < 0) return out;
    index = close + VOCABULARY_FENCE_CLOSE.length;
  }
}

/**
 * Every forbidden claim the text makes outside its declared vocabulary, with
 * the line it sits on so a writer can find it.
 */
export function forbiddenClaimFindings(source) {
  const scanned = stripVocabularyFences(source);
  const lines = scanned.split("\n");
  const findings = [];
  for (const rule of FORBIDDEN_CLAIM_RULES) {
    lines.forEach((line, offset) => {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match = pattern.exec(line);
      while (match) {
        findings.push({ rule: rule.id, label: rule.label, match: match[0], line: offset + 1 });
        match = pattern.exec(line);
      }
    });
  }
  return findings;
}

export function contentHash(source) {
  return createHash("sha256").update(String(source ?? ""), "utf8").digest("hex");
}

function repoPath(root, relative) {
  return isAbsolute(relative) ? relative : join(root, relative);
}

export function shardPathForEntryId(entryId) {
  return `${EVIDENCE_SHARD_DIR}/${encodeEntryId(entryId)}.json`;
}

export function readResearchLaneRegistry(root = ROOT, relative = RESEARCH_LANES_RELATIVE) {
  return JSON.parse(readFileSync(repoPath(root, relative), "utf8"));
}

function runnableLanes(registry) {
  return (registry.lanes || []).filter((lane) => lane && lane.runnable === true);
}

export function researchLaneById(registry, laneId) {
  return (registry.lanes || []).find((lane) => lane && lane.id === laneId) || null;
}

/**
 * The gate. Returns every failure it finds rather than the first, so a caller
 * that is genuinely not ready sees the whole distance rather than one step of
 * it.
 */
export function evaluateResearchLaneGates(registry, { root = ROOT } = {}) {
  const failures = [];
  const fail = (code, detail, extra = {}) => failures.push({ code, detail, ...extra });

  if (!registry || typeof registry !== "object") {
    fail("registry_unreadable", "The research-lane registry is missing or is not an object.");
    return { ok: false, failures, checked: { cards: 0, lanes: 0 } };
  }
  if (registry.schema !== RESEARCH_LANES_SCHEMA) {
    fail("registry_schema", `Expected schema ${RESEARCH_LANES_SCHEMA}, found ${registry.schema || "(none)"}.`);
  }

  const cards = Array.isArray(registry.prerequisite_cards) ? registry.prerequisite_cards : [];
  if (!cards.length) {
    fail("no_prerequisite_cards", "The registry declares no prerequisite cards, so it gates nothing.");
  }

  const cardIds = new Set();
  for (const card of cards) {
    const id = text(card?.card);
    if (!id) {
      fail("card_unnamed", "A prerequisite card entry has no card identifier.");
      continue;
    }
    cardIds.add(id);
    const shards = Array.isArray(card.evidence_shards) ? card.evidence_shards : [];
    const manifests = Array.isArray(card.manifests) ? card.manifests : [];
    if (!shards.length && !manifests.length) {
      fail("card_without_evidence", `Card ${id} declares neither an evidence shard nor a capture manifest.`, { card: id });
    }
    for (const entryId of shards) {
      const relative = shardPathForEntryId(entryId);
      if (!existsSync(repoPath(root, relative))) {
        fail("missing_evidence_shard", `Card ${id} names evidence shard ${entryId}, which is not present at ${relative}.`, { card: id });
      }
    }
    for (const manifest of manifests) {
      const relative = text(manifest);
      if (!relative || !existsSync(repoPath(root, relative))) {
        fail("missing_manifest", `Card ${id} names capture manifest ${relative || "(none)"}, which is not present.`, { card: id });
        continue;
      }
      try {
        JSON.parse(readFileSync(repoPath(root, relative), "utf8"));
      } catch {
        fail("unreadable_manifest", `Card ${id}'s capture manifest ${relative} is not readable JSON.`, { card: id });
      }
    }
  }

  const lanes = Array.isArray(registry.lanes) ? registry.lanes : [];
  if (!lanes.length) fail("no_lanes", "The registry declares no lanes.");

  for (const lane of lanes) {
    const laneId = text(lane?.id);
    if (!laneId) {
      fail("lane_unnamed", "A lane entry has no id.");
      continue;
    }
    const status = text(lane.status);
    if (status !== RESEARCH_LANE_STATUS.GATED && status !== RESEARCH_LANE_STATUS.DEFERRED) {
      fail("lane_status", `Lane ${laneId} carries status ${status || "(none)"}, which is not a known status.`, { lane: laneId });
    }

    if (lane.runnable !== true) {
      // A deferred lane is deferred all the way down: no steps to follow and
      // no pre-registration standing by.
      if (status !== RESEARCH_LANE_STATUS.DEFERRED) {
        fail("lane_not_runnable_not_deferred", `Lane ${laneId} is not runnable but is not marked deferred.`, { lane: laneId });
      }
      if (Array.isArray(lane.steps) ? lane.steps.length : lane.steps) {
        fail("deferred_lane_has_steps", `Deferred lane ${laneId} carries runnable steps.`, { lane: laneId });
      }
      if (lane.preregistration) {
        fail("deferred_lane_registered", `Deferred lane ${laneId} carries a pre-registration.`, { lane: laneId });
      }
      if (!text(lane.deferral_note)) {
        fail("deferred_lane_unexplained", `Deferred lane ${laneId} does not say why it is deferred.`, { lane: laneId });
      }
      continue;
    }

    const prerequisites = Array.isArray(lane.prerequisite_cards) ? lane.prerequisite_cards : [];
    if (!prerequisites.length) {
      fail("lane_without_prerequisites", `Lane ${laneId} names no prerequisite cards.`, { lane: laneId });
    }
    for (const required of prerequisites) {
      if (!cardIds.has(text(required))) {
        fail("lane_prerequisite_unknown", `Lane ${laneId} requires card ${required}, which the registry does not declare.`, { lane: laneId });
      }
    }

    const prereg = lane.preregistration;
    if (!prereg || !text(prereg.path)) {
      fail("preregistration_missing", `Lane ${laneId} has no pre-registration file.`, { lane: laneId });
      continue;
    }
    const relative = text(prereg.path);
    const absolute = repoPath(root, relative);
    if (!existsSync(absolute)) {
      fail("preregistration_file_absent", `Lane ${laneId}'s pre-registration ${relative} is not present.`, { lane: laneId });
      continue;
    }
    const body = readFileSync(absolute, "utf8");
    const registered = text(prereg.content_sha256);
    if (!registered) {
      fail("preregistration_unsigned", `Lane ${laneId}'s pre-registration ${relative} is not registered by content hash. Run: node tools/procurement_research_lane_gates.mjs --register ${laneId}`, { lane: laneId });
    } else if (registered !== contentHash(body)) {
      fail("preregistration_hash_mismatch", `Lane ${laneId}'s pre-registration ${relative} has changed since it was registered.`, { lane: laneId });
    }
    if (!text(prereg.registered_at)) {
      fail("preregistration_undated", `Lane ${laneId}'s pre-registration carries no registration date.`, { lane: laneId });
    }
    for (const finding of forbiddenClaimFindings(body)) {
      fail(
        "forbidden_claim",
        `Lane ${laneId}'s pre-registration ${relative} line ${finding.line} makes a ${finding.label} ("${finding.match}").`,
        { lane: laneId },
      );
    }
  }

  return { ok: failures.length === 0, failures, checked: { cards: cards.length, lanes: lanes.length } };
}

/**
 * Record a pre-registration's content hash into the registry. This is the
 * signing step: after it, an edit to the pre-registration text fails --check.
 */
export function registerPreregistration(laneId, { root = ROOT, relative = RESEARCH_LANES_RELATIVE, now = null } = {}) {
  const registryPath = repoPath(root, relative);
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const lane = researchLaneById(registry, laneId);
  if (!lane) throw new Error(`Unknown research lane: ${laneId}`);
  if (lane.runnable !== true) throw new Error(`Lane ${laneId} is not runnable and cannot be registered.`);
  if (!lane.preregistration || !text(lane.preregistration.path)) {
    throw new Error(`Lane ${laneId} declares no pre-registration path.`);
  }
  const pregPath = repoPath(root, text(lane.preregistration.path));
  if (!existsSync(pregPath)) throw new Error(`Pre-registration not found: ${lane.preregistration.path}`);
  const body = readFileSync(pregPath, "utf8");
  const findings = forbiddenClaimFindings(body);
  if (findings.length) {
    throw new Error(
      `Refusing to register ${laneId}: the pre-registration makes ${findings.length} forbidden claim(s), starting at line ${findings[0].line} ("${findings[0].match}").`,
    );
  }
  lane.preregistration.content_sha256 = contentHash(body);
  lane.preregistration.registered_at = text(now) || new Date().toISOString();
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { lane: laneId, path: lane.preregistration.path, content_sha256: lane.preregistration.content_sha256 };
}

const KNOWN_VALUE_FLAGS = Object.freeze(["--register", "--root", "--registry"]);
const KNOWN_BOOLEAN_FLAGS = Object.freeze(["--check", "--list", "--json"]);
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Argument parsing is a boundary, not a convenience. Every boolean flag is
 * parsed bare, every unknown flag is an error rather than a silent no-op, and
 * a URL-shaped value is refused outright -- this tool has nothing to fetch and
 * no argument that could name a remote host.
 */
export function parseResearchLaneArgv(argv = []) {
  const parsed = {
    check: false,
    list: false,
    json: false,
    register: null,
    root: null,
    registry: null,
    errors: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (URL_SHAPED.test(argument)) {
      parsed.errors.push(`This tool takes no URL argument; refused: ${argument}`);
      continue;
    }
    if (KNOWN_BOOLEAN_FLAGS.includes(argument)) {
      parsed[argument.slice(2)] = true;
      continue;
    }
    if (KNOWN_VALUE_FLAGS.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        parsed.errors.push(`${argument} requires a value.`);
        continue;
      }
      index += 1;
      if (URL_SHAPED.test(String(value))) {
        parsed.errors.push(`This tool takes no URL argument; refused: ${value}`);
        continue;
      }
      parsed[argument.slice(2)] = String(value);
      continue;
    }
    parsed.errors.push(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseResearchLaneArgv(argv);
  if (parsed.errors.length) {
    for (const error of parsed.errors) console.error(error);
    return 2;
  }
  const root = resolve(parsed.root || ROOT);
  const relative = parsed.registry || RESEARCH_LANES_RELATIVE;

  if (parsed.register) {
    const result = registerPreregistration(parsed.register, { root, relative });
    console.log(`Registered ${result.lane}: ${result.path} -> ${result.content_sha256}`);
    return 0;
  }

  const registry = readResearchLaneRegistry(root, relative);

  if (parsed.list) {
    for (const lane of registry.lanes || []) {
      console.log(`${lane.id}\t${lane.status}\t${lane.runnable ? "runnable" : "not runnable"}`);
    }
    return 0;
  }

  const result = evaluateResearchLaneGates(registry, { root });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (result.ok) {
    console.log(
      `Research lane gate: ok. ${result.checked.cards} prerequisite card(s) carry their own evidence; ` +
        `${runnableLanes(registry).length} runnable lane(s) are pre-registered by content hash.`,
    );
    return 0;
  }
  console.error(`Research lane gate: ${result.failures.length} failure(s).`);
  for (const failure of result.failures) console.error(`  [${failure.code}] ${failure.detail}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
