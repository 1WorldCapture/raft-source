package agentconversation

// MessageFacts is the transport-neutral projection of one agent-visible
// message. It carries agent-facing sender types (human|agent|system|
// third_party_app) and thread channel names already resolved to the stored
// thread-<shortid> form. Seq 0 means the row has no messages.seq. The HTTP
// and machine presenters map this struct onto wire JSON; this package does
// not import them.
type MessageFacts struct {
	Seq               int64
	MessageID         string
	TimestampMS       int64
	SenderType        string
	SenderName        string
	SenderDescription *string
	ChannelID         string
	ChannelName       string
	ChannelType       string
	ParentChannelName *string
	ParentChannelType *string
	Content           string
	Mentioned         bool
	NonMemberMention  bool
	ThreadID          *string
	ReplyCount        *int64
}

// HistoryFacts is one authorized history window. Messages are oldest to
// newest. Agents have no read cursor in this stage, so LastReadSeq stays nil
// rather than a fabricated zero.
type HistoryFacts struct {
	Messages    []MessageFacts
	HasOlder    bool
	HasNewer    bool
	LastReadSeq *int64
}
