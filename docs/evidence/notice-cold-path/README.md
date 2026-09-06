# Notice route cold module path

The Notice route renders one public record. Before this change it also booted
every lens list in the application, because the loader awaited each lens module
in turn on every route. This directory records what the route fetches now, what
it no longer fetches, and how the remaining chain is announced to the browser.

Measure it at any commit:

```bash
node tools/notice_cold_path.mjs           # notice, lens route, home
node tools/notice_cold_path.mjs --json    # the same report, machine-readable
node tools/notice_cold_path.mjs --check   # manifest drift + committed ceilings
```

The tool reads the boot sequence out of `site/app/main.mjs` rather than
restating it, so the loader stays the single owner of what a route loads.

## Measured at delivery

Measured with `node tools/notice_cold_path.mjs` on this change and on the
default branch it was cut from (`31bd87c0a`). "Awaited stages" counts the
loader's serial `await`ed imports; "serial request stages" counts the depth of
the request waterfall those stages produce, including the nesting each fetched
module's own imports reveal.

| Route | Modules | Transferred bytes | Awaited stages | Serial request stages |
| --- | ---: | ---: | ---: | ---: |
| Notice, before | 174 | 2,735,938 | 32 | 71 |
| Notice, after | 138 | 2,060,856 | 27 | 59 |
| Home (unchanged) | 8 | 50,134 | 3 | 6 |

The Notice cold path loads 36 fewer modules and transfers 675,082 fewer bytes,
a 20.7% and 24.7% reduction, and the waterfall it must walk is 12 stages
shallower.

## The five lens groups that left the Notice cold path

Each row is the module group named for the tab that owns it, measured as what it
adds to the Notice chain when the gate is removed. The five together account for
41 modules and 684,973 bytes.

| Lens group | Entry module | Modules | Bytes |
| --- | --- | ---: | ---: |
| Contracts | `site/app/money-list.mjs` | 20 | 261,583 |
| Land | `site/app/land.mjs` | 10 | 132,329 |
| Exams | `site/app/exams.mjs` | 4 | 84,663 |
| Staffing | `site/app/staffing.mjs` | 1 | 19,636 |
| Meetings | `site/app/meetings.mjs` | 5 | 183,054 |

Rows do not sum to the joint total: the groups share dependencies, so removing
all five frees one module and 3,708 bytes more than the rows alone.

Exams and Staffing have no notice-detail surface at all and never load on a
Notice route. The other three own a notice section that only some notices have,
and each is activated from `site/notice_lens_sections.mjs` after the record says
the section exists:

- **Contracts** — the procurement paper trail, on a notice with a usable PIN.
- **Land** — the land-project spine, on a notice the spine's own eligibility
  model covers.
- **Meetings** — the meeting-outcome panel, on a notice the outcome read model
  has a record for. The read happens first, so a notice with no hearing and no
  matched meeting never boots the lens.

A notice that does need one of these gets it through the same activation gate
the tab strip uses, which `test/notice_lens_sections.test.mjs` exercises for
both the present and absent cases, including a failed activation.

## Preload hints

`site/notice_module_preload.mjs` is generated from the real import closure and
lists every module on the chain except the entry module the document already
requests. `site/pages_edge.mjs` announces them as `<link rel="modulepreload">`
in the edge-rendered Notice document, so the browser requests the chain in
parallel instead of discovering it one import at a time.
`test/notice_cold_path.test.mjs` fails when the manifest drifts from the closure.

## Ceilings

`architecture/notice-cold-path-budget.json` holds the module, byte, and
waterfall-depth ceilings. Reintroducing a lens group the Notice route never
shows fails `node tools/notice_cold_path.mjs --check` and
`test/notice_cold_path.test.mjs`.

## Latency read-back

This change claims no latency improvement. The production read-back for the
Notice content-ready measurement is open and pending in
[`data/performance/field-rum-readiness-2026-08-26.md`](../../../data/performance/field-rum-readiness-2026-08-26.md).
