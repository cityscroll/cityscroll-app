// A deliberate production clock, declared at its own line. The product keeps its
// real-clock behaviour; the reason is recorded where the next reader will see it.
export function exportFilename(lens) {
  // determinism-lint: allow clock the filename records the day the reader exported the file, which is a fact about their action.
  return `cityscroll-${lens}-${new Date().toISOString().slice(0, 10)}.csv`;
}
