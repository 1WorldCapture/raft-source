package message

import (
	"context"
	"fmt"
	"sort"
)

// Projection is the ENRICHED FACT bundle of one message row for any exit:
// the row itself plus sender directory facts, membership status, reaction
// aggregates and mention facts. It carries no client JSON tags and no wire
// rendering — the transport presenter turns these facts into the protocol
// shapes (history/context/sync full DTO, send-response subset, sealed socket
// payloads) with their exact presence semantics.
//
// Enrichment facts:
//   - SenderName/SenderHandle default to "Unknown" only at the WIRE layer;
//     facts keep the empty string when no directory row exists. "System" is
//     likewise a wire decision from SenderType/MessageType.
//   - SenderMembershipStatus is nil when the surface must omit it (non-user
//     senders, system messages); "active"/"removed" otherwise.
//   - Reactions/Mentions are nil when absent (the wire always renders
//     explicit empty arrays).
type Projection struct {
	Message
	// SenderDirectoryKnown reports that a users row exists for the sender:
	// the wire default differs between "no directory row" ("Unknown") and
	// "row with an empty name" ("User"), so the distinction is a fact.
	SenderDirectoryKnown   bool
	SenderName             string
	SenderHandle           string
	SenderDescription      *string
	SenderMembershipStatus *string
	Reactions              []ReactionSummary
	Mentions               []Mention
}

// userDirectoryProfile is the directory projection for senders.
type userDirectoryProfile struct {
	Handle      string
	Name        string
	Description *string
}

// userDirectory loads the minimal directory projection for the given user ids
// (name/displayName/description), exactly like the TS batch sender lookup.
func (s *Store) userDirectory(ctx context.Context, ex dbExecutor, ids map[string]bool) (map[string]userDirectoryProfile, error) {
	out := map[string]userDirectoryProfile{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids))
	for id := range ids {
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT id, name, display_name, description FROM users
		WHERE id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("directory lookup: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var displayName, description *string
		if err := rows.Scan(&id, &name, &displayName, &description); err != nil {
			return nil, err
		}
		profile := userDirectoryProfile{Handle: name, Name: name}
		if displayName != nil && *displayName != "" {
			profile.Name = *displayName
		}
		profile.Description = description
		out[id] = profile
	}
	return out, rows.Err()
}

// agentDirectoryProfile is the directory projection for agent senders.
type agentDirectoryProfile struct {
	Handle      string
	Name        string
	Description *string
}

// agentDirectory loads the minimal directory projection for the given agent
// ids (name/displayName/description). The agents row stays readable after a
// soft delete so committed history keeps rendering the real identity behind
// the stable id (the tombstone display is a presenter decision).
func (s *Store) agentDirectory(ctx context.Context, ex dbExecutor, ids map[string]bool) (map[string]agentDirectoryProfile, error) {
	out := map[string]agentDirectoryProfile{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids))
	for id := range ids {
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT id, name, display_name, description FROM agents
		WHERE id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("agent directory lookup: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var displayName, description *string
		if err := rows.Scan(&id, &name, &displayName, &description); err != nil {
			return nil, err
		}
		profile := agentDirectoryProfile{Handle: name, Name: name}
		if displayName != nil && *displayName != "" {
			profile.Name = *displayName
		}
		profile.Description = description
		out[id] = profile
	}
	return out, rows.Err()
}

