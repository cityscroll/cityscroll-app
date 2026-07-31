# Account-level digest rollup and preference center

## Concepts

| Term | Meaning |
|------|---------|
| **Watch** | One filter + lens row in `SUBS` KV (`sub:<id>`). |
| **Account** | An email identity that may own many watches. |
| **Digest rollup** | One email per recipient per day when that email has more than one active watch; HTML sections per watch that had content (or a quiet summary). |
| **Preference center** | Magic-link page (`GET/POST /prefs`) to list, edit, pause, or delete watches for that email. |

No passwords or full login accounts. Identity is the confirmed email, same as magic-link sessions and pins.

## Delivery rules

- **Rollup when** more than one non-paused watch shares an email.
- **Single path** when exactly one active watch (unchanged per-watch email shape).
- **Paused** watches are skipped for delivery; they remain visible in the preference center.
- **Send caps:** one rollup email counts as **one send unit** toward `MAX_PER_RUN` and `MAX_SENDS_PER_DAY`, regardless of section count.
- **Queue mode:** cron enqueues one job per account (`type: "rollup"` with `keys`, or `type: "sub"` with `key`), not one job per watch for multi-watch accounts.

## Cutover rule (preference center)

Edits write to `SUBS` immediately. The daily digest always reads current `SUBS` rows, so changes take effect on the **next daily cron** (~13:00 UTC / **~9am Eastern**). Every preference-center surface states this.

## Unsubscribe

| Scope | How |
|-------|-----|
| One watch | Existing token `{ k: "sub:…" }` on List-Unsubscribe and per-watch footers. |
| All watches | Token `{ all: 1, e: "<email>" }` from rollup footers and preference center “Unsubscribe all”. |

## Preference center

- **URL:** `https://api.cityscroll.org/prefs?token=…`
- **Token:** purpose-scoped optin-token `{ sc: "prefs", e: email }` (~60 days), issued from digest footers (`Manage watches`).
- **Actions:** list, update keywords/freq, pause/unpause, delete one watch, unsubscribe all.
- **Cannot:** change email, invent a new lens without the normal double-opt-in signup flow.

## Operator debug

```
GET /admin/digest-rollup?key=<ADMIN_KEY>&email=<address>
```

Dry-runs evaluation for that email (forces non-live send). Returns active watch count, whether rollup would apply, section outcomes, and a day-log preview. Does not call Resend.

Day logs (`digest:daylog:<day>` in `ALERT_STATE`) set `kind: "rollup"` for consolidated sends and `kind: "subscription"` for single-watch sends. Rollup entries include `sendUnits: 1` and a `sections` array.

## Migration

Existing multi-subscription addresses keep working without data migration. On the first deploy that includes rollup, any email with two or more active watches receives one consolidated message instead of N separate digests. Single-watch addresses are unchanged.

## Characterization

```bash
cd worker && node --test test/rollup.test.mjs test/prefs_lib.test.mjs test/prefs.test.mjs test/digest_rollup.test.mjs
```
