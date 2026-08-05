"""Round-two wave A: entity pages, pivots, method facet + regressions."""
import json, sys
from playwright.sync_api import sync_playwright
import os
from urllib.parse import unquote
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.cityscroll.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
SHOT = os.environ.get("CROL_SHOTS", os.path.dirname(os.path.abspath(__file__)) + "/shots") + "/"
os.makedirs(SHOT, exist_ok=True)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
with open(os.path.join(ROOT, "site", "data", "entity_intelligence_lookup.json"), encoding="utf-8") as f:
    ENTITY_INTELLIGENCE = json.load(f)
HPD_REF = "agency:id:housing-preservation-and-development"
HPD_CONNECTIONS = dict(ENTITY_INTELLIGENCE["by_ref"][HPD_REF])
HPD_CONNECTIONS["coverage"] = {
    "eligible": None,
    "linked": 18,
    "rate": None,
    "vintage": ENTITY_INTELLIGENCE["generated_at"],
    "gap": "eligible_denominator_not_measured",
    "tentative": 2,
}
HPD_CONNECTIONS["materialization_meta"] = {
    "generated_at": ENTITY_INTELLIGENCE["generated_at"],
    "observation_count": ENTITY_INTELLIGENCE["observation_count"],
}
for block in HPD_CONNECTIONS["domains"].values():
    objects = block.get("objects", [])
    block["strong_count"] = sum(o.get("confidence") == "strong" for o in objects)
    block["tentative_count"] = sum(o.get("confidence") == "tentative" for o in objects)
    for obj in objects:
        connections = []  # Source: committed entity-intelligence by_subject_ref fixture.
        for candidate in ENTITY_INTELLIGENCE.get("by_subject_ref", {}).get(obj.get("subject_ref"), []):
            ref = candidate.get("entity_ref", "")
            confidence = candidate.get("confidence")
            if ref == HPD_REF or confidence not in ("strong", "tentative"):
                continue
            if not (ref.startswith("agency:") or ref.startswith("vendor:stem:") or ref.startswith("entity:official:")):
                continue
            root = ENTITY_INTELLIGENCE.get("by_ref", {}).get(ref, {}).get("root", {})
            label = root.get("display_name") or (
                unquote(ref.removeprefix("vendor:stem:")) if ref.startswith("vendor:stem:") else ref
            )
            connections.append({
                "entity_ref": ref,
                "label": label,
                "relation": candidate.get("relation"),
                "confidence": confidence,
                "evidence": obj.get("provenance", {}).get("basis"),
            })
        obj["connected_entities"] = connections




