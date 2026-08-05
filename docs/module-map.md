# Site module map

Start here for JavaScript work on the main site. Read the named module and `core.mjs` only when the task uses shared network, formatting, or tab helpers; do not load every module by default.

| Module | Owns / read for |
|---|---|
| `site/app/main.mjs` | Ordered module loading and the route-activation registry; read for boot-order or module-registration changes. Property is fetched for Property/notice routes, not the default Money landing. |
| `site/app/core.mjs` | API clients, shared formatting, skeletons, tabs, and common DOM helpers. |
| `site/scope_v0.mjs` | Pure scope v0 narrow-waist adapter across routes, filters, map/Now state, presets, sharing, watches, and the Near-you GET encoding; owns no mutable state. `scope_now_adapter.mjs` keeps the Now matcher on that surface's lazy graph; `near_you_scope.mjs` adds place mutation and GET parsing for the static/edge renderer. |
| `site/app/money-list.mjs` | Money-list queries, filters, rows, selection, and lineage badges. |
| `site/app/money-history.mjs` | Notice-detail shell, prior cycles, external awards, paper trail, and response actions. |
| `site/app/search-share.mjs` | Natural-language search, suggestions, share/export/print actions, and search-state rendering. |
| `site/app/people.mjs` | Staffing feed, civil-service exam guide/detail, roles, and personnel search. |
| `site/app/land.mjs` | Land search/detail/map, ZAP outcomes, ULURP timeline, and notice-to-ZAP joins. |
| `site/app/feed-actions.mjs` | Shared Property/Rules/Meetings loading, stamped district-bag filtering, hearing explorer, and notice/land action rails. |
| `site/app/result-match.mjs` | Shared list and digest match evidence plus digest-item presentation used by reading routes without loading watch management. |
| `site/app/notice-context.mjs` | Notice-detail context, attachment, parcel, and external-award hydration shared by reading routes. |
| `site/franchise_notice.mjs` | Route-independent franchise eligibility and stage classification shared by the Money action rail and Property renderer. |
| `site/action_outcome_prompt.mjs` | Optional post-handoff/passed-action self-report UI over the registered outcome vocabulary; aggregate analytics only, with no matter identifier or free text. |
| `site/app/property.mjs` | Franchise and property-disposition spines, surplus-buyer commercial glance, property explorer, and tax-lien context. |
| `site/property_commercial.mjs` | Pure Property commercial extraction (item/qty/price/deal/participation) for list + detail. |
| `site/property_timed_events.mjs` | Pure typed Property hearing, auction, sale, showing, bid, accommodation, objection/comment, and result date extraction with exact source spans and temporal bands. |
| `site/property_plain_summary.mjs` | Receipt-gated Property plain-language templates, faithful jargon definitions, honest original-text fallback, and progressive-disclosure summary markup. |
| `site/solicitation_procurement_method.mjs` | Pure solicitation method extract (§6-129 / NCSP / accelerated / response floor). |
| `site/mwbe_goal_surface.mjs` | Pure solicitation M/WBE / method chips over procurement_method (list + notice detail). |
| `site/app/rules.mjs` | Rules explorer, rulemaking phase spine, rule actions, and generic feed-card rendering. |
| `site/map_exploration.mjs` | Pure map geometry, canonical scope drill hashes, and exact all-lens request-ID membership from `district_activity.district_items`. |
| `site/near_you_view.mjs` | Shared static/edge Near-you view model and HTML renderer over versioned scope, district activity, and boundaries. |
| `site/following_view.mjs` | Shared static/edge Following view model and HTML renderer. The saved scope drives the summary, count, preview, and subscription form. |
| `site/app/following.mjs` | Following-only personal island plus preview, duplicate-warning, and submission enhancements. Public reading and forms do not depend on it. |
| `site/app/alerts.mjs` | Legacy hash-route watch UI retained for source characterization only; it is not in the home loader graph. |
| `site/app/procurement-lifecycle.mjs` | Contract-lifecycle stages, sources, documents, payment state, and lifecycle cards. |
| `site/app/procurement-phase.mjs` | Procurement phase grouping, stepper, dollars panel, lifecycle loading, M/WBE solicitation detail, and prime sub-outreach mount. |
| `site/procurement_planning_surface.mjs` | Pure receipt-gated MOCS plan-row joins that add the optional Money planning phase; an absent or edge-empty payload is inert. |
| `site/sub_outreach.mjs` | Pure prime-win sub-outreach view + HTML from `award_prime_goal` (facts only; no goal-gap apology). |
| `site/app/subsidy.mjs` | Subsidy eligibility, phase timeline, facts, gaps, and lifecycle loading. |
| `site/app/authority-award.mjs` | Receipt-gated ABO award detail on eligible authority notices. |
| `site/non_council_outcome_panel.mjs` | Pure receipt-gated community-board decision view, static lookup loader, and notice-panel HTML. |
| `site/app/meetings.mjs` | Meeting outcomes, roll calls, matter phase spine, receipt-backed community-board decisions, and outcome loading. |
| `site/app/entities.mjs` | Official, agency, and vendor profiles; vendor phase timeline and forecasts. |
| `site/app/workspace.mjs` | Investigation storage/sync/share and matter timeline. |
| `site/app/map.mjs` | Route-only Near-you island: adopts the server SVG/list for pan, zoom, drill-down, geolocation, and focus sync; it is not part of the home loader. |
| `site/app/now.mjs` | Tiny route-lazy `#now` entry shim; keeps the Now renderer and its read models off the home cold path. |
| `site/now_view.mjs` | Additive Now loader and renderer; compiles existing read models into Act by and Happening soon without owning lens navigation. |
| `site/now_surface.mjs` | Pure cross-domain Now compiler, temporal ordering, source coverage, and opaque future-scope predicate seam. |
| `site/app/routing.mjs` | Permalinks, URL/filter state, route history, and item-route dispatch. |
| `site/app/boot.mjs` | Event wiring, initial loads, language repaint, alert quiz, and session boot. |

Source-extraction tests use `test/helpers/site_source.mjs`, which reads this module set in runtime order without rebuilding a monolith.
