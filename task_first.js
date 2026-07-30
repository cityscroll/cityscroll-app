// Task-first entry presentations for two bounded visitor questions:
//   "Can I bid?" (procurement solicitations)
//   "What will change here?" (ZAP land-use projects)
// Official source fields are preserved verbatim; the presentation only reorders
// and labels them around the visitor's task. Payment-lag language may cite only
// observed lag figures with a named source — bid-count causality is not measured.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaskFirst = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ROLLING_RE = /rolling|until\s+expended|as\s+needed|continuous|open[-\s]?ended/i;

  function cleanText(value) {
    if (value == null) return "";
    return String(value)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseDueMs(dueDate) {
    if (!dueDate) return null;
    var ms = Date.parse(dueDate);
    return Number.isFinite(ms) ? ms : null;
  }

  function isRollingDeadline(dueDate) {
    return !!(dueDate && ROLLING_RE.test(String(dueDate)));
  }

  /**
   * Derive the bid answer from official solicitation fields only.
   * @param {object} official City Record fields
   * @param {Date|number|string} [now] clock for tests
   */
  function bidStatus(official, now) {
    var due = official && official.due_date;
    if (!due) {
      return { key: "unknown", open: null, days_left: null };
    }
    if (isRollingDeadline(due)) {
      return { key: "rolling", open: true, days_left: null };
    }
    var dueMs = parseDueMs(due);
    if (dueMs == null) {
      return { key: "unknown", open: null, days_left: null };
    }
    var clock = now == null ? Date.now() : +new Date(now);
    var daysLeft = Math.ceil((dueMs - clock) / 86400000);
    if (daysLeft < 0) return { key: "closed", open: false, days_left: daysLeft };
    if (daysLeft === 0) return { key: "due_today", open: true, days_left: 0 };
    return { key: "open", open: true, days_left: daysLeft };
  }

  /**
   * Task-first presentation for a procurement notice.
   * Preserves every official field on the returned object.
   */
  function presentCanIBid(example, options) {
    options = options || {};
    var official = Object.assign({}, (example && example.official) || {});
    var status = bidStatus(official, options.now);
    var facts = {
      stage: official.type_of_notice_description || null,
      method: official.selection_method_description || null,
      deadline: official.due_date || null,
      agency: official.agency_name || null,
      pin: official.pin || null,
      category: official.category_description || null,
      title: cleanText(official.short_title) || null,
      contact_name: cleanText(official.contact_name) || null,
      contact_phone: cleanText(official.contact_phone) || null,
      email: official.email || null,
      submit_to: cleanText(official.address_to_request) || null,
      other_info: cleanText(official.other_info_1) || null,
      description: cleanText(official.additional_description_1) || null,
      start_date: official.start_date || null,
      request_id: official.request_id || null,
      section_name: official.section_name || null,
      contract_amount: official.contract_amount != null ? official.contract_amount : null,
      vendor_name: official.vendor_name || null,
    };

    var paymentLag = presentPaymentLag(example && example.observed_payment_lag);

    return {
      task: "can-i-bid",
      id: (example && example.id) || official.request_id || null,
      bid_status: status,
      lead: {
        bid_status: status,
        stage: facts.stage,
        method: facts.method,
        deadline: facts.deadline,
        agency: facts.agency,
        pin: facts.pin,
      },
      facts: facts,
      official: official,
      source: (example && example.source) || null,
      observed_payment_lag: paymentLag,
      notice_hash: official.request_id ? "#notice/" + official.request_id : null,
    };
  }

  /**
   * Payment lag may appear only as an observed figure with a named source.
   * Bid-count causality is never attached here — it is not measured.
   */
  function presentPaymentLag(observed) {
    if (!observed || observed.days == null || !observed.source) return null;
    var days = Number(observed.days);
    if (!Number.isFinite(days)) return null;
    return {
      days: days,
      source: String(observed.source),
      source_url: observed.source_url || null,
      subject: observed.subject || null,
      measured_as: observed.measured_as || "registration_lag_days",
      // Hard product rule: presentation templates must not claim bid-count effects.
      bid_count_causality_claimed: false,
    };
  }

  /**
   * Task-first presentation for a ZAP project.
   */
  function presentWhatWillChange(example) {
    var official = Object.assign({}, (example && example.official) || {});
    var placeParts = [official.borough, official.community_district].filter(Boolean);
    var place = placeParts.length ? placeParts.join(" · ") : null;
    var facts = {
      place: place,
      borough: official.borough || null,
      community_district: official.community_district || null,
      boundary_actions: official.actions || null,
      stage_public: official.public_status || null,
      stage_project: official.project_status || null,
      milestone: official.current_milestone || null,
      title: cleanText(official.project_name) || null,
      brief: cleanText(official.project_brief) || null,
      applicant: cleanText(official.primary_applicant) || null,
      ulurp_numbers: official.ulurp_numbers || null,
      mih_flag: official.mih_flag == null ? null : String(official.mih_flag),
      project_id: official.project_id || null,
    };

    return {
      task: "what-will-change",
      id: (example && example.id) || official.project_id || null,
      lead: {
        place: facts.place,
        boundary: facts.boundary_actions,
        stage: facts.stage_public || facts.milestone,
        brief: facts.brief,
      },
      facts: facts,
      official: official,
      source: (example && example.source) || null,
      land_hash: official.project_id ? "#land/" + official.project_id : null,
    };
  }

  function presentExample(example, options) {
    if (!example) return null;
    if (example.task === "can-i-bid") return presentCanIBid(example, options);
    if (example.task === "what-will-change") return presentWhatWillChange(example);
    return null;
  }

  /** Every official key on the source record must still appear on the presentation. */
  function officialFieldsIntact(example, presentation) {
    if (!example || !presentation || !example.official || !presentation.official) return false;
    var keys = Object.keys(example.official);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var left = example.official[key];
      var right = presentation.official[key];
      if (left == null && right == null) continue;
      if (String(left) !== String(right)) return false;
    }
    return true;
  }

  function paymentLagCopyIsSafe(text) {
    if (!text) return true;
    var lower = String(text).toLowerCase();
    // Forbidden: unmeasured causal claims about bidding volume.
    if (/\b(fewer|more|less|reduced?|increas\w*|deter|discourage|encourage)\b[\s\S]{0,40}\bbids?\b/.test(lower)) {
      return false;
    }
    if (/\bbids?\b[\s\S]{0,40}\b(because|due to|from)\b[\s\S]{0,40}\b(payment|pay\s*lag|late\s*pay)/.test(lower)) {
      return false;
    }
    return true;
  }

  function listTaskIds(bundle, task) {
    var group = bundle && bundle.tasks && bundle.tasks[task];
    if (!group || !Array.isArray(group.examples)) return [];
    return group.examples.map(function (ex) {
      return ex.id;
    });
  }

  function findExample(bundle, task, id) {
    var group = bundle && bundle.tasks && bundle.tasks[task];
    if (!group || !Array.isArray(group.examples)) return null;
    for (var i = 0; i < group.examples.length; i++) {
      if (group.examples[i].id === id) return group.examples[i];
    }
    return null;
  }

  function parseTaskHash(raw) {
    if (!raw) return null;
    var path = String(raw).replace(/^#/, "");
    if (!path.startsWith("task/")) return null;
    var rest = path.slice(5);
    if (!rest) return { task: null, id: null, collection: true };
    var slash = rest.indexOf("/");
    if (slash < 0) {
      if (rest === "can-i-bid" || rest === "what-will-change") {
        return { task: rest, id: null, collection: true };
      }
      return null;
    }
    var task = rest.slice(0, slash);
    var id = decodeURIComponent(rest.slice(slash + 1));
    if (task !== "can-i-bid" && task !== "what-will-change") return null;
    if (!id) return { task: task, id: null, collection: true };
    return { task: task, id: id, collection: false };
  }

  function taskCollectionHash(task) {
    return "#task/" + task;
  }

  function taskItemHash(task, id) {
    return "#task/" + task + "/" + encodeURIComponent(id);
  }

  return {
    cleanText: cleanText,
    bidStatus: bidStatus,
    isRollingDeadline: isRollingDeadline,
    presentCanIBid: presentCanIBid,
    presentWhatWillChange: presentWhatWillChange,
    presentExample: presentExample,
    presentPaymentLag: presentPaymentLag,
    officialFieldsIntact: officialFieldsIntact,
    paymentLagCopyIsSafe: paymentLagCopyIsSafe,
    listTaskIds: listTaskIds,
    findExample: findExample,
    parseTaskHash: parseTaskHash,
    taskCollectionHash: taskCollectionHash,
    taskItemHash: taskItemHash,
  };
});
