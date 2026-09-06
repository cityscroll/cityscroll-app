# Public guide: explanation and reference ownership

Seven articles were added to the guide — four under **Understand** and three under
**Reference**. Every one of them describes material that already had an owner
somewhere in this repository, and the point of this record is to say which owner,
and what each article is allowed to say about it.

The seven articles remain the meaning layer. About and the README now send readers
to them: About keeps identity, independence, team/contact, accessibility, content
policy, feedback, and the cited formula anchors; the README keeps the product
overview, public entry points, a few representative examples, and maintainer links.
The exact thresholds still live on the About anchors E4 already linked, so a
citation that pointed at `#context` or a formula id still lands on a summary of
that rule.

## The rule these articles follow

A guide article gets the **meaning**. The owner keeps the **value**.

An article may say that a flag counts how long a notice was open compared with an
agency's usual practice. It may not say what the threshold is, because the threshold
is a number that changes and a number in two places is a number that will eventually
disagree with itself. The same rule covers pools, windows, coefficients, freshness
limits, and every count of anything.

Where a value genuinely belongs on a guide page — the number of sources behind the
records — it is generated from its owner at build time rather than typed.

## Article by article

| Article | Owner it defers to | What the article says | What it must never restate |
| --- | --- | --- | --- |
| E1 · What a public record tells you | `site/public_input_explainer.mjs` and `site/consequence_projection.mjs` for participation; the official City pages those name | What each kind of record establishes, and the four different invitations to take part | The specific date, status or participation channel of any one proceeding — that stays on its listing |
| E2 · How records are connected | `site/graph_edge_provenance.mjs` | What a connection claims, the three bases it can rest on, and why one can be missing | The matching methods themselves, or any confidence score |
| E3 · What dates and blanks mean | `site/data/gap_taxonomy.json` and its generated `docs/gap-taxonomy.md`; `site/civic_time_ledger.mjs` | The four kinds of date, the four kinds of blank, and what the as-of filter does | The gap inventory, its dispositions, or any coverage percentage |
| E4 · Flags and historical patterns | `site/about.html` (`#context`, `#past-patterns` and the four formula anchors); `docs/formulas/` | What each computed note counts, and the limits of reading one | Every threshold, pool, window and coefficient. The article links each anchor instead |
| R1 · Glossary | The surfaces the terms appear on | The plain sense of a term as a reader meets it | Any definition that competes with a surface's own label |
| R2 · Controls and what they give you | `site/api.html` | What a reader can operate and the state it leaves them in | The machine parameter inventory, endpoints and feed formats — those are the API page's |
| R3 · Where the records come from | `site/data/source_contracts.json`, its generated `docs/data-sources.md`, and `site/source_health_public_projection.mjs` | Which publishers the records come from, how often they change, and what coverage does not mean | Per-source freshness, health or coverage. The one inventory shown is generated from the registry |

## The generated inventory

`site/guide_source_coverage.mjs` reads the source registry and returns one table:
how many public sources there are, grouped by how often each refreshes. R3 places it
with a `::: source-coverage` line and the builder fills it in.

Three properties make it safe to publish:

- It is a pure function of `site/data/source_contracts.json`, so it cannot describe a
  set of sources the product does not read.
- Sources the registry marks backstage are excluded, because a reader cannot reach
  what they feed.
- A refresh mode the module has no plain-language meaning for **fails the build**.
  A new mode reaches a reader as a sentence someone wrote, or it does not reach them.

## Two pages that must not be linked as if they still hold content

- `site/standards.html` forwards to `site/about.html#accessibility`.
- `site/data.html` forwards to `site/api.html#upstream`.

The guide links `/about.html` and `/api.html` directly. It also does not link
`/data-health/`, which is built but not currently public.

## What the reference pages deliberately leave out

- **A single coverage number.** There isn't one. R3 explains the four different ways
  a source can be working and still not answer a question, and sends the reader to
  the stats page for size and period.
- **A source-by-source table.** The ledger already exists and is generated. A second
  copy on a page nobody regenerates is exactly the failure mode this record exists to
  prevent.
- **Anything about a specific record.** A reference page describes the shape of
  things. The record's own page, and its official source, hold the facts.
