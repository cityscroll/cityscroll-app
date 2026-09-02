// Fixed-date parsing, Date.UTC, and explicit zones stay available: none of them
// change answer with the clock, so none of them is a finding.
export const CHARTER_REVISION = new Date("2019-11-05T00:00:00Z");
export const FISCAL_YEAR_START = Date.UTC(2026, 6, 1);

export function parseDay(value) {
  return Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
}

export function utcParts(value) {
  const d = new Date(value);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export function hearingLabel(value) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York",
  });
}

export function dollars(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
