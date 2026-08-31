import {
  defaultRouteIdentityReport,
  projectInstitutionProfileNavigation,
  renderInstitutionProfileNavigation,
} from "../civic_institution_profile_navigation.mjs";

export const institutionNavigationSection = Object.freeze({
  id: "institution-navigation",
  order: 4,
  render(view) {
    const constellation = view?.displayView || view?.view || view;
    if (!constellation) return "";
    const projection = projectInstitutionProfileNavigation({
      view: constellation,
      identity: {
        canonical_id: constellation.canonical_id || constellation.id,
        canonical_name: constellation.display_name,
      },
      identityEvidence: constellation.identity_evidence,
      publisherRow: constellation.identity_evidence?.observations?.some((row) => row.source_system === "oti")
        ? { canonical_name: constellation.display_name }
        : null,
      routeIdentityReport: defaultRouteIdentityReport,
      hasRoute: true,
    });
    return renderInstitutionProfileNavigation(projection);
  },
});
