// Versioned ops contract — the narrow waist between the public worker and private desk.
//
// Machine-readable only. No secrets, no recipient PII, no internal desk HTML.
// Served on authenticated GET /admin/ops-contract (ADMIN_KEY). Public /stats must not
// expose this document.
//
// Desk panels pin min_version and validate fixtures against this schema so hard-coded
// key prefixes, digest modes, and daylog actions cannot drift silently.

export const OPS_CONTRACT_VERSION = "1.4.0";
export const OPS_CONTRACT_ID = "ops-contract.v1";

/** Digest delivery / evaluation modes the worker may stamp on receipts and daylogs. */
export const DIGEST_MODES = Object.freeze([
  {
    id: "cron",
    aliases: ["inline"],
    description: "Default daily cron path: process accounts inline in runAlerts().",
  },
  {
    id: "queue",
    aliases: [],
    description: "QUEUE_DIGESTS=true with DIGEST_QUEUE bound: fan-out one job per account.",
  },
  {
    id: "catch_up",
    aliases: [],
    description: "Watermark recovery (admin POST /admin/digest-catchup or DIGEST_CATCH_UP).",
  },
  {
    id: "rollup",
    aliases: [],
    description: "Account-level multi-watch consolidated email (entry kind, not a daylog mode).",
  },
  {
    id: "dry_run",
    aliases: [],
    description: "Evaluation without Resend send (ALERTS_LIVE off, admin rollup dry-run, test-send).",
  },
  {
    id: "shadow_run",
    aliases: [],
    description: "06:00 ET full render against live data; delivery and state advancement disabled.",
  },
]);

export const DIGEST_SHADOW = Object.freeze({
  contract: "digest-shadow.v1",
  cron_utc: "0 10 * * *",
  status_values: ["READY", "NEEDS_ATTENTION"],
  endpoint: "/admin/digest-shadow",
  storage: {
    binding: "DB",
    run_table: "digest_shadow_runs",
    preview_table: "digest_shadow_previews",
    hold_state_table: "digest_shadow_hold_states",
    hold_override_table: "digest_shadow_hold_overrides",
  },
  redline_fields: ["code", "digest_id", "watch_id", "reason", "evidence"],
  redline_codes: [
    "render_error",
    "historical_watch_zero",
    "aggregate_count_collapse",
    "aggregate_count_explosion",
    "count_list_mismatch",
    "broken_digest_link",
  ],
  monitoring: {
    poll_status: "HTTP 200 only when READY; NEEDS_ATTENTION returns HTTP 503 with the JSON body",
    wake: "Scheduled post-rehearsal and post-delivery monitors open or update a repair issue for redlines, missing runs, or open degraded receipts.",
    rerun: "Authenticated POST /admin/digest-shadow rebuilds all previews after a repair; affected_digest_ids scopes diagnosis.",
    delivery_effect: "At 12:45 UTC, only affected_digest_ids still redlined are held from the 13:00 UTC delivery path; unrelated digests remain eligible.",
  },
  hold: {
    contract: "digest-shadow-hold.v1",
    cutoff_utc: "12:45",
    delivery_boundary_utc: "13:00",
    expires_utc: "14:00",
    retry_policy: "three bounded read attempts with 250ms then 1000ms backoff",
    unavailable_policy: "use today's persisted state when usable; otherwise fail open loudly",
    missing_run_policy: "fail open loudly while a READY rehearsal is less than 3 days old; hold all at the 3-day boundary",
    recovery_policy: "a READY rehearsal after a dark-period hold triggers automatic catch-up before normal delivery",
    degraded_receipt_contract: "digest-shadow-degraded-decision.v1",
    redline_policy: "fail closed only for affected_digest_ids",
    expiry_policy: "fail open after the bounded delivery window",
    override: "Authenticated POST with action=override-hold, digest_ids, and reason",
    successful_rerun: "Authenticated READY rerun clears overrides and releases every digest",
  },
});

