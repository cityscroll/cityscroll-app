export function main() {
  const started = Date.now();
  const local = new Date();
  const label = local.toLocaleString();
  return { started, local, label };
}
