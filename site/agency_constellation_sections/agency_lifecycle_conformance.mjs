import {
  AGENCY_LIFECYCLE_CONFORMANCE_STYLE,
  renderAgencyLifecycleConformance,
} from "../agency_lifecycle_conformance.mjs";

export const agencyLifecycleConformanceSection = Object.freeze({
  id: "agency-lifecycle-conformance",
  order: 45,
  styleOrder: 1,
  style: AGENCY_LIFECYCLE_CONFORMANCE_STYLE,
  render({ displayView }) {
    return renderAgencyLifecycleConformance(displayView?.agency_lifecycle_conformance);
  },
});
