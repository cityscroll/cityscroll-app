// Prime-win sub-outreach surface (payload consumer only).
//
// Renders award/registration notice packaging from GET /contract-lifecycle
// `award_prime_goal` (cityscroll.award_prime_goal.v1). Shows only published
// facts: prime identity, agency, dollars, industry chips, and an optional
// possible-subcontract-window callout.
//
// HARD RULE (empty-state axe): when subcontract_goal.status is not_published
// (or goal_percent is null), render NOTHING for goals — no "data unavailable"
// div, no apology box, no class-(b) gap copy on the card. The reporting gap
// lives only in the gap-taxonomy / data-wishlist artifact.
//
// Pure: no fetch, no DOM, no i18n globals. Call sites inject t / esc / money.

export const SUB_OUTREACH_SCHEMA = "cityscroll.sub_outreach.v1";

/** Notice types that may mount the surface when lifecycle side-car is present. */
export const SUB_OUTREACH_NOTICE_TYPES = Object.freeze([
  "Award",
  "Intent to Award",
  "Intent to Negotiate",
  "Vendor List",
]);

/**
 * @param {object|null|undefined} noticeRow
 * @returns {boolean}
 */
export function isSubOutreachNoticeType(noticeRow) {
  if (!noticeRow || typeof noticeRow !== "object") return false;
  const section = String(noticeRow.section_name || "").trim();
  if (section === "Public Hearings and Meetings") return false;
  if (section === "Agency Rules") return false;
  if (section === "Property Disposition") return false;
  if (section === "Changes in Personnel") return false;
  const type = String(
    noticeRow.type_of_notice_description || noticeRow.type_of_notice || "",
  ).trim();
  if (SUB_OUTREACH_NOTICE_TYPES.includes(type)) return true;
  // Registration-matched solicitation may still carry award_prime_goal; type
  // gate is soft — final gate is hasSubOutreachSignals on the side-car.
  return section === "Procurement" && type === "Award";
}

/**
 * True when the payload has at least one allowlisted fact to paint.
 * Never counts subcontract_goal absence as a reason to paint an empty panel.
 *
 * @param {object|null|undefined} awardPrimeGoal
 * @returns {boolean}
 */
export function hasSubOutreachSignals(awardPrimeGoal) {
  const view = buildSubOutreachView(awardPrimeGoal);
  return !!(view && view.show);
}

/**
 * Build a presentation view from `lifecycle.award_prime_goal`.
 * Allowlist only — never invent, never surface goal-gap prose.
 *
 * @param {object|null|undefined} awardPrimeGoal
 * @returns {{
 *   schema: string,
 *   show: boolean,
 *   eligible: boolean,
 *   prime: { display_name: string, stem: string|null, subject_ref: string|null }|null,
 *   agency: { display_name: string, canonical_id: string|null, subject_ref: string|null }|null,
 *   dollars: { amount: number, source: string|null, basis: string|null }|null,
 *   industry_chips: Array<{ key: string, label: string, source: string|null }>,
 *   window_callout: { status: string, basis: string|null }|null,
 *   goal_block: null,
 * }}
 */
export function buildSubOutreachView(awardPrimeGoal) {
  const empty = {
    schema: SUB_OUTREACH_SCHEMA,
    show: false,
    eligible: false,
    prime: null,
    agency: null,
    dollars: null,
    industry_chips: [],
    window_callout: null,
    // Explicit null: callers must not invent a goal apology slot.
    goal_block: null,
  };

  if (!awardPrimeGoal || typeof awardPrimeGoal !== "object") return empty;
  if (awardPrimeGoal.eligible === false) return { ...empty, eligible: false };

  const primeName = clean(awardPrimeGoal.prime?.display_name);
  const prime = primeName
    ? {
        display_name: primeName,
        stem: clean(awardPrimeGoal.prime?.stem),
        subject_ref: clean(awardPrimeGoal.prime?.subject_ref),
      }
    : null;

  const agencyName = clean(awardPrimeGoal.agency?.display_name);
  const agency = agencyName
    ? {
        display_name: agencyName,
        canonical_id: clean(awardPrimeGoal.agency?.canonical_id),
        subject_ref: clean(awardPrimeGoal.agency?.subject_ref),
      }
    : null;

  const amountRaw = awardPrimeGoal.dollars?.amount;
  const amount =
    amountRaw != null && Number.isFinite(Number(amountRaw))
      ? Number(amountRaw)
      : null;
  const dollars =
    amount != null
      ? {
          amount,
          source: clean(awardPrimeGoal.dollars?.source),
          basis: clean(awardPrimeGoal.dollars?.basis),
        }
      : null;

  const industry_chips = [];
  if (Array.isArray(awardPrimeGoal.industry_chips)) {
    for (const chip of awardPrimeGoal.industry_chips) {
      const label = clean(chip?.label);
      if (!label) continue;
      industry_chips.push({
        key: clean(chip?.key) || label.toLowerCase().replace(/\s+/g, "_"),
        label,
        source: clean(chip?.source),
      });
    }
  }

  // Window callout only when the payload stamps open_candidate.
  // Never claim remaining goal capacity; never mention the goal gap.
  const win = awardPrimeGoal.possible_subcontract_window;
  const window_callout =
    win && win.status === "open_candidate"
      ? {
          status: "open_candidate",
          basis: clean(win.basis),
        }
      : null;

  // HARD RULE: goal_percent not_published / null → goal_block stays null.
  // Even when status is "present", this surface's allowlist omits goal %.
  // The reporting gap is the wishlist artifact only.
  const goal_block = null;
  void awardPrimeGoal.subcontract_goal; // deliberately unread for render

  const show = !!(
    prime
    || agency
    || dollars
    || industry_chips.length
    || window_callout
  );

  return {
    schema: SUB_OUTREACH_SCHEMA,
    show,
    eligible: awardPrimeGoal.eligible !== false,
    prime,
    agency,
    dollars,
    industry_chips,
    window_callout,
    goal_block,
  };
}

