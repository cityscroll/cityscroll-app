import { MANDATE_CONFORMANCE_STYLE } from "../process_conformance.mjs";
import { categorySection } from "./category_section.mjs";

export const processConformanceSection = categorySection("obligations", 70, {
  styleOrder: 0,
  style: MANDATE_CONFORMANCE_STYLE,
});
