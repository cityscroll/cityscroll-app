import assert from "node:assert/strict";
import test from "node:test";
import { renderNodeBack } from "../site/civic_document_chrome.mjs";

import {
  appendTraversalHop,
  decodeTraversalPath,
  encodeTraversalPath,
  emptyTraversalPath,
  renderTraversalPath,
  resolveTraversalBackHref,
  scopeFromTraversalHref,
  traversalBackHref,
  traversalFromHref,
} from "../site/traversal_path.mjs";

const origin = {
  kind: "official",
  id: "7801",
  name: "Official One",
  href: "#official/7801",
};

test("a carried path round-trips nodes, relations, and active scope", () => {
  const state = {
    hops: [{
      source: origin,
      relation: "committee membership",
      destination: { kind: "committee", id: "17", name: "Committee on Land Use", href: "#meetings?group=place" },
      scope: scopeFromTraversalHref("#meetings?group=place"),
    }],
  };
  const token = encodeTraversalPath(state);
  assert.ok(token);
  const restored = decodeTraversalPath(token);
  assert.equal(restored.status, "active");
  assert.equal(restored.hops[0].source.name, "Official One");
  assert.equal(restored.hops[0].relation, "committee membership");
  assert.equal(restored.hops[0].destination.name, "Committee on Land Use");
  assert.equal(restored.hops[0].scope.facets.values.group, "place");
});

test("appending hops preserves the shareable route and back returns one step", () => {
  const first = appendTraversalHop("#meetings?group=place", {
    source: origin,
    relation: "committee membership",
    destination: { kind: "committee", id: "17", name: "Committee on Land Use", href: "#meetings?group=place" },
  }, emptyTraversalPath());
  assert.ok(first.href.includes("walk="));
  const second = appendTraversalHop("/near-you/?lens=meetings&boro=Queens", {
    source: first.state.hops[0].destination,
    relation: "meeting place",
    destination: { kind: "place", id: "Queens", name: "Queens", href: "/near-you/?lens=meetings&boro=Queens" },
  }, traversalFromHref(first.href));
  const restored = traversalFromHref(second.href);
  assert.equal(restored.hops.length, 2);
  assert.equal(restored.hops[1].scope.facets.domains[0], "meetings");
  assert.match(renderTraversalPath(restored, { currentHref: second.href }), /Official One/);
  assert.match(renderTraversalPath(restored, { currentHref: second.href }), /Committee on Land Use/);
  assert.match(renderTraversalPath(restored, { currentHref: second.href }), /Queens/);
  assert.equal(traversalBackHref(restored, second.href).includes("walk="), true);
  assert.equal(traversalBackHref({ hops: [restored.hops[0]] }, second.href), "#official/7801");
});

test("unsupported hops remain visible as a held state with restart", () => {
  const result = appendTraversalHop("/committees/17/", {
    source: origin,
    relation: "committee membership",
    destination: { kind: "committee", id: "17", name: "Committee on Land Use", href: "/committees/17/" },
  }, emptyTraversalPath());
  assert.ok(result.href.includes("walk="));
  const held = traversalFromHref(result.href);
  assert.equal(held.status, "held");
  const html = renderTraversalPath(held, { currentHref: result.href });
  assert.match(html, /aria-label="Back one step"/);
  assert.match(html, /Committee on Land Use/);
  assert.match(html, /aria-label="Restart at origin"/);
  assert.doesNotMatch(html, /not a new fact|Navigation path|Where you came from/);
});

test("carried back resolution consumes the first hop and shortens later hops", () => {
  const first = appendTraversalHop("/notices/100", {
    source: { kind: "agency", id: "parks", name: "Parks", href: "/agencies/parks/" },
    relation: "hosted meeting",
    destination: { kind: "notice", id: "100", name: "Notice 100", href: "/notices/100" },
  });
  assert.equal(resolveTraversalBackHref(first.href, "/browse/contracts/"), "/agencies/parks/");

  const second = appendTraversalHop("/officials/7801/", {
    source: first.state.hops[0].destination,
    relation: "named official",
    destination: { kind: "official", id: "7801", name: "Official One", href: "/officials/7801/" },
  }, traversalFromHref(first.href));
  const back = resolveTraversalBackHref(second.href, "/browse/contracts/");
  assert.match(back, /\/notices\/100\?/);
  assert.ok(new URL(back, "https://cityscroll.org").searchParams.has("walk"));
  assert.equal(traversalFromHref(back).hops.length, 1);
  const staticBack = renderNodeBack({ href: "/browse/contracts/", label: "Back to Browse", currentHref: first.href });
  assert.match(staticBack, /data-route-back="traversal"/);
  assert.match(staticBack, /href="\/agencies\/parks\/"/);
});
