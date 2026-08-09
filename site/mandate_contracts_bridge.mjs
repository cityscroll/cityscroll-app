import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";

/**
 * Mandates → contracts/procurement constellation bridge.
 *
 * A public edge requires four independent keys: the agency-scoped dossier, a
 * procurement-trigger duty, subject/scope overlap with a procurement notice,
 * and the existing notice → contract authority-key edge. Agency co-occurrence
 * or title similarity alone never publishes a connection.
 */

import { makeObjectLink } from "../entity_resolution/cross_domain/object_links.mjs";
import {
  DEFAULT_CROSS_SPINE_EDGE_POLICY,
  routeCrossSpineEdge,
} from "../entity_resolution/cross_domain/edge_policy.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { buildEdgeProvenanceClaim } from "./graph_edge_provenance.mjs";

export const MANDATE_CONTRACTS_SCHEMA = "cityscroll.mandate_contracts_bridge.v1";
export const MANDATE_CONTRACTS_METHOD = "mandate_agency_scope_authority_exact_v1";
export const MANDATE_CONTRACT_EDGE_TYPE = "implemented_by_contract";
export const MANDATE_CONTRACT_SIGNAL = "procurement_contract";
export const MANDATE_CONTRACT_MIN_PRECISION = 0.9;

const PROCUREMENT_TRIGGER = /\b(?:request for proposals|issue (?:a |an )?solicitation|solicit(?:ation)? for|procure(?:ment)?|enter into (?:a |an )?contract|renegotiat\w* (?:qualifying )?existing [^.]{0,80}contracts?|contract (?:with|for)|contracts (?:with|for))\b/i;

const SUBJECT_STOP_WORDS = new Set([
  "about", "administration", "agency", "applicable", "city", "commence", "contract", "contracted",
  "contractor", "contracts", "department", "ensure", "every", "existing", "include",
  "including", "issue", "local", "make", "mandate", "period", "procure", "procurement",
  "program", "proposal", "proposals", "provide", "qualifying", "receive", "receiving",
  "renegotiate", "request", "required", "requirement", "requirements", "section", "service",
  "services", "shall", "solicitation", "specified", "terms", "through", "under", "with",
  "within", "york",
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function stemToken(value) {
  return value
    .replace(/ies$/, "y")
    .replace(/(ing|ed|es|s)$/, "");
}

export function mandateContractSubjectKeys(value) {
  return [...new Set(
    clean(value, 2_000)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 5 && !SUBJECT_STOP_WORDS.has(token))
      .map(stemToken)
      .filter((token) => token.length >= 5 && !SUBJECT_STOP_WORDS.has(token)),
  )].sort();
}

export function isProcurementMandate(row) {
  return PROCUREMENT_TRIGGER.test(clean(row?.duty_text, 2_000));
}

function procurementActionKey(value) {
  const text = clean(value, 2_000).toLowerCase();
  if (/request for proposals|\bsolicit(?:ation)?\b/.test(text)) return "solicitation";
  if (/renegotiat/.test(text)) return "renewal";
  if (/\bprocure(?:ment)?\b/.test(text)) return "procurement";
  if (/enter into (?:a |an )?contract|contracts? (?:with|for)/.test(text)) return "contract";
  return null;
}

function noticeCarriesAction(notice, actionKey) {
  const label = clean(notice?.label, 500).toLowerCase();
  if (actionKey === "solicitation") {
    return notice?.object_kind === "solicitation"
      || /\brfp\b|request for proposals|\bsolicit/.test(label);
  }
  if (actionKey === "renewal") return /\brenewal\b|renegotiat|\bamend/.test(label);
  return actionKey === "procurement" || actionKey === "contract";
}

/** Shareable constellation anchor for the bridge. */
export function agencyMandateContractsPath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/agencies/";
  return `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-contracts`;
}

export function agencyContractsFollowHref(agencyIdOrName, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_name) return "/following/";
  const filter = { agency: identity.canonical_name };
  if (identity.canonical_id) filter.entity_refs_all = [`agency:id:${identity.canonical_id}`];
  return followingUrlFromWatch({ lens: "money", filter }, { frequency });
}

function contractIdFromRef(ref) {
  return clean(ref, 160).replace(/^contract:/, "");
}

