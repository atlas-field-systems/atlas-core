// pluginfixture is a separately built, test-only Plugin. Commands schedule the
// real component's public boundaries; effects are an independently observable
// file outside both participants' private bookkeeping stores.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

type configuration struct {
	ContractPath, Socket, Work, Effects, Mode string
	Binding                                   plugindispatch.Binding
	Token                                     string
	Release                                   plugindispatch.Release
	Definition                                *plugindispatch.Capability
	Capacity, MaxFiles                        int
	MaxBytes                                  int64
}
type event struct {
	Event     string                   `json:"event"`
	Error     string                   `json:"error,omitempty"`
	Evidence  *plugindispatch.Evidence `json:"evidence,omitempty"`
	Operation *plugins.Operation       `json:"operation,omitempty"`
	Duplicate bool                     `json:"duplicate,omitempty"`
}

var outputMu sync.Mutex

func emit(value event) {
	outputMu.Lock()
	defer outputMu.Unlock()
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, "fixture event:", err)
	}
}
func run() (result error) {
	coreMode := flag.Bool("core", false, "run the Core test owner")
	configPath := flag.String("config", "", "test configuration")
	flag.Parse()
	encoded, err := os.ReadFile(*configPath)
	if err != nil {
		return err
	}
	var cfg configuration
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		return err
	}
	if *coreMode {
		return runCore(cfg)
	}
	contract, err := plugindispatch.Load(cfg.ContractPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	release := make(chan struct{})
	var releaseOnce sync.Once
	var syncFault atomic.Bool
	definition := fixtureDefinition()
	if cfg.Definition != nil {
		definition = *cfg.Definition
	}
	if cfg.Mode == "run-lookup-v1" || cfg.Mode == "run-lookup-v2" {
		definition.ID = "lookup"
		definition.InputVersion = strings.TrimPrefix(cfg.Mode, "run-lookup-v")
	}
	if cfg.Mode == "run-lookup-alternate" {
		definition.ID = "lookup"
		definition.OutputSchema = json.RawMessage(`{"const":{"value":99}}`)
	}
	runtime, err := pluginruntime.Open(pluginruntime.Config{AfterEvidenceRename: func() error {
		if syncFault.Load() {
			return errors.New("injected_directory_sync_failure")
		}
		return nil
	}, Contract: contract, Binding: cfg.Binding, Token: cfg.Token, Release: cfg.Release, ConfigurationRevision: "1", WorkDirectory: cfg.Work, ReceiptCapacity: cfg.Capacity, MaxEvidenceFiles: cfg.MaxFiles, MaxEvidenceBytes: cfg.MaxBytes, Capabilities: []pluginruntime.Capability{{Definition: definition, Execute: func(work context.Context, invocation *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		if cfg.Mode == "hold" || cfg.Mode == "hold-failed" || cfg.Mode == "ignore-cancel" || cfg.Mode == "run-hold" || cfg.Mode == "sync-failure" || cfg.Mode == "lost-ack-hold" {
			emit(event{Event: "started"})
			if cfg.Mode == "hold" || cfg.Mode == "hold-failed" || cfg.Mode == "run-hold" {
				select {
				case <-release:
				case <-work.Done():
					return plugindispatch.Outcome{Status: "cancelled"}, nil
				}
			} else {
				select {
				case <-release:
				case <-ctx.Done():
					return plugindispatch.Outcome{}, ctx.Err()
				}
			}
		}
		if cfg.Mode == "hold-failed" {
			return plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"code":"fixture_failure"}`)}, nil
		}
		if err := appendEffects(cfg.Effects, 1); err != nil {
			return plugindispatch.Outcome{}, err
		}
		emit(event{Event: "effect"})
		if cfg.Mode == "effect-gap" {
			select {
			case <-release:
			case <-ctx.Done():
				return plugindispatch.Outcome{}, ctx.Err()
			}
		}
		var input struct {
			Value int `json:"value"`
		}
		if err := json.Unmarshal(invocation.Dispatch.Input, &input); err != nil {
			return plugindispatch.Outcome{}, err
		}
		value := input.Value * 2
		if cfg.Mode == "run-lookup-alternate" {
			value = 99
		}
		result, err := json.Marshal(struct {
			Value int `json:"value"`
		}{Value: value})
		return plugindispatch.Outcome{Status: "completed", Result: result}, err
	}}}})
	if err != nil {
		emit(event{Event: "fault", Error: err.Error()})
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		result = errors.Join(result, runtime.Close(shutdown))
	}()
	if strings.HasPrefix(cfg.Mode, "run") {
		return runChannel(ctx, runtime, cfg, func() { releaseOnce.Do(func() { close(release) }) })
	}
	var connection net.Conn
	connect := func() error {
		var err error
		connection, err = (&net.Dialer{}).DialContext(ctx, "unix", cfg.Socket)
		return err
	}
	defer func() {
		if connection != nil {
			result = errors.Join(result, connection.Close())
		}
	}()
	exchange := func(request plugindispatch.Request) (plugindispatch.Response, error) {
		request.Binding = cfg.Binding
		request.Token = cfg.Token
		if err := connection.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return plugindispatch.Response{}, err
		}
		if err := contract.Send(connection, request); err != nil {
			return plugindispatch.Response{}, err
		}
		var response plugindispatch.Response
		if err := contract.Receive(connection, &response); err != nil {
			return response, err
		}
		if response.Kind == "error" {
			return response, errors.New(response.Error)
		}
		return response, nil
	}
	report := func(evidence plugindispatch.Evidence, cleanup bool) error {
		response, err := exchange(plugindispatch.Request{Kind: "evidence", Evidence: &evidence})
		if err != nil {
			return err
		}
		expected := plugindispatch.Ack{OperationID: evidence.Execution.OperationID, Sequence: evidence.Sequence, Revision: evidence.Revision}
		if response.Ack == nil || *response.Ack != expected {
			return errors.New("missing or mismatched ACK")
		}
		if cleanup {
			return runtime.Acknowledge(*response.Ack)
		}
		return nil
	}
	ready := func() error {
		pages, err := runtime.ReadyPages()
		if err != nil {
			return err
		}
		for _, value := range pages[:len(pages)-1] {
			if _, err := exchange(plugindispatch.Request{Kind: "ready", Ready: &value}); err != nil {
				return err
			}
		}
		for _, evidence := range runtime.Retained() {
			emit(event{Event: "retained", Evidence: &evidence})
			if err := report(evidence, true); err != nil {
				return err
			}
		}
		value := pages[len(pages)-1]
		if _, err := exchange(plugindispatch.Request{Kind: "ready", Ready: &value}); err != nil {
			return err
		}
		emit(event{Event: "ready"})
		return nil
	}

	if err := connect(); err != nil {
		return err
	}
	if err := ready(); err != nil {
		emit(event{Event: "fault", Error: err.Error()})
		return err
	}
	commands, scanErrors := readCommands(ctx)
	var original *plugindispatch.Dispatch
	var saved *plugindispatch.Evidence
	waitEvidence := func() error {
		deadline := time.NewTimer(3 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			for _, evidence := range runtime.Retained() {
				if evidence.Outcome != nil {
					copy := evidence
					saved = &copy
					return nil
				}
			}
			select {
			case <-ticker.C:
			case <-deadline.C:
				return errors.New("evidence not saved")
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-scanErrors:
			return err
		case command := <-commands:
			var commandErr error
			switch command {
			case "drop-dispatch-response":
				response, err := exchange(plugindispatch.Request{Kind: "next"})
				commandErr = err
				if err == nil {
					if response.Kind != "dispatch" {
						commandErr = errors.New("expected dispatch to drop")
					} else {
						// Discard the committed exposure response before Accept can
						// create a live receipt or execute the capability.
						commandErr = connection.Close()
						connection = nil
						if commandErr == nil {
							emit(event{Event: "dispatch_response_dropped"})
						}
					}
				}
			case "next":
				response, err := exchange(plugindispatch.Request{Kind: "next"})
				commandErr = err
				if err == nil {
					switch response.Kind {
					case "dispatch":
						original = response.Dispatch
						saved = nil
						duplicate, err := runtime.Accept(ctx, *original)
						commandErr = err
						if err == nil && cfg.Mode != "lost-dispatch-ack" && cfg.Mode != "lost-ack-hold" {
							_, commandErr = exchange(plugindispatch.Request{Kind: "dispatch_ack", Receipt: &plugindispatch.Receipt{Execution: *original}})
						}
						if commandErr == nil {
							emit(event{Event: "received", Duplicate: duplicate})
						}
					case "cancel":
						commandErr = runtime.Cancel(*response.Cancel)
						if commandErr == nil {
							emit(event{Event: "cancel_received"})
						}
					default:
						emit(event{Event: response.Kind})
					}
				}
			case "receipt":
				if original == nil {
					commandErr = errors.New("missing dispatch")
				} else {
					_, commandErr = exchange(plugindispatch.Request{Kind: "dispatch_ack", Receipt: &plugindispatch.Receipt{Execution: *original}})
					if commandErr == nil {
						emit(event{Event: "accepted_receipt"})
					}
				}
			case "saved":
				commandErr = waitEvidence()
				if commandErr == nil {
					emit(event{Event: "saved", Evidence: saved})
				}
			case "report":
				if saved == nil {
					commandErr = waitEvidence()
				}
				if commandErr == nil {
					commandErr = report(*saved, true)
				}
				if commandErr == nil {
					emit(event{Event: "acknowledged"})
				}
			case "report-retain":
				if saved == nil {
					commandErr = waitEvidence()
				}
				if commandErr == nil {
					commandErr = report(*saved, false)
				}
				if commandErr == nil {
					emit(event{Event: "committed"})
				}
			case "duplicate":
				if original == nil {
					commandErr = errors.New("missing original dispatch")
				} else {
					duplicate, err := runtime.Accept(ctx, *original)
					commandErr = err
					if err == nil {
						emit(event{Event: "duplicate", Duplicate: duplicate})
					}
				}
			case "changed-dispatch":
				if original == nil {
					commandErr = errors.New("missing original dispatch")
				} else {
					changed := *original
					changed.Input = json.RawMessage(`{"value":99}`)
					changed.InputDigest = plugindispatch.Digest(changed.Input)
					_, commandErr = runtime.Accept(ctx, changed)
				}
			case "progress", "progress-retain", "progress-new", "known-effect", "known-effect-save":
				if original == nil {
					commandErr = errors.New("missing original dispatch")
				} else {
					update := pluginruntime.Update{Progress: json.RawMessage(`{"percent":50}`)}
					if command == "known-effect" || command == "known-effect-save" || command == "progress-retain" {
						if err := appendEffects(cfg.Effects, 1); err != nil {
							return err
						}
						update.Effects = []plugindispatch.Effect{{ID: "fixture-known", Description: "fixture effect evidence"}}
					}
					evidence, err := runtime.Record(original.OperationID, update)
					commandErr = err
					if err == nil {
						if command == "progress-retain" {
							saved = &evidence
							commandErr = report(evidence, false)
						} else if command != "progress-new" && command != "known-effect-save" {
							commandErr = report(evidence, true)
						}
					}
					if commandErr == nil {
						emit(event{Event: "progress", Evidence: &evidence})
					}
				}
			case "fail-sync":
				syncFault.Store(true)
				emit(event{Event: "sync_fault_enabled"})
			case "ack-old":
				if saved == nil {
					commandErr = errors.New("missing evidence")
				} else {
					commandErr = runtime.Acknowledge(plugindispatch.Ack{OperationID: saved.Execution.OperationID, Sequence: saved.Sequence, Revision: saved.Revision})
					if commandErr == nil {
						emit(event{Event: "old_ack"})
					}
				}
			case "runtime-fault":
				select {
				case err := <-runtime.Faults():
					emit(event{Event: "runtime_fault", Error: err.Error()})
				case <-time.After(3 * time.Second):
					commandErr = errors.New("runtime fault timed out")
				}
			case "release":
				releaseOnce.Do(func() { close(release) })
				emit(event{Event: "released"})
			case "disconnect":
				commandErr = connection.Close()
				connection = nil
				if commandErr == nil {
					emit(event{Event: "disconnected"})
				}
			case "reconnect":
				commandErr = connect()
				if commandErr == nil {
					commandErr = ready()
				}
			case "begin-reconnect-without-receipts":
				commandErr = connect()
				if commandErr == nil {
					value := runtime.Ready(false)
					value.Receipts = []plugindispatch.Receipt{}
					_, commandErr = exchange(plugindispatch.Request{Kind: "ready", Ready: &value})
				}
				if commandErr == nil {
					emit(event{Event: "readiness_started"})
				}
			case "ready-without-receipts", "ready-complete":
				value := runtime.Ready(true)
				if command == "ready-without-receipts" {
					value.Receipts = []plugindispatch.Receipt{}
				}
				_, commandErr = exchange(plugindispatch.Request{Kind: "ready", Ready: &value})
				if commandErr == nil {
					emit(event{Event: "ready"})
				}
			case "conflicting-outcome", "changed-report", "invalid-result":
				if saved == nil {
					commandErr = errors.New("missing evidence")
				} else {
					changed := *saved
					switch command {
					case "conflicting-outcome":
						changed.Sequence = "2"
						changed.Outcome = &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"code":"fixture_failure"}`)}
					case "changed-report":
						changed.Progress = json.RawMessage(`{"percent":1}`)
					case "invalid-result":
						changed.Sequence = "3"
						changed.Outcome = &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":"invalid"}`)}
					}
					changed.Revision = plugindispatch.Revision(changed)
					commandErr = report(changed, false)
				}
			case "drained":
				_, commandErr = exchange(plugindispatch.Request{Kind: "drained"})
				if commandErr == nil {
					emit(event{Event: "drained"})
				}
			case "stop":
				return nil
			default:
				if strings.HasPrefix(command, "record-update ") {
					var update pluginruntime.Update
					commandErr = json.Unmarshal([]byte(strings.TrimPrefix(command, "record-update ")), &update)
					if original == nil {
						commandErr = errors.New("missing original dispatch")
					}
					if commandErr == nil {
						evidence, err := runtime.Record(original.OperationID, update)
						commandErr = err
						if commandErr == nil {
							commandErr = report(evidence, true)
						}
						if commandErr == nil {
							emit(event{Event: "reported_update", Evidence: &evidence})
						}
					}
				} else if strings.HasPrefix(command, "report-evidence ") || strings.HasPrefix(command, "report-effect ") {
					prefix := "report-evidence "
					perform := strings.HasPrefix(command, "report-effect ")
					if perform {
						prefix = "report-effect "
					}
					var evidence plugindispatch.Evidence
					commandErr = json.Unmarshal([]byte(strings.TrimPrefix(command, prefix)), &evidence)
					if commandErr == nil && perform {
						commandErr = appendEffects(cfg.Effects, len(evidence.Effects))
					}
					if commandErr == nil {
						commandErr = report(evidence, false)
					}
					if commandErr == nil {
						emit(event{Event: "reported_evidence"})
					}
				} else if strings.HasPrefix(command, "accept ") {
					var dispatch plugindispatch.Dispatch
					commandErr = json.Unmarshal([]byte(strings.TrimPrefix(command, "accept ")), &dispatch)
					if commandErr == nil {
						_, commandErr = runtime.Accept(ctx, dispatch)
					}
					if commandErr == nil {
						emit(event{Event: "accepted_dispatch"})
					}
				} else {
					commandErr = errors.New("unknown command")
				}
			}
			if commandErr != nil {
				emit(event{Event: "error", Error: commandErr.Error()})
			}
		}
	}
}

func appendEffects(path string, count int) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(strings.Repeat("effect\n", count))
	return errors.Join(writeErr, file.Sync(), file.Close())
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
