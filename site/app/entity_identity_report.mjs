/* Add the report affordance to the existing dynamic person and organization
 * profiles. The profile renderer remains the owner of profile facts; this
 * small enhancement only observes its already-rendered panel. */

function profileDescriptor(root) {
  const official = root.querySelector("#official-skim[data-official-id]");
  if (official) {
    const id = official.dataset.officialId;
    const label = official.querySelector(".rolename")?.textContent?.trim();
    if (id && label) return {
      ref: `entity:official:${id}`,
      href: `/officials/${encodeURIComponent(id)}/`,
      label,
    };
  }

  const agency = root.querySelector("[data-agency-id][data-agency-name]");
  if (agency) {
    const id = agency.dataset.agencyId;
    const label = agency.dataset.agencyName || agency.querySelector(".rolename")?.textContent?.trim();
    if (id && label) return {
      ref: `agency:id:${id}`,
      href: `/agencies/${encodeURIComponent(id)}/`,
      label,
    };
  }

  const vendorRoute = String(location.hash || "").startsWith("#vendor/")
    || String(location.pathname || "").startsWith("/vendors/");
  if (vendorRoute) {
    const label = root.querySelector(".rolename")?.textContent?.trim();
    const pivots = globalThis.CrolEntityPivots;
    const ref = pivots?.entityRouteRef?.("vendor", label);
    const href = ref && pivots?.entityHref?.({ ref, label });
    if (label && ref && href) return { ref, href, label };
  }
  return null;
}

function paint(root) {
  const reports = globalThis.CrolReportIssue;
  if (!reports || typeof reports.buildEntityProfileReportTarget !== "function") return;
  const actions = root.querySelector(".actions");
  if (!actions || actions.dataset.identityReportInstalled === "true") return;
  const profile = profileDescriptor(root);
  if (!profile) return;
  const target = reports.buildEntityProfileReportTarget({
    entity_ref: profile.ref,
    canonical_url: profile.href,
    object_label: profile.label,
  });
  const markup = reports.renderReportIssueAffordance(target, { label: "Report an issue" });
  if (!markup) return;
  actions.insertAdjacentHTML("beforeend", markup);
  actions.dataset.identityReportInstalled = "true";
}

const root = document.querySelector("#entityview");
if (root) {
  const observer = new MutationObserver(() => paint(root));
  observer.observe(root, { childList: true, subtree: true });
  paint(root);
}

export { paint as paintEntityIdentityReport, profileDescriptor as entityProfileDescriptor };
