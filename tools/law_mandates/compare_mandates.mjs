import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { escapeHtml, sanitizeText } from "./sanitize.mjs";

export const COMPARATOR_SCHEMA_VERSION = "mandate-differential-review-v1";
export const TRUST_RULE = "Resolve disagreements by re-reading the fetched statute text; do not prefer either extractor.";

function clean(value, max = 2000) { return sanitizeText(value, max); }

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload.flatMap((item) => Array.isArray(item?.mandates) ? item.mandates : [item]);
  if (Array.isArray(payload?.mandates)) return payload.mandates;
  if (Array.isArray(payload?.obligations)) return payload.obligations;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.laws)) return payload.laws.flatMap((law) => law.mandates || []);
  return [];
}

function mattersFromPayload(payload) {
  const byMatter = new Map();
  for (const row of rowsFromPayload(payload)) {
    const matterId = clean(row?.matter_id ?? row?.matterId, 120);
    if (!matterId) continue;
    if (!byMatter.has(matterId)) byMatter.set(matterId, []);
    byMatter.get(matterId).push(row);
  }
  return byMatter;
}

function sequenceKey(row, index) {
  const match = String(row?.mandate_id ?? row?.mandateId ?? row?.obligation_id ?? "").match(/-(\d+)$/);
  return match ? `seq:${Number(match[1])}` : `seq:${index + 1}`;
}

function fieldValue(row, field) {
  if (field === "agency") return row?.agency ?? row?.agency_name ?? row?.actor_resolved ?? row?.actor ?? "";
  if (field === "deadline") {
    const deadline = row?.deadline;
    if (deadline && typeof deadline === "object") return deadline.computed_date ?? deadline.deadline_date ?? deadline.fixed_date ?? JSON.stringify(deadline);
    return row?.deadline_date ?? row?.deadline ?? "";
  }
  if (field === "deliverable_type") return row?.deliverable_type ?? "";
  return "";
}

function publicRow(row) {
  return {
    mandate_id: clean(row?.mandate_id ?? row?.mandateId ?? row?.obligation_id, 120) || null,
    matter_id: clean(row?.matter_id ?? row?.matterId, 120) || null,
    agency: clean(fieldValue(row, "agency"), 240),
    duty_text: clean(row?.duty_text ?? row?.action_summary, 2000),
    deliverable_type: clean(fieldValue(row, "deliverable_type"), 80),
    deadline: clean(fieldValue(row, "deadline"), 500),
    status: clean(row?.status ?? (row?.quote_verified === false ? "candidate" : "verified"), 40),
    quote_verified: row?.quote_verified !== false,
  };
}

function statuteSource(payload, matterId) {
  const law = (payload?.laws || []).find((row) => String(row?.matter_id) === matterId);
  const row = rowsFromPayload(payload).find((item) => String(item?.matter_id) === matterId);
  return {
    url: clean(law?.provenance?.source_url ?? row?.source?.url ?? row?.source_url, 1000) || null,
    sha256: clean(law?.provenance?.sha256 ?? row?.source?.sha256, 128) || null,
  };
}

export function compareMandates(ourPayload, referencePayload, { generatedAt = new Date().toISOString() } = {}) {
  const ours = mattersFromPayload(ourPayload);
  const reference = mattersFromPayload(referencePayload);
  const matterIds = [...new Set([...ours.keys(), ...reference.keys()])].sort();
  const queue = [];
  for (const matterId of matterIds) {
    const ourRows = ours.get(matterId) || [];
    const referenceRows = reference.get(matterId) || [];
    const ourMap = new Map(ourRows.map((row, index) => [sequenceKey(row, index), row]));
    const referenceMap = new Map(referenceRows.map((row, index) => [sequenceKey(row, index), row]));
    const agreementSet = [];
    const ourOnly = [];
    const referenceOnly = [];
    const fieldLevelDisagreements = [];
    for (const key of new Set([...ourMap.keys(), ...referenceMap.keys()])) {
      const ourRow = ourMap.get(key);
      const referenceRow = referenceMap.get(key);
      if (!ourRow) { referenceOnly.push(publicRow(referenceRow)); continue; }
      if (!referenceRow) { ourOnly.push(publicRow(ourRow)); continue; }
      agreementSet.push(publicRow(ourRow).mandate_id || key);
      for (const field of ["agency", "deadline", "deliverable_type"]) {
        const left = clean(fieldValue(ourRow, field), 500).toLowerCase();
        const right = clean(fieldValue(referenceRow, field), 500).toLowerCase();
        if (left !== right) fieldLevelDisagreements.push({ key, field, our: clean(fieldValue(ourRow, field), 500), reference: clean(fieldValue(referenceRow, field), 500) });
      }
    }
    const needsReview = ourOnly.length || referenceOnly.length || fieldLevelDisagreements.length;
    const statute = statuteSource(ourPayload, matterId);
    queue.push({
      queue_id: `mandate-diff:${matterId}`,
      matter_id: matterId,
      state: needsReview ? "needs_review" : "agreement",
      title: `Independent mandate comparison for matter ${matterId}`,
      agreement_set: agreementSet,
      our_only: ourOnly,
      reference_only: referenceOnly,
      field_level_disagreements: fieldLevelDisagreements,
      evidence: { matter_id: matterId, statute },
      review_instruction: TRUST_RULE,
      source_urls: [statute.url].filter(Boolean),
      caveat: "This queue compares extractors; it is not a legal conclusion and neither extractor is authoritative.",
    });
  }
  return {
    schema_version: COMPARATOR_SCHEMA_VERSION,
    generated_at: generatedAt,
    status: "candidate_compilation_for_future_review",
    public_surfaces_changed: false,
    operative_links_enabled: false,
    methodology: { keyed_by: "matter_id", compared_fields: ["agency", "deadline", "deliverable_type"], human_review_required: true, trust_rule: TRUST_RULE },
    queue,
    candidates: queue,
    receipt: { matter_count: queue.length, agreement_count: queue.filter((item) => item.state === "agreement").length, review_count: queue.filter((item) => item.state === "needs_review").length },
  };
}

export function assertReferencePathOutsideRepo(referencePath, repoRoot = process.cwd()) {
  const absoluteReference = resolve(referencePath);
  const relativePath = relative(resolve(repoRoot), absoluteReference);
  if (!relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) throw new Error("private reference must be outside the repository");
  return absoluteReference;
}

async function main(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const ourPath = args.get("--our");
  const referencePath = args.get("--reference");
  const outPath = args.get("--out");
  if (!ourPath || !referencePath || !outPath) throw new Error("usage: node compare_mandates.mjs --our <path> --reference <private-path> --out <path>");
  const validatedReferencePath = assertReferencePathOutsideRepo(referencePath, args.get("--repo-root") || process.cwd());
  const [ourPayload, referencePayload] = await Promise.all([readFile(ourPath, "utf8").then(JSON.parse), readFile(validatedReferencePath, "utf8").then(JSON.parse)]);
  await writeFile(outPath, `${JSON.stringify(compareMandates(ourPayload, referencePayload), null, 2)}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv).catch((error) => { console.error(error.message); process.exitCode = 1; });

export const reviewQueueHtml = (review) => review.queue.map((item) => `<article><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.review_instruction)}</p></article>`).join("\n");
