package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
)

// Feed connection limits.
const (
	// feedAuthenticationTimeout bounds the wait for the first message.
	feedAuthenticationTimeout = 5 * time.Second
	// feedWriteTimeout disconnects a consumer that stops reading; it
	// reconnects and replays instead of holding Core's buffers.
	feedWriteTimeout = 5 * time.Second
	// feedBatch is how many changes one log read delivers.
	feedBatch = 100
	// feedReadLimit fits FeedAuthentication, the only client message.
	feedReadLimit = 512
)

var errFeedExpired = errors.New("feed fell behind the retained change log")

// feedCallers mirrors the security of the Protocol getFeed operation. The
// feed is excluded from generation, so its security is not in the generated
// spec; the "Enrollment cannot follow the feed" scenario checks this list.
var feedCallers = map[identity.Kind]bool{identity.Operator: true, identity.Asset: true, identity.Plugin: true}

// feedHandler serves GET /feed: authenticate from the first message, send
// FeedHello, then every later commit in sequence order.
func (a *App) feedHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.connections.Add(1)
		defer a.connections.Done()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		defer context.AfterFunc(a.lifetime, cancel)()
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			return // Accept has already written the HTTP error.
		}
		defer connection.CloseNow()
		connection.SetReadLimit(feedReadLimit)
		caller, scope, ok := a.authenticateFeed(ctx, connection)
		if !ok {
			connection.Close(websocket.StatusPolicyViolation, "a valid credential is required")
			return
		}
		// CloseRead ends ctx when the client closes; the client sends nothing after authenticating.
		ctx = connection.CloseRead(ctx)
		a.closeFeed(ctx, connection, a.streamChanges(ctx, connection, caller, scope))
	})
}

func (a *App) authenticateFeed(ctx context.Context, connection *websocket.Conn) (identity.Caller, api.FeedAuthenticationScope, bool) {
	ctx, cancel := context.WithTimeout(ctx, feedAuthenticationTimeout)
	defer cancel()
	var message api.FeedAuthentication
	if err := wsjson.Read(ctx, connection, &message); err != nil {
		return identity.Caller{}, "", false
	}
	caller, err := a.identity.Authenticate(ctx, message.ApiKey)
	if err != nil || !feedCallers[caller.Kind] {
		return identity.Caller{}, "", false
	}
	if message.Scope != nil && !message.Scope.Valid() {
		return identity.Caller{}, "", false
	}
	scope := api.FeedAuthenticationScopeFull
	if message.Scope != nil {
		scope = *message.Scope
	}
	if scope == api.FeedAuthenticationScopeAsset && caller.Kind != identity.Asset {
		return identity.Caller{}, "", false
	}
	return caller, scope, true
}

func (a *App) streamChanges(ctx context.Context, connection *websocket.Conn, caller identity.Caller, scope api.FeedAuthenticationScope) error {
	latest, err := a.changes.Latest(ctx)
	if err != nil {
		return err
	}
	cursor, err := a.changes.Cursor(latest)
	coverage := api.PictureCoverage{Scope: api.PictureCoverageScopeFull}
	if scope == api.FeedAuthenticationScopeAsset {
		cursor, err = a.changes.AssetCursor(caller.ID, latest)
		id, parseErr := uuid.Parse(caller.ID)
		if parseErr != nil {
			return fmt.Errorf("parse Asset ID %s for feed coverage: %w", caller.ID, parseErr)
		}
		coverage = api.PictureCoverage{Scope: api.PictureCoverageScopeAsset, AssetId: &id}
	}
	if err != nil {
		return fmt.Errorf("encode feed cursor for caller %s: %w", caller.ID, err)
	}
	hello := api.FeedHello{Type: api.Hello, DatasetId: a.datasets.Current().ID, Cursor: cursor, Sequence: latest, Coverage: coverage}
	if err := writeFeed(ctx, connection, hello); err != nil {
		return err
	}
	position := feedPosition{cursor: cursor, sequence: latest}
	for {
		committed := a.changes.Committed()
		if position, err = a.deliverChanges(ctx, connection, position, caller.ID, scope); err != nil {
			return err
		}
		select {
		case <-committed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

type feedPosition struct {
	cursor   string
	sequence int64
}

// deliverChanges sends changes and proof of excluded sequences, then returns
// the last delivered cursor and sequence.
func (a *App) deliverChanges(ctx context.Context, connection *websocket.Conn, position feedPosition, assetID string, scope api.FeedAuthenticationScope) (feedPosition, error) {
	for {
		var page api.ChangePage
		var err error
		if scope == api.FeedAuthenticationScopeAsset {
			page, err = a.changes.SinceAsset(ctx, assetID, position.cursor, feedBatch)
		} else {
			page, err = a.changes.Since(ctx, position.cursor, feedBatch)
		}
		if changes.IsExpired(err) {
			return position, errors.Join(errFeedExpired, writeFeed(ctx, connection, api.FeedGap{Type: api.Gap, Code: api.FeedGapCodeCursorExpired}))
		}
		if err != nil {
			return position, err
		}
		for _, change := range page.Changes {
			if scope == api.FeedAuthenticationScopeAsset && change.Sequence > position.sequence+1 {
				before, err := a.changes.AssetCursor(assetID, change.Sequence-1)
				if err != nil {
					return position, fmt.Errorf("encode feed cursor before change %d: %w", change.Sequence, err)
				}
				if err := writeFeed(ctx, connection, api.FeedProgress{Type: api.Progress, Cursor: before, ThroughSequence: change.Sequence - 1}); err != nil {
					return position, err
				}
				position = feedPosition{cursor: before, sequence: change.Sequence - 1}
			}
			var next string
			if scope == api.FeedAuthenticationScopeAsset {
				next, err = a.changes.AssetCursor(assetID, change.Sequence)
			} else {
				next, err = a.changes.Cursor(change.Sequence)
			}
			if err != nil {
				return position, fmt.Errorf("encode feed cursor at change %d: %w", change.Sequence, err)
			}
			if err := writeFeed(ctx, connection, api.FeedChange{Type: api.Change, Change: change, Cursor: next}); err != nil {
				return position, err
			}
			position = feedPosition{cursor: next, sequence: change.Sequence}
		}
		if scope == api.FeedAuthenticationScopeAsset && page.ThroughSequence > position.sequence {
			if err := writeFeed(ctx, connection, api.FeedProgress{Type: api.Progress, Cursor: page.Cursor, ThroughSequence: page.ThroughSequence}); err != nil {
				return position, err
			}
		}
		position = feedPosition{cursor: page.Cursor, sequence: page.ThroughSequence}
		if len(page.Changes) < feedBatch {
			return position, nil
		}
	}
}

func writeFeed(ctx context.Context, connection *websocket.Conn, message any) error {
	ctx, cancel := context.WithTimeout(ctx, feedWriteTimeout)
	defer cancel()
	return wsjson.Write(ctx, connection, message)
}

// closeFeed closes the connection with a status that tells the client why.
func (a *App) closeFeed(ctx context.Context, connection *websocket.Conn, err error) {
	switch {
	case errors.Is(err, errFeedExpired):
		connection.Close(websocket.StatusPolicyViolation, "change history expired")
	case a.lifetime.Err() != nil:
		connection.Close(websocket.StatusGoingAway, "Core is stopping")
	case ctx.Err() != nil:
		// The client closed the connection or went away.
	default:
		a.log.Error("feed failed", "error", err)
		connection.Close(websocket.StatusInternalError, "feed unavailable")
	}
}
