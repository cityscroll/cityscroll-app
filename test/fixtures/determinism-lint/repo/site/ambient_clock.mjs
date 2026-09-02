// A shipped module that reads the wall clock with nothing supplying it. This is
// the class of change the production scope exists to stop.
export function noticeIsOpen(notice) {
  return String(notice?.due_date || "") > new Date().toISOString().slice(0, 10);
}

export function elapsedSince(startedAt) {
  return Date.now() - Number(startedAt);
}
