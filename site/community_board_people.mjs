/**
 * Public adapter for source-qualified Community Board people.
 *
 * This module intentionally does not import Council person or committee
 * projections. A board-local identity can later be attached to a generic
 * person object by an explicit reviewed cross-source assertion.
 */

export {
  COMMUNITY_BOARD_PERSON_EDGE_SCHEMA,
  COMMUNITY_BOARD_PERSON_OBJECT_TYPE,
  COMMUNITY_BOARD_PERSON_ROLES,
  COMMUNITY_BOARD_PERSON_ROLE_CONTRACT,
  buildCommunityBoardPersonEdges,
  communityBoardPersonId,
  communityBoardPersonObject,
  promoteCommunityBoardPersonEdge,
  promoteCommunityBoardPersonRoleEdge,
} from "./community_board_relations.mjs";

export function communityBoardPeopleForBoard(people = {}, boardId) {
  const rows = Array.isArray(people) ? people : people?.boards?.[boardId]?.relationships || people?.[boardId]?.relationships || [];
  return rows.filter((row) => row && (row.publisher_person_id || row.reviewed_local_id || row.person_id || row.member_id));
}
