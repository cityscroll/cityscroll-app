/**
 * Display labels for ZAP action codes on land detail.
 *
 * Family mapping stays in land_use_action_type.mjs. This table is presentation
 * only: known publisher codes get a zapact_ i18n key; CM/HU/UK/EAS/RA/RC/RS
 * stay unlabeled (raw code) rather than being forced into rezoning.
 */

/** DCP action-code → i18n key. Unknown codes are absent, never remapped. */
export const ZAP_ACTION_LABEL_KEYS = Object.freeze({
  ZM: "zapact_zm",
  ZR: "zapact_zr",
  ZA: "zapact_za",
  ZC: "zapact_zc",
  ZS: "zapact_zs",
  HA: "zapact_ha",
  PC: "zapact_pc",
  PQ: "zapact_pc",
  HG: "zapact_hg",
  PP: "zapact_pp",
  PS: "zapact_ps",
  MM: "zapact_mm",
  DM: "zapact_dm",
  HI: "zapact_hi",
  LD: "zapact_hi",
});

export const UNLABELED_ZAP_ACTION_CODES = Object.freeze([
  "CM",
  "HU",
  "UK",
  "EAS",
  "RA",
  "RC",
  "RS",
]);

function tokenizeZapActions(actions) {
  if (typeof actions === "string") {
    return actions.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
  }
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const row of actions) {
    const raw = typeof row === "string"
      ? row
      : row && typeof row === "object"
        ? row.action || row.code || row.action_code
        : "";
    const code = String(raw || "").trim();
    if (code) out.push(code);
  }
  return out;
}

/**
 * Reader-facing action chips for a ZAP row.
 * Labeled codes resolve through `translate`; unlabeled codes stay raw.
 */
export function zapActionDisplayLabels(actions, translate) {
  const t = typeof translate === "function" ? translate : (key) => key;
  return tokenizeZapActions(actions).map((code) => {
    const key = ZAP_ACTION_LABEL_KEYS[code.toUpperCase()];
    return key ? t(key) : code;
  });
}
