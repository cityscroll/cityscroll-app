# CC-7 correction round-trip pilot

This is a bounded, fixture-backed exercise of the challengeable-claims seam. It
does not claim that equivalent records elsewhere are correct or challengeable.
The machine-readable record is [pilot.json](pilot.json), and the screenshots
are generated from that same replay.

## Result

| Case | Seeded error | Failure origin | Adjudication | Source-of-truth change | Visible result |
| --- | --- | --- | --- | --- | --- |
| CC7-IDENTITY-001 | Wrong identity | Entity resolution | Confirmed | `canonical_entity_ref` changed from `entity:official:cc7-1001` to `entity:official:cc7-1002` | Yes |
| CC7-RELATIONSHIP-001 | Wrong contract → vendor connection | Joining | Confirmed | `vendor_ref` changed from Northstar Works to Harbor Maintenance | Yes |
| CC7-GROUPING-001 | Two notices grouped as one hearing | Derived interpretation | Confirmed | `grouping_mode` changed from `one_meeting` to `separate_notices` | Yes |
| CC7-MISSING-001 | Missing Community Board host relationship | Ingestion | Confirmed | `host_board_ref` populated with Manhattan Community Board 6 | Yes |
| CC7-NEGATIVE-INSUFFICIENT-EVIDENCE-001 | Same grouping challenge without source evidence | Derived interpretation | Unresolved | No change applied | No; assertion remains visible |

Each confirmed case begins with the assertion and attached provenance, submits a
structured payload through the exact `POST /feedback` route shape, records the
adjudication evidence and decision, applies a guarded change only to the named
pilot source-of-truth envelope, and reprojects the visible result. The replay
does not call the production endpoint or send email.

## Before and after captures

Desktop captures are 1440px wide; mobile captures are 390px wide.

| Case | Before | After |
| --- | --- | --- |
| Identity | [desktop](backstage://cityscroll-evidence/objects/sha256/31/314638a3b762038f84aad39ca0077c2826d6add99ed6cc118ad87e3c79f5f3bd.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/29/29e06a5c5fdd55b3062f042e415376ef40149b8a1f2b228398ba6121824409b9.webp) | [desktop](backstage://cityscroll-evidence/objects/sha256/70/70676211c718ec25057f1f3c723ac0369120bbab77c669eca3d921e8ea5aac5c.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/22/22b149d78f5c9f011283a9522903e9646ca76ea11f3944cf04f7d74a19ef78fe.webp) |
| Relationship | [desktop](backstage://cityscroll-evidence/objects/sha256/4f/4fc470c3747405a36b54abd7a67543e3da8353f2d5c95ac5b34c7c9f37352cda.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/47/47f9212577b1d3b1f32d9febaaf99226c88b4483fe4c721323065ae6b565ab70.webp) | [desktop](backstage://cityscroll-evidence/objects/sha256/19/19cb304a3f97dfea31c1e09060bd6516de81cd0af39c2e25e6ec4e998056ac1c.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/05/051abe1584926dae56874d232e9c15e297a510a9df07acf520de72f81b36dc08.webp) |
| Grouping | [desktop](backstage://cityscroll-evidence/objects/sha256/32/323083780d7680b537eec883c0c25dfc662aa98b50b9dd6f0b4b007d68bd1c17.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/81/81c9c8662f71c3d7a04637ef88df867e7b8bfe040a8631d43ffafe87f51db72b.webp) | [desktop](backstage://cityscroll-evidence/objects/sha256/a9/a97e1718e5e11b865beb8d5b9d0999053f1e32c22065ffaf8b2105d18c7f3861.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/89/891e1c6494d104031082667d9275cf3791f6c94f2ef3f1cdc2b4c86055a6fe6f.webp) |
| Missing relationship | [desktop](backstage://cityscroll-evidence/objects/sha256/43/4362cfb56fbfb35ea0b2823466864493a0f1beff1e72d91468bb0d1334e90066.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/40/40baccf90052a8b9a365a9235bb36c7b996a27593a372e4e8ee0b7573b99eed0.webp) | [desktop](backstage://cityscroll-evidence/objects/sha256/b3/b311de6d9cfe331fba5f7e231ce9c7ac4cad223f26845a1ea2df8d09c429d1b2.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/8d/8dad296843c9ba9ef30482b099a070d923ebedc400a7c59c0c94f5f68668e066.webp) |
| Insufficient evidence | [desktop](backstage://cityscroll-evidence/objects/sha256/58/58e41d61b514fcb3136aceed0f553bc06c8abc50c89a4797113387d93c6fedb6.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/fa/faa476b0c1fc9ddec38d19759ba4dadab0d3c309dca09391784d1006b0ec6e29.webp) | [desktop](backstage://cityscroll-evidence/objects/sha256/cc/cc7e9be73afc2d4ccc378edbde3e70700a24707c9250ce9cef87f88dec858f14.webp) · [mobile](backstage://cityscroll-evidence/objects/sha256/96/9694150f8e8108a9df3928eef45019e0afa6e510b7c226b2c3291c16b52d5f56.webp) |

## Reproduce

From the repository root:

```bash
node tools/cc7_round_trip_pilot.mjs
python3 tools/capture_cc7_round_trip_pilot.py
node --test test/cc7_round_trip_pilot.test.mjs
```

The pilot source of truth is intentionally in-memory and scoped to the five
records above. The negative replay is important: a disagreement without source
evidence is retained as unresolved, and its visible assertion and source truth
remain unchanged. This pilot therefore demonstrates the seam and one complete
assertion → challenge → evidence → correction → visible-result path; it does
not establish universal correctness, correction coverage, adjudication capacity,
or automatic correction of equivalent records.
