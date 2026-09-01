# Open question: the parity-era Land browse default

**Status:** open · decided by the site owner · not decided in implementation code.

## What is already decided

Land browse carries `view=list|map` as presentation state beside its existing
filter keys. `site/land_view_state.mjs` owns the contract:

- `list` and `map` are the only two values that change presentation.
- An absent, empty, repeated-then-unknown, or unrecognized value resolves to
  `LAND_DEFAULT_VIEW`, which is `list` today. A legacy Land link without `view`
  therefore paints exactly the List it has always painted.
- The default view is omitted from the serialized route, so a List route is
  byte-identical to the legacy route a resident already bookmarked.
- `view` is never a Land facet and never a Land watch filter field.
  `site/scope_v0.mjs` drops it for the Land surface, so a Land watch describes
  the civic filter and never a viewport, tile state, or renderer selection.
- A Map that cannot paint falls back to List with the same filtered population
  and the same semantic filters. Nothing about the resident's scope changes.

## What is not decided

The Land Map View census records the site owner's question and does not answer
it: **after measured List/Map parity, should Land browse default to Map, and
how would a resident return to List?**

Flipping `LAND_DEFAULT_VIEW` is not a local edit. It changes what every existing
bare Land link means, because the default is the value the route omits:

| Link | Today (`LAND_DEFAULT_VIEW = "list"`) | If the default became `map` |
| --- | --- | --- |
| `#land?boro=Queens` | List | Map |
| `#land?boro=Queens&view=list` | List | List, and `view=list` now serializes |
| `#land?boro=Queens&view=map` | Map | Map, and `view=map` stops serializing |

In every row the semantic scope is identical; only presentation moves. That is
the property that makes the question safe to leave open — but it is also why the
answer belongs to the site owner rather than to whichever card next touches the
renderer.

## What a decision needs

1. A measured parity receipt: the same filtered population, the same counts, and
   the same unmapped rows visible in both renderers.
2. An explicit answer on the return path to List, including whether a resident's
   choice should be remembered and, if so, where.
3. A migration statement for existing bare links and saved watches. Watches are
   unaffected by construction — they carry no `view` — but shared links are not.

Until all three land, `LAND_DEFAULT_VIEW` stays `list` and
`LAND_VIEW_DEFAULT_QUESTION.status` in `site/land_view_state.mjs` stays `open`.
`test/land_view_state.test.mjs` asserts both, so a later change cannot decide
this question quietly.
