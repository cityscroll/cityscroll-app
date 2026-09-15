import { readFileSync } from "node:fs";

import { renderProcurementDocument } from "../site/procurement_document.mjs";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));
const html = renderProcurementDocument(fixture.object, fixture.observations, {
  currentHref: "/procurements/CT107120258801626",
});

if (!html) throw new Error("procurement detail fixture did not render");
process.stdout.write(html);
