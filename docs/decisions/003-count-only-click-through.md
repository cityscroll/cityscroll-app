# 003 — Digest click-through: yes, but count-only

**Status:** accepted · 2026-07-02 (team decision)

## Decision

Digest emails link notices through `api.crol-list.org/r/<kind>/<request_id>`, which increments a
per-day counter (total + per watch-kind) and 302s to the notice permalink. Deliberately excluded:
per-recipient identifiers, per-email identifiers, IPs, user agents — the counter is a plain
integer per day. Every digest footer discloses the redirect and links to the public stats page.
The `/r` path never carries a URL (validated slug + id only), so it cannot be an open redirect.

## Why

- The team's honest question ("would it be possible to see active users?") deserves a real
  answer, and "digest links followed" is the closest outcome-shaped proxy that doesn't require
  tracking anyone (see 001).
- The alternative — unique tokens per recipient, the email-industry default — would tell us *who*
  reads, which we specifically don't want to know.

## Trade-offs accepted

- Digest links now depend on the worker being up. Mitigated: the site fails over between the
  custom domain and the workers.dev alias, and the City Record source link in each digest item
  remains direct.
- Counts are approximate (KV eventual consistency) and can't distinguish one person clicking five
  times from five people. Fine — these are trend numbers.
