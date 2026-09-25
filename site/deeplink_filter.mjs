/**
 * Client-side deeplink filter clamp — hand-synced with worker/src/lib/filter.mjs.
 *
 * routing.mjs imports this module so the short-context working bar stays under
 * the 100 KB application-module gate. test/deeplink_watch.test.mjs extracts the
 * same declarations via SHARED_SOURCE_MODULES.
 */

import { normalizeCommunityBoardRef } from "./community_board_watch.mjs";
import { canonicalMeetingAvailability } from "./meeting_availability_filter.mjs";

// DEEPLINK_LENSES/deeplinkClampField/sanitizeDeepLinkFilter are a hand-synced client port of
// worker/src/lib/filter.mjs's LENSES/clampField/sanitize -- same dual-implementation convention
// as external_awards.js/lib/external_award.mjs (see AGENTS.md). test/deeplink_watch.test.mjs
// cross-checks the two stay in sync. Reusing sanitize()'s clamp-to-schema behavior is what makes
// an unexpected extra key or an out-of-range value fail soft (silently dropped, not an error)
// rather than break rendering.
const DEEPLINK_LENSES = {
  // Keep field-for-field parity with worker/src/lib/filter.mjs LENSES (deeplink_watch.test).
  money:    ["keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "minRemainingDays", "route", "name", "tab", "entity_refs_all", "connection_relation", "geographies", "place_role", "procurement_id", "processState"],
  people:   ["keywords", "lookupType", "view", "interest", "interestArea", "interestLabel", "examNumber", "subject_refs_all"],
  land:     ["keywords", "boro", "status", "communityDistrict", "councilDistrict", "nearMe", "procedure", "family", "regulatoryEffect", "futureAction", "attendance", "geographies", "place_role"],
  property: ["keywords", "agency", "process", "stage", "asset", "saleMethod", "priceBand", "sort", "borough", "neighborhood", "communityDistrict", "nearMe", "geographies", "place_role"],
  rules:    ["keywords", "agency", "process", "geographies", "place_role", "request_ids"],
  meetings: ["keywords", "agency", "when", "borough", "neighborhood", "communityDistrict", "councilDistrict", "locationScope", "dateWindow", "process", "nearMe", "geographies", "place_role", "communityBoard", "matter_ref", "matter_scope_version", "activity", "body", "access", "availability"],
  district: ["councilDistrict"],
  entity:   ["name", "kind", "tab", "entity_refs_all"],
  mandates: ["agency_id", "agency", "mandate_id", "deliverable_type", "windowDays"],
  obligations: ["agency_id", "agency", "mandate_id", "deliverable_type", "windowDays"],
  legal_code: ["provision_id"],
  alerts:   ["watchType", "place", "keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "minRemainingDays", "route", "name", "tab", "entity_refs_all", "connection_relation"],
  award:    ["requestId", "agency"],
};
const DEEPLINK_CATEGORIES = ["Goods", "Goods and Services", "Services (other than human services)",
  "Human Services/Client Services", "Construction/Construction Services", "Construction Related Services"];
const DEEPLINK_BOROS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
const DEEPLINK_PROCESS_STATES = ["planned", "open", "responses_closed", "evaluation", "selection_made",
  "intent_to_negotiate", "intent_to_award", "award", "contract_in_progress", "pending_registration",
  "registered", "payment", "closed", "vendor_list"];
// Hand-synced with site/scope_v0.mjs's PLACE_ROLES (venue/matter/affected_area) — the one
// canonical place-role predicate; see that module for what each value means.
const DEEPLINK_PLACE_ROLES = ["venue", "matter", "affected_area"];
function deeplinkClampField(name, v){
  switch(name){
    case "keywords": return Array.isArray(v) ? v.map(k=>String(k).toLowerCase().trim()).filter(Boolean).slice(0,4) : [];
    case "geographies": {
      const publicKey=/^geography:(?:borough:[1-5]|community_district:(?:M|X|K|Q|R)\d{2}|council_district:(?:[1-9]|[1-4]\d|5[01])|nta2020:(?:BK|BX|MN|QN|SI)\d{4}|police_precinct:(?:[1-9]|[1-9]\d|1[01]\d|12[0-3]))$/;
      return Array.isArray(v) ? [...new Set(v.map(item=>String(item||"").trim()).filter(item=>item.length<=100&&publicKey.test(item)))].sort().slice(0,8) : [];
    }
    case "agency": return typeof v==="string" && v.trim() ? v.trim() : null;
    case "communityBoard": return normalizeCommunityBoardRef(v);
    case "agency_id": { const s=typeof v==="string"?v.trim().toLowerCase():""; return /^[a-z0-9][a-z0-9-]{1,80}$/.test(s)?s:null; }
    case "matter_ref": {
      const s = typeof v === "string" ? v.trim().toLowerCase() : "";
      const match = s.match(/^(legistar):([a-z0-9-]+):matter:(\d+)$/) || (/^\d+$/.test(s) ? ["", "legistar", "nyc", s] : null);
      return match && match[2] === "nyc" ? `legistar:nyc:matter:${match[3]}` : null;
    }
    case "matter_scope_version": {
      const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
      return Number.isInteger(n) && n === 1 ? 1 : null;
    }
    case "provision_id": {
      const s = typeof v === "string" ? v.trim() : "";
      const citation = s
        .replace(/[§]/g, " ")
        .replace(/^(?:nyc-administrative-code|nyc-admin-code):/i, "")
        .trim()
        .match(/^(\d+[a-z]?-[0-9a-z.]+)$/i);
      return citation ? `nyc-administrative-code:${citation[1].toLowerCase()}` : null;
    }
    case "mandate_id": {
      // Exact statutory duty id — bare id or legacy mandate:/obligation: subject ref.
      // Keep field-for-field parity with worker/src/lib/filter.mjs + site/mandate_subject_ref.mjs.
      let s = typeof v === "string" ? v.trim() : "";
      const legacy = s.match(/^(?:mandate|obligation):([^:\s]+)$/i);
      if (legacy) s = legacy[1];
      if (!s || /\s/.test(s) || s.includes(":")) return null;
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : null;
    }
    case "deliverable_type": { const s=typeof v==="string"?v.trim().toLowerCase():""; return ["report","rulemaking","program","data publication","other"].includes(s)?s:null; }
    case "windowDays": {
      const n=typeof v==="number"?v:(typeof v==="string"&&v.trim()?Number(v):NaN);
      if(!Number.isFinite(n)) return null;
      const days=Math.round(n);
      return days>=1&&days<=365?days:null;
    }
    case "minAmount": return typeof v==="number" && v>=1000 ? Math.round(v) : null;
    case "maxAmount": return typeof v==="number" && v>=1000 ? Math.round(v) : null;
    case "category": return DEEPLINK_CATEGORIES.includes(v) ? v : null;
    case "months": return typeof v==="number" && v>0 && v<=60 ? Math.round(v) : null;
    case "minRemainingDays": {
      if (typeof v === "boolean" || Array.isArray(v) || (v && typeof v === "object")) return null;
      if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) return null;
      const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v.trim()) : NaN);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 365) return null;
      return n;
    }
    case "noticeType": return v==="award" ? "award" : v==="solicitation" ? "solicitation" : null;
    case "excludeSpecial": return !!v;
    case "boro": { const s = typeof v==="string" ? v.trim().toLowerCase() : ""; return DEEPLINK_BOROS.find(b=>b.toLowerCase()===s) || null; }
    case "status": return v==="all" ? "all" : v==="active" ? "active" : null;
    case "procedure": return ["review","ulurp","elurp","non_ulurp"].includes(v) ? v : null;
    case "family": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return [
        "acquisition","disposition","certification","renewal","major_concession","legal_document",
        "rezoning","special_permit","authorization","site_selection","mapping","demapping",
        "urban_renewal","landmark","follow_up","office_space","bid","franchise_consent",
        "housing_plan","pops","landfill",
      ].includes(s) ? s : null;
    }
    case "regulatoryEffect": {
      const raw=typeof v==="string"?v.trim().toLowerCase().replace(/[\s-]+/g,"_"):"";
      const s=({up_zone:"upzone",down_zone:"downzone"})[raw]||raw;
      return ["upzone","downzone","mixed","no_density_change"].includes(s)?s:null;
    }
    case "futureAction": return ["any","none","any_future","hearing","non_hearing"].includes(v)?v:null;
    case "attendance": return ["in_person","livestream","hybrid"].includes(v)?v:null;
    case "when": return ["all","upcoming","week","month","past"].includes(v) ? v : null;
    case "borough": { const s=typeof v==="string"?v.trim().toLowerCase():""; return DEEPLINK_BOROS.find(b=>b.toLowerCase()===s)||null; }
    case "neighborhood": return typeof v==="string"&&v.trim()?v.replace(/\s+/g," ").trim().slice(0,80):null;
    case "locationScope": return v==="citywide-unlocated"||v==="citywide"||v==="virtual"||v==="unlocated"?v:null;
    case "dateWindow": return ["week","month","upcoming"].includes(v)?v:null;
    case "lookupType": return v==="person" ? "person" : v==="role" ? "role" : null;
    case "view": return v==="guide" ? "guide" : null;
    case "interestArea": return ["public-safety","health-care","engineering-construction","technology-science","community-social-services","administration-finance","trades-operations"].includes(v)?v:null;
    case "interestLabel": return typeof v==="string"&&v.trim()?v.replace(/\s+/g," ").trim().slice(0,80):null;
    case "examNumber": return typeof v==="string" && /^\d{4}$/.test(v.trim()) ? v.trim() : null;
    case "name": return typeof v==="string" && v.trim() ? v.replace(/\s+/g," ").trim().slice(0,120) : null;
    case "kind": return v==="agency" ? "agency" : v==="vendor" ? "vendor" : null;
    case "watchType": return v==="rezone" ? "rezone" : null;
    case "place": return typeof v==="string" && v.trim() ? v.trim() : null;
    case "requestId": return typeof v==="string" && /^[A-Za-z0-9_-]{4,40}$/.test(v.trim()) ? v.trim() : null;
    case "request_ids": return Array.isArray(v) ? [...new Set(v.map(item=>String(item||"").trim()).filter(item=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(item)))].sort().slice(0,24) : [];
    case "procurement_id": { const s=typeof v==="string"?v.trim():""; return /^procurement:[a-z0-9-]+:[A-Za-z0-9._:-]{3,120}$/.test(s)?s:null; }
    case "entity_refs_all": return Array.isArray(v) ? [...new Set(v.map(item=>String(item||"").trim()).filter(item=>/^(?:agency:[^:\s]+:[^:\s]+|vendor:stem:[^:\s]+|entity:official:[^:\s]+|project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}|notice:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|pin:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|exam:\d{4}|bbl:\d{10})$/.test(item)))].slice(0,20) : [];
    case "connection_relation": return typeof v==="string" && ["published_by_agency","applicant_agency","hosts_meeting","named_vendor","sited_on_parcel","votes_on","references_contract","registered_as","shares_authority_key","about_notice","parcel_links_project","named_owner","same_rulemaking"].includes(v) ? v : null;
    case "place_role": return DEEPLINK_PLACE_ROLES.includes(v) ? v : null;
    case "activity": return v === "observe" ? "observe" : null;
    case "body": {
      const s = typeof v === "string" ? v.trim() : "";
      return ["pdc_calendar", "bsa_calendar", "oath_trial_calendar"].includes(s) ? s : null;
    }
    case "access": return ["remote", "in_person", "unknown"].includes(v) ? v : null;
    case "availability": return canonicalMeetingAvailability(v);
    case "processState": {
      // Hand-synced with worker/src/lib/filter.mjs + KNOWN_PROCUREMENT_PROCESS_STATES.
      const s=typeof v==="string"?v.trim().toLowerCase():"";
      return DEEPLINK_PROCESS_STATES.includes(s)?s:null;
    }
    case "closingWeek": return !!v;
    case "route": return v==="agency" || v==="vendor" ? v : null;
    case "tab": return v==="forecast" || v==="overview" ? v : null;
    case "communityDistrict": { const s=typeof v==="string"?v.trim().toUpperCase():""; return /^(?:M|X|K|Q|R)\d{2}$/.test(s)?s:null; }
    case "councilDistrict": { const s=(typeof v==="string"||typeof v==="number")?String(v).trim():""; return /^(?:[1-9]|[1-4]\d|5[01])$/.test(s)?s:null; }
    case "nearMe": return !!v;
    case "process": {
      const allowed=["proposal","public_process","adoption","effective","unstaged","hearing","auction_or_rfp","award_or_conveyance","scheduled","agenda","held","outcomes"];
      return allowed.includes(v)?v:null;
    }
    case "stage": { const s=typeof v==="string"?v.trim():""; return s&&s!=="all"?s.slice(0,40):null; }
    case "asset": { const s=typeof v==="string"?v.trim():""; return s&&s!=="all"?s.slice(0,40):null; }
    case "saleMethod": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["online_auction","public_auction","sealed_bid","rfp","lease_auction"].includes(s)?s:null;
    }
    case "priceBand": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["priced","under_10k","10k_100k","100k_plus"].includes(s)?s:null;
    }
    case "sort": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["closing_soon","newest","price_desc","price_asc"].includes(s)?s:null;
    }
    default: return null;
  }
}
function sanitizeDeepLinkFilter(lens, input){
  const fields = DEEPLINK_LENSES[lens] || DEEPLINK_LENSES.money;
  const f = input || {};
  const out = {};
  for(const name of fields) out[name] = deeplinkClampField(name, f[name]);
  if(!out.geographies?.length) delete out.geographies;
  if(!out.place_role) delete out.place_role;
  if(!out.activity) delete out.activity;
  if(!out.body) delete out.body;
  if(!out.access) delete out.access;
  if(!out.procurement_id) delete out.procurement_id;
  if(!out.processState) delete out.processState;
  if(!out.availability) delete out.availability;
  if(!out.provision_id) delete out.provision_id;
  if(!out.matter_ref) delete out.matter_ref;
  if(!out.matter_scope_version) delete out.matter_scope_version;
  if(out.minRemainingDays == null) delete out.minRemainingDays;
  if(f.text_query?.version===1) out.text_query=f.text_query;
  return out;
}

export {
  DEEPLINK_LENSES,
  DEEPLINK_CATEGORIES,
  DEEPLINK_BOROS,
  DEEPLINK_PROCESS_STATES,
  DEEPLINK_PLACE_ROLES,
  deeplinkClampField,
  sanitizeDeepLinkFilter,
};
