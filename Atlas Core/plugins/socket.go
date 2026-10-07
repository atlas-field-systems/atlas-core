package plugins

import (
	"cmp"
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"slices"
	"sync"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins/generated/storage"
)

// Server owns its listener and accepted connections. Close interrupts and joins
// all work before returning; it must run before module storage is removed.
type Server struct {
	ctx         context.Context
	cancel      context.CancelFunc
	module      *Module
	listener    *ownedListener
	mu          sync.Mutex
	connections map[net.Conn]bool
	done        chan struct{}
	joined      chan struct{}
	wg          sync.WaitGroup
	closed      bool
	result      error
	slots       chan struct{}
}

const privateConnections = 16
const socketDeadline = 5 * time.Second

func (m *Module) Listen(path string) (*Server, error) {
	listener, err := listenOwned(path)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{ctx: ctx, cancel: cancel, module: m, listener: listener, connections: make(map[net.Conn]bool), done: make(chan struct{}), slots: make(chan struct{}, privateConnections)}
	s.wg.Add(1)
	go s.accept()
	return s, nil
}
func (s *Server) accept() {
	defer s.wg.Done()
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				s.mu.Lock()
				s.result = errors.Join(s.result, err)
				s.mu.Unlock()
			}
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			connection.Close()
			return
		}
		select {
		case s.slots <- struct{}{}:
			s.connections[connection] = true
			s.wg.Add(1)
			go s.serve(connection)
		default:
			connection.Close()
		}
		s.mu.Unlock()
	}
}
func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		s.cancel()
		s.listener.Close()
		for connection := range s.connections {
			connection.Close()
		}
		close(s.done)
		s.joined = make(chan struct{})
		go func() {
			s.wg.Wait()
			s.mu.Lock()
			s.result = errors.Join(s.result, s.listener.release())
			s.mu.Unlock()
			close(s.joined)
		}()
	}
	joined := s.joined
	s.mu.Unlock()
	select {
	case <-joined:
	case <-ctx.Done():
		return ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result
}

type session struct {
	plugin  string
	number  uint64
	binding plugindispatch.Binding
}

