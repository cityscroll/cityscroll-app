export const MONEY_EVENT_TYPES = Object.freeze([
  "planned",
  "awarded",
  "registered",
  "amended",
  "encumbered",
  "invoiced",
  "paid",
  "reversed"
]);

const TYPES = new Set(MONEY_EVENT_TYPES);

export function validateMoneyEvent(event) {
  if (!TYPES.has(event.event_type)) throw new TypeError(`unknown money event type: ${event.event_type}`);
  if (!Number.isFinite(event.amount)) throw new TypeError("money event amount must be finite");
  if (event.currency !== "USD") throw new TypeError("money event currency must be USD");
  if (!event.effective_at || !event.source_key || !event.source_url) throw new TypeError("money event provenance is incomplete");
  if (event.event_type === "reversed" && (!event.reverses_source_key || event.amount >= 0)) {
    throw new TypeError("reversal must be negative and point to its source event");
  }
  if (event.source_system === "paris_abo" && event.quality !== "self_reported_unverified") {
    throw new TypeError("PARIS/ABO money must remain self-reported and unverified");
  }
  return event;
}

export function summarizeMoneyEvents(events, asOf) {
  const totals = {
    planned: 0,
    awarded: 0,
    registered: 0,
    amended: 0,
    encumbered: 0,
    invoiced: 0,
    paid: 0,
    reversed: 0
  };
  for (const event of events) {
    validateMoneyEvent(event);
    totals[event.event_type] += event.amount;
  }
  return {
    as_of: asOf,
    amount_types: Object.fromEntries(Object.entries(totals).map(([type, value]) => [
      type,
      {currency: "USD", value}
    ])),
    paid_net: {currency: "USD", value: totals.paid + totals.reversed}
  };
}

export function buildMoneyLedger(events, asOf) {
  const byProcess = new Map();
  for (const event of events) {
    validateMoneyEvent(event);
    const rows = byProcess.get(event.process_id) || [];
    rows.push(event);
    byProcess.set(event.process_id, rows);
  }
  return [...byProcess].map(([process_id, rows]) => ({
    process_id,
    events: rows.sort((a, b) => a.effective_at.localeCompare(b.effective_at) || a.source_key.localeCompare(b.source_key)),
    totals: summarizeMoneyEvents(rows, asOf)
  }));
}
