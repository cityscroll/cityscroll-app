// Keep the universal Search document, its capability projection, and their
// transitive graph behind the Search route's own code-split boundary.
if (location.pathname === "/search" || location.pathname === "/search/") {
  await import("./search_document.mjs");
}
