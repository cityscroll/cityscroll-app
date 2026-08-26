# After-state verification

The after-state is intentionally identical to the before contract. The characterization gate is:

```sh
node --test test/calendar_contract.test.mjs
```

It compares the standing Meetings feed, individual meeting event, keyword/agency feed, and
documented `lens/q/agency/min` feed against CRLF-preserving golden files, including UIDs,
`DTSTART`/`DTEND`, and summaries.
