import { test } from "node:test";
import assert from "node:assert/strict";
import * as pivots from "../site/entity_pivot.mjs";
import { listEntityMentionHTML } from "../site/list_entity_pivots.mjs";

globalThis.CrolEntityPivots = pivots;
const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");

test("list entity mentions use constellation links only for typed routable identities", () => {
  const agency = listEntityMentionHTML({ kind: "agency", value: "Finance", escape });
  assert.match(agency, /ui-constellation-link/);
  assert.match(agency, /\/agencies\/finance\//);

  const unknown = listEntityMentionHTML({ kind: "agency", value: "Review-only organization", escape });
  assert.equal(unknown, "Review-only organization");
  assert.doesNotMatch(unknown, /href=/);

  const project = listEntityMentionHTML({ kind: "project", value: "2024Q0135", label: "Willets Point", escape });
  assert.match(project, /href="#land\/2024Q0135"/);
});
