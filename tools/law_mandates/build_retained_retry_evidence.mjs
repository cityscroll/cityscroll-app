import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_INPUT = "tools/law_mandates/output/retained_retry/receipt.json";
const DEFAULT_OUTPUT = "docs/evidence/mandate-retained-retry.json";

function assertComplete(receipt) {
  if (receipt?.retry?.attempted_law_count !== 188) throw new Error("expected 188 retained laws");
  if (receipt?.retry?.completed_law_count !== 188 || receipt?.retry?.failed_law_count !== 0) {
    throw new Error("retained-law retry is incomplete");
  }
  if (receipt?.retry?.quote_candidate_count !== 0 || receipt?.fidelity?.extractor_bug_count !== 0) {
    throw new Error("retained-law retry has unresolved extractor defects");
  }
  if (receipt?.human_gate_required !== false || receipt?.fidelity?.human_gate_required !== false) {
    throw new Error("retained-law retry must remain automated");
  }
  if (!Array.isArray(receipt?.results) || receipt.results.length !== 188
    || new Set(receipt.results.map((row) => row?.matter_id)).size !== 188) {
    throw new Error("retained-law evidence must contain 188 unique results");
  }
  for (const row of receipt.results) {
    if (row?.status !== "completed" || row?.self_check?.verdict === "extractor_bug"
      || row?.self_check?.human_gate_required !== false) throw new Error(`invalid retained-law result: ${row?.matter_id}`);
    if (!/^https:\/\//u.test(row?.source?.source_url || "") || !/^[a-f0-9]{64}$/u.test(row?.source?.sha256 || "")) {
      throw new Error(`invalid retained-law provenance: ${row?.matter_id}`);
    }
    if (!Array.isArray(row?.extraction?.mandates)
      || row.extraction.mandates.some((mandate) => mandate?.quote_verified !== true)) {
      throw new Error(`unverified retained-law mandate: ${row?.matter_id}`);
    }
  }
}

export function publicRetainedRetryEvidence(receipt) {
  assertComplete(receipt);
  return {
    schema_version: "cityscroll.retained_mandate_retry_evidence.v1",
    generated_at: receipt.generated_at,
    retained_definition: receipt.retained_definition,
    source_snapshot: receipt.source_snapshot,
    retry: receipt.retry,
    fidelity: receipt.fidelity,
    methodology: {
      extraction_prompt_version: receipt.extraction?.prompt_version || null,
      extraction_strategy_version: receipt.extraction?.extraction_strategy_version || null,
      enacted_text_adapter_version: receipt.extraction?.source_adapter_version || null,
      current_fidelity_self_check_prompt_version: receipt.extraction?.self_check_prompt_version || null,
      observed_fidelity_self_check_prompt_versions: [...new Set(receipt.results
        .map((row) => row?.self_check?.prompt_version).filter(Boolean))].sort(),
      classification_vocabulary: ["faithful", "ambiguous_law_text", "extractor_bug"],
      ambiguous_cases_are_published_as_provenance_not_queued_for_review: true,
      human_gate_required: false,
    },
    results: receipt.results.map((row) => ({
      matter_id: row.matter_id,
      file_number: row.file_number || null,
      title: row.title || null,
      retained_reason: row.retained_reason,
      status: row.status,
      source: row.source,
      extraction: row.extraction,
      self_check: row.self_check,
      repair: row.repair || null,
    })),
  };
}

export async function buildRetainedRetryEvidence({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  const receipt = JSON.parse(await readFile(resolve(input), "utf8"));
  const evidence = publicRetainedRetryEvidence(receipt);
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || DEFAULT_INPUT;
  const output = process.argv[3] || DEFAULT_OUTPUT;
  buildRetainedRetryEvidence({ input, output }).then((evidence) => {
    console.log(`wrote ${output}: laws=${evidence.retry.completed_law_count} mandates=${evidence.retry.extracted_mandate_count} ambiguous=${evidence.fidelity.ambiguous_law_text_count}`);
  }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
