// M5 agent-facing reads: one channel history page and one message context
// window, authorized through the real agent conversation policy on a single
// pinned snapshot. The agent viewer has no readstate, so thread unread
// projections read as none (the empty-viewer semantics of the shared
// summary builder) and sender/mention projections come from the same
// presenter facts the human exits use.
package message

import (
	"context"

	platformdb "raft.local/server-go/internal/platform/db"
)

// ListAgentChannelPageForAgent reads one channel page plus its coverage for
// an AGENT viewer on a fresh snapshot. It checks conversation read authority
// only. A caller that holds an agent credential must use
// ListAgentChannelPageForAgentTx on the same executor that already ran
// ValidateAgentPrincipalTx — a live AgentID is not a standing credential.
func (s *Store) ListAgentChannelPageForAgent(ctx context.Context, workspaceID, channelID, agentID string, q PageQuery) (*Page, error) {
	var page *Page
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		var err error
		page, err = s.ListAgentChannelPageForAgentTx(ctx, ex, workspaceID, channelID, agentID, q)
		return err
	})
	if err != nil {
		return nil, err
	}
	return page, nil
}

// ListAgentChannelPageForAgentTx is the snapshot-bound page read. The caller
// supplies the executor (a read snapshot or an open transaction) and must
// already have revalidated the agent credential on that same executor when
// the caller accepted a credential. This method then checks conversation
// read authority and loads the page from that executor: hidden #all,
// roster-less private/DM and a foreign workspace fail closed. Thread unread
// stays empty because the agent viewer has no readstate.
func (s *Store) ListAgentChannelPageForAgentTx(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, agentID string, q PageQuery) (*Page, error) {
	if _, err := s.authorizeAgentRead(ctx, ex, workspaceID, channelID, agentID); err != nil {
		return nil, err
	}
	page, err := s.listChannelPage(ctx, ex, workspaceID, channelID, q, "")
	if err != nil {
		return nil, err
	}
	page.Projections, err = s.ProjectMessages(ctx, ex, workspaceID, page.Messages)
	if err != nil {
		return nil, err
	}
	return page, nil
}

// GetAgentMessageContextForAgent locates messageID inside channelID for an
// AGENT viewer on a fresh snapshot. Credential revalidation belongs on the
// caller's snapshot via GetAgentMessageContextForAgentTx.
func (s *Store) GetAgentMessageContextForAgent(ctx context.Context, workspaceID, channelID, messageID, agentID string, before, after int) (*ContextResult, error) {
	var result *ContextResult
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		var err error
		result, err = s.GetAgentMessageContextForAgentTx(ctx, ex, workspaceID, channelID, messageID, agentID, before, after)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// GetAgentMessageContextForAgentTx is the snapshot-bound context window.
// The caller that accepted a credential must revalidate it on ex before
// calling. A channel-scoped id living in another channel is a not-found,
// not a leak. The same conversation read rules as the page read apply.
func (s *Store) GetAgentMessageContextForAgentTx(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, messageID, agentID string, before, after int) (*ContextResult, error) {
	if _, err := s.authorizeAgentRead(ctx, ex, workspaceID, channelID, agentID); err != nil {
		return nil, err
	}
	return s.getMessageContext(ctx, ex, workspaceID, channelID, messageID, before, after, "")
}
