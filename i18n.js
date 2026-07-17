// i18n.js — CROL-List runtime string catalog: CORE file.
// Architecture (w8-01): this file holds the runtime (t/tn/tSection/applyStrings/setLang),
// LANG_META, and the `en` dictionary INLINE (en is the fallback — it must always be
// available with zero network round-trips). Every other language's STRINGS/SECTION_I18N
// table lives in its own `i18n/lang/<lang>.js` file and is loaded on demand:
//   - Node/tooling (tests, hash-checking scripts): loaded synchronously via require() at
//     the bottom of this file, so `node -e "require('./i18n.js')"` sees every shipping
//     language's full table with no browser involved.
//   - Browser, saved preference != en: injected via document.write() while this script is
//     still executing in <head> (before first paint — the WCAG "no English flash" rule),
//     so the active language's dictionary is present before the body renders.
//   - Browser, user switches language after load: ensureLangLoaded() appends a <script>
//     tag on demand; t()/tn() fall back to English until it resolves (or forever, if the
//     network request fails — the 2026-07-11 "no raw keys" rule, satisfied by the
//     existing STRINGS.en fallback chain either way).
// No bundler either way — every file is a plain classic <script>, `SHIPPING_LANGS` below is
// the one declaration the selector (index.html + subpages), i18n_keys.py, and the stray-
// English guard (test/functional/13_stray_english.py) all read language lists from.
//
// Per-language dictionary files carry their own review-state frontmatter (a JS comment +
// window.I18N_PROVENANCE entry — see I18N_PROVENANCE below and i18n/GLOSSARY.md) — all ten
// shipping languages (es, zh-Hans, ru, bn, ht, ko, fr, pl, ar, ur) are `machine-drafted`
// (glossary-pinned, placeholder-verified, not yet native-reviewed); the UI shows a disclosure
// banner (`updateLangNotice()`) for any language in that state, alongside the notices-stay-
// English note.
//
// fr-HT: Haitian Creole has no Intl locale; date/number formatting uses fr-HT.
// RTL wave (w8-03): Arabic (ar) and Urdu (ur) ship dir="rtl" chrome — logical CSS properties
// throughout index.html (retrofit, not just new code), bidi isolation on English data islands
// (see the enTitle()/lang="en" dir="ltr" pairing in index.html), and a pinned Western-digit
// policy (`intlDate: "ar-u-nu-latn"` / `"ur-u-nu-latn"` below) — MOIA's own Arabic/Urdu print
// materials use Western digits, and the `-u-nu-latn` Unicode locale extension pins that
// regardless of a browser's default numbering system for the bare "ar"/"ur" macrolocale
// (which varies — do not remove the extension even if it looks redundant in one browser).
// Bengali note: bn uses 2-2-3 digit grouping; Intl.NumberFormat('bn') handles this automatically.

// Supported language codes: BCP 47 locale, native label, layout direction, Intl date locale.
// Haitian Creole uses fr-HT for Intl (ht has no CLDR support). `fontStack`/`lineHeightScale`
// (w8-06) are optional per-language CSS custom-property overrides for script rendering —
// only set once a language actually ships (unset = the default Latin stack in index.html).
const LANG_META = {
  en:       { locale: "en-US",   label: "English",          dir: "ltr", intlDate: "en-US"   },
  es:       { locale: "es",      label: "Español",          dir: "ltr", intlDate: "es"       },
  // Stubs for remaining LL30 languages (translations pending):
  fr:       { locale: "fr",      label: "Français",         dir: "ltr", intlDate: "fr"       },
  ht:       { locale: "fr-HT",   label: "Kreyòl ayisyen",  dir: "ltr", intlDate: "fr-HT"    },
  ru:       { locale: "ru",      label: "Русский",          dir: "ltr", intlDate: "ru"       },
  bn:       { locale: "bn",      label: "বাংলা",            dir: "ltr", intlDate: "bn",
              fontStack: "'Noto Sans Bengali','Vrinda','Kalpurush',sans-serif",
              lineHeightScale: 1.25 },
  "zh-Hans":{ locale: "zh-Hans", label: "中文（简体）",      dir: "ltr", intlDate: "zh-Hans",
              fontStack: "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif",
              lineHeightScale: 1.15 },
  "zh-Hant":{ locale: "zh-Hant", label: "中文（繁體）",      dir: "ltr", intlDate: "zh-Hant"  },
  ko:       { locale: "ko",      label: "한국어",            dir: "ltr", intlDate: "ko"       },
  ar:       { locale: "ar",      label: "العربية",          dir: "rtl", intlDate: "ar-u-nu-latn",
              fontStack: "'Geeza Pro','Noto Naskh Arabic','Noto Sans Arabic',sans-serif",
              lineHeightScale: 1.3 },
  ur:       { locale: "ur",      label: "اردو",             dir: "rtl", intlDate: "ur-u-nu-latn",
              fontStack: "'Noto Nastaliq Urdu','Noto Nastaliq Urdu Draft','Geeza Pro','Noto Naskh Arabic',sans-serif",
              lineHeightScale: 1.9 },
  pl:       { locale: "pl",      label: "Polski",           dir: "ltr", intlDate: "pl"       },
};
const SUPPORTED_LANGS = Object.keys(LANG_META);

// Shipping languages: full key coverage, guard-activated, selectable today. Everything else
// in LANG_META is a stub (empty STRINGS[lang] === {}) reserved for a future wave. This is the
// ONE declaration i18n_keys.py's REQUIRED_FULL, the selector buttons, and the CI guard matrix
// all derive from — add a language here only after its dictionary + guard activation ship.
// w8 batch 2: bn/ht/ko/fr/pl join es/zh-Hans/ru. w8-03: ar/ur (RTL) join the roster too — see
// the RTL wave note above for the dir/digit-policy specifics that make these two different
// from every LTR language before them. All ten LL30 languages now ship.
const SHIPPING_LANGS = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];

// Per-file cache-skew hashes (w8-01 AC #1): sha256(i18n/lang/<lang>.js)[:8], checked by
// test/standards/i18n_refs.py. Changing ONE language's file changes only its own hash here —
// a Polish fix never invalidates nine other dictionaries' cache entries.
// Regenerate with: shasum -a 256 i18n/lang/<lang>.js | cut -c1-8
const LANG_FILE_HASHES = {
  es: "68b63313",
  "zh-Hans": "8df91ee0",
  ru: "05cb64cb",
  bn: "3ae25833",
  ht: "6c189ca6",
  ko: "407677a2",
  fr: "c92708ec",
  pl: "f85e726c",
  ar: "bf2c0a1d",
  ur: "d03964cd",
};

