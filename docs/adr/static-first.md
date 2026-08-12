# ADR: Static-first delivery

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Scope | Public site documents, committed read models, and Worker-backed enhancements |
| Supersedes | — |
| Related | `docs/architecture.md`, `docs/precompute-first-inventory-2026-07-29.md`, `warehouse/README.md` |

## Context

CityScroll presents public civic records through a static site and a Cloudflare
Worker. The product has two different freshness needs: a first paint should be
available from committed or already-materialized data, while some explicitly
interactive controls can still use a live source. A browser request that fans
out to several public APIs is harder to reproduce and can leave the page empty
when one upstream service is slow or unavailable.

The repository already distinguishes `live-only`, `edge-materialized`, and
`inline-at-build` delivery tiers. The architecture summary describes
CityScroll-owned materialized read models as the primary delivery path and says
the static shell remains deployable without the Worker.

## Decision

Use a static-first delivery model:

1. Build public documents and bounded read models before or during deployment.
2. Let the static site provide the initial document, markup, and committed
   facts without requiring the Worker.
3. Use Worker and live-source requests as bounded enhancements, freshness
   paths, or explicitly interactive operations.
4. Keep each source contract explicit about whether it is `live-only`,
   `edge-materialized`, or another delivery tier.

Static-first does not mean that every source is frozen. The precompute audit
keeps user-driven search and geocoding live where their current behavior
requires it, while routing bounded lifecycle, hearing, property, vendor, and
other views through materialized paths.

## Alternatives

- Make every browser surface live-only and query public APIs on page load.
- Make every surface a committed snapshot and remove live enhancement paths.
- Put all reads behind the Worker and make the static site a shell only.

## Rationale

The repository records the operational reasons for this decision: the static
shell is deployable without the Worker, public browser routes are intended to
use reproducible materialized views, and the warehouse is explicitly a
batch-data factory rather than an edge query engine. Those reasons are visible
in `docs/architecture.md`, the precompute inventory, and `warehouse/README.md`.

The historical discussion that selected this exact boundary over the listed
alternatives is not recorded in the repository: rationale required.

## Consequences

- First paint and ordinary reads can survive a Worker or upstream failure.
- Builders, snapshots, and source contracts become part of the product
  surface and must be kept current.
- Freshness is explicit rather than assumed; a live-only path remains a
  deliberate exception.
- The site must preserve honest fallback behavior when a materialized view is
  stale, missing, or unavailable.

## Evidence

- `docs/architecture.md` — summary and data-store sections define
  materialized read models as the primary path and the static shell as
  deployable without the Worker.
- `docs/precompute-first-inventory-2026-07-29.md` — records the delivery-tier
  vocabulary and the live versus edge-materialized boundary.
- `warehouse/README.md` — states that public browser routes are precompute-first
  and that the warehouse is the factory while the Worker is the shop window.
- `site/data/source_contracts.json` — committed source contracts carry delivery
  tiers and freshness policies.
