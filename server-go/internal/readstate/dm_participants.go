package readstate

// humanDMParticipantsSQL is a read-only human-participation projection across
// the two canonical DM kinds. Both user_low/user_high values in an Agent DM
// are the human participant's ID: no Agent UUID is cast to a user or inserted
// into the human-only direct_messages table. Existing readstate predicates
// answer membership only, never choose the peer from these columns.
//
// Keeping the same named columns lets every aggregate, frontier, residue and
// thread-parent query share exactly one typed-pair union. It is a fixed SQL
// literal (no caller input); the WHERE clauses retain workspace/visibility
// checks and bound parameters. A third workspace human never matches the
// Agent DM row merely because they belong to its workspace.
const humanDMParticipantsSQL = `(SELECT workspace_id, channel_id, user_low, user_high FROM direct_messages
	UNION ALL
	SELECT workspace_id, channel_id, user_id AS user_low, user_id AS user_high FROM agent_direct_messages)`
