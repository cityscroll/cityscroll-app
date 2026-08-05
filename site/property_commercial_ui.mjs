const ASSET_LABEL = {
  vehicle: "asset_vehicle",
  timber: "asset_timber",
  equipment: "asset_equipment",
  real_property: "asset_real_property",
  scrap_materials: "asset_scrap_materials",
  seized_property: "asset_seized_property",
  rights_and_interests: "asset_rights_and_interests",
  other: "asset_other",
};

/** Structured commercial-card markup shared by every notice entry path. */
export function renderPropertyCommercialDetail(commercial, helpers = {}) {
  if (!commercial?.item) return "";
  const t = helpers.t || ((key) => key);
  const esc = helpers.escape || ((value) => String(value || ""));
  const priceBadge = helpers.priceBadge || ((_kind, amount) => amount);
  const timedEventsHTML = helpers.timedEventsHTML || (() => "");
  const fallbackSaleSignals = helpers.fallbackSaleSignals || (() => false);
  const extAttrs = helpers.extAttrs || "";
  const extSr = helpers.extSr || (() => "");
  const eligible = commercial.sale_eligible === true
    || (commercial.sale_eligible == null && fallbackSaleSignals(commercial));
  if (!eligible) return "";

  const evidenceHTML = (value, source = "notice_body") => {
    const copy = String(value || "").trim();
    if (!copy || /^…|…$/.test(copy)) return "";
    const citation = source === "attachment_text"
      ? t("notice_attachment_title_fallback")
      : t("disposition_source_city_record");
    return `<blockquote class="property-commercial-evidence" lang="en" dir="ltr"><q>${esc(copy)}</q><cite>${citation}</cite></blockquote>`;
  };
  const contactHTML = (entry) => {
    if (!entry?.value) return "";
    const value = esc(entry.value);
    const evidence = evidenceHTML(entry.context, entry.source);
    if (entry.value.includes("@")) {
      return `<div class="property-commercial-contact"><a href="mailto:${value}">${value}</a>${evidence}</div>`;
    }
    const phone = `<a href="tel:${esc(entry.value.replace(/[^\d+]/g, ""))}" lang="en" dir="ltr">${value}</a>`;
    const line = entry.purpose === "accommodation"
      ? t("property_commercial_call_accommodation_html", { phone })
      : t("property_commercial_call_participation_html", { phone });
    return `<div class="property-commercial-contact"><p>${line}</p>${evidence}</div>`;
  };

  const item = commercial.item;
  const categoryLabel = t(ASSET_LABEL[item.category] || "asset_other");
  const itemDetail = item.label && String(item.label).toLowerCase() !== String(categoryLabel).toLowerCase()
    ? `<span lang="en" dir="ltr"> · ${esc(item.label)}</span>`
    : "";
  const hasWhat = Boolean(item.label || item.category && item.category !== "other" || commercial.quantities?.length);
  const quantities = (commercial.quantities || []).map((quantity) => (
    `<li><span lang="en" dir="ltr">${esc(quantity.display || "")}</span>${evidenceHTML(quantity.evidence, quantity.source)}</li>`
  )).join("");
  const prices = (commercial.price_facts || []).map((price) => {
    const nominal = price.kind === "nominal";
    const label = priceBadge(price.kind, String(price.display || "").replace(/^\$/, "")) || price.display;
    return `<li${nominal ? ' data-price-role="nominal-consideration"' : ""}><span class="${nominal ? "property-commercial-value-title" : "tag amt"}">${nominal ? `Nominal consideration: ${esc(price.display || "$1")}` : label}</span>${price.context ? `<p class="property-commercial-context">${esc(price.context)}</p>` : ""}${evidenceHTML(price.evidence, price.source)}</li>`;
  }).join("");
  const deal = commercial.deal_signal?.status === "derived"
    ? `<p class="property-deal-signal" data-deal-status="derived"><strong>${esc(commercial.deal_signal.summary)}</strong></p>`
    : "";
  const method = commercial.sale_method
    ? `<div class="lc-pct"><strong>${t("property_commercial_method_lbl")}:</strong> <span lang="en" dir="ltr">${esc(commercial.sale_method.method.replace(/_/g, " "))}</span>${evidenceHTML(commercial.sale_method.evidence, commercial.sale_method.source)}</div>`
    : "";
  const steps = (commercial.participation?.steps || []).map((step) => (
    `<li><span lang="en" dir="ltr">${esc(step.text || step.kind || "")}</span></li>`
  )).join("");
  const packageUrl = commercial.participation?.package_url
    ? `<div class="lc-pct"><a href="${esc(commercial.participation.package_url)}" ${extAttrs}>${t("property_action_open_rfp")}${extSr()}</a></div>`
    : "";
  const contacts = [
    ...(commercial.participation?.emails || []),
    ...(commercial.participation?.phones || []),
  ].map(contactHTML).filter(Boolean);
  const hasBidSignals = Boolean(method || packageUrl || steps);
  const hasParticipation = Boolean(hasBidSignals || contacts.length);
  const timedEvents = timedEventsHTML(commercial);

  const what = hasWhat ? `<div class="property-commercial-row property-commercial-what" data-commercial-field="what"><dt class="property-commercial-label">${t("property_commercial_what_lbl")}</dt><dd class="property-commercial-value"><div><span class="tag asset">${esc(categoryLabel)}</span>${itemDetail}</div>${evidenceHTML(item.evidence, item.source)}${quantities ? `<ul class="ei-list property-commercial-qty">${quantities}</ul>` : ""}</dd></div>` : "";
  const price = prices ? `<div class="property-commercial-row property-commercial-price" data-commercial-field="price"><dt class="property-commercial-label">${t("property_commercial_price_lbl")}</dt><dd class="property-commercial-value"><ul class="ei-list">${prices}</ul></dd></div>` : "";
  const dealRow = deal ? `<div class="property-commercial-row property-commercial-deal" data-commercial-field="deal"><dt class="property-commercial-label">${t("property_commercial_deal_lbl")}</dt><dd class="property-commercial-value">${deal}</dd></div>` : "";
  const participation = hasParticipation ? `<div class="property-commercial-row property-commercial-bid" data-commercial-field="participation"><dt class="property-commercial-label">${hasBidSignals ? t("property_commercial_bid_lbl") : t("apply_contact_lbl")}</dt><dd class="property-commercial-value">${method}${packageUrl}${steps ? `<ul class="ei-list">${steps}</ul>` : ""}${contacts.length ? `<div class="property-commercial-contacts">${contacts.join("")}</div>` : ""}</dd></div>` : "";
  const provenance = `<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${t("property_commercial_provenance_html")}</div></details>`;
  return `<section class="property-commercial-detail" data-commercial-detail="1" data-sale-eligible="1" aria-label="${esc(t("property_commercial_heading"))}"><h3 class="chain-h">${t("property_commercial_heading")}</h3>${timedEvents ? `<div class="property-commercial-timed-events" aria-label="Dated events">${timedEvents}</div>` : ""}<dl class="property-commercial-facts">${what}${price}${dealRow}${participation}</dl>${provenance}</section>`;
}
