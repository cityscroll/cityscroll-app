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
| `architecture/evidence.d` | 164 |
| `artifacts` | 8 |
| `data` | 2 |
| `docs/evidence` | 83 |
| **Total** | **257** |

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

One control-plane receipt entry is left for a follow-up. Its identity is declared
on the same physical source line as a published schema id, so no edit changes the
identity without also reprinting that schema id, and renaming the schema id is a
separate contract change with its own consumers. The test pins that one path by
SHA-256 rather than by name — an exception written in plain characters would put
back the kind of name this rule exists to remove — and it fails if a second path
ever joins it, or if the pinned one stops needing the exception.

## Beyond the paths

The same registry namespace also appeared in file content, where it named a
record rather than a path: in the ids the evidence entries declared, in the
`card` field of capture manifests and receipts, in two scratch-directory
prefixes, in one inventory note, and in the shipped-work list of the civic
action-path audit. Those all moved in the same change. The audit keeps its own
short local labels, which are what its published table has always rendered and
what the surrounding documentation already refers to; only the registry
namespace in front of them is gone.

Some tool filenames under `tools/` still carry an abbreviation-and-ordinal
prefix. They are outside the public evidence roots this rule governs and are
not renamed here.
