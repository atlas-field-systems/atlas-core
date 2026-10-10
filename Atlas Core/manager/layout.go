// Package manager is the shared private host-management implementation used
// by the local CLI: installation setup, trust material, and Core Start, Stop,
// Restart and ordinary Reset through Docker Compose and Core's private
// socket. It never opens Core's SQLite database; Core is its sole accessor.
package manager

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/atlas-field-systems/atlas-core/corerun"
)

// Installation names one installation's owned root and its external recovery
// storage, which lives outside the tree that cleanup touches.
type Installation struct {
	Root     string
	Recovery string
}

// Owned layout under the installation root.
func (i Installation) coreDir() string      { return filepath.Join(i.Root, "core") }
func (i Installation) setupDir() string     { return filepath.Join(i.Root, "setup") }
func (i Installation) coreSetupDir() string { return filepath.Join(i.Root, "setup", "core") }
func (i Installation) caDir() string        { return filepath.Join(i.Root, "setup", "ca") }
func (i Installation) journalDir() string   { return filepath.Join(i.Root, "journal") }
func (i Installation) logsDir() string      { return filepath.Join(i.Root, "logs") }
func (i Installation) runDir() string       { return filepath.Join(i.Root, "run") }
func (i Installation) socket() string       { return filepath.Join(i.Root, "run", "core.sock") }
func (i Installation) composeFile() string  { return filepath.Join(i.Root, "setup", "compose.json") }
func (i Installation) recordFile() string   { return filepath.Join(i.Root, "setup", "manager.json") }
func (i Installation) actionsDir() string   { return filepath.Join(i.Recovery, "actions") }
func (i Installation) lockFile() string     { return filepath.Join(i.Recovery, "manager.lock") }
func (i Installation) settingsFile() string { return filepath.Join(i.coreSetupDir(), "config.json") }
func (i Installation) identityFile() string {
	return filepath.Join(i.coreSetupDir(), "installation.json")
}
func (i Installation) CACertificate() string { return filepath.Join(i.caDir(), "ca.crt") }

// Record is the nonsecret host-management view of an installation.
type Record struct {
	Format         int      `json:"format"`
	InstallationID string   `json:"installation_id"`
	Image          string   `json:"image"`
	ListenAddress  string   `json:"listen_address"`
	ListenPort     int64    `json:"listen_port"`
	Hostnames      []string `json:"hostnames"`
	TestFaults     bool     `json:"test_faults"`
	OwnerUID       int      `json:"owner_uid"`
	OwnerGID       int      `json:"owner_gid"`
}

// ErrNotSetUp reports an installation root without completed setup.
var ErrNotSetUp = errors.New("installation_not_set_up")

func (i Installation) record() (Record, error) {
	encoded, err := os.ReadFile(i.recordFile())
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, ErrNotSetUp
	}
	if err != nil {
		return Record{}, fmt.Errorf("read installation record: %w", err)
	}
	var record Record
	if err := json.Unmarshal(encoded, &record); err != nil || record.Format != 1 {
		return Record{}, errors.New("installation record is unreadable")
	}
	return record, nil
}

func (i Installation) installationRecord() (corerun.InstallationRecord, error) {
	encoded, err := os.ReadFile(i.identityFile())
	if err != nil {
		return corerun.InstallationRecord{}, fmt.Errorf("read installation identity: %w", err)
	}
	var record corerun.InstallationRecord
	if err := json.Unmarshal(encoded, &record); err != nil {
		return record, fmt.Errorf("decode installation identity: %w", err)
	}
	return record, nil
}
