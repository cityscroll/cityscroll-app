// Read-only ER shadow monitoring. The monitor measures immutable observations,
// matcher candidates, and stored shadow decisions without writing review or link state.

import { createHash } from "node:crypto";

import {
  CANDIDATE_GENERATION_VERSION,
  generateCandidates,
} from "../candidate_generation/index.mjs";
import { extractFeatures } from "../features/index.mjs";
import { MATCHERS_VERSION, scorePair } from "../matchers/index.mjs";
import {
  AUTHORITY_LABEL,
  AUTHORITY_VERSION,
  deriveAuthorityCases,
  latestSourceRecords,
  predictAuthorityCases,
} from "./authority.mjs";

export const SHADOW_MONITOR_SCHEMA_VERSION = 1;
export const SHADOW_MONITOR_VERSION = "shadow_monitor_v1";
export const DEFAULT_MONITOR_WINDOW_DAYS = 30;
export const DEFAULT_SOURCE_STALE_AFTER_DAYS = 2;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceRecordId(row) {
  return clean(row?.source_record_id)
    || [row?.source_system, row?.source_system_id, row?.content_hash].map(clean).join(":");
}

function nativeRecordId(row) {
  return `${clean(row?.source_system)}:${clean(row?.source_system_id)}`;
}

function rate(numerator, denominator, caveat = null) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  return {
    status: d > 0 ? "measured" : "insufficient",
    numerator: n,
    denominator: d,
    value: d > 0 ? n / d : null,
    caveat: d > 0 ? caveat : (caveat || "No eligible observations were available."),
  };
}

function finiteTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function observationFromSource(row) {
  const snapshot = parseObject(row.normalized_snapshot);
  const displayName = clean(
    snapshot.vendor_name || snapshot.display_name || snapshot.name || snapshot.title || snapshot.short_title,
  );
  return {
    source_record_id: sourceRecordId(row),
    native_record_id: nativeRecordId(row),
    source_system: clean(row.source_system),
    source_system_id: clean(row.source_system_id),
    display_name: displayName,
    vendor_name: clean(snapshot.vendor_name),
    entity_type: "vendor",
    attrs: snapshot,
    ingested_at: clean(row.ingested_at),
  };
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function scoreDistribution(predictions) {
  const scores = predictions
    .map((prediction) => Number(prediction.confidence))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const buckets = {
    "[0,0.5)": 0,
    "[0.5,0.8)": 0,
    "[0.8,0.9)": 0,
    "[0.9,0.95)": 0,
    "[0.95,1]": 0,
  };
  for (const score of scores) {
    if (score < 0.5) buckets["[0,0.5)"] += 1;
    else if (score < 0.8) buckets["[0.5,0.8)"] += 1;
    else if (score < 0.9) buckets["[0.8,0.9)"] += 1;
    else if (score < 0.95) buckets["[0.9,0.95)"] += 1;
    else buckets["[0.95,1]"] += 1;
  }
  const decisions = { same: 0, different: 0, unresolved: 0 };
  for (const prediction of predictions) {
    const decision = clean(prediction.decision) || "unresolved";
    decisions[decision] = (decisions[decision] || 0) + 1;
  }
  return {
    status: scores.length ? "measured" : "insufficient",
    count: scores.length,
    minimum: scores.at(0) ?? null,
    p50: quantile(scores, 0.5),
    p90: quantile(scores, 0.9),
    maximum: scores.at(-1) ?? null,
    buckets,
    decisions,
  };
}

function candidateSignals(latestRows, links) {
  const observations = latestRows.map(observationFromSource).filter((row) => row.vendor_name);
  const candidates = generateCandidates(observations, { blocker: "token_v0", entityType: "vendor" });
  const predictions = candidates.map((candidate) => scorePair(
    candidate.left,
    candidate.right,
    extractFeatures(candidate.left, candidate.right, { entityType: "vendor" }),
  ));
  const linkedCanonical = new Map();
  for (const link of links) {
    if (clean(link.decision) !== "auto_link" || !clean(link.canonical_entity_id)) continue;
    const set = linkedCanonical.get(clean(link.source_record_id)) || new Set();
    set.add(clean(link.canonical_entity_id));
    linkedCanonical.set(clean(link.source_record_id), set);
  }
  let unresolved = 0;
  let falseSplitLeads = 0;
  candidates.forEach((candidate, index) => {
    const prediction = predictions[index];
    if (prediction.decision === "unresolved") unresolved += 1;
    const left = linkedCanonical.get(candidate.left.source_record_id) || new Set();
    const right = linkedCanonical.get(candidate.right.source_record_id) || new Set();
    const sharesCanonical = [...left].some((id) => right.has(id));
    if (!sharesCanonical && prediction.decision !== "different") falseSplitLeads += 1;
  });
  return {
    observations: observations.length,
    candidates: candidates.length,
    unresolved_rate: rate(unresolved, candidates.length),
    false_split_leads_per_observation: rate(falseSplitLeads, observations.length),
    score_distribution: scoreDistribution(predictions),
  };
}

function authoritySignals(sourceRows) {
  const cases = sourceRows.length ? deriveAuthorityCases(sourceRows) : [];
  const predictions = predictAuthorityCases(cases);
  const same = cases.filter((row) => row.authority_label === AUTHORITY_LABEL.SAME);
  const conflicts = cases.filter((row) => row.authority_label === AUTHORITY_LABEL.NEVER_AUTO);
  const retained = same.filter((row) => generateCandidates([row.left, row.right], {
    blocker: "token_v0",
    entityType: row.entity_type,
  }).length > 0).length;
  const conflictAutoLinks = conflicts.filter((row) => predictions.get(row.id)?.decision === "same").length;
  return {
    silver_same_pairs: same.length,
    authority_conflict_pairs: conflicts.length,
    candidate_recall: rate(retained, same.length),
    authority_conflict_auto_link_rate: rate(conflictAutoLinks, conflicts.length),
  };
}

function clusterSignals(sourceRows, links, windowStartMs) {
  const sourceById = new Map(sourceRows.map((row) => [sourceRecordId(row), nativeRecordId(row)]));
  const active = links.filter((link) => clean(link.decision) === "auto_link" && clean(link.canonical_entity_id));
  const firstSeen = new Map();
  for (const link of active) {
    const member = sourceById.get(clean(link.source_record_id)) || clean(link.source_record_id);
    const key = `${clean(link.canonical_entity_id)}\u0000${member}`;
    const created = finiteTime(link.created_at);
    const prior = firstSeen.get(key);
    if (!prior || (created != null && (prior.created == null || created < prior.created))) {
      firstSeen.set(key, { canonical: clean(link.canonical_entity_id), member, created });
    }
  }
  const membersByCluster = new Map();
  const beforeByCluster = new Map();
  for (const entry of firstSeen.values()) {
    const members = membersByCluster.get(entry.canonical) || new Set();
    members.add(entry.member);
    membersByCluster.set(entry.canonical, members);
    if (entry.created != null && entry.created < windowStartMs) {
      const before = beforeByCluster.get(entry.canonical) || new Set();
      before.add(entry.member);
      beforeByCluster.set(entry.canonical, before);
    }
  }
  const sizes = [...membersByCluster.values()].map((set) => set.size).sort((a, b) => a - b);
  let expandedClusters = 0;
  let priorLinks = 0;
  let newLinks = 0;
  for (const [canonical, members] of membersByCluster) {
    const before = beforeByCluster.get(canonical) || new Set();
    priorLinks += before.size;
    newLinks += members.size - before.size;
    if (before.size > 0 && members.size > before.size) expandedClusters += 1;
  }
  return {
    status: membersByCluster.size ? "measured" : "insufficient",
    clusters: membersByCluster.size,
    multi_record_clusters: sizes.filter((size) => size > 1).length,
    maximum_cluster_size: sizes.at(-1) ?? null,
    p50_cluster_size: quantile(sizes, 0.5),
    expanded_clusters: expandedClusters,
    links_before_window: priorLinks,
    links_added_in_window: newLinks,
    link_growth_rate: rate(newLinks, priorLinks, priorLinks === 0 ? "No pre-window links were available." : null),
  };
}

function contradictionSignal(latestRows, links) {
  const latestIds = new Set(latestRows.map(sourceRecordId));
  const decisionsByPair = new Map();
  const canonicalsBySource = new Map();
  const linkedSources = new Set();
  for (const link of links) {
    const source = clean(link.source_record_id);
    const canonical = clean(link.canonical_entity_id);
    if (!source || (latestIds.size && !latestIds.has(source))) continue;
    linkedSources.add(source);
    const pair = `${source}\u0000${canonical}`;
    const decisions = decisionsByPair.get(pair) || new Set();
    decisions.add(clean(link.decision));
    decisionsByPair.set(pair, decisions);
    if (clean(link.decision) === "auto_link" && canonical) {
      const canonicals = canonicalsBySource.get(source) || new Set();
      canonicals.add(canonical);
      canonicalsBySource.set(source, canonicals);
    }
  }
  const contradictory = new Set();
  for (const [source, canonicals] of canonicalsBySource) {
    if (canonicals.size > 1) contradictory.add(source);
  }
  for (const [pair, decisions] of decisionsByPair) {
    if (decisions.has("auto_link") && (decisions.has("separate") || decisions.has("never_auto"))) {
      contradictory.add(pair.split("\u0000")[0]);
    }
  }
  return {
    ...rate(contradictory.size, linkedSources.size),
    source_records_with_multiple_canonicals: [...canonicalsBySource.values()].filter((set) => set.size > 1).length,
    source_records_with_opposing_decisions: [...decisionsByPair.values()].filter(
      (set) => set.has("auto_link") && (set.has("separate") || set.has("never_auto")),
    ).length,
  };
}

function coverageSignals(latestRows, links, currentRows) {
  const linked = new Set(links
    .filter((link) => clean(link.decision) === "auto_link")
    .map((link) => clean(link.source_record_id)));
  const linkedLatest = latestRows.filter((row) => linked.has(sourceRecordId(row))).length;
  const currentKeys = new Set(currentRows.map(nativeRecordId).filter((key) => key !== ":"));
  const shadowKeys = new Set(latestRows.map(nativeRecordId));
  const capturedCurrent = [...currentKeys].filter((key) => shadowKeys.has(key)).length;
  const bySource = [...new Set([...currentRows, ...latestRows].map((row) => clean(row.source_system)).filter(Boolean))]
    .sort()
    .map((sourceSystem) => {
      const current = [...currentKeys].filter((key) => key.startsWith(`${sourceSystem}:`));
      const captured = current.filter((key) => shadowKeys.has(key)).length;
      return {
        source_system: sourceSystem,
        capture_coverage: rate(captured, current.length),
      };
    });
  return {
    orphan_rate: rate(latestRows.length - linkedLatest, latestRows.length),
    shadow_link_coverage: rate(linkedLatest, latestRows.length),
    shadow_capture_coverage: rate(capturedCurrent, currentKeys.size),
    shadow_current_read_delta: {
      current_records: currentKeys.size,
      shadow_records: shadowKeys.size,
      missing_from_shadow: Math.max(0, currentKeys.size - capturedCurrent),
      shadow_only: [...shadowKeys].filter((key) => !currentKeys.has(key)).length,
    },
    by_source: bySource,
  };
}

function freshnessSignals(latestRows, observedAtMs, staleAfterDays) {
  const systems = new Map();
  for (const row of latestRows) {
    const source = clean(row.source_system);
    const time = finiteTime(row.ingested_at);
    if (!source || time == null) continue;
    if (!systems.has(source) || time > systems.get(source)) systems.set(source, time);
  }
  const sources = [...systems.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, time]) => {
    const ageDays = Math.max(0, (observedAtMs - time) / 86_400_000);
    return {
      source_system: source,
      latest_ingested_at: new Date(time).toISOString(),
      age_days: Number(ageDays.toFixed(3)),
      stale_after_days: staleAfterDays,
      state: ageDays > staleAfterDays ? "stale" : "fresh",
    };
  });
  return {
    status: sources.length ? "measured" : "insufficient",
    stale_sources: sources.filter((source) => source.state === "stale").length,
    sources,
  };
}

