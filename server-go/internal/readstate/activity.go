package readstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"

	"raft.local/server-go/internal/auth"
)

// Activity window parameters frozen from the reference implementation.
const (
	ActivityWindowID   = "main"
	ActivityWindowSize = 100
	ActivityRetention  = 2048
)

// Activity filters are the wire enum (unread_mentions is Inbox-only).
const (
	ActivityFilterAll     = "all"
	ActivityFilterUnread  = "unread"
	ActivityFilterMention = "mentions"
)

// SnapshotQuery is the validated /activity/snapshot input.
type SnapshotQuery struct {
	RequestID string
	Filter    string
}

// DifferenceQuery is the validated /activity/difference input.
type DifferenceQuery struct {
	RequestID      string
	Filter         string
	Epoch          string
	AfterWatermark string
}

// ActivityScopeIdentity is the wire scope {serverId,principalId,filter,windowId}.
type ActivityScopeIdentity struct {
	ServerID    string `json:"serverId"`
	PrincipalID string `json:"principalId"`
	Filter      string `json:"filter"`
	WindowID    string `json:"windowId"`
}

// WindowMetadata is the frozen scope metadata JSON.
type WindowMetadata struct {
	NextCursor       *string `json:"nextCursor"`
	HasMore          bool    `json:"hasMore"`
	Complete         bool    `json:"complete"`
	TotalCount       int     `json:"totalCount"`
	TotalUnreadCount int     `json:"totalUnreadCount"`
}

// ActivitySnapshotResult is the 200 snapshot body.
type ActivitySnapshotResult struct {
	Type            string
	RequestID       string
	Scope           ActivityScopeIdentity
	Epoch           string
	Watermark       string
	ActivityVersion string
	Window          ActivityWindowResult
}

// ActivityWindowResult is the window sub-object of snapshot bodies.
type ActivityWindowResult struct {
	Rows             []map[string]any
	Tombstones       []map[string]any
	NextCursor       *string
	HasMore          bool
	Complete         bool
	TotalCount       int
	TotalUnreadCount int
}

// SnapshotRequiredResult is the 409 repair signal.
type SnapshotRequiredResult struct {
	Scope           ActivityScopeIdentity
	Epoch           string
	Watermark       string
	ActivityVersion string
}

// ActivityDifferenceResult ports ActivityDifferenceResult.
type ActivityDifferenceResult struct {
	Status           int // 200 | 409
	Snapshot         *ActivitySnapshotResult
	NotModified      *NotModifiedResult
	NotModifiedBody  *NotModifiedBody
	Difference       *DifferenceResult
	SnapshotRequired *SnapshotRequiredResult
}

// NotModifiedResult is the 200 notModified body.
type NotModifiedResult struct {
	Type            string
	RequestID       string
	Scope           ActivityScopeIdentity
	Epoch           string
	Watermark       string
	ActivityVersion string
}

// NotModifiedBody mirrors NotModifiedResult for JSON assembly in handlers.
type NotModifiedBody NotModifiedResult

// DifferenceResult is the 200 difference body.
type DifferenceResult struct {
	Type             string
	RequestID        string
	Scope            ActivityScopeIdentity
	Epoch            string
	FromSeq          string
	ToSeq            string
	ActivityVersion  string
	Rows             []map[string]any
	Tombstones       []map[string]any
	NextCursor       *string
	HasMore          bool
	Complete         bool
	TotalCount       int
	TotalUnreadCount int
	NextFromSeq      *string
}

// activityPayload is one wire ActivityRow payload WITHOUT rowVersion. The
// digest runs over the canonical JSON of this map; rowVersion is stamped
// separately from the scope row version.
type activityRowState struct {
	rowID         string
	rowVersion    int64
	active        bool
	payload       map[string]any
	payloadDigest string
	tombstone     *string
}

// ActivitySnapshot ports getActivitySnapshot: reconcile the scope against the
// current authorized facts and answer the full main window.
func (s *Store) ActivitySnapshot(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, query SnapshotQuery) (*ActivitySnapshotResult, error) {
	var out *ActivitySnapshotResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		result, err := s.reconcileScopeTx(ctx, tx, claims, workspaceID, query.Filter)
		if err != nil {
			return err
		}
		out = &ActivitySnapshotResult{
			Type:            "snapshot",
			RequestID:       query.RequestID,
			Scope:           result.scope,
			Epoch:           formatUint64(uint64(result.epoch)),
			Watermark:       formatUint64(uint64(result.watermark)),
			ActivityVersion: formatUint64(uint64(result.watermark)),
			Window:          result.window,
		}
		return nil
	})
	return out, err
}

