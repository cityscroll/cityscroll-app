# Digest preview + ops parity evidence

## Findings

| Surface | Verdict | Notes |
|---------|---------|-------|
| Site alert preview (`digItemHTML` / `aPreview`) | **Fixed** | Loads `site/digest_item_awareness.mjs` and shows phase / open·closing-soon·closed / next-step under each dig item — same model as email. |
| Desk hub daylog (`digest_ops`) | **OK (send-level)** | Send-level: `noticeIds`, `noticeLinks`, outcome labels. Does not re-render email item HTML. Continuity of deep links verified. |

## Files

- `alert-preview.html` — email-mock dig items with awareness
- `desk-daylog.html` — operator send row + JSON
- `findings.json` — machine-readable verdicts

Regenerate: `node tools/render_preview_ops_parity_evidence.mjs`
