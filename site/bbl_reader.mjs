// Shared reader-facing BBL decomposition with no location-parser dependencies.

export const BBL_BOROUGH_NAMES = Object.freeze({
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
});

/** Turn a serial BBL into the borough, block, and lot a reader needs. */
export function bblReaderLabel(bbl) {
  const digits = String(bbl || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) return "";
  const borough = BBL_BOROUGH_NAMES[digits[0]] || "New York City";
  const block = String(parseInt(digits.slice(1, 6), 10));
  const lot = String(parseInt(digits.slice(6, 10), 10));
  return `${borough} — Block ${block}, Lot ${lot} (BBL ${digits})`;
}