// ActivityDifference ports getActivityDifference.
func (s *Store) ActivityDifference(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, query DifferenceQuery) (*ActivityDifferenceResult, error) {
	requestedEpoch, ok := parseUint64String(query.Epoch)
	if !ok {
		return nil, invalidInput("epoch must be a canonical uint64 decimal string")
	}
	after, ok := parseUint64String(query.AfterWatermark)
	if !ok {
		return nil, invalidInput("afterWatermark must be a canonical uint64 decimal string")
	}
	out := &ActivityDifferenceResult{}
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		reconciled, err := s.reconcileScopeTx(ctx, tx, claims, workspaceID, query.Filter)
		if err != nil {
			return err
		}
		snapshotRequired := func() {
			out.Status = 409
			out.SnapshotRequired = &SnapshotRequiredResult{
				Scope:           reconciled.scope,
				Epoch:           formatUint64(uint64(reconciled.epoch)),
				Watermark:       formatUint64(uint64(reconciled.watermark)),
				ActivityVersion: formatUint64(uint64(reconciled.watermark)),
			}
		}
		// A wire value above the signed-64 storage domain can never match a
		// stored epoch/watermark; answer with the repair signal, not an
		// overflow.
		if requestedEpoch > uint64(1<<63-1) || after > uint64(1<<63-1) {
			snapshotRequired()
			return nil
		}
		if uint64(reconciled.epoch) != requestedEpoch || after > uint64(reconciled.watermark) {
			snapshotRequired()
			return nil
		}
		if after == uint64(reconciled.watermark) {
			out.Status = 200
			out.NotModified = &NotModifiedResult{
				Type:            "notModified",
				RequestID:       query.RequestID,
				Scope:           reconciled.scope,
				Epoch:           formatUint64(uint64(reconciled.epoch)),
				Watermark:       formatUint64(uint64(reconciled.watermark)),
				ActivityVersion: formatUint64(uint64(reconciled.watermark)),
			}
			return nil
		}
		changes, err := loadActivityChangesTx(ctx, tx, workspaceID, claims.Subject, query.Filter, int64(after))
		if err != nil {
			return err
		}
		if len(changes) == 0 || changes[0].seq != int64(after)+1 {
			snapshotRequired()
			return nil
		}
		latestByRow := map[string]activityChange{}
		for _, change := range changes {
			if change.rowID != nil {
				latestByRow[*change.rowID] = change
			}
		}
		rows := []map[string]any{}
		tombstones := []map[string]any{}
		for _, change := range latestByRow {
			if change.kind == "upsert" && change.payload != nil && change.rowVersion != nil {
				row := change.payload
				row["rowVersion"] = formatUint64(uint64(*change.rowVersion))
				rows = append(rows, row)
			} else if change.kind == "tombstone" && change.rowID != nil && change.rowVersion != nil && change.tombstoneReason != nil {
				tombstones = append(tombstones, map[string]any{
					"rowId":      *change.rowID,
					"rowVersion": formatUint64(uint64(*change.rowVersion)),
					"reason":     *change.tombstoneReason,
				})
			}
		}
		// A3: the rows/tombstones arrays are semantic order (the contract's
		// canonicalJson: "arrays keep semantic order"). Map iteration in Go is
		// randomized, so both arrays are sorted with the window comparator:
		// rows by lastActivityAt descending then rowId ascending (identical
		// to materializeWindowTx), tombstones by rowId ascending.
		sort.SliceStable(rows, func(i, j int) bool {
			a, b := rows[i], rows[j]
			aAt, _ := a["lastActivityAt"].(string)
			bAt, _ := b["lastActivityAt"].(string)
			if aAt != bAt {
				return aAt > bAt
			}
			aID, _ := a["rowId"].(string)
			bID, _ := b["rowId"].(string)
			return aID < bID
		})
		sort.SliceStable(tombstones, func(i, j int) bool {
			aID, _ := tombstones[i]["rowId"].(string)
			bID, _ := tombstones[j]["rowId"].(string)
			return aID < bID
		})
		out.Status = 200
		out.Difference = &DifferenceResult{
			Type:             "difference",
			RequestID:        query.RequestID,
			Scope:            reconciled.scope,
			Epoch:            formatUint64(uint64(reconciled.epoch)),
			FromSeq:          formatUint64(after + 1),
			ToSeq:            formatUint64(uint64(reconciled.watermark)),
			ActivityVersion:  formatUint64(uint64(reconciled.watermark)),
			Rows:             rows,
			Tombstones:       tombstones,
			NextCursor:       reconciled.window.NextCursor,
			HasMore:          reconciled.window.HasMore,
			Complete:         reconciled.window.Complete,
			TotalCount:       reconciled.window.TotalCount,
			TotalUnreadCount: reconciled.window.TotalUnreadCount,
			NextFromSeq:      nil,
		}
		return nil
	})
	return out, err
}

