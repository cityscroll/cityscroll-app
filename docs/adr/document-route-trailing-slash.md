# Normalize trailing slashes on extension-based document routes

| Status | Accepted |
| --- | --- |
| Date | 2026-08-24 |

## Context

The public Worker mirror forwards static-site requests to the canonical origin.
The static origin resolves extension-based document compatibility URLs such as
`/about.html` to clean document routes, but `/about.html/` falls through to the
generic site shell. This can silently replace a real document when an inbound
link includes a trailing slash.

## Decision

Before forwarding a mirrored request, remove one trailing slash only when the
path ends in `.html/` (case-insensitive). Directory routes retain their slash
and are forwarded unchanged. The origin remains responsible for the existing
`.html` to clean-route redirect and document response.

## Consequences

Extension-based document links with a trailing slash share the existing static
origin resolution path. Directory routes such as `/browse/` and `/agencies/`
are unaffected. `/changelog.html/` is normalized consistently, but the public
changelog route currently resolves to the About surface; that separate product
gap remains for the site owner to address.
