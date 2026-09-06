/**
 * Author-friendly source format for the public guide.
 *
 * Guide prose is written as Markdown-with-front-matter under `site/guide/_articles/`
 * (plus `site/guide/_home.md` for the guide home). This module is the only reader of
 * that format: it parses one source file into a plain object and renders its body with
 * a deliberately small block/inline subset. `site/guide_view.mjs` turns the result into
 * a document and `tools/build_guide_documents.mjs` writes it.
 *
 * Two properties this format exists to protect:
 *
 * * `last_reviewed` is a date an editor wrote down after checking the article against
 *   the live product. It is required, it is parsed from the source, and nothing here
 *   reads a clock — a rebuild of unchanged sources produces byte-identical documents.
 * * The subset is small on purpose. An article that needs a construct this parser does
 *   not have is a signal to reconsider the article, not to grow a documentation
 *   platform. Unknown syntax fails the build rather than rendering as literal text.
 *
 * Sources live under an underscore-prefixed directory, which the public-site payload
 * walker already skips, so the Markdown is tracked and reviewable without becoming a
 * published route.
 *
 * Two constructs exist for reference articles, whose reading situation is lookup
 * rather than narrative:
 *
 * * A pipe table, which must carry a header row and follow a heading. The heading
 *   names the scrollable region, so a table can never reach a reader as an
 *   unlabelled box they can scroll but not name.
 * * `::: <name>`, one line, which drops in a table an owner generates. It is how a
 *   reference page shows something the registry knows without a second copy of it
 *   being typed here by hand. An unknown name fails the build.
 */

/** Reader-facing section labels. These are the guide's contract with its readers. */
export const GUIDE_GROUPS = Object.freeze([
  Object.freeze({ id: "start", label: "Start here", type: "tutorial", path: "start" }),
  Object.freeze({ id: "how-to", label: "How to…", type: "how-to", path: "how-to" }),
  Object.freeze({ id: "understand", label: "Understand", type: "explanation", path: "understand" }),
  Object.freeze({ id: "reference", label: "Reference", type: "reference", path: "reference" }),
]);

const GROUP_BY_TYPE = new Map(GUIDE_GROUPS.map((group) => [group.type, group]));

/** Front-matter keys whose value is a list of `label | href` items. */
const LINK_LIST_KEYS = new Set(["related", "sources", "examples"]);
/** Front-matter keys whose value is a single `label | href` item. */
const LINK_KEYS = new Set(["return_to_task"]);

/**
 * Review metadata: lists of bare identifiers rather than links.
 *
 * These name what an article is coupled to, so a change to the product can be
 * mapped back to the articles that might now be wrong. They are read by
 * `site/guide_review_source.mjs` and are not rendered: an identifier is a
 * maintenance fact, not something a reader is shown.
 */
const ID_LIST_KEYS = new Set([
  "demos",
  "historical_demos",
  "capabilities",
  "source_contracts",
  "depends_on",
]);

const REQUIRED_ARTICLE_KEYS = [
  "id",
  "type",
  "title",
  "url",
  "reader_question",
  "purpose",
  "last_reviewed",
  "description",
  "return_to_task",
];

/**
 * The complete set of keys an article source may carry. An unknown key fails the
 * build rather than being ignored, which is what keeps private review state —
 * an assignee, a queue position, a desk link — out of a public source file: there
 * is no key it could be written under.
 */
const ALLOWED_ARTICLE_KEYS = new Set([
  ...REQUIRED_ARTICLE_KEYS,
  ...LINK_LIST_KEYS,
  ...ID_LIST_KEYS,
  "page_title",
  "published",
  "updated",
  "correction",
  "historical_note",
]);

const ALLOWED_HOME_KEYS = new Set([
  "title",
  "page_title",
  "description",
  "purpose",
  "last_reviewed",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Optional editorial dates. `last_reviewed` stays required and is checked separately. */
const OPTIONAL_DATE_KEYS = ["published", "updated"];

// Identifier shapes. Each one is owned somewhere else — the demo manifest, the
// frozen capability registry, the source-contract registry, the repository tree —
// so these only reject a value that could not name anything there.
const DEMO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITY_REFERENCE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)*@[1-9]\d*$/;
const SOURCE_CONTRACT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// A dependency needs at least two path segments. One segment is a whole top-level
// directory, and an article that declares `site` is stale every time anything at
// all changes, which is the same as declaring nothing.
const DEPENDENCY_PATH = /^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)+$/;

