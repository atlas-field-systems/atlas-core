package hostmanagement

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

const recordFormat = 1

type Actor struct {
	UID uint32 `json:"uid"`
	GID uint32 `json:"gid"`
}
type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (f *Failure) Error() string { return f.Code + ": " + f.Message }

type Request struct {
	ActionID              string      `json:"action_id"`
	Kind                  string      `json:"kind"`
	ExpectedResetRevision *uint64     `json:"expected_reset_revision,omitempty"`
	Setup                 *SetupInput `json:"setup,omitempty"`
}

type Result struct {
	ActionID       string                  `json:"action_id,omitempty"`
	Kind           string                  `json:"kind,omitempty"`
	Status         string                  `json:"status"`
	InstallationID string                  `json:"installation_id"`
	DatasetID      string                  `json:"dataset_id,omitempty"`
	RunID          string                  `json:"run_id,omitempty"`
	Ready          bool                    `json:"ready"`
	ResetRevision  uint64                  `json:"reset_revision"`
	CAFingerprint  string                  `json:"ca_fingerprint,omitempty"`
	Config         *coremaintenance.Config `json:"config,omitempty"`
	Failure        *Failure                `json:"failure,omitempty"`
}

// LifetimeExtension gives later managed Plugin containers the same writer and
// cleanup gates. S1 installs no Plugins and therefore registers no extension.
type LifetimeExtension interface {
	StopWriters(context.Context) error
	VerifyStopped(context.Context) error
	ClearOperational(context.Context) error
	StartForCore(context.Context, string) error
	CoreLost(context.Context, string) error
}

type Command struct {
	Program string   `json:"program"`
	Prefix  []string `json:"prefix,omitempty"`
}
type Options struct {
	InstallationID string            `json:"installation_id"`
	Root           string            `json:"root"`
	RecoveryRoot   string            `json:"recovery_root"`
	RuntimeRoot    string            `json:"runtime_root"`
	Image          string            `json:"image"`
	BindAddress    string            `json:"bind_address"`
	Port           int               `json:"port"`
	OwnerUID       int               `json:"owner_uid"`
	ManagementGID  *int              `json:"management_gid,omitempty"`
	Docker         Command           `json:"docker"`
	Extension      LifetimeExtension `json:"-"`
	// Checkpoint can interrupt at a durable external phase. It changes timing,
	// never replaces Docker, the private Core transport or establishment proof.
	Checkpoint func(string) error `json:"-"`
}

type action struct {
	ID                   string    `json:"action_id"`
	Kind                 string    `json:"kind"`
	Actor                Actor     `json:"actor"`
	Fingerprint          string    `json:"request_fingerprint"`
	Phase                string    `json:"phase"`
	ResetID              string    `json:"reset_id,omitempty"`
	ExpectedDatasetID    string    `json:"expected_dataset_id,omitempty"`
	AcceptedAt           time.Time `json:"accepted_at"`
	Failure              *Failure  `json:"failure,omitempty"`
	TargetImageID        string    `json:"target_image_id,omitempty"`
	TargetWritingRelease string    `json:"target_writing_release,omitempty"`
}
type coreRun struct {
	ID          string `json:"run_id"`
	ContainerID string `json:"container_id"`
	ImageID     string `json:"image_id"`
}
type recoveryRecord struct {
	Format                    int      `json:"record_format"`
	InstallationID            string   `json:"installation_id"`
	ResetRevision             uint64   `json:"reset_revision"`
	Active                    *action  `json:"active,omitempty"`
	CompletedReset            *Result  `json:"completed_reset,omitempty"`
	LastResult                *Result  `json:"last_result,omitempty"`
	CompletedResetFingerprint string   `json:"completed_reset_fingerprint,omitempty"`
	LastResultFingerprint     string   `json:"last_result_fingerprint,omitempty"`
	Run                       *coreRun `json:"run,omitempty"`
}
type savedSetup struct {
	Installation  coremaintenance.Installation `json:"installation"`
	CAFingerprint string                       `json:"ca_fingerprint"`
}

// Manager owns the installation lock and all lifecycle work. Closing a CLI
// connection never cancels a submitted action; the service context owns it.
type Manager struct {
	options     Options
	mu          sync.Mutex
	submitMu    sync.Mutex
	record      recoveryRecord
	lock        *os.File
	ctx         context.Context
	cancel      context.CancelFunc
	work        sync.WaitGroup
	working     bool
	preparing   bool
	preparingID string
	imageID     string
}

