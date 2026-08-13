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

function activateTab(html, tab) {
  let out = html
    .replaceAll('class="tabbtn active"', 'class="tabbtn"')
    .replaceAll('class="tabpane active"', 'class="tabpane"');
  const groupPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-route-facets="[^\"]*\\b${tab}\\b[^\"]*")`);
  const tabPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-tab="${tab}")`);
  const grouped = out.replace(groupPattern, 'class="tabbtn active"$1');
  out = grouped.includes('class="tabbtn active"')
    ? grouped
    : out.replace(tabPattern, 'class="tabbtn active"$1');
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
    <p class="now-back"><a href="/browse/">Browse city topics</a></p>
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
    description: "Browse NYC contracts, staffing, zoning, property, rules, and meetings from linked public sources.",
    canonical: canonicalRoute("/browse/"),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, "browse");
  html = addRouteStyles(html, ["browse.css"]);
  const landing = buildBrowseLanding(payloads, options);
  return replaceElementContent(html, "browseview", renderBrowseLanding(landing));
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
  html = activateTab(html, config.tab);
  html = addRouteStyles(html, ["browse.css"]);
  return replaceElementContent(html, "browseview", renderBrowseConceptLanding(buildBrowseConceptLanding(kind, sources)));
}
