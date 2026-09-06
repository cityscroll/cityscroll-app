/**
 * Reader-facing ULURP phase names.
 *
 * The Land list and the notice action rail label the same phases, so the
 * mapping from phase id to translation key lives here rather than inside the
 * Land lens module. Callers pass their own translator, which keeps this file
 * free of the page's global i18n binding.
 */
const PHASE_LABEL_KEYS = Object.freeze({
  pre_application: "land_phase_pre_application",
  environmental: "land_phase_environmental",
  pre_certification: "land_phase_pre_certification",
  certification: "land_phase_certification",
  community_board: "land_phase_community_board",
  borough_president: "land_phase_borough_president",
  cpc: "land_phase_cpc",
  city_council: "land_phase_city_council",
  mayoral_appeals: "land_phase_mayoral_appeals",
});

/**
 * Label one phase id, phase record, or empty value.
 * `translate` receives a translation key and returns the resident-facing text.
 */
export function landPhaseLabelText(phase, translate) {
  if (!phase) return "—";
  const t = typeof translate === "function" ? translate : (key) => key;
  if (phase.label_key) return t(phase.label_key);
  if (typeof phase === "string") {
    const key = PHASE_LABEL_KEYS[phase];
    return key ? t(key) : phase;
  }
  return phase.short || "—";
}
