# Public guide: article map

This is the bounded map behind a public `/guide/` covering four different reader
needs — guided practice, doing your own task, understanding a concept, and
looking something up while working. It fixes eighteen articles, one primary
documentation type each, and the example each one is taught with, so the first
release can be written and shipped without a complete feature census first.

The framework the four types come from is documented publicly at
<https://diataxis.fr/start-here/>. Readers are never asked to learn it: the
reader-facing labels are **Start here**, **How to…**, **Understand**, and
**Reference**.

## How to read this map

- **Type** is the single primary type. An article that would need two is split
  or its second job becomes a link.
- **Reader question** is the one question the article answers. If an article
  cannot be reduced to one, it is not ready to write.
- **Entry point** is the product route a reader arrives from or is sent back to.
- **Related existing content** names the file that already owns the material,
  so the article links or extracts rather than creating a competing truth.
- **Examples** are the seed ids whose verification records are in
  [`example-selection-records.md`](example-selection-records.md).

Proposed URLs use one path segment per reader-facing section, so a section is
itself a stable destination: `/guide/start/`, `/guide/how-to/`,
`/guide/understand/`, `/guide/reference/`.

## Start here — tutorials

| ID | Proposed URL | Reader question | Entry point | Related existing content (owner) | Examples |
| --- | --- | --- | --- | --- | --- |
| T1 | `/guide/start/explore-housing-across-city-records/` | "I want to learn how this works — where do I begin?" | Homepage topic search, then `/search/?q=housing` | `README.md` "Examples"; `site/index.html` search entry | X1 |
| T2 | `/guide/start/trace-a-notice-to-the-duty-behind-it/` | "How do I get from a published notice to the law that required it?" | `/notices/20260605008` | `site/mandate_document.mjs`; `site/notice_land_spine.mjs` | X2 |
| T3 | `/guide/start/trace-an-award-and-keep-the-trail/` | "How do I follow an agency to a vendor to an award, and keep that path?" | Encoded walk resolved from `site/demo/demo-links.json` | `site/graph_edge_provenance.mjs`; `docs/civic-graph.md` | X5 |

## How to… — how-to guides

| ID | Proposed URL | Reader question | Entry point | Related existing content (owner) | Examples |
| --- | --- | --- | --- | --- | --- |
| H1 | `/guide/how-to/find-and-narrow-records/` | "How do I find records about my topic and narrow them down?" | `/search/`, `/browse/` | `site/browse_surface_contracts.mjs`; `site/scope_v0.mjs` | X1, X8 |
| H2 | `/guide/how-to/follow-a-search/` | "How do I get told when new records match what I care about?" | `/following/` → Create a watch | `site/app/following.mjs`; `site/scope_v0.mjs` | X1 |
| H3 | `/guide/how-to/follow-a-community-board/` | "How do I watch what happens at my community board?" | `/following/` → Create a watch → Choose a Community Board watch | `site/community_board_watch.mjs` | X7 |
| H4 | `/guide/how-to/put-dates-in-your-calendar/` | "How do I get these dates into my own calendar?" | `/now/` | `site/calendar_subscription.mjs`; `docs/calendar-contract.md` | X9 |
| H5 | `/guide/how-to/read-a-land-use-projects-next-step/` | "What happens next on this project, and where are its documents?" | `/browse/zoning/` | `site/land_project_route.mjs`; `site/land_project_decision_relations.mjs` | X10 |
| H6 | `/guide/how-to/check-the-evidence-behind-a-connection/` | "Why does this say two records are connected?" | Agency page claim permalink | `site/graph_edge_provenance.mjs` | X3 |
| H7 | `/guide/how-to/look-at-records-as-of-a-day/` | "What did an agency's record set look like on a given day?" | Agency page as-of control | `site/civic_time_ledger.mjs` | X4, X6 |
| H8 | `/guide/how-to/collect-records-and-export-them/` | "How do I keep a set of records together and take them with me?" | Pin control on a record, then `/#investigation` | `site/app/workspace.mjs`; `site/research_package.mjs` | X11 |

