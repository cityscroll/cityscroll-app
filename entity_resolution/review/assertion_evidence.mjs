// Provenance-first conflict evidence for desk review.
// Publisher values remain assertions; parsing and conflict detection are explicitly
// CityScroll interpretations and never select a canonical value.

export const ASSERTION_INTERPRETATION_VERSION = "assertion_interpretation_v1";

export const ASSERTION_FACT_DEFINITIONS = Object.freeze([
  {
    fact: "contract_amount",
    label: "Contract amount",
    kind: "amount",
    aliases: [
      "contract_amount",
      "prime_contract_current_amount",
      "current_amount",
      "award_amount",
      "contract_value",
    ],
  },
  {
    fact: "start_date",
    label: "Start date",
    kind: "date",
    aliases: ["start_date", "prime_contract_start_date", "contract_start_date", "begin_date"],
  },
  {
    fact: "end_date",
    label: "End date",
    kind: "date",
    aliases: ["end_date", "prime_contract_end_date", "contract_end_date"],
  },
  {
    fact: "registration_date",
    label: "Registration date",
    kind: "date",
    aliases: ["registration_date", "prime_contract_registration_date", "registered_date"],
  },
  {
    fact: "due_date",
    label: "Due date",
    kind: "date",
    aliases: ["due_date", "response_due_date", "bid_due_date"],
  },
].map((definition) => Object.freeze({
  ...definition,
  aliases: Object.freeze([...definition.aliases]),
})));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalizedFieldName = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function assertionSnapshot(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function comparisonAmount(value) {
  const text = clean(value);
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const numericText = text.replace(/[^0-9.+-]/g, "");
  if (!/[0-9]/.test(numericText)) return null;
  const number = Number(numericText);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function validIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function comparisonDate(value) {
  const text = clean(value);
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T|\s|$)/);
  if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
  if (match) return validIsoDate(Number(match[3]), Number(match[1]), Number(match[2]));
  return null;
}

export function assertionComparisonValue(kind, value) {
  if (kind === "amount") return comparisonAmount(value);
  if (kind === "date") return comparisonDate(value);
  return clean(value) || null;
}

export function sourceAssertionForFact(observation, definition) {
  const snapshot = assertionSnapshot(observation?.raw_snapshot);
  const fields = new Map(Object.keys(snapshot).map((field) => [normalizedFieldName(field), field]));
  const alias = definition.aliases.find((candidate) => fields.has(candidate));
  if (!alias) return null;
  const sourceField = fields.get(alias);
  const value = snapshot[sourceField];
  if (value == null || typeof value === "object" || clean(value) === "") return null;
  const compared = assertionComparisonValue(definition.kind, value);
  if (compared == null) return null;
  return {
    classification: "source_assertion",
    source_system: clean(observation.source_system),
    source_system_id: clean(observation.source_system_id),
    source_record_id: clean(observation.source_record_id),
    source_url: clean(observation.source_url),
    source_field: sourceField,
    value,
    recorded_at: clean(observation.ingested_at),
    _comparison_value: compared,
  };
}

function withoutInternalComparison(assertion) {
  const { _comparison_value: omitted, ...publicAssertion } = assertion;
  return publicAssertion;
}

export function buildAssertionEvidence(left = {}, right = {}) {
  const conflicts = [];
  for (const definition of ASSERTION_FACT_DEFINITIONS) {
    const leftAssertion = sourceAssertionForFact(left, definition);
    const rightAssertion = sourceAssertionForFact(right, definition);
    if (!leftAssertion || !rightAssertion || leftAssertion._comparison_value === rightAssertion._comparison_value) continue;
    conflicts.push({
      fact: definition.fact,
      label: definition.label,
      kind: definition.kind,
      assertions: [withoutInternalComparison(leftAssertion), withoutInternalComparison(rightAssertion)],
      interpretation: {
        classification: "cityscroll_interpretation",
        status: "conflict",
        resolution: "unresolved",
        comparison_values: [leftAssertion._comparison_value, rightAssertion._comparison_value],
        summary: `CityScroll reads the two source values as different ${definition.label.toLowerCase()} assertions; neither value is selected.`,
      },
    });
  }
  return {
    version: ASSERTION_INTERPRETATION_VERSION,
    conflict_count: conflicts.length,
    conflicts,
  };
}