const ID_LIST_SHAPES = new Map([
  ["demos", { pattern: DEMO_ID, what: "a demo id from site/demo/demo-links.json" }],
  ["historical_demos", { pattern: DEMO_ID, what: "a demo id from site/demo/demo-links.json" }],
  ["capabilities", { pattern: CAPABILITY_REFERENCE, what: "a capability reference such as notice.get@1" }],
  ["source_contracts", { pattern: SOURCE_CONTRACT_ID, what: "a source-contract id" }],
  ["depends_on", { pattern: DEPENDENCY_PATH, what: "a repository path with at least two segments" }],
]);

/**
 * Values that would mean a private review lane leaked into a public source file.
 * The same shapes the public product-updates artifact refuses.
 */
const PRIVATE_LEAK = /(?:\/Users\/|\/var\/folders|file:\/\/|127\.0\.0\.1|localhost|ADMIN_KEY|cityscroll-internal|desk\.cityscroll\.org|operator[_ -]?state)/i;

// The site-wide page-metadata gate (civic-content-gates) reads a rendered page and
// requires a 120-160 character description and a title under 60 characters carrying
// the house separator. Checking the same bounds against the source means an author
// is told which article is wrong, not which generated file is.
const MIN_DESCRIPTION = 120;
const MAX_DESCRIPTION = 160;
const MAX_PAGE_TITLE = 60;
const TITLE_SEPARATOR = "\u00b7";

function validateMetadata(sourceName, { description, page_title: pageTitle }) {
  // The rendered attribute is what the gate measures, and escaping an apostrophe
  // costs five characters, so measure the escaped form here too.
  const length = escapeHtml(description).length;
  if (length < MIN_DESCRIPTION || length > MAX_DESCRIPTION) {
    fail(sourceName, `description must be ${MIN_DESCRIPTION}-${MAX_DESCRIPTION} characters, got ${length}`);
  }
  if (pageTitle === undefined) return;
  if (escapeHtml(pageTitle).length >= MAX_PAGE_TITLE) {
    fail(sourceName, `page_title must be under ${MAX_PAGE_TITLE} characters, got ${escapeHtml(pageTitle).length}`);
  }
  if (!String(pageTitle).includes(TITLE_SEPARATOR)) {
    fail(sourceName, `page_title must carry the site title separator ${TITLE_SEPARATOR}`);
  }
}

export class GuideSourceError extends Error {}

function fail(sourceName, message) {
  throw new GuideSourceError(`${sourceName}: ${message}`);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function parseLinkItem(sourceName, key, raw) {
  const [label, href, ...rest] = String(raw).split("|").map((part) => part.trim());
  if (!label || !href || rest.length) {
    fail(sourceName, `${key} must be written as "label | href", got ${JSON.stringify(raw)}`);
  }
  return { label, href };
}

/**
 * Split `---` front matter from the body and parse the flat key/value block.
 * Values are either a scalar on the key line or a `- ` list indented beneath it.
 */
function parseFrontMatter(sourceName, text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) fail(sourceName, "must open with a --- front-matter block");
  const end = normalized.indexOf("\n---\n", 3);
  if (end === -1) fail(sourceName, "front-matter block is not closed with ---");
  const head = normalized.slice(4, end + 1);
  const body = normalized.slice(end + 5);

  const fields = {};
  let currentKey = null;
  for (const [index, line] of head.split("\n").entries()) {
    if (!line.trim()) { currentKey = null; continue; }
    const where = `front matter line ${index + 1}`;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (!currentKey) fail(sourceName, `${where}: list item has no key above it`);
      fields[currentKey].push(listItem[1].trim());
      continue;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) fail(sourceName, `${where}: expected "key: value", got ${JSON.stringify(line)}`);
    const [, key, value] = pair;
    if (key in fields) fail(sourceName, `${where}: duplicate key ${key}`);
    if (value === "") { fields[key] = []; currentKey = key; continue; }
    fields[key] = value.trim();
    currentKey = null;
  }
  return { fields, body };
}

