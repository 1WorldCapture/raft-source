package testkit

import (
	"context"
	"database/sql"

	platformdb "raft.local/server-go/internal/platform/db"
)

// ExecFixture serializes fixture and fault-injection writes with the real
// application's writers. The whole-app testkit starts the delivery pump;
// raw autocommit DDL can otherwise race that pump before the intended fault
// is even installed. Request execution and failure assertions stay unchanged.
// Do not call this helper while already holding a write transaction or fence.
func (e *TestEnv) ExecFixture(query string, args ...any) (sql.Result, error) {
	ctx := context.Background()
	var result sql.Result
	err := platformdb.WithWriteTx(ctx, e.App.DB, func(tx *sql.Tx) error {
		var err error
		result, err = tx.ExecContext(ctx, query, args...)
		return err
	})
	return result, err
}
