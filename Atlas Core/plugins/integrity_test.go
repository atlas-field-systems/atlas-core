package plugins_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestMalformedRetainedRecordsFaultBeforeReconciliation(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	good, err := f.core.Submit(context.Background(), request("valid-unfinished", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	bad, err := f.core.Submit(context.Background(), request("corruption-target", `{"value":8}`))
	if err != nil {
		t.Fatal(err)
	}
	child.kill(t)
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	if err := f.core.Close(); err != nil {
		t.Fatal(err)
	}
	baseline, err := os.ReadFile(f.config.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, fault := range []struct {
		name, path string
		value      json.RawMessage
	}{
		{"missing-status", "Status", nil},
		{"unknown-status", "Status", json.RawMessage(`"unknown"`)},
		{"missing-reports", "Reports", nil},
		{"null-reports", "Reports", json.RawMessage(`null`)},
		{"missing-false-field", "Exposed", nil},
		{"null-false-field", "Acknowledged", json.RawMessage(`null`)},
		{"unknown-field", "Unexpected", json.RawMessage(`true`)},
		{"unknown-nested-field", "Original.Unexpected", json.RawMessage(`true`)},
		{"mismatched-operation", "Execution.operation_id", json.RawMessage(`"dddddddd-dddd-4ddd-8ddd-dddddddddddd"`)},
		{"mismatched-dataset", "Original.DatasetID", json.RawMessage(`"dddddddd-dddd-4ddd-8ddd-dddddddddddd"`)},
		{"wrong-input-digest", "Execution.input_digest", json.RawMessage(`"0000000000000000000000000000000000000000000000000000000000000000"`)},
		{"terminal-without-outcome", "Status", json.RawMessage(`"completed"`)},
		{"latest-without-reports", "LatestSequence", json.RawMessage(`1`)},
		{"nonterminal-outcome", "Outcome", json.RawMessage(`{"status":"completed","result":{"value":16}}`)},
		{"recovered-nonterminal", "RecoveredOutcome", json.RawMessage(`{"status":"completed","result":{"value":16}}`)},
		{"missing-output-schema", "OutputSchema", nil},
		{"oversized-capability-bytes", "Original.CapabilityID", json.RawMessage(`"` + strings.Repeat("é", 65) + `"`)},
		{"oversized-version-bytes", "Original.InputVersion", json.RawMessage(`"` + strings.Repeat("é", 65) + `"`)},
		{"nonterminal-final-slot", "Exposed", json.RawMessage(`true`)},
		{"mis-cased-status", "Status", nil},
		{"mis-cased-binding", "Execution.binding.core_run_id", nil},
		{"duplicate-status", "", nil},
	} {
		t.Run(fault.name, func(t *testing.T) {
			cfg := f.config
			cfg.DatabasePath = filepath.Join(t.TempDir(), "retained.sqlite")
			cfg.CoreRunID = "new-run"
			if err := os.WriteFile(cfg.DatabasePath, baseline, 0o600); err != nil {
				t.Fatal(err)
			}
			restore, err := injectStoredRecord(cfg.DatabasePath, bad.ID, func(original string) (string, error) {
				changed, err := alterStoredField(original, strings.Split(fault.path, "."), fault.value)
				if err != nil {
					return "", err
				}
				switch fault.name {
				case "oversized-capability-bytes":
					return alterStoredField(changed, []string{"Execution", "capability_id"}, fault.value)
				case "oversized-version-bytes":
					return alterStoredField(changed, []string{"Execution", "input_version"}, fault.value)
				case "nonterminal-final-slot":
					reports := make(map[string]string, f.contract.Limits.MaxReportRevisions)
					for sequence := 1; sequence <= f.contract.Limits.MaxReportRevisions; sequence++ {
						reports[strconv.Itoa(sequence)] = strings.Repeat("0", 64)
					}
					encoded, err := json.Marshal(reports)
					if err != nil {
						return "", err
					}
					changed, err = alterStoredField(changed, []string{"Reports"}, encoded)
					if err != nil {
						return "", err
					}
					return alterStoredField(changed, []string{"LatestSequence"}, json.RawMessage(strconv.Itoa(f.contract.Limits.MaxReportRevisions)))
				case "mis-cased-status":
					return alterStoredField(changed, []string{"status"}, json.RawMessage(`"pending"`))
				case "mis-cased-binding":
					return alterStoredField(changed, []string{"Execution", "binding", "Core_Run_ID"}, json.RawMessage(`"run"`))
				case "duplicate-status":
					return strings.TrimSuffix(original, "}") + `,"Status":"pending"}`, nil
				default:
					return changed, nil
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			opened, err := plugins.Open(context.Background(), cfg)
			if !errors.Is(err, plugins.ErrIntegrity) {
				t.Errorf("malformed same-release record did not fault integrity: %v", err)
			}
			if opened != nil {
				if err := opened.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if err := restore(); err != nil {
				t.Fatal("failed opening did not preserve the corruption input", err)
			}
			opened, err = plugins.Open(context.Background(), cfg)
			if err != nil {
				t.Fatal("restored valid records refused retained opening", err)
			}
			defer func() {
				if err := opened.Close(); err != nil {
					t.Error(err)
				}
			}()
			for _, original := range []plugins.Operation{good, bad} {
				value, err := opened.Read(context.Background(), datasetID, pluginID, original.ID)
				if err != nil || value.Status != plugins.Interrupted || value.Outcome != nil || value.RecoveredOutcome != nil || string(value.Original.Input) != string(original.Original.Input) {
					t.Fatal("valid unfinished work did not reconcile with original facts", value, err)
				}
			}
		})
	}
}

func TestMissingWritingReleaseMarkerFaultsWithoutReconciliation(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	completed, err := f.core.Submit(context.Background(), request("confirmed-before-marker-loss", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed = f.wait(t, completed.ID, plugins.Completed)
	pending, err := f.core.Submit(context.Background(), request("unfinished-before-marker-loss", `{"value":8}`))
	if err != nil {
		t.Fatal(err)
	}
	assertEffects(t, f, 1)
	if err := child.stop(); err != nil {
		t.Fatal(err)
	}
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	if err := f.core.Close(); err != nil {
		t.Fatal(err)
	}
	baseline, err := os.ReadFile(f.config.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, release := range []string{f.config.CoreRelease, "different-writing-release"} {
		t.Run(release, func(t *testing.T) {
			cfg := f.config
			cfg.DatabasePath = filepath.Join(t.TempDir(), "missing-marker.sqlite")
			cfg.CoreRunID, cfg.CoreRelease = "new-run", release
			if err := os.WriteFile(cfg.DatabasePath, baseline, 0o600); err != nil {
				t.Fatal(err)
			}
			restore, err := injectMissingWritingMarker(cfg.DatabasePath, pending.ID)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := plugins.Open(context.Background(), cfg)
			if !errors.Is(err, plugins.ErrIntegrity) {
				t.Errorf("nonempty retained store adopted a missing writing marker: %v", err)
			}
			if opened != nil {
				if err := opened.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if err := restore(); err != nil {
				t.Fatal("failed opening did not preserve marker-loss fault input", err)
			}
			cfg.CoreRelease = "different-writing-release"
			opened, err = plugins.Open(context.Background(), cfg)
			if err == nil {
				t.Error("restored original marker allowed a different writing release")
			}
			if opened != nil {
				if err := opened.Close(); err != nil {
					t.Fatal(err)
				}
			}
			cfg.CoreRelease = f.config.CoreRelease
			opened, err = plugins.Open(context.Background(), cfg)
			if err != nil {
				t.Fatal("restored original writing marker refused valid retained open", err)
			}
			defer func() {
				if err := opened.Close(); err != nil {
					t.Error(err)
				}
			}()
			confirmed, err := opened.Read(context.Background(), datasetID, pluginID, completed.ID)
			if err != nil || mustJSON(t, confirmed) != mustJSON(t, completed) {
				t.Fatalf("restored open changed confirmed facts: %+v %v", confirmed, err)
			}
			unfinished, err := opened.Read(context.Background(), datasetID, pluginID, pending.ID)
			if err != nil || unfinished.Status != plugins.Interrupted || mustJSON(t, unfinished.Original) != mustJSON(t, pending.Original) || unfinished.Outcome != nil {
				t.Fatalf("valid unfinished work did not reconcile after marker restoration: %+v %v", unfinished, err)
			}
		})
	}
}

// Only the stopped store is touched. The conditional writes restore the exact
// injected marker absence and guard unchanged fault-input bytes; Open/Read
// supply the retained-state and writing-release business assertions.
func injectMissingWritingMarker(path, unfinishedID string) (_ func() error, result error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer func() { result = errors.Join(result, db.Close()) }()
	var dataset, release, original string
	if err := db.QueryRow("SELECT dataset_id, core_release FROM plugin_bookkeeping_metadata WHERE singleton = 1").Scan(&dataset, &release); err != nil {
		return nil, err
	}
	if err := db.QueryRow("SELECT value FROM plugin_operations WHERE id = ?", unfinishedID).Scan(&original); err != nil {
		return nil, err
	}
	if _, err := db.Exec("DELETE FROM plugin_bookkeeping_metadata WHERE singleton = 1"); err != nil {
		return nil, err
	}
	return func() (result error) {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			return err
		}
		defer func() { result = errors.Join(result, db.Close()) }()
		write, err := db.Exec("UPDATE plugin_operations SET value = value WHERE id = ? AND value = ?", unfinishedID, original)
		if err != nil {
			return err
		}
		if count, err := write.RowsAffected(); err != nil || count != 1 {
			return errors.Join(err, errors.New("retained fault-input bytes changed before marker restoration"))
		}
		write, err = db.Exec("INSERT INTO plugin_bookkeeping_metadata(singleton, dataset_id, core_release) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM plugin_bookkeeping_metadata)", dataset, release)
		if err != nil {
			return err
		}
		if count, err := write.RowsAffected(); err != nil || count != 1 {
			return errors.Join(err, errors.New("missing writing marker was silently initialized"))
		}
		return nil
	}, nil
}

// SQL access only injects/restores a deliberate corruption while Core is
// closed. Conditional restoration verifies the exact fault input survived;
// Open/Read provide every business-state assertion.
func injectStoredRecord(path, id string, change func(string) (string, error)) (_ func() error, result error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer func() { result = errors.Join(result, db.Close()) }()
	var original string
	if err := db.QueryRow("SELECT value FROM plugin_operations WHERE id = ?", id).Scan(&original); err != nil {
		return nil, err
	}
	corrupt, err := change(original)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("UPDATE plugin_operations SET value = ? WHERE id = ?", corrupt, id); err != nil {
		return nil, err
	}
	return func() (result error) {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			return err
		}
		defer func() { result = errors.Join(result, db.Close()) }()
		write, err := db.Exec("UPDATE plugin_operations SET value = ? WHERE id = ? AND value = ?", original, id, corrupt)
		if err != nil {
			return err
		}
		count, err := write.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.New("injected bytes changed before restoration")
		}
		return nil
	}, nil
}

func alterStoredField(encoded string, path []string, value json.RawMessage) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &fields); err != nil {
		return "", err
	}
	if len(path) > 1 {
		changed, err := alterStoredField(string(fields[path[0]]), path[1:], value)
		if err != nil {
			return "", fmt.Errorf("fault path: %w", err)
		}
		fields[path[0]] = json.RawMessage(changed)
	} else if value == nil {
		delete(fields, path[0])
	} else {
		fields[path[0]] = value
	}
	changed, err := json.Marshal(fields)
	return string(changed), err
}
