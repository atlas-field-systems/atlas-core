// Package activity records attributed administrative and tasking actions.
package activity

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/activity/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
)

// Log writes activity in the caller's transaction so it cannot disagree with
// an accepted Task. Later activity readers use this module's private table.
type Log struct{ queries *db.Queries }

func New(operational *sql.DB) *Log { return &Log{queries: db.New(operational)} }

func (l *Log) Record(ctx context.Context, tx *sql.Tx, caller identity.Caller, action string, target uuid.UUID) error {
	err := l.queries.WithTx(tx).Record(ctx, db.RecordParams{ActorKind: string(caller.Kind), ActorID: caller.ID, Action: action, TargetID: target.String(), RecordedAt: time.Now().UnixMilli()})
	if err != nil {
		return fmt.Errorf("record %s activity for %s: %w", action, target, err)
	}
	return nil
}
