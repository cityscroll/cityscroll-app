// An implicit local-time read: the same instant yields a different calendar day
// either side of the international date line.
export function calendarDay(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
