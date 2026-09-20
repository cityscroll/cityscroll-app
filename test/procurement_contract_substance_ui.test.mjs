import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EVIDENCE_ROLES,
  RESIDENT_VENDOR_PROMISE_LABEL,
  applyAmendment,
  buildContractSubstanceDocument,
  projectContractSubstance,
  projectObligation,
  projectPriceTerm,
} from "../site/procurement_contract_substance.mjs";
import {
  ACCESS_STATES,
  DOCUMENT_ROLES,
  buildContractSubstanceAccessDocument,
} from "../site/procurement_contract_substance_access.mjs";
import {
  buildContractSubstanceView,
  renderContractSubstanceAccessNoteHtml,
  renderContractSubstanceHtml,
  substanceGeographyLinkKeys,
} from "../site/procurement_contract_substance_ui.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";

const MATERIALIZED_SUBSTANCE = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance.json", import.meta.url),
  "utf8",
));
const MATERIALIZED_ACCESS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_access.json", import.meta.url),
  "utf8",
));
const MATERIALIZED_SERVICE_GEOGRAPHY = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_service_geography.json", import.meta.url),
  "utf8",
));
const MATERIALIZED_ROLE_CORPUS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_role_corpus.json", import.meta.url),
  "utf8",
));
const ROLE_CAPTURE_MANIFEST = JSON.parse(readFileSync(
  new URL("../docs/evidence/contract-substance-role-corpus/capture-manifest.json", import.meta.url),
  "utf8",
));
const PARITY_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url),
  "utf8",
));

const BHRAGS = "CT107120258801626";
const SMALL_CONTRACT_IDS = [
  "CT110220271400991",
  "CT105720278802113",
  "CT104020273009333",
];
const EXECUTED_URL = "https://www.nyc.gov/assets/example/executed-contract.pdf";

const CITED_PASSAGE_RE = /Source passage/;

function executedSubstanceCandidates() {
  return {
    scopeCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-executed-scope-1",
      content_hash: `sha256:${"cd".repeat(32)}`,
      publication_date: "2024-08-29",
      locator: "page 3 / section 2.1 Scope of Services",
      excerpt: "The Contractor shall provide home care services to eligible residents within the service area during the contract term.",
      public_url: EXECUTED_URL,
      document_role: EVIDENCE_ROLES.EXECUTED_SCOPE,
      subject: "home care services",
      action: "provide",
      object: "eligible residents",
      period: "2024-09-01 to 2027-08-31",
    }],
    priceCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-pricing-1",
      content_hash: `sha256:${"cd".repeat(32)}`,
      publication_date: "2024-08-29",
      locator: "page 12 / Rate Schedule A",
      excerpt: "Unit price: $45.00 per attendant hour, not to exceed 40 hours per week.",
      public_url: EXECUTED_URL,
      document_role: EVIDENCE_ROLES.PRICING_SCHEDULE,
      payment_basis: "unit_price",
      description: "attendant hour",
      quantity: 1,
      unit: "hour",
      rate: 45,
      conditions: "not to exceed 40 hours per week",
      period: "contract term",
    }],
    obligationCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-obligation-1",
      content_hash: `sha256:${"cd".repeat(32)}`,
      publication_date: "2024-08-29",
      locator: "page 5 / section 4.2 Deliverables",
      excerpt: "The vendor shall deliver monthly staffing reports to the Agency by the tenth business day of each month.",
      public_url: EXECUTED_URL,
      document_role: EVIDENCE_ROLES.EXECUTED_OBLIGATION,
      obligated_party: "The vendor",
      action: "deliver",
      deliverable: "monthly staffing reports",
      frequency: "monthly",
      deadline: "tenth business day of each month",
    }],
  };
}

function fromProjection(projected, extra = {}) {
  return buildContractSubstanceDocument({
    scopeFacts: projected.scope_facts,
    priceTerms: projected.price_terms,
    obligations: projected.obligations,
    unresolved: projected.unresolved,
    ...extra,
  }, { generatedAt: "2026-09-19T12:00:00.000Z" });
}

