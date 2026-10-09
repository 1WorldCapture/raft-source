// Domain adapter for the Agent CLI ports. It maps messaging, the agent
// conversation read model and the delivery inbox onto the transport ports.
// Wire sentences stay here; the application packages return facts and
// typed domain errors only.
package agentapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/agentconversation"
	"raft.local/server-go/internal/application/agentdelivery"
	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/transport/presenter"
)

// DomainAdapter is the production implementation of the four Agent API ports.
type DomainAdapter struct {
	messaging *messaging.Service
	reads     *agentconversation.Service
	inbox     *agentdelivery.Service
}

// NewDomainAdapter requires the three fact owners. A missing one is a
// construction error, not a 501 fallback.
func NewDomainAdapter(messagingSvc *messaging.Service, reads *agentconversation.Service, inbox *agentdelivery.Service) (*DomainAdapter, error) {
	if messagingSvc == nil || reads == nil || inbox == nil {
		return nil, errors.New("agentapi: messaging, conversation reads and delivery inbox are required")
	}
	return &DomainAdapter{messaging: messagingSvc, reads: reads, inbox: inbox}, nil
}

// SendAgent maps the CLI idempotency key onto the message random id and
// commits through the messaging use case.
func (a *DomainAdapter) SendAgent(ctx context.Context, principal agent.CredentialLookup, in AgentSendInput) (*message.CreateResult, error) {
	input := in.CreateInput
	if in.IdempotencyKey != "" {
		key := in.IdempotencyKey
		input.RandomID = &key
	}
	return a.messaging.SendAgent(ctx, principal, input)
}

// ResolveWritableAgentTarget resolves a writable target, including canonical
// Agent DM creation owned by messaging.
func (a *DomainAdapter) ResolveWritableAgentTarget(ctx context.Context, principal agent.CredentialLookup, target string) (*WritableTargetResolution, error) {
	if channelID, ok := channelIDTarget(target); ok {
		conv, err := a.reads.WritableByChannelID(ctx, principal, channelID)
		if err != nil {
			return nil, mapTargetError(target, err)
		}
		return &WritableTargetResolution{ChannelID: conv.Channel.ID, Kind: agentTargetKind(conv.Channel.Type)}, nil
	}
	resolved, err := a.messaging.ResolveAgentTarget(ctx, principal, target)
	if err != nil {
		return nil, mapTargetError(target, err)
	}
	return &WritableTargetResolution{ChannelID: resolved.ChannelID, Kind: agentTargetKind(resolved.ChannelType)}, nil
}

// ReadAgentHistory reads one authorized window and projects it to presenter facts.
func (a *DomainAdapter) ReadAgentHistory(ctx context.Context, principal agent.CredentialLookup, q AgentHistoryQuery) (*presenter.AgentHistoryFacts, error) {
	facts, err := a.reads.ReadHistory(ctx, principal, agentconversation.HistoryQuery{
		ChannelRef: q.ChannelRef, Before: q.Before, After: q.After, Around: q.Around, Limit: q.Limit,
	})
	if err != nil {
		return nil, mapHistoryError(err)
	}
	out := &presenter.AgentHistoryFacts{
		HasOlder: facts.HasOlder, HasNewer: facts.HasNewer, LastReadSeq: facts.LastReadSeq,
		Messages: make([]presenter.AgentMessageFacts, 0, len(facts.Messages)),
	}
	for _, row := range facts.Messages {
		out.Messages = append(out.Messages, MessageFactsWire(row))
	}
	return out, nil
}

// DrainEvents is the legacy destructive check.
func (a *DomainAdapter) DrainEvents(ctx context.Context, principal agent.CredentialLookup, q AgentEventQuery) (*AgentEventBatch, error) {
	batch, err := a.inbox.DrainEvents(ctx, principal, q.SinceSeq, q.Limit)
	if err != nil {
		return nil, err
	}
	return eventBatch(batch), nil
}

// ClaimEvents leases a batch without acknowledging it.
func (a *DomainAdapter) ClaimEvents(ctx context.Context, principal agent.CredentialLookup, q AgentEventQuery) (*AgentEventBatch, error) {
	batch, err := a.inbox.ClaimEvents(ctx, principal, q.SinceSeq, q.Limit)
	if err != nil {
		return nil, err
	}
	return eventBatch(batch), nil
}

