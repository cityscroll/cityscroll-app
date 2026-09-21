/**
 * Maintained discovery contract for public CityScroll capabilities.
 *
 * This is a small declarative projection: semantic authority stays in the
 * capability registry, MCP bindings, and each UI owner. The contract states
 * what a new or changed public capability must declare — task, eligibility,
 * placement, exact context, recovery, and evidence — and censes every
 * published page family for an inherited Ask-with-AI entry or a justified
 * omission.
 */

import { CAPABILITY_DISCOVERY_MATRIX, AI_ENDPOINT } from "./ai_discovery.mjs";
import { AFFORDANCE_ACTION_ROLES, affordanceActionRole } from "./affordance_grammar.mjs";
import { GUIDE_HELP } from "./guide_contextual_links.mjs";

export const DISCOVERY_CONTRACT_ID = "cityscroll.public_entrance_contract.v1";
export const GENERIC_AI_INTRODUCTION_PATH = "/use-with-ai/";
export { AI_ENDPOINT, AFFORDANCE_ACTION_ROLES };

/** Requirements every new or changed public capability must satisfy. */
export const DISCOVERY_REQUIREMENTS = Object.freeze({
  task: "Name the reader task the control serves; do not invent a capability to fill a button.",
  eligibility: "State the availability predicate; omit the control when the predicate fails.",
  placement: "Use shared navigation, More tools, or a scope-level region — never a per-row toolbar or arrival modal.",
  exact_context: "Carry only public identifiers and filters the destination can honor; never broaden silently.",
  recovery: "Preserve the original public context and offer copy or navigation recovery after a failed handoff.",
  evidence: "Prove the rendered route-to-task-to-result journey; separate protocol fixtures from hosted-client proof.",
});

/**
 * Closed dispositions for how a published page family exposes discovery.
 * `inherited_chrome` means shared document chrome mounts Ask with AI.
 * `standalone_link` means the template itself carries the introduction link.
 * `introduction` is the setup page.
 * `justified_omission` requires a non-empty reason and never promises a scoped task.
 */
export const PAGE_FAMILY_DISPOSITIONS = Object.freeze([
  "inherited_chrome",
  "standalone_link",
  "introduction",
  "justified_omission",
]);

/**
 * Closed placement vocabulary for capability task mappings, backing the
 * `placement` requirement: shared introduction, a scope-level region, or the
 * More-tools region. A per-row toolbar or arrival modal is unsupported by
 * construction because it is not in this list.
 */
export const CAPABILITY_TASK_PLACEMENTS = Object.freeze([
  "introduction",
  "scope_tools",
  "more_tools",
]);

/** Closed vocabulary for the matrix's user-visible disposition. */
export const CAPABILITY_TASK_DISPOSITIONS = Object.freeze([
  "machine_connector",
  "existing_control",
  "conditional_control",
  "browser_local",
  "contextual_control",
  "machine_analysis",
]);

/**
 * Census of published page families from the performance-classification
 * surface registry. Each family declares how generic AI introduction reaches
 * it. Contextual task entrances remain owned by sibling projections.
 */
