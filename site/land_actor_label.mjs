/** A source-ref label shared by Land projections and resident renderers. */
function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

export function actorLabel(bodyRef, translate) {
  const ref = clean(bodyRef) || "";
  const board = ref.match(/^community-board:([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (board) {
    const borough = board[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Community Board ${Number(board[2])}`;
  }
  if (ref === "agency:id:city-council") return translate("land_authority_actor_council");
  if (ref === "agency:id:city-planning-commission") return translate("land_phase_cpc");
  if (ref === "agency:id:city-planning") return translate("land_authority_actor_dcp");
  if (ref === "agency:id:mayor") return translate("land_phase_mayoral_appeals");
  const president = ref.match(/^borough-president:([a-z]+(?:-[a-z]+)*)$/);
  if (president) {
    const borough = president[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Borough President`;
  }
  const boroughBoard = ref.match(/^borough-board:([a-z]+(?:-[a-z]+)*)$/);
  if (boroughBoard) {
    const borough = boroughBoard[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Borough Board`;
  }
  return ref || translate("land_authority_unknown");
}