// Translation review-state (w8-02): drives the machine-translation disclosure banner
// (updateLangNotice(), below). `state` is one of "machine-drafted" | "glossary-checked" |
// "native-reviewed" — only "native-reviewed" suppresses the banner. Each per-language file
// also carries this same state in its own header comment so provenance travels with the
// dictionary even if this table is ever regenerated from a manifest.
const I18N_PROVENANCE = {
  es: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  "zh-Hans": { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  ru: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  bn: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  ht: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  ko: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  fr: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  pl: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  ar: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
  ur: { state: "machine-drafted", reviewed_by: null, reviewed_date: null },
};

// Full string table — en + es. Keys cover all translatable UI chrome in index.html.
// Notice content (City Record titles, agency names, notice bodies) is NEVER in this table.
const STRINGS = {
  en: {
    footer_notices: "1M+ notices",
    sugg_money_0: "construction contracts over $500k",
    sugg_money_1: "IT consulting RFPs",
    sugg_money_2: "shelter services contracts",
    sugg_money_3: "park maintenance contracts",
    sugg_money_4: "school food service contracts",
    sugg_money_5: "senior center contracts",
    sugg_people_0: "paramedic roles",
    sugg_people_1: "look up someone named Rodriguez",
    sugg_people_2: "attorney titles",
    sugg_land_0: "rezonings in Brooklyn",
    sugg_land_1: "rezonings in Queens",
    sugg_land_2: "79 Rivington",
    sugg_land_3: "rezonings in the Bronx",
    sugg_property_0: "HPD property sales",
    sugg_property_1: "environmental protection land",
    sugg_property_2: "police department property",
    sugg_property_3: "parks department property",
    sugg_rules_0: "buildings rules",
    sugg_rules_1: "sanitation rules",
    sugg_rules_2: "taxi rules",
    sugg_rules_3: "health department rules",
    sugg_meetings_0: "recent landmarks hearings",
    sugg_meetings_1: "recent city council hearings",
    sugg_meetings_2: "recent community board meetings",
    sugg_meetings_3: "recent taxi and limousine hearings",
    sugg_alerts_0: "awards over $1M",
    sugg_alerts_1: "education contracts over $200K due in 3 months",
    sugg_alerts_2: "rezonings near 79 Rivington",
    sugg_alerts_3: "sanitation contract awards",
    all_agencies_loading: "All agencies — loading…",
    // Tab labels
    tab_money:    "Contracts",
    tab_people:   "Staffing",
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
    money_trail_heading: "Contract trail",
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
    quiz_step2:         "Describe what you want — plain English or keywords (optional)",
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
    watch_moneynl:      "Contracts or awards by description",
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
    // Machine-translation disclosure (w8-02, DCAS Language Access Plan convention) — shown
    // via updateLangNotice() for any active language whose I18N_PROVENANCE state isn't
    // "native-reviewed" yet.
    mt_disclaimer: "This translation was machine-drafted and has not yet been reviewed by a native speaker.",

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
    kw_placeholder_people_person: "last name, for example Rodriguez",
    nl_placeholder_people:   "for example, paramedic roles, or look up someone named Rodriguez",
    nl_placeholder_land:     "for example, rezonings in Brooklyn, or 79 Rivington",
    nl_placeholder_property: "for example, HPD property sales, DEP land",
    nl_placeholder_rules:    "for example, buildings rules, sanitation rules",
    nl_placeholder_meetings: "for example, recent landmarks hearings, city council",
    nl_placeholder_alerts:   "for example, education contracts over $200K due in 3 months, or awards over $1M",

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
    pick_notice_panel_heading: "Contract trail",
    preview_panel_heading: "Preview",

    // Quiz panel
    quiz_narrow_placeholder: "type what you're looking for, or pick a topic above…",
    quiz_param_agency:   "agency (optional) — for example, Buildings",

    // Alert builder labels
    param_label_min_award:    "Minimum award",
    param_label_keyword:      "Keyword (optional)",
    param_label_vendor:       "Vendor name",
    param_label_agency_name:  "Agency name (as printed)",
    param_label_place:        "ZIP, address, or neighborhood (optional)",
    param_label_moneynl_kw:     "Keyword (optional)",
    param_label_moneynl_min:    "Minimum $ (optional)",
    param_label_moneynl_months: "Due within months (optional)",
    param_placeholder_moneynl_kw:     "education, construction…",
    param_placeholder_moneynl_min:    "200000",
    param_placeholder_moneynl_months: "3",
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
    nl_understood_label: "We understood this as:",
    nl_edit_btn:      "Edit search",
    nl_no_matches_note: "No matches for this search.",
    nl_chip_land_kind: "rezonings",
    nl_chip_land_status_all: "including closed rezonings",
    sync_watch_announce: "Your alert is now set to {what}.",
    sync_freq_announce: "Your alert's frequency is set to {freq}.",
    sugg_lineage_hint:  "Includes contracts with award history",
    sugg_forecast_hint: "Includes contracts with forecast data",

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

    // Front-page masthead
    site_tagline: "Subscribe to NYC contracts, rezonings, and hearings that interest you.",

    // Skip link
    skip_to_content: "Skip to content",

    // Announcements (sr-only)
    or_more_results: "{n} or more results",
    results_count: "{n} results",

    // Event countdown (eventTag)
    event_today: "today",
    event_in_n_days_one: "in {n} day",
    event_in_n_days_other: "in {n} days",

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
    today_summary: "<b>{n}</b> notices today, from <b>{a}</b> agencies",
    due_on: "due {date}",
    untitled: "(untitled)",
    untitled_notice: "(untitled notice)",

    // Deadline / event tags
    closed_tag: "closed",
    open_days_left: "open · {n} days left",
    days_left_one: "1 day left",
    days_left_other: "{n} days left",

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
    agency_awards_unavailable_note: "No contract awards from this agency appear in the City Record — some agencies publish awards elsewhere.",
    agency_awards_elsewhere_note: "This agency files its contract awards with {source}, not the City Record.",
    agency_awards_none_open_data: "This agency's contract awards are not published in any open dataset CROL-List knows of.",
    external_awards_heading: "Awards published elsewhere",
    external_awards_abo_source: "NYS Authorities Budget Office",
    external_awards_checkbook_source: "Checkbook NYC",
    external_awards_abo_note: "Official annual filing, separate from the City Record. The source may lag by a year.",
    external_awards_possible_note: "Possible awards, matched by vendor and award date — not a confirmed City Record match.",
    external_awards_updated: "Source updated {date}.",
    external_award_none_note_html: "The site also checked {source} and found no matching award there either.",
    external_award_nycha_none_note: "The site checked Checkbook NYC for this notice's PIN and found no registered award there yet — registration can lag a solicitation.",
    external_award_nycha_note_html: "Checkbook NYC award matched by exact PIN <code>{pin}</code> and a contract date after this solicitation.",
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
    renewal_badge: "Renewal",
    notice_fallback: "Notice",
    view_in_city_record: "View in City Record",
    // Accessible marking for the City Record/PASSPort/Checkbook NYC new-tab carve-out
    // (test/standards/link_targets.py). Appended as visually-hidden text inside the link.
    ext_link_new_tab_sr: "(opens in new tab)",
    pin_unusable_note: "This notice's PIN isn't usable for linking (<code>{pin}</code>), so its award can't be traced automatically. Open it in the City Record to read the full text.",
    only_notice_note: "Only this notice is on record so far — no later stage has been published for PIN <code>{pin}</code> yet. ",
    award_pending_note: "The award may still be pending.",
    blanket_note: "PIN <code>{pin}</code> is a <b>blanket code</b>: it bundles {n} separate awards (common for emergency declarations). Each box is a distinct contract under the same code.",
    // Past winners strip (w12-05): a rolled-up list of who won each cycle, built from the same
    // paper-trail chain chainHTML() already renders — see pastWinnersHTML() in index.html.
    past_winners_heading: "Past winners",
    past_winners_vendor_unlisted: "Award, vendor unlisted",
    // Cadence estimate (w12-04): "is this a yearly bid?" answered in words, from this notice's
    // own paper-trail chain — see cadenceEstimate()/cadenceHTML() in index.html.
    cadence_award_count_one: "{n} prior award",
    cadence_award_count_other: "{n} prior awards",
    cadence_months_apart_one: "about {months} month apart",
    cadence_months_apart_other: "about {months} months apart",
    cadence_years_apart_one: "about {years} year apart",
    cadence_years_apart_other: "about {years} years apart",
    cadence_next_expected: "Next solicitation expected around {date}.",
    cadence_estimate_tag: "Estimate",
    // Lineage indicator (w12-10): a compact result-row badge pointing at the same chain data
    // pastWinnersHTML()/cadenceHTML() already render on the detail view — see
    // computeLineageBadgeCounts()/loadLineageBadges() in index.html.
    history_cycles_tag_one: "{n} cycle",
    history_cycles_tag_other: "{n} cycles",
    prior_cycle_heading: "Looks recurring — prior award cycles",
    prior_cycle_heuristic_note: "We matched this by agency and title, not by a shared PIN. It may be the same repeating contract, but we cannot be sure. Check the dates and vendor first.",
    prior_cycle_none_generic: "This title is too generic to search for earlier rounds.",
    prior_cycle_none_no_candidates_html: "No earlier {agency} award matches this title — most likely not a repeating contract (or an earlier round was titled differently).",
    prior_cycle_none_low_confidence_html: "We found earlier {agency} awards, but none matched this title closely enough to be sure.",
    // Near-match prior cycles (w12-18): an exploratory second tier below the strict matcher
    // above, offered as an explicit reveal on the empty state — see rankNearMatchCandidates()/
    // nearMatchHTML() in index.html.
    near_match_reveal_btn: "Look for looser possible matches",
    near_match_heading: "Possible earlier rounds",
    near_match_tag: "Maybe",
    near_match_why_lbl: "Why we're showing this:",
    near_match_reason_agency: "same agency",
    near_match_reason_title_html: "shares title words: {words}",
    near_match_reason_pin_html: "PIN prefix similar to {prefix}",
    near_match_reason_amount_html: "comparable amount ({a} vs {b})",
    near_match_caveat_note: "These are guesses, not confirmed history. Each one shares some traits with this notice, but none cleared our bar for a likely match — check the dates, vendor, and PIN yourself before relying on them.",
    near_match_none_note: "We checked for more distant possible matches too, and did not find any.",
    near_match_loading: "Checking for possible matches…",
    agency_forecast_heading: "This agency's next predicted bid windows",
    agency_forecast_count_one: "{n} predicted opportunity ahead for this agency.",
    agency_forecast_count_other: "{n} predicted opportunities ahead for this agency.",
    agency_forecast_link: "See the full forecast →",
    forecast_overview_tab: "Overview",
    forecast_subtab_label: "Procurement forecast ({n})",
    forecast_section_heading: "Predicted expirations and planned schedules",
    forecast_honesty_note: "These are estimates built from past award durations and this agency's own published plans — not confirmed dates. Confirm timing before you rely on them.",
    forecast_badge_checkbook: "Estimated renewal",
    forecast_badge_mocs: "Agency plan",
    forecast_vendor_fallback: "Vendor contract expiration",
    forecast_solicitation_fallback: "Planned solicitation",
    forecast_amount_label: "Amount",
    forecast_value_band_label: "Value band",
    forecast_predicted_expiration_label: "Predicted expiration: {date}",
    forecast_expected_quarter_label: "Expected RFP quarter: {quarter}",
    what_they_want: "What they want",
    apply_method_lbl: "Method",
    apply_contact_lbl: "Contact",
    apply_submit_lbl: "Submit / request to",
    call_btn: "Call {phone}",
    apply_pnote_html: "<b>Email a response</b> opens a pre-filled letter of intent to the listed contact — edit before sending. Competitive bids are ultimately submitted through <b>PASSPort</b>. Nothing leaves your device until you hit send.",
    apply_pnote_no_email_html: "This notice lists no direct contact — submit your response through <b>PASSPort</b>, or use the submission address above if one is listed.",

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
    salary_note_html: "Salary band from <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\" target=\"_blank\" rel=\"noopener noreferrer\">Citywide Payroll FY{fy}<span class=\"sr-only\"> (opens in new tab)</span></a>. Exam status comes from the <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\" target=\"_blank\" rel=\"noopener noreferrer\">Civil Service List<span class=\"sr-only\"> (opens in new tab)</span></a>, which lists competitive (exam) titles only — a title absent there is treated as no-exam.",
    n_notices_meta_one: "{n} notice",
    n_notices_meta_other: "{n} notices",
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
    zap_explainer_html: "ZAP indexes by <b>project</b>, not address — a notice about your block can be missing here while still in <a href=\"https://a856-cityrecord.nyc.gov/Search/Advanced\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a>.",
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
    map_approx_note_html: "{label}. <span class=\"muted\">Approximate — confirm exact lots on <a href=\"https://zola.planning.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">ZoLa<span class=\"sr-only\"> (opens in new tab)</span></a>.</span>",
    showing_lots_note_html: "Showing {n} rezoned tax lot{s} (NYC MapPLUTO). <span class=\"muted\">Confirm on <a href=\"https://zola.planning.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">ZoLa<span class=\"sr-only\"> (opens in new tab)</span></a>.</span>",
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
    desc_moneynl: "{freq} digest of contracts or awards{bits}",
    desc_moneynl_about: " about “{kw}”",
    desc_moneynl_over: " over {amt}",
    desc_moneynl_due_one: " due within {n} month",
    desc_moneynl_due_other: " due within {n} months",
    desc_moneynl_any: " — no filters set",
    desc_vendor: "{freq} digest — every new notice naming vendor “{name}”",
    desc_agency_watch: "{freq} digest — anything “{name}” publishes",
    desc_section: "{freq} digest of {what}{bits}",
    desc_matching: " matching “{kw}”",
    desc_from_agency: " from {agency}",
    desc_rezone_near: "{freq} digest of rezonings near “{place}”",
    desc_rezone_city: "{freq} digest of new rezonings citywide",
    your_digest_subject: "Your {desc}",
    no_matches_today_html: "No matching notices today — so you&#39;d get nothing. (That&#39;s the point: signal, not noise.)",
    simplify_keyword_hint_html: "Long, sentence-like search terms rarely match City Record listings verbatim — try one or two words instead.",
    digest_footer_one: "{n} notice today · from The City Record · unsubscribe any time (one click)",
    digest_footer_other: "{n} notices today · from The City Record · unsubscribe any time (one click)",
    // {snippet}/{term} are pre-built HTML (a <mark>-wrapped hit) -- see matchEvidence() above digItemHTML.
    digest_match_snippet_html: "Matched: “{snippet}”",
    digest_match_unknown_html: "Matched: “{term}”",
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
    quizph_rfpkw: "construction, IT, catering… or describe it in a sentence",
    quizph_bigaward: "(uses the $1M+ threshold — tune it below)",
    quizph_rezone: "place — 79 Rivington, Bushwick…",
    quizph_property: "keyword — Brooklyn, auction…",
    quizph_rules: "keyword — e-bike, sidewalk…",
    quizph_meetings: "keyword — community board, landmarks…",
    pick_topic_first: "← type something, or pick a topic",

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
    inv_footer_note_html: "Every exported item carries its permalink + the date you pinned it — citation-grade by construction. Sharing uploads a read-only snapshot (90-day link). Nothing else ever leaves this browser.",
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
    about_p_what_html: "CROL-List is a search tool for <a href=\"https://a856-cityrecord.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a>. That is the City of New York's official daily paper. In it, <a href=\"https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-3113\" target=\"_blank\" rel=\"noopener noreferrer\">every agency must publish<span class=\"sr-only\"> (opens in new tab)</span></a> its contracts, hearings, rule changes, rezonings, and staff moves. CROL-List lets you search the record by interest. You can follow a contract, look up a job title, track a rezoning, or get an email when something new matches.",
    about_h_content: "About our content",
    about_p_content: "An AI assistant (Claude) drafts this site's copy — headings, explanations, pages like this one. A human editor checks it before it goes live. The data is not AI-generated. Every notice, dollar figure, and date comes straight from NYC Open Data, unedited.",
    about_h_source: "Where the data comes from",
    about_p_source_html: "All of it comes from public, official data: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Online (dg92-zbpx)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\" target=\"_blank\" rel=\"noopener noreferrer\">Citywide Payroll (k397-673e)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\" target=\"_blank\" rel=\"noopener noreferrer\">Civil Service List (vx8i-nprf)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\" target=\"_blank\" rel=\"noopener noreferrer\">ZAP Projects (hgx4-8ukb)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://a0333-passportpublic.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">PASSPort<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://www.checkbooknyc.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Checkbook NYC<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    about_h_honest: "The data, to be honest",
    about_p_honest_intro_html: "The City Record dataset is <b>1.09 million notices back to 2003</b> — and it is not what it looks like at first glance. Our team's exploratory analysis of the full dataset found quirks that would silently mislead if we didn't correct for them, so here is exactly what we do:",
    about_li_honest_html: "<li><b>87.5% of all rows are civil-service personnel changes</b>, not civic notices. Each stat on this site is counted within its own section — a \"global\" City Record number would really be a personnel-file number.</li><li><b>A few contract amounts are data-entry errors</b> — three rows claim $10&nbsp;billion or more, topping out at <a href=\"index.html#notice/20210524108\">$96 trillion, a housing-services award whose amount field is plainly a typo</a> (the largest verified real award is <a href=\"index.html#notice/20180109010\">about $6.68 billion, the city's 10-year electricity contract with NYPA</a>). Money filters and digests exclude amounts of $10 billion or more. One typo can't dominate every ranking.</li><li><b>Some \"due dates\" aren't deadlines.</b> Notices for pre-qualified lists use fake dates in the year 2090 or later. We mark these as \"no fixed deadline (rolling)\" so no one puts a date on their calendar that isn't real.</li><li><b>Agency names come in two conventions</b> (old ALL-CAPS and Title Case — 312 raw strings for about 150 real agencies). Our name tool treats them as one.</li>",
    about_p_honest_footer_html: "Searches on this site always show live data from NYC Open Data. Email alerts check for new matches once a day. Want the numbers themselves? <a href=\"data.html\"><b>The Data</b></a> shows the record at a glance — sections, volume, procurement mix, top agencies and vendors — computed live with these same rules.",
    about_h_flags: "Flags and context, explained",
    about_p_flags_intro_html: "Procurement notices carry two kinds of computed notes. Both are <b>statistical context, not findings or blame</b>. A flag just means \"worth a closer look.\" Every formula has a fair reason behind it. Emergencies really happen. Some markets are specialized and have few bidders. Name matching is not perfect. This method follows two guides. One is <a href=\"https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/\" target=\"_blank\" rel=\"noopener noreferrer\">the Open Contracting Partnership's red-flags guide<span class=\"sr-only\"> (opens in new tab)</span></a>. The other is <a href=\"https://opentender.eu/\" target=\"_blank\" rel=\"noopener noreferrer\">Opentender's<span class=\"sr-only\"> (opens in new tab)</span></a> integrity rules.",
    about_li_flags_html: "<li><b>⚑ Short ad window</b> — the days between when a notice is posted and when the answer is due. We flag it when it is 10 days or fewer and less than half the agency's own median. The median comes from that agency's last 200 notices. Short windows favor incumbents who already knew the work was coming.</li><li><b>⚑ Non-competitive method</b> — the notice says it will pick a vendor without a full contest. It may be a deal made through talks, a single chosen source, an urgent buy, or a test project. This can be fair at times. But it is always good to know.</li><li><b>⚑ Repeat awards</b> — the same vendor name shows up on 3 or more award notices at the same agency within 90 days. This can point to task orders under a blanket contract just as much as favoritism. The flag just counts them — you decide what it means.</li><li><b>Context strip</b> — how big an award is, shown as a percentile of that agency's awards in the last 12 months (shown only when the agency has 20 or more awards in that time). It also shows the vendor's share of the agency's award dollars in the same time. We use the exact published name. We do not merge name variants here.</li>",
    about_p_flags_footer_html: "All numbers come live from the <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Open Data<span class=\"sr-only\"> (opens in new tab)</span></a> when you view the notice. These are awards <b>as published</b>. The numbers can lag behind contract registration and real payment. Nothing here says anyone did wrong. It just saves you the math.",
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
    about_note_feedback_html: "If you add your email, we only use it to reply. Each submission also saves some basic info — your IP address and browser. We keep this info for a short time to stop spam. See <a href=\"#privacy\">Privacy</a>.",
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
    about_foot_html: "CROL-List · a search interface over <a href=\"https://a856-cityrecord.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"changelog.html\">Changelog</a> · <a href=\"stats.html\">Stats</a> · <a href=\"index.html\">Home</a>",
    about_h_privacy: "Privacy",
    about_p_privacy_intro: "No accounts, no cookies, no cross-site tracking, no ad tech. Here is exactly what CROL-List does with your data:",
    about_li_privacy_html: "<li><b>Searches and filters</b> go from your browser straight to NYC Open Data. The CROL-List server never sees them.</li><li><b>The \"Ask\" box</b> lets you search in plain English. Your text is sent to Anthropic's Claude, which turns it into filters. We do not save your text. We only keep a daily count, so we can cap costs.</li><li><b>Subscribing or sending feedback</b> saves what you send us. This includes your alert or message and your email, if you share one. We also keep some basic info about your request, like your IP address and browser. We keep this for a short time to stop spam and abuse. Every alert email has a one-click unsubscribe link.</li><li><b>Page views</b> are tracked with Cloudflare Web Analytics. It uses no cookies and only shows totals. It counts visits. It does not know who you are or follow you to other sites.</li>",

    // data.html
    data_p_lede_html: "The City Record dataset at a glance. Your browser pulls live totals from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">NYC Open Data<span class=\"sr-only\"> (opens in new tab)</span></a>. Nothing is saved on the server. The numbers follow the <a href=\"about.html#data\">honesty rules</a>. Stats stay in their own section. We exclude likely data-entry errors: amounts of $10 billion or more. Placeholder deadlines aren't real.",
    data_h_sections_html: "What the record really shows <span class=\"note\">(all time, by section)</span>",
    data_note_sections_body: "Most of the City Record is paperwork about civil-service jobs. The notices that matter to the public are only a small part of it. That is why every number on this site is shown per section.",
    data_h_volume_html: "How many were published <span class=\"note\">(last 12 months)</span>",
    data_h_procmix_html: "Procurement mix <span class=\"note\">(last 12 months, by notice type)</span>",
    data_h_agencies_html: "Top agencies by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_agencies_html: "\"Cleaned\" means we took out amounts over $10 billion. We think those are data-entry errors. See <a href=\"about.html#data\">the underlying data</a>.",
    data_h_vendors_html: "Top vendors by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_vendors: "Vendor names are not standardized in the source. Small spelling differences show up as separate rows here.",
    data_loading_counting: "Counting 1M+ notices…",
    data_fail: "Couldn't reach NYC Open Data just now — reload to retry.",
    data_foot_html: "Every number is worked out live in your browser from the public dataset. Reload the page for new data. Methodology: <a href=\"about.html#data\">about → the underlying data</a> · <a href=\"stats.html\">site usage stats</a> · <a href=\"changelog.html\">changelog</a>",

    // stats.html
    stats_loading: "Loading live counters…",
    stats_h_general: "The headline numbers",
    stats_lbl_subs: "Active watches",
    stats_desc_subs: "Confirmed standing watches — the number that matters most to us.",
    stats_lbl_digests: "Digests sent · 7 days",
    stats_desc_digests_html: "<span id=\"s-digests-today\">–</span> today. Only when something new matched (plus honest \"still watching\" check-ins).",
    stats_lbl_clicks: "Digest links followed · 7 days",
    stats_desc_clicks_html: "Counted by a redirect that records a number, never a person — <a href=\"changelog.html#2026-07-02b\">how this works</a>.",
    stats_lbl_feeds: "Feed fetches · 7 days",
    stats_desc_feeds: "RSS/Atom/JSON/calendar pulls, as seen at the origin (edge-cached hits aren't counted).",
    stats_lbl_batch: "Saved-search checks via the API · 7 days",
    stats_desc_batch_html: "Watchlists checked through the <a href=\"api.html\">open API</a>.",
    stats_lbl_inv: "Shared investigation links · 7 days",
    stats_desc_inv: "Read-only workspace snapshots created.",
    stats_lbl_nl: "Searches asked · 7 days",
    stats_desc_nl_html: "<span id=\"s-nl-today\">–</span> today. Plain questions typed into \"Ask,\" about any part of the site.",
    stats_since: "Counted since {date}.",
    stats_h_alltime: "Totals",
    stats_p_alltime: "The same outcomes, added up instead of reset every 7 days.",
    stats_lbl_digests_alltime: "Digests sent · all time",
    stats_desc_digests_alltime: "Every digest CROL-List has ever sent.",
    stats_lbl_nl_alltime: "Searches asked · all time",
    stats_desc_nl_alltime: "Every plain-English question CROL-List has ever answered.",
    stats_h_category: "Digests, by topic",
    stats_p_category: "Notices surfaced in digests, broken out by City Record topic.",
    stats_col_category: "Topic",
    stats_col_count: "Notices",
    stats_cat_empty: "No digests have matched anything yet.",
    stats_h_bylens: "Searches, by section",
    stats_p_bylens: "Which part of the site people asked about: contracts, staffing, land, property, rules, or meetings.",
    stats_col_lens: "Section",
    stats_col_last7: "Last 7 days",
    stats_col_alltime: "All time",
    stats_lens_empty: "No searches have been asked yet.",
    stats_h_history: "Over time",
    stats_p_history: "Digests sent, searches asked, and watches active, day by day.",
    stats_col_day: "Day",
    stats_col_digests: "Digests sent",
    stats_col_searches: "Searches asked",
    stats_col_watches: "Watches active",
    stats_history_caption: "Daily counts of digests sent, searches asked, and watches active",
    stats_history_notrecorded: "Not recorded",
    stats_history_era: "Counts before {date} were recovered from old logs. Counts from {date} on are counted as they happen.",
    stats_history_empty: "No day-by-day history yet.",
    stats_h_technical: "Technical details",
    stats_p_technical: "How the numbers above are put together. You don't need to know this to use CROL-List.",
    stats_foot_html: "Raw JSON: <a href=\"https://api.crol-list.org/stats\">api.crol-list.org/stats</a> (cached ~15 min) · <a href=\"changelog.html\">Changelog</a> · <a href=\"about.html\">About</a> · <a href=\"index.html\">Home</a>",
    stats_asof: "As of {date} (refreshes every 15 minutes).",
    stats_unreachable: "Live counters are unreachable right now — the raw JSON lives at api.crol-list.org/stats.",

    // api.html
    api_p_intro_html: "Every view on CROL-List has a machine-readable twin. No key and no account are required. Endpoints are rate-limited and cached, and none touches a paid service. Base URL: <code>https://api.crol-list.org</code>.",
    api_h_feeds: "Feeds — any search as RSS / JSON / calendar",
    api_p_feeds_html: "<code>GET /feed.xml</code> (Atom) · <code>GET /feed.json</code> (JSON Feed 1.1) · <code>GET /feed.ics</code> (subscribable calendar — one event per dated notice). Edge-cached 15 minutes.",
    api_th_param: "Param",
    api_th_meaning: "Meaning",
    api_row_q: "keywords (up to 4)",
    api_row_agency: "agency name as printed in the record",
    api_row_min: "minimum award $ (money lens → award feed)",
    api_row_kindname_html: "entity lens: <code>kind=vendor|agency</code>, <code>name=…</code> — vendor names are matched by normalized stem, so suffix/case variants are included",
    api_h_batch: "Batch cross-reference",
    api_p_batch_html: "<code>POST /batch</code> with <code>{\"names\": [\"…\", …]}</code> (≤10 names/request, 30 requests/day/IP). For each name, <b>awards</b> means award/intent notices naming that vendor (name-stem matched, all years). <b>Mentions</b> means full-text hits in the last two years of editions. <b>Entity</b> means the vendor-profile permalink when awards exist.",
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
    api_p_sharedinv_html: "<code>POST /inv</code> stores a pin-list snapshot (structured fields only, ≤32KB, 90-day TTL, 10/day/IP) and returns an id. <code>GET /inv/&lt;id&gt;</code> reads it back. The site renders these at <code>/#investigation/shared/&lt;id&gt;</code>.",
    api_h_stats: "Public stats",
    api_p_stats_html: "<code>GET /stats</code> — the project's own usage as aggregate counts (active subscriptions, digests sent, digest links followed, feed/batch/share activity). No personal data exists behind it. It's cached about 15 minutes. Human-readable version: <a href=\"stats.html\">stats</a>. Related: digest emails link notices via <code>GET /r/&lt;kind&gt;/&lt;request_id&gt;</code>, a count-only redirect to the notice permalink — it accepts a validated id (never a URL, so it can't redirect off-site) and records a per-day number, never a person.",
    api_h_subscribe: "Subscribe by email",
    api_p_subscribe_html: "Email <a href=\"mailto:subscribe@crol-list.org\"><code>subscribe@crol-list.org</code></a> describing what you want in plain English — for example, \"construction contract awards over $500k\" or \"rezoning notices in Brooklyn\". You'll get back a confirmation link describing how we understood your request. The watch starts only after you click it (double opt-in). Daily ceilings apply, and nothing is stored until you confirm.",
    api_h_mcp: "MCP — for AI assistants",
    api_p_mcp_html: "<code>POST /mcp</code> (Streamable HTTP, JSON-RPC) — point an MCP client at <code>https://api.crol-list.org/mcp</code>. Tools: <code>search_notices</code> and <code>get_notice</code> (the daily-refreshed notices mirror, honest-data rules applied), <code>preview_watch</code> (plain English → what a standing watch would deliver, without subscribing), and <code>create_watch</code> (plain English → a double-opt-in confirmation email — digests start only after the address confirms). Watch management stays behind the emailed unsubscribe links — knowing an address never reveals or controls its subscriptions. Per-IP and daily model-call ceilings apply.",
    api_h_upstream: "Upstream data",
    api_p_upstream_html: "CROL-List republishes and joins public datasets — for bulk work, go straight to the sources: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Online (dg92-zbpx, Socrata SODA)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://www.checkbooknyc.com/data-feeds/api\" target=\"_blank\" rel=\"noopener noreferrer\">Checkbook NYC API<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\" target=\"_blank\" rel=\"noopener noreferrer\">Citywide Payroll<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\" target=\"_blank\" rel=\"noopener noreferrer\">ZAP<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    api_foot_html: "CROL-List · <a href=\"index.html\">Home</a> · <a href=\"about.html\">About</a>",

    // changelog.html
    chg_p_lede: "What changed on CROL-List, newest first.",
    chg_auto_h2: "Recent updates",
    chg_auto_note: "These lines come from the descriptions of merged code changes and stay in English for now.",
    chg_earlier_h2: "Earlier releases",
    chg_detail_note: "The detailed technical notes below each release (bullet lists, incident reports) remain in English for now.",
    chg_foot_html: "CROL-List is an unofficial, free interface to public data. <a href=\"about.html\">About</a> · <a href=\"stats.html\">Stats</a> · <a href=\"api.html\">API and feeds</a> · <a href=\"index.html\">Home</a>",
    chg_0710e_h2: "2026.07.10 · Espanol coverage: the whole interface, not just the chrome",
    chg_0710e_foryou_html: "<b>Para usted</b> — Phase 2 of Spanish support: the entire visible interface now translates when you switch to Espanol. Phase 1 covered tabs, buttons, and short labels (98 keys). Phase 2 adds the empty states, search placeholders, panel headings, the Today's Edition strip, alert builder labels and parameters, loading messages, and all control labels across every lens (Money, People, Land, Property, Rules, Meetings, Alerts) -- growing the dictionary from 98 to over 200 keys. A new residual-English coverage gate in the test suite verifies 15 high-visibility sentinel strings are absent in Espanol mode.",
    chg_0710d_h2: "2026.07.10 · Spanish support + style-guide copy pass",
    chg_0710d_foryou_html: "<b>For you</b> — A language switcher now appears in the header (English / Espanol). Choosing Spanish translates all tabs, chips, and messages in the UI. Notices themselves stay in English, which is the official language of the City Record. Your preference is remembered across visits. Separately, time chips, deadline chips, and the feedback-category selector were updated to follow the NYC Web Content Style Guide: \"9 a.m.\" (not \"9 AM\"), spelled-out numbers (\"closes in two days\"), and acronym expansions on first use (RFP, M/WBE, ZAP). City Record content is now marked <code>translate=\"no\"</code> so machine-translation tools leave it intact.",
    chg_0710c_h2: "2026.07.10 · Accessibility: an enforced floor, not a promise",
    chg_0710c_foryou_html: "<b>For you</b> — If you use a keyboard or a screen reader, the rough edges are getting fixed for real: the feedback form's category picker now works without a mouse, the plain-English search box announces itself properly, low-contrast text is corrected site-wide, and the \"minimum award\" filter genuinely disables when it doesn't apply instead of just fading. From now on, an automated accessibility check (axe) runs against every page in our test harness — a change that breaks accessibility fails the build. CONTRIBUTING and SECURITY were also rewritten to describe how the project is actually governed and defended.",
    chg_0710b_h2: "2026.07.10 · Three new front doors: email-in, MCP, and The Data",
    chg_0710b_foryou_html: "<b>For you</b> — Three new ways in. <b>Subscribe by email:</b> write to <a href=\"mailto:subscribe@crol-list.org\">subscribe@crol-list.org</a> in plain English (\"construction awards over $500k\") and you'll get a confirmation link back — no form, no CAPTCHA, just your words. <b>For AI assistants:</b> point any MCP client at <code>api.crol-list.org/mcp</code> to search notices and set up watches programmatically (double opt-in still applies — nothing sends without the address confirming). <b><a href=\"data.html\">The Data</a>:</b> a new page showing the City Record at a glance — what's actually in it, publication volume, procurement mix, top agencies and vendors by cleaned dollars — computed live in your browser from NYC Open Data.",
    chg_0710_h2: "2026.07.10 · Honest data rules + a faster backbone (with Dev Doshi)",
    chg_0710_foryou_html: "<b>For you</b> — Money filters and digests can no longer be hijacked by the dataset's data-entry errors: amounts of $10 billion or more (there's a $96 trillion typo in the official record) are excluded, while real multi-billion awards now correctly appear — the old cutoff silently dropped everything above $5 billion, including the largest legitimate award (about $6.68 billion). Pre-qualified-list notices with placeholder year-2090 dates now say \"no fixed deadline (rolling)\" instead of a date no one should calendar. The <a href=\"about.html#data\">About page documents the dataset's quirks</a> — what the City Record actually contains and how we correct for it.",
    chg_0709_h2: "2026.07.09 · Predictive Procurement: Checkbook Expirations, MOCS Plans, &amp; Early-Warning Timelines",
    chg_0709_foryou_html: "<b>For you</b> — CROL-List now alerts you 6 months before contracts expire or new RFPs are published. Agency and vendor profiles show a new <b>\"Procurement Forecast\"</b> tab with a vertical chronological timeline, uniting predicted contract renewals (from Checkbook NYC) and official agency-planned solicitations (from Charter §112 MOCS datasets). Digests now deliver early-warning notifications for upcoming forecasts matching your watches.",
    chg_0702d_h2: "2026.07.02 · Fix: vendors with punctuated names resolve again",
    chg_0702d_foryou_html: "<b>For you</b> — Vendor pages and vendor watches now work for names like \"Leon D. Dematteis Construction Corp.\" Before this fix, clicking such a vendor showed \"no awards on record\" and a watch on them matched nothing — despite their awards being right there.",
    chg_0702c_h2: "2026.07.02 · Snap + crisp: the round-four speed-and-declutter pass",
    chg_0702c_foryou_html: "<b>For you</b> — The site looks calmer and feels immediate. Lists show content-shaped placeholders instead of spinners. Filtering keeps your place instead of blanking the list. Going back to a tab you already loaded is instant. Clicking a notice paints its detail at once (the paper trail fills in a beat later). Search runs as you type — the Filter buttons are gone because you no longer need them.",
    chg_0702b_h2: "2026.07.02 · Enablement: public stats, honest click counts, this page",
    chg_0702b_foryou_html: "<b>For you</b> — You can now see the project's own usage numbers at <a href=\"stats.html\">/stats</a> (aggregate counts only — no accounts, no cookies, nobody tracked). Email-digest links now pass through a count-only redirect so we can tell digests are useful. It counts clicks per day, never who clicked, and every digest footer says so.",
    chg_0702_h2: "2026.07.02 · Follow the dollars, matter timelines, follows, workspace, API",
    chg_0702_foryou_html: "<b>For you</b> — Awards now show what was <b>actually paid</b> (live from Checkbook NYC), any procurement matter reads as one timeline, you can follow a vendor or agency and get emailed when they reappear, pin anything into a citable investigation workspace, and use every view as an API.",
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

  // Shipping languages: full dictionaries live in i18n/lang/<lang>.js (loaded on
  // demand — see the file header above). Populated at runtime via
  // Object.assign(window.STRINGS.<lang>, {...}); stays {} here until then.
  es: {}, ru: {}, "zh-Hans": {}, bn: {}, ht: {}, ko: {}, fr: {}, pl: {}, ar: {}, ur: {},

  // Stub for the one remaining LL30 language — translation pending (a future wave)
  "zh-Hant": {},
};

// City Record section names arrive as DATA VALUES (section_name in the open dataset) but are
// rendered as navigation chrome (Today strip, agency profiles) — so they translate here, with
// English fallback for any section the dataset adds before we do (2026-07-13 hotfix, bug b).
// Populated per-language by i18n/lang/<lang>.js (SECTION_I18N.es = {...}; etc).
const SECTION_I18N = {};
function tSection(name) {
  const lang = window.LANG || "en";
  const map = SECTION_I18N[lang];
  return (map && map[name]) || name;
}

// Expose globals consumed by index.html
window.STRINGS = STRINGS;
window.LANG_META = LANG_META;
window.SUPPORTED_LANGS = SUPPORTED_LANGS;
window.SHIPPING_LANGS = SHIPPING_LANGS;
window.LANG_FILE_HASHES = LANG_FILE_HASHES;
window.I18N_PROVENANCE = I18N_PROVENANCE;
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

// tn(base, n, vars) — CLDR-correct pluralized lookup (w8-01 AC #2), backed by
// Intl.PluralRules. Looks up "<base>_<category>" (one/few/many/other, per CLDR), falling
// back to "<base>_other", then to the same chain under English, then to a raw key string —
// the same no-raw-key-crash posture as t(). {n} is auto-substituted from the count passed;
// extra `vars` behave like t()'s vars. English/Spanish output is unchanged byte-for-byte
// from the pre-tn() {s}-suffix hack (both only ever select "one" or "other").
function pluralCategory(lang, n) {
  try {
    const locale = (LANG_META[lang] && LANG_META[lang].intlDate) || lang;
    return new Intl.PluralRules(locale).select(n);
  } catch (e) {
    return n === 1 ? "one" : "other";
  }
}
window.pluralCategory = pluralCategory;

function tn(base, n, vars) {
  const lang = window.LANG || "en";
  const cat = pluralCategory(lang, n);
  const dict = STRINGS[lang] || {};
  let str = dict[base + "_" + cat];
  if (str === undefined) str = dict[base + "_other"];
  if (str === undefined) str = STRINGS.en[base + "_" + cat];
  if (str === undefined) str = STRINGS.en[base + "_other"];
  if (str === undefined) str = base + "_" + cat;
  const allVars = Object.assign({ n: n }, vars || {});
  Object.entries(allVars).forEach(function(kv) {
    str = str.replace(new RegExp("\\{" + kv[0] + "\\}", "g"), kv[1]);
  });
  return str;
}
window.tn = tn;

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
  // w8-06: per-language font stack + line-height as CSS custom properties (CJK/Bengali/
  // Arabic typography needs a script-aware stack; the :lang() rules in each page's CSS do
  // the case/tracking neutralization, this just supplies the stack the rules reference).
  document.documentElement.style.setProperty("--lang-font-stack", (meta && meta.fontStack) || "inherit");
  document.documentElement.style.setProperty("--lang-line-height-scale", (meta && meta.lineHeightScale) || 1);
  updateLangNotice();
}
window.applyStrings = applyStrings;

// updateLangNotice() — shared #langNotice banner (index.html + all subpages): discloses (a)
// that notice CONTENT stays English (only meaningful on pages that render notices) and (b)
// machine-translation-quality disclosure for any active language whose I18N_PROVENANCE state
// isn't yet "native-reviewed" (w8-02 AC). Centralizing this in applyStrings() means every
// page gets both disclosures for free — no per-page wiring needed.
function updateLangNotice() {
  const notice = document.getElementById("langNotice");
  if (!notice) return;
  const lang = window.LANG || "en";
  if (lang === "en") { notice.hidden = true; notice.textContent = ""; return; }
  const parts = [];
  if (document.getElementById("list")) parts.push(t("notices_in_english_note"));
  const prov = I18N_PROVENANCE[lang];
  if (prov && prov.state !== "native-reviewed") parts.push(t("mt_disclaimer"));
  if (parts.length) { notice.textContent = parts.join(" "); notice.hidden = false; }
  else { notice.hidden = true; notice.textContent = ""; }
}
window.updateLangNotice = updateLangNotice;

// ensureLangLoaded(lang, cb) — lazy-load a shipping language's dictionary file (browser
// only; Node/tooling already has every shipping language via the require() shim at the
// bottom of this file). cb runs once the dictionary is available (or immediately, if it
// already is, or if `lang` isn't a lazy-loadable shipping language). On network failure,
// STRINGS[lang] simply stays {} forever and t()/tn() fall back to complete English — the
// 2026-07-11 "no raw keys" rule — so there is no error path to handle here.
const _langLoadState = {}; // lang -> "loading" | "loaded"
function ensureLangLoaded(lang, cb) {
  if (lang === "en" || !SHIPPING_LANGS.includes(lang) || (STRINGS[lang] && Object.keys(STRINGS[lang]).length)) {
    if (cb) cb();
    return;
  }
  if (_langLoadState[lang] === "loading") {
    document.addEventListener("crol:langloaded:" + lang, function handler() {
      document.removeEventListener("crol:langloaded:" + lang, handler);
      if (cb) cb();
    });
    return;
  }
  _langLoadState[lang] = "loading";
  const hash = LANG_FILE_HASHES[lang];
  const s = document.createElement("script");
  s.src = "i18n/lang/" + lang + ".js" + (hash ? ("?v=" + hash) : "");
  function done() {
    _langLoadState[lang] = "loaded";
    document.dispatchEvent(new Event("crol:langloaded:" + lang));
    if (cb) cb();
  }
  s.onload = done;
  s.onerror = done; // fall back to English silently — no raw keys, no thrown error
  document.head.appendChild(s);
}
window.ensureLangLoaded = ensureLangLoaded;

// setLang(lang, onReady) — switch language, persist to localStorage, re-apply strings.
// Renders immediately with whatever is loaded (falls back to English for any missing key —
// static [data-i18n] chrome only), then re-applies once a lazily-loaded shipping language's
// dictionary finishes fetching. `onReady`, if given, runs both immediately AND again once
// the dictionary loads — callers with DYNAMICALLY-BUILT content (search results, today-strip
// cards, a subpage's live-fetched data) pass their repaint function here, because
// applyStrings() only ever touches [data-i18n]-tagged static elements: content already
// stamped out via t()/tn() template literals before the dictionary arrived would otherwise
// stay in English forever even after the network request completes (the load race this
// callback exists to close).
function setLang(lang, onReady) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = "en";
  window.LANG = lang;
  try { localStorage.setItem("crol_lang", lang); } catch(e) {}
  applyStrings();
  ensureLangLoaded(lang, function() {
    if (window.LANG === lang) {
      applyStrings();
      if (onReady) onReady();
    }
  });
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
        setLang(lang, onChange ? function(){ onChange(lang); } : null);
        btns.forEach(function(b){ b.setAttribute("aria-pressed", b.dataset.lang === lang ? "true" : "false"); });
        if (onChange) onChange(lang);
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
window.initSubpageLangSwitcher = initSubpageLangSwitcher;

// Node/tooling shim: when this file is require()'d outside a browser (tests, the hash-
// checking gate in i18n_refs.py, es_diacritics.py, etc.), synchronously require() every
// shipping language's dictionary file too, so window.STRINGS/SECTION_I18N come back
// complete with NO browser involved. `require`/`module` only exist in Node — this branch
// is dead code (never even parsed as reachable) in the browser.
if (typeof module !== "undefined" && module.exports !== undefined && typeof require === "function") {
  const path = require("path");
  SHIPPING_LANGS.forEach(function(lang) {
    require(path.join(__dirname, "i18n", "lang", lang + ".js"));
  });
}

// Init: restore saved language preference on module load (before DOMContentLoaded), and set
// the html lang/dir attributes immediately (i18n.js loads in <head>, so this runs before body
// paints — the WCAG 3.1.1 "no English flash" requirement, satisfied without a separate script).
// w8-01: if the saved preference is a lazily-loaded shipping language, document.write() its
// dictionary file's <script> tag NOW, while this script is still executing during <head>
// parsing — the browser fetches+runs it synchronously before the rest of the page parses, so
// the FIRST render already has the dictionary (no translated-text flash either, not just the
// lang/dir attributes). This only fires once, at initial load; a later in-session language
// switch uses ensureLangLoaded()'s async <script> injection instead (setLang(), above).
(function() {
  var saved = "en";
  try { saved = localStorage.getItem("crol_lang") || "en"; } catch(e) {}
  if (!SUPPORTED_LANGS.includes(saved)) saved = "en";
  window.LANG = saved;
  if (typeof document !== "undefined") {
    document.documentElement.lang = saved;
    var meta = LANG_META[saved];
    if (meta) document.documentElement.dir = meta.dir;
    if (saved !== "en" && SHIPPING_LANGS.includes(saved) && typeof document.write === "function") {
      var hash = LANG_FILE_HASHES[saved];
      document.write('<script src="i18n/lang/' + saved + '.js' + (hash ? ('?v=' + hash) : '') + '"><\/script>');
      _langLoadState[saved] = "loaded"; // document.write blocks until it runs — no async race
    }
  }
})();
