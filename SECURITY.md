# Security

## Reporting

Found a vulnerability? Email **security@crol-list.org** (routed to the operator). Please give us
a reasonable window to fix before public disclosure; we'll credit you in the changelog unless you
prefer otherwise.

## Threat model (what we defend and how)

**Assets, in order of importance:**
1. Subscriber email addresses + their watch queries (KV, runtime only — never in this repo).
2. The operator's paid API keys (Anthropic, Resend) — abuse = our money.
3. The integrity of what the site displays (it must faithfully reflect the public record).

**Defenses, none of which depend on this code being secret:**
- **Secrets** live exclusively in Cloudflare's secret store (`wrangler secret put`); the repo
  holds no credentials, and never has (verified by a full-history scan before publication).
- **Denial-of-wallet**: every route that can spend money fails closed behind a hard daily
  ceiling. `/nl` has a CORS allowlist, input cap, and a KV-metered daily cap; `/mcp`'s
  model-backed tools share the same metering plus a per-IP daily limit and an optional bearer
  token; the inbound-email parser has a daily surface ceiling, a per-sender limit, size clamps,
  and auto-reply/loop guards; email sending has per-run and per-day caps. An unconfigured or
  capped route degrades, it doesn't fall open.
- **Abuse of write routes** (`/subscribe`, `/feedback`, `/inv`, `/batch`): Turnstile where a
  human is asserted, per-IP and per-address daily rate limits, strict validation, size clamps,
  TTLs on everything stored.
- **Email**: double opt-in (nothing stored until the signed confirm link is clicked), signed
  one-click unsubscribe (RFC 8058), From is always the app's own identity.
- **No open redirect**: `/r` accepts a validated slug + record id and constructs the target
  itself; paths never carry URLs.
- **Admin routes** are bearer-key-gated and 404 when unconfigured; their obscurity is not a
  defense.
- **The static site** is dependency-free vanilla JS on GitHub Pages: no build pipeline to
  poison, no third-party scripts beyond Cloudflare's cookieless analytics beacon.

- **The notices mirror (D1)** holds only already-public City Record data plus the raw source
  rows; nothing personal ever enters it. **Queues** carry subscription *keys*, not addresses.

**Out of scope / accepted:** a fork running its own copy with its own keys (their instance,
their rules — ours holds no shared state with it); KV eventual-consistency letting a burst
slightly exceed a rate cap; NYC Open Data availability (we display what the city publishes).
