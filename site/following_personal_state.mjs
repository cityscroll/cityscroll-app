/**
 * Personal-watch island states for Following.
 *
 * Session-sensitive controls stay off until the existing session contract
 * recognizes the resident. Missing, unavailable, and error states never mint a
 * watch or borrow another account's rows.
 */

export const FOLLOWING_PERSONAL_STATES = Object.freeze([
  "loading",
  "unrecognized",
  "empty",
  "recognized",
  "unavailable",
  "error",
]);

const CREATE_HREF = "#create";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function followingPersonalUiState({
  loading = false,
  fetchFailed = false,
  responseOk = true,
  sessionRecognized = null,
  watchCount = 0,
} = {}) {
  if (loading) return "loading";
  if (fetchFailed) return "error";
  if (responseOk === false) return "unavailable";
  if (sessionRecognized === false) return "unrecognized";
  if (Number(watchCount) > 0) return "recognized";
  if (sessionRecognized === true) return "empty";
  return "loading";
}

export function followingPersonalIslandProjection(state, options = {}) {
  const createHref = options.createHref || CREATE_HREF;
  const views = {
    loading: {
      message: "Looking up your saved watches…",
      recovery: null,
    },
    unrecognized: {
      message: "Open a CityScroll email to see your watches.",
      recovery: { kind: "create", label: "Create a watch", href: createHref },
    },
    empty: {
      message: "No saved watches yet. Create one to get updates on matching City Record rows.",
      recovery: { kind: "create", label: "Create a watch", href: createHref },
    },
    unavailable: {
      message: "Saved watches are not available right now.",
      recovery: { kind: "retry", label: "Try again" },
    },
    error: {
      message: "Could not load saved watches.",
      recovery: { kind: "retry", label: "Try again" },
    },
    recognized: {
      message: null,
      recovery: null,
    },
  };
  const view = views[state] || views.loading;
  return Object.freeze({
    state: views[state] ? state : "loading",
    showControls: state === "recognized",
    message: view.message,
    recovery: view.recovery,
  });
}

export function followingPersonalIslandHtml(state, options = {}) {
  if (state === "recognized") return options.watchesHtml || "";
  const view = followingPersonalIslandProjection(state, options);
  const sessionAttr = state === "unrecognized"
    ? ' data-session-recognized="false"'
    : state === "empty"
      ? ' data-session-recognized="true"'
      : "";
  const recovery = view.recovery
    ? view.recovery.kind === "retry"
      ? `<p class="following-personal-recovery"><button type="button" class="following-personal-retry" data-personal-retry>${esc(view.recovery.label)}</button></p>`
      : `<p class="following-personal-recovery"><a href="${esc(view.recovery.href)}" data-following-create-recovery>${esc(view.recovery.label)}</a></p>`
    : "";
  const message = view.message ? `<p>${esc(view.message)}</p>` : "";
  return `<div data-personal-state="${esc(view.state)}"${sessionAttr}>${message}${recovery}</div>`;
}

export function followingTabHash(tab) {
  if (tab === "watches") return "your-following";
  if (tab === "create" || tab === "packs") return tab;
  return "";
}

export function followingUrlForTab(locationLike, tab) {
  const pathname = String(locationLike?.pathname || "/following/");
  const search = String(locationLike?.search || "");
  const hash = followingTabHash(tab);
  return `${pathname}${search}${hash ? `#${hash}` : ""}`;
}

export function followingManagementUrl(locationLike = { pathname: "/following/", search: "" }) {
  return followingUrlForTab(locationLike, "watches");
}

export function followingPersonalStateFromHost(host) {
  if (!host || typeof host.querySelector !== "function") return "loading";
  const stamped = host.getAttribute?.("data-personal-state")
    || host.querySelector("[data-personal-state]")?.getAttribute("data-personal-state");
  if (FOLLOWING_PERSONAL_STATES.includes(stamped)) return stamped;
  const session = host.querySelector("[data-session-recognized]");
  return followingPersonalUiState({
    sessionRecognized: session
      ? session.getAttribute("data-session-recognized") === "true"
      : null,
    watchCount: host.querySelectorAll("[data-watch-key]").length,
  });
}
