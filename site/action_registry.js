(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrolActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OUTCOME_ENUM = Object.freeze(["submitted", "attended", "bid", "won", "not_useful"]);
  const ACTION_TYPES = Object.freeze([
    "watch", "calendar", "document", "contact", "rsvp", "comment", "attend",
    "bid_checklist", "official_application", "return_to_matter", "local_note",
  ]);
  const ACTION_DELIVERIES = Object.freeze(["local", "official_handoff", "unavailable"]);
  const CONFIRMATION_ACTIONS = new Set(["rsvp", "comment", "official_application"]);
  const PASSPORT_RFX_URL = "https://a0333-passportpublic.nyc.gov/rfx.html";
  // Same path PASSPort Public uses for procurement-name links in rfx.js (login ReturnUrl → RFx).
  const PASSPORT_RFX_EXTRANET_BASE =
    "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet";
  const NYCHA_ISUPPLIER_URL = "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page";
  // Stable public OASys landing when a per-exam NOE deep link is not mapped.
  // Mapped open exams use https://a856-exams.nyc.gov/OASysWeb/noe?examId=… (build-time join).
  const OASY_APPLY_URL = "https://www.nyc.gov/examsforjobs";
  const OASY_HOST = "a856-exams.nyc.gov";
  // Checkbook smart search — same shape as site/index.html checkbookSearchUrl (no bare landing as primary).
  const CHECKBOOK_SMART_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";

  function httpsUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : null;
    } catch (_error) {
      return null;
    }
  }

  /** Numeric PASSPort Public rfp_id only (strips BOM). */
  function cleanPassportRfpId(value) {
    const id = String(value || "").replace(/^\uFEFF/, "").trim();
    return /^\d{3,}$/.test(id) ? id : null;
  }

  /**
   * RFx handoff: publisher extranet deep link when rfp_id is known, else public browse.
   * Prefer an already-deep portal stamped on the join payload when present.
   */
  function passportRfxHandoffUrl(rfpId, portalFallback) {
    const id = cleanPassportRfpId(rfpId);
    if (id) return `${PASSPORT_RFX_EXTRANET_BASE}/${encodeURIComponent(id)}`;
    const portal = httpsUrl(portalFallback);
    if (portal && /process_manage_extranet\/\d+/i.test(portal)) return portal;
    return portal || PASSPORT_RFX_URL;
  }

  /** True for examsforjobs / OASys home / exams list — not a per-exam door. */
  function isOasysGenericHub(value) {
    const safe = httpsUrl(value);
    if (!safe) return false;
    try {
      const u = new URL(safe);
      const host = u.hostname.toLowerCase();
      const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
      const href = `${host}${path}`.toLowerCase();
      if (/examsforjobs/i.test(href)) return true;
      if (host.includes("nyc.gov") && /\/examsforjobs$/i.test(path)) return true;
      if (host.includes("nyc.gov") && /\/redirects\/oasys\.html$/i.test(path)) return true;
      if (host === OASY_HOST || (host.endsWith(".nyc.gov") && host.includes("exams"))) {
        if (
          path === "/"
          || /^\/OASysWeb$/i.test(path)
          || /^\/OASysWeb\/home$/i.test(path)
          || /^\/OASysWeb\/exams$/i.test(path)
          || /^\/OASysWeb\/login$/i.test(path)
          || /^\/OASysWeb\/register$/i.test(path)
          || /^\/oasysweb$/i.test(path)
          || /^\/oasysweb\/home$/i.test(path)
          || /^\/oasysweb\/exams$/i.test(path)
        ) {
          return true;
        }
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  function oasysNoeUrlFromExamId(examId) {
    const id = String(examId || "").trim();
    if (!/^\d+$/.test(id)) return null;
    return `https://${OASY_HOST}/OASysWeb/noe?examId=${encodeURIComponent(id)}`;
  }

  /**
   * Prefer a per-exam OASys NOE page (or other non-hub publisher URL) when present;
   * otherwise the stable examsforjobs landing.
   */
  function examApplyUrl(matter) {
    if (!matter) return OASY_APPLY_URL;
    const candidates = [
      matter.official_application_url,
      matter.oasys_noe_url,
      oasysNoeUrlFromExamId(matter.oasys_exam_id),
    ];
    for (const c of candidates) {
      const explicit = httpsUrl(c);
      if (!explicit) continue;
      if (isOasysGenericHub(explicit)) continue;
      return explicit;
    }
    return OASY_APPLY_URL;
  }

  function examApplyIsDeep(url) {
    const safe = httpsUrl(url);
    if (!safe || isOasysGenericHub(safe)) return false;
    try {
      const u = new URL(safe);
      if (u.hostname.toLowerCase() === OASY_HOST) {
        const path = (u.pathname || "").replace(/\/+$/, "");
        if (/\/noe$/i.test(path) && /^\d+$/.test(String(u.searchParams.get("examId") || ""))) {
          return true;
        }
        if (/\/noe\/[^/]+\.pdf$/i.test(path)) return true;
      }
      // Non-hub publisher URL counts as deep for mode labeling.
      return true;
    } catch (_e) {
      return false;
    }
  }

  function validateAction(action) {
    if (!ACTION_TYPES.includes(action.type)) throw new TypeError(`unknown action type: ${action.type}`);
    if (!ACTION_DELIVERIES.includes(action.delivery)) throw new TypeError(`unknown action delivery: ${action.delivery}`);
    if (typeof action.confirmation_required !== "boolean") throw new TypeError("action confirmation must be boolean");
    if (action.delivery === "official_handoff") {
      if (!httpsUrl(action.destination)) throw new TypeError("official handoff requires a visible HTTPS destination");
      if (!action.destination_label) throw new TypeError("official handoff requires a destination label");
    }
    if (action.delivery === "unavailable") {
      if (action.destination || action.destination_label) throw new TypeError("unavailable actions cannot include a destination");
      if (action.confirmation_required) throw new TypeError("unavailable actions cannot require confirmation");
    }
    return action;
  }

  function official(type, labelKey, fallbackLabel, destination, deadline, extra) {
    const safe = httpsUrl(destination);
    if (!safe) return unavailable(type, "next_action_unavailable_handoff", "The official action link is not published here.", deadline);
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "official_handoff",
      destination: safe,
      destination_label: new URL(safe).hostname,
      deadline: deadline || null,
      confirmation_required: CONFIRMATION_ACTIONS.has(type),
      ...(extra || {}),
    });
  }

  function local(type, labelKey, fallbackLabel, destination, deadline) {
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "local",
      destination: destination || null,
      deadline: deadline || null,
      confirmation_required: type === "watch",
    });
  }

  function unavailable(type, labelKey, fallbackLabel, deadline) {
    return validateAction({
      type,
      label_key: labelKey,
      label: fallbackLabel,
      delivery: "unavailable",
      deadline: deadline || null,
      confirmation_required: false,
    });
  }

  function kindFor(matter) {
    if (matter.kind) return matter.kind;
    const section = String(matter.section_name || "");
    const type = String(matter.type_of_notice_description || "");
    if (section === "Agency Rules") return "rule";
    if (section === "Property Disposition") return "property";
    if (section === "Public Hearings and Meetings" || /hearing|meeting/i.test(type)) return "hearing";
    if (type === "Solicitation") return "solicitation";
    // Award chain + selection intermediates (Intent to Award already matches /Award/).
    if (/Award|Intent to Negotiate|Vendor List/i.test(type)) return "award";
    return "notice";
  }

  /** Format a published dollar amount for award rail labels (no fabrication of missing values). */
  function formatAwardMoney(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n === 0) return "$0";
    try {
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    } catch (_e) {
      return "$" + String(Math.round(n));
    }
  }

  /**
   * Checkbook handoff URL when a join key exists. Prefer a verified detail URL / agid
   * path; else smart_search by contract id, PIN, or vendor. Never a bare landing.
   */
  function checkbookHandoffUrl(opts) {
    const o = opts || {};
    if (o.detailUrl) {
      const safe = httpsUrl(o.detailUrl);
      if (safe && /checkbooknyc\.com/i.test(new URL(safe).hostname)) return safe;
    }
    const agid = o.agid != null ? String(o.agid).trim() : "";
    if (/^\d+$/.test(agid)) {
      let code = String(o.documentCode || o.doctype || "").trim().toUpperCase();
      if (!code) {
        const m = String(o.contractId || "").trim().match(/^([A-Za-z]+)(\d)/);
        code = m ? (m[1] + m[2]).toUpperCase() : "CT1";
      }
      return `https://www.checkbooknyc.com/contract_details/agid/${encodeURIComponent(agid)}/doctype/${encodeURIComponent(code)}`;
    }
    const term = o.contractId || o.pin || o.vendor;
    if (term) return `${CHECKBOOK_SMART_SEARCH}?search_term=${encodeURIComponent(String(term))}`;
    return null;
  }

  /**
   * Selection-phase notice types on the money chain (past solicitation; not a bid CTA).
   * Intent to Award matches /Award/ for kind routing but is still selection until Award.
   */
  function awardSelectionPhase(typeOfNotice) {
    const type = String(typeOfNotice || "").trim();
    if (/^Intent to Negotiate$/i.test(type)) return "intent_to_negotiate";
    if (/^Vendor List$/i.test(type)) return "vendor_list";
    if (/^Intent to Award$/i.test(type)) return "intent_to_award";
    return null;
  }

  /**
   * Award / selection handoff from City Record fields + /contract-lifecycle stages already
   * painted on the notice. Primary CTA is dollars/vendor/registration-aware — never "bid"
   * on closed awards, and never a solicitation submit CTA on Intent to Award / Negotiate.
   * Only surface steps when the field is present; empty lifecycle degrades to pointer.
   */
  function awardHandoff(matter) {
    const m = matter || {};
    const type = String(m.type_of_notice_description || "").trim();
    const selectionPhase = awardSelectionPhase(type);
    const pin = String(m.pin || m.lifecycle_pin || "").trim() || null;
    const reg = m.registration && typeof m.registration === "object" ? m.registration : null;
    const pay = m.payment && typeof m.payment === "object" ? m.payment : null;
    const pending = m.pending && typeof m.pending === "object" ? m.pending : null;
    const awardStage = m.award_stage && typeof m.award_stage === "object" ? m.award_stage : null;
    const regDetail = reg && reg.status === "matched" && reg.detail ? reg.detail : null;
    const payDetail = pay && pay.status === "matched" && pay.detail ? pay.detail : null;
    const pendingDetail = pending && pending.status === "matched" && pending.detail ? pending.detail : null;
    const awardDetail = awardStage && awardStage.status === "matched" && awardStage.detail
      ? awardStage.detail : null;
    const ocp = m.ocp_award && typeof m.ocp_award === "object" ? m.ocp_award : null;
    const ocpMatched = ocp && (ocp.status === "matched" || ocp.matched)
      ? (ocp.detail || ocp.match || ocp) : null;

    const vendor = String(
      m.vendor_name
      || (regDetail && regDetail.vendor)
      || (pendingDetail && pendingDetail.vendor)
      || (awardDetail && awardDetail.vendor)
      || (ocpMatched && (ocpMatched.vendor || ocpMatched.vendor_name))
      || ""
    ).trim() || null;

    let amountRaw = m.contract_amount;
    if (amountRaw == null && awardDetail && awardDetail.amount != null) amountRaw = awardDetail.amount;
    if (amountRaw == null && regDetail && regDetail.current_amount != null) amountRaw = regDetail.current_amount;
    if (amountRaw == null && pendingDetail && pendingDetail.amount != null) amountRaw = pendingDetail.amount;
    if (amountRaw == null && ocpMatched && (ocpMatched.amount != null || ocpMatched.contract_amount != null)) {
      amountRaw = ocpMatched.amount != null ? ocpMatched.amount : ocpMatched.contract_amount;
    }
    const amount = formatAwardMoney(amountRaw);

    const contractId = String(
      (regDetail && regDetail.contract_id)
      || (pendingDetail && pendingDetail.contract_id)
      || m.contract_id
      || ""
    ).trim() || null;

    const registrationDate = regDetail
      ? (regDetail.registration_date || reg.date || null)
      : null;
    const registered = !!regDetail;

    // Paid-to-date: prefer spending match; else registration spent_to_date when present.
    let spent = null;
    if (payDetail && payDetail.total_spent != null && Number.isFinite(Number(payDetail.total_spent))) {
      if (payDetail.payment_state !== "unavailable") spent = formatAwardMoney(payDetail.total_spent);
    } else if (regDetail && regDetail.spent_to_date != null && Number.isFinite(Number(regDetail.spent_to_date))) {
      spent = formatAwardMoney(regDetail.spent_to_date);
    }

    const pendingRegistration = !registered
      && pending
      && pending.status === "matched";

    const destination = checkbookHandoffUrl({
      contractId,
      pin,
      vendor,
      agid: (regDetail && (regDetail.agid || regDetail.checkbook_agid))
        || (pendingDetail && (pendingDetail.agid || pendingDetail.checkbook_agid))
        || null,
      documentCode: (regDetail && (regDetail.document_code || regDetail.doctype))
        || (pendingDetail && (pendingDetail.document_code || pendingDetail.doctype))
        || null,
      detailUrl: (regDetail && regDetail.checkbook_detail_url)
        || (pendingDetail && pendingDetail.checkbook_detail_url)
        || null,
    });

    const hasFields = !!(
      vendor || amount || registered || pendingRegistration || spent || pin || contractId
      || selectionPhase
    );

    // Selection-phase guide: Intent to Award / Negotiate / Vendor List — not a bid CTA.
    // Outbound Checkbook only when registration/pending already matched (otherwise guide-first).
    if (selectionPhase) {
      let labelKey = "next_action_selection_guide";
      let label = "What happens next in selection";
      if (selectionPhase === "intent_to_award") {
        labelKey = "next_action_intent_to_award";
        label = "Intent to Award — selection in progress";
      } else if (selectionPhase === "intent_to_negotiate") {
        labelKey = "next_action_intent_to_negotiate";
        label = "Intent to Negotiate — selection in progress";
      } else if (selectionPhase === "vendor_list") {
        labelKey = "next_action_vendor_list";
        label = "Vendor list — selection in progress";
      }
      // Prefer vendor/amount lead when Intent to Award published a winner.
      const labelVars = {};
      if (selectionPhase === "intent_to_award" && vendor && amount) {
        labelKey = "next_action_award_to";
        label = `Awarded to ${vendor} · ${amount}`;
        labelVars.vendor = vendor;
        labelVars.amount = amount;
      } else if (selectionPhase === "intent_to_award" && vendor) {
        labelKey = "next_action_award_to_vendor";
        label = `Awarded to ${vendor}`;
        labelVars.vendor = vendor;
      }
      const selectionDestination = (registered || pendingRegistration) ? destination : null;
      return {
        system: "award_lifecycle",
        mode: "selection",
        selection_phase: selectionPhase,
        destination: selectionDestination,
        label_key: labelKey,
        label,
        label_vars: Object.keys(labelVars).length ? labelVars : null,
        vendor,
        amount,
        spent,
        pin,
        contract_id: contractId,
        registration_date: registrationDate,
        registered: false,
        pending_registration: pendingRegistration,
        checkbook_url: selectionDestination,
        has_fields: hasFields,
        official_notice_url: httpsUrl(m.official_notice_url),
      };
    }

    // Closed / published Award — never a bid CTA.
    let labelKey = "next_action_award_guide";
    let label = "Track this award below";
    const labelVars = {};
    if (registered && registrationDate) {
      labelKey = "next_action_award_registered";
      label = `Registered ${String(registrationDate).slice(0, 10)}`;
      labelVars.date = String(registrationDate).slice(0, 10);
    } else if (registered) {
      labelKey = "next_action_award_checkbook";
      label = "Open this contract on Checkbook";
    } else if (pendingRegistration) {
      labelKey = "next_action_award_pending";
      label = "Pending registration on Checkbook";
    } else if (vendor && amount) {
      labelKey = "next_action_award_to";
      label = `Awarded to ${vendor} · ${amount}`;
      labelVars.vendor = vendor;
      labelVars.amount = amount;
    } else if (vendor) {
      labelKey = "next_action_award_to_vendor";
      label = `Awarded to ${vendor}`;
      labelVars.vendor = vendor;
    } else if (destination) {
      labelKey = "next_action_award_checkbook";
      label = "Open this contract on Checkbook";
    }

    return {
      system: "award_lifecycle",
      mode: registered ? "registered" : pendingRegistration ? "pending" : "award",
      selection_phase: null,
      destination: destination || null,
      label_key: labelKey,
      label,
      label_vars: Object.keys(labelVars).length ? labelVars : null,
      vendor,
      amount,
      spent,
      pin,
      contract_id: contractId,
      registration_date: registrationDate,
      registered,
      pending_registration: pendingRegistration,
      checkbook_url: destination,
      has_fields: hasFields,
      official_notice_url: httpsUrl(m.official_notice_url),
    };
  }

  /** Parcel deep-links when a 10-digit BBL is known (ZoLa / ACRIS / Who Owns What). */
  function parcelLookupActions(matter, deadline) {
    const bbl = String(matter.bbl || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(bbl)) return [];
    const boro = bbl[0];
    const block = String(parseInt(bbl.slice(1, 6), 10));
    const lot = String(parseInt(bbl.slice(6, 10), 10));
    const zola = `https://zola.planning.nyc.gov/l/lot/${boro}/${block}/${lot}`;
    // Prefer ZoLa as the primary “look up this lot” action; ACRIS/WOW live on the parcel row.
    return [
      official("document", "property_action_lookup_zola", "Look up this lot on ZoLa", zola, deadline, {
        guide: {
          system: "parcel_lookup",
          mode: "bbl",
          identifier: bbl,
          bbl,
          zola_url: zola,
          acris_url: `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${boro}&block=${block}&lot=${lot}`,
          who_owns_what_url: `https://whoownswhat.justfix.org/bbl/${bbl}`,
          contact_name: matter.contact_name || null,
          contact_phone: matter.contact_phone || null,
          email: matter.email || null,
          owner_name: matter.owner_name || null,
        },
      }),
    ];
  }

  function isPast(date, today) {
    if (!date) return false;
    const d = String(date).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today;
  }

  function passportShaped(value) {
    return /^\d{5}[A-Z]\d{4}(?:\d{3})?$/i.test(String(value || "").replace(/[^a-z0-9]/gi, ""));
  }

  function noticeNamedPortal(body) {
    const systems = [
      {name: "OpenGov", token: /\bOpenGov\b/i, hosts: ["procurement.opengov.com"]},
      {name: "Bonfire", token: /\bBonfire\b/i, hosts: ["bonfirehub.com"]},
      {name: "BidNet", token: /\bBidNet(?:\s+Direct)?\b/i, hosts: ["bidnetdirect.com"]},
    ];
    const urls = String(body || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (const system of systems) {
      if (!system.token.test(body)) continue;
      for (const raw of urls) {
        const cleaned = raw.replace(/&amp;/gi, "&").replace(/[),.;]+$/g, "");
        const safe = httpsUrl(cleaned);
        if (!safe) continue;
        const host = new URL(safe).hostname.toLowerCase();
        if (system.hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
          return {name: system.name, destination: safe};
        }
      }
    }
    return null;
  }

  // Pull concrete response facts from structured City Record fields + the notice body.
  // Prefer an explicit package/submit HTTPS URL published in the notice over a deferral.
  function extractNoticeUrls(body) {
    return (String(body || "").match(/https?:\/\/[^\s<>"']+/gi) || [])
      .map(raw => raw.replace(/&amp;/gi, "&").replace(/[),.;\]}>]+$/g, ""))
      .map(httpsUrl)
      .filter(Boolean);
  }

  function packageUrlFromBody(body) {
    const text = String(body || "");
    if (!text) return null;
    const urls = extractNoticeUrls(text);
    if (!urls.length) return null;
    // Score URLs by nearby download / solicitation / submit language (window of 160 chars).
    let best = null;
    let bestScore = -1;
    for (const url of urls) {
      const idx = text.indexOf(url);
      const window = text.slice(Math.max(0, idx - 160), Math.min(text.length, idx + url.length + 80));
      let score = 0;
      // Package handoff requires download/solicitation language and/or a clear RFP path —
      // bare "submit … as instructed" near a generic /procurement URL must not invent a portal.
      if (/(download|solicitation documents?|copy of the (?:solicitation|RFP|RFQ)|RFP package|bid documents?)/i.test(window)) score += 4;
      if (/(to download|download a copy|solicitation documents?)/i.test(window)) score += 2;
      if (/(electronically upload|upload a proposal|submit (?:your )?(?:proposal|response|bid))/i.test(window)) score += 2;
      if (/(visit|available at|found at)/i.test(window)) score += 1;
      if (/\/rfps?\b|\/rfp\b|\/bids?\b|\/opportunities\b/i.test(url)) score += 3;
      // Skip pure MWBE / certification / financing directories when better options exist.
      if (/(certification-directory|opportunity-mwdbe|sbsconnect)/i.test(url)) score -= 5;
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    // Threshold 4: EDC "download … visit …/rfps" scores well; loose "learn more" does not.
    return bestScore >= 4 ? best : null;
  }

  /**
   * Deep package document from T0/T1 attachment metadata (City Record GetFile with
   * DocumentID). Bare GetFile without DocumentID is a search page — never promote it.
   * Body-extracted package_url still wins in noticeFieldGuidance when present.
   */
  function packageUrlFromAttachments(attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const url = httpsUrl(row.url || row.href || row.document_url);
      if (!url) continue;
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (!(host.includes("a856-cityrecord.nyc.gov") || host.includes("cityrecord.nyc.gov"))) {
          // Allowlisted marketplace / RFP package hosts already used as package_url.
          if (
            host.includes("govdeals.com")
            || host.includes("opengov.com")
            || host.includes("bonfirehub.com")
            || host.includes("bidnetdirect.com")
          ) {
            return url;
          }
          continue;
        }
        if (!/\/Search\/GetFile/i.test(parsed.pathname || "")) continue;
        const q = parsed.searchParams;
        const docId = q.get("DocumentID") || q.get("documentId") || q.get("document_id");
        const reqId = q.get("RequestID") || q.get("requestId") || q.get("request_id");
        if (docId && reqId) return url;
      } catch {
        /* ignore malformed */
      }
    }
    return null;
  }

  function noticeFieldGuidance(matter) {
    const body = String(matter.notice_text || "");
    const packageUrl = packageUrlFromBody(body)
      || httpsUrl(matter.package_url)
      || packageUrlFromAttachments(matter.attachments)
      || null;
    const email = String(matter.email || "").trim() || null;
    const contactName = String(matter.contact_name || "").trim() || null;
    const contactPhone = String(matter.contact_phone || "").trim() || null;
    const address = String(matter.address_to_request || "").trim() || null;
    const method = String(matter.selection_method || "").trim() || null;
    const hasFields = !!(packageUrl || email || contactName || contactPhone || address || method || matter.deadline);
    return {
      package_url: packageUrl,
      email,
      contact_name: contactName,
      contact_phone: contactPhone,
      address_to_request: address,
      selection_method: method,
      has_fields: hasFields,
    };
  }

  function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const raw of values || []) {
      const value = String(raw || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  function extractEmails(text) {
    return uniqueStrings(Array.from(String(text || "").matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi))
      .map((match) => match[0]));
  }

  function extractPhones(text) {
    return uniqueStrings(Array.from(String(text || "").matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g))
      .map((match) => match[0]));
  }

  // Prefer the email the notice names for written testimony / comment submission.
  function extractTestimonyEmail(body) {
    const text = String(body || "");
    if (!text) return null;
    const patterns = [
      /written\s+testimony[\s\S]{0,160}?\b(?:electronically\s+)?(?:to|at)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
      /(?:submit|send)\s+(?:all\s+)?(?:written\s+)?(?:testimony|comments?)[\s\S]{0,120}?\b(?:to|at)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
      /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b[\s\S]{0,100}?written\s+testimony/i,
      /comments?\s+(?:may|must|can)\s+be\s+(?:submitted|sent)[\s\S]{0,120}?\b(?:to|at)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) return match[1];
    }
    return null;
  }

  // Honest testimony deadline: explicit clock if published, else "until hearing ends" language.
  function extractTestimonyUntil(body) {
    const text = String(body || "");
    if (!text) return null;
    if (/written\s+testimony[\s\S]{0,200}?(?:up\s+until|until)\s+the\s+close\s+of\s+the\s+(?:public\s+)?hearing/i.test(text)
      || /(?:up\s+until|until)\s+the\s+close\s+of\s+the\s+(?:public\s+)?hearing[\s\S]{0,120}?written\s+testimony/i.test(text)) {
      return {kind: "hearing_close", label: null};
    }
    const longDate = "(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}";
    const time = "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)";
    const byDate = new RegExp(
      `written\\s+testimony[\\s\\S]{0,160}?\\b(?:received\\s+by|by|before)\\s+(${time})\\s+on\\s+(${longDate})`,
      "i",
    ).exec(text);
    if (byDate) return {kind: "datetime", label: `${byDate[1]} on ${byDate[2]}`.replace(/\s+/g, " ").trim()};
    return null;
  }

  function isJoinPlatformUrl(url) {
    return /\b(?:zoom|webex|teams|meet\.google)\b/i.test(String(url || ""));
  }

  function isLivestreamUrl(url) {
    return /\b(?:youtube\.com|youtu\.be|vimeo\.com|facebook\.com\/.*live|twitch\.tv)\b/i.test(
      String(url || ""),
    );
  }

  /** Maps deep-link for an in-person venue (never invents an address). */
  function mapsSearchUrl(address) {
    const a = String(address || "").trim();
    if (!a) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a}, New York, NY`)}`;
  }

  function venueFromMatter(matter) {
    const venue = matter && matter.venue ? matter.venue : {};
    const address = String(venue.address || "").trim()
      || uniqueStrings([
        matter && matter.street_address_1,
        matter && matter.street_address_2,
        matter && matter.city,
        matter && matter.state,
        matter && matter.zip_code,
      ]).join(", ")
      || null;
    const building = String(venue.building || (matter && matter.building_name) || "").trim() || null;
    const mode = String(venue.mode || "").trim() || null;
    return {address: address || null, building, mode};
  }

  // Hearing handoff: extract attend / testify / contact steps from City Record fields + body.
  // Never invent online join when absent — but do not punt when venue or testimony IS published.
  function hearingHandoff(matter) {
    const body = String((matter && matter.notice_text) || "");
    const venue = venueFromMatter(matter || {});
    const participation = (matter && matter.participation) || {};
    const linkUrl = httpsUrl(matter && matter.participation_url)
      || httpsUrl(((participation.links || [])[0] || {}).url);
    const joinKind = linkUrl ? (isJoinPlatformUrl(linkUrl) ? "join" : "link") : null;
    const testimonyEmail = extractTestimonyEmail(body);
    const testimonyUntil = extractTestimonyUntil(body);
    const bodyEmails = extractEmails(body);
    const bodyPhones = extractPhones(body);
    const emails = uniqueStrings([
      matter && matter.email,
      ...(participation.emails || []),
      ...bodyEmails,
    ]);
    const phones = uniqueStrings([
      matter && matter.contact_phone,
      ...(participation.phones || []),
      ...bodyPhones,
    ]);
    const contactName = String((matter && matter.contact_name) || "").trim() || null;
    // Prefer a non-testimony email for the general contact line when both exist.
    const contactEmail = uniqueStrings(emails.filter((email) => {
      if (!testimonyEmail) return true;
      return email.toLowerCase() !== String(testimonyEmail).toLowerCase();
    }))[0] || testimonyEmail || null;
    const contactPhone = phones[0] || null;
    const hasFields = !!(
      linkUrl
      || venue.address
      || venue.building
      || testimonyEmail
      || contactName
      || contactEmail
      || contactPhone
      || (matter && matter.deadline)
      || (matter && matter.event_date)
    );

    let labelKey = "next_action_participation_missing";
    let label = "No online participation link is published in this notice.";
    if (joinKind === "join") {
      labelKey = "join_online";
      label = "Join online";
    } else if (joinKind === "link") {
      labelKey = "participation_link";
      label = "Participation link";
    } else if (hasFields) {
      labelKey = "next_action_hearing_guide";
      label = "Follow the participation steps below";
    }

    return {
      system: "hearing_extracted",
      mode: "notice_fields",
      destination: linkUrl,
      label_key: labelKey,
      label,
      join_kind: joinKind,
      participation_url: linkUrl,
      venue_address: venue.address,
      venue_building: venue.building,
      venue_mode: venue.mode,
      event_date: (matter && (matter.deadline || matter.event_date)) || null,
      testimony_email: testimonyEmail,
      testimony_until: testimonyUntil,
      contact_name: contactName,
      email: contactEmail,
      contact_phone: contactPhone,
      emails,
      phones,
      has_fields: hasFields,
    };
  }

  /**
   * Classify land-use body (CB / BP / CPC / Council) for phase-tied steps.
   * Pure title/agency heuristics — never invents a hearing that is not present.
   */
  function landHearingBody(hearing) {
    const hay = [
      hearing && hearing.agency,
      hearing && hearing.agency_name,
      hearing && hearing.title,
      hearing && hearing.short_title,
      hearing && hearing.detail,
      hearing && hearing.notice_text,
      hearing && hearing.representing,
    ].filter(Boolean).join(" ").toLowerCase();
    if (/community board|\bcb\s*\d|\bcb\b/.test(hay)) return "community_board";
    if (/borough president|borough board/.test(hay)) return "borough_president";
    if (/city planning|\bcpc\b|planning commission/.test(hay)) return "cpc";
    if (/city council|council review|subcommittee on zoning/.test(hay)) return "city_council";
    return null;
  }

  const LAND_PUBLIC_PHASES = Object.freeze([
    "community_board", "borough_president", "cpc", "city_council",
  ]);

  const LAND_PHASE_LABELS = Object.freeze({
    pre_application: "Pre-application and filing",
    environmental: "Environmental review (CEQR)",
    pre_certification: "Pre-certification notice",
    certification: "Certification",
    community_board: "Community Board review",
    borough_president: "Borough President review",
    cpc: "City Planning Commission",
    city_council: "City Council review",
    mayoral_appeals: "Mayoral and appeals review",
  });

  /**
   * Map public_status / lifecycle_stage / phase_id into a coarse land stage for the rail.
   * Does not invent openness — completed-like statuses close comment; public-review opens it.
   */
  function zoningStage(matter) {
    const stage = String((matter && matter.lifecycle_stage) || "").toLowerCase().trim();
    if (stage) return stage;
    const status = String((matter && matter.public_status) || "").toLowerCase();
    if (/completed|withdrawn|terminated|approved|disapproved/.test(status)) return "closed";
    if (/public review/.test(status)) return "public-review";
    if (/noticed/.test(status)) return "noticed";
    if (/active|filed/.test(status)) return "active";
    const phase = String((matter && matter.phase_id) || "").toLowerCase();
    if (LAND_PUBLIC_PHASES.includes(phase)) return "public-review";
    if (phase === "pre_certification") return "noticed";
    if (phase === "mayoral_appeals") return "closed";
    return stage || "active";
  }

  function participationUrlFromBody(body) {
    const urls = (String(body || "").match(/https?:\/\/[^\s<>"']+/gi) || [])
      .map((raw) => raw.replace(/&amp;/gi, "&").replace(/[),.;\]}>]+$/g, ""))
      .map(httpsUrl)
      .filter(Boolean);
    // Prefer Zoom/Webex/Teams join links over generic agency pages.
    const join = urls.find((url) => isJoinPlatformUrl(url));
    if (join) return join;
    // Agenda/materials pages near hearing language.
    for (const url of urls) {
      if (/legistar|planning\.nyc|communityboard|cb\d|franchise|hearing|agenda/i.test(url)) {
        return url;
      }
    }
    return urls[0] || null;
  }

  function hearingParticipationBits(hearing, today) {
    if (!hearing) return null;
    const body = String(hearing.notice_text || hearing.description || "");
    const venue = venueFromMatter(hearing);
    const participation = hearing.participation || {};
    // Prefer explicit livestream URL (ZAP disposition logistics) over body scrape.
    const livestreamUrl = httpsUrl(hearing.livestream_url)
      || (httpsUrl(hearing.participation_url) && isLivestreamUrl(hearing.participation_url)
        ? httpsUrl(hearing.participation_url)
        : null)
      || (() => {
        const fromBody = participationUrlFromBody(body);
        return fromBody && isLivestreamUrl(fromBody) ? fromBody : null;
      })();
    const linkUrl = livestreamUrl
      || httpsUrl(hearing.participation_url)
      || httpsUrl(((participation.links || [])[0] || {}).url)
      || participationUrlFromBody(body);
    const joinKind = linkUrl
      ? (isJoinPlatformUrl(linkUrl) ? "join" : isLivestreamUrl(linkUrl) ? "livestream" : "link")
      : null;
    const mapsUrl = httpsUrl(hearing.maps_url) || mapsSearchUrl(venue.address || hearing.street_address_1);
    const testimonyEmail = extractTestimonyEmail(body);
    const testimonyUntil = extractTestimonyUntil(body);
    const bodyEmails = extractEmails(body);
    const bodyPhones = extractPhones(body);
    const emails = uniqueStrings([
      hearing.email,
      ...(participation.emails || []),
      ...bodyEmails,
    ]);
    const phones = uniqueStrings([
      hearing.contact_phone,
      ...(participation.phones || []),
      ...bodyPhones,
    ]);
    const contactName = String(hearing.contact_name || "").trim() || null;
    const contactEmail = uniqueStrings(emails.filter((email) => {
      if (!testimonyEmail) return true;
      return email.toLowerCase() !== String(testimonyEmail).toLowerCase();
    }))[0] || testimonyEmail || null;
    const contactPhone = phones[0] || null;
    const eventDate = hearing.event_date || hearing.deadline || null;
    const past = eventDate ? isPast(eventDate, today) : false;
    const bodyKind = landHearingBody(hearing);
    const sourceUrl = httpsUrl(hearing.source_url || hearing.official_notice_url)
      || (hearing.request_id
        ? `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(hearing.request_id)}`
        : null);
    const hasFields = !!(
      linkUrl
      || venue.address
      || venue.building
      || mapsUrl
      || testimonyEmail
      || contactName
      || contactEmail
      || contactPhone
      || eventDate
      || sourceUrl
      || hearing.hearing_location_raw
    );
    return {
      request_id: String(hearing.request_id || "").trim() || null,
      title: String(hearing.title || hearing.short_title || "").trim() || null,
      agency: String(hearing.agency || hearing.agency_name || "").trim() || null,
      body_kind: bodyKind,
      event_date: eventDate,
      past,
      participation_url: linkUrl,
      join_kind: joinKind,
      livestream_url: livestreamUrl || (joinKind === "livestream" ? linkUrl : null),
      maps_url: mapsUrl,
      venue_address: venue.address,
      venue_building: venue.building,
      venue_mode: venue.mode || (venue.address && livestreamUrl ? "hybrid" : venue.address ? "in-person" : livestreamUrl ? "virtual" : null),
      hearing_location_raw: String(hearing.hearing_location_raw || "").trim() || null,
      parse_status: hearing.parse_status || null,
      testimony_email: testimonyEmail,
      testimony_until: testimonyUntil,
      contact_name: contactName,
      email: contactEmail,
      contact_phone: contactPhone,
      source_url: sourceUrl,
      has_fields: hasFields,
    };
  }

  /**
   * Rules handoff: concrete comment-by-deadline + how-to-comment and hearing
   * attend/testify steps from NYC Rules fields + City Record body. Never invents
   * a comment portal, email, venue, or hearing date — omits steps when absent.
   */
  function ruleHandoff(matter, options) {
    const opts = options || {};
    const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const m = matter || {};
    const stage = String(m.lifecycle_stage || "").toLowerCase();
    const commentDeadline = m.deadline || m.comment_by_date || null;
    const open = stage === "comment-open" && commentDeadline && !isPast(commentDeadline, today);
    const commentUrl = httpsUrl(m.comment_url) || null;
    const ruleUrl = httpsUrl(m.official_notice_url) || httpsUrl(m.rule_url) || null;

    // Upcoming hearing from RSS hearing_date and/or City Record event_date.
    const hearingCandidates = [m.hearing_date, m.event_date].filter(Boolean);
    let hearingDate = null;
    for (const candidate of hearingCandidates) {
      if (!isPast(candidate, today)) {
        hearingDate = candidate;
        break;
      }
    }
    // Stage "hearing" with only a past date stays closed for attend — do not invent.
    const hearingUpcoming = !!hearingDate;

    // Reuse hearing participation extraction for venue / join / testimony from the notice body.
    const bits = hearingParticipationBits({
      request_id: m.request_id,
      event_date: hearingDate || m.event_date || m.hearing_date || null,
      agency: m.agency_name,
      title: m.title,
      notice_text: m.notice_text,
      participation_url: m.participation_url,
      participation: m.participation,
      venue: m.venue,
      street_address_1: m.street_address_1,
      street_address_2: m.street_address_2,
      city: m.city,
      state: m.state,
      zip_code: m.zip_code,
      building_name: m.building_name,
      email: m.email,
      contact_name: m.contact_name,
      contact_phone: m.contact_phone,
      source_url: m.official_notice_url,
    }, today);

    const body = String(m.notice_text || "");
    const commentEmail = (bits && bits.testimony_email) || extractTestimonyEmail(body) || null;
    const contactName = String((bits && bits.contact_name) || m.contact_name || "").trim() || null;
    const contactEmail = (bits && bits.email)
      || String(m.email || "").trim()
      || commentEmail
      || null;
    const contactPhone = (bits && bits.contact_phone)
      || String(m.contact_phone || "").trim()
      || null;

    let mode = "closed";
    if (open) mode = "comment_open";
    else if (hearingUpcoming || stage === "hearing") mode = hearingUpcoming ? "hearing" : "closed";
    else if (stage === "proposed") mode = "proposed";

    // Primary kinetic destination: comment portal while open; else join/hearing notice; else rule page.
    let destination = null;
    let labelKey = "read_official_notice";
    let label = "Read the official notice";
    let primaryType = "document";
    if (open && (commentUrl || ruleUrl)) {
      destination = commentUrl || ruleUrl;
      labelKey = "rule_comment_btn";
      label = "Comment on the official rule page";
      primaryType = "comment";
    } else if (hearingUpcoming && bits && bits.participation_url && bits.join_kind === "join") {
      destination = bits.participation_url;
      labelKey = "join_online";
      label = "Join online";
      primaryType = "attend";
    } else if (hearingUpcoming && bits && bits.participation_url) {
      destination = bits.participation_url;
      labelKey = "participation_link";
      label = "Participation link";
      primaryType = "attend";
    } else if (hearingUpcoming && (ruleUrl || (bits && bits.source_url))) {
      destination = ruleUrl || bits.source_url;
      labelKey = "rule_action_open_rule_page";
      label = "Open the official rule page";
      primaryType = "document";
    } else if (open && commentEmail) {
      // No portal URL but a published comment email — guide-first (destination null).
      destination = null;
      labelKey = "next_action_rule_guide";
      label = "Follow the comment and hearing steps below";
      primaryType = "comment";
    } else if (ruleUrl) {
      destination = ruleUrl;
      labelKey = "read_official_notice";
      label = "Read the official notice";
      primaryType = "document";
    }

    const hasFields = !!(
      commentUrl
      || commentDeadline
      || hearingDate
      || commentEmail
      || contactName
      || contactEmail
      || contactPhone
      || (bits && (bits.venue_address || bits.venue_building || bits.participation_url))
      || ruleUrl
      || m.summary
    );

    return {
      system: "rules_extracted",
      mode,
      destination,
      label_key: mode === "closed" ? "next_action_comment_closed" : labelKey,
      label: mode === "closed" ? "Public comment is not open now." : label,
      primary_type: mode === "closed" ? "comment" : primaryType,
      comment_open: open,
      comment_deadline: open ? commentDeadline : null,
      comment_url: commentUrl,
      rule_url: ruleUrl,
      summary: String(m.summary || "").trim() || null,
      hearing_date: hearingDate,
      hearing_upcoming: hearingUpcoming,
      participation_url: bits ? bits.participation_url : null,
      join_kind: bits ? bits.join_kind : null,
      venue_address: bits ? bits.venue_address : null,
      venue_building: bits ? bits.venue_building : null,
      venue_mode: bits ? bits.venue_mode : null,
      testimony_email: commentEmail,
      testimony_until: bits ? bits.testimony_until : null,
      contact_name: contactName,
      email: contactEmail,
      contact_phone: contactPhone,
      official_notice_url: ruleUrl || (bits ? bits.source_url : null),
      has_fields: hasFields,
    };
  }

  /**
   * Land / ULURP handoff: phase-tied next steps from ZAP + joined City Record hearings.
   * Never fabricates a hearing, comment email, or join link — omits when absent.
   */
  function zoningHandoff(matter, options) {
    const opts = options || {};
    const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const m = matter || {};
    const projectUrl = httpsUrl(m.project_url)
      || (m.project_id
        ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(String(m.project_id))}`
        : null);
    const stage = zoningStage(m);
    const phaseId = String(m.phase_id || "").trim() || null;
    const phaseLabel = String(m.phase_label || "").trim()
      || (phaseId && LAND_PHASE_LABELS[phaseId])
      || null;
    const publicStatus = String(m.public_status || "").trim() || null;
    const rawHearings = Array.isArray(m.hearings) ? m.hearings.slice() : [];
    // Also accept a single hearing-shaped payload stamped on the matter.
    if (!rawHearings.length && (m.notice_text || m.event_date || m.participation_url || m.venue)) {
      rawHearings.push({
        request_id: m.request_id,
        event_date: m.event_date || m.deadline,
        agency: m.agency_name,
        title: m.title,
        notice_text: m.notice_text,
        participation_url: m.participation_url,
        participation: m.participation,
        venue: m.venue,
        street_address_1: m.street_address_1,
        street_address_2: m.street_address_2,
        city: m.city,
        state: m.state,
        zip_code: m.zip_code,
        building_name: m.building_name,
        email: m.email,
        contact_name: m.contact_name,
        contact_phone: m.contact_phone,
        source_url: m.official_notice_url,
      });
    }
    const hearings = rawHearings
      .map((h) => hearingParticipationBits(h, today))
      .filter(Boolean);
    // Prefer upcoming hearing matching current phase, else nearest future, else most recent with fields.
    const upcoming = hearings
      .filter((h) => h.event_date && !h.past)
      .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
    let nextHearing = null;
    if (phaseId && upcoming.length) {
      nextHearing = upcoming.find((h) => h.body_kind === phaseId) || upcoming[0];
    } else if (upcoming.length) {
      nextHearing = upcoming[0];
    } else {
      nextHearing = hearings
        .filter((h) => h.has_fields)
        .sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")))[0] || null;
    }

    const closed = stage === "closed" || stage === "completed" || stage === "past";
    const publicReview = stage === "public-review" || stage === "hearing"
      || LAND_PUBLIC_PHASES.includes(phaseId);
    const preReview = !closed && !publicReview;

    // Prefer current-phase hearing logistics even when the hearing date has passed
    // (still useful: venue maps + livestream channel) — but mark past honestly.
    let logisticsHearing = nextHearing;
    if (!logisticsHearing) {
      logisticsHearing = hearings
        .filter((h) => h.has_fields && (h.venue_address || h.livestream_url || h.participation_url || h.maps_url))
        .sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")))[0] || null;
    }

    // Primary kinetic destination: join → maps attend → livestream watch → notice → ZAP.
    let destination = null;
    let labelKey = "view_comment_zap";
    let label = "View and comment on ZAP";
    let primaryType = "comment";
    const activeHearing = logisticsHearing && !logisticsHearing.past ? logisticsHearing : null;
    const showHearing = activeHearing || logisticsHearing;
    if (activeHearing && activeHearing.participation_url && activeHearing.join_kind === "join") {
      destination = activeHearing.participation_url;
      labelKey = "join_online";
      label = "Join online";
      primaryType = "attend";
    } else if (activeHearing && activeHearing.maps_url && activeHearing.venue_address) {
      destination = activeHearing.maps_url;
      labelKey = "land_action_attend_in_person";
      label = "Attend in person";
      primaryType = "attend";
    } else if (activeHearing && activeHearing.livestream_url) {
      destination = activeHearing.livestream_url;
      labelKey = "land_action_watch_live";
      label = "Watch live";
      primaryType = "attend";
    } else if (activeHearing && activeHearing.participation_url && activeHearing.join_kind === "livestream") {
      destination = activeHearing.participation_url;
      labelKey = "land_action_watch_live";
      label = "Watch live";
      primaryType = "attend";
    } else if (activeHearing && activeHearing.source_url && activeHearing.has_fields) {
      destination = activeHearing.source_url;
      labelKey = "land_action_open_hearing_notice";
      label = "Open the hearing notice";
      primaryType = "document";
    } else if (publicReview && projectUrl) {
      destination = projectUrl;
      labelKey = "view_comment_zap";
      label = "View and comment on ZAP";
      primaryType = "comment";
    } else if (projectUrl) {
      destination = projectUrl;
      labelKey = "zap_full_project";
      label = "Full project on ZAP";
      primaryType = "document";
    }

    const hasFields = !!(
      projectUrl
      || nextHearing
      || logisticsHearing
      || phaseId
      || publicStatus
      || m.deadline
      || hearings.length
    );

    const hearingForGuide = showHearing || nextHearing;
    return {
      system: "zoning_extracted",
      mode: closed ? "closed" : publicReview ? "public_review" : preReview ? "pre_review" : "active",
      destination,
      label_key: closed ? "next_action_comment_closed" : labelKey,
      label: closed ? "Public comment is not open now." : label,
      primary_type: closed ? "comment" : primaryType,
      project_url: projectUrl,
      project_id: String(m.project_id || "").trim() || null,
      project_name: String(m.title || m.project_name || "").trim() || null,
      public_status: publicStatus,
      phase_id: phaseId,
      phase_label: phaseLabel,
      stage,
      deadline: m.deadline
        || (nextHearing && !nextHearing.past ? nextHearing.event_date : null)
        || (activeHearing ? activeHearing.event_date : null),
      next_hearing: hearingForGuide,
      hearings: hearings.slice(0, 6),
      // Flatten next-hearing participation for guide renderers shared with hearing rails.
      participation_url: hearingForGuide ? hearingForGuide.participation_url : null,
      join_kind: hearingForGuide ? hearingForGuide.join_kind : null,
      livestream_url: hearingForGuide ? (hearingForGuide.livestream_url || null) : null,
      maps_url: hearingForGuide ? (hearingForGuide.maps_url || null) : null,
      venue_address: hearingForGuide ? hearingForGuide.venue_address : null,
      venue_building: hearingForGuide ? hearingForGuide.venue_building : null,
      venue_mode: hearingForGuide ? hearingForGuide.venue_mode : null,
      hearing_location_raw: hearingForGuide ? hearingForGuide.hearing_location_raw : null,
      event_date: hearingForGuide ? hearingForGuide.event_date : null,
      testimony_email: hearingForGuide ? hearingForGuide.testimony_email : null,
      testimony_until: hearingForGuide ? hearingForGuide.testimony_until : null,
      contact_name: hearingForGuide ? hearingForGuide.contact_name : null,
      email: hearingForGuide ? hearingForGuide.email : null,
      contact_phone: hearingForGuide ? hearingForGuide.contact_phone : null,
      official_notice_url: hearingForGuide ? hearingForGuide.source_url : httpsUrl(m.official_notice_url),
      has_fields: hasFields,
    };
  }

  // A solicitation handoff is an evidence record, not a guessed deep link. Matched PASSPort
  // RFx rows carry rfp_id → the same process_manage_extranet deep link PASSPort Public uses.
  // Without rfp_id the handoff stays a public browse search recipe (EPIN/name guide). Agency
  // systems only win when the notice names them. When no portal is named, surface the notice's
  // own package URL / contact / submission fields — never "read the official notice."
  function solicitationHandoff(matter) {
    const body = String(matter.notice_text || "");
    const agency = String(matter.agency_name || "");
    const pin = String(matter.pin || "").trim() || null;
    const title = String(matter.title || "").trim() || null;
    const rfx = matter.rfx_detail || null;
    const detail = rfx && rfx.status === "matched" ? (rfx.detail || {}) : null;
    const explicitUrl = httpsUrl(matter.official_application_url);
    const fields = noticeFieldGuidance(matter);
    // Prefer notice-published package/submit URL for iSupplier RFQ depth when present.
    const nychaNoticeUrl = httpsUrl(matter.official_notice_url);

    if (/housing authority|\bnycha\b/i.test(agency) && /\bisupplier\b/i.test(body)) {
      // No public per-RFQ iSupplier URL is published. Registration guide remains the
      // kinetic destination; keep RFQ/PIN copyable and prefer City Record notice when known
      // as the package/document handoff for this solicitation.
      return {
        system: "nycha_isupplier",
        mode: "notice_named",
        destination: NYCHA_ISUPPLIER_URL,
        label_key: "open_nycha_isupplier",
        label: "Open NYCHA iSupplier guide",
        identifier: pin,
        procurement_name: title,
        status: null,
        approval_delay: /24\s*(?:to|–|-)\s*72\s*hours/i.test(body),
        // Outbound for the RFQ identity when City Record request_id is known.
        identifier_url: nychaNoticeUrl,
        ...fields,
        // package_url from body wins; else official notice is the deepest public package link.
        package_url: fields.package_url || nychaNoticeUrl,
      };
    }

    const namedPortal = noticeNamedPortal(body);
    if (namedPortal) {
      return {
        system: "notice_portal",
        system_name: namedPortal.name,
        mode: "notice_named",
        destination: namedPortal.destination,
        label_key: "open_notice_submission_portal",
        label: "Open the submission portal",
        identifier: pin,
        procurement_name: title,
        status: null,
        ...fields,
      };
    }

    if (detail) {
      const rfpId = detail.rfp_id;
      const destination = passportRfxHandoffUrl(rfpId, rfx.portal);
      const deep = !!cleanPassportRfpId(rfpId)
        || /process_manage_extranet\/\d+/i.test(String(destination));
      return {
        system: "passport",
        mode: "matched",
        destination,
        label_key: "search_passport_rfx",
        label: "Find this RFx in PASSPort",
        identifier: String(detail.epin || pin || "").trim() || null,
        // EPIN still useful on the public browse when deep link is auth-gated.
        identifier_url: deep ? PASSPORT_RFX_URL : null,
        procurement_name: String(detail.procurement_name || title || "").trim() || null,
        status: String(detail.rfx_status || "").trim() || null,
        rfp_id: cleanPassportRfpId(rfpId),
        ...fields,
      };
    }

    const passportEvidence = passportShaped(pin)
      || /\bpassport\b/i.test(body)
      || (explicitUrl && /(^|\.)passport\./i.test(new URL(explicitUrl).hostname));
    if (passportEvidence) {
      return {
        system: "passport",
        mode: "search_only",
        destination: PASSPORT_RFX_URL,
        label_key: "search_passport_rfx",
        label: "Search PASSPort RFx",
        identifier: pin,
        procurement_name: title,
        status: null,
        ...fields,
      };
    }

    // Notice-published package / RFP page (e.g. edc.nyc/rfps) — concrete destination from body.
    if (fields.package_url) {
      return {
        system: "notice_extracted",
        mode: "notice_fields",
        destination: fields.package_url,
        label_key: "open_rfp_package",
        label: "Get the RFP package",
        identifier: pin,
        procurement_name: title,
        status: null,
        ...fields,
      };
    }

    // No portal URL, but the notice still has contact / submit-to / method — guide from fields.
    if (fields.has_fields) {
      return {
        system: "notice_extracted",
        mode: "notice_fields",
        destination: null,
        label_key: "next_action_response_guide",
        label: "Follow the response steps below",
        identifier: pin,
        procurement_name: title,
        status: null,
        ...fields,
      };
    }

    return {
      system: "notice_extracted",
      mode: "notice_fields",
      destination: null,
      label_key: "next_action_response_guide",
      label: "Follow the response steps below",
      identifier: pin,
      procurement_name: title,
      status: null,
      ...fields,
    };
  }

  /**
   * Franchise / FCRC stage-tied handoff. Uses process stage (solicitation →
   * public_hearing → committee_meeting → award) plus fields already on the
   * notice — never invents hearings or bid CTAs on awards. Hearing stages
   * reuse testimony/venue extraction; solicitation reuses package/contact.
   */
  function franchiseHandoff(matter) {
    const m = matter || {};
    const stage = String(m.franchise_stage || m.lifecycle_stage || "").toLowerCase().trim();
    const fields = noticeFieldGuidance(m);

    if (stage === "solicitation") {
      const sol = solicitationHandoff(m);
      return {
        system: sol.destination ? sol.system : "franchise_extracted",
        mode: "solicitation",
        stage: "solicitation",
        destination: sol.destination || fields.package_url || null,
        label_key: sol.destination
          ? sol.label_key
          : (fields.package_url ? "open_rfp_package" : "franchise_phase_action_solicitation"),
        label: sol.destination
          ? sol.label
          : (fields.package_url ? "Get the RFP package" : "Review the franchise solicitation steps"),
        primary_type: sol.destination || fields.package_url ? "official_application" : "bid_checklist",
        package_url: fields.package_url || sol.package_url || null,
        email: fields.email || sol.email || null,
        contact_name: fields.contact_name || sol.contact_name || null,
        contact_phone: fields.contact_phone || sol.contact_phone || null,
        address_to_request: fields.address_to_request || sol.address_to_request || null,
        selection_method: fields.selection_method || sol.selection_method || null,
        identifier: sol.identifier || null,
        identifier_url: sol.identifier_url || null,
        has_fields: !!(sol.destination || fields.has_fields || fields.package_url),
        guide_system: sol.destination ? sol.system : "notice_extracted",
        ...fields,
      };
    }

    if (stage === "public_hearing" || stage === "committee_meeting") {
      const h = hearingHandoff(m);
      const isMeeting = stage === "committee_meeting";
      return {
        system: "franchise_extracted",
        mode: stage,
        stage,
        destination: h.destination,
        label_key: h.destination
          ? h.label_key
          : (isMeeting ? "franchise_phase_action_committee_meeting" : "franchise_phase_action_public_hearing"),
        label: h.destination
          ? h.label
          : (isMeeting
            ? "Prepare for the FCRC committee meeting"
            : "Prepare for the FCRC public hearing"),
        primary_type: h.destination ? (h.join_kind === "join" ? "attend" : "attend") : "bid_checklist",
        join_kind: h.join_kind,
        participation_url: h.participation_url,
        venue_address: h.venue_address,
        venue_building: h.venue_building,
        venue_mode: h.venue_mode,
        event_date: h.event_date || m.event_date || m.deadline || null,
        testimony_email: h.testimony_email,
        testimony_until: h.testimony_until,
        contact_name: h.contact_name,
        email: h.email,
        contact_phone: h.contact_phone,
        emails: h.emails,
        phones: h.phones,
        has_fields: h.has_fields,
        // Guide HTML reuses the hearing step list for venue / testimony / join.
        guide_system: "hearing_extracted",
      };
    }

    if (stage === "award") {
      return {
        system: "franchise_extracted",
        mode: "award",
        stage: "award",
        destination: httpsUrl(m.official_notice_url),
        label_key: "franchise_phase_action_award",
        label: "Review the franchise or concession award",
        primary_type: "document",
        has_fields: !!httpsUrl(m.official_notice_url),
        guide_system: null,
      };
    }

    // Unknown stage: fall back to hearing fields when present, else notice pointer.
    const h = hearingHandoff(m);
    if (h.has_fields) {
      return {
        system: "franchise_extracted",
        mode: "unknown",
        stage: stage || null,
        destination: h.destination,
        label_key: h.label_key || "franchise_phase_action_public_hearing",
        label: h.label || "Follow the franchise participation steps below",
        primary_type: h.destination ? "attend" : "bid_checklist",
        ...h,
        has_fields: true,
        guide_system: "hearing_extracted",
      };
    }
    return {
      system: "franchise_extracted",
      mode: "unknown",
      stage: stage || null,
      destination: httpsUrl(m.official_notice_url),
      label_key: "read_official_notice",
      label: "Read the official notice",
      primary_type: "document",
      has_fields: !!httpsUrl(m.official_notice_url),
      guide_system: null,
    };
  }

  /**
   * Context-carrying alert entry: watch CTAs land on #alerts pre-scoped to the
   * matter's natural lens/agency (and seed notice/project id for the email-template
   * preview). Same hash-param shape as saved-search health fix links.
   */
  function watchDestination(matter) {
    const m = matter || {};
    const noticeId = m.request_id && /^[A-Za-z0-9_-]{4,40}$/.test(String(m.request_id))
      ? String(m.request_id) : null;
    const projectId = m.project_id && /^[A-Za-z0-9_-]{4,40}$/.test(String(m.project_id))
      ? String(m.project_id) : null;
    const agency = m.agency_name && String(m.agency_name).trim() ? String(m.agency_name).trim() : null;
    const section = String(m.section_name || "");
    const type = String(m.type_of_notice_description || "");
    const kind = String(m.kind || "").toLowerCase();
    let lens = "money";
    const filter = {};
    if (kind === "zoning" || projectId) {
      lens = "land";
      const place = String(m.project_name || m.title || m.borough || "")
        .replace(/(rezoning|demapping|rezone|special permit|special district|text amendment|mapping actions?|modification|disposition|non-?ulurp).*/i, "")
        .trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
      if (place) filter.keywords = [place];
      filter.status = "all";
      if (m.borough) filter.boro = m.borough;
    } else if (kind === "hearing" || section === "Public Hearings and Meetings") {
      lens = "meetings";
      if (agency) filter.agency = agency;
    } else if (kind === "rule" || section === "Agency Rules") {
      lens = "rules";
      if (agency) filter.agency = agency;
    } else if (kind === "property" || section === "Property Disposition") {
      lens = "property";
      if (agency) filter.agency = agency;
    } else if (section === "Changes in Personnel") {
      lens = "entity";
      filter.kind = "agency";
      if (agency) filter.name = agency;
    } else if (kind === "solicitation" || type === "Solicitation") {
      lens = "money";
      if (agency) filter.agency = agency;
      filter.noticeType = "solicitation";
    } else if (kind === "award" || /Award|Intent to Negotiate|Vendor List/i.test(type)) {
      lens = "money";
      if (agency) filter.agency = agency;
      if (/Award/i.test(type) || kind === "award") filter.noticeType = "award";
    } else if (kind === "franchise") {
      lens = "meetings";
      if (agency) filter.agency = agency;
    } else {
      if (agency) filter.agency = agency;
    }
    // No id and no filter bits → bare alerts (neutral).
    if (!noticeId && !projectId && !Object.keys(filter).length) return "#alerts";
    const params = new URLSearchParams();
    params.set("lens", lens);
    params.set("filter", JSON.stringify(filter));
    if (noticeId) params.set("notice", noticeId);
    if (projectId) params.set("project", projectId);
    return "#alerts?" + params.toString();
  }

  function compileActionRail(matter, options) {
    const opts = options || {};
    const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const kind = kindFor(matter || {});
    const stage = String(matter.lifecycle_stage || "").toLowerCase();
    const deadline = matter.deadline || null;
    const watch = local("watch", "next_action_watch", "Watch this notice", watchDestination(matter), null);
    const calendar = local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, deadline);
    const notice = () => official("document", "read_official_notice", "Read the official notice", matter.official_notice_url, deadline);
    let actions;

    if (kind === "franchise") {
      // Stage-tied FCRC rail: solicitation / hearing / meeting / award from spine stage.
      const handoff = franchiseHandoff(matter);
      const actionDeadline = handoff.event_date || deadline || null;
      const past = isPast(actionDeadline, today);
      const francStage = String(handoff.stage || matter.franchise_stage || stage || "").toLowerCase();

      if (francStage === "award") {
        actions = handoff.destination
          ? [official("document", handoff.label_key, handoff.label, handoff.destination, null, { guide: handoff })]
          : [notice()];
        actions.push(watch);
      } else if (past && (francStage === "public_hearing" || francStage === "committee_meeting")) {
        actions = [
          unavailable("attend", "next_action_event_passed", "This event has passed.", actionDeadline),
          notice(),
          watch,
        ];
      } else if (handoff.destination) {
        const type = handoff.primary_type === "official_application"
          ? "official_application"
          : handoff.primary_type === "document"
            ? "document"
            : "attend";
        // Prefer hearing_extracted / notice_extracted guide shape for step lists.
        const guidePayload = handoff.guide_system
          ? { ...handoff, system: handoff.guide_system }
          : handoff;
        actions = [
          official(type, handoff.label_key, handoff.label, handoff.destination, actionDeadline, { guide: guidePayload }),
        ];
        if (actionDeadline && !past) actions.push(calendar);
        actions.push(watch);
      } else if (handoff.has_fields) {
        const guidePayload = handoff.guide_system
          ? { ...handoff, system: handoff.guide_system }
          : handoff;
        actions = [validateAction({
          type: "bid_checklist",
          label_key: handoff.label_key || "franchise_phase_action_public_hearing",
          label: handoff.label || "Follow the franchise steps below",
          delivery: "local",
          destination: null,
          deadline: actionDeadline,
          confirmation_required: false,
          guide: guidePayload,
        })];
        if (actionDeadline && !past) actions.push(calendar);
        actions.push(watch);
      } else {
        // Honest pointer when no stage-specific fields are published.
        actions = [notice(), watch];
      }
    } else if (kind === "solicitation") {
      const closed = stage === "closed" || (!matter.rolling_deadline && isPast(deadline, today));
      const handoff = solicitationHandoff(matter);
      if (closed) {
        actions = [unavailable("official_application", "next_action_bid_closed", "The response deadline has passed.", deadline), notice(), watch];
      } else if (handoff.destination) {
        actions = [official("official_application", handoff.label_key, handoff.label, handoff.destination, deadline, {guide: handoff})];
      } else {
        // Guide-first: never punt with "use the response instructions in the official notice."
        actions = [validateAction({
          type: "bid_checklist",
          label_key: handoff.label_key || "next_action_response_guide",
          label: handoff.label || "Follow the response steps below",
          delivery: "local",
          destination: null,
          deadline,
          confirmation_required: false,
          guide: handoff,
        })];
      }
      if (!closed && deadline && !matter.rolling_deadline) actions.push(calendar);
      if (!closed) actions.push(watch);
    } else if (kind === "rule") {
      // Guide-first: comment-by-deadline + how-to-comment and hearing attend when fields exist.
      const handoff = ruleHandoff(matter, {today});
      const actionDeadline = handoff.comment_deadline || handoff.hearing_date || deadline || null;
      const ruleCalendar = actionDeadline && !isPast(actionDeadline, today)
        ? local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, actionDeadline)
        : null;
      if (handoff.mode === "closed" || handoff.mode === "proposed") {
        actions = [
          unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", actionDeadline),
          notice(),
          watch,
        ];
      } else if (handoff.destination) {
        const type = handoff.primary_type === "attend"
          ? "attend"
          : handoff.primary_type === "document"
            ? "document"
            : "comment";
        actions = [
          official(type, handoff.label_key, handoff.label, handoff.destination, actionDeadline, {guide: handoff}),
        ];
        if (ruleCalendar) actions.push(ruleCalendar);
        actions.push(watch);
      } else if (handoff.has_fields) {
        // Comment email / hearing venue without a single outbound URL — guide-first.
        actions = [validateAction({
          type: "bid_checklist",
          label_key: handoff.label_key || "next_action_rule_guide",
          label: handoff.label || "Follow the comment and hearing steps below",
          delivery: "local",
          destination: null,
          deadline: actionDeadline,
          confirmation_required: false,
          guide: handoff,
        })];
        if (ruleCalendar) actions.push(ruleCalendar);
        actions.push(watch);
      } else {
        actions = [
          unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", actionDeadline),
          notice(),
          watch,
        ];
      }
    } else if (kind === "hearing") {
      const past = stage === "past" || isPast(deadline, today);
      if (past) {
        actions = [unavailable("attend", "next_action_event_passed", "This event has passed.", deadline), notice(), watch];
      } else {
        const handoff = hearingHandoff(matter);
        if (handoff.destination) {
          // Join platforms stay "Join online"; agenda/materials pages keep an honest label.
          actions = [official("attend", handoff.label_key, handoff.label, handoff.destination, deadline, {guide: handoff})];
        } else if (handoff.has_fields) {
          // Venue / testimony / contact from the ingested body — never punt when those exist.
          actions = [validateAction({
            type: "bid_checklist",
            label_key: handoff.label_key || "next_action_hearing_guide",
            label: handoff.label || "Follow the participation steps below",
            delivery: "local",
            destination: null,
            deadline,
            confirmation_required: false,
            guide: handoff,
          })];
        } else {
          actions = [unavailable("attend", "next_action_participation_missing", "No online participation link is published in this notice.", deadline)];
        }
        if (deadline) actions.push(calendar);
        actions.push(watch);
      }
    } else if (kind === "zoning") {
      const handoff = zoningHandoff(matter, {today});
      const actionDeadline = deadline || handoff.deadline || null;
      const landWatch = local("watch", "next_action_watch_rezone", "Watch this rezoning", watchDestination(matter), null);
      // Rail keeps at most 3 actions (slice below). Prefer:
      //   join platform → [join, calendar, watch] (maps stay in guide steps)
      //   ZAP hybrid logistics → [maps attend, watch live, calendar|watch]
      const pushAttendanceExtras = (list, opts) => {
        const options = opts || {};
        const seen = new Set((list || []).map((a) => a && a.destination).filter(Boolean));
        const live = handoff.livestream_url
          || (handoff.join_kind === "livestream" ? handoff.participation_url : null);
        // Zoom/Webex join is already the primary CTA — don't burn a slot on maps.
        if (handoff.join_kind === "join" && !options.force) return list;
        if (handoff.maps_url && handoff.venue_address && !seen.has(handoff.maps_url)) {
          const label = handoff.venue_address
            ? `Attend in person at ${handoff.venue_address}`
            : "Attend in person";
          list.push(official(
            "attend",
            "land_action_attend_in_person_at",
            label,
            handoff.maps_url,
            actionDeadline,
            {guide: handoff, label_vars: {address: handoff.venue_address}},
          ));
          seen.add(handoff.maps_url);
        }
        if (live && !seen.has(live)) {
          list.push(official(
            "attend",
            "land_action_watch_live",
            "Watch live",
            live,
            actionDeadline,
            {guide: handoff},
          ));
          seen.add(live);
        }
        return list;
      };
      if (handoff.mode === "closed") {
        actions = [
          unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", actionDeadline),
        ];
        if (handoff.project_url) {
          actions.push(official("document", "zap_full_project", "Full project on ZAP", handoff.project_url, null));
        } else if (matter.official_notice_url) {
          actions.push(notice());
        }
        actions.push(landWatch);
      } else if (handoff.destination) {
        const type = handoff.primary_type === "attend"
          ? "attend"
          : handoff.primary_type === "document"
            ? "document"
            : "comment";
        actions = [
          official(type, handoff.label_key, handoff.label, handoff.destination, actionDeadline, {
            guide: handoff,
            label_vars: handoff.venue_address ? {address: handoff.venue_address} : undefined,
          }),
        ];
        pushAttendanceExtras(actions);
        if (actionDeadline && !isPast(actionDeadline, today)) {
          actions.push(local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, actionDeadline));
        }
        // Prefer watch when a 3-slot rail still has room after attendance CTAs.
        if (actions.length < 3) actions.push(landWatch);
        else if (!actions.some((a) => a && a.type === "watch")) {
          // Hybrid maps+live+calendar: drop calendar for watch only when no deadline.
          if (!(actionDeadline && !isPast(actionDeadline, today))) actions.push(landWatch);
        }
      } else if (handoff.has_fields) {
        // Phase context and/or hearing fields without a single outbound URL — guide-first.
        actions = [validateAction({
          type: "bid_checklist",
          label_key: "next_action_land_guide",
          label: "Follow the land-use participation steps below",
          delivery: "local",
          destination: null,
          deadline: actionDeadline,
          confirmation_required: false,
          guide: handoff,
        })];
        pushAttendanceExtras(actions, {force: true});
        if (actionDeadline && !isPast(actionDeadline, today) && actions.length < 3) {
          actions.push(local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, actionDeadline));
        }
        if (actions.length < 3) actions.push(landWatch);
      } else {
        actions = [
          unavailable("comment", "next_action_land_steps_missing", "No participation steps are published for this rezoning yet.", actionDeadline),
          landWatch,
        ];
      }
    } else if (kind === "exam") {
      const open = stage === "open";
      // Prefer per-exam OASys NOE deep link when mapped; else stable examsforjobs landing.
      const applyUrl = examApplyUrl(matter);
      const applyDeep = examApplyIsDeep(applyUrl);
      actions = open
        ? [official(
            "official_application",
            applyDeep ? "career_apply_oasys" : "career_apply_oasys_browse",
            applyDeep ? "Apply in OASys" : "Browse OASys exams",
            applyUrl,
            deadline,
            {
              guide: {
                system: "oasys",
                mode: applyDeep ? "deep" : "landing",
                identifier: String(matter.exam_number || matter.pin || "").trim() || null,
                oasys_exam_id: matter.oasys_exam_id ? String(matter.oasys_exam_id) : null,
                identifier_url: httpsUrl(matter.official_notice_url || matter.notice_url),
              },
            },
          ), calendar, notice()]
        : [unavailable("official_application", stage === "closed" ? "next_action_exam_closed" : "next_action_exam_not_open", stage === "closed" ? "The application window has closed." : "Applications are not open yet.", deadline), notice()];
    } else if (kind === "property") {
      // Disposition process next-step from stage + commercial bid steps + parcel affordances (no punt).
      const disp = String(matter.disposition_stage || stage || "").toLowerCase();
      const fields = noticeFieldGuidance(matter);
      // Commercial participation (GovDeals / sealed-bid / show dates) extracted from the body.
      const commercial = matter.commercial || null;
      const commercialUrl = commercial && commercial.participation
        ? (commercial.participation.package_url || null)
        : null;
      const packageUrl = fields.package_url || commercialUrl || httpsUrl(matter.package_url) || null;
      const commercialSteps = commercial && commercial.participation && Array.isArray(commercial.participation.steps)
        ? commercial.participation.steps
        : [];
      const commercialGuide = {
        system: "notice_extracted",
        mode: "commercial_participation",
        ...fields,
        package_url: packageUrl,
        sale_method: commercial && commercial.sale_method ? commercial.sale_method.method : fields.selection_method,
        commercial_item: commercial && commercial.item ? commercial.item.category : null,
        commercial_steps: commercialSteps.map((s) => s.text || s.kind).filter(Boolean).slice(0, 6),
        bbl: matter.bbl || null,
      };
      const parcelActs = parcelLookupActions(matter, deadline);
      const past = isPast(deadline, today);
      if (disp === "hearing" || (!disp && /hearing|meeting/i.test(String(matter.type_of_notice_description || "")))) {
        actions = past
          ? [unavailable("attend", "next_action_event_passed", "This event has passed.", deadline)]
          : matter.participation_url
            ? [official("attend", "join_online", "Join online", matter.participation_url, deadline)]
            : [local("attend", "disposition_phase_action_attend", "Prepare for the disposition hearing", null, deadline)];
        if (!past && deadline) actions.push(calendar);
        if (parcelActs.length) actions.push(parcelActs[0]);
        else actions.push(notice());
        if (!past) actions.push(watch);
      } else if (disp === "auction_or_rfp" || /sale/i.test(String(matter.type_of_notice_description || ""))) {
        if (packageUrl) {
          actions = [official("official_application", "property_action_open_rfp", "Open the sale / RFP package", packageUrl, deadline, { guide: commercialGuide })];
        } else if (commercialSteps.length || fields.has_fields) {
          actions = [validateAction({
            type: "bid_checklist",
            label_key: "disposition_phase_action_bid",
            label: "Follow the sale response steps below",
            delivery: "local",
            destination: null,
            deadline,
            confirmation_required: false,
            guide: commercialGuide,
          })];
        } else if (parcelActs.length) {
          actions = [...parcelActs];
        } else {
          actions = [notice()];
        }
        if (deadline && !past) actions.push(calendar);
        if (parcelActs.length && actions[0] && actions[0].label_key !== "property_action_lookup_zola") {
          actions.push(parcelActs[0]);
        }
        actions.push(watch);
      } else if (disp === "award_or_conveyance") {
        actions = parcelActs.length
          ? [...parcelActs, notice(), watch]
          : [notice(), watch];
      } else {
        // Generic disposition notice: bid marketplace / commercial steps when present, else parcel.
        if (packageUrl) {
          actions = [official("official_application", "property_action_open_rfp", "Open the sale / RFP package", packageUrl, deadline, { guide: commercialGuide }), watch];
        } else if (commercialSteps.length) {
          actions = [validateAction({
            type: "bid_checklist",
            label_key: "disposition_phase_action_bid",
            label: "Follow the sale response steps below",
            delivery: "local",
            destination: null,
            deadline,
            confirmation_required: false,
            guide: commercialGuide,
          }), watch];
        } else {
          actions = parcelActs.length
            ? [...parcelActs, notice(), watch]
            : [notice(), watch];
        }
      }
    } else if (kind === "award") {
      // Money award / selection rail: use lifecycle vendor, amount, registration, spending.
      // Never a solicitation "bid" CTA. Empty lifecycle degrades to notice + watch.
      const handoff = awardHandoff(matter);
      const labelExtra = handoff.label_vars ? { label_vars: handoff.label_vars } : {};
      if (handoff.has_fields) {
        if (handoff.destination) {
          actions = [official(
            "document",
            handoff.label_key,
            handoff.label,
            handoff.destination,
            null,
            { guide: handoff, ...labelExtra },
          )];
        } else {
          actions = [validateAction({
            type: "bid_checklist",
            label_key: handoff.label_key || "next_action_award_guide",
            label: handoff.label || "Track this award below",
            delivery: "local",
            destination: null,
            deadline: null,
            confirmation_required: false,
            guide: handoff,
            ...labelExtra,
          })];
        }
        if (matter.official_notice_url) actions.push(notice());
        actions.push(watch);
      } else {
        actions = [notice(), watch];
      }
    } else {
      actions = [notice(), watch];
    }

    return actions.slice(0, 3).map(validateAction);
  }

  function outcomeEvent(value) {
    if (!OUTCOME_ENUM.includes(value)) throw new TypeError("unknown outcome");
    return Object.freeze({event: "outcome_recorded", detail: value.replace("_", "-"), surface: "home"});
  }

  return {
    OUTCOME_ENUM,
    ACTION_TYPES,
    ACTION_DELIVERIES,
    PASSPORT_RFX_URL,
    PASSPORT_RFX_EXTRANET_BASE,
    NYCHA_ISUPPLIER_URL,
    OASY_APPLY_URL,
    passportRfxHandoffUrl,
    cleanPassportRfpId,
    examApplyUrl,
    examApplyIsDeep,
    isOasysGenericHub,
    compileActionRail,
    watchDestination,
    solicitationHandoff,
    awardHandoff,
    hearingHandoff,
    ruleHandoff,
    zoningHandoff,
    franchiseHandoff,
    zoningStage,
    landHearingBody,
    parcelLookupActions,
    checkbookHandoffUrl,
    packageUrlFromAttachments,
    packageUrlFromBody,
    validateAction,
    outcomeEvent,
  };
});