type activityChange struct {
	seq             int64
	rowID           *string
	rowVersion      *int64
	kind            string
	payload         map[string]any
	tombstoneReason *string
}

func loadActivityChangesTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, filter string, after int64) ([]activityChange, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT seq, row_id, row_version, kind, payload, tombstone_reason
		FROM activity_changes
		WHERE workspace_id = ? AND principal_id = ? AND filter = ?
		  AND window_id = ? AND seq > ?
		ORDER BY seq ASC`,
		workspaceID, userID, filter, ActivityWindowID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []activityChange{}
	for rows.Next() {
		var change activityChange
		var rowID sql.NullString
		var rowVersion sql.NullInt64
		var payload sql.NullString
		var reason sql.NullString
		if err := rows.Scan(&change.seq, &rowID, &rowVersion, &change.kind, &payload, &reason); err != nil {
			return nil, err
		}
		if rowID.Valid {
			v := rowID.String
			change.rowID = &v
		}
		if rowVersion.Valid {
			v := rowVersion.Int64
			change.rowVersion = &v
		}
		if reason.Valid {
			v := reason.String
			change.tombstoneReason = &v
		}
		if payload.Valid && payload.String != "" {
			decoded, err := decodeJSONObject(payload.String)
			if err != nil {
				return nil, fmt.Errorf("decode activity change payload: %w", err)
			}
			change.payload = decoded
		}
		out = append(out, change)
	}
	return out, rows.Err()
}

// reconciledScope is the in-transaction reconcile outcome.
type reconciledScope struct {
	scope     ActivityScopeIdentity
	epoch     int64
	watermark int64
	window    ActivityWindowResult
}

// reconcileScopeTx ports reconcileInTransaction: rebuild the canonical
// window from current authorized facts, diff it against the materialized
// rows by payload digest, allocate row versions from the shared principal
// authority, append change-journal entries, and roll the epoch when the
// retention budget would overflow. Reads and writes share this one
// consistency boundary.
func (s *Store) reconcileScopeTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, filter string) (*reconciledScope, error) {
	userID := claims.Subject
	if filter != ActivityFilterAll && filter != ActivityFilterUnread && filter != ActivityFilterMention {
		return nil, invalidInput("filter must be all, unread, or mentions")
	}
	now := s.now().UnixMilli()
	// Principal authority.
	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO activity_principal_authorities (workspace_id, principal_id, row_version, updated_at)
		VALUES (?, ?, 0, ?)`, workspaceID, userID, now); err != nil {
		return nil, err
	}
	var principalVersion int64
	if err := tx.QueryRowContext(ctx, `
		SELECT row_version FROM activity_principal_authorities
		WHERE workspace_id = ? AND principal_id = ?`, workspaceID, userID).Scan(&principalVersion); err != nil {
		return nil, err
	}
	// Scope authority.
	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO activity_scopes
			(workspace_id, principal_id, filter, window_id, window_size, epoch, watermark, updated_at)
		VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
		workspaceID, userID, filter, ActivityWindowID, ActivityWindowSize, now); err != nil {
		return nil, err
	}
	var scopeEpoch, scopeWatermark int64
	var scopeDigest sql.NullString
	var scopeMetadata sql.NullString
	if err := tx.QueryRowContext(ctx, `
		SELECT epoch, watermark, scope_digest, metadata
		FROM activity_scopes
		WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
		workspaceID, userID, filter, ActivityWindowID).Scan(&scopeEpoch, &scopeWatermark, &scopeDigest, &scopeMetadata); err != nil {
		return nil, err
	}

	// Canonical window from current facts (same projection the Inbox uses).
	page, err := s.InboxItemsInTx(ctx, tx, claims, workspaceID, InboxQuery{
		Filter: filter,
		Limit:  ActivityWindowSize,
		Offset: 0,
		Sort:   "desc",
	})
	if err != nil {
		if de := AsError(err); de != nil {
			return nil, de
		}
		return nil, err
	}
	canonical := make([]map[string]any, 0, len(page.Items))
	canonicalRowIDs := map[string]bool{}
	for _, item := range page.Items {
		if item.LatestActivitySeq == nil || *item.LatestActivitySeq <= 0 {
			// Fail closed: a row without a provable content frontier is a
			// projection bug, never a fabricated 0 and never a silent drop.
			return nil, fmt.Errorf("activity row %s has no provable latestActivitySeq", item.ScopeID)
		}
		payload := item.ActivityRowPayload()
		canonical = append(canonical, payload)
		canonicalRowIDs[item.ScopeID] = true
	}
	metadata := WindowMetadata{
		NextCursor:       pageWindowCursor(page.HasMore),
		HasMore:          page.HasMore,
		Complete:         !page.HasMore,
		TotalCount:       page.TotalCount,
		TotalUnreadCount: page.TotalUnreadCount,
	}

	// Current materialized rows.
	current, err := loadActivityRowsTx(ctx, tx, workspaceID, userID, filter)
	if err != nil {
		return nil, err
	}
	currentByID := map[string]*activityRowState{}
	for i := range current {
		currentByID[current[i].rowID] = current[i]
	}
	// Row authorities for the canonical ids only.
	authorityByID := map[string]*struct {
		lastVersion   int64
		active        bool
		payloadDigest sql.NullString
	}{}
	if len(canonical) > 0 {
		ids := make([]any, 0, len(canonical))
		for _, payload := range canonical {
			ids = append(ids, payload["rowId"])
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT row_id, last_version, active, payload_digest
			FROM activity_row_authorities
			WHERE workspace_id = ? AND principal_id = ?
			  AND row_id IN (`+placeholders(len(ids))+`)`,
			append([]any{workspaceID, userID}, ids...)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var rowID string
			authority := &struct {
				lastVersion   int64
				active        bool
				payloadDigest sql.NullString
			}{}
			var active int64
			if err := rows.Scan(&rowID, &authority.lastVersion, &active, &authority.payloadDigest); err != nil {
				rows.Close()
				return nil, err
			}
			authority.active = active == 1
			authorityByID[rowID] = authority
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	type pendingChange struct {
		rowID      *string
		rowVersion *int64
		kind       string
		payload    map[string]any
		reason     *string
	}
	pending := []pendingChange{}

	bumpPrincipal := func() (int64, error) {
		principalVersion++
		if _, err := tx.ExecContext(ctx, `
			UPDATE activity_principal_authorities
			SET row_version = ?, updated_at = ?
			WHERE workspace_id = ? AND principal_id = ?`,
			principalVersion, now, workspaceID, userID); err != nil {
			return 0, err
		}
		return principalVersion, nil
	}

	// Upserts.
	for _, payload := range canonical {
		rowID := payload["rowId"].(string)
		payloadDigest := digestHex(payload)
		if current, ok := currentByID[rowID]; ok && current.active && current.payloadDigest == payloadDigest {
			continue
		}
		var rowVersion int64
		if authority, ok := authorityByID[rowID]; ok && authority.active &&
			authority.payloadDigest.Valid && authority.payloadDigest.String == payloadDigest &&
			(currentByID[rowID] == nil || authority.lastVersion > currentByID[rowID].rowVersion) {
			// Cross-filter row identity: reuse the authority version so the
			// same row carries the same rowVersion in every filter.
			rowVersion = authority.lastVersion
		} else {
			rowVersion, err = bumpPrincipal()
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO activity_row_authorities
					(workspace_id, principal_id, row_id, last_version, active, payload_digest, updated_at)
				VALUES (?, ?, ?, ?, 1, ?, ?)
				ON CONFLICT (workspace_id, principal_id, row_id) DO UPDATE SET
					last_version = excluded.last_version,
					active = 1,
					payload_digest = excluded.payload_digest,
					updated_at = excluded.updated_at`,
				workspaceID, userID, rowID, rowVersion, payloadDigest, now); err != nil {
				return nil, err
			}
		}
		if err := upsertActivityRowTx(ctx, tx, workspaceID, userID, filter, rowID, rowVersion, true, &payload, payloadDigest, nil, now); err != nil {
			return nil, err
		}
		pending = append(pending, pendingChange{rowID: &rowID, rowVersion: &rowVersion, kind: "upsert", payload: payload})
	}

	// Tombstones for rows that left the window.
	missing := []*activityRowState{}
	for _, row := range current {
		if row.active && !canonicalRowIDs[row.rowID] {
			missing = append(missing, row)
		}
	}
	if len(missing) > 0 {
		reasons, err := s.tombstoneReasonsTx(ctx, tx, userID, workspaceID, missing)
		if err != nil {
			return nil, err
		}
		for _, row := range missing {
			reason := reasons[row.rowID]
			if reason == "" {
				reason = "outOfWindow"
			}
			rowVersion, err := bumpPrincipal()
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO activity_row_authorities
					(workspace_id, principal_id, row_id, last_version, active, payload_digest, updated_at)
				VALUES (?, ?, ?, ?, 0, NULL, ?)
				ON CONFLICT (workspace_id, principal_id, row_id) DO UPDATE SET
					last_version = excluded.last_version,
					active = 0,
					payload_digest = NULL,
					updated_at = excluded.updated_at`,
				workspaceID, userID, row.rowID, rowVersion, now); err != nil {
				return nil, err
			}
			if err := upsertActivityRowTx(ctx, tx, workspaceID, userID, filter, row.rowID, rowVersion, false, nil, "", &reason, now); err != nil {
				return nil, err
			}
			pending = append(pending, pendingChange{rowID: &row.rowID, rowVersion: &rowVersion, kind: "tombstone", reason: &reason})
		}
	}

	// Scope fact digest (rows + tombstones + metadata).
	tombstoneFact := []map[string]any{}
	for _, row := range current {
		if !row.active {
			continue
		}
	}
	_ = tombstoneFact
	allRows, err := loadActivityRowsTx(ctx, tx, workspaceID, userID, filter)
	if err != nil {
		return nil, err
	}
	rowsFact := make([]map[string]any, 0, len(canonical))
	for _, payload := range canonical {
		rowsFact = append(rowsFact, map[string]any{
			"rowId":         payload["rowId"],
			"payloadDigest": digestHex(payload),
		})
	}
	stonesFact := []map[string]any{}
	for _, row := range allRows {
		if row.active || row.tombstone == nil {
			continue
		}
		stonesFact = append(stonesFact, map[string]any{
			"rowId":      row.rowID,
			"rowVersion": formatUint64(uint64(row.rowVersion)),
			"reason":     *row.tombstone,
		})
	}
	scopeFact := map[string]any{
		"rows":       rowsFact,
		"tombstones": stonesFact,
		"metadata":   metadataWire(metadata),
	}
	scopeFactDigest := digestHex(scopeFact)
	if !(scopeDigest.Valid && scopeDigest.String == scopeFactDigest) {
		pending = append(pending, pendingChange{kind: "scope", payload: metadataWire(metadata)})
	}

	// Retention: roll the epoch rather than leaving a hole.
	if len(pending) > 0 {
		var retained int64
		if err := tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM activity_changes
			WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
			workspaceID, userID, filter, ActivityWindowID).Scan(&retained); err != nil {
			return nil, err
		}
		if retained+int64(len(pending)) > ActivityRetention {
			scopeEpoch++
			scopeWatermark = 0
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM activity_changes
				WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
				workspaceID, userID, filter, ActivityWindowID); err != nil {
				return nil, err
			}
			// Tombstones only defend inside an epoch; rollover discards them.
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM activity_rows
				WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?
				  AND active = 0`,
				workspaceID, userID, filter, ActivityWindowID); err != nil {
				return nil, err
			}
			scopeFact = map[string]any{
				"rows":       rowsFact,
				"tombstones": []map[string]any{},
				"metadata":   metadataWire(metadata),
			}
			scopeFactDigest = digestHex(scopeFact)
			if _, err := tx.ExecContext(ctx, `
				UPDATE activity_scopes
				SET epoch = ?, watermark = 0, scope_digest = NULL, metadata = NULL, updated_at = ?
				WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
				scopeEpoch, now, workspaceID, userID, filter, ActivityWindowID); err != nil {
				return nil, err
			}
		}
	}

	// Append the change journal.
	watermark := scopeWatermark
	for _, change := range pending {
		watermark++
		var rowID any
		if change.rowID != nil {
			rowID = *change.rowID
		}
		var rowVersion any
		if change.rowVersion != nil {
			rowVersion = *change.rowVersion
		}
		var payload any
		if change.payload != nil {
			payload = encodeJSON(change.payload)
		}
		var reason any
		if change.reason != nil {
			reason = *change.reason
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO activity_changes
				(workspace_id, principal_id, filter, window_id, seq, row_id, row_version,
				 kind, payload, tombstone_reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			workspaceID, userID, filter, ActivityWindowID, watermark,
			rowID, rowVersion, change.kind, payload, reason, now); err != nil {
			return nil, err
		}
	}
	if len(pending) > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE activity_scopes
			SET watermark = ?, scope_digest = ?, metadata = ?, updated_at = ?
			WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
			watermark, scopeFactDigest, encodeJSON(metadataWire(metadata)), now,
			workspaceID, userID, filter, ActivityWindowID); err != nil {
			return nil, err
		}
	}

	window, err := s.materializeWindowTx(ctx, tx, workspaceID, userID, filter, scopeEpoch, watermark, metadata)
	if err != nil {
		return nil, err
	}
	return &reconciledScope{
		scope: ActivityScopeIdentity{
			ServerID:    workspaceID,
			PrincipalID: userID,
			Filter:      filter,
			WindowID:    ActivityWindowID,
		},
		epoch:     scopeEpoch,
		watermark: watermark,
		window:    window,
	}, nil
}

