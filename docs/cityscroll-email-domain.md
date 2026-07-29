# cityscroll.org as a sending domain (Resend)

`cityscroll.org` is verified with the email provider (Resend) and is now the live
alerts sender. See `docs/canonical-domain-cutover.md` for the site owner's decision
record on the sender-domain switchover (2026-07-29).

## What exists today

- A `cityscroll.org` domain object has been created in the Resend account used by this
  project (`worker` secret `RESEND_API_KEY`), domain id `d6bb9aa7-dd4f-4305-9472-53118de697e1`,
  region `us-east-1`.
- The three required DNS records have been added to the `cityscroll.org` Cloudflare zone
  (zone id `be328e4440eabf7a4c53dc1b3741bbf4`) and confirmed resolving:

  | Purpose | Type | Name | Value | Priority | TTL | Resend status |
  |---|---|---|---|---|---|---|
  | DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCx8KrFDDi35mc1zeOM9OJ7lx8ebBfE/BmbhT/XlIyQnelthNlx5zoeQQHAdbXB8KSHT+Wy8c3r+Y1CTskAvMJ0TmLNvOqLMSGHccWR+aRjdVxwgv/5TpobYre+wCkIFgb/HyAZrzvf4CfO/pJRC94pDjHEFjpjYLXhOTnzTBd+6QIDAQAB` | — | Auto | verified |
  | SPF (routing) | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto | verified |
  | SPF (policy) | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — | Auto | verified |

  These are public DNS records, not secrets, and are safe to keep in the repo.

## Status: verified and live

Resend reports `cityscroll.org` fully verified. A one-time test send from
`alerts@cityscroll.org` confirmed deliverability (Resend message id
`71c6541e-3bb1-4b41-8100-54a8fefd2416`) before the switchover. `ALERTS_FROM` in
`worker/wrangler.toml` now points at `alerts@cityscroll.org`; `crol-list.org` stays
verified in Resend as a fallback sending domain.
