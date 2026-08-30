# Person representation inventory

Status: reviewable architecture inventory. This file does not migrate identities,
does not create a public generic person object, and does not treat display-name
equality as same-human proof.

Same-human proof vocabulary used here:

- **exact** — a publisher native key is retained and compared as an identifier.
- **reviewed** — an explicit evidence-bearing assertion is required before a
  canonical person reference may be populated.
- **unknown** — no join is claimed; missing proof stays awaiting implementation.

The additive envelope `cityscroll.person.v1` (`ontology/person.mjs`) is not a
listed source representation. It is the existing wrapper around those
representations. See `docs/adr/person-source-identity-seam.md`.

## 1. `official`

| Field | Record |
| --- | --- |
| Source authority | NYC Council Legistar person/vote rows (`VotePersonId` / `PersonId`). Registry backing `legistar_votes`. |
| Source-local identifier | Numeric Legistar `PersonId`. Public id `official:{person_id}`. |
| Exact vs name-only | Exact when PersonId is present. Helper `officialEntityId` can mint `official:name:…` if a name is supplied with no id (`entity_resolution/officials/index.mjs:69-74`); person hub and People search refuse that fallback (`site/person_hub.mjs:35-36`, `site/people_search_producer.mjs:58-61,149-151`). The name fallback is not a production Council identity. |
| Roles / tenure | Council member terms live on the person hub, not on this id mint. Committee membership is `member_of` from `official:{PersonId}` to `committee:{BodyId}` (`site/committee_graph.mjs`, `site/committee_memberships.mjs:42`). Votes are `votes_on` (`ontology/registry.v0.json` `votes_on`). |
| Routes | Canonical `/officials/{PersonId}/` (`site/_routes.json:14`, `site/pages_edge.mjs:208`, `site/app/entities.mjs:297-314`). Compatibility `#official/{id}` → `/officials/{id}/` (`tools/build_url_migration_map.mjs`). |
| Search producers | `site/people_search_producer.mjs` over the person hub. Indexed documents use `object_type: "person"` and `object_ref: person:{PersonId}` while `canonical_href` stays `/officials/{id}/` (`site/people_search_producer.mjs:160-166`). That search `person:` token is **not** the generic envelope `person:legistar:{id}`. |
| Downstream assumptions | Council votes, committee memberships, lobbying, campaign finance, and the official profile remain Council-only (`ontology/person.mjs:36-42,326-339`; `test/person_ontology.test.mjs:130-158`). Land historical actors resolve only exact `official:{PersonId}` from hub `terms[]`, never `current_term` (`worker/src/lib/land_prediction_actor_resolution.mjs:1-6,320`). |
| Same-human proof | Exact PersonId within Council/Legistar. Cross-source same-human with Community Board, payroll, staffing, or agency-head records: **unknown** (awaiting reviewed `person_identity_link.v1`). Influence joins (lobby/CFB) use exact unique name keys onto an already-identified hub person; they do not mint identity (`site/official_influence.mjs:4-6,48-68`; `entity_resolution/officials/person_name.mjs:89-101`). |

Authoritative files: `entity_resolution/officials/index.mjs`, `ontology/registry.v0.json` object `official`, `site/app/entities.mjs`, `test/official_entity_family.test.mjs`.

## 2. Council person hub

