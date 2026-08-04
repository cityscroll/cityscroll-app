# City Record corpus access for external consumers

CityScroll's public source contract already provides a generic route to the complete
City Record corpus: use the official NYC Open Data dataset that the
[API page](https://cityscroll.org/api.html) identifies for bulk work. No CityScroll
product endpoint needs to duplicate the publisher's full export.

This is the narrow waist for downstream data products: one publisher-owned row
contract, with domain-specific extraction performed after acquisition.

## Surface audit

| Surface | Complete corpus | Complete published text | Bulk | Incremental cursor | Intended use |
|---|---:|---:|---:|---:|---|
| [City Record Online SODA `dg92-zbpx`](https://data.cityofnewyork.us/d/dg92-zbpx) | Yes | Yes | Yes | Yes | Source rows for external data products |
| `https://api.cityscroll.org/feed.json`, `.xml`, `.ics` | No | No | No | Feed polling only | Filtered CityScroll views |
| `POST https://api.cityscroll.org/batch` | No | No | No | No | Small vendor cross-reference requests |
| `POST https://api.cityscroll.org/mcp` | No | No | No | No | Search and display detail from the recent D1 mirror |
| `https://cityscroll.org/#notice/<request_id>` | One row | Human-readable full text | No | No | Reading and citation |

The MCP tool names `search_notices` and `get_notice` can sound broader than their
storage contract. They return the daily-refreshed recent mirror. Search results carry
snippets, and `get_notice` returns CityScroll's display record rather than the raw
publisher row. They must not be used as a corpus export or change feed.

The warehouse under `warehouse/` is build infrastructure, not a hosted public data
surface. Its City Record dataset declaration and bulk machinery use the same official
source described below.

## Publisher endpoints

| Purpose | Endpoint |
|---|---|
| Dataset page | `https://data.cityofnewyork.us/d/dg92-zbpx` |
| SODA JSON | `https://data.cityofnewyork.us/resource/dg92-zbpx.json` |
| SODA CSV | `https://data.cityofnewyork.us/resource/dg92-zbpx.csv` |
| Complete CSV export | `https://data.cityofnewyork.us/api/views/dg92-zbpx/rows.csv?accessType=DOWNLOAD` |
| Schema and publisher metadata | `https://data.cityofnewyork.us/api/views/dg92-zbpx.json` |

The JSON API uses SODA field names. The complete text-bearing fields are:

- `additional_description_1`, `additional_description_2`,
  `additional_description_3`
- `other_info_1`, `other_info_2`, `other_info_3`
- `printout_1`, `printout_2`, `printout_3`

These values can contain publisher-supplied HTML and embedded newlines. Preserve the
original values as source evidence, then derive plain text separately if needed. A
missing JSON key means that field is null for that row; it does not mean the field is
absent from the schema.

The complete CSV export uses publisher display headers rather than SODA field names.
In particular, the current display header for `additional_description_2` is misspelled
`AdditionalDesctription2`. Consumers should map columns from the schema endpoint's
`name` and `fieldName` properties instead of guessing header spellings.

## Initial snapshot

Use the complete CSV export for an initial load. It avoids deep API pagination and
includes every publisher column.

```sh
curl --fail --location \
  'https://data.cityofnewyork.us/api/views/dg92-zbpx/rows.csv?accessType=DOWNLOAD' \
  --output city-record.csv
```

Before the download, capture a high-water cursor from the JSON endpoint:

```sh
curl --fail --get \
  'https://data.cityofnewyork.us/resource/dg92-zbpx.json' \
  --data-urlencode '$select=:id,:updated_at' \
  --data-urlencode '$order=:updated_at DESC,:id DESC' \
  --data-urlencode '$limit=1'
```

Store the returned `:updated_at` and `:id` tuple. After loading the CSV, replay changes
strictly after that tuple using the incremental request below. Upsert by `request_id`,
so a row present in both the CSV and the replay remains harmless.

For a bounded JSON query that includes every user and system field, use
`$select=:*,*`. For example:

```sh
curl --fail --get \
  'https://data.cityofnewyork.us/resource/dg92-zbpx.json' \
  --data-urlencode '$select=:*,*' \
  --data-urlencode "\$where=request_id = '20201005107'" \
  --data-urlencode '$limit=1'
```

## Incremental change cursor

Socrata publishes `:updated_at` and `:id` system fields. Use them together as a
lexicographic keyset cursor; `start_date` is the notice vintage, not an update cursor.

Given checkpoint values `CURSOR_UPDATED_AT` and `CURSOR_ID`, request a page with:

```sh
curl --fail --get \
  'https://data.cityofnewyork.us/resource/dg92-zbpx.json' \
  --data-urlencode '$select=:*,*' \
  --data-urlencode \
    "\$where=:updated_at > '$CURSOR_UPDATED_AT' OR (:updated_at = '$CURSOR_UPDATED_AT' AND :id > '$CURSOR_ID')" \
  --data-urlencode '$order=:updated_at ASC,:id ASC' \
  --data-urlencode '$limit=5000'
```

Apply the page as idempotent upserts keyed by `request_id`. Advance the checkpoint to
the last row's `:updated_at` and `:id` only after that page is durably stored. Continue
until the response is empty. A smaller page size is reasonable when rows contain long
HTML bodies.

Two limitations require explicit handling:

1. A publisher full-replace can mark every row updated. Treat that as a large valid
   replay, not as a reason to skip rows. Socrata documents this behavior for system
   fields.
2. The row query does not provide deletion tombstones. Run a periodic complete export
   reconciliation and compare `request_id` sets if deletion fidelity matters.

Socrata recommends an application token for sustained request volume. Send it as
`X-App-Token`; it changes rate limits, not the row contract. The public endpoint can be
used without a token for small verification requests.

## Verified contract

The fixed [2026-08-04 access receipt](evidence/city-record-corpus-access/2026-08-04.json)
records the live probes behind this guide. At verification time the source contained
1,098,994 rows, all with distinct `request_id` values, spanning notice vintages from
2003-01-02 through 2026-08-04. The schema exposed 37 publisher columns, including all
nine text-bearing fields above. A two-page `:updated_at`/`:id` probe returned disjoint
pages.

Authoritative protocol references:

- [Socrata system fields](https://dev.socrata.com/docs/system-fields.html)
- [Socrata paging guidance](https://dev.socrata.com/docs/paging.html)
- [SODA consumer API](https://dev.socrata.com/consumers/getting-started)
