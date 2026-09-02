// An annotation is a declaration, never a mechanism: this one claims the clock
// arrives from the caller while nothing on the line supplies it.
export function todayISO() {
  // determinism-lint: inject clock the caller passes the day in.
  return new Date().toISOString().slice(0, 10);
}
