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
  // Stable public OASys handoff (city redirect → a856-exams.nyc.gov/oasysweb). No public per-exam apply URL.
  const OASY_APPLY_URL = "https://www.nyc.gov/examsforjobs";

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

  /** Prefer a publisher-supplied apply URL when it is not the generic OASys landing. */
  function examApplyUrl(matter) {
    const explicit = httpsUrl(matter && matter.official_application_url);
    if (explicit) {
      try {
        const u = new URL(explicit);
        const path = (u.pathname || "").replace(/\/+$/, "") || "/";
        const isLanding = /examsforjobs/i.test(u.hostname + path)
          || (u.hostname.includes("nyc.gov") && /\/examsforjobs$/i.test(path));
        if (!isLanding) return explicit;
      } catch (_e) {
        return explicit;
      }
    }
    return OASY_APPLY_URL;
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
    if (/Award/.test(type)) return "award";
    return "notice";
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

  function noticeFieldGuidance(matter) {
    const body = String(matter.notice_text || "");
    const packageUrl = packageUrlFromBody(body) || httpsUrl(matter.package_url) || null;
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

  function compileActionRail(matter, options) {
    const opts = options || {};
    const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const kind = kindFor(matter || {});
    const stage = String(matter.lifecycle_stage || "").toLowerCase();
    const deadline = matter.deadline || null;
    const watch = local("watch", "next_action_watch", "Watch this notice", "#alerts", null);
    const calendar = local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, deadline);
    const notice = () => official("document", "read_official_notice", "Read the official notice", matter.official_notice_url, deadline);
    let actions;

    if (kind === "solicitation") {
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
      const open = stage === "comment-open" && !isPast(deadline, today);
      actions = open
        ? [official("comment", "rule_comment_btn", "Comment on the official rule page", matter.comment_url || matter.official_notice_url, deadline), calendar, watch]
        : [unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", deadline), notice(), watch];
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
      const active = !stage || ["active", "public-review", "hearing"].includes(stage);
      actions = active
        ? [official("comment", "view_comment_zap", "View and comment on ZAP", matter.project_url, deadline), watch]
        : [unavailable("comment", "next_action_comment_closed", "Public comment is not open now.", deadline), notice(), watch];
    } else if (kind === "exam") {
      const open = stage === "open";
      // Prefer exam-specific apply URL when publisher supplies one; else stable OASys landing.
      const applyUrl = examApplyUrl(matter);
      actions = open
        ? [official("official_application", "career_apply_oasys", "Apply in OASys", applyUrl, deadline, {
            guide: {
              system: "oasys",
              mode: applyUrl === OASY_APPLY_URL ? "landing" : "deep",
              identifier: String(matter.exam_number || matter.pin || "").trim() || null,
              identifier_url: httpsUrl(matter.official_notice_url || matter.notice_url),
            },
          }), calendar, notice()]
        : [unavailable("official_application", stage === "closed" ? "next_action_exam_closed" : "next_action_exam_not_open", stage === "closed" ? "The application window has closed." : "Applications are not open yet.", deadline), notice()];
    } else if (kind === "property") {
      // Disposition process next-step from stage + real parcel affordances (no punt).
      const disp = String(matter.disposition_stage || stage || "").toLowerCase();
      const fields = noticeFieldGuidance(matter);
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
        if (fields.package_url) {
          actions = [official("official_application", "property_action_open_rfp", "Open the sale / RFP package", fields.package_url, deadline, { guide: { system: "notice_extracted", mode: "notice_fields", ...fields, bbl: matter.bbl || null } })];
        } else if (parcelActs.length) {
          actions = [...parcelActs];
        } else if (fields.has_fields) {
          actions = [validateAction({
            type: "bid_checklist",
            label_key: "disposition_phase_action_bid",
            label: "Follow the sale response steps below",
            delivery: "local",
            destination: null,
            deadline,
            confirmation_required: false,
            guide: { system: "notice_extracted", mode: "notice_fields", ...fields, bbl: matter.bbl || null },
          })];
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
        // Generic disposition notice: parcel lookup first when BBL is known.
        actions = parcelActs.length
          ? [...parcelActs, notice(), watch]
          : [notice(), watch];
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
    compileActionRail,
    solicitationHandoff,
    hearingHandoff,
    parcelLookupActions,
    validateAction,
    outcomeEvent,
  };
});
