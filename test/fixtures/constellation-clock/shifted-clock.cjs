// Deliberate clock fixture: shifts the ambient date so a build that reads it
// produces different bytes. Preloaded with --require by the freshness suite to
// prove the agency constellation materialization does not depend on "today".
// determinism-lint: inject clock fixture shifts the ambient date on purpose
const RealDate = Date;
const OFFSET_MS = Number(process.env.CONSTELLATION_CLOCK_SHIFT_DAYS || 400) * 86400000;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + OFFSET_MS);
    else super(...args);
  }
  static now() {
    return RealDate.now() + OFFSET_MS;
  }
}
globalThis.Date = ShiftedDate;