| Field | Record |
| --- | --- |
| Source authority | NYC Open Data Council Members `uvw5-9znb` (`site/person_hub.mjs:15,134-138`). Builder `tools/build_person_hub.mjs`. |
| Source-local identifier | `council_member_id` equals Legistar PersonId (`site/person_hub.mjs:3,35-42`). Lookup key `by_person_id`. Committed artifact `site/data/person_hub_lookup.json` (`person_count` 215 at inspection, `gate.promoted` true). |
| Exact vs name-only | Identity is numeric PersonId. Display names and `name_keys` are retrieval/join helpers, not identity (`site/person_hub.mjs:78-91`). |
| Roles / tenure | `terms[]` with `term_start`, `term_end`, `office_id`, `district`. `current_term` is a convenience stamp and must not be used as a historical fallback (`site/person_hub.mjs:60-77`; `worker/src/lib/land_prediction_actor_resolution.mjs:1-6`). |
| Routes | Feeds `/officials/{id}/` via `personHubForId`. No separate hub route. |
| Search producers | Sole Council-people producer (`site/people_search_producer.mjs:1-5`; keyword family `people` in `tools/build_keyword_search_index.mjs:187-191`). |
| Downstream assumptions | Official profiles, People + organizations `official` rows, exact Council-term rows, influence edges, and land actor resolution all assume this PersonId. |
| Same-human proof | Exact PersonId vs Legistar votes (`site/person_hub.mjs:95-123`, “precision is 1.0 by construction” for that join). Same-human with other source families: **unknown**. |

Authoritative files: `site/person_hub.mjs`, `tools/build_person_hub.mjs`, `site/data/person_hub_lookup.json`, `test/person_hub.test.mjs`.

## 3. `person-leader`

| Field | Record |
| --- | --- |
| Source authority | NYC agency roster / OTI crosswalk `t3jq-9nkf` via `worker/src/data/agency_crosswalk.json` (`tools/build_agency_crosswalk.mjs:96-97`; `worker/src/agency.mjs:49`). |
| Source-local identifier | `person-leader:{agency_id}:{person_id\|name}` (`entity_resolution/leaders/index.mjs:12,58-63`). Production materialization uses the name branch (`person-leader:police-department:name:jessica%20tisch` in `test/person_leader_referents.test.mjs:20-23`) because the crosswalk supplies `head_name`, not a PersonId. |
| Exact vs name-only | Agency-scoped publisher name for the current principal officer. Not a general person id. Unscoped role mentions fail closed (`test/person_leader_referents.test.mjs:41-52`). |
| Roles / tenure | Current `head_title` only. No tenure interval on the entity. |
| Routes | No `/officials/` or generic person route. Agency profile “led by” links to `/agencies/{agency_id}/` with `data-entity-ref` of the leader id (`site/app/money-history.mjs:365-369`). |
| Search producers | None as a person SearchDocument. Agency search remains the agency object. |
| Downstream assumptions | Agency identity HTML and public relationship graph (`entity_resolution/publication/relationship_graph.mjs:32,50,242-243`) treat this as an agency-head entity, not a Council official. |
| Same-human proof | Exact publisher head name **within one agency**. Same-human with `official:{PersonId}` or Community Board people: **unknown**. |

Authoritative files: `entity_resolution/leaders/index.mjs`, `worker/src/agency.mjs`, `test/person_leader_referents.test.mjs`, `ontology/registry.v0.json` object `person-leader`.

## 4. Council terms currently labelled appointments

| Field | Record |
| --- | --- |
| Source authority | Person-hub `terms[]` from `uvw5-9znb`. |
| Source-local identifier | Row kind `exact-person-appointment`, id `appointment:{personId}:{officeId}:{term_start}` (`site/people_organizations_read_model.mjs:120-154`). Person identity is the same Legistar PersonId as `official`. |
| Exact vs name-only | Exact PersonId plus office id plus term start. Rows without those keys are omitted (`site/people_organizations_read_model.mjs:133-135`). |
| Roles / tenure | City Council term, optional district. Machine kind still says “appointment”; reader copy is “City Council term” (`site/browse_concept_view.mjs:186,228,342`; `site/people_organizations_surface.mjs:22,33`). |
| Routes | `/officials/{personId}/` (`site/people_organizations_read_model.mjs:140`). |
| Search producers | Indexed only as search text on the official/hub person, not as a separate object type. |
| Downstream assumptions | `/browse/people/` lists these as City Council terms, not civil-service appointments (`test/browse_concept_view.test.mjs:127-137`). |
| Same-human proof | Exact PersonId (same as `official`). Not a civil-service appointment identity. |