// AckEvents acknowledges a previously claimed batch. The removed count is the
// number removed by this call.
func (a *DomainAdapter) AckEvents(ctx context.Context, principal agent.CredentialLookup, seqs []int64, messageIDs []string) (int64, error) {
	return a.inbox.AckClaim(ctx, principal, seqs, messageIDs)
}

func eventBatch(batch *agentdelivery.ClaimedBatch) *AgentEventBatch {
	if batch == nil {
		return &AgentEventBatch{Events: []presenter.AgentMessageFacts{}, AckSeqs: []int64{}, AckMessageIDs: []string{}}
	}
	out := &AgentEventBatch{
		HasMore: batch.HasMore, AckSeqs: batch.AckSeqs, AckMessageIDs: batch.AckMessageIDs,
		Events: make([]presenter.AgentMessageFacts, 0, len(batch.Events)),
	}
	if out.AckSeqs == nil {
		out.AckSeqs = []int64{}
	}
	if out.AckMessageIDs == nil {
		out.AckMessageIDs = []string{}
	}
	for _, row := range batch.Events {
		switch {
		case row.Message != nil:
			out.Events = append(out.Events, MessageFactsWire(*row.Message))
		case row.Notice != nil:
			out.Events = append(out.Events, controlNoticeFacts(*row.Notice))
		}
	}
	return out
}

// DeliveryEncoder is the machine-wire projection of application facts.
type DeliveryEncoder struct{}

// EncodeMessage renders one tracked message body.
func (DeliveryEncoder) EncodeMessage(facts agentconversation.MessageFacts) (json.RawMessage, error) {
	return json.Marshal(presenter.AgentMessageWire(MessageFactsWire(facts)))
}

// EncodeControl renders one private briefing notice. Seq stays 0; the
// dispatcher puts that on the frame, not in this object.
func (DeliveryEncoder) EncodeControl(notice agentdelivery.ControlNotice) (json.RawMessage, error) {
	return json.Marshal(presenter.AgentMessageWire(controlNoticeFacts(notice)))
}

// controlNoticeFacts is the private briefing envelope: seq 0, the stable
// delivery id as message_id, and a system sender. Seq 0 is omitted by the
// frozen envelope tag; acknowledgement uses the notice id, not a zero seq.
func controlNoticeFacts(notice agentdelivery.ControlNotice) presenter.AgentMessageFacts {
	return presenter.AgentMessageFacts{
		Seq:         0,
		MessageID:   notice.NoticeID,
		TimestampMS: notice.CreatedAt,
		SenderType:  "system",
		SenderName:  "system",
		ChannelID:   notice.ChannelID,
		ChannelName: notice.ChannelName,
		ChannelType: channel.TypeChannel,
		Content:     notice.Content,
	}
}

// MessageFactsWire copies application facts into the presenter input.
func MessageFactsWire(f agentconversation.MessageFacts) presenter.AgentMessageFacts {
	return presenter.AgentMessageFacts{
		Seq: f.Seq, MessageID: f.MessageID, TimestampMS: f.TimestampMS,
		SenderType: f.SenderType, SenderName: f.SenderName, SenderDescription: f.SenderDescription,
		ChannelID: f.ChannelID, ChannelName: f.ChannelName, ChannelType: f.ChannelType,
		ParentChannelName: f.ParentChannelName, ParentChannelType: f.ParentChannelType,
		Content: f.Content, Mentioned: f.Mentioned, NonMemberMention: f.NonMemberMention,
		ThreadID: f.ThreadID, ReplyCount: f.ReplyCount,
	}
}

func channelIDTarget(target string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(target), "channelId:")
	if !ok {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	if rest == "" || strings.Contains(rest, ":") {
		return "", false
	}
	return rest, true
}

func agentTargetKind(channelType string) string {
	if channelType == channel.TypeJoint {
		return channel.TypePrivate
	}
	return channelType
}

