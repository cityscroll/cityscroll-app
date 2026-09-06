# Browser verification for the guide surfaces

`capture-manifest.json` in this directory is the primary record: 42 captures and
8 journeys at 390px and 1440px, all assertions holding. This file records
the two checks run alongside it that the manifest does not itself contain.

Repository revision `320c011ee06d9aa0fa00845b587bb47d5095aa13`, against the
local static build, with no network.

## The shared accessibility and focus gates

The guide documents are already in the page list those gates walk, so they were
run rather than assumed:

| Gate | Result |
| --- | --- |
| `test/functional/11_accessibility.py` | green on all pages, including `guide/index.html` and every published article under it; no critical or serious axe violations |
| `test/functional/14_focus_visible.py` | green; the skip link reaches the first focusable element and targets an existing `#main`, and all 14 first-party focus stops have a visible indicator |

## Modified clicks

The guide is prose with native links and no script of its own, so a reader's
ordinary browser gestures have to keep working. A Meta+click on the first link
in `main` on each guide page opened the link target in a new tab and left the
original page where it was:

| Page | Link | Outcome |
| --- | --- | --- |
| `/guide/` | `/guide/start/explore-housing-across-city-records/` | opened in a new tab; original stayed on `/guide/` |
| `/guide/start/explore-housing-across-city-records/` | `/guide/` | opened in a new tab; original stayed on the tutorial |
| `/guide/reference/glossary/` | `/guide/` | opened in a new tab; original stayed on the glossary |
| `/guide/understand/how-records-are-connected/` | `/guide/` | opened in a new tab; original stayed on the explanation |

Browser Back, the JavaScript-disabled reading path, 200% reflow, horizontal
overflow, target size, and internal link status are all recorded per route and
per viewport in `capture-manifest.json`.

## Reproducing

```sh
tools/prepare_functional_site.sh
python3 tools/local_site_server.py --directory _site --port 0 --ready-file <file>
CROL_BASE=<the base it reports> python3 test/functional/11_accessibility.py
CROL_BASE=<the base it reports> python3 test/functional/14_focus_visible.py
```

The modified-click check is one `page.click(modifiers=[...])` call against the
first link in `main` on each of the four guide routes above, asserting the popup
lands on the resolved href and the opener does not navigate.