function runSignals(runs) {
  const parsed = runs.map((run) => ({
    ...run,
    metrics: parseObject(run.metrics_json),
  }));
  return {
    total: parsed.length,
    completed: parsed.filter((run) => clean(run.status) === "completed").length,
    failed: parsed.filter((run) => clean(run.status) === "failed").length,
    matcher_versions: [...new Set(parsed.map((run) => clean(run.matcher_version)).filter(Boolean))].sort(),
    emitted_score_distributions: parsed.filter((run) => run.metrics?.score_distribution?.count > 0).length,
  };
}

export function compareShadowMonitorReceipts(current, baseline) {
  if (!baseline) return { status: "not_requested", reasons: [], deltas: {} };
  const reasons = [];
  for (const key of ["monitor_version", "schema_version"]) {
    if (current?.[key] !== baseline?.[key]) reasons.push(`${key}_changed`);
  }
  for (const key of ["window_days", "source_stale_after_days"]) {
    if (current?.parameters?.[key] !== baseline?.parameters?.[key]) reasons.push(`${key}_changed`);
  }
  if (JSON.stringify(current?.policy_versions) !== JSON.stringify(baseline?.policy_versions)) {
    reasons.push("policy_versions_changed");
  }
  if (reasons.length) return { status: "incompatible", reasons, deltas: {} };
  const paths = [
    ["candidate_recall", current.signals.authority.candidate_recall, baseline.signals?.authority?.candidate_recall],
    ["unresolved_rate", current.signals.candidates.unresolved_rate, baseline.signals?.candidates?.unresolved_rate],
    ["orphan_rate", current.signals.coverage.orphan_rate, baseline.signals?.coverage?.orphan_rate],
    ["contradiction_rate", current.signals.contradiction_rate, baseline.signals?.contradiction_rate],
  ];
  const deltas = {};
  for (const [name, now, before] of paths) {
    deltas[name] = now?.status === "measured" && before?.status === "measured"
      ? Number((now.value - before.value).toFixed(12))
      : null;
  }
  return { status: "compatible", reasons: [], deltas };
}

