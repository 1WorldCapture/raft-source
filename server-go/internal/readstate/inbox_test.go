package readstate

import "testing"

func itemByScope(items []InboxItem, scopeID string) *InboxItem {
	for i := range items {
		if items[i].ScopeID == scopeID {
			return &items[i]
		}
	}
	return nil
}

// TestInboxFiltersAndCounts walks all/unread/mentions/unread_mentions over a
// workspace with a public channel, a private channel, a DM, a self-DM and a
// followed thread, each with real unread and mention facts.
func TestInboxFiltersAndCounts(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	generalSeq := fx.insertMessage(fxGeneral, fxBob, "hello general") // unread for alice
	fx.insertMessage(fxGeneral, fxAlice, "alice own")                 // never unread
	fx.insertMessage(fxSecret, fxBob, "secret ping", fxAlice)         // unread + mention
	fx.insertMessage(fxDM, fxBob, "dm ping")
	fx.insertMessage(fxDM2, fxAlice, "self note")                           // own: DM2 never surfaces
	threadSeq := fx.insertMessage(fxThread, fxBob, "thread reply", fxAlice) // mention in thread
	fx.follow(fxAlice, fxThread, false)

	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	// general + secret + dm + thread = 4 (self-DM own-only excluded).
	if len(all.Items) != 4 {
		t.Fatalf("all items = %d: %+v", len(all.Items), all.Items)
	}
	if all.TotalCount != 4 || all.TotalUnreadCount != 4 {
		t.Fatalf("all totals = %d/%d, want 4/4", all.TotalCount, all.TotalUnreadCount)
	}
	if item := itemByScope(all.Items, fxGeneral); item == nil || item.UnreadCount != 1 || *item.LatestActivitySeq != generalSeq {
		t.Fatalf("general row = %+v", item)
	}
	if item := itemByScope(all.Items, fxThread); item == nil || item.UnreadCount != 1 || item.ReplyCount != 1 || !item.HasMention {
		t.Fatalf("thread row = %+v", item)
	}
	if item := itemByScope(all.Items, fxThread); item != nil && item.Kind != "thread" || item != nil && !item.IsFollowing {
		t.Fatalf("thread row kind/follow = %+v", item)
	}

	unread, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if unread.TotalCount != 4 {
		t.Fatalf("unread total = %d, want 4", unread.TotalCount)
	}

	mentions, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	// secret mention + thread mention (mention rows are read-state independent).
	if mentions.TotalCount != 2 {
		t.Fatalf("mentions total = %d, want 2", mentions.TotalCount)
	}
	if itemByScope(mentions.Items, fxSecret) == nil || itemByScope(mentions.Items, fxThread) == nil {
		t.Fatalf("mentions rows = %+v", mentions.Items)
	}
	// Reading the mention keeps it in the Mentions filter (read-state
	// independence) but drops it from unread_mentions.
	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxSecret); err != nil {
		t.Fatal(err)
	}
	mentions, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if mentions.TotalCount != 2 {
		t.Fatalf("read mention dropped from Mentions filter: %+v", mentions.Items)
	}
	unreadMentions, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnreadMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if unreadMentions.TotalCount != 1 || itemByScope(unreadMentions.Items, fxSecret) != nil {
		t.Fatalf("unread_mentions = %+v", unreadMentions.Items)
	}
	_ = threadSeq
}

// TestInboxNonMemberPublicMentionRow: a public-channel mention for a
// non-member surfaces only through the mention rows.
func TestInboxNonMemberPublicMentionRow(t *testing.T) {
	fx := newFixture(t)
	// Carol joins #general in the second seat... use bob mentioning alice is
	// membership-covered; instead seed a third non-member human via guest?
	// The workspace has owner+member only, so use the private-channel removal
	// to build a genuine non-member mention case in the public channel:
	// remove bob from #general, then alice mentions bob there.
	if _, err := fx.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, fxGeneral, fxBob); err != nil {
		t.Fatal(err)
	}
	fx.insertMessage(fxGeneral, fxAlice, "hey bob", fxBob)

	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(all.Items, fxGeneral) != nil {
		t.Fatalf("non-member chat row leaked into All: %+v", all.Items)
	}
	mentions, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item := itemByScope(mentions.Items, fxGeneral)
	if item == nil || !item.HasMention || item.UnreadCount != 0 {
		t.Fatalf("non-member mention row = %+v", item)
	}
	// Done suppresses the mention row up to the confirmed frontier.
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	mentions, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(mentions.Items, fxGeneral) != nil {
		t.Fatalf("done did not suppress the mention row: %+v", mentions.Items)
	}
	// A NEW mention beyond the frontier resurrects it.
	fx.insertMessage(fxGeneral, fxAlice, "again bob", fxBob)
	mentions, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(mentions.Items, fxGeneral) == nil {
		t.Fatalf("post-frontier mention did not resurrect: %+v", mentions.Items)
	}
}