Authoritative files: `site/people_organizations_read_model.mjs`, `site/browse_concept_view.mjs`, `test/browse_concept_view.test.mjs`.

## 5. City Record staffing hires

| Field | Record |
| --- | --- |
| Source authority | City Record Online Changes in Personnel, short title `APPOINTED`, dataset `dg92-zbpx` (`site/data/staffing_default_hires.json:5-16`). Independent Staffing surface: `/browse/staffing/` (`site/browse_surface_contracts.mjs:23-32`). |
| Source-local identifier | Notice `request_id`. People + organizations row kind `notice-only-hire`, id `hire:{request_id}` (`site/people_organizations_read_model.mjs:166-189`). |
| Exact vs name-only | Display name is parsed from notice body field `Employee Name`. `person_id` is always `null`; `entity_ref` is `null`; `relation_state` is `unknown` (`site/people_organizations_read_model.mjs:177-179`). A notice whose employee name resembles a Council member is still not joined (`test/browse_concept_view.test.mjs:132-141`). |
| Roles / tenure | Agency name, title code, effective date from the notice. Not a Council term. |
| Routes | `/notices/{request_id}` only. |
| Search producers | Not a People SearchDocument. Staffing browse is a separate surface. |
| Downstream assumptions | Names in City Record notices are publication evidence, not person identity. Do not feed payroll employee rows through this path. |
| Same-human proof | **unknown**. Awaiting implementation of an exact or reviewed join; name resemblance is not proof. |

Authoritative files: `site/people_organizations_read_model.mjs:157-189`, `site/data/staffing_default_hires.json`, `site/browse_surface_contracts.mjs`, `test/browse_concept_view.test.mjs`.

## 6. Payroll identities

Payroll in this product is **board/agency identity**, not a natural-person identity.

| Field | Record |
| --- | --- |
| Source authority | Citywide Payroll `k397-673e` (`site/data/source_contracts.json:870-888`). Product freshness: title mart and board staff counts; “Individual employee rows are never served.” |
| Source-local identifier | `payroll_number` bound to `community-board:{borough-cb-NN}` after exact `agency_name` corroboration (`site/community_board_payroll_identity.mjs:1-8,49-53,64-71,123-139`). Staff-count artifact `site/data/community_board_payroll_staff_count.json`. Title mart `site/data/payroll_title_warehouse_lookup.json` (`pii.employee_rows: false`). |
| Exact vs name-only | Exact payroll number plus exact publisher agency label. Geography and similar names are not identity (`site/community_board_payroll_identity.mjs:59-63,136-139`; `test/community_board_payroll_identity.test.mjs`). |
| Roles / tenure | ACTIVE-row staff **counts** per board. Dollars and title mix withheld under the five-row suppression floor (`site/data/community_board_payroll_staff_count.json:18-24`; `site/community_board_payroll_identity.mjs:16-31`). |
| Routes | None for employees. Board money/staff counts attach to Community Board documents, not people routes. |
| Search producers | None for employees. Title-mart counts feed People/Staffing suggestions, not person SearchDocuments. |
| Downstream assumptions | Employee field names (`last_name`, `first_name`, `employee_id`, …) in a served contract are a fitness failure (`site/community_board_payroll_identity.mjs:36-45,93-115`; `test/community_board_payroll_identity.test.mjs:30-41,120-133`). |
| Same-human proof | Not applicable as a person representation. Binding is board↔payroll_number. Person-level payroll identity is **unknown** and must stay unpublished. |

Authoritative files: `site/community_board_payroll_identity.mjs`, `site/data/community_board_payroll_staff_count.json`, `site/data/payroll_title_warehouse_lookup.json`, `test/community_board_payroll_identity.test.mjs`.

## 7. Community Board roster identities

