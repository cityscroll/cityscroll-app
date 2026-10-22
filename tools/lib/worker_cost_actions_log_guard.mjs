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
 * Findings are value-free: rule (+ optional source path/label) only. Never
 * return match excerpts that can re-echo an account id or bill amount into
 * failing assert messages or step diagnostics.
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
 * @param {{ path?: string }} [options]
 * @returns {{ ok: true, findings: [] } | { ok: false, findings: Array<{ rule: string, path?: string }> }}
 */
export function scanActionsLogForBillAccountLeaks(text, options = {}) {
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
  const path = typeof options.path === "string" && options.path.length > 0
    ? options.path
    : undefined;
  for (const [rule, re] of rules) {
    // Reset lastIndex for global-safe reuse; patterns are non-global today.
    re.lastIndex = 0;
    if (re.test(text)) {
      const finding = { rule };
      if (path) finding.path = path;
      findings.push(finding);
    }
  }
  return findings.length === 0
    ? { ok: true, findings: [] }
    : { ok: false, findings };
}

/**
 * Scan a list of workflow / script source texts that feed Actions logs for the
 * Worker cost-control path. Returns value-free findings keyed by source label.
 *
 * @param {Array<{ label: string, text: string }>} sources
 */
export function scanCostControlActionsSources(sources) {
  const failed = [];
  for (const source of sources || []) {
    const result = scanActionsLogForBillAccountLeaks(source.text, {
      path: source.label,
    });
    if (!result.ok) {
      failed.push({ label: source.label, findings: result.findings });
    }
  }
  return failed.length === 0
    ? { ok: true, failed: [] }
    : { ok: false, failed };
}

/**
 * Scan CLI emission surfaces (stdout, stderr, and optional diagnostics) for
 * bill / account leakage. Findings stay value-free.
 *
 * @param {{ stdout?: string, stderr?: string, diagnostics?: string, path?: string }} surfaces
 */
export function scanCliEmissionSurfaces(surfaces = {}) {
  const parts = [
    ["stdout", surfaces.stdout],
    ["stderr", surfaces.stderr],
    ["diagnostics", surfaces.diagnostics],
  ];
  const findings = [];
  for (const [surface, text] of parts) {
    if (typeof text !== "string" || text.length === 0) continue;
    const path = surfaces.path
      ? `${surfaces.path}#${surface}`
      : surface;
    const result = scanActionsLogForBillAccountLeaks(text, { path });
    if (!result.ok) findings.push(...result.findings);
  }
  return findings.length === 0
    ? { ok: true, findings: [] }
    : { ok: false, findings };
}
