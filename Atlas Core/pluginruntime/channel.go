package pluginruntime

import (
	"context"
	"errors"
	"net"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
)

// Run owns a single authenticated socket session. A transport failure returns
// while live receipts and workers remain, allowing the host to verify and the
// caller to reconnect this unchanged Runtime. Close ends its work explicitly.
// A fatal worker failure closes the channel and remains a fault on reconnect;
// other accepted workers retain their lifetime until Close.
// No automatic connection retry, process restart or Operation rerun occurs.
func (r *Runtime) Run(ctx context.Context, socket string) (result error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return errors.New("runtime_closed")
	}
	if r.workerFault != nil {
		err := r.workerFault
		r.mu.Unlock()
		return err
	}
	if r.running {
		r.mu.Unlock()
		return errors.New("session_already_running")
	}
	r.running = true
	sessionContext, cancel := context.WithCancel(ctx)
	r.sessionCancel = cancel
	r.sessionDone = make(chan struct{})
	done := r.sessionDone
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		if r.workerFault != nil {
			result = errors.Join(r.workerFault, result)
		}
		r.running = false
		r.sessionCancel = nil
		close(done)
		r.mu.Unlock()
	}()
	ctx = sessionContext
	defer func() {
		if ctx.Err() != nil {
			result = errors.Join(result, ctx.Err())
		}
	}()
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return err
	}
	defer connection.Close()
	stopped := make(chan struct{})
	monitorDone := make(chan struct{})
	defer func() { close(stopped); <-monitorDone }()
	go func() {
		defer close(monitorDone)
		select {
		case <-ctx.Done():
			connection.Close()
		case <-r.failed:
			connection.Close()
		case <-stopped:
		}
	}()
	exchange := func(request plugindispatch.Request) (plugindispatch.Response, error) {
		request.Binding = r.cfg.Binding
		request.Token = r.cfg.Token
		if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return plugindispatch.Response{}, err
		}
		if err := r.cfg.Contract.Send(connection, request); err != nil {
			return plugindispatch.Response{}, err
		}
		var response plugindispatch.Response
		if err := r.cfg.Contract.Receive(connection, &response); err != nil {
			return response, err
		}
		if response.Kind == "error" {
			return response, errors.New(response.Error)
		}
		return response, nil
	}
	pages, err := r.ReadyPages()
	if err != nil {
		return err
	}
	for _, ready := range pages[:len(pages)-1] {
		if _, err := exchange(plugindispatch.Request{Kind: "ready", Ready: &ready}); err != nil {
			return err
		}
	}
	report := func(evidence plugindispatch.Evidence) error {
		response, err := exchange(plugindispatch.Request{Kind: "evidence", Evidence: &evidence})
		if err != nil {
			return err
		}
		if response.Kind != "ack" || response.Ack == nil {
			return errors.New("missing_evidence_ack")
		}
		return r.Acknowledge(*response.Ack)
	}
	for _, evidence := range r.Retained() {
		if err := report(evidence); err != nil {
			return err
		}
	}
	final := pages[len(pages)-1]
	if _, err := exchange(plugindispatch.Request{Kind: "ready", Ready: &final}); err != nil {
		return err
	}
	drainConfirmed := false
	for {
		for _, evidence := range r.Pending() {
			if err := report(evidence); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		response, err := exchange(plugindispatch.Request{Kind: "next"})
		if err != nil {
			return err
		}
		switch response.Kind {
		case "dispatch":
			if response.Dispatch == nil {
				return errors.New("missing_dispatch")
			}
			if _, err := r.Accept(ctx, *response.Dispatch); err != nil {
				return err
			}
			if _, err := exchange(plugindispatch.Request{Kind: "dispatch_ack", Receipt: &plugindispatch.Receipt{Execution: *response.Dispatch}}); err != nil {
				return err
			}
		case "cancel":
			if response.Cancel == nil {
				return errors.New("missing_cancel")
			}
			if err := r.Cancel(*response.Cancel); err != nil {
				return err
			}
		case "idle", "drain":
			if response.Kind == "drain" && !drainConfirmed && r.finiteFinished() {
				ack, err := exchange(plugindispatch.Request{Kind: "drained"})
				if err != nil && ack.Error != "active_work" {
					return err
				}
				if err == nil {
					drainConfirmed = true
				}
			}
		default:
			return errors.New("unexpected_private_response")
		}
	}
}