/**
 * Daylog entry `action` values the worker writes. `skipped:<reason>` is open-ended;
 * listed skip reasons are the known closed set from alerts/rollup paths.
 */
export const DAYLOG_ACTIONS = Object.freeze([
  { id: "match", description: "Fresh notices included in a send." },
  { id: "heartbeat", description: "Daily quiet liveness email after heartbeatDays of silence." },
  { id: "weekly-empty", description: "Weekly subscription check-in with no fresh notices." },
  { id: "none", description: "No send; still inside quiet window or zero-match row." },
  { id: "catch_up", description: "Watermark-recovery send or catch-up path stamp." },
  { id: "rollup", description: "Account rollup default when no finer action is set." },
  {
    id: "skipped:*",
    description: "Skip prefix; concrete reasons listed under daylog.skip_reasons.",
    pattern: "^skipped:.+",
  },
]);

/** Known skipped: reasons (action becomes `skipped:<reason>`). */
export const DAYLOG_SKIP_REASONS = Object.freeze([
  "paused",
  "weekly",
  "empty",
  "gone",
  "bad-job",
  "no-watermark",
  "malformed-award-watch",
  "award-lookup-failed",
  "shadow-hold",
  "lens:people",
  "lens:money",
  "lens:land",
  "lens:property",
  "lens:rules",
  "lens:meetings",
  "lens:entity",
  "lens:alerts",
]);

/** Fields on a daylog entry (digest:daylog:YYYY-MM-DD). */
export const DAYLOG_ENTRY_FIELDS = Object.freeze([
  { name: "day", type: "string|null", description: "UTC YYYY-MM-DD." },
  { name: "kind", type: "string", description: "subscription | config_watch | rollup." },
  { name: "id", type: "string|null", description: "Masked sub key or account log id; never raw email." },
  { name: "lens", type: "string|null", description: "Watch lens or account for rollup." },
  { name: "query", type: "string|null", description: "Human query label." },
  { name: "email", type: "string|null", description: "Redacted email only." },
  { name: "found", type: "number|null", description: "All query matches this run (incl. already-seen)." },
  { name: "noticeCount", type: "number", description: "New notices included in a send." },
  { name: "noticeIds", type: "string[]", description: "Public City Record request ids (capped)." },
  { name: "noticeLinks", type: "string[]", description: "cityscroll.org/notices/<id> deep links." },
  { name: "action", type: "string|null", description: "See daylog.actions." },
  {
    name: "traffic_class",
    type: "string|null",
    description: "Daylog recovery class: null (daily) or catch_up. Not usage traffic_class.",
  },
  { name: "sent", type: "boolean", description: "True when Resend accepted a live send." },
  { name: "dryRun", type: "boolean", description: "True when evaluated but not live-sent." },
  { name: "capped", type: "boolean", description: "Deferred by per-run or daily send caps." },
  { name: "zeroMatch", type: "boolean", description: "Explicit zero-match / quiet row." },
  { name: "error", type: "string|null", description: "Error message when processing failed." },
  { name: "forecasts", type: "number", description: "Forecast cards attached to the email." },
  { name: "sections", type: "array|undefined", description: "Rollup nested section summaries." },
  { name: "sendUnits", type: "number", description: "Send-cap units (rollup = 1)." },
]);

/** Daylog envelope fields. */
export const DAYLOG_ENVELOPE_FIELDS = Object.freeze([
  { name: "day", type: "string" },
  { name: "ranAt", type: "string", description: "ISO timestamp of the run." },
  { name: "updatedAt", type: "string|undefined", description: "Set on queue merges." },
  { name: "live", type: "boolean" },
  { name: "mode", type: "string", description: "inline | queue | catch_up (see digest_modes aliases)." },
  { name: "entryCount", type: "number" },
  { name: "sentCount", type: "number" },
  { name: "zeroSendCount", type: "number" },
  { name: "totalNotices", type: "number" },
  {
    name: "shadowHoldDecision",
    type: "object|null",
    description: "Collapsed degraded-path or recovery receipt for the send-safety quiet line.",
  },
  { name: "entries", type: "array" },
]);

