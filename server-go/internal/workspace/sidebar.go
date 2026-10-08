// Sidebar preference read for GET /api/servers/:id/sidebar-order (M2 settings
// worker). The full PATCH sidebar contract (custom-section CAS, pinnedVersion,
// events) is explicitly deferred; this file only reads, sanitizes and hydrates.
//
// Contract sources:
//   - packages/server/src/routes/servers.ts:461-720 (R16):
//     getAllowedSidebarIds, canonicalizeSidebarSections,
//     canonicalizePinnedRefs, synthesizePinnedRefsFromLegacy,
//     projectLegacyPinnedFields, mergeLegacyPinnedFields,
//     hydrateSidebarPinnedResponse;
//   - packages/server/src/services/serverService.ts:1694-1860 (R16):
//     getSanitizedMemberSidebarOrder — per-array visibility SQL.
//
// Sanitization rules (ported from the legacy SQL, never returning raw
// persisted ids):
//   - channelOrder/pinnedChannelIds/pinnedOrder: channels of THIS workspace,
//     type channel (public) or private/joint with a channel_humans row for the
//     requester, not deleted, not archived;
//   - agentOrder/pinnedAgentIds/pinnedOrder: agents of THIS workspace that are
//     not deleted;
//   - dmOrder/pinnedChannelIds/pinnedOrder/hiddenDmIds: type=dm channels of
//     THIS workspace where the requester has a channel_humans row (legacy DM
//     sanitize does not filter dm deletion);
//   - panel tab orders are filtered to the fixed legacy whitelists;
//   - typed pinned (pinned_refs) is canonicalized against the same sets, and
//     when it is unset the response synthesizes typed refs from the legacy
//     pinned fields; the legacy triple is then re-projected for consistency.
//
// Known M2 boundaries (registered in the worker report): agent/self DM peer
// resolution requires the channel-agent directory planned for later phases;
// M2 resolves human peers of two-human DMs only. Unknown objects are never
// treated as visible, and cross-workspace ids can therefore not leak.
package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"sort"
)

// pinnedRef is one typed pin (TS SidebarPinnedRef).
type pinnedRef struct {
	Kind string
	ID   string
}

func (r pinnedRef) key() string { return r.Kind + ":" + r.ID }

// customSection is one user-defined sidebar section (TS SidebarCustomSection).
type customSection struct {
	ID       string
	Name     string
	Emoji    *string
	SortMode string
}

// sectionPlacement assigns a channel/agent to a custom section (TS
// SidebarSectionPlacement). Position stays float until the canonical
// renumbering, mirroring TS Number.isFinite acceptance.
type sectionPlacement struct {
	Kind      string
	ID        string
	SectionID string
	Position  float64
}

var sidebarSortModes = map[string]bool{"manual": true, "recent": true, "az": true}

// Fixed panel tab whitelists (legacy sanitize SQL ANY(ARRAY[...])).
var channelPanelTabs = map[string]bool{"chat": true, "tasks": true, "files": true}
var agentPanelTabs = map[string]bool{
	"profile": true, "chat": true, "dms": true, "reminders": true,
	"workspace": true, "integrations": true, "activity": true,
}

// System section ids always allowed in sectionOrder (legacy canonicalize).
var systemSectionIDs = []string{"system:pinned", "system:joint", "system:channels", "system:dms"}

// sidebarContext is the visibility context for one requester (TS
// getAllowedSidebarIds, restricted to the M2-real directories).
type sidebarContext struct {
	channelIDs  map[string]bool // visible non-DM channels
	agentIDs    map[string]bool // active agents of the workspace
	humanIDs    map[string]bool // member user ids
	dmIDs       map[string]bool // dm channels the user belongs to (any state)
	dmPeerBy    map[string]pinnedRef
	dmChannelBy map[string]string // pinnedRef.key() -> dm channel id
}

