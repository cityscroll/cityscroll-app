// Entity-centric evaluation over labeled pair graphs.
// Positive labels define reference components; negative labels are constraints.
// Missing pair labels remain unknown rather than being treated as negatives.

import { createHash } from "node:crypto";

import { extractFeatures } from "../features/index.mjs";
import { MATCHERS_VERSION, scorePair } from "../matchers/index.mjs";

export const ENTITY_COMPONENT_SCHEMA_VERSION = 1;
export const DEFAULT_COMPONENT_SAMPLE_SIZE = 8;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

class DisjointSet {
  constructor(ids = []) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    if (!this.parent.has(id)) this.parent.set(id, id);
    const parent = this.parent.get(id);
    if (parent !== id) this.parent.set(id, this.find(parent));
    return this.parent.get(id);
  }

  union(left, right) {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(b, a.localeCompare(b) <= 0 ? a : b);
  }
}

function observationId(side, corpus, entityType) {
  const durable = clean(side.source_record_id || side.native_key || side.source_system_id);
  if (durable) return `${corpus}:${entityType}:${clean(side.source_system)}:${durable}`;
  return `${corpus}:${entityType}:anon:${digest(JSON.stringify(side)).slice(0, 16)}`;
}

function normalizeCase(row, corpus) {
  const entityType = clean(row.entity_type || "vendor");
  const label = row.label || (row.authority_label === "same" ? "same" : "different");
  const side = (value) => ({
    ...value,
    source_system: clean(value?.source_system),
    native_key: clean(value?.native_key || value?.source_system_id),
    display_name: clean(value?.display_name),
    attrs: value?.attrs || {},
  });
  const left = side(row.left);
  const right = side(row.right);
  return {
    id: clean(row.id),
    corpus,
    entity_type: entityType,
    label,
    left,
    right,
    left_id: observationId(left, corpus, entityType),
    right_id: observationId(right, corpus, entityType),
    evidence: row.evidence || null,
  };
}

