/* ===================== CONTRACT LIFECYCLE TIMELINE (PROC-001) =====================
    A compact horizontal timeline on notice detail showing the full procurement journey:
    solicitation/award → pending → registered → payment. Consumes the precomputed read model
    from GET /contract-lifecycle?id=<request_id> (worker/src/checkbook_lifecycle.mjs) — no
    live upstream fetch from the client. Unmatched/ambiguous/unknown stages render as specific
    statements in the established "no record found" register, never blank. Each stage links to
    its authoritative source page (City Record or Checkbook NYC). OCP Recent Contract Awards
    (qyyg-4tf5) rides the same precomputed payload as an award side-car for date/amount
    corroboration — disagreements name both sources.

    Category-aware dispatch: only procurement notices mount this module. Hearings, rules,
    property disposition, and staffing are wrong-universe for PIN/Checkbook/OCP gaps — leave
    the slot empty rather than stacking "not found" cards on a public hearing. */

// Contract lifecycle (PIN, Checkbook, OCP awards) is meaningful only for procurement.
// Section is authoritative when present; notice type covers paths that omit section_name.
function isContractLifecycleEligible(r){
  if(!r) return false;
  const section=String(r.section_name||"");
  if(section==="Procurement") return true;
  if(section==="Public Hearings and Meetings") return false;
  if(section==="Agency Rules") return false;
  if(section==="Property Disposition") return false;
  if(section==="Changes in Personnel") return false;
  return /^(Solicitation|Award|Intent to Award|Intent to Negotiate|Vendor List)$/.test(r.type_of_notice_description||"");
}
const CHECKBOOK_SEARCH_URL = "https://www.checkbooknyc.com/contract_search";
const CHECKBOOK_SPENDING_URL = "https://www.checkbooknyc.com/spending_search";
const CHECKBOOK_SMART_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";
const OCP_AWARDS_URL = "https://data.cityofnewyork.us/d/qyyg-4tf5";

// Infer Checkbook document_code (CT1, DO1, …) from a prime_contract_id when the API
// did not stamp doctype. Citywide detail URLs need both agid + doctype.
function checkbookDocumentCode(contractId, explicit){
  if(explicit) return String(explicit).trim().toUpperCase() || null;
  const m = String(contractId || "").trim().match(/^([A-Za-z]+)(\d)/);
  return m ? (m[1] + m[2]).toUpperCase() : null;
}

// Prefer a verified contract-detail URL when Checkbook agid is known; else scoped
// smart_search by contract id / PIN / vendor; never a bare landing when a term exists.
// Citywide detail paths use /contract_details/agid/{id}/doctype/{code} (not the CT id alone).
function checkbookSearchUrl(opts){
  opts = opts || {};
  if(opts.detailUrl){
    try{
      const u = new URL(String(opts.detailUrl));
      if(u.protocol === "https:" && u.hostname.includes("checkbooknyc.com")) return u.toString();
    }catch(_e){ /* fall through */ }
  }
  const agid = opts.agid != null ? String(opts.agid).trim() : "";
  if(/^\d+$/.test(agid)){
    const code = checkbookDocumentCode(opts.contractId, opts.documentCode || opts.doctype) || "CT1";
    return `https://www.checkbooknyc.com/contract_details/agid/${encodeURIComponent(agid)}/doctype/${encodeURIComponent(code)}`;
  }
  const term = opts.contractId || opts.pin || opts.vendor || opts.searchTerm;
  if(term) return `${CHECKBOOK_SMART_SEARCH}?search_term=${encodeURIComponent(String(term))}`;
  if(opts.kind === "spending") return CHECKBOOK_SPENDING_URL;
  return CHECKBOOK_SEARCH_URL;
}

function lifecycleStageLabel(stage){
  if(stage === "solicitation") return t("lifecycle_stage_solicitation");
  if(stage === "intent_to_negotiate") return t("lifecycle_stage_intent_to_negotiate");
  if(stage === "vendor_list") return t("lifecycle_stage_vendor_list");
  if(stage === "intent_to_award") return t("lifecycle_stage_intent_to_award");
  if(stage === "award") return t("lifecycle_stage_award");
  if(stage === "pending") return t("lifecycle_stage_pending");
  if(stage === "registered") return t("lifecycle_stage_registered");
  if(stage === "payment") return t("lifecycle_stage_payment");
  return stage;
}

