import {
  BROWSE_FACETS,
  buildBrowseLanding,
  buildBrowseView,
  renderBrowseLanding,
  renderBrowseView,
} from "./browse_view.mjs";
import { buildNowSurface } from "./now_surface.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import { BROWSE_CONCEPTS, buildBrowseConceptLanding, renderBrowseConceptLanding } from "./browse_concept_view.mjs";
import { renderNodeBack } from "./civic_document_chrome.mjs";
import { BROWSE_ROUTE_ALIASES } from "./browse_route_aliases.mjs";

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findElementRange(html, id) {
  const pattern = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i");
  const opening = pattern.exec(html);
  if (!opening) throw new Error(`Missing #${id} in document shell`);
  const tag = opening[1].toLowerCase();
  const tokens = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "ig");
  tokens.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let tagMatch;
  while ((tagMatch = tokens.exec(html))) {
    depth += tagMatch[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return {
        openingStart: opening.index,
        contentStart: opening.index + opening[0].length,
        contentEnd: tagMatch.index,
        closingEnd: tagMatch.index + tagMatch[0].length,
      };
    }
  }
  throw new Error(`Unclosed #${id} in document shell`);
}

export function replaceElementContent(html, id, content) {
  const range = findElementRange(html, id);
  return `${html.slice(0, range.contentStart)}${content}${html.slice(range.contentEnd)}`;
}

function activateTabButton(html, tab) {
  let out = html.replaceAll('class="tabbtn active"', 'class="tabbtn"');
  const groupPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-route-facets="[^\"]*\\b${tab}\\b[^\"]*")`);
  const tabPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-tab="${tab}")`);
  const grouped = out.replace(groupPattern, 'class="tabbtn active"$1');
  return grouped.includes('class="tabbtn active"')
    ? grouped
    : out.replace(tabPattern, 'class="tabbtn active"$1');
}

function activateTab(html, tab) {
  let out = activateTabButton(
    html.replaceAll('class="tabpane active"', 'class="tabpane"'),
    tab,
  );
  out = out.replace(`id="tab-${tab}" class="tabpane"`, `id="tab-${tab}" class="tabpane active"`);
  return out;
}