func New(options Options) (*Manager, error) {
	if _, err := uuid.Parse(options.InstallationID); err != nil {
		return nil, errors.New("installation identity must be a UUID")
	}
	if options.Port < 1 || options.Port > 65535 || options.Image == "" || options.Docker.Program == "" {
		return nil, errors.New("image, Docker command and valid HTTPS port are required")
	}
	if options.OwnerUID != os.Getuid() || options.ManagementGID != nil && *options.ManagementGID < 0 {
		return nil, errors.New("manager must run as the configured installation owner")
	}
	if len(filepath.Join(options.RuntimeRoot, "core", "maintenance.sock")) >= 108 {
		return nil, errors.New("runtime root exceeds Linux Unix socket path limit")
	}
	paths := []string{options.Root, options.RecoveryRoot, options.RuntimeRoot}
	for _, path := range paths {
		if !filepath.IsAbs(path) || filepath.Clean(path) == "/" {
			return nil, errors.New("owned roots must be absolute dedicated directories")
		}
		if err := rejectSymlinkAncestors(path); err != nil {
			return nil, err
		}
	}
	for i, path := range paths {
		for j, other := range paths {
			if i != j && within(path, other) {
				return nil, errors.New("installation, runtime and recovery roots must be disjoint")
			}
		}
	}
	for _, path := range paths {
		if err := os.MkdirAll(path, 0700); err != nil {
			return nil, fmt.Errorf("prepare owned directory: %w", err)
		}
	}
	for _, path := range paths {
		if err := ensureOwnedRoot(path, options.InstallationID); err != nil {
			return nil, err
		}
	}
	lock, err := os.OpenFile(filepath.Join(options.RecoveryRoot, "manager.lock"), os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, &Failure{Code: "management_busy", Message: "an installation manager already holds the lock"}
	}
	m := &Manager{options: options, lock: lock, record: recoveryRecord{Format: recordFormat, InstallationID: options.InstallationID}}
	m.ctx, m.cancel = context.WithCancel(context.Background())
	data, err := os.ReadFile(m.recordPath())
	if err == nil {
		if err := decodeStrict(data, &m.record); err != nil || m.record.Format != recordFormat || m.record.InstallationID != options.InstallationID {
			m.Close()
			return nil, &Failure{Code: "management_record_invalid", Message: "recovery record is unreadable or belongs to another installation"}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		m.Close()
		return nil, fmt.Errorf("read recovery record: %w", err)
	}
	if active := m.record.Active; active != nil && active.Kind == "reset" {
		_, actionErr := uuid.Parse(active.ID)
		_, datasetErr := uuid.Parse(active.ExpectedDatasetID)
		if actionErr != nil || datasetErr != nil || active.ResetID != active.ID || active.TargetWritingRelease == "" || m.record.ResetRevision == 0 {
			m.Close()
			return nil, &Failure{Code: "management_record_invalid", Message: "pending Reset authority is incomplete or invalid"}
		}
	}
	if m.record.Run != nil {
		m.imageID = m.record.Run.ImageID
	} else if m.record.Active != nil {
		m.imageID = m.record.Active.TargetImageID
	}
	for _, name := range []string{"core", "setup", "logs", "objects", "staging"} {
		if err := os.MkdirAll(filepath.Join(options.Root, name), 0700); err != nil {
			m.Close()
			return nil, err
		}
	}
	if err := os.MkdirAll(m.coreRuntimeDir(), 0700); err != nil {
		m.Close()
		return nil, err
	}
	return m, nil
}

func (m *Manager) Close() error {
	m.cancel()
	m.work.Wait()
	if m.lock == nil {
		return nil
	}
	err := errors.Join(unix.Flock(int(m.lock.Fd()), unix.LOCK_UN), m.lock.Close())
	m.lock = nil
	return err
}
func (m *Manager) recordPath() string     { return filepath.Join(m.options.RecoveryRoot, "state.json") }
func (m *Manager) coreRuntimeDir() string { return filepath.Join(m.options.RuntimeRoot, "core") }
func (m *Manager) saveLocked() error      { return writeJSON(m.recordPath(), m.record) }

func (m *Manager) Submit(request Request, actor Actor) (Result, error) {
	if !m.submitMu.TryLock() {
		m.mu.Lock()
		activeID := m.preparingID
		if m.record.Active != nil {
			activeID = m.record.Active.ID
		}
		m.mu.Unlock()
		return Result{}, &Failure{Code: "management_busy", Message: "active action " + activeID}
	}
	defer m.submitMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := uuid.Parse(request.ActionID); err != nil {
		return Result{}, &Failure{Code: "invalid_action", Message: "action identity must be a UUID"}
	}
	if request.Kind == "retry" {
		if m.record.Active != nil && m.record.Active.ID == request.ActionID {
			m.launchLocked()
		}
		return m.inspectLocked(request.ActionID), nil
	}
	if request.Kind != "setup" && request.Kind != "start" && request.Kind != "stop" && request.Kind != "restart" && request.Kind != "reset" {
		return Result{}, &Failure{Code: "invalid_action", Message: "unsupported lifecycle action"}
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return Result{}, err
	}
	digest := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(digest[:])
	if active := m.record.Active; active != nil {
		if request.Kind == "start" && active.Kind == "reset" {
			m.launchLocked()
			return m.inspectLocked(active.ID), nil
		}
		if active.ID != request.ActionID {
			return Result{}, &Failure{Code: "management_busy", Message: "active action " + active.ID}
		}
		if active.Fingerprint != fingerprint {
			return Result{}, &Failure{Code: "action_conflict", Message: "action identity reused with different request"}
		}
		m.launchLocked()
		return m.inspectLocked(active.ID), nil
	}
	if completed := m.record.CompletedReset; completed != nil && completed.ActionID == request.ActionID {
		if m.record.CompletedResetFingerprint != fingerprint {
			return Result{}, &Failure{Code: "action_conflict", Message: "completed action identity was reused with different request"}
		}
		return *completed, nil
	}
	if last := m.record.LastResult; last != nil && last.ActionID == request.ActionID {
		if m.record.LastResultFingerprint != fingerprint {
			return Result{}, &Failure{Code: "action_conflict", Message: "completed action identity was reused with different request"}
		}
		return *last, nil
	}
	if request.Kind == "reset" {
		if request.ExpectedResetRevision == nil || *request.ExpectedResetRevision != m.record.ResetRevision {
			return Result{}, &Failure{Code: "reset_precondition", Message: "inspect the current Reset revision before submitting a new Reset"}
		}
	}
	if request.Kind == "setup" {
		if request.Setup == nil {
			return Result{}, &Failure{Code: "setup_required", Message: "prepared setup input is required"}
		}
		if _, err := os.Stat(filepath.Join(m.options.Root, "setup", "installation.json")); err == nil {
			return Result{}, &Failure{Code: "already_setup", Message: "installation setup already exists"}
		} else if !errors.Is(err, os.ErrNotExist) {
			return Result{}, err
		}
		if _, err := ProvisionTrust(*request.Setup, time.Now()); err != nil {
			return Result{}, err
		}
		if err := writeJSON(filepath.Join(m.options.Root, "setup", "pending-setup.json"), request.Setup); err != nil {
			return Result{}, err
		}
	} else if _, err := m.loadSetup(); err != nil {
		return Result{}, err
	}
	var preflight coremaintenance.Result
	if request.Kind == "reset" {
		m.preparing = true
		m.preparingID = request.ActionID
		m.mu.Unlock()
		preflightCtx, cancel := context.WithTimeout(m.ctx, 20*time.Second)
		proof, proofErr := m.maintenance(preflightCtx, "preflight", nil, "", "")
		cancel()
		m.mu.Lock()
		m.preparing = false
		m.preparingID = ""
		if proofErr != nil {
			return Result{}, proofErr
		}
		if err := m.validateCoreResult(proof, proof.RunID, false); err != nil {
			return Result{}, err
		}
		preflight = proof
	}
	previous := m.record
	active := &action{ID: request.ActionID, Kind: request.Kind, Actor: actor, Fingerprint: fingerprint, Phase: "accepted", AcceptedAt: time.Now().UTC(), TargetImageID: m.imageID}
	if request.Kind == "reset" {
		active.ResetID = request.ActionID
		active.ExpectedDatasetID = preflight.DatasetID
		active.TargetWritingRelease = preflight.WritingRelease
		m.record.ResetRevision++
		m.record.CompletedReset = nil
		m.record.CompletedResetFingerprint = ""
	}
	m.record.Active = active
	m.record.LastResult = nil
	m.record.LastResultFingerprint = ""
	if err := m.saveLocked(); err != nil {
		m.record = previous
		return Result{}, err
	}
	m.launchLocked()
	return m.inspectLocked(active.ID), nil
}

func (m *Manager) Resume() { m.mu.Lock(); defer m.mu.Unlock(); m.launchLocked() }
func (m *Manager) launchLocked() {
	if m.record.Active == nil || m.working || m.ctx.Err() != nil {
		return
	}
	m.working = true
	m.work.Add(1)
	go func() {
		defer m.work.Done()
		err := m.perform(m.ctx)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.working = false
		if err != nil && m.record.Active != nil {
			m.record.Active.Failure = safeFailure(err)
			if saveErr := m.saveLocked(); saveErr != nil {
				m.record.Active.Failure = &Failure{Code: "management_record_unwritable", Message: "action outcome could not be synced"}
			}
		}
	}()
}
func (m *Manager) Inspect(actionID string) Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inspectLocked(actionID)
}
func (m *Manager) inspectLocked(actionID string) Result {
	if actionID != "" {
		if m.record.Active != nil && m.record.Active.ID == actionID {
			a := m.record.Active
			status := "running"
			if !m.working && a.Failure != nil {
				status = "incomplete"
			}
			return Result{ActionID: a.ID, Kind: a.Kind, Status: status, InstallationID: m.options.InstallationID, ResetRevision: m.record.ResetRevision, Failure: a.Failure}
		}
		if m.record.CompletedReset != nil && m.record.CompletedReset.ActionID == actionID {
			return *m.record.CompletedReset
		}
		if m.record.LastResult != nil && m.record.LastResult.ActionID == actionID {
			return *m.record.LastResult
		}
		return Result{ActionID: actionID, Status: "action_result_expired", InstallationID: m.options.InstallationID, ResetRevision: m.record.ResetRevision}
	}
	result := Result{Status: "stopped", InstallationID: m.options.InstallationID, ResetRevision: m.record.ResetRevision}
	if m.record.Run != nil {
		result.Status = "running"
		result.RunID = m.record.Run.ID
	}
	if m.record.Active != nil {
		result.ActionID = m.record.Active.ID
		result.Kind = m.record.Active.Kind
		result.Status = "action_pending"
		result.Failure = m.record.Active.Failure
	}
	if saved, err := m.loadSetup(); err == nil {
		result.CAFingerprint = saved.CAFingerprint
		config := saved.Installation.InitialConfig
		result.Config = &config
	}
	if m.record.LastResult != nil {
		result.DatasetID = m.record.LastResult.DatasetID
		result.Ready = m.record.Run != nil && m.record.LastResult.RunID == m.record.Run.ID && m.record.LastResult.Ready && m.record.Active == nil
	}
	return result
}

