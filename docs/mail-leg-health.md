# Mail-leg health

Inbound Cloudflare Email Routing and outbound Resend sends are different rails.
A failure on one does not prove a failure on the other.

| Leg | Path | How it is checked |
|---|---|---|
| Outbound operations mailbox | Worker Resend send to `team@cityscroll.org` | `POST /admin/reliability/mail` canary records provider acceptance |
| Inbound Worker consumer | `subscribe@crol-list.org` → Worker `email()` handler | Canary subject token must appear in an `ops:mail:` inbound receipt |
| Inbound Gmail forward | `alerts@crol-list.org` and the domain catch-all | Dashboard-gated; this repo cannot observe the destination inbox |

`GET /admin/reliability/mail` and the digest/scheduler watchdogs fail closed (HTTP 503)
when a canary is unmatched or an operations send is rejected. A dead alert rail does
**not** try to email itself; the scheduled Reliability watchdogs workflow is the
independent GitHub-red alarm.

## Pre/post-cutover gate

Offline (CI / no secrets):

```bash
node tools/check_mail_legs.mjs
node --test test/mail_legs.test.mjs worker/test/reliability_watchdogs.test.mjs
```

Live (operator key, not a pull-request gate):

```bash
CITYSCROLL_ADMIN_KEY=… node tools/check_mail_legs.mjs --live
```

Live mode posts a canary, polls the mail snapshot, and prints per-leg `pass` /
`fail` / `unprobed`. The Gmail forward line stays `unprobed` because this
repository cannot observe the destination inbox or replay a message.

## Interpreting Email Routing failure counts

A dashboard FAILED total is not a count of lost useful mail. Cloudflare Email
Routing can retry one rejected message many times; those retries are lifecycle
events on the same message ID. SPF/DKIM passing while Gmail returns `421 4.7.28`
is a transient unsolicited-volume deferral on the sender's DKIM domain, not
proof that forwarding is misconfigured.

Collapse Activity Log rows by message ID before acting:

```bash
node --test test/mail_legs.test.mjs
```

`summarizeEmailRoutingActivity` in `tools/check_mail_legs.mjs` encodes that
collapse. Per-message identity (subject, sender, recipient, message ID) is
required; this view does not expose a body or a replay control.

## Recoverable vs gone

This is a separate diagnostic from naming work. Print the closed inventory with:

```bash
node tools/check_mail_legs.mjs --recovery
```

For the Activity Log incident (three unsolicited forward envelopes, retries of
one Gmail `421 4.7.28`):

| Item | State |
|---|---|
| Envelope metadata | Recoverable (Activity Log export: subject, sender, recipient, message ID, SPF/DKIM, retry events) |
| Message bodies | Gone |
| Queued copies | Gone (no replay control; Gmail never accepted) |
| Worker bounce store | Gone (DSN senders are ignored; no bounce table) |
| Useful lost messages | None in this set |

Other rails, if they had failed:

| Class | Metadata | Body | Queue / resend |
|---|---|---|---|
| Worker consumer inbound | KV receipt after deploy (to/time/token only) | Gone | None. A completed enroll is the watch in SUBS, not the original mail |
| Subscriber digest | D1 outbox + KV watermarks | Resend retrieve when `provider_message_id` and API key exist; otherwise reconstruct from `payload_json` | Owed D1 rows drain on the next digest. That is a rebuild, not an RFC822 replay |
| Operations mailbox send | KV receipt after deploy | Resend retrieve if a provider id was stored | `POST /admin/ops-alert` can send a new alarm; it cannot resurrect a never-generated one |

The live probe in this environment: GitHub Actions logs are reachable; Wrangler/Resend/admin-key
secrets are not present, so D1/KV/Resend pulls stay `credential_missing` until those
secrets are supplied. Fixture `--recovery` does not call providers.

## Receipts

- Inbound Worker deliveries write `ops:mail:inbound:latest` even when the message
  is ignored as a loop or the enroll path is unconfigured.
- Operations-mailbox sends write `ops:mail:outbound:latest` with Resend acceptance.
- Canaries write `ops:mail:canary:latest` and, on Worker receipt,
  `ops:mail:canary:inbound:<token>`.
