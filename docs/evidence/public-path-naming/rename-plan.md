# Public path naming plan

Every tracked path in this repository is a public naming surface. The paths in the
roots below were named after a planning identifier — a registry namespace other
than the one public namespace this repository has, or a queue position — instead
of words describing what the file holds. This change renames them.

## How each new name was chosen

Each new name is derived from the file's own content, never from the grouping it
used to sit in. An architecture evidence entry takes the descriptive part of the
record it already declared, keeping its own words; a capture directory takes the
subject it captures. Where a bare descriptive tail was too generic to stand as a
repository-wide identity, a qualifier was taken from the entry's own projection
paths. Every rename is a `git mv`, so each file's history follows it.

## Scope

| Root | Paths renamed |
| --- | --- |
| `architecture/evidence.d` | 165 |
| `artifacts` | 8 |
| `data` | 2 |
| `docs/evidence` | 83 |
| **Total** | **258** |

## The rule that keeps them named this way

`tools/public_identity_contract.mjs` states the naming rule as a positive shape:
an evidence registry file names the one public namespace, and no path segment in
a public evidence root is a short abbreviation followed by an ordinal. It carries
no list of names to keep out, for the same reason `tools/check_stale_repo_name.mjs`
keeps its own denylist outside this repository: a committed list of forbidden
names publishes the names.

`test/public_path_contract.test.mjs` unit-tests that shape and then holds every
tracked path in `architecture/evidence.d`, `docs/evidence`, `artifacts` and `data`
to it, so a path of this class cannot be added back.

## Not covered here

A handful of retired work-item references survive in the prose of
`docs/civic-action-paths.md` and the audit evidence generated from
`tools/lib/action_path_generalization_audit.mjs`. They appear only in file content,
never in a path, and the public tree does not record what each one covered, so
renaming them here would mean inventing descriptions for a published evidence
claim. They are left for a change that can name them from their own record.

Some tool filenames under `tools/` also carry a planning identifier. They are
outside the public evidence roots this rule governs and are not renamed here.
