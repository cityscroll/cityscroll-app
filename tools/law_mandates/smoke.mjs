import { extractMandatesBatch } from "./extract_mandates.mjs";

export const SMOKE_LAWS = Array.from({ length: 5 }, (_, index) => {
  const matterId = `smoke-${String(index + 1).padStart(3, "0")}`;
  const quote = `The department shall publish report ${index + 1} annually.`;
  return {
    matter_id: matterId,
    matter_file: `Int ${index + 1}-2026`,
    title: `Smoke local law ${index + 1}`,
    enactment_date: "2026-01-15",
    effective_date: "2026-02-15",
    text: `Be it enacted by the Council: Section ${index + 1}. ${quote}`,
    mock_mandates: [{ agency: "Department of Civic Records", duty_text: `Publish report ${index + 1} annually.`, deliverable_type: "report", deadline: { kind: "none" }, recurrence: "annual", citation: `Section ${index + 1}`, verbatim_quote: quote }],
  };
});

export async function runSmoke({ laws = SMOKE_LAWS, invokeModel = async ({ law }) => ({ mandates: law.mock_mandates }) } = {}) {
  const envelopes = await extractMandatesBatch(laws, { invokeModel, model: "smoke-adapter" });
  const rows = envelopes.flatMap((envelope) => envelope.mandates);
  return {
    schema_version: "mandates-smoke-v1",
    law_count: laws.length,
    mandate_count: rows.length,
    verified_count: rows.filter((row) => row.quote_verified).length,
    candidate_count: rows.filter((row) => row.status === "candidate").length,
    quote_receipts: rows.map((row) => ({ mandate_id: row.mandate_id, quote_verified: row.quote_verified, reason: row.quote_verification_reason })),
    envelopes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) runSmoke().then((receipt) => console.log(JSON.stringify(receipt, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
