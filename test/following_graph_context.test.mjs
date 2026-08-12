import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildFollowingViewModel,
  renderFollowingDocument,
} from "../site/following_view.mjs";

const templates = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));

test("a topic and place watch explains its identity, cadence, and return path publicly", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { keywords: ["curb"], borough: "Queens", agency: "Transportation" },
    frequency: "weekly",
    requested: true,
  }, templates));

  assert.match(html, /data-following-watch-identity/);
  assert.match(html, /<dt>Topic<\/dt>.*Hearings and meetings/s);
  assert.match(html, /<dt>Place<\/dt>.*Queens/s);
  assert.match(html, /<dt>Keyword<\/dt>.*curb/s);
  assert.match(html, /<dt>Agency<\/dt>.*Transportation/s);
  assert.match(html, /data-following-identity-cadence[^>]*>Weekly</);
  assert.match(html, /Notify me when Hearings and meetings match keyword curb AND agency Transportation AND in Queens\./);
  assert.match(html, /href="\/browse\/meetings\/[^\"]*"[^>]*data-following-current-matches/);
});

test("an entity watch uses typed pivots for the entity and its current matches", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "entity",
    filter: { kind: "agency", name: "Parks and Recreation" },
    requested: true,
  }, templates));

  assert.match(html, /Open Parks and Recreation/);
  assert.match(html, /data-entity-ref="agency:id:parks-and-recreation"/);
  assert.match(html, /data-subject-ref="agency:id:parks-and-recreation"/);
  assert.match(html, /href="\/browse\/contracts\/[^\"]*facet[^\"]*"[^>]*data-following-current-matches/);
  assert.match(html, /entity_refs_all/);
  assert.match(html, /href="\/agencies\/parks-and-recreation\//);
});

test("watch sets enumerate linked constituent scopes and entities without opening disclosure", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, {
    templates: [{
      id: "agency-demo",
      title: "Agency demo",
      watches: [
        { label: "Parks contracts", lens: "money", filter: {
          agency: "Parks and Recreation",
          entity_refs_all: ["agency:id:parks-and-recreation"],
        } },
      ],
    }],
  }));

  assert.match(html, /data-following-pack-watch/);
  assert.match(html, /class="ui-constellation-link following-watch-scope-link"[^>]*href="\/browse\/contracts\//);
  assert.match(html, /class="ui-constellation-link following-pack-watch-entity"[^>]*href="\/agencies\/parks-and-recreation\//);
  assert.match(html, /Open this pack/);
});

test("public Following rendering contains no personal watch records", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, templates));
  assert.match(html, /Open a CityScroll email to see your watches/);
  assert.doesNotMatch(html, /data-watch-key|data-session-recognized="true"/);
});