func (m *Manager) phase(name string) error {
	m.mu.Lock()
	if m.record.Active == nil {
		m.mu.Unlock()
		return errors.New("active action disappeared")
	}
	m.record.Active.Phase = name
	m.record.Active.Failure = nil
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if m.options.Checkpoint != nil {
		return m.options.Checkpoint(name)
	}
	return nil
}
func (m *Manager) finish(core coremaintenance.Result) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := m.record.Active
	if a == nil {
		return errors.New("active action disappeared")
	}
	result := Result{ActionID: a.ID, Kind: a.Kind, Status: "completed", InstallationID: m.options.InstallationID, DatasetID: core.DatasetID, RunID: core.RunID, Ready: core.Ready, ResetRevision: m.record.ResetRevision}
	if saved, err := m.loadSetup(); err == nil {
		result.CAFingerprint = saved.CAFingerprint
		config := saved.Installation.InitialConfig
		result.Config = &config
	}
	if a.Kind == "reset" {
		m.record.CompletedReset = &result
		m.record.CompletedResetFingerprint = a.Fingerprint
	}
	m.record.LastResult = &result
	m.record.LastResultFingerprint = a.Fingerprint
	m.record.Active = nil
	if err := m.saveLocked(); err != nil {
		m.record.Active = a
		return err
	}
	return nil
}
func (m *Manager) loadSetup() (savedSetup, error) {
	var saved savedSetup
	data, err := os.ReadFile(filepath.Join(m.options.Root, "setup", "installation.json"))
	if err != nil {
		return saved, &Failure{Code: "setup_required", Message: "installation setup is missing or unreadable"}
	}
	if err := decodeStrict(data, &saved); err != nil || saved.Installation.InstallationID != m.options.InstallationID {
		return saved, &Failure{Code: "setup_invalid", Message: "installation setup is invalid or conflicts with the installation"}
	}
	return saved, nil
}
func safeFailure(err error) *Failure {
	var local *Failure
	if errors.As(err, &local) {
		return local
	}
	var core *coremaintenance.Error
	if errors.As(err, &core) {
		return &Failure{Code: core.Code, Message: core.Message}
	}
	return &Failure{Code: "action_incomplete", Message: "local lifecycle work did not complete; inspect owned resources and retry the same action"}
}
func decodeStrict(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("local JSON has trailing values")
	}
	return nil
}

