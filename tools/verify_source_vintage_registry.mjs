#!/usr/bin/env node

import { loadSourceContracts } from "./source_contracts.mjs";
import {
  loadSourceVintageAlternates,
  validateSourceVintageAlternates,
} from "./source_vintage_alternates.mjs";

const errors = validateSourceVintageAlternates(
  loadSourceVintageAlternates(),
  loadSourceContracts(),
);
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("source vintage alternate registry is valid");
}