function pageMetadata(html, { title, description, canonical, primaryHref, primaryContext }) {
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(canonical)}">`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replace("<main id=\"main\"", '<main id="main" data-document-rendered="true"');
  if (primaryContext) {
    if (/<body\b[^>]*\bdata-primary-context=/i.test(out)) {
      out = out.replace(/(<body\b[^>]*\bdata-primary-context=")[^"]*(")/i, `$1${esc(primaryContext)}$2`);
    } else {
      out = out.replace(/<body\b/i, `<body data-primary-context="${esc(primaryContext)}"`);
    }
  }
  if (!/<base\b/i.test(out)) out = out.replace("<head>", '<head>\n<base href="/">');
  if (primaryHref) {
    out = out.replace(`href="${primaryHref}"`, `href="${primaryHref}" aria-current="page"`);
  }
  return out;
}

function addRouteStyles(html, paths) {
  const links = paths
    .filter((path) => !html.includes(`href="${path}"`))
    .map((path) => `<link rel="stylesheet" href="${path}" data-route-style="${path}">`)
    .join("\n");
  return links ? html.replace("</head>", `${links}\n</head>`) : html;
}

function canonicalRoute(route) {
  return `https://cityscroll.org${route}`;
}

function routeHref(route) {
  if (/^#notice\//.test(route || "")) return migrateLegacyUrl(`/${route}`).target;
  if (/^#/.test(route || "")) return `/${route}`;
  return route || "/browse/";
}

function staticAction(matter) {
  if (matter?.kind === "exam" && matter.official_application_url) {
    return [{
      type: "official_application",
      delivery: "official_handoff",
      destination: matter.official_application_url,
    }];
  }
  return [{ type: "bid_checklist", delivery: "local" }];
}

function nowCard(item) {
  const href = routeHref(item.route);
  const action = item.action?.destination && item.action.destination !== item.route
    ? `<a class="act primary" href="${esc(item.action.destination)}" rel="noopener noreferrer">Take action</a>`
    : `<a class="act primary" href="${esc(href)}">Open details</a>`;
  return `<article class="now-card" data-now-item="${esc(item.id)}" data-now-lane="${esc(item.lane)}">
    <div class="now-card-tags"><span class="tag ${item.lane === "act_by" ? "urgency" : "open"}">${esc(item.kind.replaceAll("_", " "))}</span><span class="tag asset">${esc(item.source.label)}</span></div>
    ${item.time?.value ? `<p class="now-card-when"><time datetime="${esc(item.time.value)}"><b>${esc(item.time.day || item.time.value)}</b></time></p>` : ""}
    <h3><a href="${esc(href)}" lang="en" dir="ltr">${esc(item.title)}</a></h3>
    ${item.agency ? `<p class="now-card-agency" lang="en" dir="ltr">${esc(item.agency)}</p>` : ""}
    <div class="actions">${action}</div>
  </article>`;
}

function nowLane(id, title, deck, items) {
  return `<section class="now-lane" aria-labelledby="${id}-title">
    <header class="now-lane-head"><div><h3 id="${id}-title">${esc(title)}</h3><p>${esc(deck)}</p></div><span class="now-count">${items.length} ${items.length === 1 ? "item" : "items"}</span></header>
    <div class="now-list" data-now-list="${id}" data-now-count="${items.length}">${items.length ? items.map(nowCard).join("") : '<div class="empty">No dated items in the bounded snapshot.</div>'}</div>
  </section>`;
}

export function renderNowBuildView(sources, today) {
  const surface = buildNowSurface(sources, { today, compileActionRail: staticAction });
  const actions = [...surface.act_by.dated, ...surface.act_by.open_without_date];
  const unavailable = surface.coverage.unavailable_sources;
  return `<div class="now-surface" data-build-rendered="now" data-generated-for="${esc(surface.generated_for)}">
    ${renderNodeBack({ href: "/browse/", label: "Browse city topics", extraClass: "now-back" })}
    <header class="now-head"><p class="now-kicker">Time + action</p><h2>Now</h2><p>Deadlines that require action and public events happening soon.</p><p class="now-bounded-note">Build-rendered from bounded public snapshots; live sources refresh when JavaScript is available.</p></header>
    ${unavailable.length ? `<div class="note warn" role="status">Live refresh adds: ${esc(unavailable.join(", "))}.</div>` : ""}
    <div class="now-lanes">${nowLane("act-by", "Act by", "Applications, responses, comments, and objections with a published date.", actions)}${nowLane("happening-soon", "Happening soon", "Hearings, meetings, auctions, effective dates, and decisions.", surface.happening_soon.items)}</div>
  </div>`;
}

export function buildNowDocument(shell, sources, options = {}) {
  const today = options.today || sources.money?.open_as_of || sources.money?.generated_at;
  let html = pageMetadata(shell, {
    title: "Now · CityScroll",
    description: "NYC public deadlines that require action and public events happening soon.",
    canonical: canonicalRoute("/now/"),
    primaryHref: "/now/",
    primaryContext: "now",
  });
  html = activateTab(html, "now");
  html = html.replace('id="nowview" hidden', 'id="nowview"');
  html = replaceElementContent(html, "browse-child-nav", "");
  return replaceElementContent(html, "nowview", renderNowBuildView(sources, today));
}

export function buildBrowseLandingDocument(shell, payloads, options = {}) {
  let html = pageMetadata(shell, {
    title: "Browse NYC’s public record · CityScroll",
    description: "Browse NYC contracts, people and organizations, land, rules, meetings, and exams from linked public sources.",
    canonical: canonicalRoute("/browse/"),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, "browse");
  html = addRouteStyles(html, ["browse.css", "walk-entry.css"]);
  const landing = buildBrowseLanding(payloads, options);
  return replaceElementContent(html, "browseview", renderBrowseLanding(landing));
}

export function buildBrowseAliasDocument(shell, aliasId, targetPayload) {
  const alias = BROWSE_ROUTE_ALIASES[aliasId];
  if (!alias) throw new Error(`Unknown Browse route alias: ${aliasId}`);
  let html = buildBrowseDocument(shell, alias.targetFacet, targetPayload, new URLSearchParams(), {
    route: alias.route,
  });
  html = pageMetadata(html, {
    title: `${alias.title} · Browse · CityScroll`,
    description: alias.description,
    canonical: canonicalRoute(alias.route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = html.replace(
    '<body data-primary-context="browse"',
    `<body data-primary-context="browse" data-browse-route-alias="${esc(aliasId)}" data-browse-route-alias-label="${esc(alias.label)}"`,
  );
  html = activateTabButton(html, alias.navigationTab);
  const examsPane = findElementRange(html, "tab-exams");
  html = `${html.slice(0, examsPane.openingStart)}${html.slice(examsPane.closingEnd)}`;
  html = html.replace('<details class="staffing-ledger" id="staffing-ledger">', '<details class="staffing-ledger" id="staffing-ledger" hidden>');
  html = html.replace(
    '<p class="career-kicker" data-i18n="staffing_pathways_kicker">City careers</p>',
    '<p class="career-kicker">Exams</p>',
  );
  html = html.replace(
    '<h2 id="career-browser-heading" class="lens-entry-heading" tabindex="-1" data-i18n="career_browser_heading">Find an exam you can act on</h2>',
    '<h2 id="career-browser-heading" class="lens-entry-heading" tabindex="-1">Civil-service exams</h2>',
  );
  return html;
}

export function buildBrowseDocument(shell, facet, payload, params = new URLSearchParams(), options = {}) {
  const config = BROWSE_FACETS[facet];
  if (!config) throw new Error(`Unknown Browse facet: ${facet}`);
  const route = options.route || (facet === "contracts" ? "/browse/" : `/browse/${facet}/`);
  const view = buildBrowseView(facet, payload, params);
  let html = pageMetadata(shell, {
    title: `${config.label} · Browse · CityScroll`,
    description: `Browse NYC ${config.label.toLowerCase()} public records by agency, place, status, date, or keyword.`,
    canonical: canonicalRoute(route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, config.tab);
  html = html.replace(`href="${config.route}"`, `href="${config.route}" aria-current="page"`);
  html = addRouteStyles(html, ["browse.css"]);
  if (facet === "property") html = addRouteStyles(html, ["property.css"]);
  return replaceElementContent(html, config.container, renderBrowseView(view));
}

export function buildBrowseConceptDocument(shell, kind, sources) {
  const config = BROWSE_CONCEPTS[kind];
  if (!config) throw new Error(`Unknown Browse concept: ${kind}`);
  let html = pageMetadata(shell, {
    title: `${config.title} · Browse · CityScroll`,
    description: config.description,
    canonical: canonicalRoute(config.route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  // Concept landings live in the Browse document pane; unlike lens routes they do
  // not have an SPA pane named after the concept. Keep the concept link selected
  // while making the actual static Browse pane visible.
  html = activateTab(html, "browse");
  html = html.replace(`class="tabbtn" href="${config.route}"`, `class="tabbtn active" href="${config.route}"`);
  html = addRouteStyles(html, ["browse.css", "local_constellation.css"]);
  const rendered = replaceElementContent(html, "browseview", renderBrowseConceptLanding(buildBrowseConceptLanding(kind, sources)));
  return kind === "people"
    ? rendered.replace("</body>", '<script type="module" src="/people_organizations.mjs"></script>\n</body>')
    : rendered;
}

function searchLane(id, title, description) {
  return `<section class="topic-search-lane" data-search-lane="${esc(id)}" aria-labelledby="search-lane-${esc(id)}">
    <header class="topic-search-lane-head"><div><h3 id="search-lane-${esc(id)}">${esc(title)}</h3><p>${esc(description)}</p></div><span class="topic-search-lane-status">Waiting</span></header>
    <div class="topic-search-lane-body" role="status">Enter a topic to search public records.</div>
  </section>`;
}

export function renderSearchDocument() {
  return `<div class="topic-search-document" data-search-document>
    <p class="topic-search-kicker">Topic search</p>
    <header class="topic-search-head"><h2 id="search-heading">What are you looking for?</h2><p>Search NYC records by topic before choosing a type of record.</p></header>
    <form class="topic-search-form" method="get" action="/search/" data-search-form>
      <label for="search-query">What are you looking for?</label>
      <div class="topic-search-form-row"><input id="search-query" name="q" type="search" maxlength="240" autocomplete="off" placeholder="Try a topic, place, or agency"><button type="submit">Search records</button></div>
      <p class="topic-search-note">You can compare Contracts, Rules, Meetings, and Mandates without choosing a type first.</p>
    </form>
    <div class="topic-search-context" data-search-place hidden></div>
    <div class="topic-search-method" aria-label="Search method"><span>Match method</span><strong>Keyword search</strong></div>
    <div class="topic-search-lanes" aria-label="Search result types">
      ${searchLane("contracts", "Contracts", "Public contract opportunities and awards.")}
      ${searchLane("rules", "Rules", "Published rules and mandates.")}
      ${searchLane("meetings", "Meetings", "Public meetings and decisions.")}
      ${searchLane("obligations", "Mandates", "Published duties and requirements.")}
    </div>
  </div>`;
}

export function buildSearchDocument(shell) {
  let html = pageMetadata(shell, {
    title: "Search NYC records · CityScroll",
    description: "Search NYC public records by topic before choosing a record type.",
    canonical: canonicalRoute("/search/"),
    primaryHref: "/browse/",
    primaryContext: "search",
  });
  html = activateTab(html, "browse");
  html = addRouteStyles(html, ["search.css"]);
  html = replaceElementContent(html, "browse-child-nav", "");
  html = replaceElementContent(html, "browseview", renderSearchDocument());
  return html
    .replace(' data-i18n-title="index_title"', "")
    .replace('<script type="module" src="app/main.mjs"></script>', '<script type="module" src="search_document.mjs"></script>');
}
