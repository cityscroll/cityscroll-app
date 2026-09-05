# Card "PPD-06" rendered evidence: a vendor's own pursuit-decision state

Textual evidence to accompany `capture-manifest.json`. `site/procurement_pursuit_state.mjs`
is a pure model with no rendered page of its own yet, so unlike the sibling
PPD-05 preference-set evidence there is no screenshot for this card. Each
block below is the exact JSON `tools/render_procurement_pursuit_state_capture_fixtures.mjs`
prints for the named case, calling the real `recordPursuitDecision()`,
`resurfacePursuitState()`, and `renderPursuitStateNoteHtml()` functions
directly against fixture rows.

## Recorded and resurfaced (Fixture A — Parks, Playground reconstruction)

- Case id: `pursuit-state-recorded`

```json
{
  "stored_record": {
    "matter_ref": "procurement:epin-2026-07",
    "decision": "pursuing",
    "reason_code": "capability_fit",
    "note": "Strong match for our playground-equipment crew.",
    "recorded_at": "2026-07-10T09:00:00.000Z",
    "provenance": "user-supplied"
  },
  "resurfaced_rows": [
    {
      "procurement_id": "procurement:epin-2026-07",
      "short_title": "Playground reconstruction solicitation",
      "agency_name": "Department of Parks and Recreation",
      "pursuit_state": {
        "schema": "cityscroll.procurement_pursuit_state.v1",
        "register": "personal-state",
        "provenance": "user-supplied",
        "decision": "pursuing",
        "label": "Pursuing",
        "reason_code": "capability_fit",
        "reason_label": "capability fit",
        "note": "Strong match for our playground-equipment crew.",
        "recorded_at": "2026-07-10T09:00:00.000Z",
        "text": "You marked this pursuing (capability fit)."
      }
    },
    {
      "request_id": "S48020",
      "short_title": "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
      "agency_name": "MTA Construction & Development"
    }
  ],
  "rendered_note_html": "<p class=\"pursuit-state-note\" data-pursuit-state-register=\"personal-state\" data-pursuit-state-provenance=\"user-supplied\" data-pursuit-state-decision=\"pursuing\">You marked this pursuing (capability fit).</p>",
  "unrelated_matter_carries_no_key": true
}
```

Confirms A1 (a decision from the closed vocabulary is recorded), A2 (a
structured reason and a note accompany it), and A3 (the decision resurfaces
on a later listing containing this matter). Fixture D's unrelated row carries
no `pursuit_state` key at all -- annotation, not inference.

## No decision recorded — nothing resurfaces

- Case id: `pursuit-state-none`

```json
{
  "resurfaced_rows": [
    {
      "procurement_id": "procurement:epin-2026-07",
      "short_title": "Playground reconstruction solicitation",
      "agency_name": "Department of Parks and Recreation"
    },
    {
      "request_id": "S48020",
      "short_title": "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
      "agency_name": "MTA Construction & Development"
    }
  ],
  "every_row_carries_no_key": true
}
```

Confirms the negative rule: an unrecorded matter is never inferred or
defaulted to a decision, and the listing itself is otherwise unchanged --
same rows, same order, same count.

## Privacy boundary — one vendor's decision, two vendors' views

- Case id: `pursuit-state-privacy-boundary`

```json
{
  "vendor_one_sees": [
    {
      "procurement_id": "procurement:epin-2026-07",
      "short_title": "Playground reconstruction solicitation",
      "agency_name": "Department of Parks and Recreation",
      "pursuit_state": {
        "schema": "cityscroll.procurement_pursuit_state.v1",
        "register": "personal-state",
        "provenance": "user-supplied",
        "decision": "passed",
        "label": "Passed",
        "reason_code": "amount",
        "reason_label": "amount",
        "note": null,
        "recorded_at": "2026-07-10T09:00:00.000Z",
        "text": "You marked this passed (amount)."
      }
    }
  ],
  "vendor_two_sees": [
    {
      "procurement_id": "procurement:epin-2026-07",
      "short_title": "Playground reconstruction solicitation",
      "agency_name": "Department of Parks and Recreation"
    }
  ],
  "vendor_two_direct_lookup": null
}
```

Confirms A4: the same fixture row, resurfaced against two separate
per-vendor stores, shows the recorded decision only in the store that
recorded it. The second vendor's direct `pursuitStateFor()` lookup for the
identical matter also comes back `null` -- the record never leaked across
scopes, whether read through resurfacing or directly.

## What this evidence does not claim

No production surface currently calls `resurfacePursuitState()` or
`renderPursuitStateNoteHtml()`. This card ships the pure module, its
resurfacing hook, and its tests; wiring an actual alert or listing route to
call it is left for a surface owner to pick up, per the card's own "if a
surface has no natural slot, ship the module and say so" allowance.