func (m *Manager) provision(ctx context.Context) (coremaintenance.Result, error) {
	if _, err := m.loadSetup(); err != nil {
		var input SetupInput
		data, err := os.ReadFile(filepath.Join(m.options.Root, "setup", "pending-setup.json"))
		if err != nil {
			return coremaintenance.Result{}, err
		}
		if err := decodeStrict(data, &input); err != nil {
			return coremaintenance.Result{}, err
		}
		trust, err := ProvisionTrust(input, time.Now())
		if err != nil {
			return coremaintenance.Result{}, err
		}
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return coremaintenance.Result{}, err
		}
		files := map[string][]byte{"ca.crt": trust.CACertificate, "server.crt": trust.ServerCertificate, "server.key": trust.ServerKey, "enrollment.key": []byte(base64.RawURLEncoding.EncodeToString(private))}
		if len(trust.CAKey) != 0 {
			files["ca.key"] = trust.CAKey
		}
		for name, contents := range files {
			if err := writeDurable(filepath.Join(m.options.Root, "setup", name), contents, 0600); err != nil {
				return coremaintenance.Result{}, err
			}
		}
		config := coremaintenance.DefaultConfig()
		config.PublicAddress = "https://" + net.JoinHostPort(input.ServerNames[0], fmt.Sprint(m.options.Port))
		config.OpenEnrollment = input.OpenEnrollment
		saved := savedSetup{Installation: coremaintenance.Installation{InstallationID: m.options.InstallationID, AdminVerifier: input.AdminVerifier, EnrollmentPublicKey: base64.RawURLEncoding.EncodeToString(public), InitialConfig: config}, CAFingerprint: trust.Fingerprint}
		if err := writeJSON(filepath.Join(m.options.Root, "setup", "installation.json"), saved); err != nil {
			return coremaintenance.Result{}, err
		}
	}
	saved, err := m.loadSetup()
	if err != nil {
		return coremaintenance.Result{}, err
	}
	result, err := m.maintenance(ctx, "setup", &saved.Installation, "", "")
	if err != nil {
		return result, err
	}
	if err := os.Remove(filepath.Join(m.options.Root, "setup", "pending-setup.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	return result, nil
}

func within(path, root string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && (relative == "." || relative != ".." && !startsParent(relative))
}
func startsParent(path string) bool {
	return len(path) > 3 && path[:3] == ".."+string(filepath.Separator)
}
func rejectSymlinkAncestors(path string) error {
	for current := path; current != "/"; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("owned paths must not contain symlinks")
		}
	}
	return nil
}
func ensureOwnedRoot(path, installationID string) error {
	marker := filepath.Join(path, ".atlas-owner.json")
	data, err := os.ReadFile(marker)
	if err == nil {
		var owner struct {
			InstallationID string `json:"installation_id"`
		}
		if err := decodeStrict(data, &owner); err != nil || owner.InstallationID != installationID {
			return &Failure{Code: "installation_ownership_conflict", Message: "owned root belongs to another installation or has invalid ownership"}
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return &Failure{Code: "installation_ownership_conflict", Message: "first setup refuses to adopt a nonempty unowned directory"}
	}
	return writeJSON(marker, struct {
		InstallationID string `json:"installation_id"`
	}{installationID})
}
