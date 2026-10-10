package system

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/atlas-field-systems/atlas-core/system/generated/storage"
	"github.com/google/uuid"
)

// ClaimOutcome is the retry identity decision for one request identity.
type ClaimOutcome int

const (
	// First: no earlier claim; perform the effect and complete the claim.
	First ClaimOutcome = iota
	// Replay: an identical earlier claim; return its recorded result.
	Replay
	// Conflict: the identity was used with different original facts.
	Conflict
	// Ended: the recorded result was later deleted or revoked.
	Ended
)

// Claim is a looked-up retry identity.
type Claim struct {
	Outcome   ClaimOutcome
	Result    []byte
	ResultRef string
	Cursor    string
}

// Claim looks up a Dataset-scoped retry identity of the given kind. facts are
// the canonical original request facts; comparison never uses current state.
func (t *Tx) Claim(kind, identity string, facts []byte) (Claim, error) {
	existing, err := storage.New(t.tx).GetClaim(t.ctx, storage.GetClaimParams{Kind: kind, Identity: canonicalIdentifier(identity)})
	if errors.Is(err, sql.ErrNoRows) {
		return Claim{Outcome: First}, nil
	}
	if err != nil {
		return Claim{}, fmt.Errorf("read %s retry identity: %w", kind, err)
	}
	claim := Claim{Result: []byte(existing.Result), ResultRef: existing.ResultRef, Cursor: Cursor(existing.CommitSeq)}
	switch {
	case !bytes.Equal([]byte(existing.Facts), facts):
		claim.Outcome = Conflict
	case existing.EndedAt.Valid:
		claim.Outcome = Ended
	default:
		claim.Outcome = Replay
	}
	return claim, nil
}

// Complete records the result of a First claim in this commit.
func (t *Tx) Complete(kind, identity string, facts, result []byte, resultRef string) error {
	seq, err := t.Seq()
	if err != nil {
		return err
	}
	if err := storage.New(t.tx).InsertClaim(t.ctx, storage.InsertClaimParams{
		Kind: kind, Identity: canonicalIdentifier(identity), Facts: string(facts), Result: string(result),
		ResultRef: resultRef, CommitSeq: seq,
	}); err != nil {
		return fmt.Errorf("record %s retry identity: %w", kind, err)
	}
	return nil
}

// EndClaims marks claims whose result was deleted or revoked, so their
// retries report the ended result without resurrection.
func (t *Tx) EndClaims(kind, resultRef string) error {
	if err := storage.New(t.tx).EndClaims(t.ctx, storage.EndClaimsParams{
		EndedAt: sql.NullString{String: formatTime(t.now), Valid: true}, Kind: kind, ResultRef: canonicalIdentifier(resultRef),
	}); err != nil {
		return fmt.Errorf("end %s retry identities: %w", kind, err)
	}
	return nil
}

// Identifiers are compared by identity across canonical, uppercase and URN
// spellings. Non-UUID values compare exactly.
func canonicalIdentifier(value string) string {
	if parsed, err := uuid.Parse(value); err == nil {
		return parsed.String()
	}
	return value
}

// CanonicalIdentifier is the stored identity of a validated UUID spelling.
func CanonicalIdentifier(value string) string { return canonicalIdentifier(value) }

func sameIdentifier(left, right string) bool {
	return strings.EqualFold(canonicalIdentifier(left), canonicalIdentifier(right))
}

// SameIdentifier compares two UUID spellings by identity.
func SameIdentifier(left, right string) bool { return sameIdentifier(left, right) }