// membershipStatuses resolves the senderMembershipStatus fact for user
// senders: "active" while the sender still belongs to the message's
// workspace, "removed" otherwise (the Go schema keeps no departure-reason
// table, so the left/removed split of the TS surface collapses to removed).
func (s *Store) membershipStatuses(ctx context.Context, ex dbExecutor, workspaceID string, msgs []*Message) (map[string]string, error) {
	ids := map[string]bool{}
	for _, m := range msgs {
		if m.SenderType == "user" && m.MessageType != "system" {
			ids[m.SenderID] = true
		}
	}
	statuses := map[string]string{}
	if len(ids) == 0 {
		return statuses, nil
	}
	args := []any{workspaceID}
	for id := range ids {
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT user_id FROM workspace_memberships
		WHERE workspace_id = ? AND user_id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("membership status: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		statuses[id] = "active"
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for id := range ids {
		if statuses[id] == "" {
			statuses[id] = "removed"
		}
	}
	return statuses, nil
}

// reactionsForMessages loads the shared aggregates: per message, per emoji,
// real row counts and the reactor name list in first-reaction order.
func (s *Store) reactionsForMessages(ctx context.Context, ex dbExecutor, messageIDs []string) (map[string][]ReactionSummary, error) {
	out := map[string][]ReactionSummary{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT r.message_id, r.emoji, r.user_id,
		COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), 'Unknown user')
		FROM message_reactions r LEFT JOIN users u ON u.id = r.user_id
		WHERE r.message_id IN (`+placeholders(len(messageIDs))+`)
		ORDER BY r.created_at, r.rowid`, anyStrings(messageIDs)...)
	if err != nil {
		return nil, fmt.Errorf("reaction aggregate: %w", err)
	}
	defer rows.Close()
	byMessage := map[string]map[string]*ReactionSummary{}
	for rows.Next() {
		var messageID, emoji, userID, name string
		if err := rows.Scan(&messageID, &emoji, &userID, &name); err != nil {
			return nil, err
		}
		emojis := byMessage[messageID]
		if emojis == nil {
			emojis = map[string]*ReactionSummary{}
			byMessage[messageID] = emojis
		}
		summary := emojis[emoji]
		if summary == nil {
			summary = &ReactionSummary{Emoji: emoji, ReactorIDs: []string{}, ReactorNames: []string{}}
			emojis[emoji] = summary
		}
		summary.Count++
		summary.ReactorIDs = append(summary.ReactorIDs, userID)
		summary.ReactorNames = append(summary.ReactorNames, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for messageID, emojis := range byMessage {
		list := make([]ReactionSummary, 0, len(emojis))
		for _, summary := range emojis {
			list = append(list, *summary)
		}
		out[messageID] = list
	}
	return out, nil
}

// mentionsForMessages loads the mention facts per message: human rows first
// (insertion order), then the typed agent rows with the handle persisted at
// send time. A pre-0014 schema has no agent facts at all.
func (s *Store) mentionsForMessages(ctx context.Context, ex dbExecutor, messageIDs []string) (map[string][]Mention, error) {
	out := map[string][]Mention{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT mm.message_id, mm.user_id, u.name
		FROM message_mentions mm JOIN users u ON u.id = mm.user_id
		WHERE mm.message_id IN (`+placeholders(len(messageIDs))+`)
		ORDER BY mm.rowid`, anyStrings(messageIDs)...)
	if err != nil {
		return nil, fmt.Errorf("mention read: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var m Mention
		if err := rows.Scan(&messageID, &m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "user"
		out[messageID] = append(out[messageID], m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	agentRows, err := ex.QueryContext(ctx, `SELECT message_id, agent_id, handle_at_send
		FROM message_agent_mentions
		WHERE message_id IN (`+placeholders(len(messageIDs))+`)
		ORDER BY rowid`, anyStrings(messageIDs)...)
	if err != nil {
		if isMissingTable(err) {
			return out, nil
		}
		return nil, fmt.Errorf("agent mention read: %w", err)
	}
	defer agentRows.Close()
	for agentRows.Next() {
		var messageID string
		var m Mention
		if err := agentRows.Scan(&messageID, &m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "agent"
		out[messageID] = append(out[messageID], m)
	}
	return out, agentRows.Err()
}

// ProjectMessages builds the enriched fact list for one snapshot read (the
// full-exit enrichment: directory, membership, reactions, mentions). Sender
// profiles, membership status, reactions and mentions come from the same
// snapshot executor as the rows themselves.
func (s *Store) ProjectMessages(ctx context.Context, ex dbExecutor, workspaceID string, msgs []*Message) ([]*Projection, error) {
	if len(msgs) == 0 {
		return []*Projection{}, nil
	}
	senderIDs := map[string]bool{}
	agentSenderIDs := map[string]bool{}
	for _, m := range msgs {
		switch {
		case m.SenderType == "user" && m.MessageType != "system":
			senderIDs[m.SenderID] = true
		case m.SenderType == "agent" && m.MessageType != "system":
			agentSenderIDs[m.SenderID] = true
		case m.MessageType == "system" || m.SenderID == "system":
			// "System" label, exactly like the TS nameMap seed.
		}
	}
	profiles, err := s.userDirectory(ctx, ex, senderIDs)
	if err != nil {
		return nil, err
	}
	agentProfiles, err := s.agentDirectory(ctx, ex, agentSenderIDs)
	if err != nil {
		return nil, err
	}
	statuses, err := s.membershipStatuses(ctx, ex, workspaceID, msgs)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		ids = append(ids, m.ID)
	}
	reactions, err := s.reactionsForMessages(ctx, ex, ids)
	if err != nil {
		return nil, err
	}
	mentions, err := s.mentionsForMessages(ctx, ex, ids)
	if err != nil {
		return nil, err
	}

	out := make([]*Projection, 0, len(msgs))
	for _, m := range msgs {
		proj := &Projection{Message: *m, Reactions: reactions[m.ID], Mentions: mentions[m.ID]}
		if m.MessageType == "system" || m.SenderID == "system" {
			// The wire renders "System"; the fact records the system actor.
			proj.SenderName = "System"
			proj.SenderHandle = "System"
		} else if prof, ok := profiles[m.SenderID]; ok {
			proj.SenderDirectoryKnown = true
			proj.SenderName = prof.Name
			proj.SenderHandle = prof.Handle
			proj.SenderDescription = prof.Description
		} else if prof, ok := agentProfiles[m.SenderID]; ok {
			proj.SenderDirectoryKnown = true
			proj.SenderName = prof.Name
			proj.SenderHandle = prof.Handle
			proj.SenderDescription = prof.Description
		}
		if m.SenderType == "user" && m.MessageType != "system" {
			status := statuses[m.SenderID]
			proj.SenderMembershipStatus = &status
		}
		out = append(out, proj)
	}
	return out, nil
}

// SendResponseMessage builds the creation-surface FACT bundle for one
// committed or replayed message: the row, its resolved mentions and the
// sender directory facts. The "senderMembershipStatus: active" constant of
// the send surface is a presenter decision (the sender passed the posting
// authorization inside the same transaction that committed the row).
func (s *Store) SendResponseMessage(ctx context.Context, ex dbExecutor, msg *Message, mentions []Mention) (*Projection, error) {
	proj := &Projection{Message: *msg, Mentions: mentions}
	if msg.SenderType == "agent" {
		profile, err := s.agentDirectory(ctx, ex, map[string]bool{msg.SenderID: true})
		if err != nil {
			return nil, err
		}
		if prof, ok := profile[msg.SenderID]; ok {
			proj.SenderDirectoryKnown = true
			proj.SenderName = prof.Name
			proj.SenderHandle = prof.Handle
			proj.SenderDescription = prof.Description
		}
		return proj, nil
	}
	profile, err := s.userDirectory(ctx, ex, map[string]bool{msg.SenderID: true})
	if err != nil {
		return nil, err
	}
	if prof, ok := profile[msg.SenderID]; ok {
		proj.SenderDirectoryKnown = true
		proj.SenderName = prof.Name
		proj.SenderHandle = prof.Handle
		proj.SenderDescription = prof.Description
	}
	return proj, nil
}

// sortEmojis is the deterministic reactedEmojis order (TS: ORDER BY emoji then
// .sort()).
func sortEmojis(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}
