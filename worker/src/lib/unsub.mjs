// Pure helpers for the List-Unsubscribe header — no I/O, so they're unit-testable on their own
// (same pattern as lib/sendcap.mjs). mailto form: the unsubscribe request lands at the reply
// address, which Cloudflare Email Routing forwards to the operator inbox for manual removal from
// alerts.config.json — so it needs NO HTTPS endpoint. One-click (RFC 8058) would additionally need
// that endpoint + a suppression list the send loop consults; deferred until there's a public
// subscriber list (see email-alerts report §6, "a public subscribe form").

// Extract the bare address from an RFC 5322 From ("Name <addr>" or a bare "addr").
export function replyAddr(from) {
  const m = String(from || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(from || "")).trim();
}

// Build the List-Unsubscribe header value for a watch: an angle-bracketed mailto whose subject
// names the watch, so a manual unsubscribe tells the operator which slice to drop.
export function listUnsubscribe(from, watchId) {
  const subject = encodeURIComponent(`unsubscribe ${watchId}`);
  return `<mailto:${replyAddr(from)}?subject=${subject}>`;
}
