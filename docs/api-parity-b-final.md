# API parity B-final: independent contract desk consumer

This proof builds a small external-style consumer that produces a journalist-oriented
contract desk report for one agency. The consumer is deliberately separate from CityScroll's
site, Worker, capability providers, and read models: it uses only the documented public HTTP
surface described on the [API and feeds page](https://cityscroll.org/api.html).

## Workflow

Run the consumer with a public API base URL and an agency name:

```sh
node examples/external-contract-desk/index.mjs \
  --agency "Agency A" \
  --json
```

The default base URL is `https://api.cityscroll.org`; `--base-url` makes local or fixture
execution possible without changing the consumer. The report:

1. calls `GET /contracts/analysis?group_by=vendor&measure=current&agency=…&limit=…` to obtain
   registered-contract value, denominator, coverage, freshness, exact contract IDs, and the
   site's canonical drill-through URL;
2. calls the same documented operation with `measure=count`;
3. checks that both public responses agree on each vendor's exact IDs and contract count; and
4. derives each vendor's share of the explicit selected-scope registered-value denominator.

No CityScroll source module is imported. The regression uses a pair of public-response fixtures
as HTTP responses, so it exercises the external boundary without depending on live network state.

## Parity evidence

The test asserts that the report preserves the public site's vendor order, values, contract
counts, exact IDs, and canonical `/browse/contracts/` drill-through links. It also asserts that
the report's denominator and coverage statement come from the public response, rather than being
reconstructed from a private snapshot. This is response-boundary parity: the independent
consumer reproduces the site-visible analytical facts and links from the same published contract.

The public interfaces used are:

| Interface | Use |
| --- | --- |
| `GET /contracts/analysis` with `measure=current` | Ranked vendor registered value and selected-scope denominator |
| `GET /contracts/analysis` with `measure=count` | Independent identity/count cross-check |
| `group.drill_through.href` in the response | Site-visible path for reviewing the contributing Contracts scope |

The equivalent documented MCP operation is `analyze_contracts`, but this proof uses HTTP only.

## Honest gap

The documented analysis capability reports registered contract value. It explicitly does not
report actual payments or spending, and the consumer makes no payment claim. A payment-focused
journalist workflow would need a separately documented public payment-analysis twin; this proof
records that boundary instead of reaching into internal payment projections or treating a missing
payment measure as zero.

Focused regression:

```sh
node --test test/external_contract_desk.test.mjs
```
