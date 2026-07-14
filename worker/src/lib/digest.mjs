// Pure decision + formatting for the alerts "confidence" feature — no I/O, so it's unit-testable
// on its own (mirrors lib/sendcap.mjs).
//
// The problem it solves: if a subscriber only ever gets silence, they can't tell "nothing matched"
// from "the alerts are broken." So we break silence deliberately, frequency-aware:
//   - weekly subs ALWAYS get their weekly email — empty weeks say "nothing new this week"
//   - daily subs get matches immediately, PLUS a heartbeat after HEARTBEAT_DAYS of quiet
// and every send carries "since <date>" so the covered window is legible.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06-30" | full ISO -> "Jun 30". Manual formatting so we don't depend on Intl locale data
// being present in the Worker runtime.
export function shortDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}

// Whole UTC days from `fromDate` to `toDate` (date strings / ISO). A null/invalid `from` yields
// Infinity — treated as "quiet forever", so a first heartbeat is due.
export function daysBetween(fromDate, toDate) {
  const a = Date.parse(String(fromDate || "").slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(String(toDate || "").slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / 86400000);
}

// What (if anything) to send this run for ONE already-eligible subscription. (The caller still
// applies the weekly "only on Mondays" gate before calling this, and the send-caps after.)
//   match        — there are fresh notices (freshCount > 0)
//   weekly-empty — weekly sub, no fresh: the reassuring weekly check-in
//   heartbeat    — daily sub, no fresh, but quiet >= heartbeatDays: a liveness ping
//   none         — daily sub, no fresh, still inside the quiet window: stay silent
export function digestDecision({ freshCount, freq, lastSentDate, today, heartbeatDays = 14 }) {
  if (freshCount > 0) return { action: "match" };
  if (freq === "weekly") return { action: "weekly-empty" };
  const quiet = daysBetween(lastSentDate, today);
  return quiet >= heartbeatDays ? { action: "heartbeat" } : { action: "none" };
}

// A handful of Award notices are republished by City Record itself, byte-identical, under a
// second request_id — the `seen`-set (keyed on request_id alone) can't catch that, so a
// watching subscriber would see the same notice twice in one digest. Collapse rows that share
// a content fingerprint within THIS run's fresh list, keeping the first occurrence's request_id.
export function dedupeFreshByContent(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = ["pin", "agency_name", "short_title", "vendor_name", "start_date"].map((k) => r[k] ?? "").join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
