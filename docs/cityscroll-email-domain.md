# cityscroll.org as a sending domain (Resend) — prep status

Purpose: pre-verify `cityscroll.org` with Resend so a future canonical-domain flip can
swap the alerts sender from `alerts@crol-list.org` to `alerts@cityscroll.org` without a
cold-start DNS wait. **The live sender is unchanged** — `ALERTS_FROM` in
`worker/wrangler.toml` still points at `crol-list.org`.

## What exists today

- A `cityscroll.org` domain object has been created in the Resend account used by this
  project (`worker` secret `RESEND_API_KEY`), domain id `d6bb9aa7-dd4f-4305-9472-53118de697e1`,
  region `us-east-1`. Status as of creation: `not_started` (DNS records not yet added).
- Resend returned the following required DNS records for `cityscroll.org`:

  | Purpose | Type | Name | Value | Priority | TTL |
  |---|---|---|---|---|---|
  | DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCx8KrFDDi35mc1zeOM9OJ7lx8ebBfE/BmbhT/XlIyQnelthNlx5zoeQQHAdbXB8KSHT+Wy8c3r+Y1CTskAvMJ0TmLNvOqLMSGHccWR+aRjdVxwgv/5TpobYre+wCkIFgb/HyAZrzvf4CfO/pJRC94pDjHEFjpjYLXhOTnzTBd+6QIDAQAB` | — | Auto |
  | SPF (routing) | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto |
  | SPF (policy) | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — | Auto |

  These are public DNS records, not secrets, and are safe to keep in the repo.

## What's blocking completion

Adding those records to the `cityscroll.org` Cloudflare zone requires a Cloudflare API
token scoped for `Zone:DNS:Edit` on that zone. The Cloudflare auth available in this
environment (the `wrangler login` OAuth session) only carries `zone:read` plus
`workers_routes:write` (enough to manage the Worker's custom-domain routes, which is a
separate mechanism from raw DNS record management) — it does not carry DNS-record write
access, and `wrangler` has no built-in DNS subcommand to fall back on.

## What the flip will change, once unblocked

1. Add the three records above to the `cityscroll.org` zone.
2. Poll `GET https://api.resend.com/domains/d6bb9aa7-dd4f-4305-9472-53118de697e1` until
   `status` reports `verified`.
3. Send one test send from `alerts@cityscroll.org` to confirm deliverability.
4. Only after that confirmation: change `ALERTS_FROM` in `worker/wrangler.toml` from
   `alerts@crol-list.org` to `alerts@cityscroll.org` (or make it host-aware, if the two
   domains should each send under their own name) and redeploy.