// GetSidebarOrder returns the full sanitized sidebar preference projection
// (19 fields, exactly the matrix dtoFields.SidebarOrder list). Guests are NOT
// rejected here: the legacy route only checks membership.
func (s *Store) GetSidebarOrder(ctx context.Context, workspaceID, userID string) (map[string]any, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&one)
	if err == sql.ErrNoRows {
		return nil, &DomainError{Code: CodeNotFound, Message: errMsgServerNotFound}
	} else if err != nil {
		return nil, err
	}

	var chOrder, agOrder, dmOrder sql.NullString
	var chSort, jointSort, dmSort, pinnedSort sql.NullString
	var pinnedJSON, pinnedCh, pinnedAg, pinnedOrd, hiddenDMs sql.NullString
	var chTabs, agTabs, sectionsJSON, sectionOrderJSON, placementsJSON sql.NullString
	var sectionsVersion, pinnedVersion int64
	err = s.db.QueryRowContext(ctx, `
		SELECT sidebar_channel_order, sidebar_agent_order, sidebar_dm_order,
		       sidebar_channel_sort_mode, sidebar_joint_channel_sort_mode,
		       sidebar_dm_sort_mode, sidebar_pinned_sort_mode,
		       pinned_refs, pinned_channel_ids, pinned_agent_ids, pinned_order, hidden_dm_ids,
		       channel_panel_tab_order, agent_panel_tab_order,
		       sidebar_custom_sections, sidebar_section_order, sidebar_section_placements,
		       sidebar_sections_version, pinned_version
		FROM workspace_member_preferences
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID).
		Scan(&chOrder, &agOrder, &dmOrder, &chSort, &jointSort, &dmSort, &pinnedSort,
			&pinnedJSON, &pinnedCh, &pinnedAg, &pinnedOrd, &hiddenDMs,
			&chTabs, &agTabs, &sectionsJSON, &sectionOrderJSON, &placementsJSON,
			&sectionsVersion, &pinnedVersion)
	if err == sql.ErrNoRows {
		// Membership exists but the preference row is gone: integrity drift,
		// answered with the legacy member-missing sentence rather than
		// inventing defaults.
		return nil, &DomainError{Code: CodeNotFound, Message: "Member not found"}
	} else if err != nil {
		return nil, err
	}

	sctx, err := s.loadSidebarContext(ctx, workspaceID, userID)
	if err != nil {
		return nil, err
	}

	// Sanitized legacy arrays (existence + visibility, stored order kept).
	channelOrder := filterIDs(toStringArray(chOrder), func(id string) bool { return sctx.channelIDs[id] })
	agentOrder := filterIDs(toStringArray(agOrder), func(id string) bool { return sctx.agentIDs[id] })
	dmOrderOut := filterIDs(toStringArray(dmOrder), func(id string) bool { return sctx.dmIDs[id] })
	pinnedChannelIDs := filterIDs(toStringArray(pinnedCh), func(id string) bool {
		return sctx.channelIDs[id] || sctx.dmIDs[id]
	})
	pinnedAgentIDs := filterIDs(toStringArray(pinnedAg), func(id string) bool { return sctx.agentIDs[id] })
	pinnedOrderLegacy := filterIDs(toStringArray(pinnedOrd), func(id string) bool {
		return sctx.channelIDs[id] || sctx.dmIDs[id] || sctx.agentIDs[id]
	})
	hiddenDmIDs := filterIDs(toStringArray(hiddenDMs), func(id string) bool { return sctx.dmIDs[id] })
	channelTabs := filterIDs(toStringArray(chTabs), func(id string) bool { return channelPanelTabs[id] })
	agentTabs := filterIDs(toStringArray(agTabs), func(id string) bool { return agentPanelTabs[id] })

	customSections := toCustomSections(sectionsJSON)
	sectionOrder := toStringArray(sectionOrderJSON)
	placements := toSectionPlacements(placementsJSON)
	sections := canonicalizeSidebarSections(customSections, sectionOrder, placements, sctx)

	var pinned []map[string]any
	var outPinnedChannelIDs, outPinnedAgentIDs, outPinnedOrder []string
	if refs := toPinnedRefs(pinnedJSON); refs != nil {
		canonical := canonicalizePinnedRefs(refs, sctx)
		projected := projectLegacyPinnedFields(canonical, sctx)
		merged := mergeLegacyPinnedFields(projected, legacyPinnedFields{
			channelIDs: pinnedChannelIDs,
			agentIDs:   pinnedAgentIDs,
			order:      pinnedOrderLegacy,
		}, sctx)
		pinned = refsToMaps(canonical)
		outPinnedChannelIDs = merged.channelIDs
		outPinnedAgentIDs = merged.agentIDs
		outPinnedOrder = merged.order
	} else {
		// pinned_refs unset: typed pins are synthesized from the sanitized
		// legacy fields, which are then returned as-is (TS hydrate path).
		pinned = refsToMaps(synthesizePinnedRefsFromLegacy(legacyPinnedFields{
			channelIDs: pinnedChannelIDs,
			agentIDs:   pinnedAgentIDs,
			order:      pinnedOrderLegacy,
		}, sctx))
		outPinnedChannelIDs = pinnedChannelIDs
		outPinnedAgentIDs = pinnedAgentIDs
		outPinnedOrder = pinnedOrderLegacy
	}

	return map[string]any{
		"channelOrder":         strSlice(channelOrder),
		"agentOrder":           strSlice(agentOrder),
		"dmOrder":              strSlice(dmOrderOut),
		"channelSortMode":      toSortMode(chSort),
		"jointChannelSortMode": toSortMode(jointSort),
		"dmSortMode":           toSortMode(dmSort),
		"pinnedSortMode":       toSortMode(pinnedSort),
		"pinned":               pinned,
		"pinnedChannelIds":     strSlice(outPinnedChannelIDs),
		"pinnedAgentIds":       strSlice(outPinnedAgentIDs),
		"pinnedOrder":          strSlice(outPinnedOrder),
		"hiddenDmIds":          strSlice(hiddenDmIDs),
		"channelPanelTabOrder": strSlice(channelTabs),
		"agentPanelTabOrder":   strSlice(agentTabs),
		"customSections":       sectionsToMaps(customSections),
		"sectionOrder":         strSlice(sections.order),
		"sectionPlacements":    placementsToMaps(sections.placements),
		"sectionsVersion":      sectionsVersion,
		"pinnedVersion":        pinnedVersion,
	}, nil
}

// loadSidebarContext resolves the visibility sets for one requester.
func (s *Store) loadSidebarContext(ctx context.Context, workspaceID, userID string) (*sidebarContext, error) {
	sctx := &sidebarContext{
		channelIDs:  map[string]bool{},
		agentIDs:    map[string]bool{},
		humanIDs:    map[string]bool{},
		dmIDs:       map[string]bool{},
		dmPeerBy:    map[string]pinnedRef{},
		dmChannelBy: map[string]string{},
	}

	// Visible non-DM channels: public type=channel, or private/joint with an
	// explicit channel_humans row (legacy requiresExplicitMembership); not
	// deleted, not archived.
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id FROM channels c
		WHERE c.workspace_id = ? AND c.type IN ('channel','private','joint')
		  AND c.deleted_at IS NULL AND c.archived_at IS NULL
		  AND (c.type = 'channel' OR EXISTS (
		      SELECT 1 FROM channel_humans ch WHERE ch.channel_id = c.id AND ch.user_id = ?))`,
		workspaceID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		sctx.channelIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Active agents of this workspace.
	rows, err = s.db.QueryContext(ctx,
		`SELECT id FROM agents WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		sctx.agentIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Member user ids (legacy listServerMemberIds: join non-deleted workspace).
	rows, err = s.db.QueryContext(ctx, `
		SELECT m.user_id FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND w.deleted_at IS NULL`, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		sctx.humanIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// DM channels the user belongs to, in any state (legacy
	// listUserDMChannelIdsIncludingRemoved has no deleted_at filter).
	rows, err = s.db.QueryContext(ctx, `
		SELECT c.id FROM channels c
		JOIN channel_humans ch ON ch.channel_id = c.id AND ch.user_id = ?
		WHERE c.workspace_id = ? AND c.type = 'dm'`, userID, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		sctx.dmIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Peer resolution for non-deleted two-human DMs. M2 has no channel-agent
	// directory, so agent-DM and self-DM provenance cannot be proven; only a
	// second human member identifies a peer (registered boundary).
	rows, err = s.db.QueryContext(ctx, `
		SELECT c.id, other.user_id
		FROM channels c
		JOIN channel_humans mine ON mine.channel_id = c.id AND mine.user_id = ?
		JOIN channel_humans other ON other.channel_id = c.id AND other.user_id != ?
		WHERE c.workspace_id = ? AND c.type = 'dm' AND c.deleted_at IS NULL`,
		userID, userID, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID, peerID string
		if err := rows.Scan(&channelID, &peerID); err != nil {
			rows.Close()
			return nil, err
		}
		ref := pinnedRef{Kind: "human", ID: peerID}
		sctx.dmPeerBy[channelID] = ref
		if _, ok := sctx.dmChannelBy[ref.key()]; !ok {
			sctx.dmChannelBy[ref.key()] = channelID
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	return sctx, nil
}

// legacyPinnedFields bundles the sanitized legacy pinned triple.
type legacyPinnedFields struct {
	channelIDs []string
	agentIDs   []string
	order      []string
}

// refFromLegacyPinnedID maps one legacy pinned id to a typed ref (TS
// refFromLegacyPinnedId): visible channel, dm-with-peer, or agent — else nil.
func refFromLegacyPinnedID(id string, sctx *sidebarContext) *pinnedRef {
	if sctx.channelIDs[id] {
		return &pinnedRef{Kind: "channel", ID: id}
	}
	if peer, ok := sctx.dmPeerBy[id]; ok {
		ref := peer
		return &ref
	}
	if sctx.agentIDs[id] {
		return &pinnedRef{Kind: "agent", ID: id}
	}
	return nil
}

// refForOrderID additionally resolves peer-entity ids that have their own dm
// channel (TS refForOrderId).
func refForOrderID(id string, sctx *sidebarContext) *pinnedRef {
	if ref := refFromLegacyPinnedID(id, sctx); ref != nil {
		return ref
	}
	agentRef := pinnedRef{Kind: "agent", ID: id}
	if _, ok := sctx.dmChannelBy[agentRef.key()]; ok {
		return &agentRef
	}
	humanRef := pinnedRef{Kind: "human", ID: id}
	if _, ok := sctx.dmChannelBy[humanRef.key()]; ok {
		return &humanRef
	}
	return nil
}

// canonicalizePinnedRefs drops invisible refs and dedups (TS
// canonicalizePinnedRefs). A channel-typed id that actually names a dm
// channel is remapped to its peer ref first.
func canonicalizePinnedRefs(refs []pinnedRef, sctx *sidebarContext) []pinnedRef {
	out := []pinnedRef{}
	seen := map[string]bool{}
	for _, raw := range refs {
		ref := raw
		if ref.Kind == "channel" {
			if peer, ok := sctx.dmPeerBy[ref.ID]; ok {
				ref = peer
			}
		}
		if ref.Kind == "channel" && !sctx.channelIDs[ref.ID] {
			continue
		}
		if ref.Kind == "agent" && !sctx.agentIDs[ref.ID] {
			if _, ok := sctx.dmChannelBy[ref.key()]; !ok {
				continue
			}
		}
		if ref.Kind == "human" && !sctx.humanIDs[ref.ID] {
			if _, ok := sctx.dmChannelBy[ref.key()]; !ok {
				continue
			}
		}
		if seen[ref.key()] {
			continue
		}
		seen[ref.key()] = true
		out = append(out, ref)
	}
	return out
}

// synthesizePinnedRefsFromLegacy builds typed pins from the sanitized legacy
// triple when pinned_refs is unset (TS synthesizePinnedRefsFromLegacy).
func synthesizePinnedRefsFromLegacy(legacy legacyPinnedFields, sctx *sidebarContext) []pinnedRef {
	out := []pinnedRef{}
	seen := map[string]bool{}
	add := func(ref *pinnedRef) {
		if ref == nil {
			return
		}
		if seen[ref.key()] {
			return
		}
		seen[ref.key()] = true
		out = append(out, *ref)
	}
	for _, id := range legacy.order {
		add(refFromLegacyPinnedID(id, sctx))
	}
	for _, id := range legacy.channelIDs {
		add(refFromLegacyPinnedID(id, sctx))
	}
	for _, id := range legacy.agentIDs {
		if sctx.agentIDs[id] {
			add(&pinnedRef{Kind: "agent", ID: id})
		}
	}
	return out
}

// projectLegacyPinnedFields projects typed pins back onto the legacy triple
// (TS projectLegacyPinnedFields). A human pin is expressed as its dm channel.
func projectLegacyPinnedFields(pinned []pinnedRef, sctx *sidebarContext) legacyPinnedFields {
	out := legacyPinnedFields{channelIDs: []string{}, agentIDs: []string{}, order: []string{}}
	seenChannel := map[string]bool{}
	seenAgent := map[string]bool{}
	addChannel := func(id string) {
		if seenChannel[id] {
			return
		}
		seenChannel[id] = true
		out.channelIDs = append(out.channelIDs, id)
		out.order = append(out.order, id)
	}
	addAgent := func(id string) {
		if seenAgent[id] {
			return
		}
		seenAgent[id] = true
		out.agentIDs = append(out.agentIDs, id)
		out.order = append(out.order, id)
	}
	for _, ref := range pinned {
		switch ref.Kind {
		case "channel":
			addChannel(ref.ID)
		case "agent":
			addAgent(ref.ID)
		default:
			if channelID, ok := sctx.dmChannelBy[ref.key()]; ok {
				addChannel(channelID)
			}
		}
	}
	return out
}

// mergeLegacyPinnedFields merges the projection of typed pins with the
// sanitized stored legacy triple (TS mergeLegacyPinnedFields): legacy ids keep
// their exact positions, typed-only pins are appended.
func mergeLegacyPinnedFields(projected, legacy legacyPinnedFields, sctx *sidebarContext) legacyPinnedFields {
	appendMissing := func(base, extra []string) []string {
		seen := map[string]bool{}
		for _, id := range base {
			seen[id] = true
		}
		merged := append([]string{}, base...)
		for _, id := range extra {
			if seen[id] {
				continue
			}
			seen[id] = true
			merged = append(merged, id)
		}
		return merged
	}

	legacyOrderKeys := map[string]bool{}
	for _, id := range legacy.order {
		if ref := refForOrderID(id, sctx); ref != nil {
			legacyOrderKeys[ref.key()] = true
		}
	}
	newOnlyProjectedOrder := []string{}
	for _, id := range projected.order {
		ref := refForOrderID(id, sctx)
		if ref == nil || !legacyOrderKeys[ref.key()] {
			newOnlyProjectedOrder = append(newOnlyProjectedOrder, id)
		}
	}

	return legacyPinnedFields{
		channelIDs: appendMissing(projected.channelIDs, legacy.channelIDs),
		agentIDs:   appendMissing(projected.agentIDs, legacy.agentIDs),
		order:      appendMissing(legacy.order, newOnlyProjectedOrder),
	}
}

// canonicalSections is the canonicalized section projection.
type canonicalSections struct {
	order      []string
	placements []sectionPlacement
}

// canonicalizeSidebarSections orders section ids (stored order first, then
// system sections, then custom ids), drops placements into non-custom
// sections or invisible objects, dedups and renumbers positions per section
// (TS canonicalizeSidebarSections). Custom sections pass through unchanged.
func canonicalizeSidebarSections(custom []customSection, sectionOrder []string, placements []sectionPlacement, sctx *sidebarContext) canonicalSections {
	customIDs := map[string]bool{}
	for _, section := range custom {
		customIDs[section.ID] = true
	}
	allowed := map[string]bool{}
	for _, id := range systemSectionIDs {
		allowed[id] = true
	}
	for id := range customIDs {
		allowed[id] = true
	}

	orderedIDs := []string{}
	seen := map[string]bool{}
	candidates := append(append([]string{}, sectionOrder...), systemSectionIDs...)
	for _, section := range custom {
		candidates = append(candidates, section.ID)
	}
	for _, id := range candidates {
		if !allowed[id] || seen[id] {
			continue
		}
		seen[id] = true
		orderedIDs = append(orderedIDs, id)
	}

	sorted := append([]sectionPlacement{}, placements...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Position < sorted[j].Position })
	seenItems := map[string]bool{}
	next := []sectionPlacement{}
	positions := map[string]int{}
	for _, placement := range sorted {
		if !customIDs[placement.SectionID] {
			continue
		}
		if placement.Kind == "channel" && !sctx.channelIDs[placement.ID] && !sctx.dmIDs[placement.ID] {
			continue
		}
		if placement.Kind == "agent" && !sctx.agentIDs[placement.ID] {
			continue
		}
		key := placement.Kind + ":" + placement.ID
		if seenItems[key] {
			continue
		}
		seenItems[key] = true
		placement.Position = float64(positions[placement.SectionID])
		positions[placement.SectionID]++
		next = append(next, placement)
	}
	return canonicalSections{order: orderedIDs, placements: next}
}

// ---- stored-JSON coercion helpers (defensive reads of write-protected
// columns; M2 has no sidebar writer, so these only matter for seeded or
// drifted data). Malformed JSON degrades to the empty default instead of a
// 500; this is a registered, fail-visible divergence from legacy raw SQL. ----

// toStringArray keeps string entries of a stored JSON array (TS toStringArray).
func toStringArray(v sql.NullString) []string {
	if !v.Valid {
		return []string{}
	}
	var arr []any
	if err := json.Unmarshal([]byte(v.String), &arr); err != nil {
		return []string{}
	}
	out := []string{}
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// toSortMode coerces an invalid stored mode to manual (TS toSidebarSortMode).
func toSortMode(v sql.NullString) string {
	if v.Valid && sidebarSortModes[v.String] {
		return v.String
	}
	return "manual"
}

// toPinnedRefs parses pinned_refs: nil when unset/invalid (the response then
// synthesizes typed pins from the legacy fields), entries with a valid kind
// and string id otherwise (TS toSidebarPinnedRefs).
func toPinnedRefs(v sql.NullString) []pinnedRef {
	if !v.Valid {
		return nil
	}
	var arr []any
	if err := json.Unmarshal([]byte(v.String), &arr); err != nil {
		return nil
	}
	refs := []pinnedRef{}
	for _, item := range arr {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, kindOK := obj["kind"].(string)
		id, idOK := obj["id"].(string)
		if !kindOK || !idOK {
			continue
		}
		if kind != "channel" && kind != "agent" && kind != "human" {
			continue
		}
		refs = append(refs, pinnedRef{Kind: kind, ID: id})
	}
	return refs
}

// toCustomSections coerces stored custom sections (TS toSidebarCustomSections).
func toCustomSections(v sql.NullString) []customSection {
	if !v.Valid {
		return []customSection{}
	}
	var arr []any
	if err := json.Unmarshal([]byte(v.String), &arr); err != nil {
		return []customSection{}
	}
	out := []customSection{}
	for _, item := range arr {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, idOK := obj["id"].(string)
		name, nameOK := obj["name"].(string)
		sortMode, sortOK := obj["sortMode"].(string)
		if !idOK || !nameOK || !sortOK || !sidebarSortModes[sortMode] {
			continue
		}
		var emoji *string
		if e, ok := obj["emoji"].(string); ok {
			emoji = &e
		}
		out = append(out, customSection{ID: id, Name: name, Emoji: emoji, SortMode: sortMode})
	}
	return out
}

// toSectionPlacements coerces stored placements (TS toSidebarSectionPlacements).
func toSectionPlacements(v sql.NullString) []sectionPlacement {
	if !v.Valid {
		return []sectionPlacement{}
	}
	var arr []any
	if err := json.Unmarshal([]byte(v.String), &arr); err != nil {
		return []sectionPlacement{}
	}
	out := []sectionPlacement{}
	for _, item := range arr {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, kindOK := obj["kind"].(string)
		id, idOK := obj["id"].(string)
		sectionID, sectionOK := obj["sectionId"].(string)
		position, posOK := obj["position"].(float64)
		if !kindOK || !idOK || !sectionOK || !posOK {
			continue
		}
		if kind != "channel" && kind != "agent" {
			continue
		}
		if math.IsNaN(position) || math.IsInf(position, 0) {
			continue
		}
		out = append(out, sectionPlacement{Kind: kind, ID: id, SectionID: sectionID, Position: position})
	}
	return out
}

// filterIDs keeps stored order (and duplicates) while dropping ids the
// predicate rejects — the array_agg WITH ORDINALITY behavior.
func filterIDs(ids []string, keep func(string) bool) []string {
	out := []string{}
	for _, id := range ids {
		if keep(id) {
			out = append(out, id)
		}
	}
	return out
}

// strSlice guarantees a non-nil slice so JSON renders [] instead of null.
func strSlice(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func refsToMaps(refs []pinnedRef) []map[string]any {
	out := []map[string]any{}
	for _, ref := range refs {
		out = append(out, map[string]any{"kind": ref.Kind, "id": ref.ID})
	}
	return out
}

func sectionsToMaps(sections []customSection) []map[string]any {
	out := []map[string]any{}
	for _, section := range sections {
		var emoji any
		if section.Emoji != nil {
			emoji = *section.Emoji
		}
		out = append(out, map[string]any{
			"id":       section.ID,
			"name":     section.Name,
			"emoji":    emoji,
			"sortMode": section.SortMode,
		})
	}
	return out
}

func placementsToMaps(placements []sectionPlacement) []map[string]any {
	out := []map[string]any{}
	for _, p := range placements {
		out = append(out, map[string]any{
			"kind":      p.Kind,
			"id":        p.ID,
			"sectionId": p.SectionID,
			"position":  int64(p.Position),
		})
	}
	return out
}
