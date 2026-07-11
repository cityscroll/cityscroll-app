// i18n.js — CROL-List runtime string dictionary
// Architecture: plain-JS runtime dictionary, no build step. Loaded via <script src="i18n.js">
// in index.html. All LL30 languages are represented as stubs so the key structure is stable
// before new language translations are added.
//
// es: machine-translated, pending native review (Anna's CBO network, wave 6).
// fr-HT: Haitian Creole has no Intl locale; date/number formatting uses fr-HT.
// RTL note: Arabic (ar) and Urdu (ur) require dir="rtl" — scaffolded here as future work;
// use CSS logical properties in any NEW css (not retrofitted from existing physical properties).
// Bengali note: bn uses 2-2-3 digit grouping; Intl.NumberFormat('bn') handles this automatically.

// Supported language codes: BCP 47 locale, native label, layout direction, Intl date locale.
// Haitian Creole uses fr-HT for Intl (ht has no CLDR support).
const LANG_META = {
  en:       { locale: "en-US",   label: "English",          dir: "ltr", intlDate: "en-US"   },
  es:       { locale: "es",      label: "Español",          dir: "ltr", intlDate: "es"       },
  // Stubs for remaining LL30 languages (translations pending):
  fr:       { locale: "fr",      label: "Français",         dir: "ltr", intlDate: "fr"       },
  ht:       { locale: "fr-HT",   label: "Kreyòl ayisyen",  dir: "ltr", intlDate: "fr-HT"    },
  ru:       { locale: "ru",      label: "Русский",          dir: "ltr", intlDate: "ru"       },
  bn:       { locale: "bn",      label: "বাংলা",            dir: "ltr", intlDate: "bn"       },
  "zh-Hans":{ locale: "zh-Hans", label: "中文（简体）",      dir: "ltr", intlDate: "zh-Hans"  },
  "zh-Hant":{ locale: "zh-Hant", label: "中文（繁體）",      dir: "ltr", intlDate: "zh-Hant"  },
  ko:       { locale: "ko",      label: "한국어",            dir: "ltr", intlDate: "ko"       },
  ar:       { locale: "ar",      label: "العربية",          dir: "rtl", intlDate: "ar"       },
  ur:       { locale: "ur",      label: "اردو",             dir: "rtl", intlDate: "ur"       },
  pl:       { locale: "pl",      label: "Polski",           dir: "ltr", intlDate: "pl"       },
};
const SUPPORTED_LANGS = Object.keys(LANG_META);

