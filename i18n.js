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
    footer_notices: "1M+ notices",
    sugg_money_0: "construction contracts over $500k",
    sugg_money_1: "IT consulting RFPs",
    sugg_money_2: "shelter services contracts",
    sugg_people_0: "paramedic roles",
    sugg_people_1: "look up someone named Rodriguez",
    sugg_people_2: "attorney titles",
    sugg_land_0: "rezonings in Brooklyn",
    sugg_land_1: "rezonings in Queens",
    sugg_land_2: "79 Rivington",
    sugg_property_0: "HPD property sales",
    sugg_property_1: "environmental protection land",
    sugg_property_2: "police department property",
    sugg_rules_0: "buildings rules",
    sugg_rules_1: "sanitation rules",
    sugg_rules_2: "taxi rules",
    sugg_meetings_0: "recent landmarks hearings",
    sugg_meetings_1: "recent city council hearings",
    sugg_meetings_2: "recent community board meetings",
    sugg_alerts_0: "awards over $1M",
    sugg_alerts_1: "construction RFPs",
    sugg_alerts_2: "rezonings near 79 Rivington",
    all_agencies_loading: "All agencies — loading…",
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
    pick_notice_empty:"Pick a notice on the left to trace it — for an RFP you'll see <b>how to respond</b> (deadline, contact, where to submit) and the full notice → award → dollars chain.",

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

    // Controls / labels
    show_label_meetings: "Show",
    mode_upcoming:       "Upcoming",
    mode_all_recent:     "All (recent)",
    search_label:        "Search",
    borough_label:       "Borough",
    all_boroughs:        "All boroughs",
    zip_addr_neighborhood: "ZIP, address, or neighborhood",
    status_label:        "Status",
    status_active:       "In review / active",
    status_all:          "All",
    look_up_pmode:       "Look up",
    filters_toggle:      "Filters",

    // Keyword placeholders
    kw_placeholder_money:   "shelter, IT, construction, security…",
    kw_placeholder_land:    "Bushwick, 79 Rivington, Gowanus…",
    kw_placeholder_property: "address, neighborhood…",
    kw_placeholder_rules:   "sanitation, licensing, rent, sidewalk…",
    kw_placeholder_meetings: "Community Board, Brooklyn, landmark…",
    kw_placeholder_people_role:   "emergency medical, attorney, engineer…",
    kw_placeholder_people_person: "last name, e.g. Rodriguez",
    nl_placeholder_people:   "e.g. paramedic roles, or look up someone named Rodriguez",
    nl_placeholder_land:     "e.g. rezonings in Brooklyn, or 79 Rivington",
    nl_placeholder_property: "e.g. HPD property sales, DEP land",
    nl_placeholder_rules:    "e.g. buildings rules, sanitation rules",
    nl_placeholder_meetings: "e.g. recent landmarks hearings, city council",
    nl_placeholder_alerts:   "e.g. email me awards over $1M, or construction RFPs",

    // People panel
    roles_heading:       "Roles",
    people_heading:      "People",
    listing_heading:     "Listing",
    land_listing_heading: "Listing",
    try_a_title_empty:   "Try a title like \"emergency medical\" -- or switch to a person.",
    pick_role_empty:     "Pick a role to see its official title, whether it needs an exam, its salary band, and the career ladder.",
    pick_result_empty:   "Pick a result on the left.",
    type_keyword_empty:  "Type a keyword to search.",

    // Land panel
    recent_rezonings_heading: "Recent rezonings",
    pick_rezoning_empty: "Pick a rezoning to see it in plain English -- applicant, what's being built, affordable units, status -- and on a map. Try \"79 Rivington\" or \"Gowanus\".",

    // Money panel
    open_rfps_heading:   "Open Requests for Proposals (RFPs)",
    all_rfps_heading:    "All RFPs",
    recent_awards_heading: "Recent Awards",
    pick_notice_panel_heading: "Money trail",
    preview_panel_heading: "Preview",

    // Quiz panel
    quiz_narrow_placeholder: "pick a topic above first…",
    quiz_param_agency:   "agency (optional) -- e.g. Buildings",

    // Alert builder labels
    param_label_min_award:    "Minimum award",
    param_label_keyword:      "Keyword (optional)",
    param_label_vendor:       "Vendor name",
    param_label_agency_name:  "Agency name (as printed)",
    param_label_place:        "ZIP, address, or neighborhood (optional)",
    param_placeholder_rfpkw:  "construction, IT, security…",
    param_placeholder_vendor: "Consolidated Scaffolding, Sinergia…",
    param_placeholder_agency: "Design and Construction, Buildings…",
    param_placeholder_rezone: "79 Rivington, Allen Street, Bushwick…",
    param_placeholder_rules:  "e-bike, sidewalk, licensing…",
    param_placeholder_meetings: "community board, landmarks…",
    param_placeholder_property: "Brooklyn, auction, HPD…",
    afreq_daily_opt:  "Daily",
    afreq_weekly_opt: "Weekly",

    // Today's Edition strip
    latest_edition_suffix: "· LATEST EDITION",
    closing_soon_lbl:      "Closing soon",
    largest_award_lbl:     "Largest award, this edition",
    next_hearing_lbl:      "Next public hearing",

    // Loading / status
    loading_notice:   "loading notice…",
    building_profile: "building profile…",
    pulling_payroll:  "pulling payroll…",
    fetching_today:   "fetching today's matching notices…",
    translating:      "translating…",

    // Dynamic headings (search())
    head_open:              "Open Requests for Proposals (RFPs)",
    head_allrfp:            "All RFPs",
    head_award:             "Recent Awards",
    head_closing_this_week: " · closing this week",

    // Empty states
    no_titles_match:   "No titles match. Try a broader word.",
    no_personnel:      "No personnel notices match that name. Try a last name.",
    no_zap:            "No Zoning Application Portal (ZAP) rezonings",
    nothing_found_feed: "Nothing found. Try a broader search.",
    could_not_reach:   "Could not reach NYC Open Data. Retry.",

    // Feed card actions
    city_record_link:       "City Record ↗",
    copy_link_btn:          "Copy link",
    map_link:               "Map ↗",
    still_standing_btn:     "Still standing?",

    // Footer
    footer_lede:       "CROL-List searches the City Record Open Data",
    footer_about:      "About",
    footer_investigation: "My investigation",
    footer_api:        "API & feeds",
    footer_changelog:  "Changelog",
    footer_stats:      "Stats",

    // Skip link
    skip_to_content: "Skip to content",

    // Announcements (sr-only)
    or_more_results: "{n} or more results",
    results_count: "{n} results",

    // Event countdown (eventTag)
    event_today: "today",
    event_in_n_days: "in {n} day{s}",

    // Deadline
    due_today_tag: "due today",
    deadline_respond_by: "Respond by {date}",

    // Detail panel actions
    copy_link: "Copy link",
    copied: "Copied",
    add_deadline_calendar: "Add deadline to calendar",
    email_a_response: "Email a response",
    bid_on_passport: "Bid on PASSPort",
    how_to_respond_heading: "How to respond to this RFP",

    // Alerts / feeds area
    prefer_feeds_html: "Prefer feeds? This watch is also",

    // Notices-in-English
    notices_in_english_note_inline: "Notice text appears in the original English.",
  },

  es: {
    footer_notices: "más de un millón de avisos",
    sugg_money_0: "contratos de construcción de más de $500k",
    sugg_money_1: "solicitudes de propuestas de consultoría informática",
    sugg_money_2: "contratos de servicios de albergue",
    sugg_people_0: "puestos de paramédico",
    sugg_people_1: "buscar a alguien llamado Rodríguez",
    sugg_people_2: "títulos de abogado",
    sugg_land_0: "rezonificaciones en Brooklyn",
    sugg_land_1: "rezonificaciones en Queens",
    sugg_land_2: "79 Rivington",
    sugg_property_0: "ventas de propiedades de HPD",
    sugg_property_1: "terrenos de protección ambiental",
    sugg_property_2: "propiedades del departamento de policía",
    sugg_rules_0: "reglas de edificios",
    sugg_rules_1: "reglas de sanidad",
    sugg_rules_2: "reglas de taxis",
    sugg_meetings_0: "audiencias recientes de monumentos",
    sugg_meetings_1: "audiencias recientes del concejo municipal",
    sugg_meetings_2: "reuniones recientes de juntas comunitarias",
    sugg_alerts_0: "adjudicaciones de más de $1M",
    sugg_alerts_1: "solicitudes de propuestas de construcción",
    sugg_alerts_2: "rezonificaciones cerca de 79 Rivington",
    all_agencies_loading: "Todas las agencias — cargando…",
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

    // Controls / labels
    show_label_meetings: "Mostrar",
    mode_upcoming:       "Proximos",
    mode_all_recent:     "Todos (recientes)",
    search_label:        "Buscar",
    borough_label:       "Distrito",
    all_boroughs:        "Todos los distritos",
    zip_addr_neighborhood: "Codigo postal, direccion o vecindario",
    status_label:        "Estado",
    status_active:       "En revision / activo",
    status_all:          "Todos",
    look_up_pmode:       "Buscar",
    filters_toggle:      "Filtros",

    // Keyword placeholders
    kw_placeholder_money:   "refugio, TI, construccion, seguridad…",
    kw_placeholder_land:    "Bushwick, 79 Rivington, Gowanus…",
    kw_placeholder_property: "direccion, vecindario…",
    kw_placeholder_rules:   "saneamiento, licencias, alquiler, acera…",
    kw_placeholder_meetings: "Junta Comunitaria, Brooklyn, patrimonio…",
    kw_placeholder_people_role:   "paramedico de emergencias, abogado, ingeniero…",
    kw_placeholder_people_person: "apellido, p. ej. Rodriguez",
    nl_placeholder_people:   "p. ej. roles de paramedico, o buscar a alguien llamado Rodriguez",
    nl_placeholder_land:     "p. ej. rezonificaciones en Brooklyn, o 79 Rivington",
    nl_placeholder_property: "p. ej. ventas de propiedades de HPD, terrenos de DEP",
    nl_placeholder_rules:    "p. ej. reglas de edificios, reglas de saneamiento",
    nl_placeholder_meetings: "p. ej. audiencias recientes de patrimonio, concejo municipal",
    nl_placeholder_alerts:   "p. ej. alertarme de adjudicaciones sobre $1M, o RFP de construccion",

    // People panel
    roles_heading:       "Cargos",
    people_heading:      "Personas",
    listing_heading:     "Listado",
    land_listing_heading: "Listado",
    try_a_title_empty:   "Pruebe un titulo como \"paramedico de emergencias\" -- o cambie a persona.",
    pick_role_empty:     "Seleccione un cargo para ver su titulo oficial, si requiere examen, su banda salarial y la escalera profesional.",
    pick_result_empty:   "Seleccione un resultado a la izquierda.",
    type_keyword_empty:  "Escriba una palabra clave para buscar.",

    // Land panel
    recent_rezonings_heading: "Rezonificaciones recientes",
    pick_rezoning_empty: "Seleccione una rezonificacion para verla en lenguaje claro -- solicitante, que se va a construir, unidades asequibles, estado -- y en un mapa. Pruebe \"79 Rivington\" o \"Gowanus\".",

    // Money panel
    open_rfps_heading:   "Solicitudes de propuestas (RFP) abiertas",
    all_rfps_heading:    "Todas las RFP",
    recent_awards_heading: "Adjudicaciones recientes",
    pick_notice_panel_heading: "Rastro del dinero",
    preview_panel_heading: "Vista previa",

    // Quiz panel
    quiz_narrow_placeholder: "primero elija un tema arriba…",
    quiz_param_agency:   "agencia (opcional) -- p. ej. Buildings",

    // Alert builder labels
    param_label_min_award:    "Monto minimo",
    param_label_keyword:      "Palabra clave (opcional)",
    param_label_vendor:       "Nombre del proveedor",
    param_label_agency_name:  "Nombre de la agencia (como aparece impreso)",
    param_label_place:        "Codigo postal, direccion o vecindario (opcional)",
    param_placeholder_rfpkw:  "construccion, TI, seguridad…",
    param_placeholder_vendor: "Consolidated Scaffolding, Sinergia…",
    param_placeholder_agency: "Design and Construction, Buildings…",
    param_placeholder_rezone: "79 Rivington, Allen Street, Bushwick…",
    param_placeholder_rules:  "bicicleta electrica, acera, licencias…",
    param_placeholder_meetings: "junta comunitaria, patrimonio…",
    param_placeholder_property: "Brooklyn, subasta, HPD…",
    afreq_daily_opt:  "Diario",
    afreq_weekly_opt: "Semanal",

    // Today's Edition strip
    latest_edition_suffix: "· ULTIMA EDICION",
    closing_soon_lbl:      "Cierra pronto",
    largest_award_lbl:     "Mayor adjudicacion, esta edicion",
    next_hearing_lbl:      "Proxima audiencia publica",

    // Loading / status
    loading_notice:   "cargando aviso…",
    building_profile: "construyendo perfil…",
    pulling_payroll:  "consultando nomina…",
    fetching_today:   "consultando avisos de hoy…",
    translating:      "traduciendo…",

    // Dynamic headings
    head_open:              "Solicitudes de propuestas (RFP) abiertas",
    head_allrfp:            "Todas las RFP",
    head_award:             "Adjudicaciones recientes",
    head_closing_this_week: " · cierra esta semana",

    // Empty states
    no_titles_match:   "Ningun titulo coincide. Pruebe con una palabra mas amplia.",
    no_personnel:      "Ningun aviso de personal coincide con ese nombre. Pruebe con un apellido.",
    no_zap:            "No hay rezonificaciones en el Portal de Solicitudes de Zonificacion (ZAP)",
    nothing_found_feed: "No se encontro nada. Pruebe con una busqueda mas amplia.",
    could_not_reach:   "No se pudo conectar a NYC Open Data. Intente de nuevo.",

    // Feed card actions
    city_record_link:       "Registro municipal ↗",
    copy_link_btn:          "Copiar enlace",
    map_link:               "Mapa ↗",
    still_standing_btn:     "¿Sigue en pie?",

    // Footer
    footer_lede:       "CROL-List busca en el Registro Municipal de Datos Abiertos",
    footer_about:      "Acerca de",
    footer_investigation: "Mi investigacion",
    footer_api:        "API y fuentes",
    footer_changelog:  "Registro de cambios",
    footer_stats:      "Estadisticas",

    // Skip link
    skip_to_content: "Ir al contenido",

    // Announcements (sr-only)
    or_more_results: "{n} o mas resultados",
    results_count: "{n} resultados",

    // Event countdown
    event_today: "hoy",
    event_in_n_days: "en {n} dia{s}",

    // Deadline
    due_today_tag: "vence hoy",
    deadline_respond_by: "Responder antes del {date}",

    // Detail panel actions
    copy_link: "Copiar enlace",
    copied: "Copiado",
    add_deadline_calendar: "Agregar fecha limite al calendario",
    email_a_response: "Enviar respuesta por correo",
    bid_on_passport: "Licitar en PASSPort",
    how_to_respond_heading: "Como responder a esta RFP",

    // Alerts / feeds area
    prefer_feeds_html: "Prefiere fuentes? Este seguimiento tambien esta disponible como",

    // Notices-in-English
    notices_in_english_note_inline: "El texto de los avisos aparece en ingles original.",
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

// applyStrings() — walk data-i18n elements and replace textContent;
// data-i18n-html elements get innerHTML replaced (allows inline markup in translations);
// also update placeholder attributes on data-i18n-placeholder elements.
function applyStrings() {
  const lang = window.LANG || "en";
  document.querySelectorAll("[data-i18n]").forEach(function(el) {
    const key = el.dataset.i18n;
    const translated = t(key);
    if (el.children.length === 0) {
      el.textContent = translated;
    }
  });
  document.querySelectorAll("[data-i18n-html]").forEach(function(el) {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function(el) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
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