| Field | Record |
| --- | --- |
| Source authority | Board-local publisher roster/staff documents with retained receipts. Grounded artifact `site/data/community_board_people.json` (schema `cityscroll.community_board_people.v1`). At inspection: one board (`manhattan-cb-06`), five relationship rows. Other boards remain ungrounded (**awaiting implementation** of additional source collections, not inferred). |
| Source-local identifier | `community-board-person:{board_id}:{publisher_person_id\|reviewed_local_id}` (`site/community_board_relations.mjs:16,80-90`; `ontology/registry.v0.json` object `community-board-person`). Display names with spaces are rejected as ids (`test/community_board_people.test.mjs:27-31`). |
| Exact vs name-only | Exact publisher or reviewed local key, qualified by board. Same local key on two boards is two people (`test/people_organizations_community_boards.test.mjs:79-88`). Numeric keys such as `7801` stay board-local and never become `official:7801` (`test/community_board_people.test.mjs:69-77`). |
| Roles / tenure | Closed vocabulary: `appointed_member`, `board_chair`, `board_officer`, `committee_chair`, `committee_member`, `public_committee_member`, `district_manager`, `staff` (`site/community_board_relations.mjs:17-27`). Edges: `member_of`, `chairs`, `staffed_by`, `works_for` with `valid_from` / `valid_to` / `observed_on` (`site/community_board_relations.mjs:321-391`). Staff and public committee participation do not establish board membership (`test/community_board_people.test.mjs:59-66`). |
| Routes | No `/officials/` route. Browse person rows set `href: null` (`site/people_organizations_read_model.mjs:365-368`). Search `canonical_href` is the parent board page (`site/community_board_people_search_producer.mjs:131`). Constellation People section uses `community-board-person` (`site/community_board_constellation.mjs:55,188`). |
| Search producers | `site/community_board_people_search_producer.mjs`, keyword family `people` alongside Council people (`tools/build_keyword_search_index.mjs:14,187-191,256`). `object_type` is `community-board-person`, not `official`. |
| Downstream assumptions | CBO-4 already shipped this contract (`cityscroll-community-board-ontology` card C4, PR 1298). Generic envelope alias is `person:community-board:{board}:{key}` (`ontology/person.mjs:226-249`; `site/community_board_constellation.mjs:187-189`). Capability allowlist: `person.identity` + `community-board.roles` only (`ontology/person.mjs:47`). |
| Same-human proof | Exact within one board+publisher key. Across boards, or vs Council/payroll/staffing: **unknown** unless a future accepted `person_identity_link.v1` exists. No accepted production links are materialized (`canonical_person_ref` is always null in `communityBoardPersonObject`, `site/community_board_relations.mjs:411-423`). |

Authoritative files: `site/community_board_relations.mjs`, `site/community_board_people.mjs`, `site/data/community_board_people.json`, `site/community_board_people_search_producer.mjs`, `test/community_board_people.test.mjs`, `test/people_organizations_community_boards.test.mjs`.

## Cross-cutting observations

1. Reader-facing “appointment” copy on `/browse/people/` is already “City Council term”; the leftover “appointment” token is the machine kind and row id prefix.
2. Keyword family `people` federates Council hub documents and Community Board person documents without merging ids (`tools/build_keyword_search_index.mjs:187-191`).
3. Search admits both `person` and `official` object types (`site/search_document_contract.mjs:26-27,59-60`). Council producer currently emits `person` with `person:{numericId}` (`site/people_search_producer.mjs:160-164`). Aligning that token with `person:legistar:{id}` is **awaiting implementation** and is not a same-human claim.
4. `/people/` appears only as a reserved SearchDocument route root (`site/search_document_contract.mjs:85`). Pages include `/officials/*` and `/browse/*`, not a generic person family (`site/_routes.json:14-20`). Registry `public_route` for object `person` is `null` (`ontology/registry.v0.json:49`; `test/person_ontology.test.mjs:45`).
5. No production `person_identity_link.v1` writer or accepted canonical person population was found. Proof remains awaiting implementation.
