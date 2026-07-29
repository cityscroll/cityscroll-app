# cityscroll.org as a sending domain (Resend) — prep status

Purpose: pre-verify `cityscroll.org` with Resend so a future canonical-domain flip can
swap the alerts sender from `alerts@crol-list.org` to `alerts@cityscroll.org` without a
cold-start DNS wait. **The live sender is unchanged** — `ALERTS_FROM` in
`worker/wrangler.toml` still points at `crol-list.org`.

## What exists today

- A `cityscroll.org` domain object has been created in the Resend account used by this
  project (`worker` secret `RESEND_API_KEY`), domain id `d6bb9aa7-dd4f-4305-9472-53118de697e1`,
  region `us-east-1`.
- The three required DNS records have been added to the `cityscroll.org` Cloudflare zone
  (zone id `be328e4440eabf7a4c53dc1b3741bbf4`) and confirmed resolving:

  | Purpose | Type | Name | Value | Priority | TTL | Resend status |
  |---|---|---|---|---|---|---|
  | DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCx8KrFDDi35mc1zeOM9OJ7lx8ebBfE/BmbhT/XlIyQnelthNlx5zoeQQHAdbXB8KSHT+Wy8c3r+Y1CTskAvMJ0TmLNvOqLMSGHccWR+aRjdVxwgv/5TpobYre+wCkIFgb/HyAZrzvf4CfO/pJRC94pDjHEFjpjYLXhOTnzTBd+6QIDAQAB` | — | Auto | verified |
  | SPF (routing) | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto | pending |
  | SPF (policy) | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — | Auto | pending |

  These are public DNS records, not secrets, and are safe to keep in the repo. `dig` confirms
  all three resolve at the DNS layer; Resend's own re-check of the MX/TXT pair is still
  catching up as of this writing.

## What's left

Resend re-checks domain records on its own schedule; DKIM has already flipped to
`verified` and the remaining SPF records are expected to follow once Resend's next
check runs. Once `GET https://api.resend.com/domains/d6bb9aa7-dd4f-4305-9472-53118de697e1`
reports overall `status: verified`:

1. Send one test message from `alerts@cityscroll.org` to confirm deliverability.
2. Only after that confirmation: change `ALERTS_FROM` in `worker/wrangler.toml` from
   `alerts@crol-list.org` to `alerts@cityscroll.org` (or make it host-aware, if the two
   domains should each send under their own name) and redeploy.
