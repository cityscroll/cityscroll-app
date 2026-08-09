import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENTITY_TYPE_FAMILIES,
  PERSON_LEADER_ENTITY_TYPE,
  buildAgencyHeadEntities,
  personLeaderEntityId,
  resolveLeadershipReferent,
} from "../entity_resolution/index.mjs";
import {
  resolveOpaqueReferent,
  resolveReferent,
} from "../entity_resolution/referents/index.mjs";
import crosswalk from "../worker/src/data/agency_crosswalk.json" with { type: "json" };

test("person-leader is a distinct ER family with stable agency-scoped identity", () => {
  assert.ok(ENTITY_TYPE_FAMILIES.includes("person-leader"));
  assert.equal(PERSON_LEADER_ENTITY_TYPE, "person-leader");
  assert.equal(
    personLeaderEntityId({ agencyId: "police-department", personName: "Jessica Tisch" }),
    "person-leader:police-department:name:jessica%20tisch",
  );
});

test("crosswalk materializes named agency heads and resolves named officials", () => {
  const leaders = buildAgencyHeadEntities(crosswalk);
  const nypd = leaders.find((leader) => leader.agency_id === "police-department");
  assert.ok(nypd);
  assert.equal(nypd.display_name, "Jessica Tisch");
  assert.equal(nypd.role, "Commissioner");
  const resolved = resolveLeadershipReferent("Commissioner Jessica Tisch spoke", {
    crosswalk,
    agencyId: "police-department",
  });
  assert.equal(resolved?.entity.id, nypd.id);
  assert.equal(resolved?.confidence.status, "strong");
  assert.equal(resolved?.method, "exact_head_name");
});

test("role referents require agency scope and a publisher title match", () => {
  const resolved = resolveLeadershipReferent("the commissioner", {
    crosswalk,
    agencyName: "Police Department",
  });
  assert.equal(resolved?.entity.display_name, "Jessica Tisch");
  assert.equal(resolved?.method, "agency_scoped_role");
  assert.equal(resolveLeadershipReferent("the commissioner", { crosswalk }), null);
  assert.equal(resolveLeadershipReferent("the deputy commissioner", {
    crosswalk,
    agencyName: "Police Department",
  }), null);
});

test("opaque referents resolve only exact unique aliases", () => {
  const project = {
    id: "project:2022M0258",
    entity_type: "project",
    name: "Gowanus Pilot Project",
    aliases: ["the pilot project"],
  };
  const resolved = resolveOpaqueReferent("the pilot project", { entities: [project] });
  assert.equal(resolved?.entity.id, project.id);
  assert.equal(resolved?.confidence.status, "strong");
  assert.equal(resolveOpaqueReferent("the pilot project", {
    entities: [project, { ...project, id: "project:other" }],
  }), null);
  assert.equal(resolveReferent("the pilot project", { entities: [project] })?.method, "exact_explicit_alias");
  assert.equal(resolveReferent("the project", { entities: [project] }), null);
});
