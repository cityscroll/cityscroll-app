# Demo link contract

`demo-links.json` is the public, executable list of routes used to demonstrate CityScroll. Each
entry states what a visitor should see and what must not appear. Its `capabilities.entryIds`
selection is the curated source for the authenticated desk `/capabilities` page; the desk joins
those IDs back to the URL, feature, description, and executable expectations in this file. The
browser regression suite generates one test from every entry, so adding a route does not require
another test function.

## Entry fields

| Field | Meaning |
| --- | --- |
| `id` | Stable entry identifier. Tour and documentation surfaces may refer to it. |
| `url` | Hash route opened from `index.html`. |
| `feature` | Stable feature grouping used by other public surfaces. |
| `localOnly` | Optional. When `true`, the browser contract runs only against the local fixture server, not production `cityscroll.org`. Use for routes that ship in the same PR and are not live on the public host yet. |
| `productionOnly` | Optional. When `true`, the route depends on changing live data and is exercised by `tools/verify_capability_permalinks.py`, not the local fixture server. |
| `description` | One-line public description of the demonstrated capability. |
| `expectations.visible` | CSS selectors that must be visible; optional `text` narrows the match. |
| `expectations.notVisible` | CSS selectors or selector-and-text matches that must not be visible. |
| `expectations.hash` | Optional canonical hash expected after routing. It defaults to `url`. |
| `expectations.focus` | Exact selector that must own focus after an item route finishes rendering. |
| `expectations.states` | DOM property or attribute values that preserve filter and control state. |
| `expectations.banner` | Expected visible or hidden disclosure banner, with optional text. |

The complete machine-readable format is in `demo-links.schema.json`.

## Add or change a link

1. Add or edit one entry in `demo-links.json`. Keep `id` stable after publication.
2. Use visitor-facing wording and local hash routes only.
3. Prefer durable IDs, roles, or product classes in selectors. Avoid layout-only selectors.
4. Describe both the useful result and the failure state that must remain absent.
5. For an item route, include its post-render focus target.
6. Run the fast manifest check:

   ```sh
   python3 test/standards/demo_links.py
   ```

7. Run the generated browser contract:

   ```sh
   python3 test/functional/20_demo_links.py
   ```

8. Before adding an ID to `capabilities.entryIds`, prove every selected production permalink is
   live, populated, and showing its stated feature:

   ```sh
   python3 tools/verify_capability_permalinks.py
   ```

The general browser test uses deterministic local fixtures. The capability checker is deliberately
live: it rejects HTTP failures, absent expected content, visible forbidden states, blank shells,
and common empty-result copy.