/**
 * Authenticated /admin/stats metric paths operators care about.
 * exclude_developer_traffic: true when developer/debug traffic must not inflate the count.
 */
export const STATS_METRICS = Object.freeze([
  {
    path: "subscriptions.active",
    source: "SUBS list scan",
    exclude_developer_traffic: true,
    description: "Active (non-paused) confirmed watches.",
  },
  {
    path: "subscriptions.accounts",
    source: "SUBS list scan",
    exclude_developer_traffic: true,
    description: "Distinct emails with at least one active watch.",
  },
  {
    path: "digests.sent_today",
    source: "ALERT_STATE sendcount:<day>",
    exclude_developer_traffic: true,
    description: "Live digest emails accepted today (UTC).",
  },
  {
    path: "digests.sent_last7d",
    source: "ALERT_STATE sendcount:*",
    exclude_developer_traffic: true,
    description: "Live digest emails in the rolling 7-day window.",
  },
  {
    path: "digests.sent_all_time",
    source: "ALERT_STATE stats:alltime:digest + hist recovery",
    exclude_developer_traffic: true,
    description: "All-time live digests with recovered pre-era history folded in.",
  },
  {
    path: "digests.catch_up_sent_today",
    source: "ALERT_STATE stats:digest_catchup:<day>",
    exclude_developer_traffic: true,
    description: "Watermark-recovery sends today (separate from daily trend).",
  },
  {
    path: "digests.catch_up_sent_all_time",
    source: "ALERT_STATE stats:alltime:digest_catchup",
    exclude_developer_traffic: true,
    description: "All-time catch-up sends.",
  },
  {
    path: "digests.lagging_subs",
    source: "SUBS + lastsent:*",
    exclude_developer_traffic: true,
    description: "Count of watches whose lastsent lags ≥ 2 days (no PII).",
  },
  {
    path: "digests.last_run",
    source: "ALERT_STATE digest:run:latest",
    exclude_developer_traffic: false,
    description: "Durable cron receipt (mode, sent, skipped_reason).",
  },
  {
    path: "digest_clicks",
    source: "ALERT_STATE stats:click:*",
    exclude_developer_traffic: true,
    description: "Count-only /r/ digest link follows.",
  },
  {
    path: "feeds.fetches_last7d",
    source: "ALERT_STATE stats:feed:*",
    exclude_developer_traffic: true,
    description: "Origin feed fetches (edge cache hits not counted).",
  },
  {
    path: "batch.calls_last7d",
    source: "ALERT_STATE stats:batch:*",
    exclude_developer_traffic: true,
    description: "Saved-search batch checks.",
  },
  {
    path: "shared_investigations.created_last7d",
    source: "ALERT_STATE stats:share:*",
    exclude_developer_traffic: true,
    description: "Investigation share creations.",
  },
  {
    path: "nl_search",
    source: "NL_METER",
    exclude_developer_traffic: true,
    description: "Natural-language search meter (Haiku).",
  },
  {
    path: "usage.*",
    source: "Analytics Engine + ALERT_STATE dual-write",
    exclude_developer_traffic: true,
    description: "First-party aggregate events; production traffic_class only.",
  },
]);

