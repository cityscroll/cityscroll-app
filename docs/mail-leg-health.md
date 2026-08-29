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
`fail` / `unprobed`. The Gmail forward line stays `unprobed` until the site owner
confirms Cloudflare Email Routing on the dashboard.

## Receipts

- Inbound Worker deliveries write `ops:mail:inbound:latest` even when the message
  is ignored as a loop or the enroll path is unconfigured.
- Operations-mailbox sends write `ops:mail:outbound:latest` with Resend acceptance.
- Canaries write `ops:mail:canary:latest` and, on Worker receipt,
  `ops:mail:canary:inbound:<token>`.
