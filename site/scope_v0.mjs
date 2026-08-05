export const SCOPE_SCHEMA="cityscroll.scope",SCOPE_VERSION=0;const M=Object.freeze(["Manhattan","Brooklyn","Queens","Bronx","Staten Island"]),O=new Set(["money","people","land","property","rules","meetings","entity","award","district"]),E=new Set(["money","people","land","property","rules","meetings","map","now","alerts"]),A=new Set(["citywide-unlocated","citywide","virtual","unlocated"]);function l(i,n=240){return i==null?null:String(i).replace(/\s+/g," ").trim().slice(0,n)||null}function w(i,n=20){return[...new Set((Array.isArray(i)?i:i==null?[]:[i]).map(o=>l(o)).filter(Boolean))].slice(0,n)}function B(i){const n={};if(!i||typeof i!="object"||Array.isArray(i))return n;for(const[o,t]of Object.entries(i))t==null||t===""||Array.isArray(t)&&t.length===0||(n[o]=t);return n}function j(i){return l(i,20)||"en"}function q(i){const n=l(i,8)?.toUpperCase()||null;return n&&/^(?:M|X|K|Q|R)\d{2}$/.test(n)?n:null}function k(i){const n=l(i,4);return n&&/^(?:[1-9]|[1-4]\d|5[01])$/.test(n)?n:null}function x(i){const n=l(i,40);return M.find(o=>o.toLowerCase()===n?.toLowerCase())||null}function v(i){const n=i&&typeof i=="object"&&!Array.isArray(i)?i:{},o=["borough","community_district","council_district"].includes(n.level)?n.level:"borough",t=Array.isArray(n.view_box)&&n.view_box.length===4&&n.view_box.every(e=>Number.isFinite(Number(e)))?n.view_box.map(Number):null;return{level:o,id:l(n.id,80),parent:l(n.parent,80),basis:l(n.basis,80)||"performance",view_box:t}}export function emptyScope(i="en"){return{schema:SCOPE_SCHEMA,version:0,place:{boroughs:[],community_districts:[],council_districts:[],neighborhood:null,location_scope:null,viewport:null},time_window:{preset:null,start:null,end:null,rolling_months:null},topic:{query:null,keywords:[]},facets:{domains:[],agencies:[],actions:[],values:{}},language:j(i)}}export function normalizeScope(i,{language:n}={}){const o=i&&typeof i=="object"&&!Array.isArray(i)?i:{},t=o.place&&typeof o.place=="object"?o.place:{},e=o.time_window&&typeof o.time_window=="object"?o.time_window:{},c=o.topic&&typeof o.topic=="object"?o.topic:{},r=o.facets&&typeof o.facets=="object"?o.facets:{},u=w(t.boroughs).map(x).filter(Boolean),d=w(t.community_districts).map(q).filter(Boolean),f=w(t.council_districts).map(k).filter(Boolean),g=l(t.location_scope,40),m=Number(e.rolling_months);return{schema:SCOPE_SCHEMA,version:0,place:{boroughs:[...new Set(u)],community_districts:[...new Set(d)],council_districts:[...new Set(f)],neighborhood:l(t.neighborhood,80),location_scope:A.has(g)?g:null,viewport:t.viewport?v(t.viewport):null},time_window:{preset:l(e.preset,40),start:l(e.start,32),end:l(e.end,32),rolling_months:Number.isFinite(m)&&m>0&&m<=60?Math.round(m):null},topic:{query:l(c.query,320),keywords:w(c.keywords,8)},facets:{domains:w(r.domains).filter(h=>O.has(h)),agencies:w(r.agencies,8),actions:w(r.actions,8),values:B(r.values)},language:j(n||o.language)}}export function scopeHasConstraints(i){const n=normalizeScope(i);return!!(n.place.boroughs.length||n.place.community_districts.length||n.place.council_districts.length||n.place.neighborhood||n.place.location_scope||n.time_window.preset||n.time_window.start||n.time_window.end||n.time_window.rolling_months||n.topic.query||n.topic.keywords.length||n.facets.domains.length||n.facets.agencies.length||n.facets.actions.length||Object.keys(n.facets.values).length)}function C(i){const n=String(i||"").replace(/^#/,""),o=n.indexOf("?"),t=(o<0?n:n.slice(0,o)).replace(/\/$/,"");return{surface:E.has(t)?t:null,params:new URLSearchParams(o<0?"":n.slice(o+1))}}const L=Object.freeze({mode:"mode",sort:"sort",min:"minAmount",max:"maxAmount",category:"category",standard:"excludeSpecial",m:"method",basis:"basis",actionBasis:"actionBasis",status:"status",attendance:"attendance",view:"view",role:"role",interest:"interest",eligibility:"eligibility",window:"window",format:"format",salary:"salary",fee:"fee",experience:"experience",type:"type",process:"process",group:"group",asset:"asset",method:"saleMethod",price:"priceBand",stage:"stage",lookupType:"lookupType",kind:"kind",name:"name",tab:"tab",noticeType:"noticeType",route:"route",nearMe:"nearMe"}),R=new Set(["minAmount","maxAmount"]),P=new Set(["excludeSpecial","nearMe"]),F=Object.freeze({money:new Set(["mode","sort","minAmount","maxAmount","category","excludeSpecial","method","basis","actionBasis"]),people:new Set(["type","mode","role","view","interest","eligibility","window","format","salary","fee","experience"]),land:new Set(["status","attendance"]),property:new Set(["asset","saleMethod","priceBand","sort","process","stage","view"]),rules:new Set(["process"]),meetings:new Set(["process","group"])});function U(i,n,o){const t=L[n];if(!(!t||o==null||o===""))if(R.has(t)){const e=Number(o);Number.isFinite(e)&&(i[t]=e)}else P.has(t)?i[t]=o==="1"||o==="true":i[t]=o}export function scopeFromRouteHash(i,{language:n="en"}={}){const{surface:o,params:t}=C(i),e=emptyScope(n);if(!o)return e;const c=o==="map"?t.get("lens"):null,r=o==="now"?t.get("lens"):null,u=o==="alerts"?t.get("lens"):o,d=c||r||u;O.has(d)&&(e.facets.domains=[d]);const f=l(t.get("q"),320);f&&(e.topic.query=f,e.topic.keywords=[f]);const g=l(t.get("agency"),160);g&&(e.facets.agencies=[g]);const m=x(t.get("boro"));m&&(e.place.boroughs=[m]);const h=q(t.get("cd"));h&&(e.place.community_districts=[h]);const b=k(t.get("council"));b&&(e.place.council_districts=[b]),e.place.neighborhood=l(t.get("neighborhood"),80);const a=t.get("scope");A.has(a)&&(e.place.location_scope=a),e.time_window.preset=l(t.get("when")||(t.get("closing")?`closing:${t.get("closing")}`:null),40);const y=Number(t.get("months"));Number.isFinite(y)&&y>0&&y<=60&&(e.time_window.rolling_months=Math.round(y));const _=l(t.get("action"),80);_&&(e.facets.actions=[_]);for(const S of t.keys())U(e.facets.values,S,t.get(S));const N=t.get("facet");if(N&&N.length<=2e3)try{Object.assign(e.facets.values,B(JSON.parse(N)))}catch{}if(o==="map"){delete e.facets.values.basis,e.place.viewport=v({level:t.get("level")||"borough",id:t.get("id"),parent:t.get("parent"),basis:t.get("basis")||"performance"});const S=scopeFromMapState({...e.place.viewport,lens:c||"all"}).place;e.place.boroughs.length||(e.place.boroughs=S.boroughs),e.place.community_districts.length||(e.place.community_districts=S.community_districts),e.place.council_districts.length||(e.place.council_districts=S.council_districts),e.place.location_scope||(e.place.location_scope=S.location_scope)}return normalizeScope(e)}function p(i){return Array.isArray(i)&&i.length?i[0]:null}function s(i,n,o,t=Boolean){t(o)&&i.set(n,String(o))}function V(i){return i.facets.values||{}}export function routeHashFromScope(i,{surface:n}={}){const o=normalizeScope(i),t=E.has(n)?n:p(o.facets.domains)||"money",e=new URLSearchParams,c=V(o),r=o.topic.query||p(o.topic.keywords),u=p(o.facets.agencies),d=p(o.place.boroughs),f=p(o.place.community_districts),g=p(o.place.council_districts),m=o.place.location_scope,h=o.time_window.preset;if(t==="money")s(e,"mode",c.mode,a=>a&&a!=="open"),s(e,"agency",u),s(e,"q",r),s(e,"sort",c.sort,a=>a&&a!=="deadline"),s(e,"min",c.minAmount,a=>Number(a)>=1e3),s(e,"max",c.maxAmount,a=>Number(a)>=1e3),s(e,"category",c.category),s(e,"months",o.time_window.rolling_months),c.excludeSpecial===!0&&e.set("standard","1"),h?.startsWith("closing:")&&e.set("closing",h.slice(8)),s(e,"m",c.method),c.basis==="contract_action_address"&&(e.set("basis","contract_action_address"),s(e,"actionBasis",c.actionBasis),s(e,"boro",d),s(e,"cd",f),s(e,"council",g));else if(t==="people")s(e,"type",c.type),c.mode==="person"&&e.set("mode","person"),s(e,"q",r),s(e,"role",c.role),s(e,"agency",u),s(e,"view",c.view),s(e,"interest",c.interest),s(e,"eligibility",c.eligibility),s(e,"window",c.window),s(e,"format",c.format),s(e,"salary",c.salary),s(e,"fee",c.fee),s(e,"experience",c.experience);else if(t==="land")s(e,"boro",d),s(e,"cd",f),s(e,"council",g),s(e,"q",r),s(e,"status",c.status,a=>a&&a!=="active"),c.status==="hearings"&&s(e,"attendance",c.attendance);else if(["property","rules","meetings"].includes(t))s(e,"agency",u),s(e,"q",r),t==="meetings"&&(s(e,"when",h,a=>a&&a!=="week"),m?e.set("scope",m):s(e,"boro",d),s(e,"neighborhood",o.place.neighborhood),s(e,"process",c.process,a=>a&&a!=="all"),c.group==="place"&&e.set("group","place")),t==="property"&&(s(e,"boro",d),s(e,"neighborhood",o.place.neighborhood),s(e,"cd",f),s(e,"asset",c.asset,a=>a&&a!=="all"),s(e,"method",c.saleMethod,a=>a&&a!=="all"),s(e,"price",c.priceBand,a=>a&&a!=="all"),s(e,"sort",c.sort,a=>a&&a!=="closing_soon"),s(e,"process",c.process,a=>a&&a!=="all"),s(e,"stage",c.stage,a=>a&&a!=="all"),s(e,"view",c.view)),t==="rules"&&(s(e,"process",c.process,a=>a&&a!=="all"),m==="citywide"?e.set("scope","citywide"):s(e,"boro",d));else if(t==="map"){const a=mapStateFromScope(o);s(e,"level",a.level,_=>_&&_!=="borough"),s(e,"id",a.id),s(e,"parent",a.parent);const y=p(o.facets.domains);s(e,"lens",y,_=>_&&_!=="all"),y==="money"&&a.basis==="contract_action_address"&&e.set("basis",a.basis),s(e,"q",r),s(e,"agency",u),s(e,"when",h),s(e,"action",p(o.facets.actions)),Object.keys(c).length&&e.set("facet",JSON.stringify(c))}else t==="now"&&(s(e,"lens",p(o.facets.domains)),s(e,"boro",d),s(e,"cd",f),s(e,"council",g),s(e,"scope",m),s(e,"q",r),s(e,"agency",u),s(e,"when",h),s(e,"action",p(o.facets.actions)),Object.keys(c).length&&e.set("facet",JSON.stringify(c)));if(F[t]){e.has("boro")||s(e,"boro",d),e.has("cd")||s(e,"cd",f),e.has("council")||s(e,"council",g),e.has("neighborhood")||s(e,"neighborhood",o.place.neighborhood),e.has("scope")||s(e,"scope",m),e.has("agency")||s(e,"agency",u),e.has("q")||s(e,"q",r),!e.has("when")&&h&&!h.startsWith("closing:")&&e.set("when",h),e.has("months")||s(e,"months",o.time_window.rolling_months),s(e,"action",p(o.facets.actions));const a=Object.fromEntries(Object.entries(c).filter(([y])=>!F[t].has(y)));Object.keys(a).length&&e.set("facet",JSON.stringify(a))}const b=e.toString();return`#${t}${b?`?${b}`:""}`}export function scopeFromLensState(i,n={},{language:o="en"}={}){const t=n&&typeof n=="object"?n:{},e=emptyScope(o);O.has(i)&&(e.facets.domains=[i]);const c=w(t.keywords||(t.q?[t.q]:[]),8);e.topic.keywords=c,e.topic.query=l(t.q,320)||p(c);const r=l(t.agency,160);r&&(e.facets.agencies=[r]);const u=x(t.borough||t.boro);u&&(e.place.boroughs=[u]);const d=q(t.communityDistrict||t.cd);d&&(e.place.community_districts=[d]);const f=k(t.councilDistrict||t.council);f&&(e.place.council_districts=[f]),e.place.neighborhood=l(t.neighborhood,80),A.has(t.locationScope)&&(e.place.location_scope=t.locationScope),e.time_window.preset=l(t.dateWindow||t.when,40);const g=Number(t.months);Number.isFinite(g)&&g>0&&g<=60&&(e.time_window.rolling_months=Math.round(g));const m=t.action?[t.action]:t.actions;e.facets.actions=w(m,8);const h=new Set(["q","keywords","agency","borough","boro","communityDistrict","cd","councilDistrict","council","neighborhood","locationScope","dateWindow","when","months","action","actions"]);for(const[b,a]of Object.entries(t))!h.has(b)&&a!=null&&a!==""&&(e.facets.values[b]=a);return normalizeScope(e)}export function lensStateFromScope(i,n){const o=normalizeScope(i),t={...o.facets.values},e=[...o.topic.keywords];!e.length&&o.topic.query&&e.push(o.topic.query);const c={...t,keywords:e};o.topic.query&&(c.q=o.topic.query);const r=p(o.facets.agencies);r&&(c.agency=r);const u=p(o.place.boroughs);u&&(c.borough=u,n==="land"&&(c.boro=u));const d=p(o.place.community_districts);d&&(c.communityDistrict=d);const f=p(o.place.council_districts);return f&&(c.councilDistrict=f),o.place.neighborhood&&(c.neighborhood=o.place.neighborhood),o.place.location_scope&&(c.locationScope=o.place.location_scope),o.time_window.preset&&(c.when=o.time_window.preset,c.dateWindow=o.time_window.preset),o.time_window.rolling_months&&(c.months=o.time_window.rolling_months),o.facets.actions.length&&(c.actions=[...o.facets.actions]),c}export function scopeFromMapState(i={},{language:n="en",viewBox:o=null}={}){const t=emptyScope(n),e=l(i.lens,40);O.has(e)&&(t.facets.domains=[e]);const c=v({...i,view_box:o});if(t.place.viewport=c,c.level==="borough"){const r=x(c.id||c.parent);r&&(t.place.boroughs=[r])}else if(c.level==="community_district"){const r=q(c.id);r&&(t.place.community_districts=[r]);const u=x(c.parent);u&&(t.place.boroughs=[u])}else if(c.level==="council_district"){const r=k(c.id);r&&(t.place.council_districts=[r])}return A.has(c.id)&&(t.place.location_scope=c.id),normalizeScope(t)}export function mapStateFromScope(i){const n=normalizeScope(i);let o=n.place.viewport;if(!o){const t=p(n.place.community_districts),e=p(n.place.council_districts),c=p(n.place.boroughs);t?o=v({level:"community_district",id:t,parent:c}):e?o=v({level:"council_district",id:e}):c?o=v({level:"borough",id:c}):n.place.location_scope?o=v({level:"borough",id:n.place.location_scope}):o=v({})}return{level:o.level,id:o.id,parent:o.parent,lens:p(n.facets.domains)||"all",basis:o.basis,viewBox:o.view_box}}export function scopeWithMapState(i,n={},{language:o,viewBox:t=null}={}){const e=normalizeScope(i,{language:o}),c=scopeFromMapState(n,{language:o||e.language,viewBox:t});return e.place={...e.place,boroughs:c.place.boroughs,community_districts:c.place.community_districts,council_districts:c.place.council_districts,location_scope:c.place.location_scope,viewport:c.place.viewport},e.facets.domains=c.facets.domains,normalizeScope(e)}export function scopeFromWatch(i={},{language:n="en"}={}){return scopeFromLensState(l(i.lens,40),i.filter||{},{language:n})}export function watchFromScope(i,{lens:n}={}){const o=normalizeScope(i),t=l(n,40)||p(o.facets.domains)||"money",e=lensStateFromScope(o,t);return delete e.q,e.actions?.length&&(e.action=e.actions[0]),delete e.actions,{lens:t,filter:B(e)}}export function scopeFromPreset(i,{language:n="en"}={}){return scopeFromRouteHash(i?.hash,{language:n})}export function presetFromScope(i,{label:n,lens:o}={}){const t=normalizeScope(i),e=l(o,40)||p(t.facets.domains)||"money";return{label:l(n,100)||e,hash:routeHashFromScope(t,{surface:e})}}export function subscriptionFromScope(i,n={},{lens:o}={}){const t=watchFromScope(i,{lens:o});return{...n,lens:t.lens,filter:t.filter,lang:normalizeScope(i).language}}

export const NEAR_YOU_COMMON_LENSES = Object.freeze(["meetings", "land", "property", "rules", "money"]);
export const NEAR_YOU_COMMON_BOROUGHS = Object.freeze(["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]);

function nearYouSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
/** Resolve common bounded scopes to their built documents; leave every uncommon scope to the edge. */
export function commonNearYouPath(input) {
  const scope = normalizeScope(input);
  const lens = scope.facets.domains?.[0] || "meetings";
  const borough = scope.place.boroughs?.[0] || null;
  const viewport = scope.place.viewport;
  const commonViewport = !viewport || ((!viewport.basis || viewport.basis === "performance")
    && !viewport.id
    && !viewport.view_box
    && (borough
      ? (!viewport.level || viewport.level === "community_district") && (!viewport.parent || viewport.parent === borough)
      : (!viewport.level || viewport.level === "borough") && !viewport.parent));
  const hasOtherPlace = scope.place.community_districts?.length
    || scope.place.council_districts?.length
    || scope.place.location_scope
    || scope.place.neighborhood;
  const hasOtherScope = scope.facets.agencies?.length
    || scope.facets.actions?.length
    || Object.keys(scope.facets.values || {}).length
    || scope.topic.query
    || scope.topic.keywords?.length
    || scope.time_window.preset
    || scope.time_window.start
    || scope.time_window.end
    || scope.time_window.rolling_months;
  if (scope.language !== "en" || !NEAR_YOU_COMMON_LENSES.includes(lens)
    || hasOtherPlace || hasOtherScope || !commonViewport) return null;
  if (borough && !NEAR_YOU_COMMON_BOROUGHS.includes(borough)) return null;
  if (!borough) return lens === "meetings" ? "/near-you/" : `/near-you/lens/${lens}/`;
  const base = `/near-you/borough/${nearYouSlug(borough)}/`;
  return lens === "meetings" ? base : `${base}${lens}/`;
}

/** Serialize one shared scope into the versioned Near-you GET contract. */
export function nearYouUrlFromScope(input, { base = "/near-you/" } = {}) {
  const scope = normalizeScope(input);
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(base);
  const url = new URL(base, "https://cityscroll.invalid");
  const params = url.searchParams;
  params.set("v", String(scope.version));
  const first = (values) => Array.isArray(values) && values.length ? values[0] : null;
  const set = (name, value) => {
    if (value != null && value !== "") params.set(name, String(value));
  };
  set("lens", first(scope.facets.domains));
  set("q", scope.topic.query || first(scope.topic.keywords));
  set("agency", first(scope.facets.agencies));
  set("boro", first(scope.place.boroughs));
  set("cd", first(scope.place.community_districts));
  set("council", first(scope.place.council_districts));
  set("neighborhood", scope.place.neighborhood);
  set("scope", scope.place.location_scope);
  set("level", scope.place.viewport?.level && scope.place.viewport.level !== "borough"
    ? scope.place.viewport.level
    : null);
  set("id", scope.place.viewport?.id);
  set("parent", scope.place.viewport?.parent);
  const basis = scope.place.viewport?.basis || scope.facets.values?.basis;
  if (basis === "contract_action_address" && first(scope.facets.domains) === "money") set("basis", basis);
  set("when", scope.time_window.preset);
  set("months", scope.time_window.rolling_months);
  set("action", first(scope.facets.actions));
  const values = { ...(scope.facets.values || {}) };
  delete values.basis;
  if (values.type && Object.keys(values).length === 1) set("type", values.type);
  else if (Object.keys(values).length) params.set("facet", JSON.stringify(values));
  if (scope.language && scope.language !== "en") params.set("lang", scope.language);
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

const sortedUnique = (values) => [...new Set((values || []).map(String).filter(Boolean))].sort();
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function routableEntityRef(value) {
  const ref = String(value || "").trim();
  if (!ref || /\s/.test(ref)) return null;
  if (/^agency:[^:]+:.+$/.test(ref)) return ref;
  if (/^vendor:stem:.+$/.test(ref)) return ref;
  if (/^entity:official:.+$/.test(ref)) return ref;
  return null;
}

/** Add one required, typed entity constraint without creating mutable scope state. */
export function scopeWithEntity(input, ref) {
  const scope = normalizeScope(input);
  const entityRef = routableEntityRef(ref);
  if (!entityRef) return scope;
  const current = Array.isArray(scope.facets.values.entity_refs_all)
    ? scope.facets.values.entity_refs_all.map(routableEntityRef).filter(Boolean)
    : [];
  scope.facets.values.entity_refs_all = sortedUnique([...current, entityRef]);
  return normalizeScope(scope);
}

function meetAllowlist(left, right, markBottom) {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  if (!a.length) return b;
  if (!b.length) return a;
  const allowed = new Set(b);
  const met = a.filter((value) => allowed.has(value));
  if (!met.length) markBottom();
  return met;
}

function meetScalar(left, right, markBottom) {
  if (left == null || left === "") return right ?? null;
  if (right == null || right === "") return left ?? null;
  if (sameValue(left, right)) return left;
  markBottom();
  return null;
}

/**
 * Meet two supported structured scopes. Independent axes conjoin, OR-like
 * allowlists intersect, all-keyword and all-entity constraints union, and a
 * contradiction remains a serializable bottom scope via match_none.
 */
export function intersectScopes(leftInput, rightInput) {
  const left = normalizeScope(leftInput);
  const right = normalizeScope(rightInput);
  const language = left.language === right.language
    ? left.language
    : left.language === "en"
      ? right.language
      : right.language === "en"
        ? left.language
        : [left.language, right.language].sort()[0];
  const out = emptyScope(language);
  let bottom = Boolean(left.facets.values.match_none || right.facets.values.match_none);
  const markBottom = () => { bottom = true; };

  out.place.boroughs = meetAllowlist(left.place.boroughs, right.place.boroughs, markBottom);
  out.place.community_districts = meetAllowlist(
    left.place.community_districts,
    right.place.community_districts,
    markBottom,
  );
  out.place.council_districts = meetAllowlist(
    left.place.council_districts,
    right.place.council_districts,
    markBottom,
  );
  out.place.neighborhood = meetScalar(left.place.neighborhood, right.place.neighborhood, markBottom);
  out.place.location_scope = meetScalar(
    left.place.location_scope,
    right.place.location_scope,
    markBottom,
  );
  out.place.viewport = meetScalar(left.place.viewport, right.place.viewport, markBottom);

  out.time_window.preset = meetScalar(
    left.time_window.preset,
    right.time_window.preset,
    markBottom,
  );
  out.time_window.start = [left.time_window.start, right.time_window.start]
    .filter(Boolean).sort().at(-1) || null;
  out.time_window.end = [left.time_window.end, right.time_window.end]
    .filter(Boolean).sort()[0] || null;
  if (out.time_window.start && out.time_window.end
      && out.time_window.start > out.time_window.end) markBottom();
  const rolling = [left.time_window.rolling_months, right.time_window.rolling_months]
    .filter((value) => Number.isFinite(value));
  out.time_window.rolling_months = rolling.length ? Math.min(...rolling) : null;

  out.topic.query = meetScalar(left.topic.query, right.topic.query, () => {
    markBottom();
    out.facets.values.composition_unsupported = ["topic.query"];
  });
  out.topic.keywords = sortedUnique([...left.topic.keywords, ...right.topic.keywords]);

  out.facets.domains = meetAllowlist(left.facets.domains, right.facets.domains, markBottom);
  out.facets.agencies = meetAllowlist(left.facets.agencies, right.facets.agencies, markBottom);
  out.facets.actions = meetAllowlist(left.facets.actions, right.facets.actions, markBottom);

  const leftValues = left.facets.values || {};
  const rightValues = right.facets.values || {};
  const entityRefs = sortedUnique([
    ...(Array.isArray(leftValues.entity_refs_all) ? leftValues.entity_refs_all : []),
    ...(Array.isArray(rightValues.entity_refs_all) ? rightValues.entity_refs_all : []),
  ].map(routableEntityRef).filter(Boolean));
  if (entityRefs.length) out.facets.values.entity_refs_all = entityRefs;

  const unsupported = sortedUnique([
    ...(out.facets.values.composition_unsupported || []),
    ...(Array.isArray(leftValues.composition_unsupported)
      ? leftValues.composition_unsupported : []),
    ...(Array.isArray(rightValues.composition_unsupported)
      ? rightValues.composition_unsupported : []),
  ]);
  if (unsupported.length) out.facets.values.composition_unsupported = unsupported;

  const reserved = new Set(["entity_refs_all", "match_none", "composition_unsupported"]);
  const valueKeys = sortedUnique([...Object.keys(leftValues), ...Object.keys(rightValues)])
    .filter((key) => !reserved.has(key));
  for (const key of valueKeys) {
    const a = leftValues[key];
    const b = rightValues[key];
    if (a == null || a === "") out.facets.values[key] = b;
    else if (b == null || b === "") out.facets.values[key] = a;
    else if (Array.isArray(a) && Array.isArray(b)) {
      const met = meetAllowlist(a, b, markBottom);
      if (met.length) out.facets.values[key] = met;
    } else if (sameValue(a, b)) out.facets.values[key] = a;
    else markBottom();
  }

  if (bottom) out.facets.values.match_none = true;
  return normalizeScope(out);
}
