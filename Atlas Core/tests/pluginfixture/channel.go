package main

import (
	"bufio"
	"context"
	"errors"
	"os"
	"time"

	"encoding/json"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
)

func runChannel(ctx context.Context, runtime *pluginruntime.Runtime, cfg configuration, release func()) error {
	commands := make(chan string)
	scanErrors := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			select {
			case commands <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		scanErrors <- scanner.Err()
	}()
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
				return err
			}
			done = nil
		}
	}
}
