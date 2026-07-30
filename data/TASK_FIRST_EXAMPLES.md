# Task-first entry examples

`task_first_examples.json` is a **bounded, inline-at-build** set of ten real City
Record and ZAP records used by the task-first entry surfaces:

| Route | Visitor task | Records |
| --- | --- | --- |
| `#task/can-i-bid` | Can I bid? | 5 procurement solicitations |
| `#task/what-will-change` | What will change here? | 5 ZAP projects |

These routes are an **entry-point experiment**. They do not replace or restructure
the Contracts or Zoning lenses. Existing `#money`, `#notice/…`, `#land`, and
`#land/…` routes keep working; each task card links through to the matching
lens item for the full interactive detail.

## What “task-first” means here

Each presentation **preserves every official field** from the snapshot and only
reorders the lead so a visitor’s question is answered first:

- **Can I bid?** — bid open/closed from `due_date`, then stage, selection method,
  deadline, agency, PIN, contact, and full description.
- **What will change here?** — place (borough + community district), boundary
  actions, public stage / milestone, then the project brief and applicant.

## Payment-lag language

The bundle’s `payment_lag_policy` is load-bearing:

- Observed payment-lag figures may be cited with a named source.
- **Bid-count causality is not measured** and must not be claimed in copy or UI.

Open solicitations in this snapshot carry `observed_payment_lag: null`.

## Refresh

Re-capture from NYC Open Data when examples go stale (deadlines pass, projects
close). Keep five of each task; prefer diverse agencies and boroughs. Verbatim
official fields only — no invented eligibility rules.