func mapHistoryError(err error) error {
	switch {
	case errors.Is(err, agentconversation.ErrHistoryChannelHidden):
		return HistoryChannelHiddenError
	case errors.Is(err, agentconversation.ErrHistoryForbidden):
		return HistoryForbiddenError
	}
	var anchor *agentconversation.AnchorError
	if errors.As(err, &anchor) {
		return &HistoryAnchorError{Reason: anchor.Reason, ChannelRef: anchor.Channel, Anchor: anchor.Anchor}
	}
	return err
}

func mapTargetError(target string, err error) error {
	var forbidden *messaging.AgentTargetForbidden
	var notFound *messaging.AgentTargetNotFound
	var peer *messaging.AgentTargetPeerNotFound
	var self *messaging.AgentTargetSelfDM
	var unsupported *messaging.AgentTargetUnsupported
	switch {
	case errors.As(err, &forbidden):
		return &TargetForbiddenError{Message: forbiddenMessageForTarget(target)}
	case errors.As(err, &notFound):
		return &TargetNotFoundError{Message: notFoundMessageForTarget(target)}
	case errors.As(err, &peer):
		return ErrAgentTargetPeerNotFound
	case errors.As(err, &self):
		return ErrAgentTargetSelfDM
	case errors.As(err, &unsupported):
		messageText := unsupported.Reason
		if messageText == "" {
			messageText = "Agent-to-agent direct messages are not enabled in this server stage"
		}
		return &AgentDMNotEnabledError{Message: messageText}
	case errors.Is(err, messaging.ErrAgentTargetShape):
		return &message.InvalidInput{Reason: "target is required"}
	case errors.Is(err, message.ErrChannelArchived):
		return &agent.Error{Status: 409, Code: "channel_archived", Message: "This channel is archived"}
	}
	if de := channel.AsDomainError(err); de != nil {
		switch {
		case de.Code == channel.CodeConflict || strings.Contains(de.Message, "archived"):
			return &agent.Error{Status: 409, Code: "channel_archived", Message: "This channel is archived"}
		case strings.Contains(de.Message, "#announcement"):
			return &TargetForbiddenError{Message: announcementForbidden}
		case de.Code == channel.CodeForbidden:
			return &TargetForbiddenError{Message: forbiddenMessageForTarget(target)}
		case de.Code == channel.CodeNotFound:
			return &TargetNotFoundError{Message: notFoundMessageForTarget(target)}
		}
	}
	return err
}

const announcementForbidden = "The #announcement channel is one-way: replies and threads are not allowed. Post a new top-level message to #announcement instead."

func forbiddenMessageForTarget(target string) string {
	parsed, ok := parseThreadTarget(target)
	if ok && parsed.kind == "channel" && parsed.name == "announcement" {
		return announcementForbidden
	}
	if ok && parsed.kind == "channel" {
		return "Agent cannot post in this thread - not a member of the parent channel. Following a thread grants listen access only; joining the parent channel is required to send. If you were @mentioned and need to respond, DM the person who mentioned you and let them know you're not in the channel."
	}
	return "Agent cannot post in this channel - not a member. If you were @mentioned and need to respond, DM the person who mentioned you and let them know you're not in the channel."
}

func notFoundMessageForTarget(target string) string {
	if _, ok := parseThreadTarget(target); ok {
		return "Thread target not found or not replyable: " + target + ". Use #channel:<parentMsgShortId> or dm:@peer:<parentMsgShortId>; the parent message must exist and belong to that parent target."
	}
	return "Channel not found: " + target
}

type parsedThreadTarget struct {
	kind string
	name string
}

func parseThreadTarget(target string) (parsedThreadTarget, bool) {
	if strings.HasPrefix(target, "#") {
		rest := target[1:]
		if i := strings.LastIndex(rest, ":"); i > 0 && isHex8(rest[i+1:]) {
			return parsedThreadTarget{kind: "channel", name: rest[:i]}, true
		}
	}
	lower := target
	if strings.HasPrefix(lower, "dm:@") || strings.HasPrefix(lower, "DM:@") {
		rest := target[4:]
		if i := strings.LastIndex(rest, ":"); i > 0 && isHex8(rest[i+1:]) {
			return parsedThreadTarget{kind: "dm", name: rest[:i]}, true
		}
	}
	return parsedThreadTarget{}, false
}

func isHex8(v string) bool {
	if len(v) != 8 {
		return false
	}
	for _, c := range v {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
