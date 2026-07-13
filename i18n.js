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
    quiz_rfpkw:         "City contracts and RFPs",
    quiz_bigaward:      "Big contract awards",
    quiz_rezone:        "Rezonings near me",
    quiz_property:      "Property sales",
    quiz_rules:         "Rule changes",
    quiz_meetings:      "Hearings and meetings",
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
    watch_meetings:     "Public hearings and meetings",
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
    latest_edition_suffix: "· latest edition",
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
    city_record_link:       "City Record",
    copy_link_btn:          "Copy link",
    map_link:               "Map",
    still_standing_btn:     "Still standing?",

    // Footer
    footer_lede:       "CROL-List searches the City Record Open Data",
    footer_about:      "About",
    footer_investigation: "My investigation",
    footer_api:        "API and feeds",
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

    // ---- Dynamically-built chrome (2026-07-13 hotfix: strings composed in JS
    // template literals bypassed the dictionary; every builder now routes here) ----

    // Today strip
    today_summary: "<b>{n}</b> notices from <b>{a}</b> agencies",
    due_on: "due {date}",
    untitled: "(untitled)",
    untitled_notice: "(untitled notice)",

    // Deadline / event tags
    closed_tag: "closed",
    open_days_left: "open · {n} days left",
    days_left_1: "1 day left",
    days_left_n: "{n} days left",

    // Money list + facet
    no_linkable_pin: "no linkable PIN",
    method_facet_label: "Method:",
    narrowed_note: "Full-history search was slow — showing <b>recent editions only</b> (since {date}). Add an agency or keyword to search all years faster.",

    // Money detail / chain / glance / how-to-respond
    copy_link_notice: "Copy link to this notice",
    pin_btn: "Pin",
    pinned_open_inv: "✓ Pinned — open investigation ({n})",
    total_awarded_lbl: "total awarded,<br>on record",
    awards_published_lbl: "contract awards<br>published",
    glance_who: "Who",
    glance_what: "What",
    glance_when: "When",
    glance_act: "Act",
    awarded_to: "→ awarded to",
    published_on: "published {date}",
    responses_due_html: "responses due <b>{date}</b>",
    event_on_html: "event <b>{date}</b>",
    paper_trail_heading: "The paper trail (notices sharing this PIN)",
    full_timeline_link: "full timeline with payments",
    notice_fallback: "Notice",
    view_in_city_record: "View in City Record",
    pin_unusable_note: "This notice's PIN isn't usable for linking (<code>{pin}</code>), so its award can't be traced automatically. Open it in the City Record to read the full text.",
    only_notice_note: "Only this notice is on record so far — no later stage has been published for PIN <code>{pin}</code> yet. ",
    award_pending_note: "The award may still be pending.",
    blanket_note: "PIN <code>{pin}</code> is a <b>blanket code</b>: it bundles {n} separate awards (common for emergency declarations). Each box is a distinct contract under the same code.",
    what_they_want: "What they want",
    apply_method_lbl: "Method",
    apply_contact_lbl: "Contact",
    apply_submit_lbl: "Submit / request to",
    call_btn: "Call {phone}",
    apply_pnote_html: "<b>Email a response</b> opens a pre-filled letter of intent to the listed contact — edit before sending. Competitive bids are ultimately submitted through <b>PASSPort</b>. Nothing leaves your device until you hit send.",

    // Screen-reader announcements
    matching_roles_announce: "{n} matching roles",
    rezonings_announce: "{n} rezonings",
    property_notices_announce: "{n} property notices",
    notices_announce: "{n} notices",

    // People lens
    try_label: "Try:",
    exam_suffix: " · exam",
    competitive_badge: "Competitive — civil-service exam required",
    noncompetitive_badge: "Non-competitive — no exam",
    median_base_lbl: "median base · FY{fy}",
    base_range_lbl: "base range",
    people_lbl: "people",
    base_salary_band_lbl: "base salary band",
    average_base_lbl: "average base",
    people_fy_lbl: "people · FY{fy}",
    career_ladder_top: "Career ladder — top titles by average pay",
    career_ladder_matching: "Career ladder — matching titles by average pay",
    refreshing_payroll: "refreshing from live payroll…",
    exam_title_tag: "exam title",
    no_exam_title_tag: "no-exam title",
    salary_note_html: "Salary band from <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Citywide Payroll FY{fy}</a>; exam status from the <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\">Civil Service List</a>, which lists competitive (exam) titles only — a title absent there is treated as no-exam.",
    n_notices_meta: "{n} notice{s}",
    base_salary_fy_lbl: "base salary · FY{fy}",
    gross_paid_lbl: "gross paid",
    overtime_lbl: "overtime",
    payroll_title_lbl: "Payroll title:",
    no_payroll_match_note: "No matching Citywide Payroll record (new hires lag a fiscal year, or the name differs across datasets).",
    city_record_history: "City Record history",
    code_label: "code {code}",

    // Land lens
    rezonings_heading: "Rezonings",
    banner_on_block: "On this block — {label}.",
    banner_none_nearest: "No rezoning on this block. Nearest in <b>{area}</b>:",
    banner_none_active_nearest: "No active rezoning on this block. Nearest in <b>{area}</b>:",
    banner_none_lot: "No rezoning filed on this lot ({label}). Active rezonings near <b>{area}</b>:",
    no_zap_kw: " for “{kw}”",
    zap_explainer_html: "ZAP indexes by <i>project</i>, not address — a notice about your block can be missing here while still in <a href=\"https://a856-cityrecord.nyc.gov/Search/Advanced\">The City Record</a>.",
    affordable_housing_tag: "affordable housing",
    unnamed_project: "(unnamed project)",
    unnamed: "(unnamed)",
    status_na: "status n/a",
    mih_tag: "Mandatory Inclusionary Housing",
    applicant_lbl: "applicant",
    where_lbl: "where",
    in_plain_english: "In plain English",
    actions_lbl: "Actions:",
    zap_full_project: "Full project on Zoning Application Portal (ZAP)",
    alert_me_area: "Alert me about this area",
    search_city_record: "Search the City Record",
    rezoning_notice_link: "This rezoning's notice in the City Record",
    locating: "locating…",
    map_approx_note_html: "{label}. <span class=\"muted\">Approximate — confirm exact lots on <a href=\"https://zola.planning.nyc.gov/\">ZoLa</a>.</span>",
    showing_lots_note_html: "Showing {n} rezoned tax lot{s} (NYC MapPLUTO). <span class=\"muted\">Confirm on <a href=\"https://zola.planning.nyc.gov/\">ZoLa</a>.</span>",
    map_needs_connection: "Map needs a connection.",
    location_not_resolved: "Location not resolved.",
    lot_not_geocoded: "{boro} — exact lot not geocoded",
    zapact_zm: "Zoning map amendment",
    zapact_zr: "Zoning text amendment",
    zapact_za: "Authorization",
    zapact_zc: "Certification",
    zapact_zs: "Special permit",
    zapact_ha: "Disposition (HPD)",
    zapact_pc: "Acquisition",
    zapact_hg: "Urban renewal",

    // Property explorer
    all_types: "All types",
    asset_realty: "Real property",
    asset_forest: "Forest / timber",
    asset_vehequip: "Vehicles + equipment",
    asset_medallion: "Medallions",
    asset_seized: "Seized / unclaimed",
    asset_other: "Other",
    stage_all: "All stages",
    stage_proposed: "● Proposed (hearing)",
    stage_soon: "◷ Closing soon",
    stage_upcoming: "◷ Upcoming",
    stage_past: "✓ Past / decided",
    badge_upset_price: "upset price ${amt}",
    badge_min_bid: "min bid ${amt}",
    badge_appraised: "appraised ${amt}",
    badge_nominal: "$1 nominal",
    add_date_btn: "Add {date}",
    checking_dob: "… checking DOB",
    lot_not_resolved: "lot not resolved",
    demolition_status_html: "Demolition: <b>{status}</b>",
    no_demo_permit: "✓ No demolition permit on this lot",

    // Alerts / digest preview
    watchlbl_property: "property sale notices",
    watchlbl_rules: "rule changes",
    watchlbl_meetings: "public hearings and meetings",
    freq_daily_lc: "daily",
    freq_weekly_lc: "weekly",
    desc_bigaward: "{freq} digest of NYC contract awards over {amt}",
    desc_rfpkw: "{freq} digest of open RFPs matching “{kw}”",
    desc_vendor: "{freq} digest — every new notice naming vendor “{name}”",
    desc_agency_watch: "{freq} digest — anything “{name}” publishes",
    desc_section: "{freq} digest of {what}{bits}",
    desc_matching: " matching “{kw}”",
    desc_from_agency: " from {agency}",
    desc_rezone_near: "{freq} digest of rezonings near “{place}”",
    desc_rezone_city: "{freq} digest of new rezonings citywide",
    your_digest_subject: "Your {desc}",
    no_matches_today_html: "No matching notices today — so you&#39;d get nothing. (That&#39;s the point: signal, not noise.)",
    digest_footer: "{n} notice{s} today · from The City Record · unsubscribe any time (one click)",
    event_meta: "event {date}",
    days_paren: " ({n} days)",
    respond_lbl: "Respond",
    view_on_crol: "↗ View on CROL-List",
    unnamed_rezoning: "(unnamed rezoning)",
    view_comment_zap: "View and comment on ZAP",
    hearing_notice_cr: "hearing notice in City Record",
    feeds_suffix: "— no email needed.",
    calendar_ics: "Calendar (.ics)",
    saved_alerts_heading: "Saved alerts (demo)",
    remove_btn: "remove",
    enter_valid_email: "Enter a valid email address.",
    subs_need_backend: "Subscriptions need the backend, which isn't wired in this build.",
    quizph_rfpkw: "keyword — construction, IT, catering…",
    quizph_bigaward: "(uses the $1M+ threshold — tune it below)",
    quizph_rezone: "place — 79 Rivington, Bushwick…",
    quizph_property: "keyword — Brooklyn, auction…",
    quizph_rules: "keyword — e-bike, sidewalk…",
    quizph_meetings: "keyword — community board, landmarks…",
    pick_topic_first: "← pick a topic first",

    // Clipboard
    copied_check: "✓ Copied",
    copy_failed: "⚠ Couldn't copy",

    // Notice permalink shell (showNotice)
    fetching_notice_id: "fetching notice {id}…",
    notice_not_found_html: "Notice <code>{id}</code> wasn't found in the City Record Open Data — it may be very new, or the ID may be mistyped.",
    back_browse: "← Browse CROL-List",
    try_city_record: "try it in the City Record",
    notice_email_btn: "Email",
    notice_print_btn: "Print",
    add_to_calendar_btn: "Add to calendar",
    read_full_notice: "Read the full notice (original City Record text)",
    permalink_note_html: "Permalink: <code>{link}</code> · request ID <code>{id}</code> · from NYC Open Data",

    // Investigation workspace (2026-07-13 hotfix 2: localStorage-gated panel shipped English-only)
    inv_ws_heading: "Investigation workspace · stored only in this browser",
    inv_default_name: "My investigation",
    inv_name_aria: "Investigation name",
    inv_pinned_meta: "{n} pinned item{s} · started {date}",
    inv_empty: "Nothing pinned yet — use the Pin button on any notice, vendor, agency, or matter page.",
    inv_share_btn: "Share (read-only link)",
    inv_export_csv: "Export .csv",
    inv_export_json: "Export .json",
    inv_print_btn: "Print dossier",
    inv_clear_btn: "Clear all",
    inv_footer_note_html: "Every exported item carries its permalink + the date you pinned it — citation-grade by construction. Sharing uploads a read-only snapshot (90-day link); nothing else ever leaves this browser.",
    inv_pinned_on: "pinned {date}",
    inv_note_placeholder: "add a note…",
    pintype_notice: "notice",
    pintype_vendor: "vendor",
    pintype_agency: "agency",
    pintype_matter: "matter",
    inv_pin_first: "Pin something first.",
    inv_share_needs_backend: "Sharing needs the backend.",
    inv_uploading: "uploading snapshot…",
    inv_readonly_link: "Read-only link (lives {n} days):",
    inv_copy_btn: "copy",
    inv_too_many_shares: "Too many shares today — try tomorrow.",
    inv_share_failed: "Couldn't share — try again.",
    inv_fetching_shared: "fetching shared investigation…",
    inv_shared_heading: "Shared investigation · read-only · snapshot of {date}",
    inv_shared_missing_html: "This shared investigation doesn't exist or has expired (links live 90 days).",
    inv_import_btn: "Import into my investigation",
    untitled_name: "Untitled",
    meta_agency_profile: "agency profile",
    meta_vendor_profile: "vendor profile",
    meta_matter: "Matter — PIN {pin}",
    // Accessible names (aria-label via data-i18n-aria — 2026-07-13 label-census remediation)
    nl_aria: "Describe what you're looking for in plain English",
    invnote_aria: "Note for this pinned item",

    // ---- Subpage chrome + content (about/data/stats/api/changelog) — crol-subpages-es ----
    site_kicker: "The City Record, searchable",
    back_home_aria: "Back to CROL-List home",
    back_to_crol: "← Back to CROL-List",
    home_link: "Home",
    data_page_h1: "The Data",

    // about.html
    about_h_what: "What this is",
    about_p_what_html: "CROL-List is a search interface over <a href=\"https://a856-cityrecord.nyc.gov/\">The City Record</a> — the City of New York's official daily journal, where <a href=\"https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-3113\">every agency must publish</a> its contracts, hearings, rule changes, rezonings, and personnel moves. CROL-List makes that record searchable <em>by interest</em>: follow a contract, decode a job title, track a rezoning, or get an email when something new matches.",
    about_h_content: "About our content",
    about_p_content: "An AI assistant (Claude) drafts this site's copy — headings, explanations, pages like this one. A human editor checks it before it goes live. The data is not AI-generated. Every notice, dollar figure, and date comes straight from NYC Open Data, unedited.",
    about_h_source: "Where the data comes from",
    about_p_source_html: "Everything is live, public data — queried straight from your browser, nothing cached: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Online (dg92-zbpx)</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Citywide Payroll (k397-673e)</a> · <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\">Civil Service List (vx8i-nprf)</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\">ZAP Projects (hgx4-8ukb)</a> · <a href=\"https://a0333-passportpublic.nyc.gov/\">PASSPort</a> · <a href=\"https://www.checkbooknyc.com/\">Checkbook NYC</a>.",
    about_h_honest: "The data, to be honest",
    about_p_honest_intro_html: "The City Record dataset is <b>1.09 million notices back to 2003</b> — and it is not what it looks like at first glance. Our team's exploratory analysis of the full dataset found quirks that would silently mislead if we didn't correct for them, so here is exactly what we do:",
    about_li_honest_html: "<li><b>87.5% of all rows are civil-service personnel changes</b>, not civic notices. Every statistic on this site is computed within its own section — a \"global\" City Record number would really be a personnel-file number.</li><li><b>A few contract amounts are data-entry errors</b> — three rows claim $10&nbsp;billion or more, topping out at <a href=\"index.html#notice/20210524108\">$96 <em>trillion</em>, a housing-services award whose amount field is plainly a typo</a> (the largest verified real award is <a href=\"index.html#notice/20180109010\">≈$6.68B, the city's 10-year electricity contract with NYPA</a>). Money filters and amount-sorted digests exclude amounts ≥ $10B rather than let one typo dominate every ranking.</li><li><b>Some \"due dates\" aren't deadlines.</b> Pre-qualified-list notices carry placeholder dates in the year 2090+; we label these \"no fixed deadline (rolling)\" instead of showing a date no one should calendar.</li><li><b>Agency names come in two conventions</b> (legacy ALL-CAPS and Title Case — 312 raw strings for ~150 real agencies); our name resolution treats them as one.</li>",
    about_p_honest_footer_html: "To keep alerts fast, our server keeps a mirror of recent notices, refreshed daily from the same public dataset — NYC Open Data remains the source of truth, and searches on this site always query it live. Want the numbers themselves? <a href=\"data.html\"><b>The Data</b></a> shows the record at a glance — sections, volume, procurement mix, top agencies and vendors — computed live with these same rules.",
    about_h_flags: "Flags and context, explained",
    about_p_flags_intro_html: "Procurement notices carry two kinds of computed annotation. Both are <b>statistical context, not findings or accusations</b> — a flag means \"worth a closer look,\" and every formula has innocent explanations (emergencies are real, specialized markets have few bidders, name matching is imperfect). The approach follows the <a href=\"https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/\">Open Contracting Partnership's red-flags methodology</a> and <a href=\"https://opentender.eu/\">Opentender's</a> integrity indicators.",
    about_li_flags_html: "<li><b>⚑ Short ad window</b> — the days between a solicitation's publication and its response deadline, flagged when it is 10 days or fewer <em>and</em> less than half the agency's own median (median computed over that agency's last 200 solicitations). Short windows favor incumbents who already knew the work was coming.</li><li><b>⚑ Non-competitive method</b> — the notice's own stated selection method is a negotiated acquisition, sole-source, emergency, or demonstration-project procurement. Sometimes justified; always worth knowing.</li><li><b>⚑ Repeat awards</b> — the same vendor name has 3+ award notices at the same agency within 90 days. Can reflect a blanket contract's task orders as easily as favoritism — the flag counts, you judge.</li><li><b>Context strip</b> — an award's size as a percentile of that agency's awards over the trailing 12 months (shown only when the agency has ≥20 awards in the window), and the vendor's share of the agency's award dollars over the same window (exact published name; name variants are not merged here).</li>",
    about_p_flags_footer_html: "All figures come live from the <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Open Data</a> at the moment you view the notice — awards <em>as published</em>, which lag contract registration and actual payment. Nothing here asserts wrongdoing; it saves you the arithmetic.",
    about_h_feedback: "Send feedback",
    about_p_feedback: "Found a bug, want a feature, or have a thought? Send it here. We read everything. No account needed.",
    about_label_kind: "What kind?",
    fb_cat_bug: "Bug",
    fb_cat_feature: "Feature idea",
    fb_cat_general: "General",
    about_label_message: "Your message",
    about_ph_message: "What happened, what you'd want, or anything else — the more specific the better.",
    about_label_email: "Email",
    about_label_email_opt: "— optional, only if you'd like a reply",
    about_btn_send: "Send feedback →",
    about_note_feedback_html: "If you add your email, we keep it only to reply. Each submission also records basic request metadata — your IP address and browser — kept briefly to block spam. See <a href=\"#privacy\">Privacy</a>.",
    about_err_short: "Add a little more detail — at least a sentence.",
    about_err_long: "That's a bit long — please keep it under 2,000 characters.",
    about_err_bademail: "That email address looks off — leave it blank if you don't want a reply.",
    about_sending: "sending…",
    about_thanks_html: "<b>Thank you — got it.</b>",
    about_thanks_reply: " We'll reply if there's anything to add.",
    about_reason_ratelimited: "Too many messages — give it a little while.",
    about_reason_badmessage: "The message was empty, too short, or too long.",
    about_reason_badcategory: "Pick a category — Bug, Feature idea, or General.",
    about_reason_notconfigured: "Feedback isn't switched on yet.",
    about_reason_sendfailed: "Couldn't record that just now — try again in a moment.",
    about_foot_html: "CROL-List · a search interface over <a href=\"https://a856-cityrecord.nyc.gov/\">The City Record</a> · <a href=\"changelog.html\">Changelog</a> · <a href=\"stats.html\">Stats</a> · <a href=\"index.html\">Home</a>",
    about_h_privacy: "Privacy",
    about_p_privacy_intro: "No accounts, no cookies, no cross-site tracking, no ad tech. Here is exactly what CROL-List does with your data:",
    about_li_privacy_html: "<li><b>Searches and filters</b> go straight from your browser to NYC Open Data — CROL-List's server never sees them.</li><li><b>The \"Ask\" box</b> (plain-English search) sends your text to our worker, which forwards it to Anthropic's Claude to turn it into filters. We don't store the text — only a daily tally, to cap costs.</li><li><b>Subscribing or sending feedback</b> stores what you submit — your alert or message, and your email if you give one — plus basic request metadata (IP address and browser) kept briefly to block spam and abuse. Every alert email has one-click unsubscribe.</li><li><b>Page views</b> are measured with Cloudflare Web Analytics: cookieless and aggregate. It counts visits; it does not identify you or follow you across sites.</li>",

    // data.html
    data_p_lede_html: "The City Record dataset, at a glance — live aggregates queried straight from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">NYC Open Data</a> by your browser, nothing cached server-side. Numbers here follow the <a href=\"about.html#data\">honesty rules</a>: statistics stay within their section, apparent data-entry errors (amounts ≥ $10B) are excluded, and placeholder deadlines aren't counted as real.",
    data_h_sections_html: "What the record actually contains <span class=\"note\">(all time, by section)</span>",
    data_note_sections_body: "Most of the City Record is paperwork about civil-service jobs. The notices that matter to the public are only a small part of it. That is why every number on this site is shown per section.",
    data_h_volume_html: "Publication volume <span class=\"note\">(last 12 months)</span>",
    data_h_procmix_html: "Procurement mix <span class=\"note\">(last 12 months, by notice type)</span>",
    data_h_agencies_html: "Top agencies by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_agencies_html: "\"Cleaned\" = amounts over $10B excluded as data-entry errors; see <a href=\"about.html#data\">the underlying data</a>.",
    data_h_vendors_html: "Top vendors by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_vendors: "Vendor names are not standardized in the source. Small spelling differences show up as separate rows here.",
    data_loading_counting: "Counting 1M+ notices…",
    data_fail: "Couldn't reach NYC Open Data just now — reload to retry.",
    data_foot_html: "Every number computes live in your browser from the public dataset — reload for fresh data. Methodology: <a href=\"about.html#data\">about → the underlying data</a> · <a href=\"stats.html\">site usage stats</a> · <a href=\"changelog.html\">changelog</a>",

    // stats.html
    stats_p_lede_html: "A transparency tool should publish its own usage. These are CROL-List's live operating numbers — <b>aggregate counts only</b>: the site has no accounts and no cookies, and neither we nor anyone else can see who did what. We measure outcomes (watches that fired, digests that got read), not people.",
    stats_loading: "Loading live counters…",
    stats_lbl_subs: "Active subscriptions",
    stats_desc_subs: "Confirmed standing watches — the number that matters most to us.",
    stats_lbl_digests: "Digests sent · 7 days",
    stats_desc_digests_html: "<span id=\"s-digests-today\">–</span> today. Only when something new matched (plus honest \"still watching\" check-ins).",
    stats_lbl_clicks: "Digest links followed · 7 days",
    stats_desc_clicks_html: "Counted by a redirect that records a number, never a person — <a href=\"changelog.html#2026-07-02b\">how this works</a>.",
    stats_lbl_feeds: "Feed fetches · 7 days",
    stats_desc_feeds: "RSS/Atom/JSON/calendar pulls, as seen at the origin (edge-cached hits aren't counted).",
    stats_lbl_batch: "Batch cross-references · 7 days",
    stats_desc_batch_html: "Watchlists checked through the <a href=\"api.html\">open API</a>.",
    stats_lbl_inv: "Investigations shared · 7 days",
    stats_desc_inv: "Read-only workspace snapshots created.",
    stats_lbl_nl: "Plain-English searches · today",
    stats_desc_nl: "\"Ask in plain English\" calls against the daily spending ceiling.",
    stats_h_dontknow: "What we deliberately don't know",
    stats_p_dontknow_html: "Who you are, what you searched, which notices you read, or which emails you opened. Page-view totals come from Cloudflare's cookieless analytics (aggregate, no fingerprinting — <a href=\"about.html\">privacy notes</a>); everything above comes from plain per-day counters. There is nothing else.",
    stats_foot_html: "Raw JSON: <a href=\"https://api.crol-list.org/stats\">api.crol-list.org/stats</a> (cached ~15 min) · <a href=\"changelog.html\">Changelog</a> · <a href=\"about.html\">About</a> · <a href=\"index.html\">Home</a>",
    stats_asof: "As of {date} (refreshes every 15 minutes).",
    stats_unreachable: "Live counters are unreachable right now — the raw JSON lives at api.crol-list.org/stats.",

    // api.html
    api_p_intro_html: "Every view on CROL-List has a machine-readable twin. No key, no account; endpoints are rate-limited and cached, and none touches a paid service. Base URL: <code>https://api.crol-list.org</code>.",
    api_h_feeds: "Feeds — any search as RSS / JSON / calendar",
    api_p_feeds_html: "<code>GET /feed.xml</code> (Atom) · <code>GET /feed.json</code> (JSON Feed 1.1) · <code>GET /feed.ics</code> (subscribable calendar — one event per dated notice). Edge-cached 15 minutes.",
    api_th_param: "Param",
    api_th_meaning: "Meaning",
    api_row_q: "keywords (up to 4)",
    api_row_agency: "agency name as printed in the record",
    api_row_min: "minimum award $ (money lens → award feed)",
    api_row_kindname_html: "entity lens: <code>kind=vendor|agency</code>, <code>name=…</code> — vendor names are matched by normalized stem, so suffix/case variants are included",
    api_h_batch: "Batch cross-reference",
    api_p_batch_html: "<code>POST /batch</code> with <code>{\"names\": [\"…\", …]}</code> (≤10 names/request, 30 requests/day/IP). For each name: <b>awards</b> = award/intent notices naming that vendor (name-stem matched, all years); <b>mentions</b> = full-text hits in the last two years of editions; <b>entity</b> = the vendor-profile permalink when awards exist.",
    api_label_try: "Try it — one name per line",
    api_btn_batch: "Cross-reference →",
    api_err_noname: "Add at least one name (3+ characters).",
    api_crossreferencing: "cross-referencing…",
    api_res_name: "Name",
    api_res_awards: "Awards (vendor of record)",
    api_res_mentions: "Mentions (last 2 yrs)",
    api_link_vendorprofile: "vendor profile →",
    api_link_search: "search →",
    api_err_ratelimited: "Daily limit reached — try tomorrow.",
    api_err_generic: "Couldn't cross-reference — try again.",
    api_h_permalinks: "Permalinks",
    api_p_permalinks: "Everything on the site has a stable address you can link or cite:",
    api_row_notice: "one notice — at-a-glance summary, flags, Checkbook dollars, full text",
    api_row_vendor: "vendor profile (name variants resolved by stem)",
    api_row_matter: "a procurement matter as a timeline, Checkbook payments included",
    api_row_anyview: "any filtered view — the URL is the state",
    api_h_sharedinv: "Shared investigations",
    api_p_sharedinv_html: "<code>POST /inv</code> stores a pin-list snapshot (structured fields only, ≤32KB, 90-day TTL, 10/day/IP) and returns an id; <code>GET /inv/&lt;id&gt;</code> reads it back. The site renders these at <code>/#investigation/shared/&lt;id&gt;</code>.",
    api_h_stats: "Public stats",
    api_p_stats_html: "<code>GET /stats</code> — the project's own usage as aggregate counts (active subscriptions, digests sent, digest links followed, feed/batch/share activity). No personal data exists behind it; cached ~15 minutes. Human-readable version: <a href=\"stats.html\">stats</a>. Related: digest emails link notices via <code>GET /r/&lt;kind&gt;/&lt;request_id&gt;</code>, a count-only redirect to the notice permalink — it accepts a validated id (never a URL, so it can't redirect off-site) and records a per-day number, never a person.",
    api_h_subscribe: "Subscribe by email",
    api_p_subscribe_html: "Email <a href=\"mailto:subscribe@crol-list.org\"><code>subscribe@crol-list.org</code></a> describing what you want in plain English — e.g. <em>\"construction contract awards over $500k\"</em> or <em>\"rezoning notices in Brooklyn\"</em>. You'll get back a confirmation link describing how we understood your request; the watch starts only after you click it (double opt-in). Daily ceilings apply; nothing is stored until you confirm.",
    api_h_mcp: "MCP — for AI assistants",
    api_p_mcp_html: "<code>POST /mcp</code> (Streamable HTTP, JSON-RPC) — point an MCP client at <code>https://api.crol-list.org/mcp</code>. Tools: <code>search_notices</code> and <code>get_notice</code> (the daily-refreshed notices mirror, honest-data rules applied), <code>preview_watch</code> (plain English → what a standing watch would deliver, without subscribing), and <code>create_watch</code> (plain English → a double-opt-in confirmation email; digests start only after the address confirms). Watch management stays behind the emailed unsubscribe links — knowing an address never reveals or controls its subscriptions. Per-IP and daily model-call ceilings apply.",
    api_h_upstream: "Upstream data",
    api_p_upstream_html: "CROL-List republishes and joins public datasets — for bulk work, go straight to the sources: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Online (dg92-zbpx, Socrata SODA)</a> · <a href=\"https://www.checkbooknyc.com/data-feeds/api\">Checkbook NYC API</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Citywide Payroll</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\">ZAP</a>.",
    api_foot_html: "CROL-List · <a href=\"index.html\">Home</a> · <a href=\"about.html\">About</a>",

    // changelog.html
    chg_p_lede_html: "What changed, when, and what it means for you — including the mistakes. Versions are dates (<a href=\"https://calver.org/\">CalVer</a>): the site ships continuously, so a date tells the truth where a version number would be theater. A tool that watches the city's public record should keep a public record of itself. Live usage numbers: <a href=\"stats.html\">stats</a>.",
    chg_detail_note: "The detailed technical notes below each release (bullet lists, incident reports) remain in English for now.",
    chg_foot_html: "CROL-List is an unofficial, free interface to public data. <a href=\"about.html\">About</a> · <a href=\"stats.html\">Stats</a> · <a href=\"api.html\">API and feeds</a> · <a href=\"index.html\">Home</a>",
    chg_0710e_h2: "2026.07.10 · Espanol coverage: the whole interface, not just the chrome",
    chg_0710e_foryou_html: "<b>Para usted</b> — Phase 2 of Spanish support: the entire visible interface now translates when you switch to Espanol. Phase 1 covered tabs, buttons, and short labels (98 keys). Phase 2 adds the empty states, search placeholders, panel headings, the Today's Edition strip, alert builder labels and parameters, loading messages, and all control labels across every lens (Money, People, Land, Property, Rules, Meetings, Alerts) -- growing the dictionary from 98 to over 200 keys. A new residual-English coverage gate in the test suite verifies 15 high-visibility sentinel strings are absent in Espanol mode.",
    chg_0710d_h2: "2026.07.10 · Spanish support + style-guide copy pass",
    chg_0710d_foryou_html: "<b>For you</b> — A language switcher now appears in the header (English / Espanol). Choosing Spanish translates all tabs, chips, and messages in the UI; notices themselves stay in English, which is the official language of the City Record. Your preference is remembered across visits. Separately, time chips, deadline chips, and the feedback-category selector were updated to follow the NYC Web Content Style Guide: \"9 a.m.\" (not \"9 AM\"), spelled-out numbers (\"closes in two days\"), and acronym expansions on first use (RFP, M/WBE, ZAP). City Record content is now marked <code>translate=\"no\"</code> so machine-translation tools leave it intact.",
    chg_0710c_h2: "2026.07.10 · Accessibility: an enforced floor, not a promise",
    chg_0710c_foryou_html: "<b>For you</b> — If you use a keyboard or a screen reader, the rough edges are getting fixed for real: the feedback form's category picker now works without a mouse, the plain-English search box announces itself properly, low-contrast text is corrected site-wide, and the \"minimum award\" filter genuinely disables when it doesn't apply instead of just fading. From now on, an automated accessibility check (axe) runs against every page in our test harness — a change that breaks accessibility fails the build. CONTRIBUTING and SECURITY were also rewritten to describe how the project is actually governed and defended.",
    chg_0710b_h2: "2026.07.10 · Three new front doors: email-in, MCP, and The Data",
    chg_0710b_foryou_html: "<b>For you</b> — Three new ways in. <b>Subscribe by email:</b> write to <a href=\"mailto:subscribe@crol-list.org\">subscribe@crol-list.org</a> in plain English (\"construction awards over $500k\") and you'll get a confirmation link back — no form, no CAPTCHA, just your words. <b>For AI assistants:</b> point any MCP client at <code>api.crol-list.org/mcp</code> to search notices and set up watches programmatically (double opt-in still applies — nothing sends without the address confirming). <b><a href=\"data.html\">The Data</a>:</b> a new page showing the City Record at a glance — what's actually in it, publication volume, procurement mix, top agencies and vendors by cleaned dollars — computed live in your browser from NYC Open Data.",
    chg_0710_h2: "2026.07.10 · Honest data rules + a faster backbone (with Dev Doshi)",
    chg_0710_foryou_html: "<b>For you</b> — Money filters and digests can no longer be hijacked by the dataset's data-entry errors: amounts ≥ $10B (there's a $96 trillion typo in the official record) are excluded, while real multi-billion awards now correctly appear — the old cutoff silently dropped everything above $5B, including the largest legitimate award (≈$6.68B). Pre-qualified-list notices with placeholder year-2090 dates now say \"no fixed deadline (rolling)\" instead of a date no one should calendar. The <a href=\"about.html#data\">About page documents the dataset's quirks</a> — what the City Record actually contains and how we correct for it.",
    chg_0709_h2: "2026.07.09 · Predictive Procurement: Checkbook Expirations, MOCS Plans, &amp; Early-Warning Timelines",
    chg_0709_foryou_html: "<b>For you</b> — CROL-List now alerts you 6 months <em>before</em> contracts expire or new RFPs are published. Agency and vendor profiles show a new <b>\"Procurement Forecast\"</b> tab with a vertical chronological timeline, uniting predicted contract renewals (from Checkbook NYC) and official agency-planned solicitations (from Charter §112 MOCS datasets). Digests now deliver early-warning notifications for upcoming forecasts matching your watches.",
    chg_0702d_h2: "2026.07.02 · Fix: vendors with punctuated names resolve again",
    chg_0702d_foryou_html: "<b>For you</b> — Vendor pages and vendor watches now work for names like \"Leon D. Dematteis Construction Corp.\" Before this fix, clicking such a vendor showed \"no awards on record\" and a watch on them matched nothing — despite their awards being right there.",
    chg_0702c_h2: "2026.07.02 · Snap + crisp: the round-four speed-and-declutter pass",
    chg_0702c_foryou_html: "<b>For you</b> — The site looks calmer and feels immediate. Lists show content-shaped placeholders instead of spinners; filtering keeps your place instead of blanking the list; going back to a tab you already loaded is instant; clicking a notice paints its detail at once (the paper trail fills in a beat later). Search runs as you type — the Filter buttons are gone because you no longer need them.",
    chg_0702b_h2: "2026.07.02 · Enablement: public stats, honest click counts, this page",
    chg_0702b_foryou_html: "<b>For you</b> — You can now see the project's own usage numbers at <a href=\"stats.html\">/stats</a> (aggregate counts only — no accounts, no cookies, nobody tracked). Email-digest links now pass through a count-only redirect so we can tell digests are useful; it counts <em>clicks per day</em>, never who clicked, and every digest footer says so.",
    chg_0702_h2: "2026.07.02 · Follow the dollars, matter timelines, follows, workspace, API",
    chg_0702_foryou_html: "<b>For you</b> — Awards now show what was <em>actually paid</em> (live from Checkbook NYC), any procurement matter reads as one timeline, you can follow a vendor or agency and get emailed when they reappear, pin anything into a citable investigation workspace, and use every view as an API.",
    chg_0701_h2: "2026.07.01 · Entity pages, red flags in context — and the first ten, all in one day",
    chg_0701_foryou_html: "<b>For you</b> — Every vendor and agency became a page (with totals, top partners, and open RFPs), procurement notices carry statistical context instead of bare text, and the whole search-and-subscribe layer landed: watch any search, get a morning email digest, grab any view as RSS/calendar, share any notice by URL, and see deadlines as countdowns instead of dates.",
    chg_0630_h2: "2026.06.30 · Real subscriptions",
    chg_0630_foryou_html: "<b>For you</b> — Email alerts became real: double opt-in (nothing is stored until you click the confirmation link), one-click unsubscribe, and your address is only ever used to send you your own digest.",
    chg_0626_h2: "2026.06.26 · crol-list.org",
    chg_0626_foryou_html: "<b>For you</b> — The site got its own domain and a real \"ask in plain English\" box on every lens (with an on-device fallback, so search works even if the helper is down).",
    chg_0624_h2: "2026.06.24–25 · The seven lenses",
    chg_0624_foryou_html: "<b>For you</b> — The tool took its shape: Money, People, Land, Property, Rules, Meetings, and Alerts, in the letterpress design, over live open data with nothing cached.",

    // wave 9: es SR surface (L1-L6) + page titles + toggle/vendor-disclosure copy
    tablist_label: "Lenses",
    fb_kind_label: "What kind of feedback?",
    meta_agency_profile_announce: "Agency profile: {name}",
    meta_vendor_profile_announce: "Vendor profile: {name}",
    meta_matter_timeline_announce: "Matter timeline: {n} events",
    mini_subscribe_btn: "Subscribe to Alert",
    vendor_profile_variants: "Vendor profile · {n} name variant{s} resolved",
    which_variants_btn: "which?",
    index_title: "CROL-List · track RFPs, rezonings, meetings",
    about_title: "About · CROL-List",
    data_title: "The Data · CROL-List",
    stats_title: "Stats · CROL-List",
    changelog_title: "Changelog · CROL-List",
    api_title: "API and feeds · CROL-List",
    map_marker_alt: "Rezoning project location",
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
    mode_upcoming:       "Próximos",
    mode_all_recent:     "Todos (recientes)",
    search_label:        "Buscar",
    borough_label:       "Distrito",
    all_boroughs:        "Todos los distritos",
    zip_addr_neighborhood: "Código postal, dirección o vecindario",
    status_label:        "Estado",
    status_active:       "En revisión / activo",
    status_all:          "Todos",
    look_up_pmode:       "Buscar",
    filters_toggle:      "Filtros",

    // Keyword placeholders
    kw_placeholder_money:   "refugio, TI, construcción, seguridad…",
    kw_placeholder_land:    "Bushwick, 79 Rivington, Gowanus…",
    kw_placeholder_property: "dirección, vecindario…",
    kw_placeholder_rules:   "saneamiento, licencias, alquiler, acera…",
    kw_placeholder_meetings: "Junta Comunitaria, Brooklyn, patrimonio…",
    kw_placeholder_people_role:   "paramédico de emergencias, abogado, ingeniero…",
    kw_placeholder_people_person: "apellido, p. ej. Rodriguez",
    nl_placeholder_people:   "p. ej. roles de paramédico, o buscar a alguien llamado Rodriguez",
    nl_placeholder_land:     "p. ej. rezonificaciones en Brooklyn, o 79 Rivington",
    nl_placeholder_property: "p. ej. ventas de propiedades de HPD, terrenos de DEP",
    nl_placeholder_rules:    "p. ej. reglas de edificios, reglas de saneamiento",
    nl_placeholder_meetings: "p. ej. audiencias recientes de patrimonio, concejo municipal",
    nl_placeholder_alerts:   "p. ej. alertarme de adjudicaciones sobre $1M, o RFP de construcción",

    // People panel
    roles_heading:       "Cargos",
    people_heading:      "Personas",
    listing_heading:     "Listado",
    land_listing_heading: "Listado",
    try_a_title_empty:   "Pruebe un título como \"paramédico de emergencias\" -- o cambie a persona.",
    pick_role_empty:     "Seleccione un cargo para ver su título oficial, si requiere examen, su banda salarial y la escalera profesional.",
    pick_result_empty:   "Seleccione un resultado a la izquierda.",
    type_keyword_empty:  "Escriba una palabra clave para buscar.",

    // Land panel
    recent_rezonings_heading: "Rezonificaciones recientes",
    pick_rezoning_empty: "Seleccione una rezonificación para verla en lenguaje claro — solicitante, qué se va a construir, unidades asequibles, estado -- y en un mapa. Pruebe \"79 Rivington\" o \"Gowanus\".",

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
    param_label_place:        "Código postal, dirección o vecindario (opcional)",
    param_placeholder_rfpkw:  "construcción, TI, seguridad…",
    param_placeholder_vendor: "Consolidated Scaffolding, Sinergia…",
    param_placeholder_agency: "Design and Construction, Buildings…",
    param_placeholder_rezone: "79 Rivington, Allen Street, Bushwick…",
    param_placeholder_rules:  "bicicleta eléctrica, acera, licencias…",
    param_placeholder_meetings: "junta comunitaria, patrimonio…",
    param_placeholder_property: "Brooklyn, subasta, HPD…",
    afreq_daily_opt:  "Diario",
    afreq_weekly_opt: "Semanal",

    // Today's Edition strip
    latest_edition_suffix: "· última edición",
    closing_soon_lbl:      "Cierra pronto",
    largest_award_lbl:     "Mayor adjudicación, esta edición",
    next_hearing_lbl:      "Próxima audiencia pública",

    // Loading / status
    loading_notice:   "cargando aviso…",
    building_profile: "construyendo perfil…",
    pulling_payroll:  "consultando nómina…",
    fetching_today:   "consultando avisos de hoy…",
    translating:      "traduciendo…",

    // Dynamic headings
    head_open:              "Solicitudes de propuestas (RFP) abiertas",
    head_allrfp:            "Todas las RFP",
    head_award:             "Adjudicaciones recientes",
    head_closing_this_week: " · cierra esta semana",

    // Empty states
    no_titles_match:   "Ningún título coincide. Pruebe con una palabra más amplia.",
    no_personnel:      "Ningún aviso de personal coincide con ese nombre. Pruebe con un apellido.",
    no_zap:            "No hay rezonificaciones en el Portal de Solicitudes de Zonificación (ZAP)",
    nothing_found_feed: "No se encontró nada. Pruebe con una búsqueda más amplia.",
    could_not_reach:   "No se pudo conectar a NYC Open Data. Intente de nuevo.",

    // Feed card actions
    city_record_link:       "Registro municipal",
    copy_link_btn:          "Copiar enlace",
    map_link:               "Mapa",
    still_standing_btn:     "¿Sigue en pie?",

    // Footer
    footer_lede:       "CROL-List busca en el Registro Municipal de Datos Abiertos",
    footer_about:      "Acerca de",
    footer_investigation: "Mi investigación",
    footer_api:        "API y fuentes",
    footer_changelog:  "Registro de cambios",
    footer_stats:      "Estadísticas",

    // Skip link
    skip_to_content: "Ir al contenido",

    // Announcements (sr-only)
    or_more_results: "{n} o más resultados",
    results_count: "{n} resultados",

    // Event countdown
    event_today: "hoy",
    event_in_n_days: "en {n} día{s}",

    // Deadline
    due_today_tag: "vence hoy",
    deadline_respond_by: "Responder antes del {date}",

    // Detail panel actions
    copy_link: "Copiar enlace",
    copied: "Copiado",
    add_deadline_calendar: "Agregar fecha limite al calendario",
    email_a_response: "Enviar respuesta por correo",
    bid_on_passport: "Licitar en PASSPort",
    how_to_respond_heading: "Cómo responder a esta RFP",

    // Alerts / feeds area
    prefer_feeds_html: "¿Prefiere fuentes? Este seguimiento también está disponible como",

    // Notices-in-English
    notices_in_english_note_inline: "El texto de los avisos aparece en inglés original.",

    // ---- Dynamically-built chrome (2026-07-13 hotfix) ----
    // es: machine-translated, pending native review (Anna's CBO network, wave 6).

    // Today strip
    today_summary: "<b>{n}</b> avisos de <b>{a}</b> agencias",
    due_on: "vence el {date}",
    untitled: "(sin título)",
    untitled_notice: "(aviso sin título)",

    // Deadline / event tags
    closed_tag: "cerrada",
    open_days_left: "abierta · quedan {n} días",
    days_left_1: "queda 1 día",
    days_left_n: "quedan {n} días",

    // Money list + facet
    no_linkable_pin: "sin PIN enlazable",
    method_facet_label: "Método:",
    narrowed_note: "La búsqueda del historial completo fue lenta — mostrando <b>solo ediciones recientes</b> (desde {date}). Agregue una agencia o palabra clave para buscar todos los años más rápido.",

    // Money detail / chain / glance / how-to-respond
    copy_link_notice: "Copiar enlace a este aviso",
    pin_btn: "Fijar",
    pinned_open_inv: "✓ Fijado — abrir investigación ({n})",
    total_awarded_lbl: "total adjudicado,<br>registrado",
    awards_published_lbl: "adjudicaciones de contratos<br>publicadas",
    glance_who: "Quién",
    glance_what: "Qué",
    glance_when: "Cuándo",
    glance_act: "Actuar",
    awarded_to: "→ adjudicado a",
    published_on: "publicado el {date}",
    responses_due_html: "respuestas antes del <b>{date}</b>",
    event_on_html: "evento el <b>{date}</b>",
    paper_trail_heading: "El rastro documental (avisos que comparten este PIN)",
    full_timeline_link: "cronología completa con pagos",
    notice_fallback: "Aviso",
    view_in_city_record: "Ver en el Registro Municipal",
    pin_unusable_note: "El PIN de este aviso no sirve para enlazar (<code>{pin}</code>), así que su adjudicación no puede rastrearse automáticamente. Ábralo en el City Record para leer el texto completo.",
    only_notice_note: "Solo este aviso consta hasta ahora — todavía no se ha publicado una etapa posterior para el PIN <code>{pin}</code>. ",
    award_pending_note: "La adjudicación puede estar aún pendiente.",
    blanket_note: "El PIN <code>{pin}</code> es un <b>código global</b>: agrupa {n} adjudicaciones separadas (común en declaraciones de emergencia). Cada caja es un contrato distinto bajo el mismo código.",
    what_they_want: "Qué buscan",
    apply_method_lbl: "Método",
    apply_contact_lbl: "Contacto",
    apply_submit_lbl: "Enviar / solicitar a",
    call_btn: "Llamar al {phone}",
    apply_pnote_html: "<b>Enviar respuesta por correo</b> abre una carta de intención prellenada al contacto indicado — edítela antes de enviar. Las ofertas competitivas se presentan finalmente a través de <b>PASSPort</b>. Nada sale de su dispositivo hasta que pulse enviar.",

    // Screen-reader announcements
    matching_roles_announce: "{n} cargos coincidentes",
    rezonings_announce: "{n} rezonificaciones",
    property_notices_announce: "{n} avisos de propiedades",
    notices_announce: "{n} avisos",

    // People lens
    try_label: "Pruebe:",
    exam_suffix: " · examen",
    competitive_badge: "Competitivo — requiere examen del servicio civil",
    noncompetitive_badge: "No competitivo — sin examen",
    median_base_lbl: "base mediana · año fiscal {fy}",
    base_range_lbl: "rango de base",
    people_lbl: "personas",
    base_salary_band_lbl: "banda salarial base",
    average_base_lbl: "base promedio",
    people_fy_lbl: "personas · año fiscal {fy}",
    career_ladder_top: "Escalera profesional — principales títulos por salario promedio",
    career_ladder_matching: "Escalera profesional — títulos coincidentes por salario promedio",
    refreshing_payroll: "actualizando desde la nómina en vivo…",
    exam_title_tag: "título con examen",
    no_exam_title_tag: "título sin examen",
    salary_note_html: "Banda salarial de la <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Nómina Municipal año fiscal {fy}</a>; el estado de examen proviene de la <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\">Lista del Servicio Civil</a>, que solo incluye títulos competitivos (con examen) — un título ausente allí se trata como sin examen.",
    n_notices_meta: "{n} aviso{s}",
    base_salary_fy_lbl: "salario base · año fiscal {fy}",
    gross_paid_lbl: "bruto pagado",
    overtime_lbl: "horas extra",
    payroll_title_lbl: "Título en nómina:",
    no_payroll_match_note: "No hay registro coincidente en la Nómina Municipal (las nuevas contrataciones tardan un año fiscal, o el nombre difiere entre conjuntos de datos).",
    city_record_history: "Historial en el Registro Municipal",
    code_label: "código {code}",

    // Land lens
    rezonings_heading: "Rezonificaciones",
    banner_on_block: "En esta manzana — {label}.",
    banner_none_nearest: "No hay rezonificación en esta manzana. La más cercana en <b>{area}</b>:",
    banner_none_active_nearest: "No hay rezonificación activa en esta manzana. La más cercana en <b>{area}</b>:",
    banner_none_lot: "No hay rezonificación registrada en este lote ({label}). Rezonificaciones activas cerca de <b>{area}</b>:",
    no_zap_kw: " para “{kw}”",
    zap_explainer_html: "ZAP indexa por <i>proyecto</i>, no por dirección — un aviso sobre su manzana puede faltar aquí y aun así estar en <a href=\"https://a856-cityrecord.nyc.gov/Search/Advanced\">The City Record</a>.",
    affordable_housing_tag: "vivienda asequible",
    unnamed_project: "(proyecto sin nombre)",
    unnamed: "(sin nombre)",
    status_na: "estado n/d",
    mih_tag: "Vivienda Inclusiva Obligatoria (MIH)",
    applicant_lbl: "solicitante",
    where_lbl: "dónde",
    in_plain_english: "En lenguaje claro",
    actions_lbl: "Acciones:",
    zap_full_project: "Proyecto completo en el Portal de Solicitudes de Zonificación (ZAP)",
    alert_me_area: "Avisarme sobre esta zona",
    search_city_record: "Buscar en el Registro Municipal",
    rezoning_notice_link: "El aviso de esta rezonificación en el Registro Municipal",
    locating: "localizando…",
    map_approx_note_html: "{label}. <span class=\"muted\">Aproximado — confirme los lotes exactos en <a href=\"https://zola.planning.nyc.gov/\">ZoLa</a>.</span>",
    showing_lots_note_html: "Mostrando {n} lote{s} rezonificado{s} (NYC MapPLUTO). <span class=\"muted\">Confirme en <a href=\"https://zola.planning.nyc.gov/\">ZoLa</a>.</span>",
    map_needs_connection: "El mapa necesita conexión.",
    location_not_resolved: "Ubicación no resuelta.",
    lot_not_geocoded: "{boro} — lote exacto no geocodificado",
    zapact_zm: "Enmienda al mapa de zonificación",
    zapact_zr: "Enmienda al texto de zonificación",
    zapact_za: "Autorización",
    zapact_zc: "Certificación",
    zapact_zs: "Permiso especial",
    zapact_ha: "Disposición (HPD)",
    zapact_pc: "Adquisición",
    zapact_hg: "Renovación urbana",

    // Property explorer
    all_types: "Todos los tipos",
    asset_realty: "Bienes inmuebles",
    asset_forest: "Bosques / madera",
    asset_vehequip: "Vehículos y equipos",
    asset_medallion: "Medallones",
    asset_seized: "Incautados / no reclamados",
    asset_other: "Otros",
    stage_all: "Todas las etapas",
    stage_proposed: "● Propuesto (audiencia)",
    stage_soon: "◷ Cierra pronto",
    stage_upcoming: "◷ Próximos",
    stage_past: "✓ Pasado / decidido",
    badge_upset_price: "precio mínimo ${amt}",
    badge_min_bid: "oferta mínima ${amt}",
    badge_appraised: "tasado ${amt}",
    badge_nominal: "$1 nominal",
    add_date_btn: "Agregar {date}",
    checking_dob: "… consultando DOB",
    lot_not_resolved: "lote no resuelto",
    demolition_status_html: "Demolición: <b>{status}</b>",
    no_demo_permit: "✓ Sin permiso de demolición en este lote",

    // Alerts / digest preview
    watchlbl_property: "avisos de venta de propiedades",
    watchlbl_rules: "cambios de reglas",
    watchlbl_meetings: "audiencias y reuniones públicas",
    freq_daily_lc: "diario",
    freq_weekly_lc: "semanal",
    desc_bigaward: "resumen {freq} de adjudicaciones de contratos de NYC superiores a {amt}",
    desc_rfpkw: "resumen {freq} de RFP abiertas que coincidan con “{kw}”",
    desc_vendor: "resumen {freq} — cada aviso nuevo que nombre al proveedor “{name}”",
    desc_agency_watch: "resumen {freq} — todo lo que publique “{name}”",
    desc_section: "resumen {freq} de {what}{bits}",
    desc_matching: " que coincidan con “{kw}”",
    desc_from_agency: " de {agency}",
    desc_rezone_near: "resumen {freq} de rezonificaciones cerca de “{place}”",
    desc_rezone_city: "resumen {freq} de nuevas rezonificaciones en toda la ciudad",
    your_digest_subject: "Su {desc}",
    no_matches_today_html: "No hay avisos coincidentes hoy — así que no recibiría nada. (Esa es la idea: señal, no ruido.)",
    digest_footer: "{n} aviso{s} hoy · del Registro Municipal · cancele la suscripción cuando quiera (un clic)",
    event_meta: "evento {date}",
    days_paren: " ({n} días)",
    respond_lbl: "Responder",
    view_on_crol: "↗ Ver en CROL-List",
    unnamed_rezoning: "(rezonificación sin nombre)",
    view_comment_zap: "Ver y comentar en ZAP",
    hearing_notice_cr: "aviso de audiencia en el Registro Municipal",
    feeds_suffix: "— sin necesidad de correo.",
    calendar_ics: "Calendario (.ics)",
    saved_alerts_heading: "Alertas guardadas (demo)",
    remove_btn: "eliminar",
    enter_valid_email: "Ingrese una dirección de correo válida.",
    subs_need_backend: "Las suscripciones necesitan el backend, que no está conectado en esta versión.",
    quizph_rfpkw: "palabra clave — construcción, TI, catering…",
    quizph_bigaward: "(usa el umbral de $1M+ — ajústelo abajo)",
    quizph_rezone: "lugar — 79 Rivington, Bushwick…",
    quizph_property: "palabra clave — Brooklyn, subasta…",
    quizph_rules: "palabra clave — bicicleta eléctrica, acera…",
    quizph_meetings: "palabra clave — junta comunitaria, patrimonio…",
    pick_topic_first: "← primero elija un tema",

    // Clipboard
    copied_check: "✓ Copiado",
    copy_failed: "⚠ No se pudo copiar",

    // Notice permalink shell (showNotice)
    fetching_notice_id: "consultando el aviso {id}…",
    notice_not_found_html: "El aviso <code>{id}</code> no se encontró en los Datos Abiertos del City Record — puede ser muy reciente, o el ID puede estar mal escrito.",
    back_browse: "← Volver a CROL-List",
    try_city_record: "búsquelo en el City Record",
    notice_email_btn: "Correo",
    notice_print_btn: "Imprimir",
    add_to_calendar_btn: "Agregar al calendario",
    read_full_notice: "Leer el aviso completo (texto original del City Record en inglés)",
    permalink_note_html: "Enlace permanente: <code>{link}</code> · ID de solicitud <code>{id}</code> · de NYC Open Data",

    // Investigation workspace (2026-07-13 hotfix 2)
    inv_ws_heading: "Espacio de investigación · guardado solo en este navegador",
    inv_default_name: "Mi investigación",
    inv_name_aria: "Nombre de la investigación",
    inv_pinned_meta: "{n} elemento{s} fijado{s} · iniciada el {date}",
    inv_empty: "Aún no hay nada fijado — use el botón Fijar en cualquier página de aviso, proveedor, agencia o expediente.",
    inv_share_btn: "Compartir (enlace de solo lectura)",
    inv_export_csv: "Exportar .csv",
    inv_export_json: "Exportar .json",
    inv_print_btn: "Imprimir expediente",
    inv_clear_btn: "Borrar todo",
    inv_footer_note_html: "Cada elemento exportado lleva su enlace permanente + la fecha en que lo fijó — con calidad de cita por construcción. Compartir sube una instantánea de solo lectura (enlace de 90 días); nada más sale de este navegador.",
    inv_pinned_on: "fijado el {date}",
    inv_note_placeholder: "agregar una nota…",
    pintype_notice: "aviso",
    pintype_vendor: "proveedor",
    pintype_agency: "agencia",
    pintype_matter: "expediente",
    inv_pin_first: "Primero fije algo.",
    inv_share_needs_backend: "Compartir requiere el backend.",
    inv_uploading: "subiendo la instantánea…",
    inv_readonly_link: "Enlace de solo lectura (dura {n} días):",
    inv_copy_btn: "copiar",
    inv_too_many_shares: "Demasiados enlaces compartidos hoy — intente mañana.",
    inv_share_failed: "No se pudo compartir — inténtelo de nuevo.",
    inv_fetching_shared: "consultando la investigación compartida…",
    inv_shared_heading: "Investigación compartida · solo lectura · instantánea del {date}",
    inv_shared_missing_html: "Esta investigación compartida no existe o ha expirado (los enlaces duran 90 días).",
    inv_import_btn: "Importar a mi investigación",
    untitled_name: "Sin título",
    meta_agency_profile: "perfil de agencia",
    meta_vendor_profile: "perfil de proveedor",
    meta_matter: "Expediente — PIN {pin}",
    // Accessible names (aria-label via data-i18n-aria)
    nl_aria: "Describa lo que busca en lenguaje claro",
    invnote_aria: "Nota para este elemento fijado",

    // ---- Subpage chrome + content (about/data/stats/api/changelog) — crol-subpages-es ----
    site_kicker: "El Registro Municipal, con búsqueda",
    back_home_aria: "Volver al inicio de CROL-List",
    back_to_crol: "← Volver a CROL-List",
    home_link: "Inicio",
    data_page_h1: "Los datos",

    // about.html
    about_h_what: "Qué es esto",
    about_p_what_html: "CROL-List es una interfaz de búsqueda sobre <a href=\"https://a856-cityrecord.nyc.gov/\">The City Record</a> — el diario oficial de la Ciudad de Nueva York, donde <a href=\"https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-3113\">toda agencia debe publicar</a> sus contratos, audiencias, cambios de reglas, rezonificaciones y movimientos de personal. CROL-List hace que ese registro se pueda buscar <em>por interés</em>: siga un contrato, descifre un título de puesto, rastree una rezonificación, o reciba un correo cuando algo nuevo coincida.",
    about_h_content: "Sobre nuestro contenido",
    about_p_content: "Un asistente de IA (Claude) redacta el texto de este sitio — títulos, explicaciones, páginas como esta. Un editor humano lo revisa antes de publicarlo. Los datos no son generados por IA. Cada aviso, cifra y fecha proviene directamente de NYC Open Data, sin editar.",
    about_h_source: "De dónde vienen los datos",
    about_p_source_html: "Todo son datos públicos en vivo — consultados directamente desde su navegador, sin nada almacenado en caché: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Online (dg92-zbpx)</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Nómina Municipal (k397-673e)</a> · <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\">Lista del Servicio Civil (vx8i-nprf)</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\">Proyectos ZAP (hgx4-8ukb)</a> · <a href=\"https://a0333-passportpublic.nyc.gov/\">PASSPort</a> · <a href=\"https://www.checkbooknyc.com/\">Checkbook NYC</a>.",
    about_h_honest: "Los datos, para ser honestos",
    about_p_honest_intro_html: "El conjunto de datos del City Record tiene <b>1.09 millones de avisos desde 2003</b> — y no es lo que parece a primera vista. El análisis exploratorio de nuestro equipo sobre el conjunto completo encontró peculiaridades que engañarían silenciosamente si no las corrigiéramos, así que esto es exactamente lo que hacemos:",
    about_li_honest_html: "<li><b>El 87.5% de todas las filas son cambios de personal del servicio civil</b>, no avisos cívicos. Cada estadística de este sitio se calcula dentro de su propia sección — una cifra \"global\" del City Record sería en realidad una cifra de expedientes de personal.</li><li><b>Algunos montos de contratos son errores de entrada de datos</b> — tres filas indican $10&nbsp;mil millones o más, llegando hasta <a href=\"index.html#notice/20210524108\">$96 <em>billones</em>, un aviso de servicios de vivienda cuyo campo de monto es claramente un error de tecleo</a> (el mayor premio real verificado es <a href=\"index.html#notice/20180109010\">≈$6.68 mil millones, el contrato eléctrico de la ciudad con NYPA a 10 años</a>). Los filtros de dinero y los resúmenes ordenados por monto excluyen cantidades ≥ $10 mil millones para que una sola errata no domine cada clasificación.</li><li><b>Algunas \"fechas límite\" no son fechas límite.</b> Los avisos de listas precalificadas llevan fechas de marcador de posición en el año 2090 o posterior; las etiquetamos como \"sin fecha límite fija (continua)\" en vez de mostrar una fecha que nadie debería anotar en su calendario.</li><li><b>Los nombres de las agencias vienen en dos convenciones</b> (MAYÚSCULAS heredadas y Formato de Título — 312 cadenas sin depurar para ~150 agencias reales); nuestra resolución de nombres las trata como una sola.</li>",
    about_p_honest_footer_html: "Para que las alertas sean rápidas, nuestro servidor mantiene un espejo de los avisos recientes, actualizado a diario desde el mismo conjunto de datos públicos — NYC Open Data sigue siendo la fuente autorizada, y las búsquedas en este sitio siempre la consultan en vivo. ¿Quiere ver los números en sí? <a href=\"data.html\"><b>Los datos</b></a> muestra el registro de un vistazo — secciones, volumen, combinación de adquisiciones, principales agencias y proveedores — calculado en vivo con estas mismas reglas.",
    about_h_flags: "Marcadores y contexto, explicados",
    about_p_flags_intro_html: "Los avisos de adquisiciones llevan dos tipos de anotación calculada. Ambas son <b>contexto estadístico, no hallazgos ni acusaciones</b> — un marcador significa \"vale la pena revisarlo más de cerca\", y cada fórmula tiene explicaciones inocentes (las emergencias son reales, los mercados especializados tienen pocos postores, la coincidencia de nombres es imperfecta). El enfoque sigue la <a href=\"https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/\">metodología de marcadores rojos de Open Contracting Partnership</a> y los indicadores de integridad de <a href=\"https://opentender.eu/\">Opentender</a>.",
    about_li_flags_html: "<li><b>⚑ Ventana de anuncio corta</b> — los días entre la publicación de una solicitud y su fecha límite de respuesta, marcada cuando son 10 días o menos <em>y</em> menos de la mitad de la mediana propia de la agencia (mediana calculada sobre las últimas 200 solicitudes de esa agencia). Las ventanas cortas favorecen a quienes ya sabían que el trabajo venía.</li><li><b>⚑ Método no competitivo</b> — el método de selección que el propio aviso declara es una adquisición negociada, de proveedor único, de emergencia, o un proyecto de demostración. A veces está justificado; siempre vale la pena saberlo.</li><li><b>⚑ Adjudicaciones repetidas</b> — el mismo proveedor tiene 3 o más avisos de adjudicación en la misma agencia dentro de 90 días. Puede reflejar las órdenes de tarea de un contrato general tanto como favoritismo — el marcador cuenta, usted juzga.</li><li><b>Franja de contexto</b> — el tamaño de una adjudicación como percentil de las adjudicaciones de esa agencia en los últimos 12 meses (se muestra solo cuando la agencia tiene ≥20 adjudicaciones en la ventana), y la participación del proveedor en los dólares adjudicados por la agencia durante la misma ventana (nombre exacto publicado; las variantes de nombre no se combinan aquí).</li>",
    about_p_flags_footer_html: "Todas las cifras provienen en vivo de <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Open Data</a> en el momento en que usted ve el aviso — adjudicaciones <em>tal como se publicaron</em>, que van con retraso respecto al registro del contrato y al pago real. Nada aquí afirma irregularidades; solo le ahorra la aritmética.",
    about_h_feedback: "Enviar comentarios",
    about_p_feedback: "¿Encontró un error, quiere una función, o tiene una idea? Envíela aquí. Leemos todo. No se necesita cuenta.",
    about_label_kind: "¿Qué tipo?",
    fb_cat_bug: "Error",
    fb_cat_feature: "Idea de función",
    fb_cat_general: "General",
    about_label_message: "Su mensaje",
    about_ph_message: "Qué pasó, qué le gustaría, o cualquier otra cosa — mientras más específico, mejor.",
    about_label_email: "Correo electrónico",
    about_label_email_opt: "— opcional, solo si desea una respuesta",
    about_btn_send: "Enviar comentarios →",
    about_note_feedback_html: "Si agrega su correo, lo conservamos solo para responder. Cada envío también registra metadatos básicos de la solicitud — su dirección IP y navegador — guardados brevemente para bloquear spam. Vea <a href=\"#privacy\">Privacidad</a>.",
    about_err_short: "Agregue un poco más de detalle — al menos una oración.",
    about_err_long: "Eso es un poco largo — manténgalo bajo 2,000 caracteres.",
    about_err_bademail: "Esa dirección de correo se ve incorrecta — déjela en blanco si no desea una respuesta.",
    about_sending: "enviando…",
    about_thanks_html: "<b>Gracias — lo recibimos.</b>",
    about_thanks_reply: " Responderemos si hay algo que añadir.",
    about_reason_ratelimited: "Demasiados mensajes — espere un momento.",
    about_reason_badmessage: "El mensaje estaba vacío, era muy corto, o muy largo.",
    about_reason_badcategory: "Elija una categoría — Error, Idea de función, o General.",
    about_reason_notconfigured: "Los comentarios aún no están activados.",
    about_reason_sendfailed: "No se pudo registrar eso ahora — inténtelo de nuevo en un momento.",
    about_foot_html: "CROL-List · una interfaz de búsqueda sobre <a href=\"https://a856-cityrecord.nyc.gov/\">The City Record</a> · <a href=\"changelog.html\">Registro de cambios</a> · <a href=\"stats.html\">Estadísticas</a> · <a href=\"index.html\">Inicio</a>",
    about_h_privacy: "Privacidad",
    about_p_privacy_intro: "Sin cuentas, sin cookies, sin rastreo entre sitios, sin tecnología publicitaria. Esto es exactamente lo que CROL-List hace con sus datos:",
    about_li_privacy_html: "<li><b>Las búsquedas y filtros</b> van directamente desde su navegador a NYC Open Data — el servidor de CROL-List nunca los ve.</li><li><b>El cuadro \"Preguntar\"</b> (búsqueda en lenguaje llano) envía su texto a nuestro worker, que lo reenvía a Claude de Anthropic para convertirlo en filtros. No almacenamos el texto — solo un conteo diario, para limitar costos.</li><li><b>Suscribirse o enviar comentarios</b> almacena lo que usted envía — su alerta o mensaje, y su correo si proporciona uno — más metadatos básicos de la solicitud (dirección IP y navegador) guardados brevemente para bloquear spam y abuso. Cada correo de alerta tiene cancelación de suscripción con un clic.</li><li><b>Las visitas a la página</b> se miden con Cloudflare Web Analytics: sin cookies y agregadas. Cuenta visitas; no lo identifica ni lo sigue entre sitios.</li>",

    // data.html
    data_p_lede_html: "El conjunto de datos del City Record, de un vistazo — agregados en vivo consultados directamente desde <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">NYC Open Data</a> por su navegador, sin nada almacenado en caché del lado del servidor. Los números aquí siguen las <a href=\"about.html#data\">reglas de honestidad</a>: las estadísticas permanecen dentro de su sección, los aparentes errores de entrada de datos (montos ≥ $10 mil millones) se excluyen, y las fechas límite de marcador de posición no se cuentan como reales.",
    data_h_sections_html: "Qué contiene realmente el registro <span class=\"note\">(todo el historial, por sección)</span>",
    data_note_sections_body: "La mayor parte del City Record es papeleo sobre empleos del servicio civil. Los avisos que le importan al público son solo una pequeña parte. Por eso cada número de este sitio se muestra por sección.",
    data_h_volume_html: "Volumen de publicación <span class=\"note\">(últimos 12 meses)</span>",
    data_h_procmix_html: "Combinación de adquisiciones <span class=\"note\">(últimos 12 meses, por tipo de aviso)</span>",
    data_h_agencies_html: "Principales agencias por dólares adjudicados <span class=\"note\">(últimos 12 meses, depurado)</span>",
    data_note_agencies_html: "\"Depurado\" = se excluyen los montos superiores a $10 mil millones por ser errores de entrada de datos; vea <a href=\"about.html#data\">los datos subyacentes</a>.",
    data_h_vendors_html: "Principales proveedores por dólares adjudicados <span class=\"note\">(últimos 12 meses, depurado)</span>",
    data_note_vendors: "Los nombres de proveedores no están normalizados en la fuente. Pequeñas diferencias de ortografía aparecen como filas separadas aquí.",
    data_loading_counting: "Contando más de 1M de avisos…",
    data_fail: "No se pudo conectar a NYC Open Data en este momento — recargue para reintentar.",
    data_foot_html: "Cada número se calcula en vivo en su navegador a partir del conjunto de datos público — recargue para obtener datos actualizados. Metodología: <a href=\"about.html#data\">acerca de → los datos subyacentes</a> · <a href=\"stats.html\">estadísticas de uso del sitio</a> · <a href=\"changelog.html\">registro de cambios</a>",

    // stats.html
    stats_p_lede_html: "Una herramienta de transparencia debería publicar su propio uso. Estos son los números operativos en vivo de CROL-List — <b>solo conteos agregados</b>: el sitio no tiene cuentas ni cookies, y ni nosotros ni nadie más puede ver quién hizo qué. Medimos resultados (alertas que se activaron, resúmenes que se leyeron), no personas.",
    stats_loading: "Cargando contadores en vivo…",
    stats_lbl_subs: "Suscripciones activas",
    stats_desc_subs: "Alertas permanentes confirmadas — el número que más nos importa.",
    stats_lbl_digests: "Resúmenes enviados · 7 días",
    stats_desc_digests_html: "<span id=\"s-digests-today\">–</span> hoy. Solo cuando algo nuevo coincidió (más chequeos honestos de \"seguimos vigilando\").",
    stats_lbl_clicks: "Enlaces de resúmenes seguidos · 7 días",
    stats_desc_clicks_html: "Contado por una redirección que registra un número, nunca una persona — <a href=\"changelog.html#2026-07-02b\">cómo funciona esto</a>.",
    stats_lbl_feeds: "Descargas de fuentes · 7 días",
    stats_desc_feeds: "Descargas de RSS/Atom/JSON/calendario, vistas en el origen (los aciertos en caché de borde no se cuentan).",
    stats_lbl_batch: "Verificaciones cruzadas por lotes · 7 días",
    stats_desc_batch_html: "Listas de vigilancia verificadas a través de la <a href=\"api.html\">API abierta</a>.",
    stats_lbl_inv: "Investigaciones compartidas · 7 días",
    stats_desc_inv: "Instantáneas de solo lectura del espacio de trabajo creadas.",
    stats_lbl_nl: "Búsquedas en lenguaje llano · hoy",
    stats_desc_nl: "Llamadas de \"Preguntar en lenguaje llano\" contra el límite diario de gasto.",
    stats_h_dontknow: "Lo que deliberadamente no sabemos",
    stats_p_dontknow_html: "Quién es usted, qué buscó, qué avisos leyó, o qué correos abrió. Los totales de vistas de página provienen de las analíticas sin cookies de Cloudflare (agregadas, sin huella digital — <a href=\"about.html\">notas de privacidad</a>); todo lo anterior proviene de simples contadores diarios. No hay nada más.",
    stats_foot_html: "JSON sin procesar: <a href=\"https://api.crol-list.org/stats\">api.crol-list.org/stats</a> (en caché ~15 min) · <a href=\"changelog.html\">Registro de cambios</a> · <a href=\"about.html\">Acerca de</a> · <a href=\"index.html\">Inicio</a>",
    stats_asof: "Al {date} (se actualiza cada 15 minutos).",
    stats_unreachable: "Los contadores en vivo no están disponibles en este momento — el JSON sin procesar está en api.crol-list.org/stats.",

    // api.html
    api_p_intro_html: "Cada vista de CROL-List tiene un equivalente legible por máquina. Sin clave, sin cuenta; los endpoints tienen límite de frecuencia y caché, y ninguno usa un servicio de pago. URL base: <code>https://api.crol-list.org</code>.",
    api_h_feeds: "Fuentes — cualquier búsqueda como RSS / JSON / calendario",
    api_p_feeds_html: "<code>GET /feed.xml</code> (Atom) · <code>GET /feed.json</code> (JSON Feed 1.1) · <code>GET /feed.ics</code> (calendario suscribible — un evento por aviso con fecha). En caché de borde 15 minutos.",
    api_th_param: "Parámetro",
    api_th_meaning: "Significado",
    api_row_q: "palabras clave (hasta 4)",
    api_row_agency: "nombre de la agencia tal como aparece en el registro",
    api_row_min: "monto mínimo de adjudicación $ (lente de dinero → fuente de adjudicaciones)",
    api_row_kindname_html: "lente de entidad: <code>kind=vendor|agency</code>, <code>name=…</code> — los nombres de proveedores se comparan por raíz normalizada, así que se incluyen variantes de sufijo/mayúsculas",
    api_h_batch: "Verificación cruzada por lotes",
    api_p_batch_html: "<code>POST /batch</code> con <code>{\"names\": [\"…\", …]}</code> (≤10 nombres/solicitud, 30 solicitudes/día/IP). Para cada nombre: <b>adjudicaciones</b> = avisos de adjudicación/intención que nombran a ese proveedor (coincidencia por raíz del nombre, todos los años); <b>menciones</b> = coincidencias de texto completo en las últimas dos ediciones anuales; <b>entidad</b> = el enlace permanente del perfil del proveedor cuando existen adjudicaciones.",
    api_label_try: "Pruébelo — un nombre por línea",
    api_btn_batch: "Verificar cruzado →",
    api_err_noname: "Agregue al menos un nombre (3+ caracteres).",
    api_crossreferencing: "verificando en cruce…",
    api_res_name: "Nombre",
    api_res_awards: "Adjudicaciones (proveedor registrado)",
    api_res_mentions: "Menciones (últimos 2 años)",
    api_link_vendorprofile: "perfil de proveedor →",
    api_link_search: "buscar →",
    api_err_ratelimited: "Límite diario alcanzado — intente mañana.",
    api_err_generic: "No se pudo verificar en cruce — inténtelo de nuevo.",
    api_h_permalinks: "Enlaces permanentes",
    api_p_permalinks: "Todo en el sitio tiene una dirección estable que puede enlazar o citar:",
    api_row_notice: "un aviso — resumen de un vistazo, marcadores, dólares de Checkbook, texto completo",
    api_row_vendor: "perfil de proveedor (las variantes de nombre se resuelven por raíz)",
    api_row_matter: "un expediente de adquisiciones como una cronología, con pagos de Checkbook incluidos",
    api_row_anyview: "cualquier vista filtrada — la URL es el estado",
    api_h_sharedinv: "Investigaciones compartidas",
    api_p_sharedinv_html: "<code>POST /inv</code> almacena una instantánea de la lista de fijados (solo campos estructurados, ≤32KB, TTL de 90 días, 10/día/IP) y devuelve un id; <code>GET /inv/&lt;id&gt;</code> lo lee de vuelta. El sitio los muestra en <code>/#investigation/shared/&lt;id&gt;</code>.",
    api_h_stats: "Estadísticas públicas",
    api_p_stats_html: "<code>GET /stats</code> — el uso propio del proyecto como conteos agregados (suscripciones activas, resúmenes enviados, enlaces de resumen seguidos, actividad de fuentes/lotes/compartidos). No hay datos personales detrás de esto; en caché ~15 minutos. Versión legible: <a href=\"stats.html\">estadísticas</a>. Relacionado: los correos de resumen enlazan avisos mediante <code>GET /r/&lt;kind&gt;/&lt;request_id&gt;</code>, una redirección de solo conteo al enlace permanente del aviso — acepta un id validado (nunca una URL, por lo que no puede redirigir fuera del sitio) y registra un número por día, nunca una persona.",
    api_h_subscribe: "Suscribirse por correo",
    api_p_subscribe_html: "Envíe un correo a <a href=\"mailto:subscribe@crol-list.org\"><code>subscribe@crol-list.org</code></a> describiendo lo que quiere en lenguaje llano — por ejemplo, <em>\"adjudicaciones de contratos de construcción de más de $500k\"</em> o <em>\"avisos de rezonificación en Brooklyn\"</em>. Recibirá de vuelta un enlace de confirmación que describe cómo entendimos su solicitud; la alerta comienza solo después de que haga clic (doble confirmación). Se aplican límites diarios; nada se almacena hasta que confirme.",
    api_h_mcp: "MCP — para asistentes de IA",
    api_p_mcp_html: "<code>POST /mcp</code> (Streamable HTTP, JSON-RPC) — apunte cualquier cliente MCP a <code>https://api.crol-list.org/mcp</code>. Herramientas: <code>search_notices</code> y <code>get_notice</code> (el espejo de avisos actualizado a diario, con las reglas de datos honestos aplicadas), <code>preview_watch</code> (lenguaje llano → lo que entregaría una alerta permanente, sin suscribirse), y <code>create_watch</code> (lenguaje llano → un correo de confirmación de doble opt-in; los resúmenes comienzan solo después de que la dirección confirma). La gestión de alertas permanece detrás de los enlaces de cancelación enviados por correo — conocer una dirección nunca revela ni controla sus suscripciones. Se aplican límites por IP y por modelo al día.",
    api_h_upstream: "Datos de origen",
    api_p_upstream_html: "CROL-List republica y combina conjuntos de datos públicos — para trabajo masivo, vaya directo a las fuentes: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\">City Record Online (dg92-zbpx, Socrata SODA)</a> · <a href=\"https://www.checkbooknyc.com/data-feeds/api\">API de Checkbook NYC</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\">Nómina Municipal</a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\">ZAP</a>.",
    api_foot_html: "CROL-List · <a href=\"index.html\">Inicio</a> · <a href=\"about.html\">Acerca de</a>",

    // changelog.html
    chg_p_lede_html: "Qué cambió, cuándo, y qué significa para usted — incluidos los errores. Las versiones son fechas (<a href=\"https://calver.org/\">CalVer</a>): el sitio se publica de forma continua, así que una fecha dice la verdad donde un número de versión sería teatro. Una herramienta que vigila el registro público de la ciudad debería mantener un registro público de sí misma. Números de uso en vivo: <a href=\"stats.html\">estadísticas</a>.",
    chg_detail_note: "Las notas técnicas detalladas debajo de cada versión (listas con viñetas, informes de incidentes) permanecen en inglés por ahora.",
    chg_foot_html: "CROL-List es una interfaz gratuita y no oficial de datos públicos. <a href=\"about.html\">Acerca de</a> · <a href=\"stats.html\">Estadísticas</a> · <a href=\"api.html\">API y fuentes</a> · <a href=\"index.html\">Inicio</a>",
    chg_0710e_h2: "2026.07.10 · Cobertura de español: toda la interfaz, no solo el marco",
    chg_0710e_foryou_html: "<b>Para usted</b> — Fase 2 del soporte en español: toda la interfaz visible ahora se traduce al cambiar a español. La fase 1 cubrió pestañas, botones y etiquetas cortas (98 claves). La fase 2 agrega los estados vacíos, los marcadores de posición de búsqueda, los encabezados de panel, la franja de la Edición de Hoy, las etiquetas y parámetros del creador de alertas, los mensajes de carga, y todas las etiquetas de control en cada lente (Dinero, Personas, Terrenos, Propiedades, Reglas, Reuniones, Alertas) — haciendo crecer el diccionario de 98 a más de 200 claves. Una nueva verificación de cobertura de inglés residual en la batería de pruebas confirma que 15 frases centinela de alta visibilidad están ausentes en modo español.",
    chg_0710d_h2: "2026.07.10 · Soporte en español + revisión de estilo de textos",
    chg_0710d_foryou_html: "<b>Para usted</b> — Ahora aparece un selector de idioma en el encabezado (English / Español). Elegir español traduce todas las pestañas, chips y mensajes de la interfaz; los avisos en sí permanecen en inglés, que es el idioma oficial del City Record. Su preferencia se recuerda entre visitas. Además, los chips de horario, los chips de fecha límite y el selector de categoría de comentarios se actualizaron para seguir la Guía de Estilo de Contenido Web de NYC: \"9 a.m.\" (no \"9 AM\"), números escritos en palabras (\"cierra en dos días\"), y expansión de siglas en su primer uso (RFP, M/WBE, ZAP). El contenido del City Record ahora está marcado con <code>translate=\"no\"</code> para que las herramientas de traducción automática lo dejen intacto.",
    chg_0710c_h2: "2026.07.10 · Accesibilidad: un piso exigido, no una promesa",
    chg_0710c_foryou_html: "<b>Para usted</b> — Si usa un teclado o un lector de pantalla, las asperezas se están corrigiendo de verdad: el selector de categoría del formulario de comentarios ahora funciona sin mouse, el cuadro de búsqueda en lenguaje llano se anuncia correctamente, el texto de bajo contraste se corrigió en todo el sitio, y el filtro de \"monto mínimo\" ahora se deshabilita de verdad cuando no aplica, en vez de solo atenuarse. De ahora en adelante, una verificación automatizada de accesibilidad (axe) se ejecuta contra cada página en nuestra batería de pruebas — un cambio que rompe la accesibilidad hace fallar la compilación. CONTRIBUTING y SECURITY también se reescribieron para describir cómo se gobierna y se defiende el proyecto en la práctica.",
    chg_0710b_h2: "2026.07.10 · Tres nuevas puertas de entrada: correo entrante, MCP y Los Datos",
    chg_0710b_foryou_html: "<b>Para usted</b> — Tres nuevas formas de entrar. <b>Suscríbase por correo:</b> escriba a <a href=\"mailto:subscribe@crol-list.org\">subscribe@crol-list.org</a> en lenguaje llano (\"adjudicaciones de construcción de más de $500k\") y recibirá de vuelta un enlace de confirmación — sin formulario, sin CAPTCHA, solo sus palabras. <b>Para asistentes de IA:</b> apunte cualquier cliente MCP a <code>api.crol-list.org/mcp</code> para buscar avisos y configurar alertas de forma programática (la doble confirmación sigue aplicando — nada se envía sin que la dirección confirme). <b><a href=\"data.html\">Los Datos</a>:</b> una nueva página que muestra el City Record de un vistazo — qué contiene realmente, volumen de publicación, combinación de adquisiciones, principales agencias y proveedores por dólares depurados — calculado en vivo en su navegador desde NYC Open Data.",
    chg_0710_h2: "2026.07.10 · Reglas de datos honestos + una base más rápida (con Dev Doshi)",
    chg_0710_foryou_html: "<b>Para usted</b> — Los filtros y resúmenes de dinero ya no pueden ser secuestrados por los errores de entrada de datos del conjunto de datos: se excluyen los montos ≥ $10 mil millones (hay una errata de $96 billones en el registro oficial), mientras que las adjudicaciones reales de varios miles de millones ahora aparecen correctamente — el límite anterior descartaba silenciosamente todo por encima de $5 mil millones, incluida la mayor adjudicación legítima (≈$6.68 mil millones). Los avisos de listas precalificadas con fechas de marcador de posición del año 2090 ahora dicen \"sin fecha límite fija (continua)\" en vez de una fecha que nadie debería anotar en su calendario. La <a href=\"about.html#data\">página Acerca de documenta las peculiaridades del conjunto de datos</a> — qué contiene realmente el City Record y cómo lo corregimos.",
    chg_0709_h2: "2026.07.09 · Adquisiciones predictivas: vencimientos de Checkbook, planes MOCS y cronologías de alerta temprana",
    chg_0709_foryou_html: "<b>Para usted</b> — CROL-List ahora le alerta 6 meses <em>antes</em> de que los contratos venzan o se publiquen nuevas RFP. Los perfiles de agencias y proveedores muestran una nueva pestaña <b>\"Pronóstico de Adquisiciones\"</b> con una cronología vertical, que une las renovaciones de contrato previstas (de Checkbook NYC) y las solicitudes oficiales planeadas por la agencia (de los conjuntos de datos MOCS del Estatuto §112). Los resúmenes ahora entregan notificaciones de alerta temprana para los pronósticos próximos que coincidan con sus alertas.",
    chg_0702d_h2: "2026.07.02 · Corrección: los proveedores con nombres con puntuación vuelven a resolverse",
    chg_0702d_foryou_html: "<b>Para usted</b> — Las páginas de proveedores y las alertas de proveedores ahora funcionan para nombres como \"Leon D. Dematteis Construction Corp.\" Antes de esta corrección, hacer clic en un proveedor así mostraba \"sin adjudicaciones registradas\" y una alerta sobre ellos no coincidía con nada — a pesar de que sus adjudicaciones estaban justo ahí.",
    chg_0702c_h2: "2026.07.02 · Ágil y nítido: la ronda cuatro de velocidad y simplificación",
    chg_0702c_foryou_html: "<b>Para usted</b> — El sitio se ve más tranquilo y se siente inmediato. Las listas muestran marcadores de posición con la forma del contenido en vez de indicadores de carga giratorios; filtrar mantiene su lugar en vez de vaciar la lista; volver a una pestaña que ya cargó es instantáneo; hacer clic en un aviso pinta su detalle de inmediato (el rastro documental se completa un instante después). La búsqueda se ejecuta mientras escribe — los botones de Filtros desaparecieron porque ya no los necesita.",
    chg_0702b_h2: "2026.07.02 · Habilitación: estadísticas públicas, conteos de clics honestos, esta página",
    chg_0702b_foryou_html: "<b>Para usted</b> — Ahora puede ver los números de uso propios del proyecto en <a href=\"stats.html\">/stats</a> (solo conteos agregados — sin cuentas, sin cookies, nadie es rastreado). Los enlaces de resúmenes por correo ahora pasan por una redirección de solo conteo para que podamos saber que los resúmenes son útiles; cuenta <em>clics por día</em>, nunca quién hizo clic, y cada pie de resumen lo dice.",
    chg_0702_h2: "2026.07.02 · Siga el dinero, cronologías de expedientes, seguimientos, espacio de trabajo, API",
    chg_0702_foryou_html: "<b>Para usted</b> — Las adjudicaciones ahora muestran lo que <em>realmente se pagó</em> (en vivo desde Checkbook NYC), cualquier expediente de adquisiciones se lee como una sola cronología, puede seguir a un proveedor o agencia y recibir un correo cuando reaparezcan, fijar cualquier cosa en un espacio de trabajo de investigación citable, y usar cada vista como una API.",
    chg_0701_h2: "2026.07.01 · Páginas de entidades, marcadores rojos en contexto — y las primeras diez, todo en un día",
    chg_0701_foryou_html: "<b>Para usted</b> — Cada proveedor y agencia se convirtió en una página (con totales, principales socios, y RFP abiertas), los avisos de adquisiciones llevan contexto estadístico en vez de texto desnudo, y llegó toda la capa de búsqueda y suscripción: vigile cualquier búsqueda, reciba un resumen matutino por correo, tome cualquier vista como RSS/calendario, comparta cualquier aviso por URL, y vea las fechas límite como cuentas regresivas en vez de fechas.",
    chg_0630_h2: "2026.06.30 · Suscripciones reales",
    chg_0630_foryou_html: "<b>Para usted</b> — Las alertas por correo se volvieron reales: doble confirmación (nada se almacena hasta que hace clic en el enlace de confirmación), cancelación de suscripción con un clic, y su dirección solo se usa para enviarle su propio resumen.",
    chg_0626_h2: "2026.06.26 · crol-list.org",
    chg_0626_foryou_html: "<b>Para usted</b> — El sitio obtuvo su propio dominio y un cuadro real de \"preguntar en lenguaje llano\" en cada lente (con un respaldo en el dispositivo, para que la búsqueda funcione incluso si el asistente falla).",
    chg_0624_h2: "2026.06.24–25 · Las siete lentes",
    chg_0624_foryou_html: "<b>Para usted</b> — La herramienta tomó su forma: Dinero, Personas, Terrenos, Propiedades, Reglas, Reuniones y Alertas, en el diseño tipográfico, sobre datos abiertos en vivo sin nada en caché.",

    // wave 9: es SR surface (L1-L6) + page titles + toggle/vendor-disclosure copy
    tablist_label: "Lentes",
    fb_kind_label: "¿Qué tipo de comentario?",
    meta_agency_profile_announce: "Perfil de agencia: {name}",
    meta_vendor_profile_announce: "Perfil de proveedor: {name}",
    meta_matter_timeline_announce: "Cronología del expediente: {n} eventos",
    mini_subscribe_btn: "Suscribirse a la alerta",
    vendor_profile_variants: "Perfil de proveedor · {n} variante{s} de nombre resuelta{s}",
    which_variants_btn: "¿cuáles?",
    index_title: "CROL-List · rastree RFP, rezonificaciones, reuniones",
    about_title: "Acerca de · CROL-List",
    data_title: "Los datos · CROL-List",
    stats_title: "Estadísticas · CROL-List",
    changelog_title: "Registro de cambios · CROL-List",
    api_title: "API y fuentes · CROL-List",
    map_marker_alt: "Ubicación del proyecto de rezonificación",
  },

  // Stubs for remaining LL30 languages — translations pending (wave 6 phases 2–4)
  fr: {}, ht: {}, ru: {}, bn: {}, "zh-Hans": {}, "zh-Hant": {}, ko: {}, ar: {}, ur: {}, pl: {},
};