function executedSubstanceDocument() {
  return fromProjection(projectContractSubstance(executedSubstanceCandidates()));
}

function solicitationOnlySubstanceDocument() {
  const projected = projectContractSubstance({
    scopeCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-rfx-scope-1",
      content_hash: `sha256:${"ab".repeat(32)}`,
      publication_date: "2024-01-15",
      locator: "page 2 / RFx Scope",
      excerpt: "The City seeks a vendor to provide home care services to eligible residents across the five boroughs.",
      public_url: "https://www.nyc.gov/assets/example/solicitation.pdf",
      document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
      subject: "home care services",
      action: "provide",
      object: "eligible residents",
    }],
    obligationCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-rfx-scope-1",
      content_hash: `sha256:${"ab".repeat(32)}`,
      publication_date: "2024-01-15",
      locator: "page 2 / RFx Scope",
      excerpt: "The vendor shall deliver monthly staffing reports.",
      public_url: "https://www.nyc.gov/assets/example/solicitation.pdf",
      document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
      obligated_party: "The vendor",
      action: "deliver",
      deliverable: "monthly staffing reports",
    }],
  });
  return fromProjection(projected);
}

function amendedPricingSubstanceDocument() {
  const prior = projectPriceTerm(executedSubstanceCandidates().priceCandidates[0]);
  assert.equal(prior.ok, true);
  const amendmentInput = {
    contract_id: BHRAGS,
    source_document_id: "doc-amendment-1",
    content_hash: `sha256:${"ef".repeat(32)}`,
    publication_date: "2025-03-01",
    locator: "page 2 / Amendment 1 Rate Schedule",
    excerpt: "The unit price is amended to $47.50 per attendant hour for the remainder of the term.",
    public_url: "https://www.nyc.gov/assets/example/amendment-1.pdf",
    payment_basis: "unit_price",
    description: "attendant hour",
    quantity: 1,
    unit: "hour",
    rate: 47.5,
    period: "remainder of the term",
  };
  const applied = applyAmendment({ prior: prior.fact, amendment: amendmentInput });
  assert.equal(applied.ok, true);
  return buildContractSubstanceDocument({
    priceTerms: [applied.prior, applied.amended],
  }, { generatedAt: "2026-09-19T12:00:00.000Z" });
}

function smallContractObject(contractId) {
  return {
    procurement_id: `procurement:contract:${contractId}`,
    identity_keys: { contract_ids: [contractId] },
    title: `Contract ${contractId}`,
  };
}

function sectionHtml(html) {
  return html.match(/<section[^>]*id="procurement-contract-substance"[\s\S]*?<\/section>/)?.[0] || "";
}

function accessNote(html) {
  return html.match(/<p[^>]*data-substance-access-limit="[^"]*"[^>]*>[^<]*<\/p>/)?.[0] || "";
}

function renderFor(object, observations, opts = {}) {
  return renderProcurementDocument(object, observations, {
    contractSubstanceMaterialization: opts.substance ?? null,
    contractSubstanceAccessMaterialization: opts.access ?? null,
    contractServiceGeographyMaterialization: opts.serviceGeography ?? null,
  });
}

test("A1: admitted executed rows surface all four questions with cited passages", () => {
  const view = buildContractSubstanceView({
    substance: executedSubstanceDocument(),
    contractIds: [BHRAGS],
    authorizedTotal: 10869881,
    paidTotal: 7385672.19,
    paidAsOf: "2026-08-06",
  });
  assert.equal(view.has_content, true);
  const html = renderContractSubstanceHtml(view);
  const section = sectionHtml(html);
  assert.ok(section, "the substance section must render");
  for (const heading of [
    "What the City bought",
    "How payment is calculated",
    RESIDENT_VENDOR_PROMISE_LABEL,
    "Where the work applies",
  ]) {
    // "Where the work applies" renders from place evidence; the executed
    // document alone still opens the question when place rows exist. Here
    // no service geography is passed, so only three groups carry content.
    if (heading === "Where the work applies") {
      assert.doesNotMatch(section, new RegExp(heading), "no empty place card without place rows");
      continue;
    }
    assert.match(section, new RegExp(heading), heading);
  }
  assert.match(section, /home care services/);
  assert.match(section, /monthly staffing reports/);
  assert.match(section, /The vendor shall deliver monthly staffing reports/);
  // Every scope/promise row opens its cited passage at the executed document.
  const citationLinks = [...section.matchAll(/href="(https:\/\/www\.nyc\.gov\/assets\/example\/[^"]+)"/g)];
  assert.ok(citationLinks.length >= 3, "each displayed claim links its cited passage");
  for (const match of citationLinks) assert.equal(match[1], EXECUTED_URL);
  assert.match(section, /page 3 \/ section 2\.1 Scope of Services/);
  assert.match(section, /page 5 \/ section 4\.2 Deliverables/);
  assert.match(section, CITED_PASSAGE_RE);
});

