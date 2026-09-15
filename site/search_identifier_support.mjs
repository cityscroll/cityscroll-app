/** Exact, source-owned identifier helpers shared by search producers. */

const clean = (value, max = 240) => String(value ?? "")
  .normalize("NFKC")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

export function normalizeSearchIdentifier(value) {
  const normalized = clean(value, 240).toLocaleUpperCase("en-US").replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

function displayVariant(value) {
  const text = clean(value, 240).toLocaleUpperCase("en-US");
  const application = text.match(/^([CN])\s*(\d{6})\s*([A-Z]{3})$/);
  if (application) return `${application[1]} ${application[2]} ${application[3]}`;
  const matter = text.match(/^(LU|RES)\s*(\d{4})\s*[- ]\s*(\d{4})$/);
  if (matter) return `${matter[1]} ${matter[2]}-${matter[3]}`;
  return null;
}

/** Add only punctuation/spacing variants of an already accepted identifier. */
export function exactIdentifierVariants(values) {
  const output = [];
  const seen = new Set();
  const sourceValues = (Array.isArray(values) ? values : [values])
    .flatMap((value) => clean(value, 240).split(/[;,]/));
  for (const value of sourceValues) {
    const raw = clean(value, 240);
    if (!raw) continue;
    for (const variant of [raw, displayVariant(raw)]) {
      const item = clean(variant, 240);
      const key = item.toLocaleUpperCase("en-US");
      if (item && !seen.has(key)) {
        seen.add(key);
        output.push(item);
      }
    }
  }
  return output;
}

export function siteHistoryForParcelIds(values) {
  const parcelIds = [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => clean(value, 20).replace(/\.0$/, ""))
    .filter((value) => /^\d{10}$/.test(value)))].sort();
  if (!parcelIds.length) return null;
  return {
    parcel_ids: parcelIds,
    href: `/parcels/${parcelIds[0]}/`,
    relation: "accepted_exact_parcel_membership",
  };
}