// Zero-safe money for lifecycle cards: never stringify as the literal "null".
// money() treats 0 as null (hides empty award amounts elsewhere); lifecycle spent/current
// lines must show $0 or an em dash instead.
function lifecycleMoney(v){
  if(v == null || v === "" || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  if(n === 0) return "$0";
  return money(n) || "$0";
}

function lifecycleAmount(entry){
  const d = entry.detail;
  if(!d) return null;
  if(entry.stage === "award" || entry.stage === "intent_to_award") return d.amount != null ? d.amount : null;
  if(entry.stage === "pending") return d.amount != null ? d.amount : null;
  if(entry.stage === "registered") return d.current_amount != null ? d.current_amount : null;
  if(entry.stage === "payment") return d.total_spent != null ? d.total_spent : null;
  return null;
}

// Distinct dataset labels for gap copy — never claim "lives in Checkbook NYC" as a
// blanket source when the page already joins another domain on the same notice.
// PASSPort sources use lifecycleSourceName; Checkbook stages name the specific feed.
function lifecycleGapSourceName(entry){
  if(entry.source === "city-record") return t("lifecycle_source_city_record");
  if(entry.source === "passport-public-contracts" || entry.source === "passport-public-rfx"){
    return t("lifecycle_source_passport");
  }
  if(entry.stage === "pending") return t("lifecycle_source_checkbook_pending");
  if(entry.stage === "registered") return t("lifecycle_source_checkbook_registered");
  if(entry.stage === "payment" || entry.source === "checkbook-spending") return t("lifecycle_source_checkbook_spending");
  return t("lifecycle_source_checkbook");
}

// The authoritative source link for each stage: City Record for solicitation/award,
// Checkbook NYC for the procurement steps, PASSPort Public for EPIN-joined pending/
// registered/RFx, Current Solicitations (Open Data) for package enrichment. An unmatched
// stage still links to the source search so the reader can verify.
const PASSPORT_CONTRACTS_URL = "https://a0333-passportpublic.nyc.gov/contracts.html";
const PASSPORT_RFX_URL = "https://a0333-passportpublic.nyc.gov/rfx.html";
const CURRENT_SOLICITATIONS_URL = "https://data.cityofnewyork.us/d/3khw-qi8f";

function lifecycleSourceName(source){
  if(source === "city-record") return t("lifecycle_source_city_record");
  if(source === "checkbook-contracts" || source === "checkbook-spending") return t("lifecycle_source_checkbook");
  if(source === "passport-public-contracts" || source === "passport-public-rfx") return t("lifecycle_source_passport");
  if(source === "ocp-current-solicitations") return t("lifecycle_source_current_solicitations");
  return t("lifecycle_source_checkbook");
}

// Package-documents sub-slot on the solicitation stage.
// Matched → real document links (historical City Record GetFile / OCP when present).
// Unmatched → class (b) not-published: modern public feeds do not publish package docs
// (measured 2026-07-30; RFx dump has no document URLs; OCP/City Record 2025+ fill 0%).
// Unknown → reachability only.
const CITY_RECORD_GETFILE_URL = "https://a856-cityrecord.nyc.gov/Search/GetFile";

function lifecycleDocumentsHTML(entry){
  if(entry.stage !== "solicitation") return "";
  const d = entry.detail || {};
  const docsStatus = entry.documents_status || d.documents_status || null;
  if(!docsStatus) return "";
  const src = `<span lang="en" dir="ltr">${t("lifecycle_source_current_solicitations")}</span>`;
  if(docsStatus === "matched" && Array.isArray(d.documents) && d.documents.length){
    const links = d.documents.map((url, i) =>
      `<a class="view" href="${escUiHtml(url)}" ${EXT_ATTRS}>${t("lifecycle_document_link",{n:i+1})}${extSR()}</a>`
    ).join(" · ");
    const due = d.due_date ? `<div class="lc-due">${t("lifecycle_due_html",{date:fdate(d.due_date)})}</div>` : "";
    return `<div class="lc-docs"><div class="lc-docs-h">${tn("lifecycle_documents_count", d.documents.length)}</div>${due}<div class="lc-docs-links">${links}</div></div>`;
  }
  if(docsStatus === "unknown"){
    return `<div class="lc-norecord lc-docs-gap">${t("lifecycle_unknown_html",{source:src})}</div>`;
  }
  if(docsStatus === "ambiguous"){
    return `<div class="lc-norecord lc-docs-gap">${t("lifecycle_ambiguous_html")}</div>`;
  }
  // unmatched — class (b) not-published. One short line + one outbound pointer
  // (never a multi-clause hedge with two outbound links). When the notice request_id
  // is known, deep-link City Record RequestDetail (the notice that would carry GetFile
  // attachments). Bare GetFile without DocumentID is a hunt page — only when no request_id.
  const rid = d.request_id || (entry.detail && entry.detail.request_id) || null;
  const where = rid
    ? `<a class="view" href="${REQ_URL(rid)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("lifecycle_source_city_record")}</span>${extSR()}</a>`
    : `<a class="view" href="${CITY_RECORD_GETFILE_URL}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("lifecycle_source_city_record_getfile")}</span>${extSR()}</a>`;
  return `<div class="lc-docs-caveat lc-docs-gap">${t("lifecycle_documents_not_published_html",{where})}</div>`;
}

// ctx: optional {contractId, pin, vendor} when the stage detail lacks a join key but the
// surrounding notice / registered row already has one (payment card is the common case).
function lifecycleSourceLink(entry, ctx){
  ctx = ctx || {};
  if(entry.source === "city-record" && entry.detail && entry.detail.request_id){
    return `<a class="view" href="${REQ_URL(entry.detail.request_id)}" ${EXT_ATTRS}>${t("lifecycle_source_city_record")}${extSR()}</a>`;
  }
  if(entry.source === "ocp-current-solicitations"){
    const rid = entry.detail && entry.detail.request_id;
    if(rid){
      return `<a class="view" href="${REQ_URL(rid)}" ${EXT_ATTRS}>${t("lifecycle_source_city_record")}${extSR()}</a>`
        + ` · <a class="view" href="${CURRENT_SOLICITATIONS_URL}" ${EXT_ATTRS}>${t("lifecycle_source_current_solicitations")}${extSR()}</a>`;
    }
    return `<a class="view" href="${CURRENT_SOLICITATIONS_URL}" ${EXT_ATTRS}>${t("lifecycle_source_current_solicitations")}${extSR()}</a>`;
  }
  if(entry.source === "checkbook-contracts"){
    const d = entry.detail || {};
    const id = d.contract_id || ctx.contractId;
    return `<a class="view" href="${checkbookSearchUrl({
      contractId:id, pin:ctx.pin, vendor:ctx.vendor,
      agid:d.agid || d.checkbook_agid, documentCode:d.document_code || d.doctype,
      detailUrl:d.checkbook_detail_url,
    })}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`;
  }
  if(entry.source === "checkbook-spending"){
    const d = entry.detail || {};
    const id = d.contract_id || ctx.contractId;
    return `<a class="view" href="${checkbookSearchUrl({
      contractId:id, pin:ctx.pin, vendor:ctx.vendor, kind:"spending",
      agid:d.agid || d.checkbook_agid, documentCode:d.document_code || d.doctype,
      detailUrl:d.checkbook_detail_url,
    })}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`;
  }
  if(entry.source === "passport-public-contracts"){
    return `<a class="view" href="${entry.portal || PASSPORT_CONTRACTS_URL}" ${EXT_ATTRS}>${t("lifecycle_source_passport")}${extSR()}</a>`;
  }
  if(entry.source === "passport-public-rfx"){
    return `<a class="view" href="${entry.portal || PASSPORT_RFX_URL}" ${EXT_ATTRS}>${t("lifecycle_source_passport")}${extSR()}</a>`;
  }
  return "";
}

// Stage order for succession: when a later stage is matched, earlier gaps are "passed".
// Intermediate City Record stages sit between solicitation and award (PIN-sibling join).
// Keep single-line: test extractConst("LIFECYCLE_STAGE_ORDER") scrapes this declaration.
const LIFECYCLE_STAGE_ORDER = {solicitation:0,intent_to_negotiate:1,vendor_list:2,intent_to_award:3,award:4,pending:5,registered:6,payment:7};

function lifecycleHasLaterMatched(timeline, stage){
  const order = LIFECYCLE_STAGE_ORDER[stage];
  if(order == null) return false;
  return (timeline || []).some(e =>
    e && e.status === "matched" && (LIFECYCLE_STAGE_ORDER[e.stage] ?? -1) > order);
}

// Coerce precompute statuses for public display:
// - not_applicable → omit (caller filters)
// - unknown never surfaces as "Could not reach" — map to unmatched taxonomy, or passed
//   when a later stage is already on record
// - unmatched + later matched → passed (stage succession)
// - payment with a matched registered join is never a public gap: paid-to-date lives on
//   that join (Follow-the-Dollars = detail owner; payments card = summary)
function lifecyclePublicStatus(entry, timeline){
  if(!entry) return "unmatched";
  if(entry.status === "not_applicable") return "not_applicable";
  if(entry.status === "matched" || entry.status === "ambiguous" || entry.status === "passed") return entry.status;
  if(lifecycleHasLaterMatched(timeline, entry.stage)) return "passed";
  // Payment stage: when registration joined, $0/paid is a known Checkbook fact — not a gap.
  if(entry.stage === "payment" && lifecycleMatchedRegisteredDetail(timeline)) return "matched";
  // Transient lookup failure and confirmed empty both use the taxonomy gap register
  // for the reader — never the operational "could not reach" wording on notice detail.
  if(entry.status === "unknown" || entry.status === "unmatched") return "unmatched";
  return entry.status;
}

// Matched registered contract detail from the same timeline (payment/dollars ownership).
function lifecycleMatchedRegisteredDetail(timeline){
  const reg = (timeline || []).find(e => e && e.stage === "registered" && e.status === "matched" && e.detail);
  return reg ? reg.detail : null;
}

// Stable anchor for Follow-the-Dollars — payments card links here for money detail.
const LIFECYCLE_DOLLARS_ANCHOR = "follow-the-dollars";

// Deep-link into Follow-the-Dollars on this notice (never a bare #follow-the-dollars —
// that hash falls through applyHash and ejects the reader to the money tab).
function lifecycleDollarsFocusHref(noticeId){
  if(!noticeId) return "#" + LIFECYCLE_DOLLARS_ANCHOR;
  return `#notice/${encodeURIComponent(String(noticeId))}?focus=${encodeURIComponent(LIFECYCLE_DOLLARS_ANCHOR)}`;
}

// Resolve payment_state for three-state honesty (paid / verified_zero / unavailable).
// Legacy payloads without payment_state: total_spent null → unavailable; else infer.
function lifecyclePaymentState(detail){
  if(!detail) return null;
  if(detail.payment_state) return detail.payment_state;
  if(detail.total_spent == null && detail.total_payments == null) return "unavailable";
  if(detail.total_payments != null) return "paid";
  if(Number(detail.total_spent) === 0) return "verified_zero";
  return detail.derived_from === "registered" ? "from_registered" : "paid";
}

// One paid-to-date resolution for the payments card AND Follow-the-Dollars.
// Prefer spending-feed totals; fall back to registration spent_to_date when the join
// has it. "unavailable" only when neither path has a usable figure (never invent $0
// over a spending-error unavailable when registration spent is also 0).
// Field case #notice/20240723114: payment unknown + PASSPort spent $4.02M must not
// show "unavailable" on the payments card while dollars shows 54% paid.
function lifecycleResolvedPayment(regDetail, payDetail){
  const payState = lifecyclePaymentState(payDetail);
  if(payDetail && payState === "paid" && payDetail.total_spent != null){
    return { state: "paid", spent: Number(payDetail.total_spent), totalPayments: payDetail.total_payments };
  }
  if(payDetail && (payState === "from_registered" || payState === "verified_zero") && payDetail.total_spent != null){
    return { state: payState, spent: Number(payDetail.total_spent), totalPayments: null };
  }
  const regSpent = regDetail && regDetail.spent_to_date != null && Number.isFinite(Number(regDetail.spent_to_date))
    ? Number(regDetail.spent_to_date) : null;
  if(regSpent != null){
    if(payState === "unavailable" && regSpent === 0){
      return { state: "unavailable", spent: null, totalPayments: null };
    }
    return {
      state: regSpent === 0 ? "verified_zero" : "from_registered",
      spent: regSpent,
      totalPayments: null,
    };
  }
  if(payState === "unavailable") return { state: "unavailable", spent: null, totalPayments: null };
  return { state: payState || "unavailable", spent: null, totalPayments: null };
}

// Parse a registration/term end date (ISO or PASSPort MM/DD/YYYY) and report if it is past.
function lifecycleTermEnded(endDate){
  if(!endDate) return false;
  const raw = String(endDate).trim();
  let iso = raw.slice(0, 10);
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m) iso = m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
  const t = Date.parse(iso);
  if(!Number.isFinite(t)) return false;
  return t < Date.now() - 86400000;
}