// City Record section names arrive as DATA VALUES (section_name in the open dataset) but are
// rendered as navigation chrome (Today strip, agency profiles) — so they translate here, with
// English fallback for any section the dataset adds before we do (2026-07-13 hotfix, bug b).
const SECTION_I18N = {
  es: {
    "Procurement": "Adquisiciones",
    "Public Comment on Contract Awards": "Comentario público sobre adjudicaciones de contratos",
    "Public Hearings and Meetings": "Audiencias y reuniones públicas",
    "Agency Rules": "Reglas de agencias",
    "Property Disposition": "Disposición de propiedades",
    "Changes in Personnel": "Cambios de personal",
    "Special Materials": "Materiales especiales",
    "Court Notices": "Avisos judiciales",
  },
};
function tSection(name) {
  const lang = window.LANG || "en";
  const map = SECTION_I18N[lang];
  return (map && map[name]) || name;
}

// Expose globals consumed by index.html
window.STRINGS = STRINGS;
window.LANG_META = LANG_META;
window.SUPPORTED_LANGS = SUPPORTED_LANGS;
window.SECTION_I18N = SECTION_I18N;
window.tSection = tSection;

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
  document.querySelectorAll("[data-i18n-aria]").forEach(function(el) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  // w9-05 (L6): document.title never translated -- each page marks its <html> with the title
  // key to use; applyStrings() runs on load and on every language switch, so this is the one
  // place that needs to know about it.
  var titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey);
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