function parseIdList(sourceName, key, value) {
  if (!Array.isArray(value)) fail(sourceName, `${key} must be a list of bare identifiers`);
  const { pattern, what } = ID_LIST_SHAPES.get(key);
  const seen = new Set();
  return value.map((raw) => {
    const item = String(raw).trim();
    if (!pattern.test(item)) fail(sourceName, `${key} entry ${JSON.stringify(item)} is not ${what}`);
    if (seen.has(item)) fail(sourceName, `${key} lists ${JSON.stringify(item)} twice`);
    seen.add(item);
    return item;
  });
}

function rejectPrivateValues(sourceName, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
    if (PRIVATE_LEAK.test(text)) {
      fail(sourceName, `${key} carries a private path, host, or credential and cannot be published`);
    }
  }
}

function rejectUnknownKeys(sourceName, fields, allowed) {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) fail(sourceName, `unknown front-matter key ${JSON.stringify(key)}`);
  }
}

function normalizeFields(sourceName, fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (LINK_LIST_KEYS.has(key)) {
      if (!Array.isArray(value)) fail(sourceName, `${key} must be a list of "label | href" items`);
      out[key] = value.map((item) => parseLinkItem(sourceName, key, item));
    } else if (LINK_KEYS.has(key)) {
      if (Array.isArray(value)) fail(sourceName, `${key} must be a single "label | href" item`);
      out[key] = parseLinkItem(sourceName, key, value);
    } else if (ID_LIST_KEYS.has(key)) {
      out[key] = parseIdList(sourceName, key, value);
    } else if (Array.isArray(value)) {
      fail(sourceName, `${key} does not take a list`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The dates, the identifier lists, and the two notices that depend on them.
 *
 * `last_reviewed` is the editor's date and is checked by the caller. The rest are
 * maintenance facts, and the only ordering asserted here is the one that cannot be
 * true otherwise: nothing is updated or reviewed before it was published. A review
 * date that is older than the update date is not an error — it is precisely the
 * signal the review lane exists to raise.
 */
function validateReviewMetadata(sourceName, article) {
  for (const key of OPTIONAL_DATE_KEYS) {
    if (article[key] === undefined) continue;
    if (!ISO_DATE.test(article[key])) {
      fail(sourceName, `${key} must be an explicit YYYY-MM-DD date, got ${JSON.stringify(article[key])}`);
    }
  }
  if (article.published) {
    for (const key of ["updated", "last_reviewed"]) {
      if (article[key] && article[key] < article.published) {
        fail(sourceName, `${key} ${article[key]} is before published ${article.published}`);
      }
    }
  }
  const demos = new Set(article.demos || []);
  for (const id of article.historical_demos || []) {
    if (!demos.has(id)) fail(sourceName, `historical_demos entry ${JSON.stringify(id)} is not in demos`);
  }
  if ((article.historical_demos || []).length && !article.historical_note) {
    // A dated example that is not labelled reads as a current invitation to act.
    fail(sourceName, "an article with historical_demos must carry a historical_note explaining what has closed");
  }
  if (article.historical_note !== undefined && !(article.historical_demos || []).length) {
    fail(sourceName, "historical_note has no historical_demos to explain");
  }
}

/* ---------------------------------------------------------------- rendering */

function renderInline(sourceName, text) {
  // Escape first, then re-introduce the handful of inline forms the subset allows,
  // so author text can never inject markup.
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, (_, strong) => `<strong>${strong}</strong>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const external = /^https?:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
  });
  const leftover = html.match(/\[[^\]]*\]\([^)]*\)/);
  if (leftover) fail(sourceName, `link ${leftover[0]} is not written as [label](href)`);
  return html;
}

/**
 * A table, wrapped in the region that carries its accessible name.
 *
 * The wrapper scrolls sideways when a table is wider than a narrow screen, and a
 * region that scrolls has to be reachable from the keyboard, so it takes focus and
 * carries a name. `label` is the name; a spec that also wants the name shown gives
 * a `caption`.
 */
function renderTable(sourceName, { label, caption, columns, rows }) {
  if (!label) fail(sourceName, "a table needs a name — put it under a heading, or give the generated table a caption");
  if (!columns?.length) fail(sourceName, "a table needs a header row");
  const cells = (values, tag) => values
    .map((value) => `<${tag}${tag === "th" ? ' scope="col"' : ""}>${renderInline(sourceName, value)}</${tag}>`)
    .join("");
  for (const row of rows) {
    if (row.length !== columns.length) {
      fail(sourceName, `table row has ${row.length} cells but the header has ${columns.length}: ${JSON.stringify(row.join(" | "))}`);
    }
  }
  const captionHtml = caption ? `<caption>${renderInline(sourceName, caption)}</caption>` : "";
  const body = rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("");
  return `<div class="guide-table" role="region" tabindex="0" aria-label="${escapeHtml(label)}">`
    + `<table>${captionHtml}<thead><tr>${cells(columns, "th")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Split one `| a | b |` line into its cells. */
function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderBlocks(sourceName, body, includes = {}) {
  const lines = body.split("\n");
  const html = [];
  let index = 0;
  // A table takes its accessible name from the heading it sits under, so the
  // heading a reader has just read is also what a screen reader announces.
  let heading = null;

  const takeWhile = (predicate) => {
    const taken = [];
    while (index < lines.length && predicate(lines[index])) taken.push(lines[index++]);
    return taken;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const headingMatch = line.match(/^(#{2,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      heading = headingMatch[2].trim();
      html.push(`<h${level}>${renderInline(sourceName, heading)}</h${level}>`);
      index += 1;
      continue;
    }

    const include = line.match(/^:::\s+([a-z][a-z0-9-]*)\s*$/);
    if (include) {
      const spec = includes[include[1]];
      if (!spec) fail(sourceName, `no owner generates a "${include[1]}" table`);
      html.push(renderTable(sourceName, { label: spec.caption || heading, ...spec }));
      index += 1;
      continue;
    }

    if (line.trim().startsWith("|")) {
      const rows = takeWhile((candidate) => candidate.trim().startsWith("|"));
      if (rows.length < 3 || !TABLE_DIVIDER.test(rows[1])) {
        fail(sourceName, "a table needs a header row, a --- divider row, and at least one row of its own");
      }
      html.push(renderTable(sourceName, {
        label: heading,
        columns: tableCells(rows[0]),
        rows: rows.slice(2).map(tableCells),
      }));
      continue;
    }

    if (/^>\s+/.test(line)) {
      const quoted = takeWhile((candidate) => /^>\s+/.test(candidate))
        .map((candidate) => candidate.replace(/^>\s+/, "").trim())
        .join(" ");
      const labelled = quoted.match(/^([A-Z][^:]{0,40}):\s*(.*)$/);
      const inner = labelled
        ? `<strong>${renderInline(sourceName, labelled[1])}:</strong> ${renderInline(sourceName, labelled[2])}`
        : renderInline(sourceName, quoted);
      html.push(`<p class="guide-checkpoint">${inner}</p>`);
      continue;
    }

    if (/^-\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const pattern = ordered ? /^\d+\.\s+/ : /^-\s+/;
      // A list runs until a blank line or another kind of block. A line inside it
      // that carries no marker continues the item above, so an author can wrap a
      // long point across lines the way they would in any other Markdown.
      const raw = takeWhile((candidate) => candidate.trim()
        && !/^(#{2,3}\s|>\s)/.test(candidate)
        && (pattern.test(candidate) || !/^(-\s|\d+\.\s)/.test(candidate)));
      const items = [];
      for (const candidate of raw) {
        if (pattern.test(candidate)) items.push(candidate.replace(pattern, "").trim());
        else if (items.length) items[items.length - 1] += ` ${candidate.trim()}`;
        else fail(sourceName, `list continuation with no item above it: ${JSON.stringify(candidate)}`);
      }
      const rendered = items.map((item) => `<li>${renderInline(sourceName, item)}</li>`);
      html.push(`<${ordered ? "ol" : "ul"}>${rendered.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    if (/^[#*_|<]/.test(line)) {
      fail(sourceName, `unsupported block starting ${JSON.stringify(line.slice(0, 40))}`);
    }

    const paragraph = takeWhile((candidate) => candidate.trim() && !/^(#{2,3}\s|>\s|-\s|\d+\.\s)/.test(candidate));
    html.push(`<p>${renderInline(sourceName, paragraph.map((part) => part.trim()).join(" "))}</p>`);
  }
  return html.join("\n");
}

/**
 * Split a body into `## Heading` sections, keeping each section's rendered HTML.
 * Used by the guide home, whose sections are addressed by name.
 */
export function splitSections(sourceName, body) {
  const sections = new Map();
  let heading = null;
  let buffer = [];
  const flush = () => {
    if (heading !== null) sections.set(heading, renderBlocks(sourceName, buffer.join("\n")));
  };
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^##\s+(.*)$/);
    if (match) {
      flush();
      heading = match[1].trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

export function groupForType(type) {
  return GROUP_BY_TYPE.get(type) || null;
}

/** Parse one article source file. Throws GuideSourceError on anything malformed. */
export function parseGuideArticle(sourceName, text, includes = {}) {
  const { fields, body } = parseFrontMatter(sourceName, text);
  rejectUnknownKeys(sourceName, fields, ALLOWED_ARTICLE_KEYS);
  rejectPrivateValues(sourceName, fields);
  const article = normalizeFields(sourceName, fields);

  for (const key of REQUIRED_ARTICLE_KEYS) {
    if (article[key] === undefined) fail(sourceName, `missing required front-matter key: ${key}`);
  }
  validateMetadata(sourceName, {
    ...article,
    page_title: article.page_title ?? `${article.title} ${TITLE_SEPARATOR} CityScroll`,
  });
  if (!groupForType(article.type)) {
    fail(sourceName, `unknown type ${JSON.stringify(article.type)}; expected one of ${GUIDE_GROUPS.map((g) => g.type).join(", ")}`);
  }
  if (!ISO_DATE.test(article.last_reviewed)) {
    fail(sourceName, `last_reviewed must be an explicit YYYY-MM-DD date an editor recorded, got ${JSON.stringify(article.last_reviewed)}`);
  }
  const group = groupForType(article.type);
  const expectedPrefix = `/guide/${group.path}/`;
  if (!article.url.startsWith(expectedPrefix) || !article.url.endsWith("/")) {
    fail(sourceName, `url must start with ${expectedPrefix} and end with /, got ${JSON.stringify(article.url)}`);
  }
  if (!body.trim()) fail(sourceName, "article body is empty");
  validateReviewMetadata(sourceName, article);

  return {
    ...article,
    group,
    related: article.related || [],
    sources: article.sources || [],
    examples: article.examples || [],
    demos: article.demos || [],
    historical_demos: article.historical_demos || [],
    capabilities: article.capabilities || [],
    source_contracts: article.source_contracts || [],
    depends_on: article.depends_on || [],
    published: article.published ?? null,
    updated: article.updated ?? null,
    correction: article.correction ?? null,
    historical_note: article.historical_note ?? null,
    bodyHtml: renderBlocks(sourceName, body, includes),
  };
}

/** Parse the guide-home source: front matter plus one section per named heading. */
export function parseGuideHome(sourceName, text) {
  const { fields, body } = parseFrontMatter(sourceName, text);
  rejectUnknownKeys(sourceName, fields, ALLOWED_HOME_KEYS);
  rejectPrivateValues(sourceName, fields);
  const home = normalizeFields(sourceName, fields);
  for (const key of ["title", "page_title", "description", "last_reviewed", "purpose"]) {
    if (home[key] === undefined) fail(sourceName, `missing required front-matter key: ${key}`);
  }
  validateMetadata(sourceName, home);
  if (!ISO_DATE.test(home.last_reviewed)) {
    fail(sourceName, `last_reviewed must be an explicit YYYY-MM-DD date, got ${JSON.stringify(home.last_reviewed)}`);
  }
  const sections = splitSections(sourceName, body);
  for (const heading of ["Orientation", ...GUIDE_GROUPS.map((group) => group.label), "About this guide"]) {
    if (!sections.get(heading)) fail(sourceName, `guide home is missing a "## ${heading}" section`);
  }
  return { ...home, sections };
}
