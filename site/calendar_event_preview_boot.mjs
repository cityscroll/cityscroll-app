/**
 * Browser boot for the shared in-place calendar event preview (PX-01).
 *
 * The Community Board constellation, legislative matter and procurement
 * documents are rendered ahead of the reader rather than painted by a route
 * module, so they have no existing browser entry point to hang the shared
 * preview binder on. This is that entry point, and nothing else: it binds the
 * one delegated behaviour to the document and stops.
 *
 * Loading this module is what reveals the preview buttons, so a document that
 * does not load it — or a reader whose browser never runs it — is left with
 * the canonical anchors, which work on their own.
 */

import { bindCalendarEventPreview } from "./calendar_event_preview.mjs";

if (typeof document !== "undefined") bindCalendarEventPreview(document);