// Term ended + paid below ~95% of committed: show ceiling framing (not an unpaid debt).
// Field case #notice/20230728114 — single-row Checkbook verified at 57% of ceiling.
function lifecycleCommittedUnderrun(paid, committed, endDate){
  const paidN = paid != null ? Number(paid) : NaN;
  const committedN = committed != null ? Number(committed) : NaN;
  if(!Number.isFinite(paidN) || !Number.isFinite(committedN) || committedN <= 0) return false;
  if(paidN <= 0) return false;
  if(paidN >= committedN * 0.95) return false;
  return lifecycleTermEnded(endDate);
}

// Payments card summary when Checkbook join exists: amounts + optional $0 lag note +
// notice-scoped deep link to the dollars panel. Never gap copy while the join is present.
// payment_state "unavailable" never renders a confident $0.
function lifecyclePaymentSummaryHTML(paid, committed, opts){
  opts = opts || {};
  const committedN = committed != null ? Number(committed) : 0;
  const state = opts.paymentState || null;
  const includeZeroLag = opts.includeZeroLag !== false;
  let html = "";
  if(state === "unavailable"){
    html += `<div class="lc-pct">${t("lifecycle_payment_unavailable_html")}</div>`;
  } else {
    const paidN = paid != null ? Number(paid) : 0;
    html += `<div class="lc-pct">${t("lifecycle_payment_summary_html",{
      paid: lifecycleMoney(paidN),
      committed: lifecycleMoney(committedN)
    })}</div>`;
    if(paidN === 0 && opts.zeroLag !== false && includeZeroLag){
      html += `<div class="lc-pct">${t("lifecycle_payment_zero_lag_html")}</div>`;
    } else if(opts.ceilingNote){
      html += `<div class="lc-pct">${t("lifecycle_committed_ceiling_note_html")}</div>`;
    }
  }
  if(opts.link !== false){
    html += `<div class="lc-pct">${t("lifecycle_payment_details_link_html",{
      href: lifecycleDollarsFocusHref(opts.noticeId)
    })}</div>`;
  }
  return html;
}