results = []
def step(tag, name, detail=""):
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    ctx = browser.new_context()
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- load money, grab a real agency + vendor from awards ----------
    page.goto(BASE + "browse/contracts/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function(
        "document.querySelector('#tab-money').classList.contains('active')",
        timeout=30000,
    )
    page.locator("#money-more-filters > summary").click()
    page.locator("#mode").wait_for(state="visible", timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.select_option("#mode", "award")
    page.wait_for_function("currentRows.length && currentRows[0].type_of_notice_description==='Award'", timeout=30000)
    ent = page.evaluate("(()=>{const r=currentRows.find(r=>r.vendor_name&&r.agency_name)||currentRows[0]; return {request_id:r.request_id, agency:r.agency_name, vendor:r.vendor_name};})()")
    print("   sample entities:", ent, flush=True)

    # ---------- method facet ----------
    page.wait_for_function("document.getElementById('methodfacet').style.display !== 'none'", timeout=30000)
    chips = page.evaluate("[...document.querySelectorAll('#methodfacet .chip')].map(b=>b.dataset.m)")
    step("OK" if len(chips)>=2 else "FAIL", "N4 method facet renders", f"{len(chips)} methods: {chips[:3]}")
    page.locator("#methodfacet .chip").first.click()
    page.wait_for_function("document.querySelector('#methodfacet .chip.on') !== null", timeout=30000)
    page.wait_for_function("methodSel && currentRows.length && currentRows.every(r=>r.selection_method_description===methodSel)", timeout=30000)
    d = page.evaluate("""({m: methodSel, url: location.pathname + location.search + location.hash,
        allMatch: currentRows.every(r=>r.selection_method_description===methodSel),
        head: document.getElementById('reshead').textContent})""")
    step("OK" if d["m"] and d["allMatch"] and "m=" in d["url"] else "FAIL", "N4 method chip filters server-side + URL", json.dumps(d)[:180])
    page.locator("#methodfacet .chip.on").click()  # clear
    page.wait_for_function("methodSel === ''", timeout=30000)
    step("OK", "N4 method chip toggles off", "")

    # ---------- glance pivots on an award ----------
    page.wait_for_selector("#detail .glance", timeout=30000)
    piv = page.evaluate("""[...document.querySelectorAll('#detail .glance a.pivot')].map(a=>({
      href:a.getAttribute('href'), ref:a.dataset.entityRef, confidence:a.dataset.linkConfidence
    }))""")
    typed_agency = [p for p in piv if p["href"].startswith("/agencies/")]
    step("OK" if typed_agency and typed_agency[0]["ref"].startswith("agency:") and typed_agency[0]["confidence"]=="strong" else "FAIL", "N4 glance typed agency pivot", str(piv[:2]))

    # ---------- pivot round trip: click the rendered agency link ----------
    rendered_agency_pivot = page.locator("#detail .glance a.pivot[href^='/agencies/']").first
    rendered_agency_pivot.evaluate("a=>a.target='_blank'")
    with ctx.expect_page() as opened:
        rendered_agency_pivot.click()
    p2 = opened.value
    p2.wait_for_url("**/agencies/**", timeout=10000)
    p2.wait_for_selector("#entityview .agencybar", timeout=45000)
    agency_scope = p2.locator("#entityview [data-agency-id]").evaluate("el=>({id:el.dataset.agencyId,name:el.dataset.agencyName,variants:JSON.parse(el.dataset.agencyVariants)})")
    round_trip_ok = ent["agency"] in agency_scope["variants"] and p2.locator("#entityview .empty").count() == 0
    step("OK" if round_trip_ok else "FAIL", "agency pivot round trip contains origin record identity", json.dumps({"origin":ent["request_id"],"agency":ent["agency"],"scope":agency_scope}))
    txt = p2.locator("#entityview").inner_text()
    has = {"total": "TOTAL AWARDED" in txt.upper(), "sections": p2.locator("#entityview .chiprow .chip").count() > 0,
           "vendors": p2.locator("#entityview .ladder .lrow").count()}
    step("OK" if has["total"] and has["sections"] else "FAIL", "N2 agency page renders", json.dumps(has))
    # watch button carries the agency scope into the canonical Following document
    p2.locator('#entityview [data-aw="rules"]').click()
    p2.wait_for_url("**/following?**", timeout=10000)
    ag = p2.evaluate("""(() => {
      const q=new URLSearchParams(location.search), f=JSON.parse(q.get('filter')||'{}');
      return {lens:q.get('lens'), agency:f.agency};
    })()""")
    step("OK" if ag["lens"]=="rules" and ag["agency"]==agency_scope["name"] else "FAIL", "N2 agency watch prefill", json.dumps(ag))
    p2.screenshot(path=SHOT + "agency.png", full_page=True)

    # pivot chain: agency page -> top vendor -> vendor page
    p2.goto(typed_agency[0]["href"] if typed_agency[0]["href"].startswith("http") else BASE.rstrip("/") + typed_agency[0]["href"], timeout=30000)
    p2.wait_for_selector("#entityview .agencybar", timeout=45000)
    if p2.locator("#entityview .ladder a.pivot").count():
        vendor_pivot = p2.locator("#entityview .ladder a.pivot").first
        vname = vendor_pivot.inner_text()
        vtyped = vendor_pivot.evaluate("a=>({ref:a.dataset.entityRef, confidence:a.dataset.linkConfidence})")
        step("OK" if vtyped["ref"].startswith("vendor:stem:") and vtyped["confidence"]=="strong" else "FAIL", "N1 typed vendor pivot metadata", json.dumps(vtyped))
        vendor_pivot.click()
        p2.wait_for_function("location.pathname.startsWith('/vendors/')", timeout=10000)
        p2.wait_for_function("document.querySelector('#entityview .ftype')?.textContent.includes('Vendor profile') || (document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading'))", timeout=45000)
        vtxt = p2.locator("#entityview").inner_text()
        step("OK" if "VENDOR PROFILE" in vtxt.upper() else "FAIL",
             "N1 agency→vendor pivot chain", f"clicked {vname!r}")
    else:
        step("WARN", "N1 agency→vendor pivot chain", "no vendor bars for this agency")
    p2.close()

    # ---------- agency connection scopes (deterministic five-domain HPD field case) ----------
    p5 = ctx.new_page()
    p5.route(
        "**/entity-intelligence?*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(HPD_CONNECTIONS),
        ),
    )
    p5.goto(BASE + "#agency/Housing%20Preservation%20and%20Development", timeout=30000)
    p5.wait_for_selector("#entity-intelligence .ei-summary", timeout=45000)
    matched_domains = p5.locator('#entity-intelligence .ei-domain[data-status="matched"]').count()
    summary = p5.locator("#entity-intelligence .ei-summary").inner_text()
    tentative_bands = p5.locator(
        '#entity-intelligence .ei-domain[data-domain="land"] .entity-pivot-band'
    ).count()
    connected_pivots = p5.evaluate("""[...document.querySelectorAll(
      '#entity-intelligence .ei-domain[data-domain="money"] .ei-connections a.entity-pivot'
    )].map(a=>({href:a.getAttribute('href'),ref:a.dataset.entityRef,
      confidence:a.dataset.linkConfidence,relation:a.dataset.relation}))""")
    step(
        "OK" if matched_domains == 5 and "18" in summary and "2" in summary and tentative_bands == 2
        and connected_pivots and connected_pivots[0]["href"].startswith("#vendor/")
        and connected_pivots[0]["ref"].startswith("vendor:stem:")
        and connected_pivots[0]["confidence"] == "strong"
        and connected_pivots[0]["relation"] == "named_vendor" else "FAIL",
        "gc-02 HPD connections separate verified and possible records",
        json.dumps({"domains": matched_domains, "summary": summary, "tentative": tentative_bands,
                    "connections": connected_pivots[:2]}),
    )
    p5.screenshot(path=SHOT + "agency-connections.png", full_page=True)
    money_scope = p5.locator(
        '#entity-intelligence .ei-domain[data-domain="money"] .ei-view-all'
    )
    legacy_scope_href = money_scope.get_attribute("href")
    money_scope.click()
    p5.wait_for_function("""() => {
      const q=new URLSearchParams(location.search);
      return location.pathname==='/browse/contracts/' && q.get('mode')==='award' && q.has('facet')
        && globalThis.CrolScope && typeof serializeState==='function'
        && document.querySelector('#tab-money').classList.contains('active');
    }""")
    canonical_url = p5.url
    canonical_route = p5.evaluate("""(() => ({
      pathname:location.pathname, search:location.search, hash:location.hash
    }))()""")
    scope_state = p5.evaluate("""(() => {
      const s=CrolScope.scopeFromRouteHash(serializeState());
      return {agency:s.facets.agencies[0], refs:s.facets.values.entity_refs_all,
        relation:s.facets.values.connection_relation, mode:s.facets.values.mode};
    })()""")
    p5.goto(canonical_url, wait_until="domcontentloaded", timeout=30000)
    p5.wait_for_function("""() => {
      const q=new URLSearchParams(location.search);
      if (location.pathname!=='/browse/contracts/' || q.get('mode')!=='award' || !q.has('facet')
          || !globalThis.CrolScope || typeof serializeState!=='function'
          || !document.querySelector('#tab-money').classList.contains('active')) return false;
      const s=CrolScope.scopeFromRouteHash(serializeState());
      return s.facets.agencies[0]==='Housing Preservation and Development'
        && s.facets.values.entity_refs_all?.[0]==='agency:id:housing-preservation-and-development'
        && s.facets.values.connection_relation==='published_by_agency'
        && s.facets.values.mode==='award';
    }""")
    reloaded_scope = p5.evaluate("""(() => {
      const s=CrolScope.scopeFromRouteHash(serializeState());
      return {agency:s.facets.agencies[0], refs:s.facets.values.entity_refs_all,
        relation:s.facets.values.connection_relation, mode:s.facets.values.mode};
    })()""")
    step(
        "OK" if scope_state == reloaded_scope
        and legacy_scope_href.startswith("#money?")
        and canonical_route["pathname"] == "/browse/contracts/"
        and canonical_route["hash"] == ""
        and scope_state["agency"] == "Housing Preservation and Development"
        and scope_state["refs"] == [HPD_REF]  # Source: committed entity-intelligence lookup.
        and scope_state["relation"] == "published_by_agency"
        and scope_state["mode"] == "award" else "FAIL",
        "gc-02 connection scope survives reload",
        json.dumps({"legacy": legacy_scope_href, "canonical": canonical_route,
                    "before": scope_state, "after": reloaded_scope}),
    )
    p5.close()

    # ---------- vendor page direct, with variant resolution ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#vendor/" + ent["vendor"].replace(" ", "%20"), timeout=30000)
    p3.wait_for_url("**/vendors/**", timeout=10000)
    p3.wait_for_selector("#entityview .agencybar, #entityview .empty:not(:has(.loading))", timeout=45000)
    p3.wait_for_function("document.querySelector('#entityview .ftype')?.textContent.includes('Vendor profile') || (document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading'))", timeout=45000)
    vt = p3.locator("#entityview").inner_text()
    ok = "TOTAL AWARDED" in vt.upper() and "VARIANT" in vt.upper()
    step("OK" if ok else "FAIL", "N1 vendor page resolves + renders", vt[:120].replace("\n"," | "))
    # agencies-they-win-from chips pivot back
    backs = p3.evaluate("[...document.querySelectorAll('#entityview a.chip')].map(a=>a.getAttribute('href'))")
    step("OK" if backs and all(h.startswith('/agencies/') for h in backs) else "WARN", "N1 vendor→agency pivot chips", str(len(backs)))
    p3.screenshot(path=SHOT + "vendor.png", full_page=True)
    # probe: garbage vendor
    p3.goto(BASE + "vendors/ZZZXQJ%20NONEXISTENT/", timeout=30000)
    p3.wait_for_function("document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading')", timeout=45000)
    step("PROBE", "vendor not-found path", p3.locator("#entityview .empty").inner_text()[:80])
    # probe: too-short vendor
    p3.goto(BASE + "vendors/AB/", timeout=30000)
    p3.wait_for_function("document.querySelector('#entityview .empty') && document.querySelector('#entityview .empty').textContent.includes('too short')", timeout=15000)
    step("PROBE", "too-short vendor stem", "clean message")
    p3.close()

    # ---------- feed card agency pivot ----------
    p4 = ctx.new_page()
    p4.goto(BASE + "browse/rules/", timeout=30000)
    p4.wait_for_selector("#rulesfeed .fcard", timeout=30000)
    p4.locator("#rulesfeed .fcard .ftype a.pivot").first.click()
    p4.wait_for_function("location.pathname.startsWith('/agencies/')", timeout=10000)
    p4.wait_for_selector("#entityview .agencybar, #entityview .empty:not(:has(.loading))", timeout=45000)
    step("OK" if p4.locator("#entityview .agencybar").count() else "FAIL", "N4 feed-card agency pivot", p4.evaluate("location.pathname")[:60])
    p4.close()

    # ---------- legacy display-name arrival resolves instead of dead-ending ----------
    p5 = ctx.new_page()
    p5.goto(BASE + "#agency/Design%20and%20Construction%20(DDC)", timeout=30000)
    p5.wait_for_url("**/agencies/design-and-construction/", timeout=10000)
    p5.wait_for_selector("#entityview [data-agency-id='design-and-construction'] .agencybar", timeout=45000)
    step("OK" if p5.locator("#entityview .empty").count() == 0 else "FAIL", "legacy DDC display route recovers", p5.evaluate("location.pathname"))
    p5.goto(BASE + "agencies/zzzxqj-nonexistent-agency/", timeout=30000)
    p5.wait_for_function("document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading')", timeout=45000)
    fallback = p5.locator("#entityview .empty a[href^='/browse/contracts/?q=']")
    step("OK" if fallback.count() == 1 else "FAIL", "unknown agency offers honest search recovery", p5.locator("#entityview .empty").inner_text()[:100])
    p5.close()

    # ---------- regressions ----------
    page.select_option("#mode", "open")
    page.wait_for_selector("#list .row", timeout=30000)
    page.click("#closingweek")
    page.wait_for_function("document.getElementById('reshead').textContent.includes('closing this week')", timeout=30000)
    page.click("#closingweek")
    step("OK", "regression: closing-week", "")
    strip = page.evaluate("!!document.getElementById('homeCta')")
    step("OK" if strip else "FAIL", "regression: today strip", "")
    page.goto(BASE + "browse/staffing/", timeout=30000)
    page.wait_for_selector("#career-area-watches .career-area-watch", timeout=15000)
    step("OK" if page.locator("#career-area-watches .career-area-watch").count()>=7 else "FAIL", "regression: staffing interest areas", "")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
