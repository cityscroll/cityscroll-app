/**
 * Source-qualified Community Board bylaw versions and material rules.
 *
 * This is intentionally a small governance vocabulary. It captures rules
 * that change how a resident interprets a board or committee, not a complete
 * parliamentary-procedure model. A missing rule is not a negative rule: the
 * question projection returns source_does_not_establish.
 */

export const COMMUNITY_BOARD_BYLAW_VERSION_SCHEMA = "cityscroll.community_board_bylaw_version.v1";
export const COMMUNITY_BOARD_GOVERNED_BY_EDGE_SCHEMA = "cityscroll.community_board_governed_by_edge.v1";
export const COMMUNITY_BOARD_BYLAW_METHOD = "community_board_bylaw_evidence_v1";

export const COMMUNITY_BOARD_BYLAW_RULE_TOPICS = Object.freeze([
  "officer_structure",
  "standing_committee_rules",
  "committee_membership_eligibility",
  "public_committee_member_eligibility",
  "public_committee_member_voting",
  "voting_eligibility",
  "quorum",
  "public_participation",
  "committee_full_board_referral",
  "parliamentary_authority",
]);

export const COMMUNITY_BOARD_BYLAW_ANSWERS = Object.freeze([
  "yes",
  "no",
  "source_does_not_establish",
]);

export const COMMUNITY_BOARD_BYLAW_QUESTION = Object.freeze({
  id: "public_committee_member_voting",
  prompt: "Can public committee members vote here?",
});

