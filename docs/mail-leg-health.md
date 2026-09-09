# Mail-leg health

Inbound Cloudflare Email Routing and outbound Resend sends are different rails.
A failure on one does not prove a failure on the other.

| Leg | Path | How it is checked |
|---|---|---|
| Outbound operations mailbox | Worker Resend send to `team@cityscroll.org` | Rejected sends remain failures; outbound delivery behavior is unchanged. |
| Inbound Worker consumer | Legacy Email Routing → Worker `email()` handler | Retired 2026-09-08; residual deliveries record receipts and a countable `inbound-email-retired` log event, without parsing, enrollment, or replies. |
| Inbound Gmail forward | `alerts@crol-list.org` and the domain catch-all | Dashboard-gated; this repo cannot observe the destination inbox |

Subscribe-by-email and its inbound canary were retired on 2026-09-08.
Existing watches, the Following page, digests, and other outbound mail are unchanged.
`GET /admin/reliability/mail` reports the inbound leg as `retired`; old canary
receipts, missing matches, and elapsed probe deadlines cannot fail health or page.
The former canary POST action is no longer supported (HTTP 405), and scheduled
checks only read health. Rejected operations sends still produce HTTP 503 and
remain visible through the scheduled reliability check without retrying a dead mail leg.

The legacy subscribe routing rule is external to this repository; no routing-rule
infrastructure definition or deployment API step manages it here. In the
[Cloudflare dashboard](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#disable-a-routing-rule),
select the legacy domain, open Compute → Email Service → Email Routing → Routing
Rules, and toggle the `subscribe` rule to Disabled. Until then the handler is receipt-only.

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

Live mode reads the mail snapshot without sending and prints per-leg `pass` /
`fail` / `unprobed` (including the retired inbound leg). The Gmail forward line stays `unprobed` because this
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
| Worker consumer inbound | KV receipt (destination/time/retired disposition) | Gone | None. Existing watches remain in SUBS; inbound messages cannot create watches |
| Subscriber digest | D1 outbox + KV watermarks | Resend retrieve when `provider_message_id` and API key exist; otherwise reconstruct from `payload_json` | Owed D1 rows drain on the next digest. That is a rebuild, not an RFC822 replay |
| Operations mailbox send | KV receipt after deploy | Resend retrieve if a provider id was stored | `POST /admin/ops-alert` can send a new alarm; it cannot resurrect a never-generated one |

The live probe in this environment: GitHub Actions logs are reachable; Wrangler/Resend/admin-key
secrets are not present, so D1/KV/Resend pulls stay `credential_missing` until those
secrets are supplied. Fixture `--recovery` does not call providers.

## Receipts

- Inbound Worker deliveries write `ops:mail:inbound:latest` with destination,
  observation time, and `disposition: retired`. Message bodies and senders are not stored.
- Operations-mailbox sends write `ops:mail:outbound:latest` with Resend acceptance.
- Historical canary receipts are ignored; no new probe or token-match receipts are written.
- Exception findings append a bounded history at `ops:mail:findings:history`.
