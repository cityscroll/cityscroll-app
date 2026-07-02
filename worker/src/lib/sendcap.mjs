// Pure spend-guard decision for the alerts mailer — no I/O, so it's unit-testable on its own.
//
// This is the denial-of-wallet / accidental-blast ceiling: given how much we've already sent
// (this run, and today) it decides whether one more watch may send, and if not, why it was
// capped. A capped watch is DEFERRED by the caller (left unseen, retried next run), never dropped.
//
//   per-run cap  — bounds a single cron firing (e.g. a stuffed config can't fire 500 at once)
//   daily cap    — bounds the whole UTC day across runs, kept below Resend's free 100/day

export function capDecision({ hasFresh, live, hasEmail, sentThisRun, sentToday, maxPerRun, maxPerDay }) {
  const wantSend = !!(hasFresh && live && hasEmail);
  if (!wantSend) return { wantSend, send: false, capped: null };
  if (sentThisRun >= maxPerRun) return { wantSend, send: false, capped: "per-run" };
  if (sentToday >= maxPerDay) return { wantSend, send: false, capped: "daily" };
  return { wantSend, send: true, capped: null };
}
