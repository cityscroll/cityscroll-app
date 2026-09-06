/**
 * Browser boot for the shared calendar behaviour on rendered documents.
 *
 * The Community Board constellation, legislative matter and procurement
 * documents are rendered ahead of the reader rather than painted by a route
 * module, so they have no existing browser entry point to hang the shared
 * calendar binders on. This is that entry point, and nothing else: it mounts
 * the shared month component's one delegated behaviour on the document and
 * stops.
 *
 * It mounts through `compact_calendar.mjs` rather than reaching for one half
 * directly, so a rendered document gets exactly what a browser-painted host
 * gets: the in-place event preview and the crowded-day agenda together. A
 * document offered a clipped title but not the panel that shows it in full
 * would be a worse document than one offered neither.
 *
 * Loading this module is what reveals those affordances, so a document that
 * does not load it — or a reader whose browser never runs it — is left with
 * the canonical anchors and the native disclosure, which work on their own.
 */

import { bindCompactMonthCalendar } from "./compact_calendar.mjs";

if (typeof document !== "undefined") bindCompactMonthCalendar(document);
