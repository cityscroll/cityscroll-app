import { writeFileSync } from "node:fs";

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  if (check) {
    writeFileSync("baseline.json", "{}\n");
  }
}