/** Admin and operator-auth routes. */
export const ADMIN_ROUTES = Object.freeze([
  {
    path: "/admin/ops-contract",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "This contract document (versioned JSON).",
  },
  {
    path: "/admin/stats",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Private product activity, subscriptions, and delivery operations (JSON or ?view=html).",
  },
  {
    path: "/admin/owed-backlog",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Read-only owed digest items grouped by subscriber, with delivery state and next schedule.",
  },
  {
    path: "/admin/subs",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Redacted confirmed subscriptions from SUBS.",
  },
  {
    path: "/admin/watch-log",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Watch lifecycle events (days window).",
  },
  {
    path: "/admin/watch-log/enrich",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "Retrofit thin watch-log events from live SUBS.",
  },
  {
    path: "/admin/feedback",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Stored feedback rows (operator inbox).",
  },
  {
    path: "/admin/possibly-same",
    methods: ["GET", "POST"],
    auth: "ADMIN_KEY",
    description: "False-split desk review (entity resolution).",
  },
  {
    path: "/admin/digest-rollup",
    methods: ["GET"],
    auth: "ADMIN_KEY",
    description: "Dry-run account digest for ?email= (no Resend).",
  },
  {
    path: "/admin/digest-shadow",
    methods: ["GET", "POST"],
    auth: "ADMIN_KEY",
    description: "GET reads the rehearsal, hold state, or rendered preview; GET also accepts the read-only SHADOW_STATUS_KEY. POST reruns after repair or overrides named affected digest holds (ADMIN_KEY only).",
  },
  {
    path: "/admin/digest-send-test",
    methods: ["POST"],
    auth: "OPERATOR_PROBE",
    description: "Evaluate or live-send one allowlisted address; advanceState opt-in.",
  },
  {
    path: "/admin/digest-catchup",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "Watermark recovery for lagging subscriptions.",
  },
  {
    path: "/admin/suggest-refresh",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "On-demand suggestion-chip validation (cron pipeline).",
  },
  {
    path: "/admin/meeting-outcomes-refresh",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "On-demand Council meeting-outcomes materialization and Legistar source_records dual-write (cron pipeline).",
  },
  {
    path: "/admin/zap-outcomes-refresh",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "On-demand Land ZAP outcomes prewarm for sell-facing project_ids (cron pipeline).",
  },
  {
    path: "/admin/passport-ingest",
    methods: ["POST"],
    auth: "ADMIN_KEY",
    description: "Rebuild PASSPort Public product tables and dual-write observations.",
  },
  {
    path: "/usage",
    methods: ["GET"],
    auth: "USAGE_KEY",
    description: "Read-only Haiku spend report (NL_METER). Not the public ops contract.",
  },
  {
    path: "/stats",
    methods: ["GET"],
    auth: "none",
    description: "Public corpus and coverage aggregates only — no product usage fields.",
  },
]);

export const AUTH_CLASSES = Object.freeze([
  {
    id: "ADMIN_KEY",
    presentation: ["?key=", "Authorization: Bearer"],
    fail_closed: "404 until secret is configured; 401 on wrong key",
    description: "Shared operator secret for /admin/* read and recovery routes.",
  },
  {
    id: "OPERATOR_PROBE",
    presentation: ["?key=", "Authorization: Bearer"],
    fail_closed: "404 until ADMIN_KEY or ANALYTICS_DEV_KEY is set; 401 on wrong key",
    description: "Accepts ADMIN_KEY or ANALYTICS_DEV_KEY (digest-send-test probe).",
  },
  {
    id: "SHADOW_STATUS_KEY",
    presentation: ["?key=", "Authorization: Bearer"],
    fail_closed: "404 until SHADOW_STATUS_KEY (or ADMIN_KEY) is set; 401 on wrong key; POST /admin/digest-shadow always requires ADMIN_KEY",
    description: "Read-only secret accepted only on GET /admin/digest-shadow. Lets an ops proxy read the rehearsal status without ADMIN_KEY custody.",
  },
  {
    id: "USAGE_KEY",
    presentation: ["?key=", "Authorization: Bearer", "X-Usage-Key"],
    fail_closed: "404 until secret is configured; 401 on wrong key",
    description: "Read-only /usage Haiku meter report for external briefings.",
  },
  {
    id: "ANALYTICS_DEV_KEY",
    presentation: ["HMAC token via X-CROL-Analytics-Dev", "also operator probe key"],
    fail_closed: "Invalid tokens count as production traffic; never a response oracle",
    description:
      "Signs short-lived developer-exclusion tokens for POST /events. Also accepted as "
      + "operator probe on digest-send-test. Configure with wrangler secret put ANALYTICS_DEV_KEY "
      + "(min 32 chars). Never commit the secret.",
  },
  {
    id: "Access",
    presentation: ["Cloudflare Access (or equivalent) in front of private desk"],
    fail_closed: "Desk-side only; this worker does not enforce Access JWTs on /admin/*",
    description:
      "Optional edge gate for private operator UIs. Worker auth remains ADMIN_KEY / probe keys.",
  },
]);

