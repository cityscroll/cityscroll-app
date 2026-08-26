# Calendar contract evidence

The `before/` directory records the current public behavior before any calendar-scope work:

- `meetings-feed.ics` is the captured response from `https://api.cityscroll.org/feed.ics?lens=meetings`.
- `meetings-ui-desktop.png` and `meetings-ui-mobile.png` are headless captures of the Meetings
  surface. The capture asserts that no `Subscribe to calendar` affordance or `/feed.ics` link is
  present.

The deterministic after-state is the committed golden set in `test/fixtures/calendar-contract/`.
Run `node --test test/calendar_contract.test.mjs` to regenerate no files and verify that all
four payloads remain byte-for-byte identical to the current production functions.
