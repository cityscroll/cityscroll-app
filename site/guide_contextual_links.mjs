/**
 * One reader-facing guide link per named product control group.
 *
 * These paths are static published articles. They never take a watch token,
 * session, or other private credential, and a control group gets at most one.
 */

export const GUIDE_HOME_HREF = "/guide/";

export const GUIDE_HELP = Object.freeze({
  following: Object.freeze({
    href: "/guide/how-to/follow-a-search/",
    label: "How to follow a search",
  }),
  calendar: Object.freeze({
    href: "/guide/how-to/put-dates-in-your-calendar/",
    label: "How to put dates in your calendar",
  }),
  connection: Object.freeze({
    href: "/guide/how-to/check-the-evidence-behind-a-connection/",
    label: "How to check the evidence behind a connection",
  }),
  asOf: Object.freeze({
    href: "/guide/how-to/look-at-records-as-of-a-day/",
    label: "How to look at records as of a day",
  }),
  emptyCollection: Object.freeze({
    href: "/guide/how-to/collect-records-and-export-them/",
    label: "How to collect records and export them",
  }),
});

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function guideHelpFor(topic) {
  const item = GUIDE_HELP[topic];
  if (!item) throw new TypeError(`unknown guide help topic: ${topic}`);
  return item;
}

/** Compact in-place help link. One per control group; never a tooltip overlay. */
export function renderGuideHelpLink(topic, { extraClass = "" } = {}) {
  const item = guideHelpFor(topic);
  const classes = ["guide-help", extraClass].filter(Boolean).join(" ");
  return `<p class="${esc(classes)}"><a href="${esc(item.href)}">${esc(item.label)}</a></p>`;
}
