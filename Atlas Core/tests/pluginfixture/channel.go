package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/atlas-field-systems/atlas-core/pluginruntime"
)

func runChannel(ctx context.Context, runtime *pluginruntime.Runtime, cfg configuration, release func(), ingestion *ingestionFixture) error {
	commands, scanErrors := readCommands(ctx)
	var cancel context.CancelFunc
	var done chan error
	start := func() {
		var session context.Context
		session, cancel = context.WithCancel(ctx)
		done = make(chan error, 1)
		go func() { done <- runtime.Run(session, cfg.Socket) }()
		emit(event{Event: "session_started"})
	}
	start()
	defer func() {
		if cancel != nil {
			cancel()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-scanErrors:
			return err
		case command := <-commands:
			switch command {
			case "ingest", "release-ingestion":
				if ingestion == nil {
					return errors.New("no ingestion fixture")
				}
				if command == "ingest" {
					ingestion.observe(ctx)
				} else {
					ingestion.release.Do(func() { close(ingestion.allowed) })
				}
			case "progress":
				ready := runtime.Ready(false)
				if len(ready.Receipts) == 0 {
					return errors.New("no live receipt")
				}
				evidence, err := runtime.Record(ready.Receipts[0].Execution.OperationID, pluginruntime.Update{Progress: json.RawMessage(`{"percent":50}`)})
				if err != nil {
					return err
				}
				emit(event{Event: "progress", Evidence: &evidence})
			case "release":
				release()
				emit(event{Event: "released"})
			case "disconnect":
				cancel()
				select {
				case err := <-done:
					if err != nil && !errors.Is(err, context.Canceled) {
						emit(event{Event: "error", Error: err.Error()})
					}
					emit(event{Event: "disconnected"})
					done = nil
				case <-time.After(3 * time.Second):
					return errors.New("session did not stop")
				}
			case "reconnect":
				if done != nil {
					return errors.New("session already exists")
				}
				start()
			case "stop":
				return nil
			default:
				emit(event{Event: "error", Error: "unknown command"})
			}
		case err := <-done:
			if err != nil {
				emit(event{Event: "fault", Error: err.Error()})
				if cfg.Mode == "run-ingestion-failed" {
					reconnectErr := runtime.Run(ctx, cfg.Socket)
					if reconnectErr == nil {
						return errors.New("failed ingestion stop allowed reconnection")
					}
					emit(event{Event: "reconnect_rejected", Error: reconnectErr.Error()})
				}
				return err
			}
			done = nil
		}
	}
}

// Observation commands represent a blocking source. The loop remains live
// until its owner cancels and joins it, independently of finite Operations.
type ingestionFixture struct {
	observations chan struct{}
	allowed      chan struct{}
	done         chan struct{}
	cancel       context.CancelFunc
	release      sync.Once
	err          error
	cfg          configuration
}

func startIngestion(ctx context.Context, cfg configuration) *ingestionFixture {
	lifetime, cancel := context.WithCancel(ctx)
	ingestion := &ingestionFixture{observations: make(chan struct{}), allowed: make(chan struct{}), done: make(chan struct{}), cancel: cancel, cfg: cfg}
	go func() {
		defer close(ingestion.done)
		for {
			select {
			case <-lifetime.Done():
				return
			case <-ingestion.observations:
				if err := appendEffects(cfg.Effects+".ingestion", 1); err != nil {
					ingestion.err = err
					return
				}
				emit(event{Event: "ingested"})
			}
		}
	}()
	return ingestion
}

func (i *ingestionFixture) observe(ctx context.Context) {
	select {
	case <-i.done:
		emit(event{Event: "ingestion_rejected"})
	case i.observations <- struct{}{}:
	case <-ctx.Done():
	}
}

func (i *ingestionFixture) stop(ctx context.Context) error {
	if err := appendEffects(i.cfg.Effects+".ingestion-stop", 1); err != nil {
		return err
	}
	emit(event{Event: "ingestion_stop_requested"})
	if i.cfg.Mode == "run-ingestion-failed" {
		return errors.New("injected_ingestion_stop_failure")
	}
	select {
	case <-i.allowed:
	case <-ctx.Done():
	}
	if err := i.close(); err != nil {
		return err
	}
	emit(event{Event: "ingestion_stopped"})
	return nil
}

func (i *ingestionFixture) close() error {
	i.cancel()
	<-i.done
	return i.err
}
