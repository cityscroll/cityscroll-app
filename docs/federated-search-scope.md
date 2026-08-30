# Federated search scope contract

`search.federated@1` remains the owner of civic SearchDocument identity,
ranking, provenance, bounds, and coverage. Adapters may only pass a closed
allowlist of registered federation lenses. They may not rank, rewrite identity,
or filter an arbitrary store.

## Before / after

| Surface | Before (1.0.0) | After (1.1.0, still `search.federated@1`) |
| --- | --- | --- |
| Input schema | `query`, `limit` | Additive `scope` mapped only to registered lenses |
| Omitted scope | Implicit all-lens federation | Unchanged: all registered lenses, including auxiliary legal-code recall |
| Allowlisted scope | Not represented | `{ schema, lenses: [...] }` or a registered-lens string/array shorthand |
| Unknown / store / SQL scope | Extra fields already rejected | Unknown lens ids and arbitrary scope fields fail closed |
| Coverage | `matched`, `empty`, `partial`, `stale`, `not_indexed`, `provider_unavailable` | Same states for requested lenses; unrequested lenses are `out_of_scope` |
| Requested-scope receipt | Absent | `requested_scope` enumerates every registered lens with `requested` plus the coverage state |

## Allowlist mapping

Registered federation lenses (the only legal `scope.lenses` values):

`notices`, `people`, `agencies`, `vendors`, `committees`, `community_boards`,
`exams`, `parcels`, `land`, `meetings`

These are not presentation lanes. `contracts` and `people-organizations` stay
HTTP projection groups over the federated envelope and are rejected as scope.
Auxiliary `legal_code` recall remains unscoped-only; it is not in the allowlist.

HTTP `GET /search?q=` omits scope and keeps the existing all-lens route.
Optional `scope=` repeats or comma-separates registered lens ids. MCP
`search_federated` accepts the same versioned `scope` object. Worker and
fixture adapters call `executeFederatedSearch` and must not call a lens or
store directly.

Frozen examples live in `test/fixtures/federated_search_scope/`.
