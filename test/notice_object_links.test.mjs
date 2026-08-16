import assert from "node:assert/strict";
import test from "node:test";

import {
  mandateObjectTarget,
  noticeEvidenceTarget,
  projectNoticeObjectTarget,
} from "../site/notice_object_links.mjs";
import {
  findMandateById,
  noticeEvidenceForMandate,
  relatedCivicEdgesForMandate,
  renderMandateDocument,
} from "../site/mandate_document.mjs";
import pagesEdge, { edgeRequestKind, renderEdgeNotice } from "../site/pages_edge.mjs";

const REPRO_NOTICE = {
  request_id: "20260710020",
  short_title: "Pesticides and Mosquito Control Products",
  agency_name: "Health and Mental Hygiene",
  section_name: "Public Comment on Contract Awards",
  type_of_notice_description: "Notice",
  additional_description_1: `
    <p>This is a notice seeking comments about the proposed contract below.</p>
    <p><strong>E-PIN:&nbsp;</strong>81626S0021001</p>
    <p>Comments must be submitted before July 27, 2026.</p>
  `,
};

const WARRANTED_MANDATE = {
  mandate_id: "66056-006",
  agency_id: "homeless-services",
  agency_name: "Homeless Services",
  duty_text: "Renegotiate shelter contracts within the statutory period.",
  citation: "Administrative Code § 6-109.2(i)",
  source_href: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=66056",
  deadline: {
    kind: "days_after_effective",
    computed_date: "2021-12-07",
    text: "No later than 30 days after the effective date",
  },
  recurrence: "one-time",
};

test("contract-award comment notice projects to its stable procurement object", () => {
  const projection = projectNoticeObjectTarget(REPRO_NOTICE);
  assert.equal(projection.state, "matched");
  assert.equal(projection.target.kind, "procurement");
  assert.equal(projection.target.id, "81626S0021001");
  assert.equal(
    projection.target.href,
    "/browse/contracts/?mode=award&q=81626S0021001",
  );
  assert.equal(projection.evidence.kind, "notice");
  assert.equal(projection.evidence.href, "/notices/20260710020");
  assert.notEqual(projection.target.href, projection.evidence.href);
});

test("contract-award notice stays notice-only without one stable identifier", () => {
  const missing = projectNoticeObjectTarget({
    ...REPRO_NOTICE,
    additional_description_1: "Comments are invited about a proposed award.",
  });
  assert.equal(missing.state, "notice_only");
  assert.equal(missing.target.kind, "notice");
  assert.equal(missing.target.href, "/notices/20260710020");

  const ambiguous = projectNoticeObjectTarget({
    ...REPRO_NOTICE,
    additional_description_1: "E-PIN: 81626S0021001; E-PIN: 81626S0021002",
  });
  assert.equal(ambiguous.state, "notice_only");
  assert.equal(ambiguous.target.kind, "notice");
});

test("warranted mandate gets a mandate route and separate notice evidence", () => {
  const target = mandateObjectTarget(WARRANTED_MANDATE);
  assert.equal(target?.kind, "mandate");
  assert.equal(target?.href, "/mandates/66056-006");
  assert.match(target?.label || "", /^Mandate · /);

  const evidence = noticeEvidenceTarget("20210820102");
  assert.deepEqual(evidence, {
    kind: "notice",
    id: "20210820102",
    href: "/notices/20210820102",
    label: "Notice evidence",
  });
});

test("unwarranted or ambiguous deontic claims never get mandate routes", () => {
  assert.equal(mandateObjectTarget({ ...WARRANTED_MANDATE, citation: null, source_href: null }), null);
  assert.equal(mandateObjectTarget({ ...WARRANTED_MANDATE, agency_id: null, agency_name: null }), null);
  assert.equal(mandateObjectTarget({ ...WARRANTED_MANDATE, deadline: null, recurrence: null }), null);
  assert.equal(mandateObjectTarget({ ...WARRANTED_MANDATE, mandate_id: "bad:id" }), null);
});

test("repro notice renderer labels and links the typed target", () => {
  const html = renderEdgeNotice(REPRO_NOTICE, REPRO_NOTICE.request_id);
  assert.match(html, /data-pivot-target-kind="procurement"/);
  assert.match(html, /href="\/browse\/contracts\/?\?mode=award&amp;q=81626S0021001"/);
  assert.match(html, /Contract award · 81626S0021001/);
  assert.doesNotMatch(html, /href="\/notices\/20260710020"[^>]*>Contract award/);
});

test("mandate document resolves exact ids and shows inverse notice evidence", () => {
  const lookup = {
    by_agency: {
      "homeless-services": {
        obligations: [{
          ...WARRANTED_MANDATE,
          obligation_id: WARRANTED_MANDATE.mandate_id,
          source: { legistar_url: WARRANTED_MANDATE.source_href },
        }],
      },
    },
  };
  const backlinks = {
    by_notice: {
      "20210820102": [{ mandate_id: WARRANTED_MANDATE.mandate_id }],
      "20210820103": [{ mandate_id: "other" }],
    },
  };
  const mandate = findMandateById(lookup, WARRANTED_MANDATE.mandate_id);
  assert.ok(mandate);
  assert.deepEqual(noticeEvidenceForMandate(backlinks, WARRANTED_MANDATE.mandate_id), [
    noticeEvidenceTarget("20210820102"),
  ]);
  const html = renderMandateDocument(mandate, {
    noticeEvidence: noticeEvidenceForMandate(backlinks, WARRANTED_MANDATE.mandate_id),
  });
  assert.match(html, /data-civic-object-kind="mandate"/);
  assert.match(html, /href="\/notices\/20210820102"[^>]*>Notice evidence/);
  assert.match(html, /href="https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&amp;ID=66056"/);
  assert.equal(edgeRequestKind("https://cityscroll.org/mandates/66056-006"), "mandate");
});