// Full string table — en + es. Keys cover all translatable UI chrome in index.html.
// Notice content (City Record titles, agency names, notice bodies) is NEVER in this table.
const STRINGS = {
  en: {
    // Tab labels
    tab_money:    "Money",
    tab_people:   "People",
    tab_land:     "Land",
    tab_property: "Property",
    tab_rules:    "Rules",
    tab_meetings: "Meetings",
    tab_alerts:   "Alerts",

    // Money lens controls
    nl_placeholder_money: "describe what you're looking for…",
    ask_btn:          "Ask",
    show_label:       "Show",
    mode_open:        "Open Requests for Proposals (RFPs) — accepting now",
    mode_allrfp:      "All RFPs",
    mode_award:       "Recent Awards ($)",
    agency_label:     "Agency",
    all_agencies:     "All agencies",
    keyword_label:    "Keyword",
    sort_label:       "Sort by",
    sort_deadline:    "Deadline: soonest",
    sort_newest:      "Newest posted",
    sort_amount:      "Largest $",
    min_award_label:  "Min award $",
    min_award_any:    "Any",
    watch_this_search:"Watch this search",
    closing_this_week:"Closing this week",
    money_trail_heading: "Money trail",
    export_csv:       "Export CSV",
    pick_notice_empty:"Pick a notice on the left to trace it — for an RFP you'll see how to respond (deadline, contact, where to submit) and the full notice → award → dollars chain.",

    // People lens
    look_up_label:       "Look up",
    pmode_role:          "A role / title",
    pmode_person:        "A person",
    title_keyword_label: "Title keyword",
    person_name_label:   "Name",
    agency_filter_label: "Agency (optional)",

    // Alerts / quiz section
    quiz_heading:       "Get your digest in 60 seconds",
    quiz_step1:         "What should we watch for you?",
    quiz_step2:         "Narrow it (optional)",
    quiz_step3:         "How often?",
    quiz_rfpkw:         "City contracts & RFPs",
    quiz_bigaward:      "Big contract awards",
    quiz_rezone:        "Rezonings near me",
    quiz_property:      "Property sales",
    quiz_rules:         "Rule changes",
    quiz_meetings:      "Hearings & meetings",
    quiz_daily:         "Daily (around 9 a.m.)",
    quiz_weekly:        "Weekly (Mondays)",
    quiz_preview_btn:   "Preview my digest →",
    quiz_no_account:    "No account — just an email confirmation.",
    build_alert_heading:"Build an alert",
    quick_suggestions:  "Quick suggestions",
    sugg_rezone_rivington: "Rezonings near 79 Rivington",
    sugg_awards_1m:     "Awards over $1M",
    sugg_construction_rfp: "Construction RFPs",
    watch_for_label:    "Watch for",
    watch_bigaward:     "Contract awards over a threshold",
    watch_rfpkw:        "Open RFPs matching a keyword",
    watch_rezone:       "Rezonings near a neighborhood",
    watch_property:     "Property sale notices",
    watch_rules:        "Rule changes (Agency Rules)",
    watch_meetings:     "Public hearings & meetings",
    watch_entityvendor: "A vendor — anything naming them",
    watch_entityagency: "An agency — anything they publish",
    email_label:        "Email address",
    email_placeholder:  "you@example.com",
    freq_label:         "Frequency",
    freq_daily:         "Daily",
    freq_weekly:        "Weekly",
    preview_digest_btn: "Preview today's digest",
    subscribe_btn:      "Subscribe →",
    subscribe_confirm_note: "We email a confirmation link — alerts begin only after you click it, so no one can sign you up but you.",
    empty_preview:      "Build an alert and hit Preview to see the digest, populated with today's real notices.",

    // Time/schedule strings (9 a.m. form per NYC style guide T-01/T-02)
    when_daily:  "New matches are emailed each morning, around 9 a.m. New York time (8 a.m. Nov–Mar).",
    when_weekly: "New matches are emailed Monday mornings, around 9 a.m. New York time (8 a.m. Nov–Mar).",

    // Status / error messages
    loading_data:           "Loading…",
    retry_open_data:        "Could not reach NYC Open Data. Retry in a moment.",
    nothing_found:          "Nothing found. Try a broader keyword or \"All RFPs\".",
    check_inbox:            "Check your inbox.",
    sent_confirm_to:        "We sent a confirmation link to {email} — your alert starts once you click it.",
    turnstile_fail:         "The human check didn't pass — try it again.",
    rate_limited:           "Too many attempts — give it a minute.",
    bad_email:              "That email address looks off.",
    channel_unsupported:    "Text alerts aren't available yet — choose Email.",
    not_configured:         "Subscriptions aren't switched on yet.",
    send_failed:            "Couldn't send the email just now — try again.",
    generic_error:          "Something went wrong — please try again.",
    complete_human_check:   "Complete the “I’m human” check above first.",
    sending_confirm_link:   "Sending your confirmation link…",
    cant_reach_server:      "Couldn't reach the server — try again.",

    // Deadline chips (N-01: numbers under ten spelled out; {n} receives already-spelled value)
    closes_today:     "closes today",
    closes_in_1_day:  "closes in one day",
    closes_in_n_days: "closes in {n} days",

    // Notice content language note (shown when non-English UI is active)
    notices_in_english_note: "Notice text appears in the original English.",
    notices_in_english_es:   "Los avisos aparecen en inglés original.",

    // Footer / nav
    about_link:     "About",
    stats_link:     "Stats",
    data_link:      "Data",
    api_link:       "API",
    changelog_link: "Changelog",

    // Language switcher
    lang_switcher_label: "Language",
  },

  es: {
    // Tab labels
    tab_money:    "Dinero",
    tab_people:   "Personas",
    tab_land:     "Terrenos",
    tab_property: "Propiedades",
    tab_rules:    "Reglas",
    tab_meetings: "Reuniones",
    tab_alerts:   "Alertas",

    // Money lens controls
    nl_placeholder_money: "describa lo que busca…",
    ask_btn:          "Buscar",
    show_label:       "Mostrar",
    mode_open:        "Solicitudes de propuestas (RFP) abiertas — aceptando ahora",
    mode_allrfp:      "Todas las RFP",
    mode_award:       "Adjudicaciones recientes ($)",
    agency_label:     "Agencia",
    all_agencies:     "Todas las agencias",
    keyword_label:    "Palabra clave",
    sort_label:       "Ordenar por",
    sort_deadline:    "Fecha límite: más próxima",
    sort_newest:      "Más reciente",
    sort_amount:      "Mayor monto $",
    min_award_label:  "Monto mínimo $",
    min_award_any:    "Cualquiera",
    watch_this_search:"Vigilar esta búsqueda",
    closing_this_week:"Cierra esta semana",
    money_trail_heading: "Rastro del dinero",
    export_csv:       "Exportar CSV",
    pick_notice_empty:"Seleccione un aviso a la izquierda para rastrearlo — para una RFP verá cómo responder (fecha límite, contacto, dónde enviar) y la cadena completa aviso → adjudicación → dinero.",

    // People lens
    look_up_label:       "Buscar",
    pmode_role:          "Un cargo / título",
    pmode_person:        "Una persona",
    title_keyword_label: "Palabra clave del título",
    person_name_label:   "Nombre",
    agency_filter_label: "Agencia (opcional)",

    // Alerts / quiz section
    quiz_heading:       "Configure su resumen en 60 segundos",
    quiz_step1:         "¿Qué debemos vigilar por usted?",
    quiz_step2:         "Refinar (opcional)",
    quiz_step3:         "¿Con qué frecuencia?",
    quiz_rfpkw:         "Contratos y RFP municipales",
    quiz_bigaward:      "Grandes adjudicaciones de contratos",
    quiz_rezone:        "Rezonificaciones cerca de mí",
    quiz_property:      "Ventas de propiedades",
    quiz_rules:         "Cambios de reglas",
    quiz_meetings:      "Audiencias y reuniones",
    quiz_daily:         "Diario (alrededor de las 9 a.m.)",
    quiz_weekly:        "Semanal (los lunes)",
    quiz_preview_btn:   "Ver mi resumen →",
    quiz_no_account:    "Sin cuenta — solo una confirmación por correo.",
    build_alert_heading:"Crear una alerta",
    quick_suggestions:  "Sugerencias rápidas",
    sugg_rezone_rivington: "Rezonificaciones cerca de 79 Rivington",
    sugg_awards_1m:     "Adjudicaciones superiores a $1M",
    sugg_construction_rfp: "RFP de construcción",
    watch_for_label:    "Vigilar",
    watch_bigaward:     "Adjudicaciones de contratos sobre un umbral",
    watch_rfpkw:        "RFP abiertas que coincidan con una palabra clave",
    watch_rezone:       "Rezonificaciones cerca de un barrio",
    watch_property:     "Avisos de venta de propiedades",
    watch_rules:        "Cambios de reglas (Reglas de Agencias)",
    watch_meetings:     "Audiencias y reuniones públicas",
    watch_entityvendor: "Un proveedor — todo aviso que lo nombre",
    watch_entityagency: "Una agencia — todo lo que publique",
    email_label:        "Dirección de correo electrónico",
    email_placeholder:  "usted@ejemplo.com",
    freq_label:         "Frecuencia",
    freq_daily:         "Diario",
    freq_weekly:        "Semanal",
    preview_digest_btn: "Ver el resumen de hoy",
    subscribe_btn:      "Suscribirse →",
    subscribe_confirm_note: "Le enviamos un enlace de confirmación — las alertas comienzan solo después de que lo haga clic, así que nadie puede suscribirle excepto usted.",
    empty_preview:      "Cree una alerta y presione Vista previa para ver el resumen con los avisos reales de hoy.",

    // Time/schedule strings
    when_daily:  "Los nuevos resultados se envían cada mañana, alrededor de las 9 a.m. hora de Nueva York (8 a.m. nov–mar).",
    when_weekly: "Los nuevos resultados se envían los lunes por la mañana, alrededor de las 9 a.m. hora de Nueva York (8 a.m. nov–mar).",

    // Status / error messages
    loading_data:           "Cargando…",
    retry_open_data:        "No se pudo conectar a NYC Open Data. Intente de nuevo en un momento.",
    nothing_found:          "No se encontró nada. Pruebe con una palabra clave más amplia o \"Todas las RFP\".",
    check_inbox:            "Revise su bandeja de entrada.",
    sent_confirm_to:        "Le enviamos un enlace de confirmación a {email} — su alerta comienza cuando lo haga clic.",
    turnstile_fail:         "La verificación de humano no pasó — inténtelo de nuevo.",
    rate_limited:           "Demasiados intentos — espere un momento.",
    bad_email:              "Esa dirección de correo no parece correcta.",
    channel_unsupported:    "Las alertas por SMS aún no están disponibles — elija Correo.",
    not_configured:         "Las suscripciones aún no están activadas.",
    send_failed:            "No se pudo enviar el correo ahora — inténtelo de nuevo.",
    generic_error:          "Algo salió mal — inténtelo de nuevo.",
    complete_human_check:   "Complete la verificación “Soy humano” de arriba primero.",
    sending_confirm_link:   "Enviando su enlace de confirmación…",
    cant_reach_server:      "No se pudo conectar al servidor — inténtelo de nuevo.",

    // Deadline chips
    closes_today:     "cierra hoy",
    closes_in_1_day:  "cierra en un día",
    closes_in_n_days: "cierra en {n} días",

    // Notice content language note
    notices_in_english_note: "El texto de los avisos aparece en inglés original.",
    notices_in_english_es:   "Los avisos aparecen en inglés original.",

    // Footer / nav
    about_link:     "Acerca de",
    stats_link:     "Estadísticas",
    data_link:      "Datos",
    api_link:       "API",
    changelog_link: "Registro de cambios",

    // Language switcher
    lang_switcher_label: "Idioma",
  },

  // Stubs for remaining LL30 languages — translations pending (wave 6 phases 2–4)
  fr: {}, ht: {}, ru: {}, bn: {}, "zh-Hans": {}, "zh-Hant": {}, ko: {}, ar: {}, ur: {}, pl: {},
};

