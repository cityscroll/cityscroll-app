# 004 — Open-source the worker, in this repo

**Status:** accepted · 2026-07-02 (team decision)

## Decision

The Cloudflare Worker (`crol-worker`, previously a private sibling repo) is open-sourced into
this public repo as `worker/`, imported as a fresh tree (the private repo's history stays
archived privately). One clone is now the whole system.

## Why

- **Security doesn't depend on source secrecy** (Kerckhoffs's principle): every real secret
  (API keys, Turnstile, token signing, admin key) lives in Cloudflare's secret store, never in
  git; subscriber data lives only in KV at runtime; abuse defenses are caps + Turnstile +
  fail-closed defaults, all of which work identically when the code is public. The route/cap
  design was already publicly documented in this repo's README and `api.html`.
- **Transparency is the brand.** A transparency tool with a secret backend is off-mission; an
  inspectable one lets anyone verify the privacy claims in 001 and 003 against the actual code.
- **Forkability is distribution.** "Clone this and point it at your city's open-data portal" only
  works if the clone contains the whole system.

## Preconditions completed before publication

1. Operator email externalized (`FEEDBACK_TO` var; default routes to the project domain).
2. Test fixtures scrubbed of personal-looking addresses.
3. Full-history secret scan (only ever a test dummy; real secrets never touched git).
4. Fresh-tree import — the private history is not published.
5. `SECURITY.md` documenting the threat model and a disclosure contact.

## Consequences

- GitHub Pages serves `worker/` files as static text. Harmless (the code is public) and it keeps
  the repo layout simple.
- A fork without our secrets fails closed (`/nl` degrades, `/subscribe` 503s) — that's the
  defense-in-depth design demonstrating itself.
- The private `crol-worker` repo is archived with a tombstone README; all future worker work
  happens here.
