// The approved seam: the instant arrives at the boundary. A caller that wants a
// fixed day passes one, and the ambient read is only the arm taken when nothing
// was supplied — visible in the expression, not asserted by a comment.
export function noticeIsOpen(notice, today = new Date().toISOString().slice(0, 10)) {
  return String(notice?.due_date || "") > today;
}

export function windowFloor({ asOf } = {}) {
  const day = asOf || new Date().toISOString().slice(0, 10);
  return `${day}T00:00:00Z`;
}
