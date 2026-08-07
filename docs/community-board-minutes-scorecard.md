# Community board minutes scorecard

The public page is generated at [`/community-boards/`](../site/community-boards/index.html). Its stable machine-readable artifact is [`site/data/community_board_minutes_scorecard.json`](../site/data/community_board_minutes_scorecard.json).

Build or verify both artifacts with:

```sh
node tools/build_community_board_scorecard.mjs
node tools/build_community_board_scorecard.mjs --check
```

The scorecard consumes the official 59-board registry and, when present, the detector artifact at `site/data/community_board_minutes_gap.json`. The detector handoff contract is `cityscroll.community_board_minutes_gap_detector.v1`: it supplies `as_of` and `rows[]` keyed by `body_id`; a row may include `last_minutes_date`, `minutes_url`, `notice_completeness`, `media_completeness`, and `receipts[]`. Dates and URLs are used only when explicitly supplied and receipt-backed. Until a dated detector receipt exists, the public row says “not measured yet” rather than treating an inventory-only board as missing minutes.

Measured rankings sort by days since the last dated minutes publication, then by `body_id` for deterministic ties. Freshest boards are leaders; oldest are laggards. The page links every board to its verified homepage and links a minutes page only when the registry or detector supplied that exact URL.