// TestInboxUnfollowedThreadInAll: Activity All keeps not-Done unfollowed
// threads with zeroed unread/mention; the unfollowed history keeps the
// frozen unfollow boundary.
func TestInboxUnfollowedThreadInAll(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.follow(fxAlice, fxThread, false)
	preBoundary := fx.insertMessage(fxThread, fxBob, "before unfollow")
	fx.follow(fxAlice, fxThread, true) // explicit unfollow freezes here
	fx.insertMessage(fxThread, fxBob, "after unfollow")

	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item := itemByScope(all.Items, fxThread)
	if item == nil {
		t.Fatalf("unfollowed thread missing from All: %+v", all.Items)
	}
	if item.UnreadCount != 0 || item.HasMention || item.IsFollowing {
		t.Fatalf("unfollowed row must zero activity: %+v", item)
	}
	if got := *item.LatestActivitySeq; got != preBoundary {
		t.Fatalf("unfollowed frontier = %d, want the boundary %d (post-unfollow reply capped)", got, preBoundary)
	}

	unfollowed, err := fx.store.UnfollowedInboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(unfollowed.Items) != 1 || unfollowed.Items[0].UnfollowedAtMS == nil {
		t.Fatalf("unfollowed history = %+v", unfollowed.Items)
	}
}

// TestInboxDoneHistory: the Done list keeps channel/DM and thread entries
// ordered by done time without resurrecting counts.
func TestInboxDoneHistory(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxDM, fxBob, "dm one")
	fx.insertMessage(fxThread, fxBob, "reply")
	fx.follow(fxAlice, fxThread, false)
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	fx.advance(50)
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	fx.advance(50)
	if _, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread, DoneInput{}); err != nil {
		t.Fatal(err)
	}

	done, err := fx.store.DoneInboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(done.Items) != 3 {
		t.Fatalf("done items = %d: %+v", len(done.Items), done.Items)
	}
	// Newest done first.
	if done.Items[0].ScopeID != fxThread || done.Items[2].ScopeID != fxGeneral {
		t.Fatalf("done order = [%s, %s, %s]", done.Items[0].ScopeID, done.Items[1].ScopeID, done.Items[2].ScopeID)
	}
	for _, item := range done.Items {
		if item.DoneAtMS == nil {
			t.Fatalf("done item without doneAt: %+v", item)
		}
	}
}

// TestInboxQAndPaging: q only filters the caller's own list and paging/counts
// come from the real authorized set.
func TestInboxQAndPaging(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "needle here")
	fx.insertMessage(fxSecret, fxBob, "nothing relevant")
	fx.insertMessage(fxDM, fxBob, "needle dm")

	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Q: "needle", Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != 2 {
		t.Fatalf("q matched %d, want 2: %+v", page.TotalCount, page.Items)
	}
	one, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Q: "needle", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !one.HasMore || len(one.Items) != 1 || one.TotalCount != 2 {
		t.Fatalf("paged q = %+v hasMore=%v total=%d", one.Items, one.HasMore, one.TotalCount)
	}
	// channelId filter selects threads by parent channel and chats by id.
	page, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, ChannelID: fxSecret, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != 1 || page.Items[0].ScopeID != fxSecret {
		t.Fatalf("channelId filter = %+v", page.Items)
	}
}

// TestInboxSortAsc: asc ordering reverses the activity order.
func TestInboxSortAsc(t *testing.T) {
	fx := newFixture(t)
	first := fx.insertMessage(fxGeneral, fxBob, "first")
	fx.advance(100)
	second := fx.insertMessage(fxSecret, fxBob, "second")
	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Sort: "asc"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].ScopeID != fxGeneral || page.Items[1].ScopeID != fxSecret {
		t.Fatalf("asc order wrong: %+v", page.Items)
	}
	_ = first
	_ = second
}

// TestUnreadCountsExcludeDoneAndOwn: Done-suppressed scopes and own messages
// never appear in any unread exit.
func TestUnreadCountsExcludeDoneAndOwn(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxSecret, fxAlice, "own only")
	fx.insertMessage(fxDM, fxBob, "dm one")
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 1 || counts[fxGeneral] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	summary, err := fx.store.UnreadSummary(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary) != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	entry := summary[fxGeneral]
	if entry.UnreadCount != 1 || entry.ReadState == nil || entry.ReadState.Kind != "absent" {
		t.Fatalf("summary entry = %+v", entry)
	}
}

// TestServerUnreadSummary: the account summary counts only joined channels
// and DMs in the sidebar number, threads only in the activity number.
func TestServerUnreadSummary(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.insertMessage(fxGeneral, fxBob, "joined hello")
	fx.insertMessage(fxSecret, fxBob, "member hello")
	// A channel alice did NOT join (public) still counts like the legacy
	// sidebar? The reference counts only joined/implicit + DMs.
	fx.follow(fxAlice, fxThread, false)
	fx.insertMessage(fxThread, fxBob, "thread reply")

	entries, err := fx.store.ServerUnreadSummary(fx.ctx(), fx.claims[fxAlice])
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ServerID != fxWS {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.UnreadCount != 2 {
		t.Fatalf("sidebar unread = %d, want 2 (general + secret)", entry.UnreadCount)
	}
	if entry.ActivityUnreadCount != 3 {
		t.Fatalf("activity unread = %d, want 3 (general + secret + thread)", entry.ActivityUnreadCount)
	}
}