/** KV namespaces and key-prefix semantics (no values, no secrets). */
export const KV_NAMESPACES = Object.freeze([
  {
    binding: "ALERT_STATE",
    prefixes: [
      { prefix: "digest:daylog:", semantics: "Per-UTC-day send log JSON for desk correctness." },
      { prefix: "digest:run:", semantics: "Per-day and latest daily-run receipts." },
      { prefix: "digest:catchup:", semantics: "Catch-up run receipts (latest + per day)." },
      { prefix: "digest:shadow:degraded:", semantics: "Send-time degraded-policy receipts and recovery status." },
      { prefix: "seen:", semantics: "Per-watch seen notice id set (watermark adjacent)." },
      { prefix: "lastsent:", semantics: "Per-watch last live-send UTC day (delivery watermark)." },
      { prefix: "sendcount:", semantics: "Per-day live send counter (caps + /stats)." },
      { prefix: "stats:", semantics: "Aggregate outcome counters (day, alltime, cat, catday)." },
      { prefix: "hist:", semantics: "Day series for digests / watches gauges." },
      { prefix: "watchlog:", semantics: "Watch lifecycle events (day + latest)." },
      { prefix: "award:", semantics: "External award cache meta." },
      { prefix: "fc:", semantics: "Forecast cache keys." },
    ],
  },
  {
    binding: "SUBS",
    prefixes: [
      { prefix: "sub:", semantics: "Confirmed watch records (email + lens + filter + freq)." },
      { prefix: "pins:", semantics: "Opaque actor pin store (session sync); id is not email." },
      { prefix: "inv:", semantics: "Shared investigation snapshots (bounded TTL)." },
      { prefix: "rl:", semantics: "Rate-limit counters (addr / IP day keys)." },
    ],
  },
  {
    binding: "NL_METER",
    prefixes: [
      { prefix: "nl:", semantics: "Per-day natural-language search call counts." },
      { prefix: "stats:", semantics: "All-time / category NL search counters when used." },
    ],
  },
  {
    binding: "FEEDBACK",
    prefixes: [
      { prefix: "fb:", semantics: "Stored feedback rows for /admin/feedback." },
    ],
  },
]);

/** Runtime feature flags (env vars / bindings). */
export const FEATURE_FLAGS = Object.freeze([
  {
    name: "QUEUE_DIGESTS",
    values: ["true", "unset"],
    description: "When true and DIGEST_QUEUE is bound, daily fan-out uses queue mode.",
  },
  {
    name: "DIGEST_CATCH_UP",
    values: ["1", "true", "unset"],
    description: "One-shot cron catch-up; prefer POST /admin/digest-catchup for operator control.",
  },
  {
    name: "ALERTS_LIVE",
    values: ["true", "false", "unset"],
    description: "When not true, digests evaluate as dry_run (no Resend).",
  },
  {
    name: "DIGEST_QUEUE",
    values: ["binding", "unset"],
    description: "Cloudflare Queue binding required for queue mode.",
  },
  {
    name: "rollup",
    values: ["always-on"],
    description:
      "Account rollup is code-path default when an email has >1 active watch — not an env flag.",
  },
  {
    name: "ANALYTICS_ENVIRONMENT",
    values: ["production", "preview", "development", "unset"],
    description: "Usage writes only when exactly production (plus USAGE_ANALYTICS binding).",
  },
]);

