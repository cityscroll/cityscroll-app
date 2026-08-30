export function check({ now = Date.now() } = {}) {
  return { observed_at: new Date(now).toISOString() };
}

export function main() {
  return check({ now: Date.parse("2026-08-18T12:00:00.000Z") });
}
