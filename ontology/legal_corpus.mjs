/** Source-independent identity for a body of law. */

export const LEGAL_CORPUS_SCHEMA = "cityscroll.legal_corpus.v1";

const CORPUS_ID = /^[-a-z0-9]+(?:[-:][a-z0-9]+)*$/;

function text(value, max = 240) {
  const result = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return result && result.length <= max ? result : null;
}

export function legalCorpus(value = {}) {
  const id = text(value.id, 120);
  const name = text(value.name, 240);
  const jurisdiction = text(value.jurisdiction, 120);
  const instrumentKind = text(value.instrument_kind, 120);
  if (!id || !CORPUS_ID.test(id) || !name || !jurisdiction || !instrumentKind) {
    throw new TypeError("LegalCorpus requires a stable id, name, jurisdiction, and instrument_kind");
  }
  return Object.freeze({
    schema: LEGAL_CORPUS_SCHEMA,
    id,
    name,
    jurisdiction,
    instrument_kind: instrumentKind,
  });
}

export const NYC_ADMINISTRATIVE_CODE = legalCorpus({
  id: "nyc-administrative-code",
  name: "New York City Administrative Code",
  jurisdiction: "NYC",
  instrument_kind: "municipal_code",
});