test("mandate document admits only public provenance-complete civic edges", () => {
  const claim = (id, verified = false) => ({
    schema: "cityscroll.graph_edge_provenance.v1",
    claim_id: id,
    where: {
      source_system: { available: true, value: "city_record" },
      source_record_id: { available: true, value: `city_record:${id}` },
      observed_at: { available: true, value: "2026-08-06" },
    },
    how: { method: { available: true, value: "parsed_mandate_evidence_v1" } },
    confidence: {
      band: "strong",
      standable: true,
      counts_as_verified_total: verified,
    },
    inspect_href: `/agencies/transportation/?claim=${id}`,
  });
  const lookup = {
    by_agency: {
      transportation: {
        edge_observations: [{
          mandate_id: "66056-006",
          category: "contracts",
          status: "observed",
          observed_record: {
            request_id: "20210820102",
            label: "Contract CT1-071-20228800271",
            href: "/notices/20210820102",
          },
          edge: {
            type: "implemented_by_contract",
            from: "mandate:66056-006",
            to: "contract:CT1-071-20228800271",
            publication_tier: "public_inferred",
            provenance: claim("contract", true),
          },
        }, {
          mandate_id: "66056-006",
          category: "meetings",
          status: "observed",
          observed_record: {
            request_id: "20260716009",
            label: "Dining Out NYC Public Hearing",
            href: "/notices/20260716009",
          },
          edge: {
            type: "requires_public_hearing",
            from: "mandate:66056-006",
            to: "notice:20260716009",
            publication_tier: "public_inferred",
            provenance: claim("meeting"),
          },
        }, {
          mandate_id: "66056-006",
          category: "rules",
          status: "observed",
          observed_record: {
            request_id: "20260605008",
            label: "DSNY Final Rule",
            href: "/notices/20260605008",
          },
          edge: {
            type: "requires_rule_filing",
            from: "mandate:66056-006",
            to: "rulemaking:notice:20260605008",
            publication_tier: "public_inferred",
            provenance: claim("rule"),
          },
        }, {
          mandate_id: "66056-006",
          category: "rules",
          status: "evidence_only",
          observed_record: { request_id: "held", label: "Held candidate" },
          edge: {
            type: "requires_rule_filing",
            from: "mandate:66056-006",
            to: "rulemaking:notice:held",
            publication_tier: "evidence_only",
            provenance: claim("held"),
          },
        }],
      },
    },
  };

  const edges = relatedCivicEdgesForMandate(lookup, WARRANTED_MANDATE.mandate_id);
  assert.deepEqual(edges.map((edge) => edge.kind), ["procurement", "rule", "meeting"]);
  assert.equal(edges.length, 3);
  assert.equal(edges.filter((edge) => edge.verified).length, 1);
  assert.equal(edges.find((edge) => edge.kind === "procurement").href, "/browse/contracts/?mode=award&q=CT1-071-20228800271");
  assert.equal(edges.find((edge) => edge.kind === "rule").href, "/notices/20260605008");
  assert.equal(edges.find((edge) => edge.kind === "meeting").href, "/meetings/meeting%3Acity_record%3A20260716009");

  const html = renderMandateDocument(WARRANTED_MANDATE, { relatedEdges: edges });
  assert.match(html, /Related civic records/);
  assert.match(html, /data-related-civic-edges="3"/);
  assert.match(html, /data-verified-civic-edges="1"/);
  assert.match(html, /href="\/browse\/contracts\/?\?mode=award&amp;q=CT1-071-20228800271"/);
  assert.match(html, /href="\/notices\/20260605008"/);
  assert.match(html, /href="\/meetings\/meeting%3Acity_record%3A20260716009"/);
  assert.doesNotMatch(html, /Held candidate/);
});

test("canonical mandate route serves only a warranted materialized object", async () => {
  const lookup = {
    by_agency: {
      "homeless-services": {
        obligations: [{
          ...WARRANTED_MANDATE,
          obligation_id: WARRANTED_MANDATE.mandate_id,
          source: { legistar_url: WARRANTED_MANDATE.source_href },
        }],
      },
    },
  };
  const backlinks = {
    by_notice: { "20210820102": [{ mandate_id: WARRANTED_MANDATE.mandate_id }] },
  };
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/data/agency_obligations_lookup.json") return Response.json(lookup);
        if (path === "/data/notice_mandate_backlinks_lookup.json") return Response.json(backlinks);
        return new Response("missing", { status: 404 });
      },
    },
  };
  const response = await pagesEdge.fetch(
    new Request("https://cityscroll.org/mandates/66056-006"),
    env,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /rel="canonical" href="https:\/\/cityscroll\.org\/mandates\/66056-006"/);
  assert.match(html, /href="\/notices\/20210820102"/);

  const missing = await pagesEdge.fetch(
    new Request("https://cityscroll.org/mandates/not-materialized"),
    env,
  );
  assert.equal(missing.status, 404);
});
