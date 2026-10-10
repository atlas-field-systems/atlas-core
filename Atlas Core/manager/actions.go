package manager

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

// writeDurable replaces path atomically: a synced same-directory temporary
// file, rename, then a directory sync. Callers perform a newly recorded phase
// only after this returns.
func writeDurable(path string, data []byte, perm os.FileMode) (err error) {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".tmp-"+filepath.Base(path)+"-")
	if err != nil {
		return fmt.Errorf("create temporary %s: %w", filepath.Base(path), err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, removeIfPresent(temporary.Name()))
		}
	}()
	if _, err := temporary.Write(data); err != nil {
		return errors.Join(fmt.Errorf("write %s: %w", filepath.Base(path), err), temporary.Close())
	}
	if err := temporary.Chmod(perm); err != nil {
		return errors.Join(fmt.Errorf("restrict %s: %w", filepath.Base(path), err), temporary.Close())
	}
	if err := temporary.Sync(); err != nil {
		return errors.Join(fmt.Errorf("sync %s: %w", filepath.Base(path), err), temporary.Close())
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close %s: %w", filepath.Base(path), err)
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return syncDirectory(directory)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open directory for sync: %w", err)
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func removeIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Action kinds and phases recorded in durable management action records.
const (
	KindStart   = "start"
	KindStop    = "stop"
	KindRestart = "restart"
	KindReset   = "reset"
	KindSetup   = "setup"

	PhasePending     = "pending"
	PhaseCleaned     = "cleaned"
	PhaseEstablished = "established"
	PhaseCompleted   = "completed"
	PhaseFailed      = "failed"
	PhaseIncomplete  = "stop_incomplete"
)

// ActionRecord is the one private record representation for recoverable
// local management work. A pending Reset record is also the Reset directive.
type ActionRecord struct {
	RecordFormat     int       `json:"record_format"`
	ActionID         string    `json:"action_id"`
	Kind             string    `json:"kind"`
	InstallationID   string    `json:"installation_id"`
	Phase            string    `json:"phase"`
	Image            string    `json:"image"`
	ResetID          string    `json:"reset_id,omitempty"`
	CompletedTargets []string  `json:"completed_targets"`
	DatasetID        string    `json:"dataset_id,omitempty"`
	Outcome          string    `json:"outcome,omitempty"`
	Error            string    `json:"error,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Terminal reports whether the record has no remaining startup or cleanup
// authority.
func (r ActionRecord) Terminal() bool {
	return r.Phase == PhaseCompleted || r.Phase == PhaseFailed
}

func (i Installation) actionPath(actionID string) string {
	return filepath.Join(i.actionsDir(), actionID+".json")
}

func (i Installation) saveAction(record *ActionRecord) error {
	record.RecordFormat = 1
	record.UpdatedAt = time.Now().UTC()
	if record.CreatedAt.IsZero() {
		record.CreatedAt = record.UpdatedAt
	}
	if record.CompletedTargets == nil {
		record.CompletedTargets = []string{}
	}
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("encode action record: %w", err)
	}
	return writeDurable(i.actionPath(record.ActionID), append(encoded, '\n'), 0o600)
}

// ErrActionRecord reports an unreadable or conflicting pending record. Start
// refuses until explicit local repair resolves it.
var ErrActionRecord = errors.New("action_record_unusable")

func (i Installation) loadAction(actionID string) (ActionRecord, error) {
	encoded, err := os.ReadFile(i.actionPath(actionID))
	if err != nil {
		return ActionRecord{}, err
	}
	var record ActionRecord
	if err := json.Unmarshal(encoded, &record); err != nil || record.RecordFormat != 1 || record.ActionID != actionID {
		return ActionRecord{}, fmt.Errorf("%w: action %s is unreadable", ErrActionRecord, actionID)
	}
	return record, nil
}

// actions lists retained records. Unreadable records are reported, never
// skipped, so they cannot silently lose startup-blocking authority.
func (i Installation) actions(installationID string) ([]ActionRecord, error) {
	entries, err := os.ReadDir(i.actionsDir())
	if err != nil {
		return nil, fmt.Errorf("list action records: %w", err)
	}
	var records []ActionRecord
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".tmp-") {
			continue
		}
		record, err := i.loadAction(strings.TrimSuffix(name, ".json"))
		if err != nil {
			return nil, err
		}
		if record.InstallationID != installationID {
			return nil, fmt.Errorf("%w: action %s belongs to another installation", ErrActionRecord, record.ActionID)
		}
		records = append(records, record)
	}
	slices.SortFunc(records, func(a, b ActionRecord) int { return a.CreatedAt.Compare(b.CreatedAt) })
	return records, nil
}

// lock holds the exclusive installation management lock.
type lock struct {
	file *os.File
}

// ErrBusy reports another active local management action.
type ErrBusy struct{ ActiveAction string }

func (e *ErrBusy) Error() string {
	return "management_busy: another local management action is active: " + e.ActiveAction
}

func (i Installation) activePath() string { return filepath.Join(i.Recovery, "active") }

// acquire takes the management lock without waiting. A concurrent invocation
// naming the same action joins it by waiting for the lock; others are busy.
func (i Installation) acquire(actionID string) (*lock, error) {
	file, err := os.OpenFile(i.lockFile(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open management lock: %w", err)
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		active, _ := os.ReadFile(i.activePath())
		if actionID != "" && strings.TrimSpace(string(active)) == actionID {
			if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
				return nil, errors.Join(fmt.Errorf("join active action: %w", err), file.Close())
			}
		} else {
			return nil, errors.Join(&ErrBusy{ActiveAction: strings.TrimSpace(string(active))}, file.Close())
		}
	}
	if err := writeDurable(i.activePath(), []byte(actionID+"\n"), 0o600); err != nil {
		return nil, errors.Join(err, file.Close())
	}
	return &lock{file: file}, nil
}

func (l *lock) release() error {
	return errors.Join(unix.Flock(int(l.file.Fd()), unix.LOCK_UN), l.file.Close())
}

// localActor identifies the local administrator from the operating system
// account; it does not prove which human used that account.
func localActor() system.Actor {
	uid := strconv.Itoa(os.Getuid())
	display := "uid " + uid
	if current, err := user.Current(); err == nil {
		display = current.Username
	}
	return system.Actor{Kind: "local_administrator", ID: "uid:" + uid, Display: display}
}

// appendJournal records a local action while Core is stopped. Core imports
// the journal once when it opens the Dataset.
func (i Installation) appendJournal(entry system.JournalEntry) error {
	file, err := os.OpenFile(filepath.Join(i.journalDir(), system.JournalFile), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open local activity journal: %w", err)
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return errors.Join(fmt.Errorf("encode local activity: %w", err), file.Close())
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		return errors.Join(fmt.Errorf("append local activity: %w", err), file.Close())
	}
	return errors.Join(file.Sync(), file.Close())
}

func newActivity(action, targetKind, targetID, outcome string, summary map[string]any) system.JournalEntry {
	return system.JournalEntry{
		ActionID: uuid.NewString(), Actor: localActor(), Action: action, TargetKind: targetKind, TargetID: targetID,
		OccurredAt: time.Now().UTC(), Outcome: outcome, Summary: summary,
	}
}
