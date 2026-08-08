/** Shared CityScroll link/control grammar. Keep these primitives presentation-neutral. */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dataAttributes(attributes, escape) {
  return Object.entries(attributes || {}).map(([name, value]) => {
    if (!/^data-[a-z0-9-]+$/.test(name) || value == null) return "";
    return ` ${name}="${escape(value)}"`;
  }).join("");
}

/** Internal graph travel: same-tab, blue, solid underline, leading node glyph. */
export function constellationLink({ href, label, className = "", current = false, attributes = {}, escape = esc } = {}) {
  return `<a class="ui-constellation-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}"${current ? ' aria-current="page"' : ""}${dataAttributes(attributes, escape)}><span aria-hidden="true">◆</span>${escape(label)}</a>`;
}

/** Authoritative external record: new tab, neutral dotted underline, trailing arrow. */
export function officialSourceLink({ href, label, className = "", attributes = {}, escape = esc } = {}) {
  return `<a class="ui-official-source-link${className ? ` ${escape(className)}` : ""}" href="${escape(href)}" target="_blank" rel="noopener noreferrer"${dataAttributes(attributes, escape)}>${escape(label)}<span aria-hidden="true">↗</span></a>`;
}

/** Keep repeated official links available without making them the object's visual rhythm. */
export function officialSourceDisclosure({ items = [], label = "Open official sources", className = "", escape = esc } = {}) {
  const seen = new Set();
  const links = (Array.isArray(items) ? items : []).map((item) => {
    const href = String(item?.href || "").trim();
    const text = String(item?.label || "").trim();
    if (!href || !text || seen.has(href)) return "";
    seen.add(href);
    return `<li>${officialSourceLink({ href, label: text, className: "node-source-link", escape })}</li>`;
  }).filter(Boolean);
  if (!links.length) return "";
  return `<details class="node-source-disclosure${className ? ` ${escape(className)}` : ""}"><summary class="node-action">${escape(label)}</summary><ul>${links.join("")}</ul></details>`;
}

/** View-changing control: pill button with aria-pressed; deliberately not a link. */
export function filterChip({ label, pressed = false, className = "", attributes = {}, escape = esc } = {}) {
  return `<button type="button" class="ui-filter-chip${className ? ` ${escape(className)}` : ""}" aria-pressed="${pressed ? "true" : "false"}"${dataAttributes(attributes, escape)}>${escape(label)}</button>`;
}

/** Non-interactive information: plain semantic text with no link affordance. */
export function staticFact({ label, className = "", escape = esc } = {}) {
  return `<span class="ui-static-fact${className ? ` ${escape(className)}` : ""}">${escape(label)}</span>`;
}

/** Install navigation behavior for filter buttons carrying their shareable destination. */
export function installFilterChipNavigation(root = globalThis.document, locationRef = globalThis.location) {
  if (!root?.querySelectorAll || !locationRef) return;
  root.querySelectorAll(".ui-filter-chip[data-filter-href]").forEach((button) => {
    if (button.dataset.filterNavigationInstalled === "true") return;
    button.dataset.filterNavigationInstalled = "true";
    button.addEventListener("click", () => {
      const href = button.getAttribute("data-filter-href");
      if (href) locationRef.assign(href);
    });
  });
}
