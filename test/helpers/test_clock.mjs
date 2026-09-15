const NativeDate = globalThis.Date;

export const TEST_CLOCK_ENV = "CITYSCROLL_TEST_TIME_SHIFT_DAYS";
export const TEST_CLOCK_PIN_ENV = "CITYSCROLL_TEST_TIME_PIN";
export const MILLISECONDS_PER_DAY = 86_400_000;

export function testClockISOString() {
  return new globalThis.Date().toISOString();
}

export function todayISO() {
  return testClockISOString().slice(0, 10);
}

const activeScopes = [];

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
  const scope = installClock(pinnedEpoch);
  try {
    return await fn();
  } finally {
    restoreClock(scope);
  }
}

function installClock(epoch) {
  const previousDate = globalThis.Date;
  class ScopedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [epoch]));
    }

    static now() {
      return epoch;
    }
  }

  const scope = {
    date: ScopedDate,
    previousDate,
    rootDate: activeScopes[0]?.rootDate ?? previousDate,
  };
  activeScopes.push(scope);
  globalThis.Date = ScopedDate;
  return scope;
}

function restoreClock(scope) {
  const index = activeScopes.indexOf(scope);
  if (index === -1) return;
  activeScopes.splice(index, 1);
  if (activeScopes.length) {
    if (globalThis.Date === scope.date || activeScopes.some(({ date }) => globalThis.Date === date)) {
      globalThis.Date = activeScopes.at(-1).date;
    }
  } else if (globalThis.Date === scope.date) {
    globalThis.Date = scope.rootDate;
  }
}

export function installClockShift(days, { now = NativeDate.now() } = {}) {
  const shiftDays = parseClockShiftDays(days);
  if (!Number.isFinite(now)) throw new RangeError("test clock anchor must be finite");
  const shiftedEpoch = now + shiftDays * MILLISECONDS_PER_DAY;
  if (!Number.isFinite(shiftedEpoch)) throw new RangeError("test clock shift overflowed");
  const scope = installClock(shiftedEpoch);
  return () => restoreClock(scope);
}

export function installClockShiftFromEnv(env = process.env) {
  if (env[TEST_CLOCK_PIN_ENV]) {
    const scope = installClock(epochMilliseconds(env[TEST_CLOCK_PIN_ENV]));
    return () => restoreClock(scope);
  }
  const days = parseClockShiftDays(env[TEST_CLOCK_ENV]);
  return days === 0 ? () => {} : installClockShift(days);
}
