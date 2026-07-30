# Entity double-escaping in preview cards

Field case: notice `20220525018` (NYCIDA supplemental public hearing).

| Surface | Before (production) | After (this branch) |
|---------|---------------------|---------------------|
| Full notice `#notice/20220525018` | Typographic quotes (`“Agency”`) | Same, via shared decode→escape-once |
| Meetings card `#meetings?when=past&q=IDA` | Literal `&ldquo;Agency&rdquo;` in excerpt | Typographic quotes |

## SHA-pinned raw sources (HTTP 200 at capture)

See `urls.txt`. SODA row snapshot: `raw-notice.json`.

## Viewports

390×844 and 1440×900, annotated bottom banner. Capture:

```bash
python3 tools/capture_entity_double_escaping.py
```

## Owner function

`site/text_clean.mjs` — `cleanNoticeText` / `excerptHtml` (decode → truncate on plain text → escape once). Site cards call `excerptHtml`; worker digest/API snippets import the same module.
