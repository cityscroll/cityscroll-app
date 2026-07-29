const day = (value) => value ? Date.parse(`${value}T00:00:00Z`) / 86400000 : null;

const definitions = {
  date_order: {
    title: "Publication follows service start",
    required: ["notice_date", "service_start"],
    evaluate: (f) => day(f.notice_date) > day(f.service_start),
    counterfactual: "The notice date is on or before the service start date."
  },
  expired_before_process: {
    title: "Intent notice follows negotiations",
    required: ["intent_notice_date", "negotiation_start"],
    evaluate: (f) => day(f.intent_notice_date) > day(f.negotiation_start),
    counterfactual: "The intent notice is published before negotiations begin."
  },
  future_competition: {
    title: "Successor notice follows bridge end",
    required: ["bridge_end", "successor_notice_date"],
    evaluate: (f) => day(f.successor_notice_date) > day(f.bridge_end),
    counterfactual: "A successor notice is published before the bridge or extension ends."
  },
  contestability_package: {
    title: "Single responsive bid with an incomplete competition record",
    required: ["responsive_bid_count", "required_form_present"],
    evaluate: (f) => f.responsive_bid_count === 1 &&
      (f.notified_vendor_count == null || f.required_form_present === false),
    counterfactual: "The record shows more than one responsive bid, the notified count, and required forms."
  },
  broken_succession: {
    title: "Successor starts after an extension ends",
    required: ["extension_end", "successor_start"],
    evaluate: (f) => day(f.successor_start) > day(f.extension_end) && !f.amendment_rationale,
    counterfactual: "The successor starts before the extension ends, or a transition rationale is published."
  }
};

export const ALARM_RULES = Object.freeze(definitions);

export function evaluateAlarm(ruleId, record) {
  const rule = definitions[ruleId];
  if (!rule) throw new TypeError(`unknown alarm rule: ${ruleId}`);
  const missing = rule.required.filter((field) => record.facts?.[field] == null);
  if (missing.length) {
    return {
      case_id: record.id,
      rule_id: ruleId,
      status: "insufficient",
      title: rule.title,
      missing_fields: missing,
      facts: record.facts,
      sources: record.sources,
      language: "Not enough published evidence to evaluate this review lead."
    };
  }
  const fired = rule.evaluate(record.facts);
  return {
    case_id: record.id,
    rule_id: ruleId,
    status: fired ? "lead" : "clear",
    title: rule.title,
    triggering_facts: fired ? Object.fromEntries(Object.entries(record.facts).filter(([, value]) => value != null)) : {},
    facts: record.facts,
    sources: record.sources,
    counterfactual: rule.counterfactual,
    language: fired
      ? "Review lead: the published dates or fields meet this rule. Human review is needed."
      : "Rule checked; the published facts do not meet this review-lead threshold."
  };
}

export function evaluateAlarmFixtures(cases) {
  return cases.map((record) => evaluateAlarm(record.rule, record));
}