// Last matched stage (or first ambiguous needing attention) is the reader's "current" step.
function lifecycleCurrentStageKey(timeline){
  const raw = timeline || [];
  for(const e of raw){
    if(lifecyclePublicStatus(e, raw) === "ambiguous") return e.stage;
  }
  let lastMatched = null;
  for(const e of raw){
    if(lifecyclePublicStatus(e, raw) === "matched") lastMatched = e.stage;
    // Payment with a registered join is treated as matched for display.
    if(e && e.stage === "payment" && lifecycleMatchedRegisteredDetail(raw)) lastMatched = "payment";
  }
  return lastMatched;
}

// Compact progress chips for every stage. Future/unmatched steps are greyed — no prose.
function lifecycleStepperHTML(entries, timeline, currentKey){
  if(!entries || !entries.length) return "";
  const items = entries.map((entry, idx) => {
    let status = lifecyclePublicStatus(entry, timeline);
    if(entry.stage === "payment" && lifecycleMatchedRegisteredDetail(timeline) && status === "unmatched"){
      status = "matched";
    }
    const isCurrent = entry.stage === currentKey;
    let cls = "future";
    if(status === "matched") cls = isCurrent ? "matched current" : "matched";
    else if(status === "passed") cls = "passed";
    else if(status === "ambiguous") cls = isCurrent ? "ambiguous current" : "ambiguous";
    else if(status === "unmatched" || status === "unknown") cls = "future";
    const aria = isCurrent ? ` aria-current="step"` : "";
    const arrow = idx < entries.length - 1 ? `<span class="lc-step-arrow" aria-hidden="true">→</span>` : "";
    return `<li><span class="lc-step ${cls}"${aria}>${lifecycleStageLabel(entry.stage)}</span>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper" aria-label="${escUiHtml(t("lifecycle_heading"))}">${items}</ol>`;
}

// Detail cards only for stages that carry data or need a human decision.
// Unmatched future stages collapse into the stepper (no "Not yet shown here" paragraph).
// opts.showSourceLink: only the current stage may emit an outbound source link (dedupe).
function lifecycleStageHTML(entry, timeline, notice, opts){
  opts = opts || {};
  let publicStatus = lifecyclePublicStatus(entry, timeline);
  if(publicStatus === "not_applicable") return "";

  // Future empty stages: stepper only.
  if(publicStatus === "unmatched" || publicStatus === "unknown") return "";

  const isCurrent = !!opts.isCurrent || entry.stage === opts.currentKey;
  if(typeof entry.renderLifecycleStage === "function"){
    return entry.renderLifecycleStage(entry, {
      isCurrent,
      t,
      esc: escUiHtml,
      money: lifecycleMoney,
      externalLinkAttributes: EXT_ATTRS,
      externalLinkSuffix: extSR,
    });
  }
  const label = lifecycleStageLabel(entry.stage);
  const showLink = opts.showSourceLink !== false && isCurrent && publicStatus !== "passed";
  const dateHTML = entry.date ? `<div class="when">${fdate(entry.date)}</div>` : (publicStatus === "passed" ? "" : `<div class="when">—</div>`);
  let detailHTML = "";
  const regDetail = lifecycleMatchedRegisteredDetail(timeline);
  const sourceCtx = {
    contractId: regDetail && regDetail.contract_id,
    pin: (notice && notice.pin) || (regDetail && regDetail.pin) || null,
    vendor: (regDetail && regDetail.vendor) || (notice && notice.vendor_name) || null,
  };

  // Ownership: when registration joined, payments card summarizes paid/committed and
  // links to Follow-the-Dollars — never parallel gap copy. Resolve paid-to-date with
  // lifecycleResolvedPayment so this card never says "unavailable" while dollars shows
  // a joined amount (and the reverse).
  if(entry.stage === "payment" && regDetail){
    publicStatus = "matched";
    const d = entry.detail || {};
    const resolved = lifecycleResolvedPayment(regDetail, entry.detail);
    const payState = resolved.state;
    const paid = resolved.spent;
    const committed = regDetail.current_amount != null ? regDetail.current_amount : 0;
    let extraHTML = "";
    const paymentCount = d.total_payments != null ? d.total_payments : resolved.totalPayments;
    if(paymentCount){
      extraHTML += `<div class="lc-pcount">${tn("lifecycle_payments_count", paymentCount)}</div>`;
      if(d.latest_payment_amount != null){
        extraHTML += `<div class="lc-pct">${t("lifecycle_latest_payment_html",{amount:lifecycleMoney(d.latest_payment_amount),date:fdate(d.latest_payment_date)})}</div>`;
      }
    }
    extraHTML += lifecyclePaymentSummaryHTML(paid, committed, {
      zeroLag: payState === "verified_zero" || (payState !== "unavailable" && Number(paid) === 0),
      ceilingNote: lifecycleCommittedUnderrun(paid, committed, regDetail.end_date),
      noticeId: notice && notice.request_id,
      paymentState: payState,
    });
    const amtHTML = payState === "unavailable"
      ? `<div class="amt muted">—</div>`
      : `<div class="amt">${lifecycleMoney(paid)}</div>`;
    detailHTML = amtHTML + extraHTML;
    const link = showLink ? lifecycleSourceLink(entry, sourceCtx) : "";
    const curCls = isCurrent ? " current-stage" : "";
    return `<div class="stage"><div class="box matched${curCls}">
      <div class="stage-name">${label}</div>
      ${dateHTML}
      ${detailHTML}
      ${link}
    </div></div>`;
  }

  if(publicStatus === "matched"){
    const amt = lifecycleAmount(entry);
    const amtHTML = (amt != null) ? `<div class="amt">${lifecycleMoney(amt)}</div>` : "";
    const d = entry.detail || {};
    let extraHTML = "";
    if(entry.stage === "registered" && d.current_amount > 0 && d.original_amount > 0 &&
       Math.abs(d.current_amount - d.original_amount) > 1){
      extraHTML += `<div class="lc-amend">${t("lifecycle_amended_from_html",{original:lifecycleMoney(d.original_amount)})}</div>`;
    }
    // Paid-to-date is owned by the payments card + Follow-the-Dollars — not a second spent
    // bar on the registration card (one owner per fact).
    if(entry.stage === "payment" && d.total_payments){
      extraHTML += `<div class="lc-pcount">${tn("lifecycle_payments_count", d.total_payments)}</div>`;
      if(d.latest_payment_amount != null){
        extraHTML += `<div class="lc-pct">${t("lifecycle_latest_payment_html",{amount:lifecycleMoney(d.latest_payment_amount),date:fdate(d.latest_payment_date)})}</div>`;
      }
    } else if(entry.stage === "payment" && d.total_spent != null && !d.total_payments){
      // No registered join — fall back to paid-to-date line only
      extraHTML += `<div class="lc-pct">${t("lifecycle_paid_to_date_html",{amount:lifecycleMoney(d.total_spent)})}</div>`;
    }
    if((entry.stage === "award" || entry.stage === "pending") && d.vendor){
      extraHTML += `<div class="vend">${t("awarded_to")} <b lang="en" dir="ltr">${escUiHtml(d.vendor)}</b></div>`;
    }
    if(entry.stage === "registered" && d.vendor){
      extraHTML += `<div class="vend">${t("awarded_to")} <b lang="en" dir="ltr">${escUiHtml(d.vendor)}</b></div>`;
    }
    if(entry.stage === "pending" && d.passport_status){
      extraHTML += `<div class="lc-pct">${escUiHtml(d.passport_status)}</div>`;
    }
    if(entry.stage === "solicitation" && d.rfx){
      const rfx = d.rfx;
      extraHTML += `<div class="lc-pct">${t("lifecycle_rfx_heading")}</div>`;
      if(rfx.due_date) extraHTML += `<div class="lc-pct">${t("lifecycle_rfx_due_html",{date:fdate(rfx.due_date) || escUiHtml(rfx.due_date)})}</div>`;
      if(rfx.rfx_status) extraHTML += `<div class="lc-pct">${t("lifecycle_rfx_status_html",{status:escUiHtml(rfx.rfx_status)})}</div>`;
      if(rfx.procurement_method) extraHTML += `<div class="lc-pct">${t("lifecycle_rfx_method_html",{method:escUiHtml(rfx.procurement_method)})}</div>`;
    }
    if(entry.stage === "solicitation"){
      if(d.due_date && !(entry.documents_status === "matched" && d.documents && d.documents.length)){
        extraHTML += `<div class="lc-due">${t("lifecycle_due_html",{date:fdate(d.due_date)})}</div>`;
      }
      extraHTML += lifecycleDocumentsHTML(entry);
    }
    detailHTML = amtHTML + extraHTML;
  } else if(publicStatus === "passed"){
    const specificKey = "lifecycle_passed_" + entry.stage + "_html";
    let note = t(specificKey);
    if(note === specificKey) note = t("lifecycle_passed_generic_html");
    detailHTML = `<div class="lc-norecord">${note}</div>`;
  } else if(publicStatus === "ambiguous"){
    detailHTML = `<div class="lc-norecord">${t("lifecycle_ambiguous_html")}</div>`;
    if(entry.detail && Array.isArray(entry.detail.candidates)){
      const cands = entry.detail.candidates.map(c => {
        const amt = c.current_amount != null ? c.current_amount : (c.amount || 0);
        const dt = c.registration_date || c.received_date || null;
        return `<div>${lifecycleMoney(amt)}${dt ? " · " + fdate(dt) : ""}${c.contract_id ? ` · <code>${c.contract_id}</code>` : ""}</div>`;
      }).join("");
      detailHTML += `<div class="lc-candidates">${cands}</div>`;
    }
  }

  const link = (showLink && publicStatus !== "passed") ? lifecycleSourceLink(entry, sourceCtx) : "";
  const curCls = isCurrent && publicStatus !== "passed" ? " current-stage" : "";
  return `<div class="stage"><div class="box ${publicStatus}${curCls}">
    <div class="stage-name">${label}</div>
    ${dateHTML}
    ${detailHTML}
    ${link}
  </div></div>`;
}

// OCP Recent Contract Awards side-car (precomputed on the lifecycle payload — no live client
// SODA fetch). Matched rows flip the not-yet-ingested gap to real joined data; when City
// Record and OCP disagree on date or amount, both values render with sources named.
function lifecycleOcpAwardHTML(data){
  const ocp = data && data.ocp_award;
  if(!ocp) return "";
  const srcLink = `<a href="${OCP_AWARDS_URL}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("lifecycle_source_ocp")}</span>${extSR()}</a>`;
  const srcName = `<span lang="en" dir="ltr">${t("lifecycle_source_ocp")}</span>`;
  const cityName = `<span lang="en" dir="ltr">${t("lifecycle_source_city_record")}</span>`;

  // Unmatched / unknown OCP rows collapse into the stepper era — no empty "not yet shown"
  // paragraph on a fresh solicitation. Only matched or ambiguous OCP data surfaces.
  if(ocp.status === "unmatched" || ocp.status === "unknown") return "";
  if(ocp.status === "ambiguous"){
    let cands = "";
    if(Array.isArray(ocp.candidates) && ocp.candidates.length){
      cands = `<div class="lc-candidates">${ocp.candidates.map(c =>
        `<div>${money(c.amount) || "—"}${c.date ? " · " + fdate(c.date) : ""}${c.vendor ? " · " + escUiHtml(c.vendor) : ""}${c.request_id ? ` · <code>${escUiHtml(c.request_id)}</code>` : ""}</div>`
      ).join("")}</div>`;
    }
    return `<div class="note" style="margin-top:10px"><b>${t("lifecycle_ocp_heading")}</b> ${t("lifecycle_ocp_ambiguous_html")}${cands}</div>`;
  }
  if(ocp.status !== "matched" || !ocp.detail) return "";

  const d = ocp.detail;
  let body = t("lifecycle_ocp_matched_html",{
    source: srcLink,
    vendor: d.vendor ? `<b lang="en" dir="ltr">${escUiHtml(d.vendor)}</b>` : "—",
    amount: money(d.amount) || "—",
    date: d.date ? fdate(d.date) : "—"
  });

  const corr = ocp.corroboration;
  if(corr && corr.agree){
    body += ` ${t("lifecycle_ocp_corroborated_html",{source:srcName})}`;
  } else if(corr && !corr.agree){
    // Claim layer: both publisher values stay source assertions; the disagreement is an
    // unresolved CityScroll interpretation — never a derived winning amount/date.
    // Prefer classifications from claim_layer on each row when the product join stamped them.
    body += ` ${t("lifecycle_ocp_disagreement_html",{source:srcName})}`;
    const dis = Array.isArray(corr.disagreements) ? corr.disagreements : [];
    const fields = [];
    for(const item of dis){
      const assertClass = (item.claim_layer && item.claim_layer.assertions && item.claim_layer.assertions[0]
        && item.claim_layer.assertions[0].classification) || "source_assertion";
      if(item.field === "amount"){
        fields.push("amount");
        body += ` <span data-claim="${escUiHtml(assertClass)}">${t("lifecycle_ocp_amount_pair_html",{
          city_record_label: cityName,
          city_amount: money(item.city_record) || "—",
          ocp_label: srcName,
          ocp_amount: money(item.ocp) || "—"
        })}</span>`;
      } else if(item.field === "date"){
        fields.push("date");
        body += ` <span data-claim="${escUiHtml(assertClass)}">${t("lifecycle_ocp_date_pair_html",{
          city_record_label: cityName,
          city_date: item.city_record ? fdate(item.city_record) : "—",
          ocp_label: srcName,
          ocp_date: item.ocp ? fdate(item.ocp) : "—"
        })}</span>`;
      }
    }
    if(fields.length){
      const fieldLabel = fields.map(f => f === "amount" ? "amount" : "date").join(" and ");
      const firstLayer = dis.find(d => d && d.claim_layer && d.claim_layer.interpretation);
      const interpClass = (firstLayer && firstLayer.claim_layer.interpretation.classification)
        || "cityscroll_interpretation";
      body += ` <span data-claim="${escUiHtml(interpClass)}">${t("lifecycle_ocp_interpretation_html",{
        field: fieldLabel
      })}</span>`;
    }
  }

  return `<div class="note" data-claim-layer="claim_layer_v1" style="margin-top:10px"><b>${t("lifecycle_ocp_heading")}</b> ${body}</div>`;
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.CHECKBOOK_SEARCH_URL = CHECKBOOK_SEARCH_URL;
globalThis.CHECKBOOK_SMART_SEARCH = CHECKBOOK_SMART_SEARCH;
globalThis.CHECKBOOK_SPENDING_URL = CHECKBOOK_SPENDING_URL;
globalThis.CITY_RECORD_GETFILE_URL = CITY_RECORD_GETFILE_URL;
globalThis.CURRENT_SOLICITATIONS_URL = CURRENT_SOLICITATIONS_URL;
globalThis.LIFECYCLE_DOLLARS_ANCHOR = LIFECYCLE_DOLLARS_ANCHOR;
globalThis.LIFECYCLE_STAGE_ORDER = LIFECYCLE_STAGE_ORDER;
globalThis.OCP_AWARDS_URL = OCP_AWARDS_URL;
globalThis.PASSPORT_CONTRACTS_URL = PASSPORT_CONTRACTS_URL;
globalThis.PASSPORT_RFX_URL = PASSPORT_RFX_URL;
globalThis.checkbookDocumentCode = checkbookDocumentCode;
globalThis.checkbookSearchUrl = checkbookSearchUrl;
globalThis.isContractLifecycleEligible = isContractLifecycleEligible;
globalThis.lifecycleAmount = lifecycleAmount;
globalThis.lifecycleCommittedUnderrun = lifecycleCommittedUnderrun;
globalThis.lifecycleCurrentStageKey = lifecycleCurrentStageKey;
globalThis.lifecycleDocumentsHTML = lifecycleDocumentsHTML;
globalThis.lifecycleDollarsFocusHref = lifecycleDollarsFocusHref;
globalThis.lifecycleGapSourceName = lifecycleGapSourceName;
globalThis.lifecycleHasLaterMatched = lifecycleHasLaterMatched;
globalThis.lifecycleMatchedRegisteredDetail = lifecycleMatchedRegisteredDetail;
globalThis.lifecycleMoney = lifecycleMoney;
globalThis.lifecycleOcpAwardHTML = lifecycleOcpAwardHTML;
globalThis.lifecyclePaymentState = lifecyclePaymentState;
globalThis.lifecyclePaymentSummaryHTML = lifecyclePaymentSummaryHTML;
globalThis.lifecyclePublicStatus = lifecyclePublicStatus;
globalThis.lifecycleResolvedPayment = lifecycleResolvedPayment;
globalThis.lifecycleSourceLink = lifecycleSourceLink;
globalThis.lifecycleSourceName = lifecycleSourceName;
globalThis.lifecycleStageHTML = lifecycleStageHTML;
globalThis.lifecycleStageLabel = lifecycleStageLabel;
globalThis.lifecycleStepperHTML = lifecycleStepperHTML;
globalThis.lifecycleTermEnded = lifecycleTermEnded;
