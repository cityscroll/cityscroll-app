const preference = "cityscroll_start_preview=";
const startPage = document.body.hasAttribute("data-start-page");

const links = [
  ["/start/", "Homepage"],
  ["/wincitywork/", "WinCityWork"],
  ["/browse/", "CityScroll Data Hub"],
  ["/about.html", "About"],
  ["/about.html?intent=general#fbmessage", "Contact"],
];

function previewPreference() {
  return document.cookie.split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(preference))
    ?.slice(preference.length);
}

function setPreview(enabled) {
  const security = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${preference}${enabled ? "1" : "0"}; Path=/; SameSite=Lax${security}`;
}

function loadPreviewStyles() {
  if (document.querySelector('link[href="/start/preview.css"]')) return;
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/start/preview.css";
  document.head.append(styles);
}

function normalizePath(pathname) {
  let path = pathname.replace(/\/index\.html$/, "").replace(/\/$/, "") || "/";
  if (path === "/about") path = "/about.html";
  return path;
}

function renderNavigation() {
  document.querySelector("#cityscroll-start-nav")?.remove();
  if (!startPage && previewPreference() !== "1") return;
  loadPreviewStyles();
  const nav = document.createElement("nav");
  nav.id = "cityscroll-start-nav";
  nav.setAttribute("aria-label", "CityScroll");
  const current = normalizePath(location.pathname);
  for (const [href, label] of links) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    const url = new URL(href, location.origin);
    if (!url.search && !url.hash && normalizePath(url.pathname) === current) {
      link.setAttribute("aria-current", "page");
    }
    nav.append(link);
  }
  document.body.prepend(nav);
}

if (startPage) setPreview(true);

if (startPage || previewPreference() === "1") {
  renderNavigation();
  window.addEventListener("pageshow", event => {
    if (event.persisted) renderNavigation();
  });
}
