// The shared action-scent primitives in `site/affordance_grammar.mjs`.
//
// A signifier tells a reader what a control will do before they commit to it.
// This suite pins the three decisions the whole repository now routes through
// one classifier instead of restating per surface:
//
//   A3 what a named next step actually does — inspect, navigate, or hand off —
//      is decided by the destination, not by how the href is spelled
//   A3 a handoff is presented as one: the visible arrow, the new tab, and the
//      announcement that goes with a new tab
//   A1 a label positioned against the reader's own document ("the steps below")
//      is judged against the surface rendering it, not rewritten everywhere
//   A2 a control does not spend its name repeating a fact the card already
//      states beside it
//
//   node --test test/affordance_grammar.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceActionRole,
  affordanceActionScent,
  affordanceHandoffPresentation,
  affordancePositionalPromise,
  externalActionLink,
} from "../site/affordance_grammar.mjs";

/* ---------- A3: what the click does ---------- */

test("A3: the destination decides the role, not the spelling of the href", () => {
  const navigate = AFFORDANCE_ACTION_ROLES.navigate;
  // Relative, rooted, query and fragment destinations are all this site.
  for (const href of ["/notices/abc", "./guide", "#now", "?scope=bronx"]) {
    assert.equal(affordanceActionRole({ href }), navigate, href);
  }
  // So is an absolute URL on a host this site owns. The Now listing used to
  // test the href for "https://" and hand every one of these to a new tab.
  for (const href of ["https://cityscroll.org/notices/abc", "https://api.cityscroll.org/now"]) {
    assert.equal(affordanceActionRole({ href }), navigate, href);
  }
  // A publisher's own URL is a handoff however ordinary it looks.
  for (const href of ["https://rules.cityofnewyork.us/rule/energy/", "mailto:clerk@example.gov", "tel:+12125551212"]) {
    assert.equal(affordanceActionRole({ href }), AFFORDANCE_ACTION_ROLES.handoff, href);
  }
});

test("A3: a control that answers in place is inspection, whatever destination it carries", () => {
  assert.equal(
    affordanceActionRole({ href: "https://rules.cityofnewyork.us/rule/energy/", inspects: true }),
    AFFORDANCE_ACTION_ROLES.inspect,
    "inspection never becomes a handoff merely because a destination is in scope",
  );
  assert.equal(affordanceActionRole({ href: "", inspects: true }), AFFORDANCE_ACTION_ROLES.inspect);
});

test("A3: a step with no usable destination is not an action a reader can be offered", () => {
  assert.equal(affordanceActionRole({ href: "" }), null);
  assert.equal(affordanceActionRole({ href: "   " }), null);
  assert.equal(affordanceActionRole({}), null);
  assert.equal(affordanceHandoffPresentation({ href: "" }).role, null);
});

/* ---------- A3: how the handoff is presented ---------- */

test("A3: only a real external page takes a new tab, and only a new tab is announced", () => {
  const external = affordanceHandoffPresentation({ href: "https://rules.cityofnewyork.us/rule/energy/" });
  assert.equal(external.role, AFFORDANCE_ACTION_ROLES.handoff);
  assert.equal(external.external, true);
  assert.match(external.attributes, /target="_blank"/);
  assert.match(external.attributes, /rel="noopener noreferrer"/);
  assert.match(external.glyph, /↗/);
  assert.match(external.announcement, /class="sr-only"/);

  // A mail or telephone handler hands off but opens no tab, so it carries the
  // visible signifier and announces nothing that will not happen.
  const protocolHandoff = affordanceHandoffPresentation({ href: "mailto:clerk@example.gov" });
  assert.equal(protocolHandoff.role, AFFORDANCE_ACTION_ROLES.handoff);
  assert.equal(protocolHandoff.attributes, "");
  assert.match(protocolHandoff.glyph, /↗/);
  assert.equal(protocolHandoff.announcement, "");

  const internal = affordanceHandoffPresentation({ href: "/notices/abc" });
  assert.equal(internal.role, AFFORDANCE_ACTION_ROLES.navigate);
  assert.equal(internal.attributes, "");
  assert.equal(internal.glyph, "");
  assert.equal(internal.announcement, "");
});

