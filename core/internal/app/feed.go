package app

import (
	"context"
	"errors"
	"net/http"
	"time"

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
var feedCallers = map[identity.Kind]bool{identity.Operator: true, identity.Asset: true}

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
		if !a.authenticateFeed(ctx, connection) {
			connection.Close(websocket.StatusPolicyViolation, "a valid credential is required")
			return
		}
		// CloseRead ends ctx when the client closes; the client sends nothing after authenticating.
		ctx = connection.CloseRead(ctx)
		a.closeFeed(ctx, connection, a.streamChanges(ctx, connection))
	})
}

func (a *App) authenticateFeed(ctx context.Context, connection *websocket.Conn) bool {
	ctx, cancel := context.WithTimeout(ctx, feedAuthenticationTimeout)
	defer cancel()
	var message api.FeedAuthentication
	if err := wsjson.Read(ctx, connection, &message); err != nil {
		return false
	}
	caller, err := a.identity.Authenticate(ctx, message.ApiKey)
	return err == nil && feedCallers[caller.Kind]
}

func (a *App) streamChanges(ctx context.Context, connection *websocket.Conn) error {
	latest, err := a.changes.Latest(ctx)
	if err != nil {
		return err
	}
	cursor, err := a.changes.Cursor(latest)
	if err != nil {
		return err
	}
	hello := api.FeedHello{Type: api.Hello, DatasetId: a.datasets.Current().ID, Cursor: cursor, Sequence: latest}
	if err := writeFeed(ctx, connection, hello); err != nil {
		return err
	}
	for {
		committed := a.changes.Committed()
		if cursor, err = a.deliverChanges(ctx, connection, cursor); err != nil {
			return err
		}
		select {
		case <-committed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// deliverChanges sends every change after cursor and returns the cursor after
// the last one sent.
func (a *App) deliverChanges(ctx context.Context, connection *websocket.Conn, cursor string) (string, error) {
	for {
		page, err := a.changes.Since(ctx, cursor, feedBatch)
		if changes.IsExpired(err) {
			return cursor, errors.Join(errFeedExpired, writeFeed(ctx, connection, api.FeedGap{Type: api.Gap, Code: api.FeedGapCodeCursorExpired}))
		}
		if err != nil {
			return cursor, err
		}
		for _, change := range page.Changes {
			if cursor, err = a.changes.Cursor(change.Sequence); err != nil {
				return cursor, err
			}
			if err := writeFeed(ctx, connection, api.FeedChange{Type: api.Change, Change: change, Cursor: cursor}); err != nil {
				return cursor, err
			}
		}
		if len(page.Changes) < feedBatch {
			return cursor, nil
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
