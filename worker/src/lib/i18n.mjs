// worker/src/lib/i18n.mjs — email string translations for digest and confirm emails.
// Kept minimal: only the strings that appear in outbound email HTML.
//
// es: machine-translated, pending native review (Anna's CBO network, wave 6).
// Extend SUPPORTED_LANGS in subscriptions.mjs and add a matching block here when
// a new language ships.

const EMAIL_STRINGS = {
  en: {
    confirm_subject:      "Confirm your CityScroll alert",
    confirm_heading:      "Confirm your CityScroll alert",
    confirm_someone_asked:"You (or someone using this address) asked CityScroll to send:",
    confirm_expires:      "This link expires in 24 hours and can be used once.",
    confirm_didnt_ask:    "Didn't ask for this? Just ignore this email — nothing will be sent, and your address is not stored.",
    confirm_btn:          "Confirm my alert →",

    digest_new_item_singular: "item",
    digest_new_item_plural:   "items",
    // {n} = count, {item} = singular/plural word, {date} = short date string
    digest_new_items:     "{n} new {item} since {date}.",
    digest_no_date:       "{n} new {item}.",
    digest_subscribed:    "You subscribed to this on cityscroll.org.",
    digest_unsubscribe:   "Unsubscribe",
    digest_unsubscribe_all: "Unsubscribe from all watches",
    digest_manage:        "Manage watches",
    // Prefs latency honesty (edits next digest) vs unsub (immediate).
    digest_prefs_cutover: "Changes apply to the next digest (about 9am Eastern).",
    digest_unsub_immediate: "takes effect immediately",
    rules_comment_open:   "Comments open through {date}",
    rules_comment_action: "Comment on NYC Rules",

    // Digest item time + action awareness (event-clock deadline state + next-action rail).
    digest_next_action_label:        "Next step:",
    digest_next_action_default:      "Follow the steps below",
    digest_deadline_rolling:         "No fixed deadline (rolling)",
    digest_deadline_closed:          "Closed",
    digest_deadline_closed_on:       "Closed (was {date})",
    digest_deadline_closes_today:    "Closes today",
    digest_deadline_closes_tomorrow: "Closes tomorrow",
    digest_deadline_closing_soon:    "Closing soon · due {date} ({n} days left)",
    digest_deadline_closing_soon_bare: "Closing soon",
    digest_deadline_open:            "Open through {date} ({n} days left)",
    digest_deadline_open_date:       "Open through {date}",
    digest_deadline_open_bare:       "Open",

    quiet_nothing_week:  "No new items this week for {label} — nothing new {since}.",
    quiet_still_watching:"Still watching {label} — nothing new {since}.",
    // Plain still-subscribed sentence so quiet days are never mistaken for outage.
    quiet_still_subscribed: "No new matches since {date} — you are still subscribed.",
    quiet_still_subscribed_week: "No new matches since {date} — you are still subscribed (weekly check-in).",
    quiet_working:       "This note just confirms your alert is working — we'll email the moment something matches.",
    quiet_subscribed:    "You subscribed to this on cityscroll.org.",

    // {snippet}/{term} are pre-built HTML (a <mark>-wrapped hit) -- see matchEvidence() in
    // lib/digest.mjs for why an item needs this at all.
    digest_match_snippet: "Matched: \"{snippet}\"",
    digest_match_unknown: "Matched: \"{term}\"",

    // search_health: shown on a watch that hasn't matched anything new in a while (see
    // lib/search_health.mjs). {weeks} = how long it's been quiet.
    search_health_quiet: "This watch hasn't matched anything new in the last {weeks} weeks.",
    search_health_fix:   "Broaden this search →",

    // award_watch: one notice's award-arrival watch (see lib/search_health.mjs's neighbor,
    // alerts.mjs's processAwardSub()). {agency} = the notice's agency name.
    award_watch_subject:        "CityScroll: an award update for {agency}",
    award_watch_heading:        "Award update",
    award_watch_exact_label:    "Award registered",
    award_watch_fuzzy_label:    "Possible award match",
    award_watch_fuzzy_note:     "Matched by vendor and award date, not certain — named source only.",
    award_watch_vendor_unlisted:"vendor unlisted",
    award_watch_view_notice:    "View the notice on CityScroll →",

    // catch_up: watermark-recovery digest sent after a delivery outage. Not a normal daily
    // drip — the subscriber should understand why they're getting a batch.
    catch_up_subject: "CityScroll: {n} items you may have missed — {label}",
    catch_up_intro:   "Delivery was interrupted — here are {n} items since {date} that were missed.",
  },

  es: {
    confirm_subject:      "Confirme su alerta de CityScroll",
    confirm_heading:      "Confirme su alerta de CityScroll",
    confirm_someone_asked:"Usted (o alguien usando esta dirección) pidió a CityScroll que enviara:",
    confirm_expires:      "Este enlace expira en 24 horas y puede usarse una sola vez.",
    confirm_didnt_ask:    "¿No solicitó esto? Solo ignore este correo — no se enviará nada y su dirección no se almacenará.",
    confirm_btn:          "Confirmar mi alerta →",

    digest_new_item_singular: "aviso",
    digest_new_item_plural:   "avisos",
    digest_new_items:     "{n} {item} nuevo(s) desde {date}.",
    digest_no_date:       "{n} {item} nuevo(s).",
    digest_subscribed:    "Se suscribió a esto en cityscroll.org.",
    digest_unsubscribe:   "Darse de baja",
    digest_unsubscribe_all: "Darse de baja de todas las alertas",
    digest_manage:        "Administrar alertas",
    digest_prefs_cutover: "Los cambios se aplican al próximo resumen (alrededor de las 9am Eastern).",
    digest_unsub_immediate: "tiene efecto inmediato",
    rules_comment_open:   "Comentarios abiertos hasta {date}",
    rules_comment_action: "Comentar en NYC Rules",

    digest_next_action_label:        "Siguiente paso:",
    digest_next_action_default:      "Siga los pasos a continuación",
    digest_deadline_rolling:         "Sin fecha límite fija (continua)",
    digest_deadline_closed:          "Cerrado",
    digest_deadline_closed_on:       "Cerrado (era {date})",
    digest_deadline_closes_today:    "Cierra hoy",
    digest_deadline_closes_tomorrow: "Cierra mañana",
    digest_deadline_closing_soon:    "Cierra pronto · vence {date} (quedan {n} días)",
    digest_deadline_closing_soon_bare: "Cierra pronto",
    digest_deadline_open:            "Abierto hasta {date} (quedan {n} días)",
    digest_deadline_open_date:       "Abierto hasta {date}",
    digest_deadline_open_bare:       "Abierto",

    quiet_nothing_week:  "No hay avisos nuevos esta semana para {label} — nada nuevo {since}.",
    quiet_still_watching:"Seguimos monitoreando {label} — nada nuevo {since}.",
    quiet_still_subscribed: "Sin coincidencias nuevas desde {date} — sigue suscrito.",
    quiet_still_subscribed_week: "Sin coincidencias nuevas desde {date} — sigue suscrito (revisión semanal).",
    quiet_working:       "Esta nota confirma que su alerta está funcionando — le avisaremos en cuanto haya coincidencias.",
    quiet_subscribed:    "Se suscribió a esto en cityscroll.org.",

    digest_match_snippet: "Coincidencia: \"{snippet}\"",
    digest_match_unknown: "Coincidencia: \"{term}\"",

    search_health_quiet: "Esta alerta no ha encontrado nada nuevo en las últimas {weeks} semanas.",
    search_health_fix:   "Ampliar esta búsqueda →",

    award_watch_subject:        "CityScroll: novedades del contrato adjudicado para {agency}",
    award_watch_heading:        "Novedades del contrato adjudicado",
    award_watch_exact_label:    "Contrato adjudicado registrado",
    award_watch_fuzzy_label:    "Posible contrato adjudicado",
    award_watch_fuzzy_note:     "Coincide por proveedor y fecha de adjudicación, no es certero — solo fuente citada.",
    award_watch_vendor_unlisted:"proveedor no indicado",
    award_watch_view_notice:    "Ver el aviso en CityScroll →",

    catch_up_subject: "CityScroll: {n} avisos que podría haber perdido — {label}",
    catch_up_intro:   "La entrega fue interrumpida — aquí hay {n} avisos desde {date} que se perdieron.",
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
