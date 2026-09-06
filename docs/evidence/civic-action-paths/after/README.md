# Civic Action Paths — after-state captures

Desktop (1440px) and mobile (390px) captures of the landed Action Path
surfaces. Regenerated with:

```text
python3 tools/capture_civic_action_paths_after.py
python3 tools/capture_civic_action_paths_after.py --check
```

The machine matrix is [`capture-manifest.json`](capture-manifest.json).
Community Board Ways to participate also keeps the CAP-6 compatibility receipt
[`ways-to-participate-capture.json`](ways-to-participate-capture.json).

| Fixture | Route | What the image must prove |
| --- | --- | --- |
| `strict_matter_join` | `/meetings/strict-matter/` | One exact Council matter (`79200`) with its own continuation control — “View official matter record,” since that matter has no published local history — plus the retained later state Laid Over by Subcommittee. Calendar remains a separate control. |
| `unmatched_hearing` | `/meetings/unmatched/` | No matter continuation is fabricated for the unmatched Buildings hearing. |
| `cb_source_backed` | `/community-boards/manhattan-cb-02/` | Source-backed Ways to participate, including attend, without turning a closed application into Apply now. |
| `cb_unknown` | `/community-boards/bronx-cb-02/` | Unsupported speaking and public-committee application paths stay omitted. No cross-board policy. |
| `dot_t2_adoption` | `/rules/dot-t2-adoption/` | July 14 adoption on `rulemaking:dot:bicycle-owned-racks`. Copy reports what happened to the rulemaking. |
| `dot_t3_effective` | `/rules/dot-t3-effective/` | August 13 effective date on the same rulemaking subject. Copy reports what happened to the rulemaking and does not attribute the outcome to a resident comment. |

Each capture receipt names the fixture, viewport, observed commit, evidence
object URL, and page observations. A handoff or follow action is not completed
participation.
