# Site module map

Start here for JavaScript work on the main site. Read the named module and `core.mjs` only when the task uses shared network, formatting, or tab helpers; do not load every module by default.

| Module | Owns / read for |
|---|---|
| `site/app/main.mjs` | Ordered module loading; read for boot-order or module-registration changes. |
| `site/app/core.mjs` | API clients, shared formatting, skeletons, tabs, and common DOM helpers. |
| `site/app/money-list.mjs` | Money-list queries, filters, rows, selection, and lineage badges. |
| `site/app/money-history.mjs` | Notice-detail shell, prior cycles, external awards, paper trail, and response actions. |
| `site/app/search-share.mjs` | Natural-language search, suggestions, share/export/print actions, and search-state rendering. |
| `site/app/people.mjs` | Staffing feed, civil-service exam guide/detail, roles, and personnel search. |
| `site/app/land.mjs` | Land search/detail/map, ZAP outcomes, ULURP timeline, and notice-to-ZAP joins. |
| `site/app/feed-actions.mjs` | Shared Property/Rules/Meetings loading, hearing explorer, and notice/land action rails. |
| `site/app/property.mjs` | Franchise and property-disposition spines, surplus-buyer commercial glance, property explorer, and tax-lien context. |
| `site/property_commercial.mjs` | Pure Property commercial extraction (item/qty/price/deal/participation) for list + detail. |
| `site/solicitation_procurement_method.mjs` | Pure solicitation method extract (§6-129 / NCSP / accelerated / response floor). |
| `site/mwbe_goal_surface.mjs` | Pure solicitation M/WBE / method chips over procurement_method (list + notice detail). |
| `site/app/rules.mjs` | Rules explorer, rulemaking phase spine, rule actions, and generic feed-card rendering. |
| `site/app/alerts.mjs` | Watch state, digest preview/items, rollups/preferences, flags, and address/context hydration. |
| `site/app/procurement-lifecycle.mjs` | Contract-lifecycle stages, sources, documents, payment state, and lifecycle cards. |
| `site/app/procurement-phase.mjs` | Procurement phase grouping, stepper, dollars panel, lifecycle loading, M/WBE solicitation detail, and prime sub-outreach mount. |
| `site/sub_outreach.mjs` | Pure prime-win sub-outreach view + HTML from `award_prime_goal` (facts only; no goal-gap apology). |
| `site/app/subsidy.mjs` | Subsidy eligibility, phase timeline, facts, gaps, and lifecycle loading. |
| `site/app/authority-award.mjs` | Receipt-gated ABO award detail on eligible authority notices. |
| `site/app/meetings.mjs` | Meeting outcomes, roll calls, matter phase spine, and outcome loading. |
| `site/app/entities.mjs` | Official, agency, and vendor profiles; vendor phase timeline and forecasts. |
| `site/app/workspace.mjs` | Investigation storage/sync/share and matter timeline. |
| `site/app/map.mjs` | District choropleth map exploration (borough → CD → council), precomputed activity density, and area feed deep links. |
| `site/app/routing.mjs` | Permalinks, URL/filter state, route history, and item-route dispatch. |
| `site/app/boot.mjs` | Event wiring, initial loads, language repaint, alert quiz, and session boot. |

Source-extraction tests use `test/helpers/site_source.mjs`, which reads this module set in runtime order without rebuilding a monolith.