/** Build one deterministic provenance-stamped monitoring receipt. */
export function buildShadowMonitorReceipt(input = {}, opts = {}) {
  const sourceRows = Array.isArray(input.source_records) ? input.source_records.map((row) => ({
    ...row,
    normalized_snapshot: parseObject(row.normalized_snapshot),
  })) : [];
  const links = Array.isArray(input.entity_links) ? input.entity_links : [];
  const runs = Array.isArray(input.resolution_runs) ? input.resolution_runs : [];
  const currentRows = Array.isArray(input.current_records) ? input.current_records : [];
  const observedAt = opts.observedAt || input.observed_at || new Date().toISOString();
  const observedAtMs = finiteTime(observedAt);
  if (observedAtMs == null) throw new Error("observedAt must be an ISO timestamp");
  const windowDays = Math.max(1, Number(opts.windowDays || DEFAULT_MONITOR_WINDOW_DAYS));
  const staleAfterDays = Math.max(0.001, Number(opts.sourceStaleAfterDays || DEFAULT_SOURCE_STALE_AFTER_DAYS));
  const windowStartMs = observedAtMs - windowDays * 86_400_000;
  const latestRows = latestSourceRecords(sourceRows);
  const candidate = candidateSignals(latestRows, links);
  const authority = authoritySignals(sourceRows);
  const runSummary = runSignals(runs);
  const sourceTimes = sourceRows.map((row) => finiteTime(row.ingested_at)).filter((time) => time != null).sort();
  const sourceSystems = [...new Set(latestRows.map((row) => clean(row.source_system)).filter(Boolean))].sort();
  const receipt = {
    kind: "entity_resolution_shadow_monitor_receipt",
    schema_version: SHADOW_MONITOR_SCHEMA_VERSION,
    monitor_version: SHADOW_MONITOR_VERSION,
    observed_at: new Date(observedAtMs).toISOString(),
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(observedAtMs).toISOString(),
    },
    parameters: {
      window_days: windowDays,
      source_stale_after_days: staleAfterDays,
    },
    policy_versions: {
      authority: AUTHORITY_VERSION,
      candidate_generation: CANDIDATE_GENERATION_VERSION,
      matcher: MATCHERS_VERSION,
      shadow_run_matchers: runSummary.matcher_versions,
    },
    input: {
      kind: clean(opts.inputKind || input.input_kind) || "offline_snapshot",
      source_records: sourceRows.length,
      latest_source_records: latestRows.length,
      entity_links: links.length,
      resolution_runs: runs.length,
      current_records: currentRows.length,
      snapshot_sha256: digest({ source_records: sourceRows, entity_links: links, resolution_runs: runs, current_records: currentRows }),
      relation_sha256: {
        source_records: digest(sourceRows),
        entity_links: digest(links),
        resolution_runs: digest(runs),
        current_records: digest(currentRows),
      },
      source_snapshot_sha256: Object.fromEntries(sourceSystems.map((source) => [
        source,
        digest(latestRows.filter((row) => clean(row.source_system) === source)),
      ])),
      source_observed_range: {
        earliest: sourceTimes.length ? new Date(sourceTimes[0]).toISOString() : null,
        latest: sourceTimes.length ? new Date(sourceTimes.at(-1)).toISOString() : null,
      },
      truncated: Boolean(input.truncated),
    },
    signals: {
      candidates: candidate,
      authority,
      coverage: coverageSignals(latestRows, links, currentRows),
      clusters: clusterSignals(sourceRows, links, windowStartMs),
      contradiction_rate: contradictionSignal(latestRows, links),
      source_freshness: freshnessSignals(latestRows, observedAtMs, staleAfterDays),
      resolution_runs: runSummary,
    },
    caveats: [
      "Shadow metrics do not change entity links, review dispositions, or public reads.",
      "Authority metrics are silver-label checks derived only from comparable hard identifiers.",
      ...(input.truncated ? ["At least one live relation hit its row cap; rates may not represent the full production population."] : []),
      ...(sourceRows.length ? [] : ["No source records were available; source-derived rates are insufficient rather than zero."]),
      ...(currentRows.length ? [] : ["No current-read rows were available; shadow/current capture coverage is insufficient."]),
    ],
  };
  receipt.comparison = compareShadowMonitorReceipts(receipt, opts.baseline || null);
  return receipt;
}
