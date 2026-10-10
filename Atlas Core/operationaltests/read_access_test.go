package operationaltests_test

import (
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
)

func TestReadDecisionBeforeDeletionCanFinishWithItsOwnBoundary(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var armed atomic.Bool
	var now atomic.Int64
	now.Store(time.Now().UnixNano())
	f := newFixture(t, systemoperations.Options{
		CommunicationTime: func() time.Time { return time.Unix(0, now.Load()) },
		BeforeCommit: func(ctx context.Context) error {
			if armed.CompareAndSwap(true, false) {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		},
	})
	var released sync.Once
	releaseRead := func() { released.Do(func() { close(release) }) }
	t.Cleanup(releaseRead)
	f.client.Timeout = 5 * time.Second
	a, _ := f.register()
	reported := f.checkin(a)
	now.Store(reported.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty().Add(4 * time.Second).UnixNano())
	armed.Store(true)
	readResult := make(chan outcome, 1)
	go func() { readResult <- f.exchange("GET", "/entities/"+a.id, a.secret, nil) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("serialized read did not reach its commit decision")
	}
	deletion := make(chan outcome, 1)
	go func() { deletion <- f.exchange("DELETE", "/entities/"+a.id, f.admin, nil) }()
	releaseRead()
	readReply, deleted := <-readResult, <-deletion
	if readReply.err != nil || readReply.status != 200 || deleted.err != nil || deleted.status != 204 {
		t.Fatalf("read-first order: read=%d/%v deletion=%d/%v", readReply.status, readReply.err, deleted.status, deleted.err)
	}
	read := decode[protocol.AssetResponse](t, readReply.body)
	priorCursor, err := strconv.ParseUint(reported.CommitCursor, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if read.Data.Components.Communications.State != "degraded" || read.ReadContext.Source != "http" || read.ReadContext.CommitCursor != strconv.FormatUint(priorCursor+1, 10) {
		t.Fatal("successful read did not retain the boundary of its own decision")
	}
	later := decode[protocol.HealthResponse](t, f.request("GET", "/health", f.admin, nil, 200))
	if later.ReadContext.CommitCursor != strconv.FormatUint(priorCursor+2, 10) {
		t.Fatal("later deletion was mislabeled as the earlier read boundary")
	}
	f.request("GET", "/entities/"+a.id, a.secret, nil, 401)
}

func TestDeletionFencesEveryAuthenticatedReadAfterDispatch(t *testing.T) {
	for _, route := range []string{"entities", "entity", "alias", "status", "assigned", "history", "tasks", "task", "health", "readiness", "docs", "openapi"} {
		t.Run(route, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var armed atomic.Bool
			f := newFixture(t, systemoperations.Options{BeforeDispatch: func(ctx context.Context, d systemoperations.Dispatch) error {
				if armed.Load() && d.Method == "GET" {
					close(entered)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				return nil
			}})
			a, _ := f.register()
			b, registered := f.register()
			task := f.create(b)
			f.request("PATCH", "/entities/"+b.id, f.admin, map[string]interface{}{"alias": "visible-target", "expected_edit_revision": registered.Data.Entity.EditRevision}, 200)
			paths := map[string]string{
				"entities": "/entities", "entity": "/entities/" + b.id,
				"alias": "/entities/alias/visible-target", "status": "/entities/" + b.id + "/status",
				"assigned": "/entities/" + b.id + "/tasks", "history": "/entities/" + b.id + "/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",
				"tasks": "/tasks", "task": "/tasks/" + task.Id.String(),
				"health": "/health", "readiness": "/readiness", "docs": "/docs", "openapi": "/openapi.json",
			}
			f.request("GET", paths[route], a.secret, nil, 200)
			armed.Store(true)
			pending := make(chan outcome, 1)
			go func() { pending <- f.exchange("GET", paths[route], a.secret, nil) }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("read dispatch barrier was not reached")
			}
			f.request("DELETE", "/entities/"+a.id, f.admin, nil, 204)
			close(release)
			reply := <-pending
			if reply.err != nil || reply.status != 401 {
				t.Fatalf("deletion-first read was not denied: status=%d err=%v", reply.status, reply.err)
			}
		})
	}
}
