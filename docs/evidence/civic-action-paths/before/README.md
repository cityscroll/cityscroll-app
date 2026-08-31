# Civic Action Paths — before-state captures

These captures freeze the public app before Action Path continuation and Ways
to participate shipped. They were produced by
`tools/capture_civic_action_paths_before.py` with a loopback static server and
headless Playwright. Interactive browser sessions are not used.

Viewports: desktop 1440×1000 and mobile 390×844.

The file map is [`capture-manifest.json`](capture-manifest.json). Screenshot
binaries were migrated to content-addressed evidence objects; the manifest
keeps the fixture, route, viewport, and object URL.

Fixture classes:

1. Council meeting with one strict matter join (`#notice/20260707022`)
2. Council meeting with multiple agenda matters (`#notice/20260707021`)
3. Meeting with no grounded matter (`#notice/20260728026`)
4. Community Board with source-backed public committee-member semantics
   (`/community-boards/manhattan-cb-06/`)
5. Community Board where those participation semantics are unknown
   (`/community-boards/manhattan-cb-02/`)
6. DOT City-Owned Bicycle Racks rules list and adoption notice

The captures do not imply that a resident attended, testified, commented, or
applied. Characterization of rails, calendar, Following, and sources is
[`characterization-receipt.md`](characterization-receipt.md).
