// Backwards-compatible matcher surface. New callers should depend on the
// scorer contract; existing policy/evaluation imports retain this path.

export {
  MATCHERS_VERSION,
  scorePair,
} from "../scorers/conventional_v2.mjs";
