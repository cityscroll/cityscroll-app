#!/usr/bin/env node
// Renders the real production output for the wider-project section across a
// fixed set of named capture cases and prints {label: html} JSON to stdout.
// Used only by tools/capture_procurement_project_context_evidence.py; nothing
// here is a served route or a build artifact, and running it changes no
// production code.
//
// Every case calls the real renderProcurementDocument() over the committed
// materialization, so a capture shows shipped behaviour rather than a mock.
import { CAPTURE_CASES } from "../test/fixtures/procurement_project_context_fixtures.mjs";

const cases = {};
for (const entry of CAPTURE_CASES) cases[entry.label] = entry.render();
process.stdout.write(JSON.stringify(cases));