function procurementObjects(dossier) {
  return (Array.isArray(dossier?.domains?.money?.objects)
    ? dossier.domains.money.objects
    : [])
    .filter((row) => ["award", "solicitation", "intent_to_award"].includes(row?.object_kind))
    .filter((row) => clean(row?.subject_ref, 160).startsWith("notice:"));
}

function contractLinks(dossier) {
  const byNotice = new Map();
  for (const link of Array.isArray(dossier?.links) ? dossier.links : []) {
    if (link?.type !== "references_contract") continue;
    if (!clean(link.from, 160).startsWith("notice:")) continue;
    if (!clean(link.to, 160).startsWith("contract:")) continue;
    if (clean(link.confidence, 40) !== "strong") continue;
    if (!clean(link.provenance?.input_value, 160)) continue;
    if (!byNotice.has(link.from)) byNotice.set(link.from, []);
    byNotice.get(link.from).push(link);
  }
  return byNotice;
}

function publicationGate(source) {
  const row = source?.gate?.mandate_contract
    || source?.gates?.mandate_contract
    || source?.mandate_contract
    || null;
  if (!row) {
    return {
      status: "pass",
      precision: null,
      min_precision: MANDATE_CONTRACT_MIN_PRECISION,
      passed: true,
      source: "committed_policy",
    };
  }
  const precision = Number(row.precision);
  const minPrecision = Number(row.min_precision ?? MANDATE_CONTRACT_MIN_PRECISION);
  const passed = (row.passed === true || row.status === "pass")
    && Number.isFinite(precision)
    && Number.isFinite(minPrecision)
    && precision >= MANDATE_CONTRACT_MIN_PRECISION
    && precision >= minPrecision;
  return {
    status: passed ? "pass" : (row.status === "fail" ? "fail" : "insufficient"),
    precision: Number.isFinite(precision) ? precision : null,
    min_precision: Number.isFinite(minPrecision) ? minPrecision : MANDATE_CONTRACT_MIN_PRECISION,
    passed,
    gold_version: clean(source?.gold_version || row.gold_version, 120) || null,
    eval_version: clean(source?.eval_version || row.eval_version, 120) || null,
  };
}

function crossSpinePolicy(gate) {
  return {
    ...DEFAULT_CROSS_SPINE_EDGE_POLICY,
    gates: {
      ...DEFAULT_CROSS_SPINE_EDGE_POLICY.gates,
      mandate_contract: {
        status: gate.passed ? "pass" : (gate.status || "insufficient"),
        min_precision: gate.min_precision,
        precision: gate.precision,
      },
    },
  };
}

function emptyView(identity, sources) {
  return {
    schema: MANDATE_CONTRACTS_SCHEMA,
    method: MANDATE_CONTRACTS_METHOD,
    status: "empty",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    counts: { mandates: 0, procurement_records: 0, contracts: 0 },
    edges: [],
    shadow_edges: [],
    share_path: agencyMandateContractsPath(identity.canonical_id),
    browse_href: clean(sources.contractsBrowseHref, 500),
    follow_href: clean(sources.contractsFollowHref, 500)
      || agencyContractsFollowHref(identity.canonical_id),
    mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id),
  };
}

/**
 * Resolve procurement mandates through the existing money notice → contract
 * spine. The output follows the ER shadow narrow waist: source records,
 * blocking keys, feature evidence, a typed decision, and provenance.
 */
