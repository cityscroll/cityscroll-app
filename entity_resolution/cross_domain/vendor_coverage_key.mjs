/** Stable compact key for the public vendor-coverage reverse index. */
export function vendorCoverageKey(ref) {
  const bytes = new TextEncoder().encode(String(ref || ""));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
