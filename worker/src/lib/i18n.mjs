// worker/src/lib/i18n.mjs — email string translations for digest and confirm emails.
// Kept minimal: only the strings that appear in outbound email HTML.
//
// es: machine-translated, pending native review (Anna's CBO network, wave 6).
// Extend SUPPORTED_LANGS in subscriptions.mjs and add a matching block here when
// a new language ships.

const EMAIL_STRINGS = {
  en: {
    confirm_subject:      "Confirm your CROL-List alert",
    confirm_heading:      "Confirm your CROL-List alert",
    confirm_someone_asked:"You (or someone using this address) asked CROL-List to send:",
    confirm_expires:      "This link expires in 24 hours and can be used once.",
    confirm_didnt_ask:    "Didn't ask for this? Just ignore this email — nothing will be sent, and your address is not stored.",
    confirm_btn:          "Confirm my alert →",

    digest_new_item_singular: "item",
    digest_new_item_plural:   "items",
    // {n} = count, {item} = singular/plural word, {date} = short date string
    digest_new_items:     "{n} new {item} since {date}.",
    digest_no_date:       "{n} new {item}.",
    digest_subscribed:    "You subscribed to this on crol-list.org.",
    digest_unsubscribe:   "Unsubscribe",

    quiet_nothing_week:  "No new items this week for {label} — nothing new {since}.",
    quiet_still_watching:"Still watching {label} — nothing new {since}.",
    quiet_working:       "This note just confirms your alert is working — we'll email the moment something matches.",
    quiet_subscribed:    "You subscribed to this on crol-list.org.",

    // {snippet}/{term} are pre-built HTML (a <mark>-wrapped hit) -- see matchEvidence() in
    // lib/digest.mjs for why an item needs this at all.
    digest_match_snippet: "Matched: \"{snippet}\"",
    digest_match_unknown: "Matched: \"{term}\"",
  },

  es: {
    confirm_subject:      "Confirme su alerta de CROL-List",
    confirm_heading:      "Confirme su alerta de CROL-List",
    confirm_someone_asked:"Usted (o alguien usando esta dirección) pidió a CROL-List que enviara:",
    confirm_expires:      "Este enlace expira en 24 horas y puede usarse una sola vez.",
    confirm_didnt_ask:    "¿No solicitó esto? Solo ignore este correo — no se enviará nada y su dirección no se almacenará.",
    confirm_btn:          "Confirmar mi alerta →",

    digest_new_item_singular: "aviso",
    digest_new_item_plural:   "avisos",
    digest_new_items:     "{n} {item} nuevo(s) desde {date}.",
    digest_no_date:       "{n} {item} nuevo(s).",
    digest_subscribed:    "Se suscribió a esto en crol-list.org.",
    digest_unsubscribe:   "Darse de baja",

    quiet_nothing_week:  "No hay avisos nuevos esta semana para {label} — nada nuevo {since}.",
    quiet_still_watching:"Seguimos monitoreando {label} — nada nuevo {since}.",
    quiet_working:       "Esta nota confirma que su alerta está funcionando — le avisaremos en cuanto haya coincidencias.",
    quiet_subscribed:    "Se suscribió a esto en crol-list.org.",

    digest_match_snippet: "Coincidencia: \"{snippet}\"",
    digest_match_unknown: "Coincidencia: \"{term}\"",
  },
};

/**
 * emailT(lang, key, vars?) — look up an email string, fall back to en.
 * @param {string} lang - BCP 47 language code (e.g. "es")
 * @param {string} key  - string key
 * @param {Object} [vars] - optional {placeholder: value} substitutions
 * @returns {string}
 */
export function emailT(lang, key, vars) {
  const dict = EMAIL_STRINGS[lang] || EMAIL_STRINGS.en;
  let str = dict[key] !== undefined ? dict[key] : (EMAIL_STRINGS.en[key] !== undefined ? EMAIL_STRINGS.en[key] : key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp("\\{" + k + "\\}", "g"), String(v == null ? "" : v));
    }
  }
  return str;
}

export { EMAIL_STRINGS };