export const PAGE_FAMILY_DISCOVERY = Object.freeze([
  Object.freeze({ surface_id: "home", route_family: "home", disposition: "standalone_link", render_owner: "site/index.html", ai_entry: "footer" }),
  Object.freeze({ surface_id: "search", route_family: "search", disposition: "standalone_link", render_owner: "site/search/index.html", ai_entry: "footer" }),
  Object.freeze({ surface_id: "now", route_family: "task-now", disposition: "inherited_chrome", render_owner: "site/primary_document_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "near-you", route_family: "place-near-you", disposition: "inherited_chrome", render_owner: "site/near_you_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "following", route_family: "stateful-following", disposition: "inherited_chrome", render_owner: "site/following_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "following-pack", route_family: "stateful-following-pack", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse", route_family: "browse", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-contracts", route_family: "browse-contracts", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-exams", route_family: "browse-exams", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-meetings", route_family: "browse-meetings", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-people", route_family: "browse-people", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-places", route_family: "browse-places", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-property", route_family: "browse-property", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-rules", route_family: "browse-rules", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-staffing", route_family: "browse-staffing", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "browse-zoning", route_family: "browse-zoning", disposition: "inherited_chrome", render_owner: "site/browse_view.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "guide", route_family: "information-guide", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "guide-article", route_family: "information-guide", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "about", route_family: "information-about", disposition: "standalone_link", render_owner: "site/about.html", ai_entry: "backhome" }),
  Object.freeze({ surface_id: "api-guide", route_family: "information-api", disposition: "standalone_link", render_owner: "site/api.html", ai_entry: "backhome" }),
  Object.freeze({ surface_id: "public-stats", route_family: "information-stats", disposition: "standalone_link", render_owner: "site/stats.html", ai_entry: "backhome" }),
  Object.freeze({ surface_id: "data-guide", route_family: "information-data", disposition: "standalone_link", render_owner: "site/data.html", ai_entry: "body" }),
  Object.freeze({ surface_id: "data-health", route_family: "information-data-health", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "changelog", route_family: "information-changelog", disposition: "standalone_link", render_owner: "site/changelog.html", ai_entry: "body" }),
  Object.freeze({ surface_id: "standards", route_family: "information-standards", disposition: "standalone_link", render_owner: "site/standards.html", ai_entry: "body" }),
  Object.freeze({ surface_id: "agency", route_family: "entity-agency", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "vendor", route_family: "entity-vendor", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "official", route_family: "entity-official", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "committee", route_family: "entity-committee", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "community-board", route_family: "entity-community-board", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "notice", route_family: "record-notice", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "meeting", route_family: "record-meeting", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "procurement", route_family: "record-procurement", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "exam", route_family: "record-exam", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "parcel", route_family: "record-parcel", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "mandate", route_family: "record-mandate", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "assertion", route_family: "record-assertion", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "rulemaking", route_family: "rulemaking", disposition: "inherited_chrome", render_owner: "site/civic_document_chrome.mjs", ai_entry: "mast" }),
  Object.freeze({ surface_id: "district-digest", route_family: "district-digest", disposition: "inherited_chrome", render_owner: "site/composed_object_documents.mjs", ai_entry: "mast" }),
]);

/** Introduction page is not a performance surface yet; keep it explicit. */
export const INTRODUCTION_FAMILY = Object.freeze({
  surface_id: "use-with-ai",
  route_family: "assistant-introduction",
  disposition: "introduction",
  render_owner: "site/use-with-ai/index.html",
  ai_entry: "self",
  path: GENERIC_AI_INTRODUCTION_PATH,
});

/**
 * Capability task bindings projected from the discovery matrix.
 * UI-only utilities must not require an MCP tool; MCP-backed tasks name a
 * public tool when one exists. Private Desk tools never appear here.
 */
export const CAPABILITY_TASK_BINDINGS = Object.freeze([
  Object.freeze({
    name: "MCP",
    task: "Connect an assistant to public records",
    requires_mcp: true,
    mcp_tools: Object.freeze(["list_capability_gaps"]),
    render_owner: "worker/src/mcp.mjs",
    guide_topic: null,
    action_role: AFFORDANCE_ACTION_ROLES.navigate,
    placement: "introduction",
    analytics_event: null,
  }),
  Object.freeze({
    name: "Follow",
    task: "Follow a search",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/app/feed-actions.mjs",
    guide_topic: "following",
    action_role: AFFORDANCE_ACTION_ROLES.navigate,
    placement: "scope_tools",
    analytics_event: "alert_start",
  }),
  Object.freeze({
    name: "Calendar",
    task: "Save dated events",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/calendar_subscription.mjs",
    guide_topic: "calendar",
    action_role: AFFORDANCE_ACTION_ROLES.handoff,
    placement: "scope_tools",
    analytics_event: "export",
  }),
  Object.freeze({
    name: "Feeds",
    task: "Read a scoped feed",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/app/feed-actions.mjs",
    guide_topic: "following",
    action_role: AFFORDANCE_ACTION_ROLES.navigate,
    placement: "scope_tools",
    analytics_event: "feed_fetch",
  }),
  Object.freeze({
    name: "Saved searches",
    task: "Keep a search in this browser",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/app/search-share.mjs",
    guide_topic: null,
    action_role: AFFORDANCE_ACTION_ROLES.inspect,
    placement: "more_tools",
    analytics_event: null,
  }),
  Object.freeze({
    name: "Collection/export",
    task: "Collect and export records",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/app/search-share.mjs",
    guide_topic: "emptyCollection",
    action_role: AFFORDANCE_ACTION_ROLES.inspect,
    placement: "more_tools",
    analytics_event: "export",
  }),
  Object.freeze({
    name: "Evidence",
    task: "Inspect source and connections",
    requires_mcp: false,
    mcp_tools: Object.freeze(["retrieve_cited_passages"]),
    render_owner: "site/guide_contextual_links.mjs",
    guide_topic: "connection",
    action_role: AFFORDANCE_ACTION_ROLES.inspect,
    placement: "more_tools",
    analytics_event: null,
  }),
  Object.freeze({
    name: "As-of",
    task: "Read records as of a day",
    requires_mcp: false,
    mcp_tools: Object.freeze([]),
    render_owner: "site/guide_contextual_links.mjs",
    guide_topic: "asOf",
    action_role: AFFORDANCE_ACTION_ROLES.navigate,
    placement: "more_tools",
    analytics_event: null,
  }),
  Object.freeze({
    name: "Comparative analysis",
    task: "Compare supported contract measures",
    requires_mcp: true,
    mcp_tools: Object.freeze(["analyze_contracts"]),
    render_owner: "capabilities/contracts_analysis.mjs",
    guide_topic: null,
    action_role: AFFORDANCE_ACTION_ROLES.navigate,
    placement: "more_tools",
    analytics_event: null,
  }),
]);

/** Analytics events that may record a discovery interaction — never a completed external connection. */
export const DISCOVERY_ANALYTICS_ALLOWLIST = Object.freeze([
  "page_view",
  "alert_start",
  "export",
  "feed_fetch",
  "investigation_share",
]);

/** Strings that must never appear in public discovery projections or analytics payloads. */
export const PRIVATE_DISCOVERY_BANLIST = Object.freeze([
  "Desk",
  "desk/",
  "/admin/",
  "watch-management",
  "session_id",
  "cs_visitor",
]);

export function pageFamilySurfaceIds() {
  return PAGE_FAMILY_DISCOVERY.map((row) => row.surface_id);
}

/**
 * Join the declaration to the published surface census without allowing the
 * declaration to choose the population. A new published surface therefore
 * produces a missing-declaration row instead of disappearing from the check.
 */
export function pageFamilyCensusFromPublishedSurfaces(surfaces = []) {
  const declarations = new Map(PAGE_FAMILY_DISCOVERY.map((row) => [row.surface_id, row]));
  return Object.freeze((surfaces || []).map((surface) => {
    const declaration = declarations.get(surface.surface_id);
    return Object.freeze({
      surface_id: surface.surface_id,
      route_family: surface.route_family || null,
      public_safe_matcher: surface.public_safe_matcher || null,
      ...(declaration || { census_declaration_missing: true }),
    });
  }));
}

export function capabilityTaskNames() {
  return CAPABILITY_TASK_BINDINGS.map((row) => row.name);
}

/**
 * Validate the discovery contract against live registries.
 * @param {object} opts
 * @param {string[]} [opts.publishedSurfaceIds] surface ids from the performance manifest
 * @param {Iterable<string>} [opts.mcpToolNames] live or generated MCP tool names
 * @param {object} [opts.guideHelp] GUIDE_HELP-shaped map
 * @param {Array} [opts.matrix] CAPABILITY_DISCOVERY_MATRIX rows
 * @param {string} [opts.analyticsSource] analytics collector source text
 * @param {string} [opts.chromeSource] civic document chrome source text
 * @param {Map<string, string>|Record<string, string>} [opts.renderOwnerSources] path -> source
 */
export function validateDiscoveryContract({
  publishedSurfaceIds = null,
  mcpToolNames = null,
  guideHelp = GUIDE_HELP,
  matrix = CAPABILITY_DISCOVERY_MATRIX,
  pageFamilies = PAGE_FAMILY_DISCOVERY,
  taskBindings = CAPABILITY_TASK_BINDINGS,
  analyticsSource = "",
  chromeSource = "",
  renderOwnerSources = null,
} = {}) {
  const problems = [];

  for (const key of Object.keys(DISCOVERY_REQUIREMENTS)) {
    if (!DISCOVERY_REQUIREMENTS[key] || typeof DISCOVERY_REQUIREMENTS[key] !== "string") {
      problems.push(`requirement missing prose: ${key}`);
    }
  }

  const matrixNames = new Set((matrix || []).map((row) => row[0]));
  const bindingNames = new Set((taskBindings || []).map((row) => row.name));
  if (matrixNames.size !== bindingNames.size) {
    problems.push("discovery matrix and task bindings differ in size");
  }
  for (const name of matrixNames) {
    if (!bindingNames.has(name)) problems.push(`matrix family lacks task binding: ${name}`);
  }
  for (const name of bindingNames) {
    if (!matrixNames.has(name)) problems.push(`task binding missing from matrix: ${name}`);
  }
  for (const row of matrix || []) {
    const [name, task, availability, renderOwner, disposition, placement] = row;
    const binding = (taskBindings || []).find((candidate) => candidate.name === name);
    if (!task || !availability) problems.push(`matrix row lacks task or availability: ${name}`);
    if (!renderOwner) problems.push(`matrix row lacks render owner: ${name}`);
    if (!CAPABILITY_TASK_DISPOSITIONS.includes(disposition)) {
      problems.push(`unsupported capability disposition for ${name}: ${disposition}`);
    }
    if (binding) {
      if (binding.task !== task) problems.push(`matrix task drift for ${name}`);
      if (binding.render_owner !== renderOwner) problems.push(`matrix render owner drift for ${name}`);
      if (binding.placement !== placement) problems.push(`matrix placement drift for ${name}`);
    }
  }

  const mcpNameSet = mcpToolNames == null ? null : new Set(mcpToolNames);
  for (const binding of taskBindings || []) {
    if (!Object.values(AFFORDANCE_ACTION_ROLES).includes(binding.action_role)) {
      problems.push(`unsupported action role for ${binding.name}`);
    }
    if (!CAPABILITY_TASK_PLACEMENTS.includes(binding.placement)) {
      problems.push(`unsupported task mapping for ${binding.name}: ${binding.placement}`);
    }
    if (binding.guide_topic && !guideHelp?.[binding.guide_topic]) {
      problems.push(`dangling guide topic for ${binding.name}: ${binding.guide_topic}`);
    }
    if (binding.requires_mcp && (!binding.mcp_tools || binding.mcp_tools.length === 0)) {
      problems.push(`MCP-required task has no tools: ${binding.name}`);
    }
    if (mcpNameSet) {
      for (const tool of binding.mcp_tools || []) {
        if (!mcpNameSet.has(tool)) problems.push(`unknown MCP binding for ${binding.name}: ${tool}`);
      }
    }
    if (binding.analytics_event && !DISCOVERY_ANALYTICS_ALLOWLIST.includes(binding.analytics_event)) {
      problems.push(`analytics event outside discovery allowlist: ${binding.analytics_event}`);
    }
    if (!binding.render_owner) problems.push(`absent render owner for ${binding.name}`);
  }

  const seenSurfaces = new Set();
  for (const family of pageFamilies || []) {
    if (seenSurfaces.has(family.surface_id)) {
      problems.push(`duplicate page family: ${family.surface_id}`);
    }
    seenSurfaces.add(family.surface_id);
    if (!PAGE_FAMILY_DISPOSITIONS.includes(family.disposition)) {
      problems.push(`unknown disposition for ${family.surface_id}: ${family.disposition}`);
    }
    if (!family.render_owner) problems.push(`absent render owner for page family ${family.surface_id}`);
    if (family.disposition === "justified_omission") {
      if (!family.omission_reason) problems.push(`omission lacks reason: ${family.surface_id}`);
      if (family.ai_entry) problems.push(`omission must not claim an ai entry: ${family.surface_id}`);
    } else if (family.disposition !== "introduction" && !family.ai_entry) {
      problems.push(`family lacks ai entry placement: ${family.surface_id}`);
    }
  }

  if (INTRODUCTION_FAMILY.disposition !== "introduction" || INTRODUCTION_FAMILY.path !== GENERIC_AI_INTRODUCTION_PATH) {
    problems.push("introduction family drifted from /use-with-ai/");
  }

  if (Array.isArray(publishedSurfaceIds)) {
    const published = new Set(publishedSurfaceIds);
    for (const id of published) {
      if (!seenSurfaces.has(id)) problems.push(`published surface missing discovery census: ${id}`);
    }
    for (const id of seenSurfaces) {
      if (!published.has(id)) problems.push(`discovery census names unpublished surface: ${id}`);
    }
  }

  if (chromeSource && !/renderAskWithAiLink/.test(chromeSource)) {
    problems.push("shared document chrome no longer mounts Ask with AI");
  }

  if (analyticsSource) {
    if (/completed[_-]?external[_-]?connection|mcp[_-]?connected|assistant[_-]?connected/.test(analyticsSource)) {
      problems.push("analytics must not treat a click as a completed external connection");
    }
    if (/retrieve_cited_passages|CT\d{10,}|@gmail\.|session_id\s*[:=]/.test(analyticsSource)) {
      problems.push("analytics source appears to carry research text or personal identifiers");
    }
  }

  if (renderOwnerSources) {
    const sources = renderOwnerSources instanceof Map
      ? renderOwnerSources
      : new Map(Object.entries(renderOwnerSources));
    for (const family of pageFamilies || []) {
      if (family.disposition === "justified_omission") continue;
      const source = sources.get(family.render_owner);
      if (source == null) {
        problems.push(`missing render owner source: ${family.render_owner}`);
        continue;
      }
      if (family.disposition === "standalone_link" && !/use-with-ai/.test(source)) {
        problems.push(`standalone template missing Ask with AI link: ${family.render_owner}`);
      }
    }
  }

  const introRole = affordanceActionRole({ href: GENERIC_AI_INTRODUCTION_PATH });
  if (introRole !== AFFORDANCE_ACTION_ROLES.navigate) {
    problems.push("Ask with AI introduction must classify as navigate");
  }
  const calendarRole = affordanceActionRole({ href: "webcal://example.test/feed.ics" });
  if (calendarRole !== AFFORDANCE_ACTION_ROLES.handoff) {
    problems.push("calendar subscription URLs must classify as handoff");
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    contract_id: DISCOVERY_CONTRACT_ID,
    page_family_count: (pageFamilies || PAGE_FAMILY_DISCOVERY).length,
    task_count: (taskBindings || CAPABILITY_TASK_BINDINGS).length,
  });
}

/**
 * Behavioral negative checks: each mutation must make validation fail for the
 * stated reason class rather than pass because nearby prose still exists.
 */
export function mutateDiscoveryContract(kind) {
  if (kind === "remove_required_entry") {
    return {
      pageFamilies: PAGE_FAMILY_DISCOVERY.filter((row) => row.surface_id !== "home"),
      publishedSurfaceIds: pageFamilySurfaceIds(),
    };
  }
  if (kind === "duplicate_control") {
    const home = PAGE_FAMILY_DISCOVERY.find((row) => row.surface_id === "home");
    return {
      pageFamilies: [...PAGE_FAMILY_DISCOVERY, { ...home, ai_entry: "duplicate-mast" }],
    };
  }
  if (kind === "drop_scope") {
    return {
      taskBindings: CAPABILITY_TASK_BINDINGS.map((row) => (
        row.name === "Evidence"
          ? { ...row, guide_topic: "missing-guide-topic", mcp_tools: ["not_a_real_mcp_tool"] }
          : row
      )),
      mcpToolNames: ["list_capability_gaps", "retrieve_cited_passages", "analyze_contracts"],
    };
  }
  if (kind === "unsupported_task_mapping") {
    return {
      taskBindings: CAPABILITY_TASK_BINDINGS.map((row) => (
        row.name === "Calendar"
          ? { ...row, placement: "row_toolbar" }
          : row
      )),
      mcpToolNames: ["list_capability_gaps", "retrieve_cited_passages", "analyze_contracts"],
    };
  }
  throw new Error(`unknown discovery mutation: ${kind}`);
}

export function validateMutatedDiscovery(kind, baseOptions = {}) {
  const mutation = mutateDiscoveryContract(kind);
  return validateDiscoveryContract({ ...baseOptions, ...mutation });
}