func (s *Server) serve(connection net.Conn) {
	defer s.wg.Done()
	state := session{}
	defer func() {
		connection.Close()
		s.module.disconnect(state)
		s.mu.Lock()
		delete(s.connections, connection)
		s.mu.Unlock()
		<-s.slots
	}()
	for {
		if err := connection.SetDeadline(time.Now().Add(socketDeadline)); err != nil {
			return
		}
		var request plugindispatch.Request
		if err := s.module.cfg.Contract.Receive(connection, &request); err != nil {
			if !errors.Is(err, io.EOF) {
				_ = s.module.cfg.Contract.Send(connection, plugindispatch.Response{Kind: "error", Error: "invalid_message"})
			}
			return
		}
		changed := s.module.changeChannel()
		response := s.module.handle(s.ctx, request, &state)
		if request.Kind == "next" && response.Kind == "idle" {
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-changed:
				response = s.module.handle(s.ctx, request, &state)
			case <-timer.C:
			case <-s.done:
				timer.Stop()
				return
			}
			timer.Stop()
		}
		if err := s.module.cfg.Contract.Send(connection, response); err != nil {
			return
		}
		if response.Kind == "error" && response.Error == ErrAuthority.Error() {
			return
		}
	}
}
func (m *Module) disconnect(state session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runtimes[state.plugin]
	if active != nil && active.session == state.number && active.host.Binding == state.binding {
		active.connected = false
		active.inSession = false
		active.reconnectVerified = false
	}
}
func (m *Module) handle(ctx context.Context, request plugindispatch.Request, state *session) plugindispatch.Response {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runtimes[request.Binding.PluginID]
	fail := func(err error) plugindispatch.Response {
		return plugindispatch.Response{Kind: "error", Error: err.Error()}
	}
	if m.closed || active == nil || active.host.Binding != request.Binding || subtle.ConstantTimeCompare([]byte(active.host.Token), []byte(request.Token)) != 1 {
		return fail(ErrAuthority)
	}
	if request.Kind == "ready" {
		ready := request.Ready
		if ready == nil || ready.ContractVersion != m.cfg.Contract.Version || ready.Release != active.host.Release || ready.ConfigurationRevision != active.host.ConfigurationRevision {
			return fail(errors.New("readiness_mismatch"))
		}
		wanted := slices.Clone(active.host.Capabilities)
		got := slices.Clone(ready.Capabilities)
		compare := func(a, b plugindispatch.CapabilityIdentity) int {
			if order := cmp.Compare(a.ID, b.ID); order != 0 {
				return order
			}
			return cmp.Compare(a.InputVersion, b.InputVersion)
		}
		slices.SortFunc(wanted, compare)
		slices.SortFunc(got, compare)
		if !slices.Equal(wanted, got) {
			return fail(errors.New("readiness_mismatch"))
		}
		if state.number == 0 {
			if active.inSession || active.started && !active.reconnectVerified {
				return fail(ErrAuthority)
			}
			if active.started && (ready.LiveWitness != active.witness || !ready.ReceiptsRetained) {
				return fail(errors.New("live_receipts_lost"))
			}
			if !active.started {
				active.witness = ready.LiveWitness
			}
			active.session++
			state.number = active.session
			state.plugin = active.host.Binding.PluginID
			state.binding = active.host.Binding
			active.stagedReceipts = make(map[string]plugindispatch.Dispatch)
			active.inSession = true
			active.connected = false
		} else if state.number != active.session || state.binding != active.host.Binding {
			return fail(ErrAuthority)
		}
		receipts := active.stagedReceipts
		for _, receipt := range ready.Receipts {
			dispatch := receipt.Execution
			if dispatch.Binding != active.host.Binding {
				return fail(ErrAuthority)
			}
			if prior, exists := receipts[dispatch.OperationID]; exists && !plugindispatch.SameDispatch(prior, dispatch) {
				return fail(errors.New("receipt_conflict"))
			}
			if len(receipts) >= active.host.ReceiptCapacity {
				if _, exists := receipts[dispatch.OperationID]; !exists {
					return fail(ErrLimit)
				}
			}
			operation, err := load(ctx, m.queries, dispatch.OperationID)
			if err != nil || !operation.Exposed || !plugindispatch.SameDispatch(operation.Execution, dispatch) {
				return fail(ErrAuthority)
			}
			receipts[dispatch.OperationID] = dispatch
		}
		if ready.Complete {
			err := scan(ctx, m.queries, func(operation operationRecord) error {
				if operation.Execution.Binding == active.host.Binding && operation.Acknowledged {
					retained, ok := receipts[operation.ID]
					if !ok || !plugindispatch.SameDispatch(retained, operation.Execution) {
						return errors.New("live_receipts_lost")
					}
				}
				return nil
			})
			if err != nil {
				return fail(err)
			}
			active.connected = true
			active.started = true
			active.reconnectVerified = false
			active.cancelSent = make(map[string]string)
			m.signal()
		}
		return plugindispatch.Response{Kind: "ready"}
	}
	if state.number == 0 || state.number != active.session || state.binding != active.host.Binding || !active.inSession {
		return fail(ErrAuthority)
	}
	switch request.Kind {
	case "dispatch_ack":
		if request.Receipt == nil {
			return fail(errors.New("missing_receipt"))
		}
		dispatch := request.Receipt.Execution
		err := m.commit(ctx, func(q *storage.Queries) error {
			operation, err := load(ctx, q, dispatch.OperationID)
			if err != nil {
				return err
			}
			if !operation.Exposed || dispatch.Binding != active.host.Binding || !plugindispatch.SameDispatch(dispatch, operation.Execution) {
				return ErrAuthority
			}
			operation.Acknowledged = true
			return save(ctx, q, operation)
		})
		if err != nil {
			return fail(err)
		}
		m.signal()
		return plugindispatch.Response{Kind: "accepted"}
	case "evidence":
		if request.Evidence == nil {
			return fail(errors.New("missing_evidence"))
		}
		ack, err := m.acceptEvidence(ctx, active, *request.Evidence)
		if err != nil {
			return fail(err)
		}
		m.signal()
		return plugindispatch.Response{Kind: "ack", Ack: &ack}
	case "next":
		if !active.connected {
			return fail(ErrUnavailable)
		}
		var candidates []operationRecord
		var cancellation *plugindispatch.Cancel
		err := scan(ctx, m.queries, func(operation operationRecord) error {
			if operation.Execution.Binding != active.host.Binding || terminal(operation.Status) {
				return nil
			}
			if operation.CancellationID != "" && active.cancelSent[operation.ID] != operation.CancellationID {
				cancellation = &plugindispatch.Cancel{OperationID: operation.ID, CancellationID: operation.CancellationID}
				return nil
			}
			if !operation.Acknowledged && active.reserved[operation.ID] {
				candidates = append(candidates, operation)
			}
			return nil
		})
		if err != nil {
			return fail(err)
		}
		if cancellation != nil {
			active.cancelSent[cancellation.OperationID] = cancellation.CancellationID
			return plugindispatch.Response{Kind: "cancel", Cancel: cancellation}
		}
		if active.draining {
			return plugindispatch.Response{Kind: "drain"}
		}
		if len(candidates) == 0 {
			return plugindispatch.Response{Kind: "idle"}
		}
		operation := candidates[active.cursor%len(candidates)]
		active.cursor++
		if !operation.Exposed {
			operation.Exposed = true
			if err := m.commit(ctx, func(q *storage.Queries) error { return save(ctx, q, operation) }); err != nil {
				return fail(err)
			}
		}
		return plugindispatch.Response{Kind: "dispatch", Dispatch: &operation.Execution}
	case "drained":
		if !active.draining {
			return fail(errors.New("not_draining"))
		}
		unfinished := false
		err := scan(ctx, m.queries, func(operation operationRecord) error {
			if operation.Execution.Binding == active.host.Binding && !terminal(operation.Status) {
				unfinished = true
			}
			return nil
		})
		if err != nil {
			return fail(err)
		}
		if unfinished {
			return fail(errors.New("active_work"))
		}
		active.drainConfirmed = true
		m.signal()
		return plugindispatch.Response{Kind: "accepted"}
	default:
		return fail(errors.New("invalid_message"))
	}
}
