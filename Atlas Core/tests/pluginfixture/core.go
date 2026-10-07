package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func fixtureDefinition() plugindispatch.Capability {
	return plugindispatch.Capability{ID: "double", InputVersion: "1", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"integer"},"padding":{"type":"string","maxLength":32700}}}`), OutputSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"integer"}}}`), ErrorSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["code"],"properties":{"code":{"type":"string"}}}`)}
}

// A Core helper exists only for the real process-kill schedule. Its command
// adapter translates requests into the same supported module interface.
func runCore(cfg configuration) (result error) {
	contract, err := plugindispatch.Load(cfg.ContractPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	core, err := plugins.Open(ctx, plugins.Config{DatabasePath: filepath.Join(filepath.Dir(cfg.Work), "core.sqlite"), DatasetID: cfg.Binding.DatasetID, CoreRunID: cfg.Binding.CoreRunID, CoreRelease: "fixture", Contract: contract, Capabilities: []plugindispatch.Capability{fixtureDefinition()}})
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, core.Close()) }()
	if err := core.BindRuntime(ctx, plugins.RuntimeBinding{Binding: cfg.Binding, Token: cfg.Token, VerifiedProcess: "fixture-host-observed-process", ReceiptCapacity: cfg.Capacity, Release: cfg.Release, ConfigurationRevision: "1", CapabilityIDs: []string{"double"}}); err != nil {
		return err
	}
	server, err := core.Listen(cfg.Socket)
	if err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		result = errors.Join(result, server.Close(shutdown))
	}()
	emit(event{Event: "ready"})
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
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-scanErrors:
			return err
		case command := <-commands:
			if strings.HasPrefix(command, "submit ") {
				var request plugins.Submission
				if err := json.Unmarshal([]byte(strings.TrimPrefix(command, "submit ")), &request); err != nil {
					return err
				}
				operation, err := core.Submit(ctx, request)
				if err != nil {
					emit(event{Event: "error", Error: err.Error()})
				} else {
					emit(event{Event: "accepted", Operation: &operation})
				}
			} else if command == "stop" {
				return nil
			} else {
				emit(event{Event: "error", Error: "unknown command"})
			}
		}
	}
}