test("A3: the shared link renderer and the shared presentation agree, because one calls the other", () => {
  const rendered = externalActionLink({ href: "https://rules.cityofnewyork.us/rule/energy/", label: "Comment" });
  const presentation = affordanceHandoffPresentation({ href: "https://rules.cityofnewyork.us/rule/energy/" });
  assert.ok(rendered.includes(presentation.attributes.trim()));
  assert.ok(rendered.includes(presentation.glyph));
  assert.ok(rendered.includes(presentation.announcement));
  assert.match(rendered, /class="ui-external-action"/);
  assert.match(externalActionLink({ href: "/notices/abc", label: "Open notice" }), /class="ui-action-link"/);
  assert.equal(externalActionLink({ href: "", label: "Nowhere" }), "");
});

/* ---------- A1: a positional promise is a claim about a page ---------- */

test("A1: a label that positions its subject in the reader's document is recognised as such", () => {
  assert.equal(affordancePositionalPromise("Follow the response steps below"), true);
  assert.equal(affordancePositionalPromise("See the table above"), true);
  assert.equal(affordancePositionalPromise("Read the notes further down"), true);
  assert.equal(affordancePositionalPromise("View response instructions"), false);
  assert.equal(affordancePositionalPromise("Comment"), false);
  assert.equal(affordancePositionalPromise(""), false);
  assert.equal(affordancePositionalPromise(null), false);
});

test("A1: the same label is sound on the document that carries the steps and unsound on a card that links to it", () => {
  const label = "Follow the response steps below";
  // The full notice renders the steps, so it declares that it carries them.
  const onTheNotice = affordanceActionScent({ label, href: "#respond", carriesSubject: true });
  assert.equal(onTheNotice.ok, true, "a valid source instruction is not rewritten where it is true");

  // A listing card links to that notice and carries nothing of the kind.
  const onTheCard = affordanceActionScent({ label, href: "/notices/bid-open" });
  assert.equal(onTheCard.ok, false);
  assert.deepEqual([...onTheCard.problems], ["positional_promise"]);
  assert.equal(onTheCard.role, AFFORDANCE_ACTION_ROLES.navigate);
});

/* ---------- A2: a control does not repeat a fact ---------- */

test("A2: naming the control the same as a fact already on the card is reported", () => {
  const repeated = affordanceActionScent({
    label: "Submit an objection",
    href: "/notices/property-actions",
    statedFacts: ["Submit an objection", "Property"],
  });
  assert.equal(repeated.ok, false);
  assert.deepEqual([...repeated.problems], ["repeats_stated_fact"]);

  // Comparison is by what a reader hears, not by bytes.
  assert.equal(
    affordanceActionScent({ label: "Open notice", href: "/n/1", statedFacts: ["  open   NOTICE. "] }).ok,
    false,
    "casing, spacing and trailing punctuation are not distinctions the card is making",
  );

  // Sharing a word is not repeating a statement.
  assert.equal(
    affordanceActionScent({ label: "Comment", href: "https://rules.cityofnewyork.us/x", statedFacts: ["Comment window", "Comment by"] }).ok,
    true,
  );
});

test("A2: an unnamed or undestined step is reported rather than rendered", () => {
  assert.deepEqual([...affordanceActionScent({ label: "  ", href: "/n/1" }).problems], ["unnamed"]);
  assert.deepEqual([...affordanceActionScent({ label: "Open notice", href: "" }).problems], ["undestined"]);
  const both = affordanceActionScent({ label: "", href: "" });
  assert.equal(both.ok, false);
  assert.deepEqual([...both.problems], ["unnamed", "undestined"]);
});

test("A2: findings are returned, never applied — the primitive rewrites no copy", () => {
  const result = affordanceActionScent({ label: "Follow the response steps below", href: "/notices/x" });
  assert.deepEqual(Object.keys(result).sort(), ["ok", "problems", "role"]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.problems));
});
