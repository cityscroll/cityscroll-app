const NativeDate = globalThis.Date;

export const TEST_CLOCK_ENV = "CITYSCROLL_TEST_TIME_SHIFT_DAYS";
export const MILLISECONDS_PER_DAY = 86_400_000;

function epochMilliseconds(value) {
  const date = value instanceof NativeDate ? new NativeDate(value.getTime()) : new NativeDate(value);
  const epoch = date.getTime();
  if (!Number.isFinite(epoch)) throw new RangeError(`invalid test clock instant: ${String(value)}`);
  return epoch;
}

export function parseClockShiftDays(value) {
  if (value === undefined || value === null || value === "") return 0;
  const days = Number(value);
  if (!Number.isInteger(days)) {
    throw new RangeError(`${TEST_CLOCK_ENV} must be an integer number of days`);
  }
  return days;
}

export async function withPinnedClock(value, fn) {
  if (typeof fn !== "function") throw new TypeError("withPinnedClock requires a function");
  const pinnedEpoch = epochMilliseconds(value);
  const previousDate = globalThis.Date;

  class PinnedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [pinnedEpoch]));
    }

    static now() {
      return pinnedEpoch;
    }
  }

  globalThis.Date = PinnedDate;
  try {
    return await fn();
  } finally {
    if (globalThis.Date === PinnedDate) globalThis.Date = previousDate;
  }
}

export function installClockShift(days, { now = NativeDate.now() } = {}) {
  const shiftDays = parseClockShiftDays(days);
  if (!Number.isFinite(now)) throw new RangeError("test clock anchor must be finite");
  const shiftedEpoch = now + shiftDays * MILLISECONDS_PER_DAY;
  if (!Number.isFinite(shiftedEpoch)) throw new RangeError("test clock shift overflowed");
  const previousDate = globalThis.Date;

  class ShiftedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [shiftedEpoch]));
    }

    static now() {
      return shiftedEpoch;
    }
  }

  globalThis.Date = ShiftedDate;
  return () => {
    if (globalThis.Date === ShiftedDate) globalThis.Date = previousDate;
  };
}

export function installClockShiftFromEnv(env = process.env) {
  const days = parseClockShiftDays(env[TEST_CLOCK_ENV]);
  return days === 0 ? () => {} : installClockShift(days);
}