// Shared lang-switcher wiring for subpages (about/data/stats/api/changelog) — index.html
// keeps its own richer initLangSwitcher() because it must also repaint dynamically-built
// search results; subpages have no such state, so applyStrings() alone is enough.
// onChange(lang), if given, runs after each switch so a page can repaint its own dynamic bits.
function initSubpageLangSwitcher(onChange) {
  function init() {
    var btns = document.querySelectorAll(".lang-btn");
    var saved = window.LANG || "en";
    btns.forEach(function(b){ b.setAttribute("aria-pressed", b.dataset.lang === saved ? "true" : "false"); });
    applyStrings();
    btns.forEach(function(btn){
      btn.addEventListener("click", function(){
        var lang = btn.dataset.lang;
        setLang(lang);
        btns.forEach(function(b){ b.setAttribute("aria-pressed", b.dataset.lang === lang ? "true" : "false"); });
        if (onChange) onChange(lang);
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
window.initSubpageLangSwitcher = initSubpageLangSwitcher;

// Init: restore saved language preference on module load (before DOMContentLoaded), and set
// the html lang/dir attributes immediately (i18n.js loads in <head>, so this runs before body
// paints — the WCAG 3.1.1 "no English flash" requirement, satisfied without a separate script).
(function() {
  var saved = "en";
  try { saved = localStorage.getItem("crol_lang") || "en"; } catch(e) {}
  if (!SUPPORTED_LANGS.includes(saved)) saved = "en";
  window.LANG = saved;
  if (typeof document !== "undefined") {
    document.documentElement.lang = saved;
    var meta = LANG_META[saved];
    if (meta) document.documentElement.dir = meta.dir;
  }
})();