// Expose globals consumed by index.html
window.STRINGS = STRINGS;
window.LANG_META = LANG_META;
window.SUPPORTED_LANGS = SUPPORTED_LANGS;

// t(key, vars) — look up a string in the active language, fall back to en.
// vars: optional object with {placeholder: value} substitutions.
function t(key, vars) {
  const lang = window.LANG || "en";
  const dict = STRINGS[lang] || STRINGS.en;
  let str = dict[key] !== undefined ? dict[key] : (STRINGS.en[key] !== undefined ? STRINGS.en[key] : key);
  if (vars) {
    Object.entries(vars).forEach(function(kv) {
      str = str.replace(new RegExp("\\{" + kv[0] + "\\}", "g"), kv[1]);
    });
  }
  return str;
}
window.t = t;

// applyStrings() — walk data-i18n elements and replace textContent.
function applyStrings() {
  const lang = window.LANG || "en";
  document.querySelectorAll("[data-i18n]").forEach(function(el) {
    const key = el.dataset.i18n;
    const translated = t(key);
    if (el.children.length === 0) {
      el.textContent = translated;
    }
  });
  document.documentElement.lang = lang;
  const meta = LANG_META[lang];
  if (meta) document.documentElement.dir = meta.dir;
}
window.applyStrings = applyStrings;

// setLang(lang) — switch language, persist to localStorage, re-apply strings.
function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = "en";
  window.LANG = lang;
  try { localStorage.setItem("crol_lang", lang); } catch(e) {}
  applyStrings();
}
window.setLang = setLang;

// Locale-aware date formatter — replaces the hardcoded "en-US" in fdt().
function fdtLocale(s, lang) {
  if (!s) return "";
  const d = new Date(s);
  const meta = LANG_META[lang || window.LANG || "en"];
  const locale = meta ? meta.intlDate : "en-US";
  return d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}
window.fdtLocale = fdtLocale;

// Locale-aware number formatter.
function fmtNumber(n, lang) {
  const meta = LANG_META[lang || window.LANG || "en"];
  const locale = meta ? meta.intlDate : "en-US";
  return new Intl.NumberFormat(locale).format(n);
}
window.fmtNumber = fmtNumber;

// Init: restore saved language preference on module load (before DOMContentLoaded).
(function() {
  var saved = "en";
  try { saved = localStorage.getItem("crol_lang") || "en"; } catch(e) {}
  if (!SUPPORTED_LANGS.includes(saved)) saved = "en";
  window.LANG = saved;
})();
