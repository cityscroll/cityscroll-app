import { mkdirSync, writeFileSync } from "node:fs";

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  if (check) {
    return { status: "ok" };
  }
  if (!check) {
    mkdirSync("generated", { recursive: true });
    writeFileSync("generated/receipt.json", "{}\n");
  }
}
