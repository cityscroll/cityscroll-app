# Mission

CROL-List exists to shrink the time between the City of New York publishing a decision and the
people it affects finding out — without asking anything of them in return.

This file is the project's *machine-readable mission*: precise enough that a new collaborator (or
an AI agent shipping a feature) can make the right call without asking, and short enough to read
before every consequential change.

## Objective

**Minimize time-to-awareness** of City Record actions (contracts, hearings, rule changes,
rezonings, property dispositions, personnel moves) for anyone with an interest in them —
journalist, vendor, community board member, neighbor.

## Success measures (in order)

1. **Standing watches that fire and get read** — active subscriptions, digests sent, digest links
   followed (all public at [crol-list.org/stats.html](https://crol-list.org/stats.html)).
2. **Time-to-awareness** — a subscriber learns about a matching notice the morning after it's
   published, days-to-weeks before they'd have found it themselves (or never).
3. **Citations** — notices, entity pages, and exported workspaces used in reporting, testimony,
   or filings.

Page views are not a success measure. Speed-of-shipping is not a success measure.

## Constraints (non-negotiable)

- **No accounts, no cookies, no tracking of individuals.** The only personal data ever held is a
  subscriber's own email address, double-opted-in, used only to send them their own digest,
  deletable in one click. All measurement is aggregate counting (see `stats.html`).
- **Statistical context, never accusations.** Red flags and benchmarks state computed facts with
  published formulas and named false-positive modes. The reader judges.
- **The site never hard-depends on the backend.** Every feature degrades gracefully when the
  worker is unreachable; search always works.
- **Honest data honestly labeled.** If the data can't support a feature (a price filter, a
  hearing join), we don't fake it — we say why (see `about.html`).
- **Identity discipline.** Email and posts come from the app's own identity
  (`alerts@crol-list.org`); nothing is ever sent as a person without that person sending it.
- **Spending is capped by construction.** Every route that can cost money has a hard daily
  ceiling and fails closed.

## Trade-off rules

- Transparency beats engagement. Reach matters only in service of awareness.
- Deleting a confusing feature beats documenting it.
- A smaller number honestly counted beats a bigger number with an asterisk.
- When two constraints conflict, protect the reader's privacy first, the record's accuracy second,
  everything else after.

## What this project is not

Not a news outlet (no editorializing), not an enforcement tool (no verdicts), not a growth
project (no dark patterns, ever), and not a replacement for the official record — every notice
links back to its City Record source.
