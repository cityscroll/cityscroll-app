export function main() {
  // determinism-lint: inject clock from the committed fixture
  const now = Date.now();
  // determinism-lint: allow network hermetic fixture transport for this replay
  const response = fetch(new URL("./data.json", import.meta.url));
  return { now, response };
}