/**
 * Detect apology / goal-gap copy that must never ship on this card.
 * Used by characterization tests and surface-load sampling.
 *
 * @param {string} html
 * @returns {string[]} matching phrases (lowercased)
 */
export function detectSubOutreachApologyCopy(html) {
  const text = String(html || "").toLowerCase();
  const phrases = [
    "data unavailable",
    "not available",
    "not published",
    "city does not publish",
    "not yet shown here",
    "goal percent",
    "goal %",
    "mwbe goal",
    "m/wbe goal",
    "participation goal",
    "remaining goal",
    "utilization target",
    "subcontract goal",
    "honest absent",
    "would appear in",
  ];
  return phrases.filter((p) => text.includes(p));
}

/**
 * Render the sub-outreach card HTML from a view (or raw payload).
 * Returns "" when there is nothing allowlisted to show.
 *
 * @param {object|null|undefined} awardPrimeGoalOrView
 * @param {object} [opts]
 * @param {(key: string, vars?: object) => string} [opts.t]
 * @param {(s: unknown) => string} [opts.esc]
 * @param {(n: number) => string} [opts.money]
 * @returns {string}
 */
export function subOutreachHTML(awardPrimeGoalOrView, opts = {}) {
  const t = typeof opts.t === "function" ? opts.t : defaultT;
  const esc = typeof opts.esc === "function" ? opts.esc : defaultEsc;
  const moneyFmt = typeof opts.money === "function" ? opts.money : defaultMoney;

  const view =
    awardPrimeGoalOrView
    && awardPrimeGoalOrView.schema === SUB_OUTREACH_SCHEMA
    && "show" in awardPrimeGoalOrView
      ? awardPrimeGoalOrView
      : buildSubOutreachView(awardPrimeGoalOrView);

  if (!view || !view.show) return "";

  // Belt-and-suspenders: never emit a goal block even if a future view drifts.
  if (view.goal_block != null) {
    view.goal_block = null;
  }

  const rows = [];

  if (view.prime) {
    rows.push(`<div class="sub-outreach-row" data-field="prime">
      <div class="stage-name">${esc(t("sub_outreach_prime_lbl"))}</div>
      <div lang="en" dir="ltr"><strong>${esc(view.prime.display_name)}</strong></div>
    </div>`);
  }

  if (view.agency) {
    rows.push(`<div class="sub-outreach-row" data-field="agency">
      <div class="stage-name">${esc(t("sub_outreach_agency_lbl"))}</div>
      <div lang="en" dir="ltr">${esc(view.agency.display_name)}</div>
    </div>`);
  }

  if (view.dollars) {
    rows.push(`<div class="sub-outreach-row" data-field="dollars">
      <div class="stage-name">${esc(t("sub_outreach_dollars_lbl"))}</div>
      <div><span class="tag amt">${esc(moneyFmt(view.dollars.amount))}</span></div>
    </div>`);
  }

  if (view.industry_chips.length) {
    const chips = view.industry_chips
      .map(
        (c) =>
          `<span class="tag" data-industry-key="${esc(c.key)}" lang="en" dir="ltr">${esc(c.label)}</span>`,
      )
      .join(" ");
    rows.push(`<div class="sub-outreach-row" data-field="industry">
      <div class="stage-name">${esc(t("sub_outreach_industry_lbl"))}</div>
      <div class="sub-outreach-chips">${chips}</div>
    </div>`);
  }

  const callout = view.window_callout
    ? `<div class="sub-outreach-window" data-window-status="open_candidate" role="note">
        ${esc(t("sub_outreach_window_callout"))}
      </div>`
    : "";

  // No methodology disclosure about goal gaps — empty-state axe.
  // Optional how-toggle only when we have a positive fact list.
  const how = rows.length
    ? `<details class="inline-disclose lc-how"><summary>${esc(t("sub_outreach_how_summary"))}</summary><div class="inline-disclose-body">${t("sub_outreach_provenance_html")}</div></details>`
    : "";

  const html = `<section class="sub-outreach-detail" data-sub-outreach="1" aria-label="${esc(t("sub_outreach_heading"))}">
    <div class="chain-h">${esc(t("sub_outreach_heading"))}</div>
    ${rows.join("\n")}
    ${callout}
    ${how}
  </section>`;

  // Final guard: characterization + runtime refuse apology phrases.
  if (detectSubOutreachApologyCopy(html).length) {
    return "";
  }
  return html;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function defaultEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultT(key) {
  return key;
}

function defaultMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: v % 1 === 0 ? 0 : 2,
    }).format(v);
  } catch (_e) {
    return `$${v.toLocaleString("en-US")}`;
  }
}
