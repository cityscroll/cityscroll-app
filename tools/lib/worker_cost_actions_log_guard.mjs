/**
 * Actions-log bill / account-id leak guard for the Worker all-meter release path.
 *
 * Receipt-level sanitization already refuses forbidden keys in all-meter evidence
 * (`assertSanitized` / closed retained-key allowlist). This guard covers the
 * separate surface: text that would appear in public GitHub Actions logs
 * (workflow stdout, `release-evaluate` JSON echo, step summaries).
 *
 * Fail closed on:
 *   - bill / invoice / monthly_bill fields with numeric or currency values
 *   - account_id / cloudflare_account_id assignments with concrete ids
 *   - labeled Cloudflare account UUID hex (32 hex) next to account wording
 *
 * Does not ban ANALYTICS_ACCOUNT_ID bindings that already live in tracked
 * Worker config; those are a different surface. This guard is for cost-gate
 * Actions log text and cost-control workflow steps.
 */

// Key may appear bare or JSON-quoted (`"bill_usd": 17.9`). Value may be a
// number, a currency amount, or a short JSON object that itself contains a digit
// (`monthly_bill={"usd":17.9}`).
const BILL_FIELD =
  /\b(?:bill_usd|invoice_amount|monthly_bill|invoice_total|billing_amount)\b["']?\s*[:=]\s*(?:[{["'][^0-9\n]{0,40})?\$?\d/i;

const ACCOUNT_FIELD =
  /\b(?:cloudflare_)?account_id\b["']?\s*[:=]\s*["']?[0-9a-f]{8,}/i;

const LABELED_ACCOUNT_HEX =
  /\b(?:cloudflare\s+)?account(?:\s+id)?\b[^.\n]{0,40}\b[0-9a-f]{32}\b/i;

const CURRENCY_BILL =
  /\b(?:monthly\s+bill|invoice\s+amount|bill(?:ing)?\s+total)\b[^.\n]{0,40}\$\s?\d+(?:\.\d+)?/i;

/**
 * @param {string} text
 * @returns {{ ok: true, findings: [] } | { ok: false, findings: Array<{ rule: string, excerpt: string }> }}
 */
export function scanActionsLogForBillAccountLeaks(text) {
  if (typeof text !== "string") {
    throw new TypeError("scanActionsLogForBillAccountLeaks requires a string");
  }
  const findings = [];
  const rules = [
    ["bill_field", BILL_FIELD],
    ["account_field", ACCOUNT_FIELD],
    ["labeled_account_hex", LABELED_ACCOUNT_HEX],
    ["currency_bill", CURRENCY_BILL],
  ];
  for (const [rule, re] of rules) {
    const match = text.match(re);
    if (match) {
      findings.push({
        rule,
        // Never echo a full secret-bearing line; keep a short stable excerpt.
        excerpt: match[0].slice(0, 80),
      });
    }
  }
  return findings.length === 0
    ? { ok: true, findings: [] }
    : { ok: false, findings };
}

/**
 * Scan a list of workflow / script source texts that feed Actions logs for the
 * Worker cost-control path. Returns the first failing file label.
 *
 * @param {Array<{ label: string, text: string }>} sources
 */
export function scanCostControlActionsSources(sources) {
  const failed = [];
  for (const source of sources || []) {
    const result = scanActionsLogForBillAccountLeaks(source.text);
    if (!result.ok) {
      failed.push({ label: source.label, findings: result.findings });
    }
  }
  return failed.length === 0
    ? { ok: true, failed: [] }
    : { ok: false, failed };
}
