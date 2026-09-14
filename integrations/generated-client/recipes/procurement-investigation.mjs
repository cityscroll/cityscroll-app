import { CAPABILITY_MANIFEST, IntegrationClientError, createIntegrationClient } from "../index.mjs";

const RECIPE = "procurement-investigation";
const ANALYSIS_REFERENCE = "contracts.analysis@1";
const BROWSE_REFERENCE = "contracts.browse@1";
const GET_REFERENCE = "contract.get@1";
const DEFAULT_REQUEST_CAP = 6;

function operation(reference, tool) {
  const advertised = CAPABILITY_MANIFEST.capabilities.find((entry) => entry.reference === reference);
  if (!advertised || advertised.tool !== tool) throw new IntegrationClientError("procurement recipe capability manifest mismatch", { reference, tool });
  return advertised;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationClientError(name + " must be an object");
  return value;
}

function budget(options = {}) {
  const cap = options.requestCap ?? DEFAULT_REQUEST_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > DEFAULT_REQUEST_CAP) throw new IntegrationClientError("procurement recipe request cap must be an integer from 1 through 6");
  let used = 0;
  return { take() { if (++used > cap) throw new IntegrationClientError("procurement recipe request cap exceeded", { cap, used }); } };
}

function wireInput(input = {}) {
  object(input, "recipe input");
  return { ...input };
}

function continuationArguments(value) {
  const published = object(value, "group continuation");
  if (published.capability !== BROWSE_REFERENCE) throw new IntegrationClientError("group continuation names an undeclared capability", { capability: published.capability });
  const args = object(published.arguments, "group continuation arguments");
  operation(BROWSE_REFERENCE, "browse_contracts");
  if (args.population !== "registered" || typeof args.group_by !== "string" || typeof args.group_label !== "string") throw new IntegrationClientError("group continuation must publish a registered exact group");
  const allowed = new Set(["population", "fiscal_year", "amount_band", "retroactive", "city_record_match", "group_by", "group_label", "agency", "vendor", "min_amount", "max_amount", "limit", "cursor"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new IntegrationClientError("group continuation contains undeclared arguments");
  if (args.cursor !== undefined && typeof args.cursor !== "string") throw new IntegrationClientError("group continuation cursor is invalid");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new IntegrationClientError("group continuation limit is invalid");
  return { published, args };
}

function unchangedExceptPaging(left, right) {
  const strip = (value) => { const copy = { ...value }; delete copy.cursor; delete copy.limit; return copy; };
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

function continuationFromGroup(group) {
  object(group, "group");
  const { published, args } = continuationArguments(group.browse);
  return { ...published, arguments: { ...args }, original_arguments: { ...args }, scope: { group_by: args.group_by, group_label: args.group_label, agency: args.agency ?? null, fiscal_year: args.fiscal_year ?? null } };
}

export async function discoverAgencies(client = createIntegrationClient(), input = {}, options = {}) {
  operation(ANALYSIS_REFERENCE, "analyze_contracts");
  const requests = budget(options);
  const analysisInput = wireInput(input);
  delete analysisInput.agency;
  requests.take();
  const analysis = await client.contractsAnalysis(analysisInput);
  return { recipe: RECIPE, scope: { ...analysisInput }, discovery: analysis.filters?.discovery?.agency ?? null, analysis };
}

export async function readGroups(client = createIntegrationClient(), input = {}, options = {}) {
  operation(ANALYSIS_REFERENCE, "analyze_contracts");
  const requests = budget(options);
  const analysisInput = wireInput(input);
  if (typeof analysisInput.agency !== "string" || !analysisInput.agency) throw new IntegrationClientError("readGroups requires an exact returned agency label");
  requests.take();
  const analysis = await client.contractsAnalysis(analysisInput);
  const groups = analysis.groups ?? [];
  return { recipe: RECIPE, scope: { ...analysisInput }, analysis, groups, continuations: groups.map(continuationFromGroup) };
}

export async function readGroupPage(client = createIntegrationClient(), continuation, options = {}) {
  const requests = budget(options);
  const candidate = object(continuation, "group continuation");
  const { published, args } = continuationArguments(candidate);
  if (candidate.original_arguments && !unchangedExceptPaging(args, candidate.original_arguments)) throw new IntegrationClientError("mutated group continuation rejected");
  const input = { ...args };
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > (args.limit ?? 100)) throw new IntegrationClientError("group continuation limit must be equal to or smaller than the published limit");
    input.limit = options.limit;
  }
  requests.take();
  const page = await client.contractsBrowse(input);
  const nextCursor = page.pagination?.next_cursor ?? null;
  const nextContinuation = nextCursor ? { ...published, arguments: { ...args, cursor: nextCursor, ...(options.limit === undefined ? {} : { limit: options.limit }) }, original_arguments: { ...(candidate.original_arguments ?? args) }, scope: candidate.scope } : null;
  return { recipe: RECIPE, scope: candidate.scope ?? { group_by: input.group_by, group_label: input.group_label }, continuation: published, page, next_continuation: nextContinuation };
}

export async function readContractReference(client = createIntegrationClient(), reference, options = {}) {
  operation(GET_REFERENCE, "get_contract");
  const requests = budget(options);
  const published = object(reference, "contract reference");
  const procurementId = published.procurement_id;
  if (procurementId === null || procurementId === undefined) return { recipe: RECIPE, scope: published.scope ?? null, reference: published, detail: { availability: "unavailable", contract: null, error: "not-published" } };
  if (typeof procurementId !== "string" || !procurementId.startsWith("procurement:")) throw new IntegrationClientError("contract reference procurement_id is not an exact published identity");
  requests.take();
  const detail = await client.contractGet({ procurement_id: procurementId });
  return { recipe: RECIPE, scope: published.scope ?? null, reference: published, detail };
}
