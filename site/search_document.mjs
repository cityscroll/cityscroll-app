const MAX_QUERY_LENGTH = 240;
const PLACE_KEYS = Object.freeze([
  ["boro", "Borough"],
  ["cd", "Community district"],
  ["council", "Council district"],
  ["neighborhood", "Neighborhood"],
  ["scope", "Area"],
]);

function clean(value, max = MAX_QUERY_LENGTH) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function queryFromLocation() {
  const params = new URLSearchParams(location.search);
  return clean(params.get("q"));
}

function placeFromLocation() {
  const params = new URLSearchParams(location.search);
  return PLACE_KEYS
    .map(([key, label]) => [label, clean(params.get(key), 80)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");
}

function preservePlaceFields(form) {
  const params = new URLSearchParams(location.search);
  for (const [key] of PLACE_KEYS) {
    const value = clean(params.get(key), 80);
    if (!value) continue;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.append(input);
  }
}

function render() {
  const root = document.querySelector("[data-search-document]");
  if (!root) return;
  const query = queryFromLocation();
  const heading = root.querySelector("#search-heading");
  const input = root.querySelector("#search-query");
  const context = root.querySelector("[data-search-place]");
  if (heading) heading.textContent = query ? `Results for “${query}”` : "What are you looking for?";
  if (input) input.value = query;
  const place = placeFromLocation();
  if (context && place) {
    context.textContent = `Place context · ${place}`;
    context.hidden = false;
  }
  const form = root.querySelector("[data-search-form]");
  if (form) preservePlaceFields(form);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
else render();
