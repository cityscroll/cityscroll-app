# civic-content-gates

Reusable **civic content CI gates** — the mechanically checkable rules from the
[NYC Web Content Style Guide](https://designsystem.nyc.gov/standards/nyc-web-content-style-guide.html)
plus companion checks (i18n key parity, reading-level ratchet) that any static
civic site can run.

This package is extracted from CityScroll's production gates. Extraction keeps
each gate's verdict logic; it does not redesign the rules.

## Suite members

| Gate | What it enforces |
|---|---|
| `link_text` | Link text must make sense out of context (no "click here") |
| `control_labels` | Visible controls use at most four words and do not present status as an action |
| `i18n_keys` | Every shipping language has every English key |
| `nyc_copy_lint` | Style-guide copy rules (acronyms, currency form, PDF links, …) |
| `heading_punctuation` | No colon/period in headings (question marks allowed) |
| `page_metadata` | Title length + separator; meta description length |
| `genai_disclosure` | About page discloses generative-AI use for site copy |
| `reading_level` | Flesch–Kincaid gate/ratchet via [readable-or-else](https://github.com/jimdc/readable-or-else) |
| `no_disclaimer_slop` | Positive plain-language check for defensive disclaimer copy |

## Install

```bash
# from a clone of this repository
pip install -e ./civic-content-gates

# reading-level member (optional)
pip install git+https://github.com/jimdc/readable-or-else.git
```

## Run

```bash
# full suite against a site directory
civic-content-gates run --root path/to/site --allowlist path/to/allowlist.txt

# with the reading-level ratchet
civic-content-gates run --root path/to/site \
  --baseline path/to/reading-level-baseline.json

# one gate
civic-content-gates check link_text --root path/to/site

# report disclaimer-slop findings without failing
civic-content-gates check no_disclaimer_slop --root path/to/site --no-disclaimer-slop-mode warn

# promote the calibrated check to a blocking gate
civic-content-gates check no_disclaimer_slop --root path/to/site --no-disclaimer-slop-mode block

# or as a module (no install)
PYTHONPATH=civic-content-gates python3 -m civic_content_gates run --root site
```

### GitHub Actions

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-python@v5
  with:
    python-version: "3.12"
- name: Civic content gates
  uses: ./.github/actions/civic-content-gates
  with:
    site-root: site
    allowlist: test/standards/nyc_copy_lint_allowlist.txt
    baseline: site/reading-level-baseline.json
```

## Expected site layout

```
site/
  index.html
  about.html
  …
  i18n.js                 # window.STRINGS + SHIPPING_LANGS
  i18n/lang/<lang>.js     # per-language dictionaries
  reading-level-baseline.json   # optional, for ratchet mode
```

Sites without i18n can still run `link_text`, `page_metadata`, `heading_punctuation`,
and `reading_level` against plain HTML.

## Positive plain-language check

`no_disclaimer_slop` scans rendered HTML, page-template JavaScript strings, i18n
source, and generated HTML pages. It starts in `warn` mode so the curated pattern
set can be reviewed against real copy. Each finding points to a positive rewrite:
say what the thing is, why it matters, and what the reader should do — for example,
“Default: X, because Y; do Z.”

The repository wrapper is:

```bash
python3 test/standards/no_disclaimer_slop.py --mode warn
python3 test/standards/no_disclaimer_slop.py --mode block
```

Use a reviewed `RULE_ID<TAB>exact copy` entry in
`test/standards/no_disclaimer_slop_allowlist.txt`, or place
`no-disclaimer-slop: ignore` on the same or immediately preceding source line.
The inline marker is useful when a real evidence boundary needs to stay beside
the copy it explains. CI runs the check in warn mode; set the
`NO_DISCLAIMER_SLOP_MODE` repository variable to `block` after calibration.

## License

MIT
