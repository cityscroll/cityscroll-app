// i18n.js — CityScroll runtime string catalog: CORE file.
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
const SELECTABLE_LANGS = ["en"].concat(SHIPPING_LANGS);

// URL language is a visit-scoped override: it wins over the saved device preference without
// replacing that preference. Picker changes still persist and keep the address bar shareable.
function explicitUrlLanguage(search) {
  try {
    const value = new URLSearchParams(typeof search === "string" ? search : "").get("lang");
    return SELECTABLE_LANGS.includes(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function initialLanguage(search, saved) {
  const explicit = explicitUrlLanguage(search);
  if (explicit) return explicit;
  return SELECTABLE_LANGS.includes(saved) ? saved : "en";
}

function languageURL(value, lang, baseHref) {
  const raw = String(value || "");
  try {
    const base = new URL(baseHref || location.href);
    const url = new URL(raw, base);
    if (url.origin !== base.origin) return raw;
    if (lang !== "en" && SELECTABLE_LANGS.includes(lang)) url.searchParams.set("lang", lang);
    else url.searchParams.delete("lang");
    return url.toString();
  } catch (_error) {
    return raw;
  }
}

function currentLanguageURL(value) {
  return languageURL(value, window.LANG || "en");
}

function syncLanguageURL(lang) {
  if (typeof location === "undefined" || typeof history === "undefined") return "";
  const next = languageURL(location.href, lang, location.href);
  try {
    const url = new URL(next);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch (_error) {}
  return next;
}

window.explicitUrlLanguage = explicitUrlLanguage;
window.initialLanguage = initialLanguage;
window.languageURL = languageURL;
window.currentLanguageURL = currentLanguageURL;
window.syncLanguageURL = syncLanguageURL;

// The deploy build stamps every page's i18n.js URL from the combined content of this file
// and all shipping dictionaries. Reuse that stamp for lazy dictionary requests, so a build
// can never pair new HTML or runtime code with a cached old dictionary. Source pages keep a
// merge-stable token; tools/stamp_i18n_assets.py replaces it only in the deployed artifact.
const I18N_ASSET_VERSION = (() => {
  if (typeof document === "undefined" || !document.currentScript) return "";
  try {
    return new URL(document.currentScript.src, document.baseURI).searchParams.get("v") || "";
  } catch (_error) {
    return "";
  }
})();

function i18nAssetUrl(path) {
  return path + (I18N_ASSET_VERSION ? ("?v=" + encodeURIComponent(I18N_ASSET_VERSION)) : "");
}


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
    scenario_heading: "What are you here to do?",
    scenario_intro: "Choose a task to start with useful filters, or use the category tabs above.",
    scenario_city_work: "I bid on city work",
    scenario_neighborhood: "I follow my neighborhood",
    scenario_hearings: "I attend or comment on hearings",
    scenario_city_career: "I explore a city career",
    scenario_subsidies_land: "I track subsidies and land use",
    scenario_legal_compliance: "I watch legal or compliance notices",
    scenario_open_contracts: "Open contracts",
    scenario_recent_awards: "Recent awards",
    scenario_ida_week: "IDA meetings this week",
    scenario_ida_month: "IDA meetings this month",
    scenario_ida_upcoming: "Upcoming IDA meetings",
    scenario_ida_past: "Past IDA meetings",
    // Task-first entry experiment (#task/can-i-bid, #task/what-will-change)
    task_can_i_bid_link: "Can I bid? (examples)",
    task_what_will_change_link: "What will change here? (examples)",
    task_can_i_bid_title: "Can I bid?",
    task_what_will_change_title: "What will change here?",
    task_can_i_bid_deck: "Five real open solicitations, led by eligibility stage and deadline. Every official field from the City Record stays on the card.",
    task_what_will_change_deck: "Five real Zoning Application Portal projects, led by place, boundary actions, and stage. Every official ZAP field stays on the card.",
    task_entry_kicker: "Task-first examples",
    task_loading: "Loading task examples…",
    task_bundle_missing: "No task examples are available right now.",
    task_example_not_found: "No record found for {id}.",
    task_back_examples: "Back to examples",
    task_open_example: "Open this example",
    task_open_notice_lens: "Open in Contracts",
    task_open_land_lens: "Open in Zoning",
    task_bid_yes_until: "Yes — responses accepted through {date} ({n} days left).",
    task_bid_yes_today: "Yes — responses are due today.",
    task_bid_yes_rolling: "Yes — this solicitation uses a rolling deadline.",
    task_bid_no_closed: "No — the published deadline was {date}.",
    task_bid_unknown: "Deadline not listed on this notice.",
    task_lead_stage: "Stage",
    task_lead_method: "Selection method",
    task_lead_deadline: "Deadline",
    task_lead_agency: "Agency",
    task_lead_pin: "PIN",
    task_lead_place: "Place",
    task_lead_boundary: "Actions",
    task_fact_category: "Category",
    task_fact_contact: "Contact",
    task_fact_submit: "Where to submit",
    task_fact_other: "Other info",
    task_fact_published: "Published",
    task_fact_request_id: "Request ID",
    task_fact_milestone: "Current milestone",
    task_fact_project_status: "Project status",
    task_fact_applicant: "Applicant",
    task_fact_ulurp: "ULURP numbers",
    task_fact_mih: "Mandatory Inclusionary Housing",
    task_fact_project_id: "Project ID",
    task_mih_yes: "Yes",
    task_mih_no: "No",
    task_change_place_lead: "Change under review in {place}.",
    task_change_place_unknown: "Place not listed on this project.",
    task_payment_lag_related: "a related recorded contract",
    task_payment_lag_observed_html: "Observed payment registration lag: {days} days for {subject}. Source: {source}. This is a recorded lag figure only. It is not a measure of how many bids the city received.",
    recent_past: "Recent past",
    this_search: "this search",
    meetings_widened_notice: "Showing {shown} for {query} ({none}).",
    meetings_shown_month: "this month's meetings",
    meetings_shown_upcoming: "upcoming meetings",
    meetings_shown_past: "recent past meetings",
    meetings_none_week: "none this week",
    meetings_none_month: "none this month",
    meetings_none_upcoming: "none upcoming",
    show_exact_search: "Show exact search",
    past_tag: "Past",
    no_hearings_after_widening: "Try a broader search. This search has no matching upcoming or recent past meetings.",
    footer_notices: "1M+ notices",
    sugg_money_0: "construction contracts over $500k",
    sugg_money_1: "IT consulting RFPs",
    sugg_money_2: "shelter services contracts",
    sugg_money_3: "park maintenance contracts",
    sugg_money_4: "school food service contracts",
    sugg_money_5: "senior center contracts",
    sugg_money_6: "contracts closing this week",
    sugg_money_7: "Parks contract forecast",
    sugg_people_0: "paramedic roles",
    sugg_people_1: "look up someone named Rodriguez",
    sugg_people_2: "attorney titles",
    sugg_people_3: "open competitive exams",
    sugg_land_0: "rezonings in Brooklyn",
    sugg_land_1: "rezonings in Queens",
    sugg_land_2: "79 Rivington",
    sugg_land_3: "rezonings in the Bronx",
    sugg_land_4: "rezonings in council district 33",
    sugg_property_0: "HPD property sales",
    sugg_property_1: "environmental protection land",
    sugg_property_2: "police department property",
    sugg_property_3: "parks department property",
    sugg_property_4: "property disposition hearings",
    sugg_rules_0: "buildings rules",
    sugg_rules_1: "sanitation rules",
    sugg_rules_2: "taxi rules",
    sugg_rules_3: "health department rules",
    sugg_rules_4: "rules open for comment",
    sugg_meetings_0: "recent landmarks hearings",
    sugg_meetings_1: "recent city council hearings",
    sugg_meetings_2: "recent community board meetings",
    sugg_meetings_3: "recent taxi and limousine hearings",
    sugg_meetings_4: "hearings this week",
    sugg_meetings_5: "what can I comment on this week",
    sugg_alerts_0: "awards over $1M",
    sugg_alerts_1: "education contracts over $200K due in 3 months",
    sugg_alerts_2: "rezonings near 79 Rivington",
    sugg_alerts_3: "sanitation contract awards",
    all_agencies_loading: "All agencies — loading…",
    // Tab labels
    tab_money:    "Contracts",
    tab_people:   "Staffing",
    tab_land:     "Zoning",
    tab_property: "Property",
    tab_rules:    "Rules",
    tab_meetings: "Meetings",
    tab_alerts:   "Alerts",
    tab_map: "Map",
    map_kicker: "What is happening where",
    map_heading: "Explore civic activity by district",
    map_intro: "Expand and contract the city map to see density of land actions, property disposition, rules, meetings, and contracts — then open the live feed for that area. District lines are a published layer, not a live geo query.",
    map_level_borough: "Boroughs",
    map_level_community: "Community districts",
    map_level_council: "Council districts",
    map_zoom_in_aria: "Zoom in",
    map_zoom_out_aria: "Zoom out",
    map_reset_view: "Reset",
    map_lens_all: "All activity",
    map_list_heading: "Areas",
    map_legend_label: "Fewer → more located events",
    map_boundary_vintage: "Districts as of {date}",
    map_fallback_note: "The map is optional. The district list and live lens filters stay available if the map does not load.",
    map_load_error: "Map data could not be loaded. Use the Contracts, Zoning, Property, Rules, and Meetings tabs to browse by list.",
    map_no_areas: "No districts in this view.",
    map_detail_lead: "{n} located events in the current lens ({lens}). Open a live feed below.",
    map_drill_community: "Show community districts",
    map_show_council: "Show council districts",
    map_follow_district: "Follow this district",
    map_areas_announce: "Showing {n} areas. Peak density {max}.",
    map_crumb_city: "New York City",
    map_crumb_council: "Council districts",
    map_bucket_citywide: "Citywide",
    map_bucket_virtual: "Virtual / online only",
    map_bucket_unlocated: "No place signal",
    map_citywide_detail_lead: "{n} citywide events in the current lens ({lens}). These apply across every district — not pinned to one place.",
    map_virtual_detail_lead: "{n} virtual-only meetings in the current lens ({lens}). No in-person venue was published.",
    map_unlocated_detail_lead: "{n} items in the current lens ({lens}) have no published place. That is missing location text, not zero activity in a district.",
    map_citywide_also_applies: "city-scale items also apply here (not counted inside this district's polygons).",
    map_money_framing: "Most contracts are citywide service classes or lack a published place — {citywide} citywide, {local} with a borough pin, {unlocated} without a place signal (of {counted} recent awards).",
    map_money_basis_performance: "Where work may affect a district",
    map_money_basis_response: "Where to respond or attend",
    map_money_response_basis_note: "These locations come from submission addresses, pre-bid venues, or document-pickup instructions. They describe procurement logistics, not where the contracted work will happen.",
    map_money_response_framing: "Response logistics are district-located for {local} of {counted} recent solicitations. {unlocated} have no resolved response address.",
    map_feed_contract_action_borough: "Contracts with response locations in this borough",
    map_feed_contract_action_community: "Contracts with response locations in this community district",
    map_feed_contract_action_council: "Contracts with response locations in this council district",
    money_location_basis_label: "Response location basis",
    money_location_basis_any: "Any location basis",
    money_location_basis_response: "Any response address",
    money_location_basis_submission: "Located by submission address",
    money_location_basis_prebid: "Located by pre-bid venue",
    money_location_basis_pickup: "Located by document-pickup address",
    money_community_district_label: "Community district",
    money_council_district_label: "Council district",
    money_district_any: "Any district",
    money_location_filter_interpretation: "Showing procurement logistics, not place of performance:",
    money_response_location_heading: "Contracts with a resolved response location",
    money_response_location_heading_place: "Contracts with a response location in {place}",
    map_drill_when_all: "All dates",
    // Map → list handoffs when the list filter is coarser than the selected polygon.
    map_feed_citywide_money: "Citywide contracts",
    map_feed_citywide_rules: "Citywide rules",
    map_feed_citywide_meetings: "Citywide meetings",
    map_feed_citywide_property: "Citywide property",
    map_feed_borough_meetings: "Meetings in this borough",
    map_feed_borough_property: "Property in this borough",
    map_feed_borough_rules: "Rules in this borough",
    property_tax_lien_link: "Tax lien sale statistics",
    tax_lien_formula_link: "How tax lien progression is computed",
    tax_lien_archive_note_html: "Archive reference — cycle context and actions appear on notices for parcels on a published list. This page is not linked from the property list.",
    tax_lien_archive_tables_summary: "View borough tables",
    tax_lien_cycle_stepper_aria: "Tax lien sale list stages",
    tax_lien_deadline_open: "Exemption and payment-plan action due {date} ({n} days left)",
    tax_lien_deadline_closing_soon: "Closing soon — exemption and payment-plan action due {date} ({n} days left)",
    tax_lien_deadline_closed: "For this cycle, exemption and payment-plan action was due {date} (deadline passed)",
    tax_lien_card_leave_rate: "{p} historically left before sale",
    tax_lien_card_deadline_live: "{n} days left to act ({date})",
    tax_lien_card_deadline_closed: "Action deadline was {date}",
    property_explore_map_link: "Explore property on the map",

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
    share_export_btn: "Share / export",
    export_xlsx:      "Export Excel",
    print_save_pdf:   "Print",
    print_header:     "CityScroll · {link} · As of {date}",
    csv_address: "Address",
    csv_applicant: "Applicant",
    csv_asset_type: "Asset type",
    csv_average_base_salary: "Average base salary",
    csv_exam_list: "Exam list",
    csv_max_base_salary: "Maximum base salary",
    csv_min_base_salary: "Minimum base salary",
    csv_notices: "Notices",
    csv_people: "People",
    csv_project: "Project",
    csv_project_id: "Project ID",
    csv_role: "Role",
    csv_search_permalink: "Search permalink",
    csv_status: "Status",
    pick_notice_empty:"Pick a notice on the left to trace it — for an RFP you'll see <b>how to respond</b> (deadline, contact, where to submit) and the full notice → award → dollars chain.",

    // People lens
    look_up_label:       "Look up",
    pmode_role:          "A role / title",
    pmode_person:        "A person",
    title_keyword_label: "Title keyword",
    person_name_label:   "Name",
    agency_filter_label: "Agency (optional)",

    // Alerts — one subscribe flow (scope → refine → email → frequency → preview → subscribe)
    quiz_heading:       "Get email alerts",
    alerts_flow_lead:   "Pick what to watch, enter your email, and subscribe. One form — no account required.",
    quiz_step1:         "What should we watch for you?",
    quiz_step2:         "Narrow with a keyword (optional)",
    quiz_step3:         "How often?",
    quiz_rfpkw:         "City contracts and RFPs",
    quiz_bigaward:      "Big contract awards",
    quiz_rezone:        "Rezonings near me",
    quiz_property:      "Property sales",
    quiz_rules:         "Rule changes",
    quiz_meetings:      "Hearings and meetings",
    quiz_district:      "Follow a district",
    quiz_daily:         "Send daily",
    quiz_weekly:        "Weekly (Mondays)",
    quiz_preview_btn:   "Preview digest",
    quiz_no_account:    "No account — just an email confirmation.",
    build_alert_heading:"More ways to watch",
    quick_suggestions:  "Quick suggestions",
    sugg_rezone_rivington: "Find Rivington rezonings",
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
    watch_district:     "Follow a district",
    district_pick_label: "Council district",
    district_pick_placeholder: "Choose a council district",
    district_preset_note: "One weekly email groups awards, hearings, land use actions, and property dispositions for this district.",
    district_pick_required: "Choose a council district first.",
    watch_entityvendor: "A vendor — anything naming them",
    watch_entityagency: "An agency — anything they publish",
    watch_awardwatch:   "The award on a notice I'm viewing",
    email_label:        "Email address",
    alerts_email_step_label: "Your email",
    email_placeholder:  "example@example.com",
    freq_label:         "Frequency",
    freq_daily:         "Daily",
    freq_weekly:        "Weekly",
    preview_digest_btn: "Preview today's digest",
    subscribe_btn:      "Subscribe",
    subscribe_confirm_note: "We'll email a link to confirm.",
    // Homepage primary conversion (under masthead tagline) — short words for the reading-level ratchet
    home_cta_prompt:    "Want email updates?",
    // Context-carrying alert entry (notice/lens → pre-scoped #alerts + real email preview)
    alert_context_scope: "You'll get an email for: {scope}",
    alert_context_from_notice: "From this notice: “{title}”",
    alert_context_next_step: "Next expected step: {step}",
    alert_context_confirm: "Confirm with your email below — one step.",
    home_cta_submit:    "Sign up",
    home_cta_topics:     "or pick topics",
    empty_preview:      "Pick a topic (or open with a watch link) to preview today's digest.",

    // Time/schedule strings (9 a.m. form per NYC style guide T-01/T-02)
    when_daily:  "New matches are emailed each morning, around 9 a.m. New York time (8 a.m. Nov–Mar).",
    when_weekly: "New matches are emailed Monday mornings, around 9 a.m. New York time (8 a.m. Nov–Mar).",

    // Status / error messages
    loading_data:           "Loading…",
    retry_open_data:        "Could not reach NYC Open Data. Retry in a moment.",
    nothing_found:          "Nothing found. Try a broader keyword or \"All RFPs\".",
    check_inbox:            "Check your inbox to confirm.",
    sent_confirm_to:        "Sent to {email}.",
    turnstile_fail:         "The human check didn't pass — try it again.",
    rate_limited:           "Too many attempts — give it a minute.",
    bad_email:              "That email address looks off.",
    channel_unsupported:    "Text alerts aren't available yet — choose Email.",
    not_configured:         "Subscriptions aren't switched on yet.",
    send_failed:            "Couldn't send the email just now — try again.",
    generic_error:          "Something went wrong — please try again.",
    // Turnstile on signup is interaction-only (invisible for most visitors); this is the race/load case.
    complete_human_check:   "Still verifying — try again in a moment.",
    sending_confirm_link:   "Sending…",
    cant_reach_server:      "Couldn't reach the server — try again.",

    // Deadline chips (N-01: numbers under ten spelled out; {n} receives already-spelled value)
    closes_today:     "closes today",
    closes_in_1_day:  "closes in one day",
    closes_in_n_days: "closes in {n} days",

    // Notice content language note (shown when non-English UI is active).
    // Softened once on-demand unofficial translation shipped: original stays official;
    // translation is an aid available from the notice detail.
    notices_in_english_note: "Official text in English. Unofficial translation available.",
    notices_in_english_es:   "Texto oficial en inglés. Traducción no oficial disponible.",

    // Informal notice translation (on-demand pane — minimal wording only)
    unofficial_translation: "Unofficial translation",
    unofficial_translation_show: "Show unofficial translation",
    unofficial_translation_hide: "Hide unofficial translation",
    unofficial_translation_loading: "Loading unofficial translation…",
    unofficial_translation_unavailable: "Unofficial translation unavailable.",

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
    use_my_location:     "Use my location",
    hearings_location_note_html: "<b>Affected place drives “near me.”</b> The venue is shown separately, because a Manhattan hearing can decide a Queens matter. Citywide and unlocated notices stay visible.",
    date_window_label: "Date window",
    this_week: "This week",
    next_30_days: "Next 30 days",
    all_upcoming: "All upcoming",
    affected_area_label: "Affected area",
    all_areas: "All areas",
    citywide_unlocated: "Citywide / unlocated",
    neighborhood_label: "Neighborhood",
    neighborhood_placeholder: "Astoria, Kingsbridge Heights…",
    citywide: "Citywide",
    affected_not_stated: "No affected area identified in this notice",
    property_location_not_stated: "No location identified in this notice",
    parcel_elsewhere_label: "This parcel elsewhere:",
    parcel_link_zola: "ZoLa zoning",
    parcel_link_acris: "ACRIS deeds",
    parcel_link_wow: "Who Owns What portfolio",
    parcel_via_geosearch: "lot {bbl} via GeoSearch — verify the match",
    parcel_via_notice_tax_lot: "lot {bbl} from this notice's tax-lot text — verify the match",
    community_district_short: "Community District {n}",
    council_district_short: "Council District {n}",
    districts_as_of: "Districts as of {vintage}",
    meetings_place_group_rail_label: "List layout",
    meetings_place_group_flat: "Single list",
    meetings_place_group_place: "Group by place",
    venue_virtual: "Online or by phone",
    venue_in_person: "In person",
    venue_hybrid: "In person and online",
    venue_not_stated: "Venue not stated",
    rules_hearing_badge: "Rule hearing",
    public_hearing_badge: "Public hearing / meeting",
    rule_stage_proposed: "Proposed",
    rule_stage_comment_open: "Comment open · {date}",
    rule_stage_comment_closed: "Comment window ended",
    rule_stage_hearing: "Hearing · {date}",
    rule_stage_adopted: "Adopted · {date}",
    rule_stage_effective: "In effect · {date}",
    rule_stage_unknown: "Stage unknown",
    rule_comment_btn: "Comment",
    // Rules action-rail guide (comment-open + hearing attend — only published fields)
    next_action_rule_guide: "Follow the comment and hearing steps below",
    rule_action_open_rule_page: "Open rule page",
    rule_guide_heading: "How to comment and participate",
    rule_guide_deadline_label: "Comment deadline",
    rule_guide_hearing_label: "Public hearing",
    rule_guide_comment_by_step: "Comment by {date}.",
    rule_guide_comment_portal_step_html: "How to comment: open the official comment page at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    rule_guide_comment_email_step_html: "How to comment: email <a href=\"mailto:{email}\">{email}</a>.",
    rule_guide_comment_rule_page_step_html: "How to comment: follow the instructions on the official rule page at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    rule_guide_attend_step: "Attend or testify on {date} at {where}.",
    rule_guide_attend_date_step: "Attend or testify on {date}.",
    rule_guide_attend_where_step: "Attend or testify at {where}.",
    rule_guide_join_step_html: "Join online at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    rule_guide_materials_step_html: "Hearing agenda and materials: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    rule_guide_testimony_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a>.",
    rule_guide_testimony_until_close_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> any time until the hearing ends.",
    rule_guide_testimony_until_date_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> by {date}.",
    rule_guide_contact_step_html: "Questions and accessibility requests: {who}.",
    rule_guide_fallback_step: "Use the official rule page and City Record notice on this page for comment and hearing details.",
    rule_lifecycle_heading: "Rule lifecycle",
    rule_event_proposal: "Proposal published",
    rule_event_hearing: "Public hearing",
    rule_event_comment_close: "Comment deadline",
    rule_event_adoption: "Adoption",
    rule_event_effective: "Effective",
    rule_event_published_on_html: "Published {date}",
    rule_event_scheduled_for_html: "Scheduled for {date}",
    rule_event_due_on_html: "Comments due {date}",
    rule_event_recorded_on_html: "Adoption published {date}",
    rule_event_starts_on_html: "Takes effect {date}",
    rule_event_not_yet_ingested_html: "Not yet shown here — {event} dates live in {source}.",
    rule_event_not_published_html: "The city has not published a {event} date for this rule — it would appear on the official NYC Rules page if released.",
    rule_event_official_source: "Open rule page",
    rule_source_nyc_rules: "NYC Rules",
    rule_event_provenance_html: "This timeline uses lifecycle dates published by {source}. Date-only deadlines use New York calendar dates and have no specified closing time.",
    rule_event_join_gap_html: "Not yet shown here — lifecycle dates for this City Record notice live in {source} when a rule can be joined.",
    rule_event_calendar_title: "Rule comment deadline: {title}",
    rule_event_calendar_reminder: "Rule comments are due tomorrow",
    // Rules phase-group (proposal → public process → adoption → effective)
    rule_phase_proposal: "Proposal",
    rule_phase_public_process: "Public process",
    rule_phase_adoption: "Adoption",
    rule_phase_effective: "Effective",
    rule_phase_now_label: "Now",
    rule_phase_next_html: "Next: <strong>{phase}</strong>",
    rule_phase_current: "Current",
    rule_phase_done: "Done",
    rule_phase_future: "Upcoming",
    rule_phase_empty: "No milestones in this phase yet",
    rule_phase_milestones_count: "{n} milestones",
    rule_phase_since: "since {date}",
    rule_phase_aggregate_range: "{first} → {last}",
    rule_phase_show_history: "Earlier phases",
    rule_phase_action_proposal: "Read proposed rule",
    rule_phase_action_public_process: "Comment or attend",
    rule_phase_action_adoption: "Read adoption record",
    rule_phase_action_effective: "Read requirements",
    rule_phase_action_attend_hearing: "Read hearing details",
    rule_phase_how_summary: "Explain timeline",
    rule_phase_how_html: "Phases follow the city’s rulemaking path: proposal, public process (hearing and comment deadline), adoption, then effective date. Dates come from NYC Rules when a City Record notice can be joined. Identical official links appear once per phase. Empty phases mean the city has not published that date yet.",
    // Multi-notice rulemaking stitch (proposal / hearing / adoption siblings)
    rule_siblings_heading: "Same rulemaking",
    rule_siblings_count: "{n} City Record notices for this rule",
    rule_sibling_this_notice: "this notice",
    rule_sibling_role_proposal: "Proposal",
    rule_sibling_role_hearing: "Public hearing",
    rule_sibling_role_adoption: "Adoption",
    rule_sibling_role_notice: "Notice",
    rule_phase_how_multi_html: "When several City Record notices confidently belong to one rulemaking (proposal, hearing, adoption), this timeline stitches them into one path. Only high-confidence joins appear here. Ambiguous notices stay separate. Dates come from NYC Rules when joined.",
    // Rules domain explorer (list ontology — process rail + multi-notice collapse)
    rules_domain_kicker: "City agency rulemaking",
    rules_domain_heading: "Proposal, public process, adoption",
    rules_domain_deck: "City Record Agency Rules notices are grouped by rulemaking stage — proposal, public process (comment and hearing), adoption, then effective date — so multi-notice chains collapse into one rule when the join is high-confidence.",
    rules_process_rail_label: "Rulemaking stage",
    rules_process_label: "Stage",
    rules_process_stepper_aria: "Rulemaking process stages",
    rules_chain_notice_count: "{n} notices in this rulemaking",
    rules_list_no_agency: "Agency not stated on this notice",
    rules_entries_announce: "{n} rulemakings",
    rules_siblings_label: "Same rulemaking",
    rules_action_agency_profile: "Open agency profile",
    rule_stage_unstaged: "Unstaged",
    rule_action_open_notice: "Open notice",
    rule_action_comment: "Comment",
    rule_action_comment_closed: "Public comment is closed for this rule",
    rule_action_attend_hearing: "Follow hearing",
    rule_action_attend_hearing_dated: "Follow hearing",
    // Action bands — group rules by what you can do now (not only by date)
    rule_band_comment_open: "Comment window open",
    rule_band_comment_open_days: "Comment window open ({n} days left)",
    rule_band_hearing: "Hearing scheduled — attend",
    rule_band_hearing_dated: "Hearing scheduled — attend on {date}",
    rule_band_adopted: "Adopted",
    rule_band_adopted_effective: "Adopted — takes effect {date}",
    rule_band_other: "Other rule notices",
    rule_band_count: "{n}",
    rules_action_band_rail_label: "What you can do now",
    // Template-shepherded participation (neutral scaffold, no advocacy)
    rule_part_summary: "Learn to comment",
    rule_part_channel_heading: "Where comments go",
    rule_part_channel_nyc_rules: "Official NYC Rules comment page",
    rule_part_channel_cta: "Open comment form",
    rule_part_deadline_line: "Comments are open through {date} ({n} days left).",
    rule_part_deadline_line_undated: "Comments are open — check the official page for the closing date.",
    rule_part_counts_heading: "What makes a comment count",
    rule_part_counts_timely: "Submit before the published deadline (or as soon as you can while the window is open).",
    rule_part_counts_specific: "Name the rule and the part of the proposal you are writing about.",
    rule_part_counts_identify: "Say who you are (person, business, or association) so the record is clear.",
    rule_part_scaffold_heading: "Neutral structure for your comment",
    rule_part_scaffold_lead: "This scaffold does not suggest a position. It only helps you organize facts the agency can use.",
    rule_part_scaffold_who_label: "Who you are",
    rule_part_scaffold_who_placeholder: "Restaurant owner in Queens, or association staff for licensed drivers",
    rule_part_scaffold_affects_label: "How this rule affects your operation",
    rule_part_scaffold_affects_placeholder: "Which permits, costs, schedules, or members are in scope",
    rule_part_scaffold_ask_label: "What you ask the agency to consider",
    rule_part_scaffold_ask_placeholder: "Clarify a definition, extend a phase-in, or answer a practical question",
    rule_part_scaffold_draft_label: "Draft from your notes (edit before you send)",
    rule_part_scaffold_copy: "Copy draft",
    rule_part_scaffold_copied: "Copied",
    // Forwardable member blurb (association secretary)
    rule_member_blurb_summary: "Share with your members",
    rule_member_blurb_lead: "A ready paragraph for a newsletter or group message. It includes this notice’s specifics — edit freely before sending.",
    rule_member_blurb_copy: "Copy blurb",
    rule_member_blurb_copied: "Copied",
    // Watch templates — association monitor packs (registry-driven)
    watch_tpl_heading: "Association monitor packs",
    watch_tpl_lead: "One-tap multi-watch bundles for industry associations. Each pack creates separate email watches through the usual confirm-link path.",
    watch_tpl_serves_label: "Who it serves",
    watch_tpl_watches_label: "Watches included",
    watch_tpl_select: "Use this pack",
    watch_tpl_selected: "Selected pack",
    watch_tpl_clear: "Clear pack",
    watch_tpl_subscribe_note: "Subscribe sends one confirmation email per watch in the pack (same inbox). Click each link to activate.",
    watch_tpl_sending: "Sending confirmation links for {n} watches…",
    watch_tpl_sent_ok: "Check your inbox — confirmation links for {ok} of {n} watches were sent to {email}.",
    watch_tpl_sent_partial: "Sent {ok} of {n} confirmation links. {fail} failed — try again or subscribe to watches one at a time.",
    read_official_notice: "Read official notice",
    next_action_heading: "What can I do now?",
    next_action_watch: "Watch this notice",
    next_action_watch_rezone: "Watch this rezoning",
    next_action_unavailable_handoff: "The official action link is not published here.",
    next_action_bid_closed: "The response deadline has passed.",
    next_action_comment_closed: "Public comment is not open now.",
    next_action_event_passed: "This event has passed.",
    next_action_participation_missing: "No online participation link is published in this notice.",
    next_action_hearing_guide: "Follow the participation steps below",
    next_action_land_guide: "Follow the land-use participation steps below",
    next_action_land_steps_missing: "No participation steps are published for this rezoning yet.",
    next_action_exam_closed: "The application window has closed.",
    next_action_exam_not_open: "Applications are not open yet.",
    outcome_prompt_heading: "Did you take part?",
    outcome_prompt_lead_handoff: "When you return from the official site, you can share what happened.",
    outcome_prompt_lead_passed: "If you took part before this action closed, you can share what happened.",
    outcome_prompt_self_report: "This is your optional self-report, not an official result.",
    outcome_prompt_privacy: "CityScroll keeps only a 90-day aggregate count — no notice ID, account, or free text.",
    outcome_prompt_choices_label: "Optional outcome",
    outcome_prompt_submitted: "I submitted",
    outcome_prompt_attended: "I attended",
    outcome_prompt_bid: "I placed a bid",
    outcome_prompt_won: "I won",
    outcome_prompt_not_useful: "This was not useful",
    outcome_prompt_not_now: "Not now",
    outcome_prompt_thanks: "Thanks — your choice was added to the aggregate count.",
    // Award / selection action rail (Money lens — not a bid CTA).
    next_action_award_guide: "Track this award below",
    next_action_award_to: "Awarded to {vendor} · {amount}",
    next_action_award_to_vendor: "Awarded to {vendor}",
    next_action_award_registered: "Registered {date}",
    next_action_award_pending: "Pending registration on Checkbook",
    next_action_award_checkbook: "Open Checkbook",
    next_action_selection_guide: "What happens next in selection",
    next_action_intent_to_award: "Intent to Award — selection in progress",
    next_action_intent_to_negotiate: "Intent to Negotiate — selection in progress",
    next_action_vendor_list: "Vendor list — selection in progress",
    award_guide_heading: "Follow this award",
    award_guide_selection_heading: "What happens next in selection",
    award_guide_vendor_label: "Vendor",
    award_guide_amount_label: "Award amount",
    award_guide_registered_label: "Registered",
    award_guide_pending_label: "Registration",
    award_guide_pending_status: "Pending on Checkbook",
    award_guide_spent_label: "Spending to date",
    award_guide_contract_label: "Contract ID",
    award_guide_pin_label: "PIN",
    award_guide_vendor_step: "Awarded to {vendor}.",
    award_guide_amount_step: "Published award amount: {amount}.",
    award_guide_registered_step: "Registered on Checkbook on {date}.",
    award_guide_pending_step: "Registration is still pending on Checkbook.",
    award_guide_spent_step: "Spending to date: {amount}.",
    award_guide_checkbook_step_html: "Open the contract record on Checkbook: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    award_guide_selection_intent_award_step: "The city has published an Intent to Award. The solicitation is closed for new bids — watch for the final Award notice and Checkbook registration.",
    award_guide_selection_intent_negotiate_step: "The city is negotiating with a vendor. Bidding is closed. Watch for Intent to Award or Award notices on the same PIN.",
    award_guide_selection_vendor_list_step: "A vendor list was published for this procurement. Bidding is closed. Watch for Intent to Award or Award notices on the same PIN.",
    // Prime-win sub-outreach card (award_prime_goal side-car). Facts only — never goal-gap copy.
    sub_outreach_heading: "Prime award snapshot",
    sub_outreach_prime_lbl: "Prime vendor",
    sub_outreach_agency_lbl: "Agency",
    sub_outreach_dollars_lbl: "Award amount",
    sub_outreach_industry_lbl: "Industry",
    sub_outreach_window_callout: "Possible subcontract window after this award.",
    sub_outreach_how_summary: "View sources",
    sub_outreach_provenance_html: "Prime, agency, dollars, and industry labels come from the joined City Record award (and Checkbook or PASSPort fields when present). This panel shows only those published facts.",
    // Receipt-backed NYCEDC/NYCIDA/Build NYC project identity on subsidy notices.
    subsidy_project_heading: "Official project records",
    subsidy_project_company_lbl: "Company",
    subsidy_project_address_lbl: "Project address",
    subsidy_project_lifecycle_dates_lbl: "Lifecycle dates",
    subsidy_project_documents_link: "Official project documents",
    subsidy_project_how_summary: "View sources",
    subsidy_project_provenance: "Published project records from the Economic Development Corporation, Industrial Development Agency, or Build NYC, joined to this City Record notice.",
    award_guide_selection_watch_step: "Watch this notice for the next City Record update on the same PIN.",
    award_guide_no_bid_step: "Do not bid — this stage is past the solicitation response window.",
    award_guide_fallback_step: "Use the contract timeline and Follow the money section on this page for registration and spending.",
    land_action_open_hearing_notice: "Open hearing notice",
    land_guide_heading: "How to participate in this rezoning",
    land_guide_phase_label: "Current ULURP phase",
    land_guide_status_label: "Public status",
    land_guide_hearing_label: "Next hearing",
    land_guide_testimony_label: "Written testimony",
    land_guide_phase_step: "This project is in {phase}.",
    land_guide_pre_review_step: "Public review has not started yet — watch for Community Board, Borough President, CPC, and Council hearings.",
    land_guide_pre_review_phase_step: "This project is in {phase}. Public comment windows open during Community Board, Borough President, CPC, and Council review.",
    land_guide_closed_step: "Public comment is not open for this project right now.",
    land_guide_attend_step: "Attend the hearing on {date} at {where}.",
    land_guide_attend_date_step: "Attend the hearing on {date}.",
    land_guide_attend_where_step: "Attend the hearing at {where}.",
    land_guide_attend_maps_step_html: "Attend in person at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{address}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_watch_live_step_html: "Watch live at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_hearing_location_raw_step: "Hearing location (as published): {text}",
    land_guide_join_step_html: "Join online at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_materials_step_html: "Hearing agenda and materials: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_testimony_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a>.",
    land_guide_testimony_until_close_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> any time until the hearing ends.",
    land_guide_testimony_until_date_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> by {date}.",
    land_guide_contact_step_html: "Questions and accessibility requests: {who}.",
    land_guide_zap_comment_step_html: "View the application and submit comments on ZAP: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_zap_project_step_html: "Full project record on ZAP: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_notice_step_html: "Official hearing notice: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    land_guide_other_hearing_step: "Also scheduled: {body} on {date}.",
    land_guide_fallback_step: "Use the project timeline and official notice links on this page to track hearings and comment windows.",
    land_action_attend_in_person: "Attend in person",
    land_action_attend_in_person_at: "Attend in person",
    land_action_watch_live: "Watch live",
    land_pipeline_overall_public_review: "Public review",
    land_pipeline_position_html: "Public review — step {step} of {total}: {stage} ({clock})",
    land_pipeline_clock_days_left: "{n}-day clock, {left} days left",
    land_pipeline_clock_due_today: "{n}-day clock, due today",
    land_pipeline_clock_overdue: "{n}-day clock, {over} days past the statutory window",
    land_pipeline_clock_window_only: "{n}-day statutory clock",
    land_status_upcoming_hearings: "Upcoming hearings",
    land_hearings_mode_label: "Attendance",
    land_hearings_mode_all: "Any mode",
    land_hearings_mode_in_person: "In person",
    land_hearings_mode_livestream: "Livestream",
    land_hearings_empty: "No upcoming land-use hearings match these filters.",
    land_hearings_empty_none_future: "Last refresh ({when}): found logistics on {n} projects, but none still have a future public hearing date in the ZAP fields CityScroll reads.",
    land_hearings_empty_as_of_unknown: "latest refresh",
    land_hearings_empty_filters: "Hearings are in the snapshot, but none match the filters above.",
    land_hearings_empty_next_steps_html: "Try <a href=\"#meetings?when=upcoming\">Meetings → upcoming</a> for City Record hearings, or <a href=\"#land\">Zoning → In review</a> for project venue notes when ZAP publishes them.",
    land_hearings_heading: "Upcoming land-use hearings",
    land_hearings_card_when: "Hearing {date}",
    land_hearings_card_modes: "Attendance: {modes}",
    land_hearings_mode_list_in_person: "in person",
    land_hearings_mode_list_livestream: "livestream",
    land_hearings_open_project: "Open project",
    land_dig_open_detail: "Open in CityScroll",
    join_online: "Join online",
    participation_link: "Open participation link",
    ida_meetings_page: "IDA meetings page",
    email_in_notice: "Email listed in notice",
    map_venue: "Map venue",
    venue_label: "Venue",
    hearing_guide_heading: "How to participate",
    hearing_guide_when_label: "When",
    hearing_guide_testimony_label: "Written testimony",
    hearing_guide_attend_step: "Attend on {date} at {where}.",
    hearing_guide_attend_date_step: "Attend on {date}.",
    hearing_guide_attend_where_step: "Attend at {where}.",
    hearing_guide_join_step_html: "Join online at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    hearing_guide_materials_step_html: "Hearing agenda and materials: <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    hearing_guide_signup_step_html: "Sign up to testify at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    hearing_guide_testimony_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a>.",
    hearing_guide_testimony_until_close_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> any time until the hearing ends.",
    hearing_guide_testimony_until_date_step_html: "Submit written testimony to <a href=\"mailto:{email}\">{email}</a> by {date}.",
    hearing_guide_contact_step_html: "Questions and accessibility requests: {who}.",
    hearing_guide_fallback_step: "Use the date, venue, and contact details on this page to attend or comment.",
    who_affected_label: "Who it affects",
    who_affected_not_stated: "Not stated in the notice",
    audience_restaurants: "Restaurant operators, diners, nearby residents, and street users",
    audience_curb: "Drivers, vehicle operators, and people who use the curb",
    audience_land_use: "Nearby residents, property owners, applicants, and community groups",
    audience_buildings: "Building owners, tenants, designers, and construction teams",
    audience_property: "People who live near, own, or use the subject property",
    audience_schools: "Students, families, educators, and school communities",
    audience_health: "Patients, health providers, and affected communities",
    audience_businesses: "Businesses, license or permit holders, and their customers",
    local_hearings_group: "Place-specific hearings",
    local_hearings_note: "",
    citywide_hearings_group: "Citywide hearings",
    citywide_hearings_note: "These may affect every borough",
    unlocated_hearings_group: "No affected area identified in this notice",
    unlocated_hearings_note: "",
    hearing_results_summary: "{n} hearings · {local} place-specific · {citywide} citywide · {unlocated} unlocated",
    // Flat default keeps place counts in the status line without section headers.
    no_hearings_window: "Try the next 30 days or Citywide / unlocated. This exact date and area have no matching meetings.",
    desc_affecting_area: " affecting {area}",
    near_you_area:       "near you → {area}",
    zip_addr_neighborhood: "ZIP or place",
    status_label:        "Status",
    status_active:       "In review / active",
    status_all:          "All",
    look_up_pmode:       "Look up",
    filters_toggle:      "Filters",

    // Keyword placeholders
    kw_placeholder_money:   "shelter, IT, construction, security…",
    kw_placeholder_land:    "Bushwick, 79 Rivington, Gowanus…",
    kw_placeholder_property: "address or neighborhood…",
    kw_placeholder_rules:   "sanitation, licensing, rent, sidewalk…",
    kw_placeholder_meetings: "Community Board, Brooklyn, landmark…",
    kw_placeholder_people_role:   "emergency medical, attorney, engineer…",
    kw_placeholder_people_person: "last name, for example Rodriguez",
    nl_placeholder_people:   "for example, paramedic roles, open competitive exams, or look up someone named Rodriguez",
    nl_placeholder_land:     "for example, rezonings in Brooklyn, council district 33, or 79 Rivington",
    nl_placeholder_property: "for example, HPD property sales, disposition hearings, DEP land",
    nl_placeholder_rules:    "for example, buildings rules, rules open for comment",
    nl_placeholder_meetings: "for example, hearings this week, landmarks, city council",
    nl_placeholder_alerts:   "for example, education contracts over $200K due in 3 months, or awards over $1M",
    nl_chip_closing_this_week: "closing this week",
    nl_chip_exam_guide: "exam guide",

    // People panel
    roles_heading:       "Roles",
    people_heading:      "People",
    listing_heading:     "Listing",
    land_listing_heading: "Listing",
    try_a_title_empty:   "Try a title like \"emergency medical\" -- or switch to a person.",
    pick_role_empty:     "Pick a role to see its official title, whether it needs an exam, its salary band, and the career ladder.",
    pick_result_empty:   "Pick a result on the left.",
    type_keyword_empty:  "Type a keyword to search.",
    staffing_pathways_kicker: "City careers",
    staffing_pathways_heading: "Choose your next step",
    staffing_pathways_deck: "Find an exam you can apply for, or explore the live City Record notices, titles, and pay behind City staffing.",
    staffing_upcoming_heading: "Upcoming civil-service exams",
    staffing_upcoming_deck: "These next application windows come from the DCAS exam guide. Open exams appear first.",
    staffing_explore_all_exams: "See all exam dates",
    staffing_notices_heading: "Live staffing notices, titles, and pay",
    staffing_notices_deck: "Search City Record personnel changes, recent payroll, and active civil-service titles. Live searches are labeled separately from the exam schedule guide.",
    staffing_browse_notices: "Browse live staffing notices",
    staffing_back_to_guide: "Go to the civil-service exam guide",
    staffing_no_upcoming: "No open or upcoming open-competitive exams appear in the current schedule. Check the source status below before acting.",
    staffing_exam_open_tag: "Exam open",
    staffing_exam_upcoming_tag: "Upcoming exam",
    staffing_view_exam_detail: "View exam details",
    staffing_feed_kicker: "City staffing",
    staffing_feed_heading: "Newest staffing notices",
    staffing_feed_deck: "Recent appointments published in the City Record, newest first. Search and filters refine the notices already on the page.",
    staffing_search_label: "Search these notices",
    staffing_search_placeholder: "role, person, agency, or title code…",
    staffing_filter_type: "Notice type",
    staffing_filter_hires: "New hires",
    staffing_filter_exams: "Civil-service exams",
    staffing_exam_help: "Learn about exams",
    contract_examples_heading: "Follow a real contract",
    staffing_filter_roles: "Role or title",
    staffing_all_roles: "All roles",
    staffing_filter_agencies: "Agency",
    staffing_all_agencies: "All agencies",
    staffing_list_heading: "Latest postings",
    staffing_appointments_heading: "Latest appointments",
    staffing_exam_guide_heading: "Civil-service exam guide",
    staffing_exam_count: "{n} exams in the DCAS schedule",
    staffing_exam_redirect_html: "Civil-service exams follow the DCAS exam schedule — not the day-to-day City Record appointments above. Browse open and upcoming exams with deadlines, fees, and application links in the guide below.",
    staffing_loading: "Loading staffing notices…",
    staffing_new_hire_tag: "New hire",
    staffing_effective_date: "Effective {date}",
    staffing_salary: "Salary {amount}",
    staffing_title_code: "Title code {code}",
    staffing_view_notice: "View in the City Record",
    staffing_results_count: "{n} appointments shown",
    staffing_no_results: "No staffing notices match these filters.",
    staffing_load_failed: "The latest staffing notices could not load. Try again later.",
    staffing_unknown_role: "Title code {code}",
    career_kicker: "City careers, explained",
    career_heading: "A City job may start with an exam",
    career_deck: "Civil-service exams can open a path to stable public-service work. You do not need to know City hiring jargon first: start with work that interests you, check the official requirements, and apply during the listed window.",
    career_summary_aria: "Exam guide summary",
    career_open_count_label: "open to applications now",
    career_upcoming_count_label: "open-competitive exams scheduled next",
    career_no_account_fact: "No account here",
    career_no_account_label: "Applications happen in the City's OASys system",
    career_how_heading: "What a civil-service exam does",
    career_step1_title: "Find an exam",
    career_step1_body: "Open-competitive exams are available to anyone who meets the requirements.",
    career_step2_title: "Read the NOE",
    career_step2_body: "The Notice of Examination is the official guide to the job, qualifications, fee, and test.",
    career_step3_title: "Apply in the window",
    career_step3_body: "Create an OASys account, submit the application, and request a fee waiver if you qualify.",
    career_step4_title: "Join the eligible list",
    career_step4_body: "If you pass, your score places you on a list agencies use when they hire for that title.",
    career_browser_heading: "Find an exam you can act on",
    career_browser_note: "Open exams come first, sorted by the soonest application deadline. Upcoming dates are tentative until DCAS posts the NOE. Choose an interest area — never a personal profile.",
    career_last_day: "Last day to apply",
    career_deadline_passed: "Deadline passed",
    career_search_label: "Job or exam number",
    career_search_placeholder: "for example, caseworker or 7016",
    career_interest_label: "Interest area",
    career_all_interests: "All interests",
    career_eligibility_label: "Who can apply",
    career_anyone_option: "Anyone who qualifies",
    career_city_employee_option: "Current City employees",
    career_all_eligibility_option: "All exam types",
    career_window_label: "Application window",
    career_actionable_option: "Open and upcoming",
    career_open_option: "Open now",
    career_upcoming_option: "Upcoming",
    career_all_windows_option: "All scheduled exams",
    career_format_label: "Exam format",
    career_format_all: "Any format",
    career_format_eee: "Education and experience",
    career_format_mc: "Multiple choice",
    career_format_physical: "Physical",
    career_format_mixed: "Mixed / multi-part",
    career_salary_band_label: "Starting salary",
    career_salary_band_all: "Any salary",
    career_salary_under_45k: "Under $45,000",
    career_salary_45k_60k: "$45,000–$60,000",
    career_salary_60k_80k: "$60,000–$80,000",
    career_salary_80k_plus: "$80,000+",
    career_fee_level_label: "Application fee",
    career_fee_level_all: "Any fee",
    career_fee_none: "No fee",
    career_fee_low: "$1–$40",
    career_fee_mid: "$41–$70",
    career_fee_high: "$71+",
    career_no_experience_label: "Experience",
    career_experience_all: "Any requirements",
    career_no_experience_yes: "No prior experience required",
    career_experience_required: "Experience required",
    career_diff_format_eee: "Education and experience review",
    career_diff_format_mc: "Multiple-choice test",
    career_diff_format_physical: "Physical test",
    career_diff_format_mixed: "Multi-part exam",
    career_diff_format_other: "See NOE for test format",
    career_diff_no_fee: "No application fee",
    career_diff_no_experience: "No prior experience required",
    career_diff_experience: "Experience required",
    career_diff_residency: "Residency required",
    career_diff_no_residency: "City residency not required",
    career_diff_salary: "From {amount}",
    career_diff_salary_range: "{min}–{max}",
    career_diff_quals: "Who may qualify",
    career_fee_waiver_boilerplate: "Fee waivers may apply for veterans, unemployed applicants, students, first-time test takers, and public-assistance recipients.",
    career_loading: "Loading the DCAS exam guide…",
    career_explorer_heading: "Explore City titles, pay, and staffing notices",
    career_explorer_deck: "Already have a job title or person in mind? Compare recent City payroll, active civil-service lists, and City Record personnel changes.",
    career_area_public_safety: "Public safety",
    career_area_health_care: "Health and care",
    career_area_engineering: "Engineering and construction",
    career_area_technology: "Technology and science",
    career_area_community: "Community and social services",
    career_area_administration: "Administration and finance",
    career_area_trades: "Trades and operations",
    career_area_other: "Other City work",
    career_date_unknown: "Date not published",
    career_not_published: "Not published — would appear on the Notice of Examination if released",
    career_fee_salary_not_yet_ingested_html: "Not yet shown here — fee and salary live in {source}.",
    career_noe_source_name: "the DCAS Notice of Examination",
    career_status_open: "Open now",
    staffing_history_summary: "What happened: recent appointments",
    career_group_open: "Apply now",
    career_group_upcoming: "Coming up",
    career_group_continuous: "Walk-in and continuous exams",
    career_group_other: "Other scheduled exams",
    career_status_upcoming: "Upcoming",
    career_status_closed: "Closed",
    career_status_canceled: "Canceled",
    career_status_postponed: "Postponed",
    career_status_unscheduled: "Date pending",
    career_open_through: "Apply by {date}",
    career_opens_on: "Applications open {date}",
    career_closed_on: "Applications closed {date}",
    career_canceled_copy: "DCAS lists this exam as canceled.",
    career_postponed_copy: "DCAS lists this exam as postponed.",
    career_exam_number: "Exam {number}",
    career_promotion_badge: "City employees only",
    career_application_fee: "application fee",
    career_starting_salary: "minimum salary in the NOE",
    career_qualifications: "Who may qualify:",
    career_test_method: "How it is scored:",
    career_fee_waiver: "Fee help:",
    career_official_english_note: "Job details above summarize the official English NOE. Read the full NOE before applying. OASys can translate NOEs into more than 190 languages.",
    career_noe_pending: "DCAS has scheduled this exam, but the detailed NOE is not available in this guide yet. Dates may change.",
    career_read_noe: "Read the official NOE",
    career_official_schedule: "Check the official schedule",
    career_apply_oasys: "Apply in OASys",
    career_apply_oasys_browse: "Browse OASys exams",
    career_back_all: "Back to all exams",
    career_show_more: "Show {n} more exams",
    career_exam_not_found: "That exam is not in the current DCAS schedule.",
    career_no_results: "No exams match these filters. Try all interests or all scheduled exams.",
    career_source_current: "From official DCAS sources. Open exams checked {date}. Annual schedule current through {annual}.",
    career_source_stale: "The latest open-exam check is from {date}. Confirm every date on the official DCAS site before acting.",
    career_source_details: "Sources and refresh rules",
    career_city_record_finding: "The City Record dataset was checked too. It does not publish DCAS Notices of Examination as an exam-announcement section, so this guide uses DCAS schedules and NOEs instead.",
    career_load_failed: "The exam guide could not load. Use the official DCAS exam schedule and try this page again later.",
    career_outcomes_heading: "Post-cycle outcomes",
    career_outcome_list_established: "on eligible list",
    career_outcome_hiring_pool: "hiring pool (certified)",
    career_outcome_hired: "hired",
    career_outcome_applicants: "applicants (cycle)",
    career_outcomes_joined_note: "Aggregate counts from the DCAS annual outcomes publication for cycle {cycle} (published {date}). Individual scores are not public.",
    career_outcomes_list_joined_note: "List size from {source} (list established {date}). Individual scores and ranks are not public.",
    exam_list_prediction_cohort_html: "Predicted based on {n} eligible lists established since {year} — median {months} months after the filing period closed.",
    exam_list_prediction_window: "Statistical range {first}–{last}. Median {median}.",
    exam_list_prediction_method: "How this range is calculated",
    exam_list_extension_observed: "Observed extension date: {date}.",
    exam_list_duration_context: "Eligible lists generally last one to four years under state law. This is legal context, not a prediction.",
    exam_list_law_source: "New York Civil Service Law §56",
    career_outcomes_source_name: "the DCAS annual civil-service exam outcomes publication",
    career_outcomes_list_source_name: "the Civil Service List open data feed",
    career_outcome_stage_list: "eligible-list establishment",
    career_outcome_stage_certification: "agency certification",
    career_outcome_stage_appointment: "appointment",
    // Class-(b) retained for individual scores / legacy; aggregate empty slots use class-(a).
    career_outcomes_not_published_html: "The city does not publish post-cycle outcomes for this exam yet — they would appear in {source} after {stage}.",
    career_outcomes_not_yet_ingested_html: "Not yet shown here — post-cycle aggregates live in {source} (and Civil Service List open data) after {stage}.",

    // Exam process spine (application → list → certification → appointment — not the static guide steps)
    exam_spine_heading: "Exam hiring timeline",
    exam_stage_application: "Application window",
    exam_stage_list_establishment: "Eligible list",
    exam_stage_certification: "Agency certification",
    exam_stage_appointment: "Appointment",
    exam_stage_on_list_count: "{n} on list",
    exam_stage_certified_count: "{n} certified",
    exam_stage_hired_count: "{n} hired",
    exam_stage_not_yet_ingested_html: "Not yet shown here — this stage's public aggregates live in {source}.",
    exam_spine_join_html: "Process chain for exam {number} ({title}).",
    exam_spine_provenance_html: "Timeline joins the DCAS exam schedule / Notice of Examination, Civil Service List open data, and the DCAS annual outcomes publication by exam number. Empty stages mean those aggregates are not yet in this guide — not that the city withheld a public source. Individual scores stay private.",
    exam_phase_action_application: "Apply during the open window or read the Notice of Examination",
    exam_phase_action_list_establishment: "Check the eligible list for this exam",
    exam_phase_action_certification: "Review agency certification counts",
    exam_phase_action_appointment: "Review appointments from this exam",
    exam_phase_now_html: "Now: <b>{phase}</b> — {action}",
    exam_phase_next_html: "Next: {phase}",
    exam_phase_source_link: "Open source",
    exam_source_schedule: "the DCAS exam schedule / Notice of Examination",
    exam_source_list: "the Civil Service List open data feed",
    exam_source_outcomes: "the DCAS annual civil-service exam outcomes publication",

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
    nl_filter_notice_label: "Notice",
    nl_filter_award: "Award",
    nl_filter_open_rfp: "Open RFP",
    nl_filter_about_label: "About",
    nl_filter_category_label: "Category",
    nl_filter_min_label: "Value ≥",
    nl_filter_max_label: "Value ≤",
    nl_filter_months: "Due within {n} mo",
    nl_filter_standard_only: "Standard methods only",
    clear_filters_btn: "Clear filters",
    property_asset_label: "Asset",
    property_stage_label: "Stage",
    nl_edit_btn:      "Edit search",
    nl_no_matches_note: "No matches for this search.",
    deeplink_watch_context_label: "Matched by your watch:",
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
    open_notice_btn:        "Open notice",
    city_record_link:       "City Record",
    copy_link_btn:          "Copy link",
    map_link:               "Map",
    still_standing_btn:     "Still standing?",

    // Footer
    footer_lede:       "CityScroll searches the City Record Open Data",
    footer_about:      "About",
    footer_feedback:   "Feedback",
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
    one_result: "1 result",

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
    open_nycha_isupplier: "Open iSupplier",
    search_passport_rfx: "Find RFx in PASSPort",
    open_notice_submission_portal: "Open submission portal",
    // Legacy key kept for older fixtures; rail no longer uses this as a public punt.
    next_action_response_instructions: "Follow the response steps below",
    next_action_response_guide: "Follow the response steps below",
    open_rfp_package: "Get RFP package",
    bid_guide_heading: "How to respond",
    bid_guide_id_label: "Search ID",
    bid_guide_name_label: "Procurement name",
    bid_guide_status_label: "RFx status",
    bid_guide_due_label: "Due",
    copy_value: "Copy",
    bid_guide_passport_search_step: "Open the RFx list and search the exact EPIN or procurement name shown above. PASSPort does not publish a stable link to one RFx.",
    bid_guide_passport_released_step: "This RFx is Released, the PASSPort status that accepts responses after sign-in.",
    bid_guide_passport_not_released_step: "Status is {status}, not Released. Browse it for context, but do not assume PASSPort is accepting responses.",
    bid_guide_passport_unmatched_step: "CityScroll could not match this notice to the public RFx list. Try both search terms and verify the result against the official notice.",
    bid_guide_passport_submit_step: "Sign in to PASSPort, open the matching RFx, acknowledge it, and complete the response there before the deadline.",
    bid_guide_nycha_register_step: "Open the housing authority's iSupplier registration guide and sign in or register. This notice does not use PASSPort.",
    bid_guide_nycha_delay_step: "The notice says profile approval typically takes 24 to 72 hours, so register before the bid deadline.",
    bid_guide_nycha_search_step: "In iSupplier Sourcing, search the RFQ number shown above and confirm the title.",
    bid_guide_nycha_submit_step: "Upload the complete bid in iSupplier before the deadline. The notice says the housing authority will not accept it by email, fax, mail, or hard copy.",
    bid_guide_named_portal_open_step: "Open {system} using the link published in this notice.",
    bid_guide_named_portal_search_step: "Search the ID or procurement name shown above and confirm that the title matches.",
    bid_guide_named_portal_submit_step: "Complete the response in that system before the deadline.",
    // Steps extracted from this notice's own fields/body (never "see the official notice").
    bid_guide_notice_due_step: "Respond by {date}.",
    bid_guide_notice_package_step_html: "Get the solicitation package at <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{host}<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    bid_guide_notice_contact_step_html: "Questions and package requests go to {who}.",
    bid_guide_notice_submit_step: "Submit or request materials at: {where}.",
    bid_guide_notice_method_step: "Selection method: {method}.",
    bid_guide_notice_fallback_step: "Use the contact and deadline on this page to request the package and submit before the due date.",
    how_to_respond_heading: "How to respond to this RFP",

    // Alerts / feeds area
    prefer_feeds_html: "Prefer feeds? This watch is also",

    // Notices-in-English
    notices_in_english_note_inline: "Official text in English. Unofficial translation available.",

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
    // A due date in year 2090+ is a pre-qualified-list placeholder, not a real deadline (mirrors
    // the worker's dueLabel()/ROLLING_YEAR) — never show a day-count or the fake date itself.
    rolling_deadline_tag: "no fixed deadline (rolling)",
    days_left_one: "1 day left",
    days_left_other: "{n} days left",

    // Money list + facet
    no_linkable_pin: "no linkable PIN",
    method_facet_label: "Method:",
    narrowed_note: "Full-history search was slow — showing <b>recent editions only</b> (since {date}). Add an agency or keyword to search all years faster.",

    // Money detail / chain / glance / how-to-respond
    copy_link_notice: "Copy notice link",
    share_search_link: "Open shareable search",
    copy_search_link: "Copy search link",
    qr_share_btn: "QR code",
    qr_dialog_title: "Share this view by QR code",
    qr_image_alt: "QR code linking to {url}",
    qr_destination_label: "Destination address",
    qr_download_png: "Download PNG",
    qr_close: "Close",
    save_search_btn: "Save preset",
    saved_check: "✓ Saved",
    saved_searches_heading: "Saved searches",
    remove_saved_search_aria: "Remove saved search: {label}",
    pin_btn: "Pin",
    pinned_open_inv: "✓ Pinned — open investigation ({n})",
    total_awarded_lbl: "total awarded,<br>on record",
    awards_published_lbl: "contract awards<br>published",
    agency_awards_unavailable_note_html: "No contract awards from this agency appear in the City Record — some agencies publish awards elsewhere. <a href=\"about.html#external-awards-sources\">See what we checked</a>.",
    agency_awards_elsewhere_note: "This agency files its contract awards with {source}, not the City Record.",
    agency_awards_none_open_data_html: "The city does not publish this agency's awards in an open dataset — they would appear in NYS Authorities Budget Office filings or Checkbook NYC if released. <a href=\"about.html#external-awards-sources\">See what we checked</a>.",
    external_awards_heading: "Awards published elsewhere",
    external_awards_abo_source: "NYS Authorities Budget Office",
    external_awards_checkbook_source: "Checkbook NYC",
    external_awards_abo_note: "Official annual filing, separate from the City Record. The source may lag by a year.",
    external_awards_possible_note: "Possible awards, matched by vendor and award date — not a confirmed City Record match.",
    external_awards_updated: "Source updated {date}.",
    external_award_none_note_html: "Not yet shown here — matching awards live in {source}.",
    external_award_nycha_none_note_html: "Not yet shown here — Housing Authority registrations live in {link}.",
    external_award_nycha_note_html: "{link} award matched by exact PIN <code>{pin}</code> and a contract date after this solicitation.",
    agency_identity_heading: "Joined from NYC Open Data",
    agency_identity_led_by: "Led by",
    agency_identity_reports_to: "Reports to",
    agency_identity_org_type: "Type",
    agency_identity_budget: "Adopted budget, FY{fy}",
    agency_identity_budget_code: "Budget code",
    agency_identity_website_label: "Website",
    agency_identity_website_link: "Official agency website",
    agency_identity_source_roster: "NYC Agencies and Governance Organizations",
    agency_identity_source_budget: "Expense Budget",
    agency_identity_provenance_html: "Joined from NYC Open Data: {roster} and {budget}. Static snapshot as of {date}.",
    entity_intel_heading: "Across CityScroll domains",
    entity_intel_lead: "Everything linked to {name} from published sources — not siloed lists.",
    entity_intel_coverage: "{matched} of {total} domains have linked objects.",
    entity_intel_domain_money: "Money",
    entity_intel_domain_land: "Land",
    entity_intel_domain_property: "Property",
    entity_intel_domain_rules: "Rules",
    entity_intel_domain_meetings: "Meetings",
    entity_intel_domain_people: "People",
    entity_intel_status_matched: "Linked",
    entity_intel_status_empty: "None in this corpus",
    entity_intel_status_not_yet: "Not yet shown here",
    entity_intel_method_note: "Each link names its source record. Domains with no matching records appear empty.",
    award_watch_offer_btn: "Watch award",
    award_watch_pick_notice_html: "Open a specific notice and use its “Email me when the award registers” button — this option only works from there.",
    award_watch_preview_note_html: "No preview to show yet — you'll get one email automatically once the award for “{label}” registers.",
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
    notice_attachment_chip_one: "{n} attachment: {title}",
    notice_attachment_chip_other: "{n} attachments: {title}",
    notice_attachment_title_fallback: "Official notice file",
    notice_attachment_extract_summary: "Read attachment text",
    notice_attachment_tables_summary: "View attachment tables",
    notice_attachment_table_caption: "Table {n}",
    notice_attachment_related_heading: "Related by attachment content",
    notice_attachment_related_lead: "Other notices that share themes with the official file text — not just shared keywords.",
    digest_match_attachment_html: "Matched in attachment: {snippet}",
    // Accessible marking for the City Record/PASSPort/Checkbook NYC new-tab carve-out
    // (test/standards/link_targets.py). Appended as visually-hidden text inside the link.
    ext_link_new_tab_sr: "(opens in new tab)",
    pin_unusable_note: "This notice's PIN isn't usable for linking (<code>{pin}</code>), so its award can't be traced automatically. Open it in the City Record to read the full text.",
    only_notice_note: "Only this notice is on record so far — no later stage has been published for PIN <code>{pin}</code> yet. ",
    award_pending_note: "The award may still be pending.",
    blanket_note: "PIN <code>{pin}</code> is a <b>blanket code</b>: it bundles {n} separate awards (common for emergency declarations). They are grouped below — expand a pool to see each vendor and City Record notice.",
    // Paper trail phase-group (rank-3 ruthless inspection): notice-type phases + same-day
    // aggregates + one default City Record link — see site/paper_trail_phase.mjs + chainHTML().
    paper_trail_now_label: "Where this PIN is now",
    paper_trail_next_html: "Next stage in the process: <strong>{phase}</strong>",
    paper_trail_phase_current: "Current",
    paper_trail_phase_done: "Earlier",
    paper_trail_phase_future: "Not yet on this PIN",
    paper_trail_phase_empty: "No notices in this stage yet",
    paper_trail_phase_solicitation: "Solicitation",
    paper_trail_phase_selection: "Selection",
    paper_trail_phase_award: "Award",
    paper_trail_notices_count_one: "{n} notice",
    paper_trail_notices_count_other: "{n} notices",
    paper_trail_aggregate_range: "{first} → {last}",
    paper_trail_show_notices: "Show {n} notices",
    paper_trail_hide_notices: "Hide notices",
    paper_trail_show_all: "Show all notices",
    paper_trail_show_history: "Earlier stages",
    paper_trail_how_summary: "Explain paper trail",
    paper_trail_how_html: "Notices that share this PIN are grouped by the city procurement process — solicitation, selection (intent to negotiate, vendor list, intent to award), and award. Same-day awards under a blanket code are pooled with a count and vendor total. Expand a pool for every vendor and City Record link. One link above opens the notice you are viewing. The full payment timeline is a separate link when the PIN is usable.",
    paper_trail_open_notice: "This notice in City Record",
    paper_trail_open_on_site: "Open notice",
    paper_trail_pool_title: "{type} pool",
    paper_trail_vendors_count: "{n} vendors",
    paper_trail_since: "since {date}",
    paper_trail_action_respond: "Respond — deadline, contact, and package steps are in What can I do now? above.",
    paper_trail_action_review_selection: "Review the selection notices on this PIN (intent to negotiate, vendor list, or intent to award).",
    paper_trail_action_track_award: "Track this award — open the full timeline with payments, or expand stages below for every City Record notice.",
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
    rule_adoption_estimate_window: "Estimated adoption window {p10} – {p90} (median {p50})",
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
    near_match_reveal_btn: "Find possible matches",
    near_match_heading: "Possible earlier rounds",
    near_match_tag: "Maybe",
    near_match_why_lbl: "Why we're showing this:",
    near_match_reason_agency: "same agency",
    near_match_reason_title_html: "shares title words: {words}",
    near_match_reason_pin_html: "PIN prefix similar to {prefix}",
    near_match_reason_amount_html: "comparable amount ({a} vs {b})",
    near_match_caveat_note: "Possible historical matches. Each shares some traits with this notice. Check the dates, vendor, and PIN before relying on it.",
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
    call_btn: "Call",
    apply_pnote_html: "<b>Email a response</b> opens a pre-filled letter of intent to the listed contact — edit before sending. Use the system-specific guide above for the actual submission. Nothing leaves your device until you hit send.",
    apply_pnote_no_email_html: "This notice lists no direct contact — use the system-specific guide above, or the submission address if one is listed.",

    // Contract lifecycle timeline (PROC-001): compact horizontal timeline on notice detail
    // showing solicitation/award → pending → registered → payment, consuming the precomputed
    // read model from GET /contract-lifecycle. Unmatched/unknown/ambiguous stages render as
    // specific statements, never blank.
    lifecycle_heading: "Contract lifecycle",
    lifecycle_stage_solicitation: "Solicitation",
    lifecycle_stage_intent_to_negotiate: "Intent to negotiate",
    lifecycle_stage_vendor_list: "Vendor list",
    lifecycle_stage_intent_to_award: "Intent to award",
    lifecycle_stage_award: "Award",
    lifecycle_stage_pending: "Pending contract",
    lifecycle_stage_registered: "Registered contract",
    lifecycle_stage_payment: "Payments",
    lifecycle_amended_from_html: "amended from {original}",
    lifecycle_payments_count_one: "{n} payment",
    lifecycle_payments_count_other: "{n} payments",
    lifecycle_latest_payment_html: "Latest: {amount} on {date}",
    lifecycle_unmatched_pending_html: "Not yet shown here — pending contracts live in {source}.",
    lifecycle_unmatched_registered_html: "Not yet shown here — registered contracts live in {source}.",
    lifecycle_unmatched_payment_html: "Not yet shown here — payments live in {source}.",
    lifecycle_unmatched_generic_html: "Not yet shown here — this lives in {source}.",
    // Operational key kept for non-public tooling; notice-detail never renders it (precompute-first).
    lifecycle_unknown_html: "Could not reach {source} to check this step.",
    lifecycle_ambiguous_html: "Multiple contracts found — cannot tell which one applies.",
    // Stage succession: earlier stages when a later stage is already on record.
    lifecycle_passed_pending_html: "Passed — the contract has registered.",
    lifecycle_passed_registered_html: "Passed — payments are on record.",
    lifecycle_passed_generic_html: "Passed — a later stage is on record.",
    lifecycle_paid_to_date_html: "Paid to date: {amount}",
    // Payments card summary when Checkbook join exists (detail lives in Follow the dollars).
    lifecycle_payment_summary_html: "{paid} paid of {committed} committed",
    lifecycle_payment_zero_lag_html: "Payments lag invoicing — $0 paid on a freshly registered contract is normal.",
    // Term ended with underrun: committed is a registration ceiling, not a remaining bill
    // (field case #notice/20230728114 — 57% of ceiling is complete Checkbook data).
    lifecycle_committed_ceiling_note_html: "Committed is a registration ceiling, not a remaining balance due — human-services contracts often close below the registered amount.",
    // Human Services award → registration dwell strip (precomputed; payment-honesty framing).
    // Never invent dwell for unknown — unknown is a quiet line, never "0 days" / instant.
    award_reg_dwell_after_html: "Registered {days} days after the award notice ({award} → {registration}).",
    award_reg_dwell_before_html: "Registered {days} days before the City Record award notice (PASSPort {registration} · award notice {award}).",
    award_reg_dwell_same_day_html: "Registered the same day as the award notice ({award}).",
    award_reg_dwell_unknown_html: "PASSPort registration date not matched for this award.",
    award_reg_dwell_payment_frame_html: "Registration starts the payment clock — $0 paid right after registration is normal. Spending often lags invoicing.",
    award_reg_dwell_aria: "Award to registration dwell",
    // Three-state honesty: spending feed error must not look like verified $0.
    lifecycle_payment_unavailable_html: "Payment data unavailable right now — Checkbook spending could not be checked.",
    lifecycle_dollars_paid_unavailable_html: "Unavailable right now",
    lifecycle_payment_details_link_html: "<a href=\"{href}\">Follow the dollars</a> for detail.",
    // Inline context/flags methodology (stays on the notice; full page is optional).
    context_strip_lbl: "Context",
    context_how_computed_summary: "How computed",
    context_how_computed_body_html: "These figures compare this award to other awards from the same agency in the last 12 months. We use the exact names as published. We do not merge name variants here. A large share is context, not a finding of wrongdoing.",
    context_flags_summary: "What flags mean",
    context_flags_body_html: "Flags mark patterns worth a closer look — short ad windows, non-competitive methods, or many recent awards to one vendor. They are statistical context, not findings of blame.",
    context_full_methodology_link: "Full methodology",
    lifecycle_source_city_record: "City Record",
    lifecycle_source_checkbook: "Checkbook NYC",
    lifecycle_source_passport: "PASSPort Public",
    // Distinct Checkbook datasets for gap copy (source coherence with page joins).
    lifecycle_source_checkbook_pending: "Checkbook NYC pending contracts",
    lifecycle_source_checkbook_registered: "Checkbook NYC registered contracts",
    lifecycle_source_checkbook_spending: "Checkbook NYC spending",
    lifecycle_source_current_solicitations: "Current Solicitations (Open Data)",
    lifecycle_source_city_record_getfile: "City Record file attachments",
    lifecycle_unmatched_documents_html: "Not yet shown here — solicitation package details live in {source}.",
    // Short honest class-(b) caveat — one line, one GetFile pointer (not a multi-clause hedge).
    lifecycle_documents_not_published_html: "The city does not publish package documents as an open feed — see {where}.",
    lifecycle_unmatched_solicitation_html: "Not yet shown here — the solicitation package lives in {source}.",
    lifecycle_documents_count_one: "{n} package document",
    lifecycle_documents_count_other: "{n} package documents",
    lifecycle_document_link: "Document {n}",
    lifecycle_due_html: "Responses due {date}",
    lifecycle_source_ocp: "Recent Contract Awards (OCP)",
    lifecycle_ocp_heading: "OCP award record",
    lifecycle_ocp_matched_html: "Joined from {source}: {vendor} · {amount} on {date}.",
    lifecycle_ocp_corroborated_html: "City Record and {source} agree on award date and amount.",
    lifecycle_ocp_disagreement_html: "City Record and {source} disagree. Each value stays a source assertion. CityScroll records an unresolved interpretation and does not derive a winning amount or date.",
    lifecycle_ocp_amount_pair_html: "Amount — source assertion {city_record_label}: {city_amount} · source assertion {ocp_label}: {ocp_amount}.",
    lifecycle_ocp_date_pair_html: "Date — source assertion {city_record_label}: {city_date} · source assertion {ocp_label}: {ocp_date}.",
    lifecycle_ocp_interpretation_html: "CityScroll interpretation: different {field} values. Resolution unresolved (no derived conclusion).",
    lifecycle_ocp_unmatched_html: "Not yet shown here — recent OCP awards live in {source}.",
    lifecycle_ocp_unknown_html: "Could not reach {source} to check this award.",
    lifecycle_ocp_ambiguous_html: "Multiple OCP award rows matched — cannot auto-pick one.",
    lifecycle_how_summary: "Explain timeline",
    // Phase-grouped procurement timeline (Solicitation → Selection → Award and registration → Payments)
    lifecycle_phase_solicitation: "Solicitation",
    lifecycle_phase_selection: "Selection",
    lifecycle_phase_award_registration: "Award and registration",
    lifecycle_phase_payments: "Payments",
    lifecycle_phase_now_label: "Now",
    lifecycle_phase_next_html: "Next: <strong>{phase}</strong>",
    lifecycle_phase_current: "Current",
    lifecycle_phase_done: "Done",
    lifecycle_phase_future: "Upcoming",
    lifecycle_phase_empty: "No milestones in this phase yet",
    lifecycle_phase_milestones_count: "{n} milestones",
    lifecycle_phase_action_respond: "Respond to this solicitation — deadline, contact, and package steps are above.",
    lifecycle_phase_action_review_selection: "Review intermediate City Record notices (intent to negotiate, vendor list, intent to award).",
    lifecycle_phase_action_track_award: "Track the award and Checkbook registration for this PIN.",
    lifecycle_phase_action_follow_money: "<a href=\"{href}\">Follow the dollars</a> for paid-to-date and payment history.",
    lifecycle_phase_show_history: "Earlier phases",
    lifecycle_phase_since: "since {date}",
    lifecycle_phase_aggregate_range: "{first} → {last}",
    lifecycle_provenance_note_html: "This timeline joins {city_record} notices to {checkbook} registrations and payments, and to {passport} pending contracts and RFx when EPIN joins the PIN {pin}.",
    lifecycle_no_pin_note_html: "The city does not publish a Procurement ID (PIN) on this notice — registration and payments would appear in Checkbook NYC if released with a PIN.",
    lifecycle_rfx_heading: "PASSPort solicitation (RFx)",
    lifecycle_rfx_due_html: "Due {date}",
    lifecycle_rfx_status_html: "Status: {status}",
    lifecycle_rfx_method_html: "Method: {method}",
    lifecycle_rfx_unmatched_html: "Not yet shown here — solicitation detail lives in {source}.",
    lifecycle_amendment_note_html: "Budget changed: {original} became {current} (a difference of {delta}).",
    // Registration/payment panel drawn from the precomputed lifecycle (not a live Checkbook call).
    lifecycle_dollars_heading: "Follow the dollars — Checkbook NYC",
    lifecycle_dollars_contract_lbl: "Contract",
    lifecycle_dollars_registered_on_html: "registered {date}",
    lifecycle_dollars_committed_lbl: "Committed",
    lifecycle_dollars_paid_lbl: "Paid to date",
    lifecycle_dollars_term_lbl: "Term",
    lifecycle_dollars_mwbe_lbl: "Minority/Women-Owned Business Enterprise (M/WBE)",
    lifecycle_dollars_vendor_mismatch_html: "⚠ Checkbook's vendor (<b>{checkbook}</b>) differs from the notice's (<b>{notice}</b>) — a PIN can cover multiple awards. Treat with care.",
    lifecycle_dollars_vendor_variant_html: "Same vendor as the notice (<b>{notice}</b>). Checkbook shows the name as <b>{checkbook}</b>.",
    lifecycle_dollars_payments_html: "{count}. {latest}",
    lifecycle_dollars_provenance_html: "From the contract lifecycle join to {link}, matched by PIN {pin}.",
    // Solicitation M/WBE / method chips + award sub-outreach (payload surface for §6-129 / NCSP / goal join)
    mwbe_chip_goal_percent: "M/WBE goal {pct}%",
    mwbe_chip_section_6_129: "§6-129 M/WBE goals",
    mwbe_chip_ncsp: "M/WBE small purchase",
    mwbe_chip_accelerated: "Accelerated",
    mwbe_chip_floor_calendar: "{days}-day response floor",
    mwbe_chip_floor_business: "{days} business-day response floor",
    mwbe_sol_heading: "M/WBE and response rules",
    mwbe_sol_persona_html: "Method and participation markers taken from this City Record solicitation — Admin Code §6-129 goals, M/WBE Noncompetitive Small Purchase, accelerated procurement, and the advertising response floor that applies.",
    mwbe_sol_floor_lbl: "Response floor",
    mwbe_sol_floor_cite_html: "Rule source: {cite}",
    mwbe_sol_goal_lbl: "Participation goal",
    mwbe_sol_goal_pct_html: "{pct}% M/WBE (Admin Code §6-129)",
    mwbe_sol_goal_cite_only_html: "Subject to Admin Code §6-129 participation goals (no numeric goal line in this notice).",
    mwbe_sol_provenance_html: "Extracted from labeled language in the City Record notice (and the published selection method when present). City Record Online remains authoritative.",
    mwbe_sub_heading: "Possible subcontract window",
    mwbe_sub_lead_html: "A prime vendor is named on this award. Subcontract opportunities may still be open — check the prime and agency contacts. This is not a published remaining-goal figure.",
    mwbe_sub_prime_lbl: "Prime vendor",
    mwbe_sub_agency_lbl: "Agency",
    mwbe_sub_dollars_lbl: "Award amount",
    mwbe_sub_industry_lbl: "Industry",
    mwbe_sub_prime_mwbe_lbl: "Prime M/WBE category",
    mwbe_sub_goal_lbl: "Subcontract M/WBE goal",
    mwbe_sub_goal_present_html: "{pct}% subcontract participation goal",
    mwbe_sub_goal_not_published_html: "The city does not publish a joinable M/WBE subcontract goal percentage next to awards — it would appear in {where} if released as open data keyed by PIN or contract id.",
    mwbe_sub_goal_where_default: "agency or Comptroller subcontract-utilization reports",
    mwbe_sub_includes_subs_html: "Checkbook notes that this contract includes sub-vendors (not a goal percentage).",
    mwbe_sub_provenance_html: "Prime, agency, dollars, and industry come from the award notice and joined public records. Subcontract goal capacity appears only when a public source publishes it — this page does not fill in a missing figure.",
    matter_spine_note: "The spine is every City Record notice sharing this PIN, in order. Checkbook events join deterministically on the same PIN via the contract lifecycle. Public-hearing notices rarely carry PINs, so hearings may be missing from the chronology.",
    matter_loading: "Assembling the matter: PIN {pin}…",
    matter_empty: "No City Record notices carry PIN <code>{pin}</code>.",
    matter_heading_html: "Matter timeline · PIN {pin}",
    matter_latest_city_record: "Open latest notice",
    matter_open_checkbook: "Open in Checkbook NYC",
    matter_today: "today",
    matter_renewal_linked: "PIN {pin} (renewal-linked)",
    matter_responses_due: "responses due {date}",
    matter_phase_of: "of",
    matter_phase_heading: "Matter timeline",
    matter_phase_solicitation: "Solicitation",
    matter_phase_selection: "Selection",
    matter_phase_award_registration: "Award and registration",
    matter_phase_payments: "Payments",
    matter_phase_now_label: "Where this matter is now",
    matter_phase_next_html: "<strong>What’s next:</strong> {phase}",
    matter_phase_current: "Current",
    matter_phase_done: "Done",
    matter_phase_future: "Not started",
    matter_phase_empty: "No milestones in this phase yet",
    matter_phase_milestones_count: "{n} milestones",
    matter_phase_action_respond: "Open the latest solicitation notice for deadline and response steps.",
    matter_phase_action_respond_html: "Open the <a href=\"{href}\">latest solicitation notice</a> for deadline and response steps.",
    matter_phase_action_review_selection: "Review intermediate City Record notices (intent to negotiate, vendor list, intent to award).",
    matter_phase_action_track_award: "Track the award and Checkbook registration for this PIN.",
    matter_phase_action_track_award_html: "Open the <a href=\"{href}\">latest award notice</a> and track Checkbook registration for this PIN.",
    matter_phase_action_follow_money: "Follow the dollars on {link} for paid-to-date and payment history.",
    matter_phase_show_history: "Earlier phases",
    matter_phase_since: "since {date}",
    matter_phase_aggregate_range: "{first} → {last}",
    matter_phase_show_dates: "Show {n} dates",
    matter_phase_hide_dates: "Hide dates",
    matter_phase_show_all: "Show all dates",
    matter_phase_how_summary: "Explain timeline",
    matter_phase_how_html: "Phases follow the city’s procurement path: solicitation, selection (intent to negotiate, vendor list, intent to award), award and registration, then payments. Notices that share this PIN are grouped by phase. Identical titles show as a count with a date range — every individual date stays under “Show dates.” One City Record link and one Checkbook link appear in the actions. Repeated portal URLs are not listed on every row.",

    // Vendor profile “On the record” phase spine (award → registration → payments)
    vendor_on_the_record: "On the record — notices naming this vendor",
    vendor_agencies_heading: "Agencies they win from (click to pivot)",
    vendor_mentions_heading: "View other mentions",
    vendor_follow_btn: "Follow this vendor",
    agency_follow_btn: "Follow agency",
    agency_watch_rules_btn: "Watch rules",
    agency_watch_meetings_btn: "Watch meetings",
    vendor_identity_note_html: "Identity is resolved by name normalization (case, punctuation, legal suffixes) — variants listed above. Distinct companies sharing a name stem would be merged, so treat totals as <b>“published under this name,”</b> not a legal entity. Awards are as published in the City Record. Registered contracts and payments live on {source}. The timeline lead carries one search for this vendor name, not a link on every award.",
    vendor_phase_heading: "Vendor procurement timeline",
    vendor_phase_award: "Award",
    vendor_phase_registration: "Registration",
    vendor_phase_payments: "Payments",
    vendor_phase_now_label: "Where this vendor is on the record",
    vendor_phase_next_html: "<strong>What’s next:</strong> {phase}",
    vendor_phase_current: "Current",
    vendor_phase_done: "Done",
    vendor_phase_future: "Not started",
    vendor_phase_empty: "No milestones in this phase yet",
    vendor_phase_milestones_count: "{n} notices",
    vendor_phase_year_cycle: "{year} · {n} notices",
    vendor_phase_lead_awards: "{n} recent award notices",
    vendor_phase_action_review_awards: "Open the latest award notice naming this vendor.",
    vendor_phase_action_review_awards_html: "Open the <a href=\"{href}\">latest award notice</a> naming this vendor.",
    vendor_phase_action_track_registration: "Track registered contracts for this vendor on {link}.",
    vendor_phase_action_follow_money: "Follow payments for this vendor on {link}.",
    vendor_phase_action_checkbook_once: "Registered contracts and payments: {link}.",
    vendor_phase_show_history: "Earlier phases",
    vendor_phase_since: "since {date}",
    vendor_phase_aggregate_range: "{first} → {last}",
    vendor_phase_show_dates: "Show {n} dates",
    vendor_phase_hide_dates: "Hide dates",
    vendor_phase_show_all: "Show all dates",
    vendor_phase_how_summary: "Explain timeline",
    vendor_phase_how_html: "Phases follow the city’s vendor-facing procurement path: award notices in the City Record, then registration and payments on Checkbook NYC. Recent notices are grouped by phase and by year. Every individual notice stays under “Show dates.” One Checkbook search for this vendor name appears in the lead. Repeated Checkbook URLs are not listed on every award row. Registration and payment rows are not yet joined onto this profile.",
    vendor_phase_future_gap_html: "Registration and payments are not yet shown here — they live in Checkbook NYC when published under this vendor name.",

    // NYCIDA/Build NYC subsidy lifecycle on notice detail (SUB-001)
    subsidy_lifecycle_heading: "Subsidy lifecycle",
    subsidy_stage_application: "Application",
    subsidy_stage_hearing: "Hearing",
    subsidy_stage_board_decision: "Board decision",
    subsidy_stage_closing: "Closing",
    subsidy_stage_compliance: "Compliance",
    subsidy_action_html: "Official action: {action}",
    subsidy_outcome_html: "Outcome: {outcome}",
    subsidy_outcome_unknown_html: "The city does not publish this outcome — it would appear on the Build NYC project documents if released.",
    subsidy_stage_unmatched_html: "Not yet shown here — {stage} records live in {source}.",
    // Age-aware gaps: too_soon vs not_published vs unavailable (fetch). Temporal sibling of
    // paid / verified_zero / unavailable on the Checkbook payment path.
    subsidy_stage_too_soon_html: "Hearing was {date} — {stage} records typically appear within about {weeks} weeks. Check back. Too recent to treat as a permanent gap.",
    subsidy_stage_not_published_html: "The city does not publish this {stage} record on {source} — it would appear there if released.",
    subsidy_join_too_soon_html: "Hearing was {date} — IDA project records for “{title}” usually appear within about {weeks} weeks of the hearing. Check back. Too recent to treat as a permanent gap.",
    subsidy_source_build_nyc: "Build NYC and NYC Industrial Development Agency",
    subsidy_source_unavailable_html: "Could not reach {source} to check the subsidy timeline for this notice.",
    subsidy_unmatched_html: "The city does not publish a linked subsidy project for “{title}” — {reason}",
    subsidy_unmatched_default_reason: "it would appear on the Build NYC and NYC Industrial Development Agency document page if released.",
    subsidy_matched_html: "Linked project: <b lang=\"en\" dir=\"ltr\">{project}</b> · company <b lang=\"en\" dir=\"ltr\">{company}</b> · stage {stage}.",
    subsidy_company_unknown_html: "The city does not publish a company name on this Build NYC record — it would appear there if released.",
    subsidy_place_unknown_html: "The city does not publish a project address or BBL on this Build NYC record — it would appear there if released.",
    subsidy_money_unknown_html: "The city does not publish this {field} on the Build NYC record — it would appear there if released.",
    // Class (a): structured Build NYC fields exist publicly but this path only has the City Record
    // hearing (feed unreachable / not joined). Do not claim the city withheld the figure.
    subsidy_company_not_yet_ingested_html: "Not yet shown here — company names live in {source}.",
    subsidy_place_not_yet_ingested_html: "Not yet shown here — project addresses and BBLs live in {source}.",
    subsidy_money_not_yet_ingested_html: "Not yet shown here — {field} figures live in {source}.",
    subsidy_feed_unavailable_html: "Could not reach {source} for the full subsidy project record — hearing details below are from the City Record notice.",
    subsidy_money_matched_html: "{field}: <b>{amount}</b>.",
    subsidy_money_matched_city_record_html: "{field}: <b>{amount}</b> (from the City Record hearing notice).",
    subsidy_place_matched_html: "Place: <b>{address}</b>.",
    subsidy_money_requested_lbl: "requested benefit",
    subsidy_money_estimated_lbl: "estimated public cost",
    subsidy_money_total_project_cost_lbl: "total project cost",
    subsidy_money_total_development_cost_lbl: "total development cost",
    subsidy_provenance_note_html: "Stages join City Record notices to {source} project records when a public match exists.",
    // Phase-group chrome (Money-collapse): current lead + not-yet-reached aggregate
    subsidy_phase_now_label: "Now",
    subsidy_phase_next_html: "Next: <strong>{phase}</strong>",
    subsidy_phase_current: "Current",
    subsidy_phase_done: "Done",
    subsidy_phase_future: "Upcoming",
    subsidy_phase_empty: "No milestones in this stage yet",
    subsidy_phase_milestones_count: "{n} milestones",
    subsidy_phase_since: "since {date}",
    subsidy_phase_aggregate_range: "{first} → {last}",
    subsidy_phase_show_history: "Earlier stages",
    subsidy_phase_show_future_gaps: "View later stages",
    subsidy_phase_show_fields: "View project fields",
    subsidy_phase_how_summary: "Explain timeline",
    subsidy_phase_and: "and",
    subsidy_phase_not_yet_reached_html: "Not yet reached: {stages}.",
    subsidy_phase_action_application: "Review the application filing and linked City Record notice.",
    subsidy_phase_action_hearing: "Attend or track the public hearing — testimony steps are on this notice when published.",
    subsidy_phase_action_board: "Watch for the board decision on Build NYC and NYC Industrial Development Agency project documents.",
    subsidy_phase_action_closing: "Watch for closing documents on the Build NYC project record.",
    subsidy_phase_action_compliance: "Watch for post-closing compliance filings on the Build NYC project record.",

    // Council meeting outcomes on notice detail (MEET-001)
    meeting_outcomes_heading: "Council meeting outcomes",
    meeting_outcomes_heading_non_council: "Hearing outcomes",
    meeting_outcomes_matched_html: "Matched Council event: <b lang=\"en\" dir=\"ltr\">{event}</b> ({date}).",
    meeting_outcomes_unmatched_html: "Not yet shown here — Council outcomes live in NYC Council Legistar. {reason}",
    meeting_outcomes_unmatched_default: "No match for this City Record notice on the hearing date and committee name.",
    meeting_outcomes_non_council_not_published_html: "The city does not publish votes for this hearing. They would appear on {where} if released as open data.",
    meeting_outcomes_non_council_where: "borough president websites and community board minutes pages",
    // Non-Council hearing process spine (notice → hearing → outcome → minutes)
    non_council_stage_notice_published: "Notice published",
    non_council_stage_hearing: "Hearing",
    non_council_stage_outcome: "Outcome / votes",
    non_council_stage_minutes: "Minutes",
    non_council_stage_not_yet_ingested_html: "Not yet shown here — this stage lives in {source}.",
    non_council_spine_join_html: "Hearing process for {title} ({agency}).",
    non_council_spine_provenance_html: "Timeline reconstructs this non-Council hearing from its City Record notice. Notice and hearing dates come from City Record. Votes and minutes are not published as a citywide open-data feed — links point to borough president and community board pages where those records appear when released.",
    non_council_source_city_record: "City Record Online",
    meeting_outcomes_agenda_lbl: "Agenda item",
    meeting_outcomes_matter_lbl: "Council matter",
    meeting_outcomes_action_lbl: "Action",
    meeting_outcomes_vote_lbl: "Vote",
    meeting_outcomes_outcome_lbl: "Outcome",
    meeting_outcomes_attachments_lbl: "Attachments",
    meeting_outcomes_vote_html: "Vote: {result} (aye {aye} · nay {nay})",
    meeting_outcomes_roll_call_lbl: "Roll call",
    meeting_outcomes_roll_call_chip_html: "{n} named votes — {names}",
    meeting_outcomes_roll_call_more: "+{n} more",
    meeting_outcomes_roll_call_member_col: "Member",
    meeting_outcomes_roll_call_vote_col: "Vote",
    meeting_outcomes_vote_person_html: "{name} ({vote})",
    // Official person page (#official/{id}) — precomputed recent votes + optional hearing scope
    official_page_kicker: "Council member",
    official_skim_kicker: "Council member · this hearing",
    official_loading: "Loading votes…",
    official_missing_id_html: "No official id in this link.",
    official_need_notice_html: "Open a Council hearing with a roll call, then choose a member name to see how they voted on that hearing’s matters.",
    official_event_scoped_note: "Votes shown are for this hearing only — not a full voting history.",
    official_event_line_html: "Hearing: {event} · Legistar event {id} · {date}",
    official_event_fallback: "City Council hearing",
    official_votes_heading: "How this member voted on this hearing’s matters",
    official_recent_votes_heading: "Recent votes across matters",
    official_all_votes_heading: "Recent roll-call votes",
    official_recent_lead_html: "{n} named Council roll-call votes shown here from published Legistar records.",
    official_no_votes_html: "No person-level roll-call votes for {name} are published for this hearing.",
    official_no_recent_html: "No named roll-call votes for {name} are shown yet.",
    official_load_error_html: "Could not load meeting outcomes for this hearing. Try again from the notice.",
    official_open_hearing: "Open hearing notice",
    official_city_council_profile: "City Council profile",
    official_provenance_html: "Person-level votes come from NYC Council Legistar records linked to this hearing.",
    official_votes_table_caption: "Person-level roll-call votes",
    official_vote_matter_col: "Matter",
    official_vote_hearing_col: "Hearing",
    official_vote_vote_col: "Vote",
    meeting_outcomes_outcome_html: "Outcome: {outcome}",
    meeting_outcomes_no_votes_html: "Not yet shown here — roll-call votes for matter “{matter}” live in NYC Council Legistar.",
    // Class-(a): tallies may be present while person-level rows are not yet in the read model.
    meeting_outcomes_no_person_votes_html: "Not yet shown here — person-level roll-call votes live in NYC Council Legistar.",
    meeting_outcomes_no_matters_html: "Not yet shown here — agenda items and matters live in NYC Council Legistar.",
    meeting_outcomes_no_action_html: "Not yet shown here — the committee action for this matter lives in NYC Council Legistar.",
    meeting_outcomes_no_attachments_html: "Not yet shown here — supporting attachments live in NYC Council Legistar.",
    meeting_outcomes_document_lbl: "Document",
    meeting_outcomes_agenda_text_lbl: "Agenda text",
    meeting_outcomes_chip_other: "other",
    meeting_outcomes_chip_procedural_hidden: "procedural rows hidden",
    meeting_outcomes_matter_title_lbl: "Matter title",
    meeting_outcomes_chip_actions_collapsed: "actions collapsed",
    meeting_outcomes_badge_referred: "Referred",
    meeting_outcomes_badge_approved: "Approved",
    meeting_outcomes_final_outcome_lbl: "Final outcome",
    meeting_outcomes_badge_held: "Held",
    meeting_outcomes_chip_referred: "referred",
    meeting_outcomes_badge_other: "Other",
    meeting_outcomes_chip_approved: "approved",
    meeting_outcomes_details_summary: "Actions, full title, and vote",
    meeting_outcomes_chip_matters: "matters",
    meeting_outcomes_chip_held: "held / deferred",
    meeting_outcomes_action_history_lbl: "Action history",
    meeting_outcomes_summary_lbl: "Outcome summary",
    meeting_outcomes_docs_lbl: "Meeting documents",
    meeting_outcomes_provenance_html: "Outcomes join City Record hearing notices to NYC Council Legistar events, agenda items, matters, and votes.",
    meeting_outcomes_details_summary_phase: "Full title, action history, and attachments",
    // Council matter phase-group (agenda → matter → decision → record) over spines[]
    meeting_phase_agenda: "Agenda",
    meeting_phase_matter: "Matter",
    meeting_phase_decision: "Decision",
    meeting_phase_record: "Record",
    meeting_phase_now_label: "Now",
    meeting_phase_next_html: "Next: <strong>{phase}</strong>",
    meeting_phase_current: "Current",
    meeting_phase_done: "Done",
    meeting_phase_future: "Upcoming",
    meeting_phase_empty: "No milestones in this phase yet",
    meeting_phase_docs_count: "{n} documents",
    meeting_phase_show_history: "Earlier phases",
    meeting_phase_timeline_lbl: "Matter lifecycle",
    meeting_phase_open_legislation: "Open legislation",
    meeting_phase_action_agenda: "Review the agenda item for this matter.",
    meeting_phase_action_matter: "Open the Council matter file on Legistar.",
    meeting_phase_action_decision: "Review the committee action and any roll-call tally.",
    meeting_phase_action_record: "Open supporting attachments for this matter.",
    meeting_phase_voice_vote_html: "Committee action recorded without a separate roll-call tally (voice or committee vote).",
    meeting_phase_gap_agenda_html: "Not yet shown here — agenda text for this matter lives in {source}.",
    meeting_phase_gap_matter_html: "Not yet shown here — the Council matter file lives in {source}.",
    meeting_phase_source_legistar: "NYC Council Legistar",
    meeting_phase_how_summary: "Explain timeline",
    meeting_phase_how_html: "Each matter follows the Council path: agenda item, matter file, decision (committee action and vote when published), then attachments. Phases use Legistar records for this hearing. Identical document links appear once. An action without named votes is a voice or committee outcome.",
    // Meetings domain explorer (list ontology — process rail + place groups + next-action)
    meetings_domain_kicker: "Public hearings and meetings",
    meetings_domain_heading: "Scheduled, agenda, held, outcomes",
    meetings_domain_deck: "City Record hearing notices follow a meeting arc — scheduled, agenda materials, held, then outcomes — with next steps when the notice publishes how to attend or testify. Same-board same-day notices collapse into one card. Affected place still drives near-me. Venue is shown separately.",
    meetings_process_rail_label: "Meeting stage",
    meetings_process_label: "Stage",
    meetings_process_stepper_aria: "Meeting process stages",
    meetings_chain_notice_count: "{n} notices for this meeting",
    meetings_list_no_agency: "Agency not stated on this notice",
    meetings_entries_announce: "{n} meetings",
    meetings_siblings_label: "Same meeting",
    meetings_action_agency_profile: "Open agency profile",
    meeting_stage_scheduled: "Scheduled",
    meeting_stage_agenda: "Agenda",
    meeting_stage_held: "Held",
    meeting_stage_outcomes: "Outcomes",
    meeting_stage_unstaged: "Unstaged",
    meeting_action_open_notice: "Open notice",
    meeting_action_attend: "Attend hearing",
    meeting_action_attend_dated: "Attend hearing",
    meeting_action_review_agenda: "Review agenda",
    meeting_action_review_held: "Review hearing",
    meeting_action_review_outcomes: "Review outcomes",
    meeting_action_join_online: "Join online",
    meeting_action_open_materials: "Open materials",
    meeting_action_submit_testimony: "Submit testimony",

    land_outcomes_heading: "Land-use outcomes",
    land_spine_heading: "Project timeline",
    land_spine_lag_behind_html: "The NYC Open Data milestone date ({open_date}) trails the live ZAP portal ({portal_date}) by {days} days.",
    land_spine_lag_aligned_html: "NYC Open Data ({open_date}) is at least as current as the live ZAP portal milestone ({portal_date}).",
    land_spine_lag_unknown: "Portal lag cannot be measured because one of the two milestone dates is not published.",
    land_spine_gap_not_yet_ingested_html: "Not yet shown here — dated milestones live in {source}.",
    land_spine_gap_not_published_html: "No City Record notice matching this project's ULURP numbers has been published yet. If one is released, it will appear in {source}.",
    land_spine_gap_unavailable_html: "Could not reach {source} to check for land-use notices.",
    land_spine_planned: "planned",
    land_spine_portal_link: "Full project on ZAP",
    land_spine_now_label: "Where this project is now",
    land_spine_since: "since {date}",
    land_spine_status_noticed_html: "Public status: <b>Noticed</b> — not yet certified into formal ULURP public review.",
    land_spine_status_public_html: "Public status: <b>{status}</b>",
    land_spine_next_html: "<strong>What’s next:</strong> {phase}",
    land_spine_phase_done: "Done",
    land_spine_phase_current: "Current",
    land_spine_phase_future: "Not started",
    land_spine_phase_empty: "No dated milestones yet",
    land_spine_milestones_count: "{n} milestones",
    land_spine_aggregate_range: "{first} → {last}",
    land_spine_planned_window: "Planned {first} → {last}",
    land_spine_planned_window_one: "Planned {date}",
    land_spine_show_dates: "Show {n} dates",
    land_spine_hide_dates: "Hide dates",
    land_spine_show_all: "Show all dates",
    land_spine_how_summary: "Explain timeline",
    land_spine_how_html: "Phases follow the city’s ULURP process: filing, environmental review (CEQR), pre-certification notice, certification, Community Board, Borough President, City Planning Commission, City Council, and mayoral or appeals review. After certification, statutory review windows come from <b>NYC Charter §197-c</b>: Community Board 60 days, Borough President 30, City Planning Commission 60, City Council 50, and Mayor 5 (≤205 days total). Those due dates follow the Charter windows and are labeled on the page — the clock can toll and projects can withdraw — not published agency calendars. Identical re-file milestones are grouped with a count and date range. Every individual date stays under “Show dates.” One link opens the full Zoning Application Portal project.",
    land_spine_statutory_deadline_html: "Statutory deadline: {stage} must conclude within {n} days (City Charter §197-c) — by {date}.",
    land_spine_statutory_due_summary: "Statutory deadline {date}",
    land_spine_statutory_testify_hint: "The hearing before this deadline is usually the last chance to testify.",
    land_spine_statutory_withdrawn_note: "This project was withdrawn — open statutory deadlines are closed.",
    land_zoning_base_rate_heading: "What past cases show",
    land_zoning_base_rate_generic_type: "land-use",
    land_zoning_base_rate_html: "Based on {n} past {type} cases since {year}. <b>{approved}% were approved.</b> Final action usually came {low}–{high} months after certification.",
    land_zoning_base_rate_outcomes: "Past results: {approved}% approved · {modified}% modified · {disapproved}% disapproved.",
    land_zoning_base_rate_authority_html: "Legal deadlines still control. This past range is context only. {link}",
    land_zoning_base_rate_formula_link: "How we count and test this",
    land_zoning_base_rate_formula_url: "about.html#zoning-base-rates",
    land_applicant_conditioned_predict_html: "Predicted based on {n} applications by this applicant since {year}: <b>{p}% approved</b>, vs {p0}% overall.",
    land_applicant_conditioned_history_html: "Based on {n} applications by this applicant since {year}: <b>{p}% approved</b>, vs {p0}% overall. Shown as history only — conditioning did not beat the overall rate out of sample.",
    land_applicant_conditioned_authority_html: "Applicant match uses public name links. {link}",
    land_applicant_conditioned_formula_link: "How applicant rates are counted",
    land_applicant_conditioned_formula_url: "about.html#applicant-conditioned-ulurp",
    land_applicant_link_strong: "Strong link",
    land_applicant_link_tentative: "Tentative link",
    land_phase_pre_application: "Pre-application and filing",
    land_phase_environmental: "Environmental review (CEQR)",
    land_phase_pre_certification: "Pre-certification notice",
    land_phase_certification: "Certification",
    land_phase_community_board: "Community Board review",
    land_phase_borough_president: "Borough President review",
    land_phase_cpc: "City Planning Commission",
    land_phase_city_council: "City Council review",
    land_phase_mayoral_appeals: "Mayoral / Appeals Board",
    land_outcomes_loading: "Loading decision documents and outcomes…",
    land_outcomes_matched_html: "Public status <b>{status}</b> · {n_docs} decision document(s) from the Zoning Application Portal.",
    land_outcomes_unmatched_html: "Not yet shown here — final decision documents and votes live in the Zoning Application Portal (ZAP). {reason}",
    land_outcomes_unmatched_default: "No decision documents or disposition votes were available for this project in the current join window.",
    land_outcomes_action_lbl: "Land-use action",
    land_outcomes_disposition_lbl: "Board disposition",
    land_outcomes_recommendation_html: "Recommendation: {rec}",
    land_outcomes_vote_tally_html: "for {favor} · against {against}",
    land_outcomes_documents_lbl: "Decision documents",
    land_outcomes_document_lbl: "Document",
    land_outcomes_documents_gap_html: "Not yet shown here — package and disposition PDFs live in the Zoning Application Portal when released.",
    land_outcomes_dob_lbl: "View DOB NOW filings",
    land_outcomes_dob_gap_html: "Not yet shown here — DOB NOW job filings on these tax lots live in NYC Open Data. {reason}",
    land_outcomes_portal_link: "Open full ZAP project",
    land_outcomes_provenance_html: "Outcomes join Open Data project rows to the public ZAP project API (exact project_id) and optional DOB NOW filings (exact BBL). The browser only reads a worker cache.",
    // Notice-level ZAP project spine (City Record land notice → phase-grouped ULURP timeline)
    notice_land_spine_heading: "Related land-use project timeline",
    notice_land_join_matched_html: "Matched this notice to Zoning Application Portal project <b>{project}</b> by {method} ({keys}).",
    notice_land_join_method_ulurp: "exact ULURP number",
    notice_land_join_method_project_id: "exact project id",
    notice_land_open_land_detail: "Open full Zoning project page",
    notice_land_no_match_html: "We haven’t matched this to a Zoning Application Portal project yet — check the live portal: {portal}.",
    notice_land_no_match_with_keys_html: "We haven’t matched ULURP {keys} to a Zoning Application Portal project yet — check the live portal: {portal}.",
    notice_land_ambiguous_html: "More than one ZAP project shares these ULURP numbers ({keys}). Open a project below to see its timeline.",
    notice_land_unavailable_html: "Could not load the project timeline right now. Try the Zoning project page when available.",
    notice_land_this_notice_html: "This City Record notice is part of the project’s public hearing record.",
    notice_land_provenance_html: "ULURP numbers come from the notice text. Project identity comes from the Zoning Application Portal open-data catalog. Timeline dates and outcomes come from CityScroll’s cached portal project record — not a live portal call from your browser.",

    // Property disposition process spine (multi-notice by parcel — not the temporal list filter rail)
    disposition_spine_heading: "Disposition timeline",
    disposition_stage_hearing: "Hearing",
    disposition_stage_auction_or_rfp: "Auction / RFP",
    disposition_stage_award_or_conveyance: "Award / conveyance",
    disposition_stage_unstaged: "Unstaged",
    disposition_stage_notice_count: "{n} notices",
    disposition_stage_not_yet_ingested_html: "Not yet shown here — later disposition notices live in {source}.",
    join_evidence_summary: "Explain grouping",
    join_evidence_html: "<b>Shared reference:</b> {reference}. <b>Match:</b> {method}.",
    join_evidence_singleton_html: "This timeline currently contains one City Record notice.",
    join_reference_solicitation: "Solicitation {value}",
    join_reference_bbl: "Tax-lot BBL {value}",
    join_reference_taxlot: "Borough / block / lot {value}",
    join_reference_party: "Named counterparty {value}",
    join_reference_plan: "Annual plan {value}",
    join_reference_rules: "FCRC rules subject",
    join_method_solicitation: "Exact solicitation number",
    join_method_party: "Same named counterparty",
    join_method_plan_year: "Same annual plan year",
    join_method_rules_subject: "Same FCRC rules subject",
    join_method_bbl: "Exact tax-lot BBL",
    join_method_taxlot: "Same borough, block, lot, and agency",
    join_method_shared_reference: "Shared official reference",
    disposition_join_singleton_html: "Single notice chain for {title} — no second City Record notice shares this parcel yet.",
    disposition_spine_unavailable_html: "Not yet shown here — multi-notice disposition chains are built from {source} Property Disposition notices.",
    disposition_source_city_record: "City Record Online",
    disposition_provenance_html: "Timeline joins Property Disposition notices that share an exact BBL or borough + block/lot and the same agency. Empty stages mean no matching City Record notice is in the current window — not that a filter chip is missing.",
    disposition_phase_action_attend: "Attend hearing",
    disposition_phase_action_bid: "Respond to sale",
    disposition_phase_action_conveyance: "Review conveyance",
    disposition_phase_now_html: "Now: <b>{phase}</b> — {action}",
    disposition_phase_next_html: "Next: {phase}",
    // Cohort-only disposition timing (phase_duration_ecdf). No per-matter date when the ship bar fails.
    disposition_timing_estimate_html: "{line} <span class=\"tag renewal\">{tag}</span>",
    disposition_timing_cohort_note_html: "Citywide pattern only — this corpus is too thin for a dated projection on this parcel.",
    disposition_timing_formula_link: "How this estimate is computed",
    property_domain_kicker: "City property disposition",
    property_domain_heading: "Hearings, sales, and awards",
    property_domain_deck: "City Record Property Disposition notices are grouped by parcel and process stage — hearing, auction or RFP, then award or conveyance — so repeated titles collapse into one disposition chain when they share a tax lot.",
    tax_lien_heading: "Tax lien sale history",
    tax_lien_deck_html: "A lien sale sells the <b>lien</b>, not the property. This view does not predict foreclosure or title transfer.",
    tax_lien_action_lead_html: "Properties on the 90-day list historically left the list before sale {p} of the time — exemption and payment-plan deadlines are the lever.",
    tax_lien_attribution: "Predicted based on {n} prior cycles",
    tax_lien_vintage: "Data through {date}",
    tax_lien_expired: "Latest published cycle ended {date} — historical context, not a current warning",
    tax_lien_action_deadline: "For the 2025 cycle, exemption and payment-plan action was due {date}.",
    tax_lien_cohort_only: "The cycle backtest did not meet the per-property projection bar, so the page shows observed BBL status and cohort statistics only.",
    tax_lien_lookup_label: "Look up a BBL on the latest published cycle",
    tax_lien_lookup_placeholder: "10-digit BBL",
    tax_lien_lookup_button: "Check BBL",
    tax_lien_lookup_invalid: "Enter a 10-digit BBL.",
    tax_lien_bbl_not_found: "BBL {bbl} was not on the 90-day list for the cycle in data through {date}.",
    tax_lien_bbl_observed_html: "Latest observed stage: {stage}. Recorded outcome: {outcome}.",
    tax_lien_borough_pattern: "In this borough's prior-cycle cohort, {p} left before sale",
    tax_lien_outcome_left: "left the list before final sale",
    tax_lien_outcome_sold: "lien appeared on the final sale list",
    tax_lien_stage_90: "90-day list",
    tax_lien_stage_60: "60-day list",
    tax_lien_stage_30: "30-day list",
    tax_lien_stage_10: "10-day list",
    tax_lien_stage_sold: "Final sale list",
    tax_lien_cycle_label: "Published cycle",
    tax_lien_borough_heading: "Counts by borough",
    tax_lien_nta_heading: "Counts by NTA",
    tax_lien_table_listed: "90-day list",
    tax_lien_table_sold: "Final list",
    tax_lien_table_left: "Left before sale",
    tax_lien_nta_unmapped: "NTA not mapped",
    tax_lien_exemptions: "Check exemptions",
    tax_lien_payment_plans: "Compare payment plans",
    tax_lien_help: "Lien sale help",
    tax_lien_call_311: "Call 311",
    tax_lien_checklist_heading: "Steps you can take",
    tax_lien_stage_heading: "What each published list means",
    tax_lien_checklist_exemptions: "Check exemptions you may qualify for",
    tax_lien_checklist_exemptions_meaning: "The DOF chart explains which owners and properties may be excluded from a lien sale.",
    tax_lien_checklist_payment_plans: "Review payment plan options",
    tax_lien_checklist_payment_plans_meaning: "DOF explains plans that may help you resolve eligible debt over time.",
    tax_lien_checklist_official_guide: "Read the official DOF lien sale guide",
    tax_lien_checklist_official_guide_meaning: "DOF explains the sale process, deadlines, and ways to get help.",
    tax_lien_cycle_expired_plain: "This published cycle ended on {date}. Its deadlines have passed. Use these links to check current DOF options.",
    tax_lien_stage_90_meaning: "DOF published the first list of liens that could enter this sale cycle.",
    tax_lien_stage_60_meaning: "DOF published an updated list about 60 days before the scheduled sale.",
    tax_lien_stage_30_meaning: "DOF published an updated list about 30 days before the scheduled sale.",
    tax_lien_stage_10_meaning: "DOF published an updated list about 10 days before the scheduled sale.",
    tax_lien_stage_sold_meaning: "The final list records liens included in the sale, not a property sale or transfer.",
    tax_lien_no_lot_tracking: "These lists are cycle snapshots. They do not track what happened to a specific lot between lists.",
    tax_lien_card_html: "Tax-lien list history through {date}: {stage} · {outcome}.",
    tax_lien_notice_context_heading: "Tax lien cycle context",
    property_process_rail_label: "Disposition stage",
    property_temporal_rail_label: "When",
    property_process_label: "Process",
    property_action_open_notice: "Open notice",
    property_action_lookup_zola: "Open ZoLa",
    property_action_open_rfp: "Open sale package",
    property_chain_notice_count: "{n} notices in this disposition",
    property_list_bbl_chip: "BBL {bbl}",
    property_list_no_bbl: "No tax-lot BBL on this notice yet",
    property_entries_announce: "{n} dispositions",
    property_process_stepper_aria: "Disposition process stages",
    property_guide_bbl_step: "Confirm the tax lot BBL {bbl}.",
    property_guide_zola_step_html: "Open the parcel on <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">ZoLa<span class=\"sr-only\"> (opens in new tab)</span></a> for zoning and lot boundaries.",
    property_guide_acris_step_html: "Check deeds and mortgages on the city <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">deeds search<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    property_guide_wow_step_html: "See related ownership clusters on <a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">Who Owns What<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    property_guide_owner_step: "Labeled grantee / winning bidder on this notice: {name}.",
    property_guide_fallback_step: "Use the parcel links above with the official City Record notice.",
    property_xd_heading: "This parcel across domains",
    property_xd_bbl_label: "Tax lot BBL {bbl}",
    property_xd_land_heading: "Land use (ZAP)",
    property_xd_owner_heading: "Owner → contracts",
    property_xd_via_bbl: "exact BBL {bbl}",
    property_xd_land_empty: "No ZAP project in the linked corpus shares this exact BBL — not proof no land-use application exists citywide.",
    property_xd_owner_empty: "No labeled winning-bidder or sold-to owner on these disposition notices.",
    property_xd_owner_no_contracts: "No money awards in the linked corpus share this owner stem.",
    property_xd_no_bbl_html: "Not yet shown here — parcel joins need a 10-digit BBL from the notice tax lot or geocode.",
    property_xd_not_in_corpus_html: "Not yet shown here — BBL {bbl} is not in the current property cross-domain catalog yet.",
    property_xd_provenance_html: "BBL → ZAP uses exact tax-lot match on zap-bbl. Owner → contracts uses vendor stem only when a winning bidder is labeled in the notice. Empty slots are corpus gaps, not proof the city withheld a source.",

    // Franchise / concession review spine (FCRC — solicitation → hearing → meeting → award)
    franchise_spine_heading: "Franchise and concession timeline",
    franchise_stage_solicitation: "Solicitation",
    franchise_stage_public_hearing: "Public hearing",
    franchise_stage_committee_meeting: "Committee meeting",
    franchise_stage_award: "Award",
    franchise_stage_notice_count: "{n} notices",
    franchise_stage_not_yet_ingested_html: "Not yet shown here — later franchise or concession notices live in {source}.",
    franchise_join_singleton_html: "Single notice chain for {title} — no second City Record notice shares this franchise or concession subject yet.",
    franchise_spine_unavailable_html: "Not yet shown here — multi-notice franchise and concession chains are built from {source} FCRC-related notices.",
    franchise_source_city_record: "City Record Online",
    franchise_provenance_html: "Timeline joins Franchise and Concession Review Committee (FCRC) notices that share a counterparty, annual concession plan year, or FCRC rules subject. Empty stages mean no matching City Record notice is in the current window — not that the city withheld a public source.",
    franchise_phase_action_solicitation: "Open solicitation",
    franchise_phase_action_public_hearing: "Attend hearing",
    franchise_phase_action_committee_meeting: "Attend meeting",
    franchise_phase_action_award: "Review franchise award",
    franchise_phase_now_html: "Now: <b>{phase}</b> — {action}",
    franchise_phase_next_html: "Next: {phase}",


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
    banner_none_nearest: "No rezoning on this block. In <b>{area}</b>:",
    banner_none_active_nearest: "No active rezoning on this block. Recent rezonings in <b>{area}</b>:",
    banner_none_lot: "No rezoning filed on this lot ({label}). Recent rezonings in <b>{area}</b>:",
    no_zap_kw: " for “{kw}”",
    // Empty-state only: project-vs-address completeness caveat (not part of the methodology note).
    zap_project_index_html: "ZAP indexes by <b>project</b>, not address — a notice about your block can be missing here while still in <a href=\"https://a856-cityrecord.nyc.gov/Search/Advanced\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    // Shared methodology note (empty + successful Land results). Site-owner-approved wording.
    zap_explainer_html: "Rezoning data comes from NYC's Zoning Application Portal (ZAP) via NYC Open Data, which the city refreshes about monthly. A change on the live ZAP site can take weeks to appear here. Lot outlines use the same tax-lot (BBL) → MapPLUTO join ZAP Search describes. When lots cannot be matched, the map is approximate — confirm on ZoLa.",
    affordable_housing_tag: "affordable housing",
    unnamed_project: "(unnamed project)",
    unnamed: "(unnamed)",
    status_na: "status n/a",
    mih_tag: "Mandatory Inclusionary Housing",
    applicant_lbl: "applicant",
    where_lbl: "where",
    in_plain_english: "In plain English",
    actions_lbl: "Actions:",
    zap_full_project: "Open ZAP project",
    alert_me_area: "Watch this area",
    search_city_record: "Search the City Record",
    rezoning_notice_link: "This rezoning's notice in the City Record",
    locating: "locating…",
    map_approx_note_html: "{label}. <span class=\"muted\">Approximate — confirm exact lots on <a href=\"https://zola.planning.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">ZoLa<span class=\"sr-only\"> (opens in new tab)</span></a>.</span>",
    showing_lots_note_html: "Showing {n} rezoned tax lot{s} (NYC MapPLUTO). <span class=\"muted\">Confirm on <a href=\"https://zola.planning.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">ZoLa<span class=\"sr-only\"> (opens in new tab)</span></a>.</span>",
    map_needs_connection: "Map needs a connection.",
    map_pan_group_aria: "Map pan controls",
    map_pan_west: "Pan map west",
    map_pan_north: "Pan map north",
    map_pan_south: "Pan map south",
    map_pan_east: "Pan map east",
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

    // Property explorer — surplus-goods buyer categories (persona vocabulary)
    all_types: "All types",
    asset_vehicle: "Vehicles",
    asset_timber: "Timber",
    asset_equipment: "Equipment",
    asset_real_property: "Real property",
    asset_scrap_materials: "Scrap / materials",
    asset_seized_property: "Seized / unclaimed property",
    asset_rights_and_interests: "Rights / interests",
    asset_other: "Other",
    // Legacy category keys kept so older bookmarks and translations still resolve.
    asset_realty: "Real property",
    asset_forest: "Forest / timber",
    asset_vehequip: "Vehicles + equipment",
    asset_medallion: "Medallions",
    asset_seized: "Seized / unclaimed",
    property_asset_rail_label: "Item type",
    property_sale_method_rail_label: "Sale method",
    property_price_rail_label: "Price",
    property_sort_label: "Sort by",
    property_sort_closing_soon: "Closing soonest",
    property_sort_newest: "Newest posted",
    property_sort_price_desc: "Price: high to low",
    property_sort_price_asc: "Price: low to high",
    sale_method_all: "All methods",
    sale_method_online_auction: "Online auction",
    sale_method_public_auction: "Public auction",
    sale_method_sealed_bid: "Sealed bid",
    sale_method_rfp: "RFP",
    sale_method_lease_auction: "Lease auction",
    sale_method_unknown: "Sale method",
    price_band_all: "All prices",
    price_band_priced: "Has a price",
    price_band_under_10k: "Under $10k",
    price_band_10k_100k: "$10k–$100k",
    price_band_100k_plus: "$100k+",
    stage_all: "All stages",
    stage_proposed: "● Proposed (hearing)",
    stage_soon: "◷ Closing soon",
    stage_upcoming: "◷ Upcoming",
    stage_past: "✓ Past / decided",
    badge_upset_price: "upset price ${amt}",
    badge_min_bid: "min bid ${amt}",
    badge_appraised: "appraised ${amt}",
    badge_assessed: "assessed ${amt}",
    badge_min_monthly_bid: "min monthly ${amt}",
    badge_min_annual_bid: "min annual ${amt}",
    badge_nominal: "$1 nominal",
    property_commercial_close: "closes {date}",
    property_commercial_closed: "closed {date}",
    property_event_hearing: "Hearing date",
    property_event_auction_start: "Auction start date",
    property_event_auction_end: "Auction close date",
    property_event_auction: "Auction date",
    property_event_sale: "Sale date",
    property_event_bid: "Bid deadline",
    property_event_showing: "Showing date",
    property_event_accommodation: "Interpreter request deadline",
    property_event_objection: "Objection deadline",
    property_event_comment: "Comment deadline",
    property_event_result: "Result date",
    property_closed_section: "Closed / archive",
    property_more_filters: "More filters",
    property_filters_active: "{n} active",
    property_how_it_works: "How this list works",
    property_nothing_current: "Nothing closing soon or upcoming right now. Recent closed notices are below.",
    property_neighborhood_empty_html: "No current dispositions in <b>{name}</b>.",
    follow_this_area: "Follow this area",
    property_cluster_summary: "{description} — {n} similar",
    property_cluster_fallback: "Dated notices",
    property_cluster_show: "Show each notice",
    property_cluster_hide: "Hide",
    property_action_closed: "Closed — view notice",
    property_commercial_heading: "What is for sale",
    property_commercial_persona_html: "For people scanning many disposition notices: what is being sold, for how much, whether a discount against the notice’s own stated value is derivable, and how to bid. Real-property developers and community land-reuse readers use the same facts with different next steps.",
    property_commercial_what_lbl: "What",
    property_commercial_price_lbl: "How much",
    property_commercial_deal_lbl: "Is it a deal?",
    property_commercial_bid_lbl: "When / how to bid",
    property_commercial_method_lbl: "Sale method",
    property_commercial_price_none_html: "No labeled minimum bid, upset price, or appraisal dollar is stated in this notice.",
    property_commercial_deal_insufficient_html: "A discount signal needs both a stated appraisal/assessed value and a minimum bid (or upset price) in the notice. This notice does not publish both.",
    property_commercial_deal_method_html: "Derived only from figures the notice itself labels — not from outside market comps.",
    property_commercial_comparables_slot_html: "External comparable pricing is planned for this category.",
    property_commercial_bid_none_html: "No registration link, deposit, show date, or bid deadline was extracted from this notice body.",
    property_commercial_provenance_html: "Extracted from the City Record notice body (and attachment titles when present). Each fact keeps a short source excerpt. City Record Online remains authoritative.",
    csv_sale_method: "Sale method",
    csv_close_date: "Close date",
    csv_primary_price: "Price",
    csv_price_kind: "Price kind",
    csv_commercial_item: "Item",
    csv_sale_eligible: "Sale eligible",
    add_date_btn: "Add to calendar",
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
    desc_awardwatch: "Checked {freq} — one email when the award for “{label}” registers",
    desc_section: "{freq} digest of {what}{bits}",
    desc_district: "Council District {district} — weekly civic actions",
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
    view_on_crol: "↗ View on CityScroll",
    unnamed_rezoning: "(unnamed rezoning)",
    view_comment_zap: "Comment on ZAP",
    hearing_notice_cr: "hearing notice in City Record",
    feeds_suffix: "— no email needed.",
    calendar_ics: "Add to calendar",
    saved_alerts_heading: "Saved alerts (demo)",
    // Multi-watch digest rollup + preference center surface (#alerts?view=rollup)
    alerts_rollup_summary: "Manage existing alerts",
    alerts_rollup_heading: "How multi-watch digests arrive",
    alerts_rollup_lead: "When one email has more than one active watch, CityScroll sends a single daily digest with a section per watch — not a separate email for each. Group the demo watches below by topic, agency, or geography to see how related alerts cluster.",
    alerts_rollup_group_label: "Group related watches by",
    alerts_rollup_group_topic: "Topic",
    alerts_rollup_group_agency: "Agency",
    alerts_rollup_group_geography: "Geography",
    alerts_rollup_email_heading: "Consolidated digest (demo)",
    alerts_rollup_prefs_lead: "Change frequency, pause a watch, or unsubscribe from the preference center linked in every digest footer.",
    alerts_rollup_manage_btn: "Manage watches",
    alerts_rollup_cutover: "Preference changes take effect on the next daily digest run (~9am Eastern).",
    alerts_rollup_section_quiet: "Nothing new for this watch.",
    alerts_rollup_no_groups: "No active watches to group.",
    alerts_rollup_watch_fallback: "Watch",
    alerts_rollup_digest_footer: "Manage watches · Unsubscribe all (one-click). Preference changes take effect on the next daily run (~9am Eastern).",
    alerts_rollup_group_announce: "Grouped by {dim}",
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
    back_browse: "← Browse CityScroll",
    back_previous_view: "← Back to previous view",
    back_to_view: "← Back to {view}",
    vendor_name_too_short: "“{name}” is too short to resolve to a vendor.",
    try_city_record: "try it in the City Record",
    notice_email_btn: "Email",
    notice_print_btn: "Print",
    add_to_calendar_btn: "Add to calendar",
    read_full_notice: "Read full notice",
    permalink_note_html: "Permalink: <code>{link}</code> · request ID <code>{id}</code> · from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">NYC Open Data<span class=\"sr-only\"> (opens in new tab)</span></a>",

    // Investigation workspace (2026-07-13 hotfix 2: localStorage-gated panel shipped English-only)
    inv_ws_heading: "Investigation workspace · stored only in this browser",
    inv_default_name: "My investigation",
    inv_name_aria: "Investigation name",
    inv_pinned_meta: "{n} pinned item{s} · started {date}",
    inv_empty: "Nothing pinned yet — use the Pin button on any notice, vendor, agency, or matter page.",
    inv_share_btn: "Share read-only link",
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

    // ---- Subpage chrome + content (about/data/stats/api/changelog) ----
    site_kicker: "The City Record, searchable",
    back_home_aria: "Back to CityScroll home",
    back_to_crol: "← Back to CityScroll",
    home_link: "Home",
    data_page_h1: "The Data",

    // about.html
    about_h_what: "What this is",
    about_p_what_html: "CityScroll is a search tool for <a href=\"https://a856-cityrecord.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a>. That is the City of New York's official daily paper. In it, <a href=\"https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-3113\" target=\"_blank\" rel=\"noopener noreferrer\">every agency must publish<span class=\"sr-only\"> (opens in new tab)</span></a> its contracts, hearings, rule changes, rezonings, and staff moves. CityScroll lets you search the record by interest. You can follow a contract, look up a job title, track a rezoning, or get an email when something new matches. CityScroll is independent and unofficial: it is not the City of New York, and it is not affiliated with or endorsed by any government agency.",
    about_h_content: "About our content",
    about_p_content_html: "An AI assistant (Claude) drafts this site's copy — headings, explanations, pages like this one. A human editor checks it before it goes live. The data is not AI-generated. Every notice, dollar figure, and date comes straight from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">NYC Open Data<span class=\"sr-only\"> (opens in new tab)</span></a>, unedited.",
    about_h_source: "Where the data comes from",
    about_p_source_html: "All of it comes from public, official data: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Online (dg92-zbpx)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\" target=\"_blank\" rel=\"noopener noreferrer\">Citywide Payroll (k397-673e)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/resource/vx8i-nprf\" target=\"_blank\" rel=\"noopener noreferrer\">Civil Service List (vx8i-nprf)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\" target=\"_blank\" rel=\"noopener noreferrer\">ZAP Projects (hgx4-8ukb)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://a0333-passportpublic.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">PASSPort<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://www.checkbooknyc.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Checkbook NYC<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    about_h_honest: "Data notes",
    about_p_honest_intro_html: "The City Record dataset is <b>1.09 million notices back to 2003</b> — and it is not what it looks like at first glance. Our team's exploratory analysis of the full dataset found quirks that would silently mislead if we didn't correct for them, so here is exactly what we do:",
    about_li_honest_html: "<li><b>87.5% of all rows are civil-service personnel changes</b>, not civic notices. Each stat on this site is counted within its own section — a \"global\" City Record number would really be a personnel-file number.</li><li><b>A few contract amounts are data-entry errors</b> — three rows claim $10&nbsp;billion or more, topping out at <a href=\"index.html#notice/20210524108\">$96 trillion, a housing-services award whose amount field is plainly a typo</a> (the largest verified real award is <a href=\"index.html#notice/20180109010\">about $6.68 billion, the city's 10-year electricity contract with NYPA</a>). Money filters and digests exclude amounts of $10 billion or more. One typo can't dominate every ranking.</li><li><b>Some \"due dates\" aren't deadlines.</b> Notices for pre-qualified lists use fake dates in the year 2090 or later. We mark these as \"no fixed deadline (rolling)\" so no one puts a date on their calendar that isn't real.</li><li><b>Agency names come in two conventions</b> (old ALL-CAPS and Title Case — 312 raw strings for about 150 real agencies). Our name tool treats them as one.</li><li id=\"external-awards-sources\"><b>Some agencies file contract awards outside the City Record entirely</b> — for those, we check Checkbook NYC (for the Housing Authority) and the NYS Authorities Budget Office's open procurement datasets (for other public authorities), and say so plainly when neither source covers an agency.</li>",
    about_p_agency_crosswalk_html: "The <a href=\"api.html#agency-crosswalk\">agency-name crosswalk</a> shows each source name and every spelling linked to it. Its data guide explains the limits and links to JSON and CSV files.",
    about_p_honest_footer_html: "Searches on this site always show live data from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">NYC Open Data<span class=\"sr-only\"> (opens in new tab)</span></a>. Email alerts check for new matches once a day. Want the numbers themselves? <a href=\"about.html#data\"><b>About</b> (data notes)</a> show these same rules in one place.",
    about_h_flags: "Flags and context, explained",
    about_h_tax_lien_formula: "Tax lien sale progression",
    about_p_tax_lien_formula_html: "Method: <b>borough base rate plus the announced sale date</b>. For each 90-, 60-, 30-, or 10-day stage, the rate is the number of distinct cycle-and-BBL pairs that also appear on that cycle's final sale list, divided by all distinct cycle-and-BBL pairs at that stage. Training requires at least three earlier cycles. A cycle-based holdout runs through the public prediction scorecard. Below the bar, CityScroll shows cohort statistics and observed BBL status, not a property-specific probability. False-positive modes include payment, payment plans, exemptions, corrections, and cancellation of an entire sale cycle. The dataset cannot identify which reason removed a BBL. A final-list match means the <b>lien</b> appeared on the sale list. It does not mean the property was sold, foreclosed, or transferred.",
    about_p_flags_intro_html: "Procurement notices carry two kinds of computed notes. Both are <b>statistical context, not findings or blame</b>. A flag just means \"worth a closer look.\" Every formula has a fair reason behind it. Emergencies really happen. Some markets are specialized and have few bidders. Name matching is not perfect. This method follows two guides. One is <a href=\"https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/\" target=\"_blank\" rel=\"noopener noreferrer\">the Open Contracting Partnership's red-flags guide<span class=\"sr-only\"> (opens in new tab)</span></a>. The other is <a href=\"https://opentender.eu/\" target=\"_blank\" rel=\"noopener noreferrer\">Opentender's<span class=\"sr-only\"> (opens in new tab)</span></a> integrity rules.",
    about_li_flags_html: "<li><b>⚑ Short ad window</b> — the days between when a notice is posted and when the answer is due. We flag it when it is 10 days or fewer and less than half the agency's own median. The median comes from that agency's last 200 notices. Short windows favor incumbents who already knew the work was coming.</li><li><b>⚑ Non-competitive method</b> — the notice says it will pick a vendor without a full contest. It may be a deal made through talks, a single chosen source, an urgent buy, or a test project. This can be fair at times. But it is always good to know.</li><li><b>⚑ Repeat awards</b> — the same vendor name shows up on 3 or more award notices at the same agency within 90 days. This can point to task orders under a blanket contract just as much as favoritism. The flag just counts them — you decide what it means.</li><li><b>Context strip</b> — how big an award is, shown as a percentile of that agency's awards in the last 12 months (shown only when the agency has 20 or more awards in that time). It also shows the vendor's share of the agency's award dollars in the same time. We use the exact published name. We do not merge name variants here.</li><li><b>Rules adoption lag (estimate)</b> — after comments close, how long similar Agency Rules usually took to reach a Notice of Adoption. Built from City Record history. Unfinished cases are not treated as fast ones. Uses an agency pool when it has at least 20 past gaps, or the whole city if not. Shown as a dashed “Estimate” segment on the rules timeline, and as one digest line only when the band changes — never as a confirmed date. Full formula: <a href=\"https://github.com/cityscroll/crol-list/blob/main/docs/formulas/rules-adoption-lag.md\" target=\"_blank\" rel=\"noopener noreferrer\">rules adoption lag<span class=\"sr-only\"> (opens in new tab)</span></a>.</li>",
    about_p_flags_footer_html: "All numbers come live from the <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Open Data<span class=\"sr-only\"> (opens in new tab)</span></a> when you view the notice. These are awards <b>as published</b>. The numbers can lag behind contract registration and real payment. Nothing here says anyone did wrong. It just saves you the math.",
    about_staffing_formula_heading: "Civil-service eligible-list timing",
    about_staffing_formula_html: "We make an exact match between an exam number in the DCAS annual schedule and the same number in the exam-level Civil Service List totals. Each gap runs from <b>the close of filing to the date the list was set up</b>. We group exams as open competitive or promotion. A group needs at least 20 exams. Smaller groups use all city exams. For each group, we sort the gaps and take the p10, median, and p90 by nearest rank. We test old results on later data. The test learns from lists set up by the end of 2024 and scores lists set up in 2025 and 2026. A page may show an exam date only when 50 or more test cases resolve, p10–p90 coverage is 70% to 90%, and each scored group rises from low to high. If the test falls short, pages show only the group median. Results can be wrong when the schedule changes, an exam number is used again, a list is late, or an active-list record has no set-up date. We never use applicant rows, names, scores, or ranks.",
    about_h_feedback: "Send feedback",
    about_p_feedback: "Found a bug, want a feature, or have a thought? Send it here. We read everything. No account needed.",
    about_email_us_html: "Or email us: <a href=\"mailto:feedback@cityscroll.org\">feedback@cityscroll.org</a>",
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
    about_foot_html: "CityScroll · a search interface over <a href=\"https://a856-cityrecord.nyc.gov/\" target=\"_blank\" rel=\"noopener noreferrer\">The City Record<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"stats.html\">Stats</a> · <a href=\"mailto:feedback%40cityscroll.org\">Feedback</a> · <a href=\"index.html\">Home</a>",
    about_h_privacy: "Privacy",
    about_p_privacy_intro: "CityScroll has no password accounts and no ad tech. It does not track you across other sites.",
    about_li_privacy_html: "<li><b>Searches and filters</b> use NYC Open Data.</li><li><b>The \"Ask\" box</b> lets you search in plain English. Your text is sent to Anthropic's Claude, which turns it into filters. We do not save your text.</li><li><b>Subscribing or sending feedback</b> saves what you send us. This includes your alert or message and your email, if you share one. We also keep some basic info about your request, like your IP address and browser. We keep this for a short time to stop spam and abuse. Every alert email has a one-click unsubscribe link.</li><li><b>Email links, pins, and watches</b> — clicking a link from your alert email signs you in on that device. The banner names the signed-in email and lets you manage its watches, sync pinned items, or sign out (\"Not you?\"). You do not need a second email link to manage watches while signed in.</li><li><b>Page views</b> are tracked with Cloudflare Web Analytics. It uses no cookies and only shows totals. It counts visits. It does not know who you are or follow you to other sites.</li><li><b>Click and scroll maps</b> (Microsoft Clarity, when turned on) show where people tap or scroll so we can fix hard-to-use spots. Typed text and form fields — including email — are masked and never sent as plain text. Clarity does not load if your browser signals Do Not Track or Global Privacy Control. It is not used for ads or personal profiles.</li>",
    session_signed_in: "Signed in as {email} — pins follow you on this device.",
    session_manage_watches: "Manage watches",
    session_not_you: "Not you?",
    session_dismiss: "Dismiss",

    // data.html
    data_p_lede_html: "The City Record dataset at a glance. Your browser pulls live totals from <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">NYC Open Data<span class=\"sr-only\"> (opens in new tab)</span></a>. Nothing is saved on the server. The numbers follow the <a href=\"about.html#data\">data-quality rules</a>. Stats stay in their own section. We exclude likely data-entry errors: amounts of $10 billion or more. Placeholder deadlines aren't real.",
    data_h_sections_html: "What the record really shows <span class=\"note\">(all time, by section)</span>",
    data_note_sections_body: "Most of the City Record is paperwork about civil-service jobs. The notices that matter to the public are only a small part of it. That is why every number on this site is shown per section.",
    data_h_volume_html: "How many were published <span class=\"note\">(last 12 months)</span>",
    data_h_procmix_html: "Procurement mix <span class=\"note\">(last 12 months, by notice type)</span>",
    data_h_agencies_html: "Top agencies by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_agencies_html: "\"Cleaned\" means we took out amounts over $10 billion. We think those are data-entry errors. See <a href=\"about.html#data\">the underlying data</a>.",
    data_h_vendors_html: "Top vendors by awarded dollars <span class=\"note\">(last 12 months, cleaned)</span>",
    data_note_vendors: "Vendor names are not standardized in the source. Small spelling differences show up as separate rows here.",
    data_value_share: "{value} · {share} of total",
    data_loading_counting: "Counting 1M+ notices…",
    data_fail: "Couldn't reach NYC Open Data just now — reload to retry.",
    data_foot_html: "Every number is worked out live in your browser from the public dataset. Reload the page for new data. Methodology: <a href=\"about.html#data\">about → the underlying data</a> · <a href=\"stats.html\">site usage stats</a>",

    // stats.html
    stats_loading: "Loading live counters…",
    stats_h_general: "The headline numbers",
    stats_lbl_subs: "Active watches",
    stats_desc_subs: "Confirmed watches that are not paused. One account may have more than one.",
    stats_lbl_accounts: "Accounts with watches",
    stats_desc_accounts: "Distinct email accounts with at least one active watch.",
    stats_lbl_digests: "Digests sent · 7 days",
    stats_desc_digests_html: "<span id=\"s-digests-today\">–</span> today. Sent for new matches and periodic \"still watching\" check-ins.",
    stats_lbl_clicks: "Digest links followed · 7 days",
    stats_desc_clicks_html: "Daily counts from the notice-link redirect — <a href=\"about.html#privacy\">how this works</a>.",
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
    stats_desc_digests_alltime: "Every digest CityScroll has ever sent.",
    stats_lbl_nl_alltime: "Searches asked · all time",
    stats_desc_nl_alltime: "Every plain-English question CityScroll has ever answered.",
    stats_h_category: "Digests, by topic",
    stats_p_category: "Notices surfaced in digests, broken out by City Record topic.",
    stats_col_category: "Topic",
    stats_col_count: "Notices",
    stats_cat_empty: "No digests have matched anything yet.",
    stats_h_bylens: "Searches, by section",
    stats_p_bylens: "Which part of the site people asked about: contracts, staffing, zoning, property, rules, or meetings.",
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
    stats_p_technical: "How the numbers above are put together. You don't need to know this to use CityScroll.",
    stats_foot_html: "Raw JSON: <a href=\"https://api.cityscroll.org/stats\">api.cityscroll.org/stats</a> (cached ~15 min) · <a href=\"about.html\">About</a> · <a href=\"index.html\">Home</a>",
    stats_asof: "As of {date} (refreshes every 15 minutes).",
    stats_unreachable: "Live counters are unreachable right now — the raw JSON lives at api.cityscroll.org/stats.",
    stats_h_usage: "How people use CityScroll",
    stats_p_usage: "Site totals. See use by day. No cookies. No visitor profiles.",
    stats_lbl_pageviews: "Page views · 7 days",
    stats_lbl_usage_searches: "Searches run · 7 days",
    stats_lbl_deeplinks: "Deep links opened · 7 days",
    stats_lbl_exports: "Exports · 7 days",
    stats_lbl_alert_confirms: "Watches confirmed · 7 days",
    stats_usage_unavailable: "These totals are not ready yet. They show after the first visit (about 15 minutes).",
    stats_h_lens_interest: "Use by section",
    stats_col_last30: "Last 30 days",
    stats_h_geography: "Searches by area",
    stats_col_area: "Area",
    stats_h_usage_growth: "Daily use",
    stats_lbl_pageviews_short: "Page views",
    stats_col_interactions: "Actions",
    stats_metric_asof: "As of {date}.",
    stats_metric_unavailable: "Data unavailable.",
    stats_area_manhattan: "Manhattan",
    stats_area_brooklyn: "Brooklyn",
    stats_area_queens: "Queens",
    stats_area_bronx: "The Bronx",
    stats_area_staten_island: "Staten Island",

    // api.html
    api_p_intro_html: "Every view on CityScroll has a machine-readable twin. No key and no account are required. Endpoints are rate-limited and cached, and none touches a paid service. Base URL: <code>https://api.cityscroll.org</code>.",
    api_h_feeds: "Feeds — any search as RSS / JSON / calendar",
    api_p_feeds_html: "<code>GET /feed.xml</code> (Atom) · <code>GET /feed.json</code> (JSON Feed 1.1) · <code>GET /feed.ics</code> (subscribable calendar — one event per dated notice). Edge-cached 15 minutes.",
    api_th_param: "Param",
    api_th_meaning: "Meaning",
    api_row_q: "keywords (up to 4)",
    api_row_agency: "agency name as printed in the record",
    api_row_min: "minimum award $ (money lens → award feed)",
    api_row_kindname_html: "entity lens: <code>kind=vendor|agency</code>, <code>name=…</code> — vendor names are matched by normalized stem, so suffix/case variants are included",
    api_h_property_locations: "Property locations",
    api_p_property_locations_html: "<code>GET /property-locations</code> returns the latest Property Disposition notices with extracted site addresses, boroughs, tax lots, BBLs, and resolved map geometry where available. The daily view is cached at the edge for 30 minutes. City Record Online remains the source of truth.",
    api_h_agencies: "Agency-name crosswalk",
    api_p_agencies_html: "<code>GET /agencies</code> lists each agency name as written in City Record Open Data and connects it to one name used by this site. Add <code>?format=csv</code> for CSV. The endpoint needs no key, allows cross-site requests, and is cached for one day.",
    api_agencies_dictionary_html: "<tr><td><code>raw_string</code></td><td>exact text in <code>agency_name</code>. One row for each distinct source string</td></tr><tr><td><code>canonical_id</code></td><td>stable text id assigned by the crosswalk</td></tr><tr><td><code>canonical_name</code></td><td>name this site uses for the group</td></tr><tr><td><code>variants</code></td><td>every source spelling connected to the same id</td></tr>",
    api_p_agencies_limits: "Matches use case, punctuation, known short forms, and administrative families. New spellings may start with their own id until the crosswalk is updated. The crosswalk helps connect records. It is not an official agency registry.",
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
    api_p_stats_html: "<code>GET /stats</code> — the project's own usage as aggregate counts (active subscriptions, digests sent, digest links followed, feed/batch/share activity). It's cached about 15 minutes. Human-readable version: <a href=\"stats.html\">stats</a>. Related: digest emails link notices via <code>GET /r/&lt;kind&gt;/&lt;request_id&gt;</code>, which checks the id against known notices, redirects to the matching permalink, and records a per-day count.",
    api_h_subscribe: "Subscribe by email",
    api_p_subscribe_html: "Email <a href=\"mailto:subscribe@crol-list.org\"><code>subscribe@crol-list.org</code></a> describing what you want in plain English — for example, \"construction contract awards over $500k\" or \"rezoning notices in Brooklyn\". You'll get back a confirmation link describing how we understood your request. The watch starts only after you click it (double opt-in). Daily ceilings apply, and nothing is stored until you confirm.",
    api_h_mcp: "MCP — for AI assistants",
    api_p_mcp_html: "<code>POST /mcp</code> (Streamable HTTP, JSON-RPC) — point an MCP client at <code>https://api.cityscroll.org/mcp</code>. Tools: <code>search_notices</code> and <code>get_notice</code> (the daily-refreshed notices mirror), <code>preview_watch</code> (plain English → what a standing watch would deliver, without subscribing), and <code>create_watch</code> (plain English → a double-opt-in confirmation email — digests start only after the address confirms). Watch management stays behind the emailed unsubscribe links — knowing an address never reveals or controls its subscriptions. Per-IP and daily model-call ceilings apply.",
    api_h_upstream: "Upstream data",
    api_p_upstream_html: "CityScroll republishes and joins public datasets — for bulk work, go straight to the sources: <a href=\"https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx\" target=\"_blank\" rel=\"noopener noreferrer\">City Record Online (dg92-zbpx, Socrata SODA)<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://www.checkbooknyc.com/data-feeds/api\" target=\"_blank\" rel=\"noopener noreferrer\">Checkbook NYC API<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Citywide-Payroll-Data-Fiscal-Year-/k397-673e\" target=\"_blank\" rel=\"noopener noreferrer\">Citywide Payroll<span class=\"sr-only\"> (opens in new tab)</span></a> · <a href=\"https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb\" target=\"_blank\" rel=\"noopener noreferrer\">ZAP<span class=\"sr-only\"> (opens in new tab)</span></a>.",
    api_foot_html: "CityScroll · <a href=\"index.html\">Home</a> · <a href=\"about.html\">About</a>",

    // changelog.html
    chg_p_lede: "What changed on CityScroll, newest first.",
    chg_auto_h2: "Recent updates",
    chg_media_visual_aria: "Before-and-after feature media",
    chg_media_viewport: "Viewport",
    chg_media_before: "Before",
    chg_media_after: "After",
    chg_media_recording: "Screen recording",
    chg_media_video_fallback: "Your browser cannot play this video.",
    chg_pr80_recording_caption: "Find a covered notice, choose the award watch, enter reader@example.com, and reach the email confirmation step.",
    chg_pr74_before_alt: "A notice page opened from a bare link, with no sign of why it matched.",
    chg_pr74_after_alt: "The same notice page opened from a digest link, with the matching word highlighted and a plain summary of the watch.",
    chg_pr62_before_alt: "The stats page with one flat grid mixing plain outcomes and technical plumbing, and no note on how far back the totals count.",
    chg_pr62_after_alt: "The stats page with headline numbers separated from a technical-details section, and a note on how far back each total counts.",
    chg_pr50_recording_caption: "Pick the \"City contracts and RFPs\" topic, type a full sentence, and preview the real, interpreted results.",
    chg_earlier_h2: "Earlier releases",
    chg_detail_note: "The detailed technical notes below each release (bullet lists, incident reports) remain in English for now.",
    chg_foot_html: "CityScroll is an unofficial, free interface to public data. <a href=\"about.html\">About</a> · <a href=\"stats.html\">Stats</a> · <a href=\"api.html\">API and feeds</a> · <a href=\"index.html\">Home</a>",
    chg_0710e_h2: "2026.07.10 · Espanol coverage: the whole interface, not just the chrome",
    chg_0710e_foryou_html: "<b>Para usted</b> — Phase 2 of Spanish support: the entire visible interface now translates when you switch to Espanol. Phase 1 covered tabs, buttons, and short labels (98 keys). Phase 2 adds the empty states, search placeholders, panel headings, the Today's Edition strip, alert builder labels and parameters, loading messages, and all control labels across every lens (Money, People, Land, Property, Rules, Meetings, Alerts) -- growing the dictionary from 98 to over 200 keys. A new residual-English coverage gate in the test suite verifies 15 high-visibility sentinel strings are absent in Espanol mode.",
    chg_0710d_h2: "2026.07.10 · Spanish support + style-guide copy pass",
    chg_0710d_foryou_html: "<b>For you</b> — A language switcher now appears in the header (English / Espanol). Choosing Spanish translates all tabs, chips, and messages in the UI. Notices themselves stay in English, which is the official language of the City Record. Your preference is remembered across visits. Separately, time chips, deadline chips, and the feedback-category selector were updated to follow the NYC Web Content Style Guide: \"9 a.m.\" (not \"9 AM\"), spelled-out numbers (\"closes in two days\"), and acronym expansions on first use (RFP, M/WBE, ZAP). City Record content is now marked <code>translate=\"no\"</code> so machine-translation tools leave it intact.",
    chg_0710c_h2: "2026.07.10 · Accessibility: an enforced floor, not a promise",
    chg_0710c_foryou_html: "<b>For you</b> — If you use a keyboard or a screen reader, the rough edges are getting fixed for real: the feedback form's category picker now works without a mouse, the plain-English search box announces itself properly, low-contrast text is corrected site-wide, and the \"minimum award\" filter genuinely disables when it doesn't apply instead of just fading. From now on, an automated accessibility check (axe) runs against every page in our test harness — a change that breaks accessibility fails the build. CONTRIBUTING and SECURITY were also rewritten to describe how the project is actually governed and defended.",
    chg_0710b_h2: "2026.07.10 · Three new front doors: email-in, MCP, and The Data",
    chg_0710b_foryou_html: "<b>For you</b> — Three new ways in. <b>Subscribe by email:</b> write to <a href=\"mailto:subscribe@crol-list.org\">subscribe@crol-list.org</a> in plain English (\"construction awards over $500k\") and you'll get a confirmation link back — no form, no CAPTCHA, just your words. <b>For AI assistants:</b> point any MCP client at <code>api.cityscroll.org/mcp</code> to search notices and set up watches programmatically (double opt-in still applies — nothing sends without the address confirming). <b><a href=\"data.html\">The Data</a>:</b> a new page showing the City Record at a glance — what's actually in it, publication volume, procurement mix, top agencies and vendors by cleaned dollars — computed live in your browser from NYC Open Data.",
    chg_0710_h2: "2026.07.10 · Data-quality rules + a faster backbone (with Dev Doshi)",
    chg_0710_foryou_html: "<b>For you</b> — Money filters and digests can no longer be hijacked by the dataset's data-entry errors: amounts of $10 billion or more (there's a $96 trillion typo in the official record) are excluded, while real multi-billion awards now correctly appear — the old cutoff silently dropped everything above $5 billion, including the largest legitimate award (about $6.68 billion). Pre-qualified-list notices with placeholder year-2090 dates now say \"no fixed deadline (rolling)\" instead of a date no one should calendar. The <a href=\"about.html#data\">About page documents the dataset's quirks</a> — what the City Record actually contains and how we correct for it.",
    chg_0709_h2: "2026.07.09 · Predictive Procurement: Checkbook Expirations, MOCS Plans, &amp; Early-Warning Timelines",
    chg_0709_foryou_html: "<b>For you</b> — CityScroll now alerts you 6 months before contracts expire or new RFPs are published. Agency and vendor profiles show a new <b>\"Procurement Forecast\"</b> tab with a vertical chronological timeline, uniting predicted contract renewals (from Checkbook NYC) and official agency-planned solicitations (from Charter §112 MOCS datasets). Digests now deliver early-warning notifications for upcoming forecasts matching your watches.",
    chg_0702d_h2: "2026.07.02 · Fix: vendors with punctuated names resolve again",
    chg_0702d_foryou_html: "<b>For you</b> — Vendor pages and vendor watches now work for names like \"Leon D. Dematteis Construction Corp.\" Before this fix, clicking such a vendor showed \"no awards on record\" and a watch on them matched nothing — despite their awards being right there.",
    chg_0702c_h2: "2026.07.02 · Snap + crisp: the round-four speed-and-declutter pass",
    chg_0702c_foryou_html: "<b>For you</b> — The site looks calmer and feels immediate. Lists show content-shaped placeholders instead of spinners. Filtering keeps your place instead of blanking the list. Going back to a tab you already loaded is instant. Clicking a notice paints its detail at once (the paper trail fills in a beat later). Search runs as you type — the Filter buttons are gone because you no longer need them.",
    chg_0702b_h2: "2026.07.02 · Enablement: public stats, click counts, this page",
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
    mini_subscribe_btn: "Subscribe",
    vendor_profile_variants: "Vendor profile · {n} name variant{s} resolved",
    vendor_doing_business_heading: "Doing Business Search",
    vendor_doing_business_listed: "Listed in the city’s Doing Business Search",
    vendor_doing_business_listed_as: "Listed as {name}",
    vendor_doing_business_structure: "Ownership structure: {structure}",
    vendor_doing_business_phone: "Organization phone: {phone}",
    vendor_doing_business_start: "Doing-business start: {date}",
    vendor_doing_business_source: "NYC Open Data · Doing Business Search entities",
    which_variants_btn: "which?",
    index_title: "CityScroll · track RFPs, rezonings, meetings",
    about_title: "About · CityScroll",
    data_title: "The Data · CityScroll",
    stats_title: "Stats · CityScroll",
    changelog_title: "Changelog · CityScroll",
    api_title: "API and feeds · CityScroll",
    standards_title: "Standards · CityScroll",
    map_marker_alt: "Rezoning project location",
    footer_standards: "Standards",

    // standards.html
    std_h1: "Standards We Track",
    std_p_lede_html: "This page checks CityScroll against standards New York City and New York State have published. One part covers languages. The other covers accessibility. What we actually do is stated as a plain observation, never as a certification.",
    std_h_languages: "Language access, side by side",
    std_p_languages_html: "New York City's <a href=\"https://citymeetings.nyc/meetings/new-york-city-council/2024-09-24-0100-pm-committee-on-immigration/chapter/explanation-of-local-law-30-of-2017-and-its-requirements/\" target=\"_blank\" rel=\"noopener noreferrer\">Local Law 30 of 2017<span class=\"sr-only\"> (opens in new tab)</span></a> names ten citywide languages, beyond English, that city agencies must support. The table below checks that list against CityScroll's own language switcher, live: if a language is ever added to or removed from the switcher, this table changes with it.",
    std_table_caption: "Local Law 30's ten languages compared to CityScroll's language switcher",
    std_col_language: "Language (Local Law 30)",
    std_col_switcher: "In CityScroll's switcher",
    std_col_review: "Translation review status",
    std_switcher_yes: "Yes",
    std_switcher_no: "Not yet",
    std_review_machine_drafted: "Machine-drafted, not yet native-reviewed",
    std_review_native: "Native-reviewed",
    std_lang_es: "Spanish",
    std_lang_zh_hans: "Chinese",
    std_lang_ru: "Russian",
    std_lang_bn: "Bengali",
    std_lang_ht: "Haitian Creole",
    std_lang_ko: "Korean",
    std_lang_ar: "Arabic",
    std_lang_fr: "French",
    std_lang_ur: "Urdu",
    std_lang_pl: "Polish",
    std_p_language_summary: "{n} of {total} Local Law 30 languages are in CityScroll's switcher today. {r} of those are native-reviewed.",
    std_h_accessibility: "The accessibility target, and where it's headed",
    std_a11y_today_label: "Today",
    std_a11y_today_html: "New York City's own <a href=\"https://rules.cityofnewyork.us/nyc-rules-website-accessibility-statement/\" target=\"_blank\" rel=\"noopener noreferrer\">website accessibility statement<span class=\"sr-only\"> (opens in new tab)</span></a> targets <b>WCAG 2.1 Level AA</b> and describes the City's sites as \"partially conformant.\"",
    std_a11y_next_label: "January 2027",
    std_a11y_next_html: "New York State's technology law (<a href=\"https://designsystem.ny.gov/foundations/accessibility/\" target=\"_blank\" rel=\"noopener noreferrer\">STL §103-d<span class=\"sr-only\"> (opens in new tab)</span></a>) requires State Entity websites to move up to <b>WCAG 2.2 Level AA</b>. That binds state agencies, not New York City directly — but it is the clearest published signal of where the standard is heading next.",
    std_h_self_conformance: "CityScroll's own accessibility posture",
    std_p_self_conformance_lede: "These are targets and continuous observations, not a certification.",
    std_self_target_label: "CityScroll target",
    std_self_target_html: "CityScroll targets <b>WCAG 2.2 Level AA</b> today.",
    std_self_observations_label: "Continuous observations",
    std_li_axe_pr: "The axe accessibility gate runs on every pull request across each public page and activated tab state. A new critical or serious violation fails the build.",
    std_li_ll30_live: "The Local Law 30 table above reads the site's current language switcher live. It changes when a language is added to or removed from the switcher.",
    std_li_reading_ratchet: "The reading-level ratchet runs on every pull request across the public pages. A page that gets harder to read than its committed baseline fails the gate.",
    std_h_posture: "What we actually built (checked on this page)",
    std_p_posture_lede: "None of this is a certification. Some lines are checked live against this page's own markup. The rest are plain facts about how the site works. View source any time to check for yourself.",
    std_li_no_login: "No account, sign-in, or password is required to search notices or read one.",
    std_li_no_browser_gate: "No browser-version check blocks entry. The page does not test which browser you use before it loads.",
    std_li_semantic_skip: "Skip-to-content link:",
    std_li_semantic_main: "Landmark region for the main content:",
    std_li_semantic_switcher: "Language switcher marked as a labeled group:",
    std_status_present: "Present",
    std_status_missing: "Missing",
    std_li_translation_review: "{r} of {total} shipping-language dictionaries are native-reviewed. The rest are machine-drafted.",
    std_h_timeline: "Snapshots over time",
    std_p_timeline_lede: "Dated entries record each published standard or posture change. Earlier measurements remain available above.",
    std_timeline_entry_html: "As of {date}: {matched} of {total} Local Law 30 languages were in the switcher. Accessibility target: {city} today, moving to {next} by {nextdate} for New York State entities.",
    std_timeline_loading: "Loading snapshots…",
    std_timeline_fail: "Couldn't load the snapshot history just now — reload to retry.",
    std_foot_html: "CityScroll · <a href=\"about.html\">About</a> · <a href=\"api.html\">API</a> · <a href=\"changelog.html\">Changelog</a> · <a href=\"index.html\">Home</a>",
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
window.I18N_ASSET_VERSION = I18N_ASSET_VERSION;
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
  document.querySelectorAll("[data-i18n-alt]").forEach(function(el) {
    el.setAttribute("alt", t(el.dataset.i18nAlt));
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
  const s = document.createElement("script");
  s.src = i18nAssetUrl("i18n/lang/" + lang + ".js");
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
  syncLanguageURL(lang);
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
// Compact <select id="langSelect"> — same control shape as the homepage dropdown.
function initSubpageLangSwitcher(onChange) {
  function init() {
    var sel = document.getElementById("langSelect");
    var saved = window.LANG || "en";
    if (sel) {
      if ([].some.call(sel.options, function(o){ return o.value === saved; })) sel.value = saved;
    }
    applyStrings();
    if (sel) {
      sel.addEventListener("change", function(){
        var lang = sel.value;
        setLang(lang, onChange ? function(){ onChange(lang); } : null);
        if (onChange) onChange(lang);
      });
    }
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
  var savedPreference = "en";
  try { savedPreference = localStorage.getItem("crol_lang") || "en"; } catch(e) {}
  var search = typeof location !== "undefined" ? location.search : "";
  var saved = initialLanguage(search, savedPreference);
  window.LANG = saved;
  if (typeof document !== "undefined") {
    document.documentElement.lang = saved;
    var meta = LANG_META[saved];
    if (meta) document.documentElement.dir = meta.dir;
    if (saved !== "en" && SHIPPING_LANGS.includes(saved) && typeof document.write === "function") {
      document.write('<script src="' + i18nAssetUrl("i18n/lang/" + saved + ".js") + '"><\/script>');
      _langLoadState[saved] = "loaded"; // document.write blocks until it runs — no async race
    }
  }
})();
