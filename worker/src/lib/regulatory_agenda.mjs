// Worker-side import seam for the host-materialized regulatory agenda bridge.
// The parser and projection stay pure so host acquisition and resident reads
// cannot silently create a procedural fact.
export * from "../../../site/regulatory_agenda.mjs";
