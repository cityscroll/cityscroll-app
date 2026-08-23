import procurementDigestSnapshot from "../../../site/data/procurement_digest_snapshot.json" with { type: "json" };
import { useProcurementDigestSnapshot } from "./compile.mjs";

useProcurementDigestSnapshot(procurementDigestSnapshot);