## Understand — explanations

| ID | Proposed URL | Reader question | Entry point | Related existing content (owner) | Examples |
| --- | --- | --- | --- | --- | --- |
| E1 | `/guide/understand/what-a-public-record-tells-you/` | "Does this record mean the city decided something?" | Linked from any record detail | `site/public_input_explainer.mjs`; `site/consequence_projection.mjs` | X2, X8 |
| E2 | `/guide/understand/how-records-are-connected/` | "What does a connection between two records actually claim?" | Linked from the connection inspector | `site/graph_edge_provenance.mjs`; `docs/civic-graph.md` | X3, X5 |
| E3 | `/guide/understand/dates-and-missing-information/` | "Why is this blank, and which date am I looking at?" | Linked from any empty or dated field | `site/data/gap_taxonomy.json`; `docs/gap-taxonomy.md`; `site/civic_time_ledger.mjs` | X4, X8 |
| E4 | `/guide/understand/flags-and-historical-patterns/` | "What does this flag mean, and how far can I trust it?" | Linked from a flag or prediction | `site/about.html` (`#context`, `#past-patterns`, and the four formula anchors); `docs/formulas/` | X6 |

## Reference

| ID | Proposed URL | Reader question | Entry point | Related existing content (owner) | Examples |
| --- | --- | --- | --- | --- | --- |
| R1 | `/guide/reference/glossary/` | "What does this term mean?" | First unfamiliar term in any article | No existing owner — the glossary is new, and takes its terms from the journeys above rather than from a general vocabulary | X2, X7, X8 |
| R2 | `/guide/reference/controls-and-outputs/` | "What can this control do, and what do I get back?" | Any lens toolbar or watch control | `site/api.html` keeps the machine parameter inventory; this page covers the reader-facing controls only | X4, X9, X11 |
| R3 | `/guide/reference/sources-and-coverage/` | "Where does this come from, and what is covered?" | Source line on any record | `site/data/source_contracts.json` is the registry; `docs/data-sources.md` is its generated view; `site/source_health_public_projection.mjs` owns the public health projection | X1, X6 |

## Ownership boundaries this map assumes

- Machine parameter inventories stay with the API page. R2 documents what a
  reader can operate, not what a client can send.
- The source registry stays authoritative. R3 derives any displayed inventory
  from `site/data/source_contracts.json` (63 contracts at the revision recorded
  in [`capture-manifest.json`](capture-manifest.json)) rather than
  hand-maintaining a second list.
- Formula detail stays where it is. E4 explains meaning and limits in plain
  language and links the existing formula documents; it does not copy
  thresholds, pools, or coefficients into a second place. About keeps the
  cited anchors (`#context`, `#past-patterns`, and the four formula ids) as
  short summaries that point at E4, so an old fragment still resolves.
- Two pages named by the earlier inspection have already moved and must not be
  linked as if they still hold content: `site/standards.html` now forwards to
  `site/about.html#accessibility`, and `site/data.html` now forwards to
  `site/api.html#upstream`.

## Entry-point gap the first release inherits

The captured homepage carries no guide link, because none exists yet. Adding
one is part of shipping the guide home, and the wider contextual placement —
links beside Following, the calendar handoff, the connection inspector, the
as-of control, and the empty collection state — is a later step that depends on
these articles existing first.

## Later

Inventory stops here. These are recorded so they are not lost, and are
deliberately **not** worked up into article requirements:

- A guided walk through the place-first surface (`/near-you/`), which the
  captured baseline shows is by far the largest entry point by rendered content
  and probably deserves its own tutorial rather than a paragraph inside H1.
- A how-to for the exam and staffing journey beyond the single filing-window
  example, including what an expired window means for a reader who still wants
  the record.
- A how-to for the shared read-only snapshot and the frozen research package,
  which H8 will touch but not cover in full.
- An explanation of how a place is matched to a record, which E2 will gesture at
  when it explains why a plausible relationship can remain unlinked.
- A reference page for feeds and subscriptions as readers encounter them, which
  overlaps the API page enough to need an ownership decision before it is
  written.