export function buildMandateContractsBridgeView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;
  const bucket = sources.obligationsLookup?.by_agency?.[identity.canonical_id];
  const mandates = (Array.isArray(bucket?.obligations) ? bucket.obligations : [])
    .filter(isProcurementMandate);
  const notices = procurementObjects(sources.intelligenceDossier);
  const linksByNotice = contractLinks(sources.intelligenceDossier);
  const gate = publicationGate(sources.crossSpineGate);
  const edgePolicy = crossSpinePolicy(gate);
  const limit = Math.max(1, Math.min(Number(sources.limit) || 16, 40));
  const edges = [];
  const shadowEdges = [];
  const seen = new Set();

  for (const mandate of mandates) {
    const mandateId = clean(mandate.obligation_id || mandate.mandate_id, 120);
    const mandateKeys = mandateContractSubjectKeys(mandate.duty_text);
    const actionKey = procurementActionKey(mandate.duty_text);
    if (!mandateId || !mandateKeys.length || !actionKey) continue;
    for (const notice of notices) {
      if (!noticeCarriesAction(notice, actionKey)) continue;
      const noticeKeys = mandateContractSubjectKeys(notice.label);
      const overlap = mandateKeys.filter((key) => noticeKeys.includes(key));
      if (!overlap.length) continue;
      for (const contractLink of linksByNotice.get(notice.subject_ref) || []) {
        const dedupeKey = `${mandateId}|${contractLink.to}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const authorityKey = clean(contractLink.provenance?.input_value, 160);
        const sourceRecordId = clean(contractLink.provenance?.source_record_id, 240);
        const contractId = contractIdFromRef(contractLink.to);
        const evidence = {
          schema: "cityscroll.er_candidate_evidence.v1",
          blocking_keys: [
            `agency:id:${identity.canonical_id}`,
            `action:${actionKey}`,
            ...overlap.map((key) => `scope:${key}`),
          ],
          agency_key: `agency:id:${identity.canonical_id}`,
          procurement_action_key: actionKey,
          subject_scope_keys: overlap,
          authority_key: authorityKey,
          notice_subject_ref: notice.subject_ref,
          contract_subject_ref: contractLink.to,
          source_records: {
            left: `enacted_local_law:${mandateId}`,
            right: sourceRecordId,
          },
          features: {
            agency_exact: true,
            procurement_trigger: true,
            procurement_action_exact: true,
            subject_scope_overlap: overlap.length,
            contract_authority_exact: true,
          },
          decision: "link",
        };
        const route = routeCrossSpineEdge({
          relation: "mandate_contract",
          features: evidence.features,
          evidence,
          provenance: {
            source_system: clean(contractLink.provenance?.source_system, 120),
            source_record_id: sourceRecordId,
          },
        }, { policy: edgePolicy });
        if (route.tier !== "public_inferred") {
          shadowEdges.push({
            id: `${mandateId}:${contractId}`,
            mandate: `mandate:${mandateId}`,
            procurement_record: notice,
            contract: contractLink.to,
            match: evidence,
            decision: "evidence_only",
            reason: route.reason,
            edge_policy: {
              tier: route.tier,
              reason: route.reason,
              policy_version: route.policy_version,
              evidence: route.evidence,
            },
          });
          continue;
        }
        const edge = makeObjectLink({
          type: MANDATE_CONTRACT_EDGE_TYPE,
          from: `mandate:${mandateId}`,
          to: contractLink.to,
          domain: "money",
          confidence: "strong",
          method: MANDATE_CONTRACTS_METHOD,
          method_version: "1",
          provenance: {
            source_system: clean(contractLink.provenance?.source_system, 120),
            source_record_id: sourceRecordId,
            source_fields: ["agency_name", "short_title", "pin", "epin"],
            basis: MANDATE_CONTRACTS_METHOD,
            observed_at: clean(contractLink.provenance?.observed_at || notice.when, 40),
            input_value: authorityKey,
            related_source_system: clean(notice.provenance?.source_system, 120),
            related_source_record_id: clean(notice.provenance?.source_record_id, 240),
          },
        });
        if (!edge) continue;
        const claim = buildEdgeProvenanceClaim({
          id: `${mandateId}:${contractId}`,
          label: `Contract ${contractId}`,
          href: notice.href || (notice.request_id ? `#notice/${notice.request_id}` : null),
          relation: MANDATE_CONTRACT_EDGE_TYPE,
          confidence: "strong",
          method: MANDATE_CONTRACTS_METHOD,
          provenance: edge.provenance,
        }, {
          category_id: "mandate-contracts",
          relation: MANDATE_CONTRACT_EDGE_TYPE,
          root_ref: `agency:id:${identity.canonical_id}`,
          document_path: agencyMandateContractsPath(identity.canonical_id).replace(/#.*$/, ""),
        });
        edges.push({
          mandate_id: mandateId,
          mandate: {
            subject_ref: `mandate:${mandateId}`,
            duty_text: clean(mandate.duty_text, 700),
            citation: clean(mandate.citation, 240) || null,
            source_href: clean(mandate.source?.legistar_url || mandate.href, 500) || null,
          },
          procurement_record: {
            subject_ref: notice.subject_ref,
            request_id: clean(notice.request_id, 80) || notice.subject_ref.replace(/^notice:/, ""),
            label: clean(notice.label, 300),
            when: clean(notice.when, 40) || null,
            href: clean(notice.href, 400)
              || `#notice/${encodeURIComponent(notice.subject_ref.replace(/^notice:/, ""))}`,
          },
          contract: {
            subject_ref: contractLink.to,
            contract_id: contractId,
          },
          evidence,
          edge,
          process_conformance: {
            method: MANDATE_CONTRACTS_METHOD,
            signal_kind: MANDATE_CONTRACT_SIGNAL,
            status: "observed",
            observed_record: contractLink.to,
          },
          edge_policy: {
            tier: route.tier,
            reason: route.reason,
            policy_version: route.policy_version,
            evidence: route.evidence,
          },
          claim,
        });
        if (edges.length >= limit) break;
      }
      if (edges.length >= limit) break;
    }
    if (edges.length >= limit) break;
  }

  if (!edges.length) {
    return {
      ...emptyView(identity, sources),
      shadow_edges: shadowEdges,
      publication_gate: gate,
    };
  }
  return {
    ...emptyView(identity, sources),
    status: "matched",
    counts: {
      mandates: new Set(edges.map((row) => row.mandate_id)).size,
      procurement_records: new Set(edges.map((row) => row.procurement_record.subject_ref)).size,
      contracts: new Set(edges.map((row) => row.contract.subject_ref)).size,
      shadow_edges: shadowEdges.length,
    },
    edges,
    shadow_edges: shadowEdges,
    publication_gate: gate,
  };
}

