# Near You subject-property local journey

Public alias: `ce239e01504c8`.

Resident journey for the retained September 14 Community Board 14 hearing:
the Flatbush-area neighborhood (`nta2020:BK1402`) and address search for
461 Coney Island Avenue reach the meeting with an **About 461 Coney Island
Avenue** explanation, while the meeting detail keeps **1625 Ocean Avenue** as
the venue and exposes a stable `#agenda-subject` anchor.

## Verify

```bash
node --test test/near_you_subject_property_journey.test.mjs
```

## Production capture

```bash
python3 tools/capture_near_you_subject_property_journey.py --host
python3 tools/capture_near_you_subject_property_journey.py --check
```

The capture refuses to run until the served `/artifact-manifest.json`
`source_commit_sha` contains the delivery commit. Screenshot binaries stay
under the local task scratch directory; only `capture-manifest.json` is
committed.
