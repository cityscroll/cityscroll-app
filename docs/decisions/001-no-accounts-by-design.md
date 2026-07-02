# 001 — No accounts, no cookies, no individual tracking

**Status:** accepted · 2026-06 (founding posture), recorded 2026-07-02

## Decision

CROL-List has no user accounts, sets no cookies, and never tracks individuals. The only personal
datum the system ever holds is a subscriber's own email address (double-opted-in, one-click
deletable, used solely to send that subscriber their own digest). Analytics are aggregate-only:
Cloudflare's cookieless beacon for traffic, plain per-day counters for outcomes.

## Why

- The audience (journalists, vendors, civic watchers) is exactly the audience most burned by
  tracking; trust is the product.
- Every comparable official tool gates features behind logins (the official CROL login-walls bid
  attachments); being the no-account alternative is a differentiator, not a sacrifice.
- No stored identity = no breach worth having. The worst-case leak of our KV is a list of email
  addresses and their watch queries — bad, but bounded, and we keep even that minimal.

## Consequences

- "Active users" cannot be measured and won't be faked; we measure outcomes instead (see 003 and
  `stats.html`).
- Cross-device state (pins, watches built in the browser) lives in localStorage and doesn't roam.
  Accepted cost.