const clean = (value, max = 1_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const date = (value) => {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : match[1];
};

const httpsUrl = (value) => {
  try {
    const url = new URL(clean(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const isBoardId = (value) => /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(clean(value, 100).toLowerCase());

function requireValue(value, label) {
  const normalized = clean(value, 500);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
function normalizedReceipt(receipt, sourceUrl) {
  const input = receipt && typeof receipt === "object" ? receipt : {};
  return {
    schema: clean(input.schema, 160) || "cityscroll.community_board_bylaw_receipt.v1",
    source_url: httpsUrl(input.source_url) || sourceUrl,
    observed_at: clean(input.observed_at || input.observedOn, 80) || null,
    status: ["ok", "observed", "verified"].includes(clean(input.status, 40).toLowerCase()) ? "ok" : "unknown",
    fetch_status: clean(input.fetch_status || input.http_status, 40) || null,
    content_type: clean(input.content_type, 120) || null,
    content_sha256: clean(input.content_sha256, 128) || null,
    parser: clean(input.parser, 120) || "reviewed_bylaw_extract_v1",
  };
}

function ruleSource(version, rule) {
  return {
    bylaw_version_id: version.id,
    source_url: version.source_url,
    publisher_document_id: version.publisher_document_id,
    source_locator: rule.source_locator,
    observed_on: version.observed_on,
    receipt: version.receipt,
  };
}

export function normalizeCommunityBoardBylawVersion(input = {}) {
  const boardId = clean(input.board_id || input.boardId, 100).toLowerCase();
  if (!isBoardId(boardId)) throw new Error("bylaw version requires a valid board_id");
  const sourceUrl = httpsUrl(input.source_url);
  if (!sourceUrl) throw new Error("bylaw version requires an HTTPS source_url");
  const publisherDocumentId = requireValue(
    input.publisher_document_id || input.document_id || input.publisher_doc_identifier,
    "publisher_document_id",
  );
  const id = requireValue(input.id, "bylaw version id");
  if (!id.startsWith("bylaw-version:")) throw new Error("bylaw version id must start with bylaw-version:");
  const observedOn = date(input.observed_on || input.observedOn);
  if (!observedOn) throw new Error("bylaw version requires observed_on");
  const receipt = normalizedReceipt(input.receipt || input.provenance?.receipt, sourceUrl);
  const rules = (Array.isArray(input.rules) ? input.rules : []).map((rule) => {
    const topic = clean(rule?.topic || rule?.rule_type, 100);
    if (!COMMUNITY_BOARD_BYLAW_RULE_TOPICS.includes(topic)) throw new Error(`unsupported bylaw rule topic: ${topic}`);
    const answer = COMMUNITY_BOARD_BYLAW_ANSWERS.includes(clean(rule.answer, 80))
      ? clean(rule.answer, 80)
      : "source_does_not_establish";
    const sourceLocator = requireValue(rule.source_locator || rule.locator, `source_locator for ${topic}`);
    return {
      schema: `${COMMUNITY_BOARD_BYLAW_VERSION_SCHEMA}:rule`,
      id: `${id}:rule:${topic}`,
      topic,
      answer,
      statement: clean(rule.statement, 2_000) || "The governing source does not establish this rule.",
      value: rule.value ?? null,
      source_locator: sourceLocator,
      bylaw_version_id: id,
    };
  });
  const byTopic = new Set();
  for (const rule of rules) {
    if (byTopic.has(rule.topic)) throw new Error(`duplicate bylaw rule topic: ${rule.topic}`);
    byTopic.add(rule.topic);
  }
  const supersedes = input.supersedes == null ? null : requireValue(input.supersedes, "supersedes");
  return {
    schema: COMMUNITY_BOARD_BYLAW_VERSION_SCHEMA,
    kind: "bylaw-version",
    id,
    board_id: boardId,
    source_url: sourceUrl,
    publisher: requireValue(input.publisher, "publisher"),
    publisher_document_id: publisherDocumentId,
    publisher_document_title: clean(input.publisher_document_title || input.document_title, 500) || null,
    effective_date: date(input.effective_date),
    adoption_date: date(input.adoption_date),
    observed_on: observedOn,
    supersedes,
    receipt,
    provenance: {
      schema: "cityscroll.community_board_bylaw_provenance.v1",
      source_url: sourceUrl,
      publisher: clean(input.publisher, 500),
      publisher_document_id: publisherDocumentId,
      observed_on: observedOn,
      receipt,
      method: COMMUNITY_BOARD_BYLAW_METHOD,
    },
    rules: rules.map((rule) => ({ ...rule, source: ruleSource({ id, source_url: sourceUrl, publisher_document_id: publisherDocumentId, observed_on: observedOn, receipt }, rule) })),
  };
}

function sameBoardVersion(version, boardId) {
  return version?.board_id === clean(boardId, 100).toLowerCase();
}

function versionDate(version) {
  return version?.effective_date || version?.adoption_date || null;
}

/**
 * Select exactly one current version. A supersession edge is authoritative;
 * otherwise an explicit effective/adoption date may break a tie. Observation
 * time alone never silently chooses between undated versions.
 */
export function currentCommunityBoardBylawVersion(versions = [], boardId) {
  const candidates = (Array.isArray(versions) ? versions : [])
    .filter((version) => sameBoardVersion(version, boardId));
  if (!candidates.length) return null;
  const ids = new Set(candidates.map((version) => version.id));
  const superseded = new Set(candidates
    .map((version) => version.supersedes)
    .filter((id) => ids.has(id)));
  const active = candidates.filter((version) => !superseded.has(version.id));
  if (active.length === 1) return active[0];
  const dated = active.filter((version) => versionDate(version));
  if (dated.length !== active.length) return null;
  const latest = [...dated].sort((a, b) => versionDate(b).localeCompare(versionDate(a)));
  return latest.length > 1 && versionDate(latest[0]) === versionDate(latest[1]) ? null : latest[0];
}

export function buildCommunityBoardBylawGraph(input = {}) {
  const rawVersions = Array.isArray(input) ? input : input.versions;
  const versions = (Array.isArray(rawVersions) ? rawVersions : [])
    .map(normalizeCommunityBoardBylawVersion);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const edges = versions.map((version) => ({
    schema: COMMUNITY_BOARD_GOVERNED_BY_EDGE_SCHEMA,
    edge_type: "governed_by",
    relation: "governed_by",
    status: "promoted",
    promoted: true,
    from: `community-board:${version.board_id}`,
    to: version.id,
    source_url: version.source_url,
    publisher_document_id: version.publisher_document_id,
    target_kind: "bylaw-version",
    target_id: version.id,
    target_name: version.publisher_document_title || "Community Board bylaw",
    effective_date: version.effective_date,
    adoption_date: version.adoption_date,
    observed_on: version.observed_on,
    supersedes: version.supersedes,
    receipt: version.receipt,
    provenance: version.provenance,
  }));
  return {
    schema: "cityscroll.community_board_bylaw_graph.v1",
    method: COMMUNITY_BOARD_BYLAW_METHOD,
    versions,
    edges,
    currentByBoard: (boardId) => currentCommunityBoardBylawVersion(versions, boardId),
    versionById,
  };
}

const answerLabel = (answer) => answer === "yes" ? "Yes" : answer === "no" ? "No" : "Source does not establish";

export function answerCommunityBoardGovernanceQuestion(graph, boardId, topic = COMMUNITY_BOARD_BYLAW_QUESTION.id) {
  const current = graph?.currentByBoard
    ? graph.currentByBoard(boardId)
    : currentCommunityBoardBylawVersion(graph?.versions, boardId);
  const rule = current?.rules?.find((candidate) => candidate.topic === topic) || null;
  const answer = rule?.answer || "source_does_not_establish";
  const edge = current ? graph?.edges?.find((candidate) => candidate.to === current.id) || null : null;
  return {
    question: topic === COMMUNITY_BOARD_BYLAW_QUESTION.id ? COMMUNITY_BOARD_BYLAW_QUESTION.prompt : topic,
    topic,
    answer,
    label: answerLabel(answer),
    board_id: clean(boardId, 100).toLowerCase(),
    bylaw_version: current,
    governed_by_edge: edge,
    rule,
    provenance: rule?.source || current?.provenance || null,
  };
}

export function communityBoardBylawSourceDescriptor(graph, boardId) {
  const current = graph?.currentByBoard?.(boardId);
  if (!current) return null;
  return {
    source_url: current.source_url,
    publisher: current.publisher,
    observed_on: current.observed_on,
    state: current.receipt.status === "ok" ? "observed" : "unknown",
    publisher_document_id: current.publisher_document_id,
    bylaw_version_id: current.id,
  };
}

export function renderCommunityBoardBylawPanel(governance = {}) {
  const answer = governance.question || answerCommunityBoardGovernanceQuestion(governance.graph, governance.board_id);
  const current = answer.bylaw_version;
  const sourceLink = current?.source_url
    ? `<a class="board-source-link" href="${escapeHtml(current.source_url)}" target="_blank" rel="noopener noreferrer">Open governing document<span aria-hidden="true">↗</span></a>`
    : "";
  const versionLabel = current
    ? `${escapeHtml(current.publisher_document_title || current.publisher_document_id)} · observed ${escapeHtml(current.observed_on)}`
    : `<span data-bylaw-answer="source_does_not_establish">No board-specific bylaw version is available in the checked sources.</span>`;
  const rules = current?.rules?.length
    ? `<ul class="node-record-list">${current.rules.map((rule) => `<li class="node-record" data-bylaw-rule="${escapeHtml(rule.topic)}"><div class="node-record-main"><strong>${escapeHtml(rule.topic.replaceAll("_", " "))}</strong> <span class="bylaw-answer bylaw-answer-${escapeHtml(rule.answer)}">${escapeHtml(answerLabel(rule.answer))}</span></div><span class="muted node-muted">${escapeHtml(rule.statement)}</span><span class="muted node-muted">${escapeHtml(rule.source_locator)} · <a href="${escapeHtml(current.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(current.publisher_document_id)}</a></span></li>`).join("")}</ul>`
    : current
      ? `<p class="node-muted" data-bylaw-answer="source_does_not_establish">No material board rules are listed in this source.</p>`
      : "";
  const history = current && governance.versions?.length > 1
    ? `<details class="inline-disclose board-bylaw-history"><summary>Version history</summary><div class="inline-disclose-body"><ul>${governance.versions.filter((version) => version.board_id === current.board_id).map((version) => `<li><a href="${escapeHtml(version.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(version.publisher_document_title || version.publisher_document_id)}</a>${version.id === current.id ? " (current)" : " (superseded)"}</li>`).join("")}</ul></div></details>`
    : "";
  return `<section id="community-board-governance" class="node-section node-card civic-object-section community-board-governance" data-community-board-governance="1" data-bylaw-version-id="${escapeHtml(current?.id || "")}" aria-labelledby="community-board-governance-heading"><h2 id="community-board-governance-heading">Governing bylaws</h2><p class="node-lede">Material board rules are shown only when that board’s governing source establishes them.</p><div class="board-governance-answer" data-governance-question="${escapeHtml(answer.topic)}" data-governance-answer="${escapeHtml(answer.answer)}"><strong>${escapeHtml(answer.question)}</strong><span class="bylaw-answer bylaw-answer-${escapeHtml(answer.answer)}">${escapeHtml(answer.label)}</span></div><p class="muted node-muted">${versionLabel}${sourceLink ? ` · ${sourceLink}` : ""}</p>${history}${rules}</section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[char]));
}
