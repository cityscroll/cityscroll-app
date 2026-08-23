---
card_standard: kraken-v1
id: cityscroll-procurement-observability/p8-digest-watch-parity-without-notice
title: "p8 · Digest and Watch parity for procurement ids without a City Record notice"
status: implemented
---

## Story

A resident can watch a PASSPort-only or Checkbook-only procurement object. Following counts, the Watch control, digest compile, outbox identity, and email delivery share that `procurement_id`.

## Change

**Before:** Money digest compile queried City Record by `request_id`, procurement documents had no Watch control for CROL-negative ids, and Following copy described City Record-only delivery.

**After (realized):** Money watches compile City Record notices plus CROL-negative rows from the shared procurement digest snapshot. `/procurements` documents expose Watch this contract and Follow this vendor. Digest items link to `/procurements/…` and never invent a City Record notice. Following copy says public records, not City Record-only.

**Theory / mechanism:** Delivery identity is the observation-fed procurement object already used for Search and Browse. CROL-negative rows keep `procurement_id`; City Record-backed watches keep `request_id`.