function graphComponents(ids, links) {
  const dsu = new DisjointSet(ids);
  for (const [left, right] of links) dsu.union(left, right);
  const groups = new Map();
  for (const id of ids) {
    const root = dsu.find(id);
    const group = groups.get(root) || [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((members) => members.sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function componentId(corpus, entityType, members) {
  return `erc-${digest(`${corpus}\n${entityType}\n${members.join("\n")}`).slice(0, 16)}`;
}

function safeRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function observationHasAuthorityKey(observation) {
  const attrs = observation?.attrs || {};
  return [
    attrs.authority_keys,
    attrs.contract_ids,
    attrs.pin,
    attrs.epin,
    attrs.contract_id,
  ].some((value) => Array.isArray(value) ? value.length > 0 : clean(value).length > 0);
}

function evaluateCorpus(inputCases, corpus) {
  const cases = inputCases.map((row) => normalizeCase(row, corpus));
  const observations = new Map();
  for (const row of cases) {
    observations.set(row.left_id, row.left);
    observations.set(row.right_id, row.right);
  }
  const byType = new Map();
  for (const [id, observation] of observations) {
    const entityType = id.split(":")[1];
    const entry = byType.get(entityType) || { ids: [], observations: new Map(), cases: [] };
    entry.ids.push(id);
    entry.observations.set(id, observation);
    byType.set(entityType, entry);
  }
  for (const row of cases) byType.get(row.entity_type).cases.push(row);

  const evaluated = [];
  const overMergeComponents = [];
  const auditEntities = [];
  const violatedNegativeIds = new Set();
  let negativeConstraints = 0;
  let violatedNegativeConstraints = 0;
  let predictedMultiComponents = 0;
  let overMergedPredictedComponents = 0;

  for (const [entityType, entry] of byType) {
    entry.ids.sort();
    const truthLinks = entry.cases
      .filter((row) => row.label === "same")
      .map((row) => [row.left_id, row.right_id]);
    const predictedLinks = [];
    const pairScores = [];
    for (let leftIndex = 0; leftIndex < entry.ids.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < entry.ids.length; rightIndex++) {
        const leftId = entry.ids[leftIndex];
        const rightId = entry.ids[rightIndex];
        const left = entry.observations.get(leftId);
        const right = entry.observations.get(rightId);
        const features = extractFeatures(left, right, { entityType });
        const score = scorePair(left, right, features);
        pairScores.push({ left_id: leftId, right_id: rightId, ...score });
        if (score.decision === "same") {
          predictedLinks.push([leftId, rightId]);
        }
      }
    }

    const truth = graphComponents(entry.ids, truthLinks);
    const predicted = graphComponents(entry.ids, predictedLinks);
    const predictedByMember = new Map();
    for (const members of predicted) {
      const id = componentId(corpus, entityType, members);
      for (const member of members) predictedByMember.set(member, id);
    }
    const violatedByPredicted = new Map();
    for (const row of entry.cases.filter((item) => item.label === "different")) {
      negativeConstraints += 1;
      if (predictedByMember.get(row.left_id) !== predictedByMember.get(row.right_id)) continue;
      violatedNegativeConstraints += 1;
      violatedNegativeIds.add(row.id);
      const predictedId = predictedByMember.get(row.left_id);
      const violations = violatedByPredicted.get(predictedId) || [];
      violations.push(row.id);
      violatedByPredicted.set(predictedId, violations);
    }
    predictedMultiComponents += predicted.filter((members) => members.length > 1).length;
    overMergedPredictedComponents += violatedByPredicted.size;
    for (const members of predicted.filter((group) => group.length > 1)) {
      const predictedId = componentId(corpus, entityType, members);
      const violationIds = violatedByPredicted.get(predictedId) || [];
      if (violationIds.length === 0) continue;
      const sources = [...new Set(members.map((id) => entry.observations.get(id).source_system))].sort();
      overMergeComponents.push({
        component_id: predictedId,
        corpus,
        entity_type: entityType,
        record_count: members.length,
        source_count: sources.length,
        sources,
        violated_negative_case_ids: violationIds.sort(),
        over_merge: true,
        observations: members.map((id) => ({ id, ...entry.observations.get(id) })),
      });
    }

    for (const members of truth.filter((group) => group.length > 1)) {
      const predictedPartitions = [...new Set(members.map((id) => predictedByMember.get(id)))];
      const caseIds = entry.cases
        .filter((row) => members.includes(row.left_id) && members.includes(row.right_id))
        .map((row) => row.id)
        .sort();
      const sources = [...new Set(members.map((id) => entry.observations.get(id).source_system))].sort();
      evaluated.push({
        component_id: componentId(corpus, entityType, members),
        corpus,
        entity_type: entityType,
        record_count: members.length,
        source_count: sources.length,
        sources,
        reference_case_ids: caseIds,
        predicted_partition_count: predictedPartitions.length,
        under_split: predictedPartitions.length > 1,
        observations: members.map((id) => ({ id, ...entry.observations.get(id) })),
      });
    }

    const falseSplitMembers = new Set(
      evaluated
        .filter((component) => component.entity_type === entityType && component.under_split)
        .flatMap((component) => component.observations.map((observation) => observation.id)),
    );
    for (const members of predicted) {
      if (members.some((member) => falseSplitMembers.has(member))) continue;
      const memberSet = new Set(members);
      const observationsForEntity = members.map((id) => ({ id, ...entry.observations.get(id) }));
      const internalSame = pairScores.filter((pair) => (
        pair.decision === "same" && memberSet.has(pair.left_id) && memberSet.has(pair.right_id)
      ));
      const boundaryUnresolved = pairScores.filter((pair) => (
        pair.decision === "unresolved" &&
        (memberSet.has(pair.left_id) !== memberSet.has(pair.right_id))
      ));
      const sources = [...new Set(observationsForEntity.map((observation) => observation.source_system))].sort();
      const predictedId = componentId(corpus, entityType, members);
      const violatedNegativeCaseIds = [...(violatedByPredicted.get(predictedId) || [])].sort();
      auditEntities.push({
        audit_id: `era-${predictedId}`,
        component_id: predictedId,
        corpus,
        entity_type: entityType,
        unit_kind: "resolved_entity",
        record_count: members.length,
        source_count: sources.length,
        sources,
        min_link_confidence: internalSame.length
          ? Math.min(...internalSame.map((pair) => pair.confidence))
          : null,
        max_boundary_unresolved_confidence: boundaryUnresolved.length
          ? Math.max(...boundaryUnresolved.map((pair) => pair.confidence))
          : null,
        authority_key_case: observationsForEntity.some(observationHasAuthorityKey),
        false_split_callout: false,
        over_merge_callout: violatedNegativeCaseIds.length > 0,
        violated_negative_case_ids: violatedNegativeCaseIds,
        observations: observationsForEntity,
      });
    }
  }

  const underSplit = evaluated.filter((component) => component.under_split);
  for (const component of underSplit) {
    auditEntities.push({
      ...component,
      audit_id: `era-${component.component_id}-false-split`,
      unit_kind: "reference_entity",
      min_link_confidence: null,
      max_boundary_unresolved_confidence: null,
      authority_key_case: component.observations.some(observationHasAuthorityKey),
      false_split_callout: true,
      over_merge_callout: false,
      violated_negative_case_ids: [],
    });
  }
  return {
    corpus,
    components: evaluated.sort((a, b) => a.component_id.localeCompare(b.component_id)),
    over_merge_components: overMergeComponents.sort((a, b) => a.component_id.localeCompare(b.component_id)),
    metrics: {
      reference_entity_components: evaluated.length,
      recovered_entity_components: evaluated.length - underSplit.length,
      under_split_entity_components: underSplit.length,
      entity_component_recall: safeRate(evaluated.length - underSplit.length, evaluated.length),
      under_split_entity_rate: safeRate(underSplit.length, evaluated.length),
      predicted_multi_record_components: predictedMultiComponents,
      over_merged_predicted_components: overMergedPredictedComponents,
      over_merge_component_rate: safeRate(overMergedPredictedComponents, predictedMultiComponents),
      negative_constraints: negativeConstraints,
      violated_negative_constraints: violatedNegativeConstraints,
      negative_constraint_violation_rate: safeRate(violatedNegativeConstraints, negativeConstraints),
    },
    violated_negative_case_ids: [...violatedNegativeIds].sort(),
    audit_entities: auditEntities.sort((a, b) => a.audit_id.localeCompare(b.audit_id)),
  };
}

function sampleStratum(component) {
  if (component.over_merge) return `${component.corpus}_over_merge`;
  if (component.under_split) return `${component.corpus}_false_split`;
  return `${component.corpus}_control`;
}

/** Build deterministic whole-component sample and entity-level metrics. */
export function buildEntityComponentReport({ goldCases = [], authorityCases = [] } = {}, opts = {}) {
  const sampleSize = Math.max(1, Number(opts.sampleSize ?? DEFAULT_COMPONENT_SAMPLE_SIZE));
  const gold = evaluateCorpus(goldCases, "gold");
  const authority = evaluateCorpus(authorityCases, "authority");
  const all = [
    ...authority.over_merge_components,
    ...gold.over_merge_components,
    ...authority.components,
    ...gold.components,
  ].map((component) => ({
    ...component,
    stratum: sampleStratum(component),
  }));
  const stratumOrder = [
    "authority_false_split",
    "gold_false_split",
    "authority_over_merge",
    "gold_over_merge",
    "authority_control",
    "gold_control",
  ];
  const buckets = new Map(stratumOrder.map((stratum) => [stratum, []]));
  for (const component of all) buckets.get(component.stratum).push(component);
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.record_count - a.record_count || a.component_id.localeCompare(b.component_id));
  }
  const sample = [];
  while (sample.length < sampleSize) {
    let added = false;
    for (const stratum of stratumOrder) {
      const next = buckets.get(stratum).shift();
      if (!next) continue;
      sample.push(next);
      added = true;
      if (sample.length === sampleSize) break;
    }
    if (!added) break;
  }
  const falseSplitPriority = all
    .filter((component) => component.under_split)
    .sort((a, b) => (a.corpus === b.corpus ? 0 : a.corpus === "authority" ? -1 : 1)
      || b.record_count - a.record_count || a.component_id.localeCompare(b.component_id));
  return {
    kind: "entity_component_evaluation",
    schema_version: ENTITY_COMPONENT_SCHEMA_VERSION,
    matcher_version: MATCHERS_VERSION,
    parameters: { sample_size: sampleSize, sampling_unit: "whole_reference_component" },
    metrics: { gold: gold.metrics, authority: authority.metrics },
    false_split_priority: falseSplitPriority,
    audit_population: [...authority.audit_entities, ...gold.audit_entities]
      .sort((a, b) => a.audit_id.localeCompare(b.audit_id)),
    sample,
    composition: Object.fromEntries(stratumOrder.map((stratum) => [
      stratum,
      all.filter((component) => component.stratum === stratum).length,
    ])),
  };
}
