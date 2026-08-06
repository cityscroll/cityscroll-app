import { test } from "node:test";
import assert from "node:assert/strict";
import { landStatusFacetOptions, landStatusFacetWhere } from "../site/land_status_facets.mjs";

test("land status facets are derived from non-empty ZAP status fields", () => {
  const options = landStatusFacetOptions([
    { project_status: "Active", public_status: "In Public Review" },
    { project_status: "Active", public_status: "In Public Review" },
    { project_status: "Complete", public_status: "Completed" },
    { project_status: "", public_status: null },
  ]);
  assert.deepEqual(options, [
    { id: "public:Completed", label: "Completed", field: "public_status", count: 1 },
    { id: "project:Active", label: "Active", field: "project_status", count: 2 },
    { id: "public:In Public Review", label: "In Public Review", field: "public_status", count: 2 },
    { id: "project:Complete", label: "Complete", field: "project_status", count: 1 },
  ].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)));
});

test("land status facet preserves the exact source field in its query", () => {
  assert.equal(landStatusFacetWhere("project:Active"), "project_status='Active'");
  assert.equal(landStatusFacetWhere("public:In Public Review"), "public_status='In Public Review'");
  assert.equal(landStatusFacetWhere("public:O'Reilly"), "public_status='O''Reilly'");
  assert.equal(landStatusFacetWhere("active"), null);
});
