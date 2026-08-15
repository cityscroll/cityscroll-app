import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { solicitationResponseContextReady } from "../site/solicitation_response_context.mjs";

const moneyHistorySource = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");
const moneyListSource = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");

const completeSolicitation = {
  short_title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution",
  type_of_notice_description: "Solicitation",
  agency_name: "Finance",
  due_date: "2026-08-17T14:00:00.000",
};

test("solicitation response affordances require title, type, agency, and a response fact", () => {
  assert.equal(solicitationResponseContextReady(completeSolicitation), true);

  for (const field of ["short_title", "type_of_notice_description", "agency_name"]) {
    assert.equal(
      solicitationResponseContextReady({ ...completeSolicitation, [field]: null }),
      false,
      `${field} is required before response affordances render`,
    );
  }

  assert.equal(
    solicitationResponseContextReady({
      short_title: completeSolicitation.short_title,
      type_of_notice_description: completeSolicitation.type_of_notice_description,
      agency_name: completeSolicitation.agency_name,
      selection_method_description: "Request for Information",
    }),
    false,
    "a procurement-method label alone is not actionable response context",
  );
});

test("deadline, contact, or submission location can independently make complete identity actionable", () => {
  const identity = {
    short_title: completeSolicitation.short_title,
    type_of_notice_description: completeSolicitation.type_of_notice_description,
    agency_name: completeSolicitation.agency_name,
  };

  for (const [field, value] of [
    ["due_date", "2026-08-17T14:00:00.000"],
    ["email", "procurement@example.gov"],
    ["contact_phone", "212-555-0100"],
    ["contact_name", "Procurement Officer"],
    ["address_to_request", "1 Centre Street, New York, NY"],
    ["street_address_1", "1 Centre Street"],
  ]) {
    assert.equal(
      solicitationResponseContextReady({ ...identity, [field]: value }),
      true,
      `${field} supplies an actionable response fact`,
    );
  }
});

test("non-solicitations never pass the solicitation response gate", () => {
  assert.equal(
    solicitationResponseContextReady({
      ...completeSolicitation,
      type_of_notice_description: "Award",
    }),
    false,
  );
});

test("Contracts browse wires the context gate ahead of every solicitation response affordance", () => {
  const renderDetail = moneyHistorySource.slice(
    moneyHistorySource.indexOf("function renderDetail"),
    moneyHistorySource.indexOf("// parseNL() itself lives"),
  );
  const headingAt = renderDetail.indexOf("solicitationContextHeadingHTML(r)");
  const railAt = renderDetail.indexOf('id="dactions"');
  const responseAt = renderDetail.indexOf("buildApply(r,false)");

  assert.ok(headingAt >= 0 && headingAt < railAt, "named solicitation context precedes the action rail");
  assert.ok(railAt < responseAt, "named solicitation context also precedes the response guide");
  assert.match(renderDetail, /if\(responseContextReady\).*buildApply\(r,false\)/);
  assert.match(renderDetail, /if\(actionRailContextReady\) mountNoticeActionRail/);
  assert.match(renderDetail, /actionRailContextReady \? \$\("#dactions"\) : null/);
  assert.match(
    moneyListSource,
    /matter\.kind==="solicitation" && !solicitationResponseContextReady\(r\)/,
    "the list-level Respond link uses the same gate",
  );
});