/** Render only resolved mandate → procurement → contract paths. */
export function renderMandateContractsBridgeSection(view) {
  if (!view || view.status !== "matched" || !view.edges?.length) return "";
  const grouped = new Map();
  for (const row of view.edges) {
    if (!grouped.has(row.mandate_id)) grouped.set(row.mandate_id, []);
    grouped.get(row.mandate_id).push(row);
  }
  const mandates = [...grouped.values()].map((rows) => {
    const mandate = rows[0].mandate;
    const source = mandate.source_href
      ? ` · ${officialSourceLink({ href: mandate.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
      : "";
    const records = rows.map((row) => {
      const claim = row.claim?.inspect_href
        ? ` · <a href="${esc(row.claim.inspect_href)}" data-edge-claim="${esc(row.claim.claim_id)}">Why this link?</a>`
        : "";
      return `<li class="node-record mandate-contract-record" data-contract-ref="${esc(row.contract.subject_ref)}" data-edge-type="${esc(MANDATE_CONTRACT_EDGE_TYPE)}">
        <div class="node-record-main">${constellationLink({ href: row.procurement_record.href, label: row.procurement_record.label, className: "agency-edge-link", escape: esc })}</div>
        <span class="muted node-muted">Contract ${esc(row.contract.contract_id)} · ${esc(row.procurement_record.when || "City Record")} · ${constellationLink({ href: row.procurement_record.href, label: "Open procurement record", className: "agency-edge-link", escape: esc })}${claim}</span>
      </li>`;
    }).join("");
    return `<article class="mandate-contract-group" data-mandate-id="${esc(rows[0].mandate_id)}">
      <h3 class="node-subhead">${esc(mandate.duty_text)}</h3>
      ${mandate.citation || source ? `<p class="muted node-muted">${esc(mandate.citation || "Mandate")}${source}</p>` : ""}
      <ul class="node-record-list" data-bridge-side="contracts">${records}</ul>
    </article>`;
  }).join("");
  const actions = [
    view.browse_href ? `<a class="node-action civic-object-action" href="${esc(view.browse_href)}">Open contracts scope</a>` : "",
    view.follow_href ? `<a class="node-action civic-object-action" href="${esc(view.follow_href)}">Follow contracts and procurement</a>` : "",
    view.mandates_follow_href ? `<a class="node-action civic-object-action" href="${esc(view.mandates_follow_href)}">Watch mandates</a>` : "",
    view.share_path ? `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>` : "",
  ].filter(Boolean).join("");
  return `<section id="mandates-contracts" class="node-section node-card civic-object-section mandate-contracts-bridge" data-agency-constellation-card="mandates-contracts" data-method="${esc(view.method)}" data-status="matched" data-export-class="object_members">
    <h2>Mandates · Contracts and procurement <span class="muted node-muted">(${esc(view.counts.mandates)} mandate${view.counts.mandates === 1 ? "" : "s"} · ${esc(view.counts.contracts)} contract${view.counts.contracts === 1 ? "" : "s"})</span></h2>
    ${mandates}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}
