// Package retryidentity owns canonical original-request claims in a commit.
package retryidentity

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	storage "github.com/atlas-field-systems/atlas-core/retryidentity/generated/storage"
	"github.com/atlas-field-systems/atlas-core/writecommit"
)

//go:embed sql/schema.sql
var files embed.FS

func Schema() string { body, _ := files.ReadFile("sql/schema.sql"); return string(body) }

var ErrConflict = errors.New("request_identity_conflict")
var ErrEnded = errors.New("result_deleted")

type Claim struct {
	Replay                bool
	ResultID              string
	Original              string
	Kind, Scope, Identity string
}

func Check(ctx context.Context, c *writecommit.Commit, kind, scope, id string, original []byte) (Claim, error) {
	facts, err := corefacts.Canonical(original)
	if err != nil {
		return Claim{}, err
	}
	claim := Claim{Kind: kind, Scope: scope, Identity: id, Original: string(facts)}
	value, err := storage.New(c.SQL).ReadClaim(ctx, storage.ReadClaimParams{Kind: kind, Scope: scope, Identity: id})
	if errors.Is(err, sql.ErrNoRows) {
		return claim, nil
	}
	if err != nil {
		return claim, err
	}
	if value.Original != claim.Original {
		return claim, ErrConflict
	}
	if value.Ended != 0 {
		return claim, ErrEnded
	}
	claim.Replay = true
	claim.ResultID = value.ResultID
	return claim, nil
}
func Store(ctx context.Context, c *writecommit.Commit, claim Claim, resultID string) error {
	c.Mutated = true
	return storage.New(c.SQL).PutClaim(ctx, storage.PutClaimParams{Kind: claim.Kind, Scope: claim.Scope, Identity: claim.Identity, Original: claim.Original, ResultID: resultID})
}
func End(ctx context.Context, c *writecommit.Commit, id string) error {
	return storage.New(c.SQL).EndResult(ctx, id)
}
func Clear(ctx context.Context, c *writecommit.Commit) error {
	return storage.New(c.SQL).ClearDataset(ctx)
}
