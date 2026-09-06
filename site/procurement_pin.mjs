/**
 * Procurement identifier (PIN) primitives shared by every surface that reads a
 * contract's renewal chain.
 *
 * The Contracts list, the award-history detail, and the matter page all need to
 * know what a PIN's base identifier is, so the rule lives in one module rather
 * than inside the Contracts lens. `worker/src/lib/lineage.mjs` holds the
 * server-side twin; `test/contract/pin_lineage.test.mjs` proves they agree.
 */

/** Renewal cycles append this suffix to the base PIN. */
const RENEWAL_SUFFIX_RE = /R0\d+$/;

/** The base PIN a renewal cycle was issued against, or null when there is none. */
function pinBase(pin){
  const s = String(pin||"").trim();
  const m = s.match(RENEWAL_SUFFIX_RE);
  return m ? s.slice(0, m.index) : null;
}

export { RENEWAL_SUFFIX_RE, pinBase };
