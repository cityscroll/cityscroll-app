/** Public name for the receipt-backed community-board institution edge layer. */

export {
  COMMUNITY_BOARD_HOSTS_MEETING_EDGE_CONTRACT,
  COMMUNITY_BOARD_HOSTS_MEETING_EDGE_SCHEMA,
  buildCommunityBoardInstitutionEdges,
  buildCommunityBoardMeetingEdge,
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
  communityBoardMeetingEdgeFromSourceRow,
  joinCommunityBoardSourceRecord,
  joinCommunityBoardSourceRecords,
  materializeCommunityBoardMeetingEdge,
  promoteCommunityBoardHostsMeetingEdge,
} from "./community_board_source_join.mjs";