func pageWindowCursor(hasMore bool) *string {
	if hasMore {
		v := formatUint64(ActivityWindowSize)
		return &v
	}
	return nil
}

func metadataWire(m WindowMetadata) map[string]any {
	return map[string]any{
		"nextCursor":       m.NextCursor,
		"hasMore":          m.HasMore,
		"complete":         m.Complete,
		"totalCount":       m.TotalCount,
		"totalUnreadCount": m.TotalUnreadCount,
	}
}

func upsertActivityRowTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, filter, rowID string,
	rowVersion int64, active bool, payload *map[string]any, payloadDigest string, reason *string, now int64) error {
	var payloadJSON any
	if payload != nil {
		payloadJSON = encodeJSON(*payload)
	}
	var reasonJSON any
	if reason != nil {
		reasonJSON = *reason
	}
	var activeInt int64
	if active {
		activeInt = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO activity_rows
			(workspace_id, principal_id, filter, window_id, row_id, row_version,
			 active, payload, payload_digest, tombstone_reason, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (workspace_id, principal_id, filter, window_id, row_id) DO UPDATE SET
			row_version = excluded.row_version,
			active = excluded.active,
			payload = excluded.payload,
			payload_digest = excluded.payload_digest,
			tombstone_reason = excluded.tombstone_reason,
			updated_at = excluded.updated_at`,
		workspaceID, userID, filter, ActivityWindowID, rowID, rowVersion,
		activeInt, payloadJSON, payloadDigest, reasonJSON, now)
	return err
}

func loadActivityRowsTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, filter string) ([]*activityRowState, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT row_id, row_version, active, payload, payload_digest, tombstone_reason
		FROM activity_rows
		WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?
		ORDER BY row_id ASC`,
		workspaceID, userID, filter, ActivityWindowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*activityRowState{}
	for rows.Next() {
		var state activityRowState
		var active int64
		var payload sql.NullString
		var digest sql.NullString
		var reason sql.NullString
		if err := rows.Scan(&state.rowID, &state.rowVersion, &active, &payload, &digest, &reason); err != nil {
			return nil, err
		}
		state.active = active == 1
		if digest.Valid {
			state.payloadDigest = digest.String
		}
		if reason.Valid {
			v := reason.String
			state.tombstone = &v
		}
		if payload.Valid && payload.String != "" {
			decoded, err := decodeJSONObject(payload.String)
			if err != nil {
				return nil, fmt.Errorf("decode activity row payload: %w", err)
			}
			state.payload = decoded
		}
		out = append(out, &state)
	}
	return out, rows.Err()
}

// tombstoneReasonsTx ports tombstoneReasons: done first (the caller's own
// Done rows), then deleted channels, else outOfWindow. An unreadable private
// parent cannot be expressed with a faithful reason here, so the scope rolls
// its epoch instead (handled by the digest comparison).
func (s *Store) tombstoneReasonsTx(ctx context.Context, tx *sql.Tx, userID, workspaceID string, missing []*activityRowState) (map[string]string, error) {
	reasons := map[string]string{}
	rowIDs := make([]any, 0, len(missing))
	for _, row := range missing {
		rowIDs = append(rowIDs, row.rowID)
	}
	// Done rows — but only rows still suppressing (done_through >= the
	// channel's latest activity): a row that left the window because newer
	// activity revived it (or a read advanced the unread filter's boundary)
	// is outOfWindow, not done.
	rows, err := tx.QueryContext(ctx, `
		SELECT d.channel_id FROM user_channel_done_states d
		WHERE d.workspace_id = ? AND d.user_id = ? AND d.done_at IS NOT NULL
		  AND d.done_through_activity_seq >=
		      COALESCE((SELECT MAX(m.seq) FROM messages m
		                WHERE m.workspace_id = d.workspace_id
		                  AND m.channel_id = d.channel_id), 0)
		  AND d.channel_id IN (`+placeholders(len(rowIDs))+`)`,
		append([]any{workspaceID, userID}, rowIDs...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		if err := rows.Scan(&channelID); err != nil {
			rows.Close()
			return nil, err
		}
		reasons[channelID] = "done"
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Channel existence.
	rows, err = tx.QueryContext(ctx, `
		SELECT id, deleted_at IS NOT NULL FROM channels
		WHERE id IN (`+placeholders(len(rowIDs))+`)`, rowIDs...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var deleted bool
		if err := rows.Scan(&channelID, &deleted); err != nil {
			rows.Close()
			return nil, err
		}
		if _, done := reasons[channelID]; done {
			continue
		}
		if deleted {
			reasons[channelID] = "deleted"
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return reasons, nil
}

// materializeWindowTx reads back the materialized window inside the same
// transaction, verifying the scope identity did not move underneath.
func (s *Store) materializeWindowTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, filter string, epoch, watermark int64, fallback WindowMetadata) (ActivityWindowResult, error) {
	rows, err := loadActivityRowsTx(ctx, tx, workspaceID, userID, filter)
	if err != nil {
		return ActivityWindowResult{}, err
	}
	var liveEpoch, liveWatermark int64
	var liveMetadata sql.NullString
	if err := tx.QueryRowContext(ctx, `
		SELECT epoch, watermark, metadata FROM activity_scopes
		WHERE workspace_id = ? AND principal_id = ? AND filter = ? AND window_id = ?`,
		workspaceID, userID, filter, ActivityWindowID).Scan(&liveEpoch, &liveWatermark, &liveMetadata); err != nil {
		return ActivityWindowResult{}, err
	}
	if liveEpoch != epoch || liveWatermark != watermark {
		return ActivityWindowResult{}, errors.New("activity scope changed inside its authority transaction")
	}
	metadata := fallback
	if liveMetadata.Valid && liveMetadata.String != "" {
		if decoded, err := decodeWindowMetadata(liveMetadata.String); err == nil {
			metadata = decoded
		}
	}
	wireRows := []map[string]any{}
	tombstones := []map[string]any{}
	for _, row := range rows {
		if row.active && row.payload != nil {
			wireRow := row.payload
			wireRow["rowVersion"] = formatUint64(uint64(row.rowVersion))
			wireRows = append(wireRows, wireRow)
		} else if !row.active && row.tombstone != nil {
			tombstones = append(tombstones, map[string]any{
				"rowId":      row.rowID,
				"rowVersion": formatUint64(uint64(row.rowVersion)),
				"reason":     *row.tombstone,
			})
		}
	}
	sort.SliceStable(wireRows, func(i, j int) bool {
		a, b := wireRows[i], wireRows[j]
		aAt, _ := a["lastActivityAt"].(string)
		bAt, _ := b["lastActivityAt"].(string)
		if aAt != bAt {
			return aAt > bAt
		}
		aID, _ := a["rowId"].(string)
		bID, _ := b["rowId"].(string)
		return aID < bID
	})
	return ActivityWindowResult{
		Rows:             wireRows,
		Tombstones:       tombstones,
		NextCursor:       metadata.NextCursor,
		HasMore:          metadata.HasMore,
		Complete:         metadata.Complete,
		TotalCount:       metadata.TotalCount,
		TotalUnreadCount: metadata.TotalUnreadCount,
	}, nil
}
