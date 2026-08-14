import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  HEARING_LOGISTICS_RULE,
  inferHearingLogistics,
  officialCityRecordAttachmentUrl,
  sourceSignalsFromHtml,
} from "../site/hearing_logistics.mjs";

// Dated spot checks retain the source signal shape, not a guessed mode. The
// sample includes the reported rule notice plus ordinary public-hearing forms.
const KILL_SAMPLE = [
  {
    request_id: "20260803009",
    source: "City Record body: enter to register at this Zoom meeting; zoomgov.com join URL",
    input: {
      body: "To participate in the public hearing, enter to register at this Zoom meeting.",
      sourceLinks: ["https://health-nyc.zoomgov.com/j/1659561163"],
    },
    expected: "remote",
  },
  {
    request_id: "20251110015",
    source: "retained City Record hearing fixture with no virtual signal",
    input: { body: "Written testimony may be submitted by e-mail." },
    expected: "unknown",
  },
  {
    request_id: "20260612004",
    source: "retained City Record hearing fixture with a street address",
    input: { body: "The hearing will be held at 22 Reade Street, New York, NY 10007." },
    expected: "in-person",
  },
  {
    request_id: "20260812001",
    source: "dated public-hearing spot check with address and Zoom URL",
    input: {
      body: "The hearing will be held at 1 Centre Street, New York, NY. Join online at https://zoom.us/j/123456789.",
    },
    expected: "hybrid",
  },
  {
    request_id: "20260723005",
    source: "retained remote Dining Out hearing whose body lists affected cafe addresses",
    input: {
      body: "The public hearing will be held remotely via Zoom for petitions adjacent to 96 Avenue A and 113 Franklin Street.",
    },
    expected: "remote",
  },
];

test("hearing logistics rule is explicit and conservative", () => {
  assert.match(HEARING_LOGISTICS_RULE, /recognized video-conference URL/);
  assert.match(HEARING_LOGISTICS_RULE, /otherwise the mode remains not stated/);
  for (const sample of KILL_SAMPLE) {
    assert.equal(
      inferHearingLogistics(sample.input).mode,
      sample.expected,
      sample.request_id + " — " + sample.source,
    );
  }
});

test("City Record extraction keeps notice content and validated attachments only", async () => {
  const html = await readFile(new URL("../worker/test/fixtures/city-record-hearing/20260713006.html", import.meta.url), "utf8");
  const sourceUrl = "https://a856-cityrecord.nyc.gov/RequestDetail/20260713006";
  const signals = sourceSignalsFromHtml(html, sourceUrl);

  assert.match(signals.body, /DCWP NOH Rules Relating to Waitlist/);
  assert.match(signals.body, /public hearing will consider rules/);
  assert.doesNotMatch(signals.body, /The City Record Online \(CROL\)|UNSUPPORTED|Sections|User's Guide|Contact Us/);
  assert.deepEqual(signals.sourceLinks, [
    "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=4&requestId=20260713006&requestStatus=Archived&documentId=44259",
  ]);
  assert.equal(
    officialCityRecordAttachmentUrl("/Search/GetFile?requestId=other&documentId=44259", sourceUrl),
    null,
  );
});
