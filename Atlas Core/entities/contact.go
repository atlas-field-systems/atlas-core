package entities

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
)

// challenges issues contact challenges bound to the Dataset, Asset, process
// generation and this Core run. The key exists only in memory, so Restart
// invalidates every earlier challenge, and expiry uses the monotonic clock.
type challenges struct {
	store  *system.Store
	key    []byte
	start  time.Time
	window time.Duration
}

func newChallenges(store *system.Store, window time.Duration) (*challenges, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate contact challenge key: %w", err)
	}
	return &challenges{store: store, key: key, start: time.Now(), window: window}, nil
}

// Token layout: Dataset UUID, Asset UUID, generation, issued Unix
// milliseconds, issued monotonic nanoseconds since run start, then the MAC.
const challengePayload = 16 + 16 + 8 + 8 + 8

func (c *challenges) mac(payload []byte) []byte {
	mac := hmac.New(sha256.New, c.key)
	mac.Write(payload)
	return mac.Sum(nil)
}

func (c *challenges) issue(datasetID, assetID string, generation int64) (protocol.ContactChallenge, error) {
	issued := time.Now()
	wall := issued.UTC().Truncate(time.Millisecond)
	payload := make([]byte, 0, challengePayload)
	for _, id := range []string{datasetID, assetID} {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return protocol.ContactChallenge{}, fmt.Errorf("challenge identity: %w", err)
		}
		payload = append(payload, parsed[:]...)
	}
	payload = binary.BigEndian.AppendUint64(payload, uint64(generation))
	payload = binary.BigEndian.AppendUint64(payload, uint64(wall.UnixMilli()))
	payload = binary.BigEndian.AppendUint64(payload, uint64(issued.Sub(c.start)))
	token := base64.RawURLEncoding.EncodeToString(append(payload, c.mac(payload)...))
	return protocol.ContactChallenge{
		AssetId: mustIdentifier(assetID), ProcessGeneration: strconv.FormatInt(generation, 10), Token: token,
		IssuedAt: wall, ExpiresAt: wall.Add(c.window),
	}, nil
}

// fresh checks a direct IP contact proof: a valid challenge from this run for
// this Dataset, Asset and generation; the report's original generation time
// within the challenge interval; and receipt before monotonic expiry.
func (c *challenges) fresh(token, datasetID, assetID string, generation int64, generated, received time.Time) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != challengePayload+sha256.Size {
		return false
	}
	payload := decoded[:challengePayload]
	if !hmac.Equal(decoded[challengePayload:], c.mac(payload)) {
		return false
	}
	dataset, _ := uuid.Parse(datasetID)
	asset, _ := uuid.Parse(assetID)
	if string(payload[:16]) != string(dataset[:]) || string(payload[16:32]) != string(asset[:]) {
		return false
	}
	if int64(binary.BigEndian.Uint64(payload[32:40])) != generation {
		return false
	}
	issuedWall := time.UnixMilli(int64(binary.BigEndian.Uint64(payload[40:48]))).UTC()
	issuedMonotonic := time.Duration(binary.BigEndian.Uint64(payload[48:56]))
	if generated.Before(issuedWall) || generated.After(issuedWall.Add(c.window)) {
		return false
	}
	return received.Sub(c.start)-issuedMonotonic <= c.window
}

// IssueChallenge serves an authenticated health request from a bound Asset for
// its current or candidate next process generation.
func (m *Module) IssueChallenge(ctx context.Context, principal identity.Principal, assetID string, generation string) (protocol.ContactChallenge, error) {
	if principal.Kind != identity.Asset || !system.SameIdentifier(principal.AssetID, assetID) {
		return protocol.ContactChallenge{}, coreerr.Forbidden("forbidden", "Only the bound Asset obtains its contact challenge")
	}
	requested, err := strconv.ParseInt(generation, 10, 64)
	if err != nil {
		return protocol.ContactChallenge{}, coreerr.Invalid("invalid_request", "Generation is outside the supported range")
	}
	datasetID := m.store.DatasetID()
	var current int64
	err = m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		if _, err := live(ctx, tx, assetID); err != nil {
			return err
		}
		current, err = storage.New(tx).CurrentGeneration(ctx, system.CanonicalIdentifier(assetID))
		return err
	})
	if err != nil {
		return protocol.ContactChallenge{}, err
	}
	if requested != current && requested != current+1 {
		return protocol.ContactChallenge{}, coreerr.Conflict("generation_conflict", "Challenges cover the current or candidate next generation").With("current_generation", strconv.FormatInt(current, 10))
	}
	return m.challenges.issue(datasetID, system.CanonicalIdentifier(assetID), requested)
}

// RunCommunications derives Communication state from Contact age until ctx
// ends. Each transition is an ordinary Entity change; it never creates
// Contact. It returns after its last commit, so the caller can close storage.
func (m *Module) RunCommunications(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := m.deriveCommunications(ctx); err != nil && ctx.Err() == nil {
				log.Printf("derive Communication state: %v", err)
			}
		}
	}
}

func (m *Module) deriveCommunications(ctx context.Context) error {
	degraded := time.Duration(m.settings.ContactDegradedAfterMS) * time.Millisecond
	offline := time.Duration(m.settings.ContactOfflineAfterMS) * time.Millisecond
	_, err := m.store.Commit(ctx, m.store.DatasetID(), "entity.communications", func(tx *system.Tx) error {
		rows, err := storage.New(tx.SQL()).ContactCandidates(ctx)
		if err != nil {
			return fmt.Errorf("read Contact ages: %w", err)
		}
		for _, row := range rows {
			age := tx.Now().Sub(system.ParseTime(row.LastSeen.String))
			next := protocol.HighBandwidth
			switch {
			case age >= offline:
				next = protocol.Offline
			case age >= degraded:
				next = protocol.Degraded
			}
			if string(next) == row.CommunicationState {
				continue
			}
			rec, err := decode(row)
			if err != nil {
				return err
			}
			rec.row.CommunicationState = string(next)
			if _, err := m.save(ctx, tx, &rec); err != nil {
				return err
			}
		}
		return nil
	})
	return err
}
