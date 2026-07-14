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

// ---- match evidence: show subscribers WHY a keyword-matched notice is in their digest ----
//
// Without this, a notice can appear with nothing visibly explaining the match: an alert for
// "education" once surfaced "NOS - Equity Index Investment Management Products" (an Office of
// the Comptroller pension-fund notice) with no visible link to the word "education" at all --
// the hit was buried in the notice's description, which names the Board of Education
// Retirement System, one of the pension funds the notice covers. Neither the title nor the
// meta line the digest already renders gave any hint why that notice was there.
//
// terms: the subscriber's search keywords (case-insensitive substring match -- the same
// semantics as SODA's $q / the D1 mirror's `haystack LIKE` search). Fields checked, most
// visible first: the notice title, then its description (additional_description_1) -- the
// only two fields a digest item's own rendering ever shows or keeps on hand.
function locateAnyTerm(text, terms) {
  const hay = String(text || "").toLowerCase();
  let best = null;
  for (const term of terms) {
    const needle = String(term || "").trim();
    if (!needle) continue;
    const idx = hay.indexOf(needle.toLowerCase());
    if (idx !== -1 && (best === null || idx < best.index)) best = { term: needle, index: idx };
  }
  return best;
}

// Returns null when there are no keywords to explain (amount-only / name-only watches --
// entity and bigaward matches are unambiguous without a snippet). Otherwise one of:
//   {field:"title", term, index}            -- highlight the term in the title itself
//   {field:"description", term, before, hit, after} -- a one-line snippet, term emphasized
//   {field:"unknown", term}                  -- matched via a field this digest never fetches
//     (SODA's $q also searches columns like contact/method fields) -- name the term rather
//     than showing the notice with no explanation at all.
export function matchEvidence(title, description, terms) {
  const words = (terms || []).filter(Boolean);
  if (!words.length) return null;

  const inTitle = locateAnyTerm(title, words);
  if (inTitle) return { field: "title", term: inTitle.term, index: inTitle.index };

  const text = String(description || "");
  const inDesc = locateAnyTerm(text, words);
  if (inDesc) {
    const RADIUS = 70;
    const start = Math.max(0, inDesc.index - RADIUS);
    const end = Math.min(text.length, inDesc.index + inDesc.term.length + RADIUS);
    return {
      field: "description", term: inDesc.term,
      before: (start > 0 ? "…" : "") + text.slice(start, inDesc.index),
      hit: text.slice(inDesc.index, inDesc.index + inDesc.term.length),
      after: text.slice(inDesc.index + inDesc.term.length, end) + (end < text.length ? "…" : ""),
    };
  }

  return { field: "unknown", term: words[0] };
}