test("A1/A3: pricing distinguishes authorized totals, paid totals, and contractual rates", () => {
  const view = buildContractSubstanceView({
    substance: executedSubstanceDocument(),
    contractIds: [BHRAGS],
    authorizedTotal: 10869881,
    paidTotal: 7385672.19,
    paidAsOf: "2026-08-06",
  });
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.match(section, /<dt>Authorized contract total<\/dt><dd data-substance-authorized-total>\$10,869,881<\/dd>/);
  assert.match(section, /<dt>Paid to date<\/dt><dd data-substance-paid-total>\$7,385,672\.19/);
  assert.match(section, /payments through 2026-08-06/);
  assert.match(section, /\$45 per hour/);
  assert.match(section, /Unit price/);
  assert.match(section, /not to exceed 40 hours per week/);
  // A rate schedule exists, so no bounded absence statement appears.
  assert.doesNotMatch(section, /No public rate schedule was located/);
});

test("A2: advertised RFx statements stay out of the vendor-promise wording and stay visually distinct", () => {
  const projected = projectContractSubstance({
    obligationCandidates: [{
      contract_id: BHRAGS,
      source_document_id: "doc-rfx-scope-1",
      content_hash: `sha256:${"ab".repeat(32)}`,
      publication_date: "2024-01-15",
      locator: "page 2 / RFx Scope",
      excerpt: "The vendor shall deliver monthly staffing reports.",
      public_url: "https://www.nyc.gov/assets/example/solicitation.pdf",
      document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
      obligated_party: "The vendor",
      action: "deliver",
      deliverable: "monthly staffing reports",
    }],
  });
  assert.equal(projected.obligations.length, 0, "solicitation obligations are refused by the projector");
  assert.ok(projected.unresolved.length >= 1);

  const view = buildContractSubstanceView({
    substance: solicitationOnlySubstanceDocument(),
    contractIds: [BHRAGS],
  });
  const html = renderContractSubstanceHtml(view);
  const section = sectionHtml(html);
  assert.ok(section, "advertised scope still renders under What the City bought");
  assert.match(section, /What the City bought/);
  assert.match(section, /home care services/);
  assert.match(section, /class="substance-standing substance-standing-advertised">Advertised</);
  assert.doesNotMatch(section, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
  assert.doesNotMatch(section, /substance-standing-executed/);
  assert.doesNotMatch(section, /monthly staffing reports/);
});

test("A2: executed and amended standings carry their own labels", () => {
  const executedView = buildContractSubstanceView({
    substance: executedSubstanceDocument(),
    contractIds: [BHRAGS],
  });
  const executedSection = sectionHtml(renderContractSubstanceHtml(executedView));
  assert.match(executedSection, /substance-standing-executed">Executed</);

  const amendedView = buildContractSubstanceView({
    substance: amendedPricingSubstanceDocument(),
    contractIds: [BHRAGS],
  });
  const amendedSection = sectionHtml(renderContractSubstanceHtml(amendedView));
  assert.match(amendedSection, /substance-standing-amended">Amended</);
  assert.match(amendedSection, /Amends the prior term/);
});

test("A3: amended pricing shows the amended rate and cites the amendment passage", () => {
  const view = buildContractSubstanceView({
    substance: amendedPricingSubstanceDocument(),
    contractIds: [BHRAGS],
  });
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.match(section, /\$47\.50 per hour/);
  assert.match(section, /remainder of the term/);
  assert.match(section, /href="https:\/\/www\.nyc\.gov\/assets\/example\/amendment-1\.pdf"/);
  assert.match(section, /page 2 \/ Amendment 1 Rate Schedule/);
  // The superseded prior rate leads nothing: it stays in evidence depth only.
  assert.doesNotMatch(section, /data-amends-prior/);
  const amendedRows = [...section.matchAll(/substance-price-row[\s\S]*?(?=<li class="substance-row|<\/ul>)/g)]
    .map((match) => match[0]);
  assert.equal(amendedRows.filter((row) => /47\.50/.test(row)).length, 1);
});

test("A3: totals without a rate schedule say so only when the bounded access record supports it", () => {
  const accessDoc = buildContractSubstanceAccessDocument({
    rows: [{
      contract_id: BHRAGS,
      document_role: DOCUMENT_ROLES.PRICING_SCHEDULE,
      access_state: ACCESS_STATES.NOT_LOCATED,
      observed_at: "2026-09-18T19:15:00.000Z",
      checked_source_ids: ["checkbook-contracts", "city-record-awards"],
    }],
    generatedAt: "2026-09-18T19:15:00.000Z",
  });
  const view = buildContractSubstanceView({
    substance: { ...MATERIALIZED_SUBSTANCE },
    access: accessDoc,
    contractIds: [BHRAGS],
    authorizedTotal: 10869881,
    paidTotal: 1000,
    serviceGeography: null,
  });
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.match(section, /No public rate schedule was located in the checked public sources as of 2026-09-18/);
  assert.match(section, /does not establish that no rate schedule exists/);

  // An account-gated pricing schedule never reads as "not located".
  const gatedView = buildContractSubstanceView({
    substance: { ...MATERIALIZED_SUBSTANCE },
    access: MATERIALIZED_ACCESS,
    contractIds: [BHRAGS],
    authorizedTotal: 10869881,
    paidTotal: 1000,
    serviceGeography: null,
  });
  const gatedSection = sectionHtml(renderContractSubstanceHtml(gatedView));
  assert.doesNotMatch(gatedSection, /No public rate schedule was located/);

  // No access record at all: the absence stays quiet.
  const quietView = buildContractSubstanceView({
    substance: { ...MATERIALIZED_SUBSTANCE },
    contractIds: [BHRAGS],
    authorizedTotal: 10869881,
    paidTotal: 1000,
    serviceGeography: null,
  });
  const quietSection = sectionHtml(renderContractSubstanceHtml(quietView));
  assert.doesNotMatch(quietSection, /No public rate schedule was located/);
});

test("A4: place rows link the selected boundary and the exact scoped record while keeping the place role", () => {
  const view = buildContractSubstanceView({
    substance: MATERIALIZED_SUBSTANCE,
    serviceGeography: MATERIALIZED_SERVICE_GEOGRAPHY,
    contractIds: [BHRAGS],
  });
  assert.equal(view.has_content, true);
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.match(section, /Where the work applies/);
  assert.match(section, /data-substance-place-role="facility_site"/);
  assert.match(section, /3218 Emmons Avenue, Brooklyn/);
  assert.match(section, /Facility site/);
  // The selected neighborhood boundary opens Near You through the versioned
  // geography-key wire contract.
  assert.match(section, /href="\/near-you\/\?v=0&amp;lens=money&amp;geo=geography%3Anta2020%3ABK1503"/);
  assert.match(section, /Sheepshead Bay-Manhattan Beach-Gerritsen Beach/);
  assert.match(section, /data-geography-key="geography:community_district:K15"/);
  // The exact scoped record stays reachable.
  assert.match(section, /href="\/notices\/20240829105"/);
  assert.match(section, /Notice 20240829105/);
  assert.deepEqual([...new Set(substanceGeographyLinkKeys(view))].sort(), [
    "geography:community_district:K15",
    "geography:council_district:48",
    "geography:nta2020:BK1503",
    "geography:police_precinct:61",
  ]);
  // A resident view shows each asserted place once, not every retained copy.
  assert.equal([...section.matchAll(/3218 Emmons Avenue, Brooklyn/g)].length, 1);
});

test("A5: the three small contracts state their access limit once near official sources", () => {
  for (const contractId of SMALL_CONTRACT_IDS) {
    const view = buildContractSubstanceView({
      substance: MATERIALIZED_SUBSTANCE,
      access: MATERIALIZED_ACCESS,
      serviceGeography: MATERIALIZED_SERVICE_GEOGRAPHY,
      contractIds: [contractId],
      authorizedTotal: 42000,
      paidTotal: 9000,
    });
    const html = renderContractSubstanceHtml(view) + renderContractSubstanceAccessNoteHtml(view);
    assert.equal(sectionHtml(html), "", `${contractId}: no empty substance card`);
    assert.doesNotMatch(sectionHtml(html), /How payment is calculated|Where the work applies/);
    const note = accessNote(html);
    assert.ok(note, `${contractId}: the access limit must be stated`);
    assert.match(note, /data-substance-access-limit="account_gated"/);
    assert.match(note, /behind publisher sign-in/);
    assert.equal([...html.matchAll(/data-substance-access-limit=/g)].length, 1, "stated exactly once");
    assert.doesNotMatch(html, /No public rate schedule was located/);
    // The bounded performance-evaluation absence never becomes a resident claim.
    assert.doesNotMatch(html, /performance evaluation/i);
  }
});

test("A5: the BHRAGS place-only evidence renders its group alone, with no empty sibling cards", () => {
  const view = buildContractSubstanceView({
    substance: MATERIALIZED_SUBSTANCE,
    access: MATERIALIZED_ACCESS,
    serviceGeography: MATERIALIZED_SERVICE_GEOGRAPHY,
    contractIds: [BHRAGS],
  });
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.match(section, /Where the work applies/);
  assert.doesNotMatch(section, /What the City bought/);
  assert.doesNotMatch(section, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
});

test("A6: a failed or inapplicable substance load keeps the canonical facts and never renders an empty success", () => {
  const { object, observations } = PARITY_FIXTURE;

  const broken = renderFor(object, observations, { substance: { schema: "not.the.schema" } });
  assert.equal(sectionHtml(broken), "");
  assert.doesNotMatch(broken, /data-subtract|substance-access-limit="null"/);
  assert.match(broken, /BHRAGS HOME CARE CORP/);
  assert.match(broken, /CT107120258801626/);
  assert.match(broken, /Contract facts/);

  const empty = renderFor(object, observations, {
    substance: buildContractSubstanceDocument({ generatedAt: "2026-09-19T12:00:00.000Z" }),
  });
  assert.equal(sectionHtml(empty), "");
  assert.match(empty, /BHRAGS HOME CARE CORP/);

  // A substance document scoped to another contract never reaches this page.
  const foreign = renderFor(object, observations, {
    substance: executedSubstanceDocument(),
    access: null,
    serviceGeography: null,
  });
  // The parity fixture is the BHRAGS contract, so executed rows do apply;
  // scope the same document to a different id to prove the boundary.
  const foreignView = buildContractSubstanceView({
    substance: executedSubstanceDocument(),
    contractIds: ["CT999900000000009"],
  });
  assert.equal(foreignView, null);
  assert.ok(foreign.length > 0);

  // A malformed payload that throws inside the builder is caught, not thrown.
  const throwing = buildContractSubstanceView({
    substance: new Proxy({}, { get() { throw new Error("boom"); } }),
    contractIds: [BHRAGS],
  });
  assert.equal(throwing, null);
});

test("A6: payment, facility, and substance projections coexist on the canonical page", () => {
  const { object, observations } = PARITY_FIXTURE;
  const html = renderProcurementDocument(object, observations, {
    contractSubstanceMaterialization: executedSubstanceDocument(),
  });
  assert.match(html, /data-procurement-payment-evidence="1"/);
  assert.match(html, /data-payment-total-spent="7385672\.19"/);
  assert.match(html, /data-procurement-place-facts="1"/);
  assert.match(html, /3218 Emmons Avenue, Brooklyn/);
  const section = sectionHtml(html);
  assert.ok(section, "the substance section rides the canonical document");
  for (const heading of [
    "What the City bought",
    "How payment is calculated",
    RESIDENT_VENDOR_PROMISE_LABEL,
    "Where the work applies",
  ]) assert.match(section, new RegExp(heading), heading);
  // The scoped paid total in the substance view agrees with the payment section.
  assert.match(section, /data-substance-paid-total>\$7,385,672\.19/);
});

test("A7: the section is server-rendered, keyboard-reachable, and useful without JavaScript", () => {
  const { object, observations } = PARITY_FIXTURE;
  const html = renderProcurementDocument(object, observations, {
    contractSubstanceMaterialization: executedSubstanceDocument(),
  });
  const section = sectionHtml(html);
  assert.ok(section);
  assert.doesNotMatch(section, /javascript:/i);
  assert.doesNotMatch(section, /tabindex="-1"/);
  assert.doesNotMatch(section, /<script/);
  // Excerpts live in native details/summary controls that work without JS.
  assert.match(section, /<details class="substance-excerpt"><summary>Cited passage<\/summary>/);
  // Citation and geography links are plain anchors.
  for (const anchor of [...section.matchAll(/<a ([^>]*)>/g)]) {
    assert.match(anchor[1], /href="[^"]+"/);
    assert.doesNotMatch(anchor[1], /onclick|role="button"/);
  }
  // The stylesheet ships exactly when the section does.
  assert.match(html, /<link rel="stylesheet" href="\/procurement_contract_substance\.css" data-route-style="procurement_contract_substance\.css">/);
  const quiet = renderFor(object, observations, {});
  assert.doesNotMatch(quiet, /procurement_contract_substance\.css/);
});

test("A7: source-link integrity keeps every substance href tied to admitted evidence", () => {
  const { object, observations } = PARITY_FIXTURE;
  const html = renderProcurementDocument(object, observations, {
    contractSubstanceMaterialization: executedSubstanceDocument(),
  });
  const section = sectionHtml(html);
  const allowed = new Set([
    EXECUTED_URL,
    "/notices/20240829105",
    "/near-you/?v=0&lens=money&geo=geography%3Anta2020%3ABK1503",
    "/near-you/?v=0&lens=money&geo=geography%3Acommunity_district%3AK15",
    "/near-you/?v=0&lens=money&geo=geography%3Acouncil_district%3A48",
    "/near-you/?v=0&lens=money&geo=geography%3Apolice_precinct%3A61",
  ]);
  const hrefs = [...section.matchAll(/href="([^"]+)"/g)].map((match) => match[1]
    .replace(/&amp;/g, "&"));
  assert.ok(hrefs.length >= 4, "the section carries citation and geography links");
  for (const href of hrefs) {
    assert.ok(allowed.has(href), `unexpected substance href: ${href}`);
  }
  // Public serializers stay free of internal evidence bookkeeping.
  assert.doesNotMatch(section, /sha256:/);
  assert.doesNotMatch(section, /excerpt_hash|projector_version|desk_reviewable/);
  // Excerpts remain available for the reader who opens the passage details.
  assert.match(section, /The Contractor shall provide home care services/);
});

test("A7: the capture artifact observes both layouts, destinations, and source-role mutation refusal", () => {
  assert.equal(ROLE_CAPTURE_MANIFEST.schema, "cityscroll.contract_substance_role_corpus_capture_manifest.v2");
  assert.match(ROLE_CAPTURE_MANIFEST.source_revision, /^grounded origin\/main [a-f0-9]{40}$/);
  assert.equal(ROLE_CAPTURE_MANIFEST.assertions.length, 1);
  assert.equal(ROLE_CAPTURE_MANIFEST.assertions[0].id, "A7");
  assert.match(ROLE_CAPTURE_MANIFEST.assertions[0].artifact, /viewports.*layout/);

  for (const capture of ROLE_CAPTURE_MANIFEST.captures) {
    assert.equal(capture.viewports.length, 2, capture.case);
    const [desktop, mobile] = capture.viewports;
    assert.deepEqual([desktop.width, desktop.height], [1440, 900]);
    assert.deepEqual([mobile.width, mobile.height], [390, 844]);
    for (const viewport of capture.viewports) {
      assert.match(viewport.render_sha256, /^[a-f0-9]{64}$/);
      assert.match(viewport.layout_sha256, /^[a-f0-9]{64}$/);
      assert.equal(viewport.layout.overflow, false);
      assert.equal(viewport.layout.scroll_width, viewport.layout.client_width);
      assert.equal(viewport.no_javascript_source_destination.script_tag_count, 0);
      assert.equal(viewport.no_javascript_source_destination.javascript_href_count, 0);
      assert.deepEqual(
        viewport.no_javascript_source_destination.destinations_in_rendered_markup,
        viewport.no_javascript_source_destination.expected_destinations,
      );
    }
    assert.notEqual(desktop.layout_sha256, mobile.layout_sha256, `${capture.case}: layout hash must differ by viewport`);
    assert.notEqual(desktop.layout.content_height, mobile.layout.content_height, `${capture.case}: content height must be observed at both viewports`);
    assert.equal(capture.keyboard_source_open.all_named_destinations_reached, true, capture.case);
    assert.deepEqual(
      capture.keyboard_source_open.reached_in_tab_order,
      capture.keyboard_source_open.expected_destinations,
    );
    assert.deepEqual(capture.keyboard_source_open.missing_destinations, []);
  }

  assert.equal(ROLE_CAPTURE_MANIFEST.source_role_mutation.vendor_promise_label_emitted, false);
  assert.equal(ROLE_CAPTURE_MANIFEST.source_role_mutation.contract_requires_heading_emitted, false);
  assert.equal(ROLE_CAPTURE_MANIFEST.source_role_mutation.rendered_row_count, 0);
});

test("A7: mutating a retained bid source role cannot promote it into a vendor promise", () => {
  const mutatedCorpus = structuredClone(MATERIALIZED_ROLE_CORPUS);
  const rows = mutatedCorpus.rows.filter((candidate) => candidate.contract_id === "BID2000090");
  assert.ok(rows.length);
  for (const row of rows) {
    row.document_role = "executed_obligation";
    row.resident_claim_label = RESIDENT_VENDOR_PROMISE_LABEL;
  }
  const view = buildContractSubstanceView({
    roleCorpus: mutatedCorpus,
    contractIds: ["BID2000090"],
  });
  assert.equal(view, null, "a role mutation that is not in the role-evidence vocabulary must fail closed");
  assert.doesNotMatch(renderContractSubstanceHtml(view), new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
});

test("A7: the three small contracts render through the canonical document without fabricated substance", () => {
  for (const contractId of SMALL_CONTRACT_IDS) {
    const html = renderFor(smallContractObject(contractId), [], {
      substance: MATERIALIZED_SUBSTANCE,
      access: MATERIALIZED_ACCESS,
      serviceGeography: MATERIALIZED_SERVICE_GEOGRAPHY,
    });
    assert.match(html, new RegExp(contractId));
    assert.equal(sectionHtml(html), "", `${contractId}: no substance card without admitted rows`);
    const note = accessNote(html);
    assert.ok(note, `${contractId}: access limit stated`);
    assert.match(note, /data-substance-access-limit="account_gated"/);
    assert.match(html, /Sources|Official records|What these official records do not carry/);
  }
});

test("solicitation obligations never gain promise standing through the view alone", () => {
  const forced = buildContractSubstanceDocument({
    obligations: [{
      ...projectObligation({
        contract_id: BHRAGS,
        source_document_id: "doc-obligation-1",
        content_hash: `sha256:${"cd".repeat(32)}`,
        publication_date: "2024-08-29",
        locator: "page 5 / section 4.2 Deliverables",
        excerpt: "The vendor shall deliver monthly staffing reports to the Agency by the tenth business day of each month.",
        public_url: EXECUTED_URL,
        document_role: EVIDENCE_ROLES.EXECUTED_OBLIGATION,
        obligated_party: "The vendor",
        action: "deliver",
        deliverable: "monthly staffing reports",
      }).fact,
      // A hostile rewrite of the standing label must not smuggle solicitation
      // evidence beneath the promise heading.
      document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
    }],
  }, { generatedAt: "2026-09-19T12:00:00.000Z" });
  const view = buildContractSubstanceView({
    substance: forced,
    contractIds: [BHRAGS],
  });
  const section = sectionHtml(renderContractSubstanceHtml(view));
  assert.doesNotMatch(section, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
  assert.doesNotMatch(section, /monthly staffing reports/);
});

test("real role corpus renders DocGo audit evidence with its source role and observed receipt", () => {
  const view = buildContractSubstanceView({
    roleCorpus: MATERIALIZED_ROLE_CORPUS,
    contractIds: ["CT180620248801671"],
    authorizedTotal: 432000000,
    paidTotal: 123456789,
    paidAsOf: "2026-09-09",
  });
  const html = renderContractSubstanceHtml(view);
  assert.match(html, /Comptroller audit reports/);
  assert.match(html, /Comptroller audit/);
  assert.match(html, /The audit reports these contract terms/);
  assert.match(html, /audit-of-the-department-of-housing-preservation-and-development/);
  assert.match(html, /data-observed-authorized-total="\$432,000,000"/);
  assert.match(html, /data-observed-paid-total="\$123,456,789"/);
  assert.match(html, /data-observation-vintage="2026-09-19T12:00:00.000Z"/);
  assert.match(html, /Public source evidence/);
  assert.doesNotMatch(html, /What this contract requires|contract requires/i);
  assert.doesNotMatch(html, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
});

test("real role corpus keeps DCAS offers and GrowNYC terms in explicit non-executed groups", () => {
  const dcas = renderContractSubstanceHtml(buildContractSubstanceView({
    roleCorpus: MATERIALIZED_ROLE_CORPUS,
    contractIds: ["BID2000090"],
  }));
  assert.match(dcas, /DCAS bid offers/);
  assert.match(dcas, /Bid offer/);
  assert.match(dcas, /href="https:\/\/www\.nyc\.gov\/assets\/dcas\/downloads\/pdf\/business\/bidtabs\/2000090\.pdf"/);
  assert.doesNotMatch(dcas, /What this contract requires|contract requires/i);
  assert.doesNotMatch(dcas, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));

  const mocs = renderContractSubstanceHtml(buildContractSubstanceView({
    roleCorpus: MATERIALIZED_ROLE_CORPUS,
    contractIds: ["MOCS-FCRC-202411-GROWNYC"],
  }));
  assert.match(mocs, /GrowNYC proposed agreement terms/);
  assert.match(mocs, /Proposed agreement term/);
  assert.match(mocs, /PublicMeetingDocuments_202411\.pdf/);
  assert.match(mocs, /Joyce Kilmer Park/);
  assert.doesNotMatch(mocs, /What this contract requires|contract requires/i);
  assert.doesNotMatch(mocs, new RegExp(RESIDENT_VENDOR_PROMISE_LABEL));
});

test("BHRAGS notice context keeps units and notice attribution without contractual standing", () => {
  const view = buildContractSubstanceView({
    serviceGeography: MATERIALIZED_SERVICE_GEOGRAPHY,
    contractIds: [BHRAGS],
  });
  const html = renderContractSubstanceHtml(view);
  assert.match(html, /3218 Emmons Avenue, Brooklyn · 60 units/);
  assert.match(html, /Notice-attributed facility context/);
  assert.match(html, /href="\/notices\/20240829105"/);
  assert.doesNotMatch(html, /contractual deliverable|What the vendor promised/);
});

test("role corpus requires the exact canonical contract id and refuses unrelated documents", () => {
  const unrelated = buildContractSubstanceView({
    roleCorpus: MATERIALIZED_ROLE_CORPUS,
    contractIds: ["CT999900000000009"],
  });
  assert.equal(unrelated, null);
});
