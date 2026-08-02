/**
 * Re-export procurement phase spine from the shared site module so worker tests
 * and pure libs share one implementation with the browser.
 * (Domain module only — not a second generic timeline library.)
 */
export * from "../../../site/procurement_phase_spine.mjs";