/**
 * Usage / daylog traffic classes.
 * Daylog recovery uses catch_up; first-party events use production|developer.
 */
export const TRAFFIC_CLASSES = Object.freeze({
  usage: [
    {
      id: "production",
      description: "Real visitor / subscriber traffic. Included only in authenticated /admin/stats usage cuts.",
    },
    {
      id: "developer",
      description:
        "Debug traffic: valid X-CROL-Analytics-Dev exclusion, non-production "
        + "ANALYTICS_ENVIRONMENT, or explicit emitUsageEvent traffic_class. Excluded from "
        + "private production metrics.",
    },
  ],
  daylog: [
    {
      id: null,
      description: "Normal daily drip (omit or null traffic_class).",
    },
    {
      id: "catch_up",
      description: "Watermark recovery or multi-day lag stamp; desk correctnessCheck exempts.",
    },
  ],
});

export const USAGE_TRAFFIC_CLASSES = Object.freeze(["production", "developer"]);

/**
 * Build the v1 ops contract document (pure, no I/O, no secrets).
 * @param {{ generated_at?: string }} [opts]
 */
export function buildOpsContract(opts = {}) {
  return {
    contract: OPS_CONTRACT_ID,
    version: OPS_CONTRACT_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    min_compatible_version: "1.0.0",
    note:
      "Machine-readable ops contract for desk panels. No secrets. Not served on public /stats.",
    digest_modes: DIGEST_MODES,
    digest_shadow: DIGEST_SHADOW,
    daylog: {
      kv_key_pattern: "digest:daylog:YYYY-MM-DD",
      actions: DAYLOG_ACTIONS,
      skip_reasons: DAYLOG_SKIP_REASONS,
      entry_fields: DAYLOG_ENTRY_FIELDS,
      envelope_fields: DAYLOG_ENVELOPE_FIELDS,
      traffic_class: TRAFFIC_CLASSES.daylog,
    },
    stats_metrics: STATS_METRICS,
    admin_routes: ADMIN_ROUTES,
    auth_classes: AUTH_CLASSES,
    kv_namespaces: KV_NAMESPACES,
    feature_flags: FEATURE_FLAGS,
    traffic_class: {
      usage: TRAFFIC_CLASSES.usage,
      daylog: TRAFFIC_CLASSES.daylog,
      developer_key:
        "ANALYTICS_DEV_KEY — signs X-CROL-Analytics-Dev tokens; also operator probe for "
        + "digest-send-test. USAGE_KEY is separate (Haiku /usage report only).",
    },
  };
}

/** Stable JSON for fixture commits (sorted keys not required; fixed field order from builder). */
export function opsContractJson(opts = {}) {
  return `${JSON.stringify(buildOpsContract(opts), null, 2)}\n`;
}

/**
 * Normalize a usage traffic_class. Unknown / missing → production.
 * @param {unknown} value
 * @returns {"production"|"developer"}
 */
export function normalizeUsageTrafficClass(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "developer" ? "developer" : "production";
}

/**
 * Every closed daylog action id the worker is allowed to write (for test coverage).
 * Open-ended skipped:* is represented by the pattern entry.
 */
export function closedDaylogActionIds() {
  return DAYLOG_ACTIONS.filter((a) => !a.pattern).map((a) => a.id);
}

/**
 * Validate that a set of action strings is covered by the contract vocabulary.
 * @param {Iterable<string>} actions
 * @returns {{ ok: boolean, unknown: string[] }}
 */
export function validateDaylogActionsCovered(actions) {
  const unknown = [];
  for (const raw of actions) {
    const a = String(raw || "");
    if (!a) continue;
    if (a.startsWith("skipped:")) continue; // open-ended prefix is contracted
    if (closedDaylogActionIds().includes(a)) continue;
    unknown.push(a);
  }
  return { ok: unknown.length === 0, unknown };
}
