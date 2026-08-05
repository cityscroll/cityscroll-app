// Constant-time string comparison for secret equality checks. The native === / !==
// operators short-circuit on the first differing byte, which leaks prefix information
// through response timing when the compared value is a caller-supplied bearer secret.
//
// This encodes both inputs to UTF-8 bytes and XOR-walks the longer length, so equal
// and unequal inputs of similar length do length-proportional work without an early
// exit. Callers must never log either argument.

export function timingSafeEqualString(a, b) {
  const aBytes = new TextEncoder().encode(a == null ? "" : String(a));
  const bBytes = new TextEncoder().encode(b == null ? "" : String(b));
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}
