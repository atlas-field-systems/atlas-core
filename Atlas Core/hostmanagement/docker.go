package hostmanagement

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/google/uuid"
)

const dockerOutputBound = 1 << 20
const terminationGrace = 10 * time.Second

type boundedOutput struct {
	bytes.Buffer
	overflow bool
}

func (w *boundedOutput) Write(data []byte) (int, error) {
	if w.Len()+len(data) > dockerOutputBound {
		w.overflow = true
		return len(data), nil
	}
	return w.Buffer.Write(data)
}
func (m *Manager) docker(ctx context.Context, args ...string) (string, error) {
	command := exec.CommandContext(ctx, m.options.Docker.Program, append(append([]string{}, m.options.Docker.Prefix...), args...)...)
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 3 * time.Second
	var output boundedOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return "", &Failure{Code: "docker_unavailable", Message: "Docker " + strings.Join(args[:min(len(args), 2)], " ") + " did not complete"}
	}
	if output.overflow {
		return "", errors.New("Docker response exceeded bound")
	}
	return strings.TrimSpace(output.String()), nil
}
func (m *Manager) project() string {
	return "atlas-" + strings.ReplaceAll(m.options.InstallationID, "-", "")
}
func (m *Manager) coreName() string    { return m.project() + "-core" }
func (m *Manager) composePath() string { return filepath.Join(m.options.RecoveryRoot, "compose.json") }
func (m *Manager) compose(ctx context.Context, args ...string) (string, error) {
	base := []string{"compose", "--project-name", m.project(), "--file", m.composePath()}
	return m.docker(ctx, append(base, args...)...)
}

type composeMount struct {
	Type     string `json:"type"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"read_only,omitempty"`
}
type composeService struct {
	Image         string            `json:"image"`
	ContainerName string            `json:"container_name"`
	User          string            `json:"user"`
	Restart       string            `json:"restart"`
	ReadOnly      bool              `json:"read_only"`
	Command       []string          `json:"command"`
	Volumes       []composeMount    `json:"volumes"`
	Ports         []string          `json:"ports"`
	Labels        map[string]string `json:"labels"`
	SecurityOpt   []string          `json:"security_opt"`
	CapDrop       []string          `json:"cap_drop"`
	Tmpfs         []string          `json:"tmpfs"`
	Logging       composeLogging    `json:"logging"`
}
type composeLogging struct {
	Driver  string            `json:"driver"`
	Options map[string]string `json:"options"`
}
type composeDocument struct {
	Services map[string]composeService `json:"services"`
	Networks map[string]composeNetwork `json:"networks"`
}
type composeNetwork struct {
	DriverOptions map[string]string `json:"driver_opts"`
	Labels        map[string]string `json:"labels"`
}

func (m *Manager) coreArguments(runID string, maintenance bool) []string {
	args := []string{"--state-dir", "/var/lib/atlas/core", "--listen", "0.0.0.0:8443", "--tls-cert", "/run/atlas/server.crt", "--tls-key", "/run/atlas/server.key", "--maintenance-socket", "/run/atlas/core/maintenance.sock", "--run-id", runID, "--owner-uid", strconv.Itoa(m.options.OwnerUID), "--activity-journal", "/var/lib/atlas/core/local-actions.jsonl"}
	if maintenance {
		args = append(args, "--maintenance-only")
	}
	return args
}
func (m *Manager) writeCompose(ctx context.Context, runID string) error {
	if m.imageID == "" {
		image, err := m.docker(ctx, "image", "inspect", "--format", "{{.Id}}", m.options.Image)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(image, "sha256:") {
			return errors.New("configured Core image has no immutable identity")
		}
		m.imageID = image
	}
	m.mu.Lock()
	if m.record.Active != nil && m.record.Active.TargetImageID == "" {
		m.record.Active.TargetImageID = m.imageID
		if err := m.saveLocked(); err != nil {
			m.mu.Unlock()
			return err
		}
	}
	m.mu.Unlock()
	if ip := net.ParseIP(m.options.BindAddress); ip == nil {
		return errors.New("Core bind address must be an IP address")
	}
	mounts := []composeMount{{Type: "bind", Source: filepath.Join(m.options.Root, "core"), Target: "/var/lib/atlas/core"}, {Type: "bind", Source: filepath.Join(m.options.Root, "objects"), Target: "/var/lib/atlas/objects"}, {Type: "bind", Source: filepath.Join(m.options.Root, "logs"), Target: "/var/lib/atlas/logs"}, {Type: "bind", Source: m.coreRuntimeDir(), Target: "/run/atlas/core"}, {Type: "bind", Source: filepath.Join(m.options.Root, "setup", "server.crt"), Target: "/run/atlas/server.crt", ReadOnly: true}, {Type: "bind", Source: filepath.Join(m.options.Root, "setup", "server.key"), Target: "/run/atlas/server.key", ReadOnly: true}}
	service := composeService{Image: m.imageID, ContainerName: m.coreName(), User: fmt.Sprintf("%d:%d", m.options.OwnerUID, os.Getgid()), Restart: "no", ReadOnly: true, Command: m.coreArguments(runID, false), Volumes: mounts, Ports: []string{net.JoinHostPort(m.options.BindAddress, strconv.Itoa(m.options.Port)) + ":8443"}, Labels: map[string]string{"atlas.installation_id": m.options.InstallationID, "atlas.owner": "hostmanagement"}, SecurityOpt: []string{"no-new-privileges:true"}, CapDrop: []string{"ALL"}, Tmpfs: []string{"/tmp:rw,noexec,nosuid,size=16m"}}
	service.Logging = composeLogging{Driver: "json-file", Options: map[string]string{"max-size": "10m", "max-file": "3"}}
	return writeJSON(m.composePath(), composeDocument{Services: map[string]composeService{"core": service}, Networks: map[string]composeNetwork{"default": {DriverOptions: map[string]string{"com.docker.network.bridge.enable_ip_masquerade": "false"}, Labels: map[string]string{"atlas.installation_id": m.options.InstallationID, "atlas.owner": "hostmanagement"}}}})
}

type containerInspection struct {
	ID     string `json:"Id"`
	Image  string `json:"Image"`
	Config struct {
		Labels map[string]string `json:"Labels"`
		Cmd    []string          `json:"Cmd"`
		User   string            `json:"User"`
	} `json:"Config"`
	State struct {
		Running bool   `json:"Running"`
		Status  string `json:"Status"`
	} `json:"State"`
	Mounts []struct {
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		ReadWrite   bool   `json:"RW"`
	} `json:"Mounts"`
}

func (m *Manager) inspectContainer(ctx context.Context, id string) (containerInspection, error) {
	output, err := m.docker(ctx, "inspect", id)
	if err != nil {
		return containerInspection{}, err
	}
	var values []containerInspection
	if err := json.Unmarshal([]byte(output), &values); err != nil || len(values) != 1 {
		return containerInspection{}, errors.New("Docker inspection is invalid")
	}
	value := values[0]
	if value.Config.Labels["atlas.installation_id"] != m.options.InstallationID || value.Config.Labels["atlas.owner"] != "hostmanagement" || value.Image != m.imageID {
		return containerInspection{}, &Failure{Code: "container_ownership_conflict", Message: "container image or installation labels do not match"}
	}
	expectedMounts := map[string]string{"/var/lib/atlas/core": filepath.Join(m.options.Root, "core"), "/var/lib/atlas/objects": filepath.Join(m.options.Root, "objects"), "/var/lib/atlas/logs": filepath.Join(m.options.Root, "logs"), "/run/atlas/core": m.coreRuntimeDir(), "/run/atlas/server.crt": filepath.Join(m.options.Root, "setup", "server.crt"), "/run/atlas/server.key": filepath.Join(m.options.Root, "setup", "server.key")}
	if len(value.Mounts) != len(expectedMounts) || value.Config.User != fmt.Sprintf("%d:%d", m.options.OwnerUID, os.Getgid()) {
		return containerInspection{}, &Failure{Code: "container_ownership_conflict", Message: "Core container owner or mounts do not match the installation"}
	}
	for _, mount := range value.Mounts {
		expected, exists := expectedMounts[mount.Destination]
		readonly := mount.Destination == "/run/atlas/server.crt" || mount.Destination == "/run/atlas/server.key"
		if !exists || mount.Source != expected || mount.ReadWrite == readonly {
			return containerInspection{}, &Failure{Code: "container_ownership_conflict", Message: "Core container storage or trust mounts do not match owned resources"}
		}
		delete(expectedMounts, mount.Destination)
	}
	if len(expectedMounts) != 0 {
		return containerInspection{}, errors.New("Core has duplicate or missing owned mounts")
	}
	runIndex := slices.Index(value.Config.Cmd, "--run-id")
	if runIndex < 0 || runIndex+1 >= len(value.Config.Cmd) {
		return containerInspection{}, errors.New("Core container has no run identity")
	}
	runID := value.Config.Cmd[runIndex+1]
	if _, err := uuid.Parse(runID); err != nil || !slices.Equal(value.Config.Cmd, m.coreArguments(runID, slices.Contains(value.Config.Cmd, "--maintenance-only"))) {
		return containerInspection{}, &Failure{Code: "container_ownership_conflict", Message: "Core container command does not match the private installation boundary"}
	}
	return value, nil
}
func (m *Manager) validateCoreResult(result coremaintenance.Result, runID string, allowUninitialized bool) error {
	if result.RunID != runID {
		return errors.New("private Core run handshake does not match")
	}
	if !allowUninitialized && (result.InstallationID != m.options.InstallationID || result.DatasetID == "" || result.WritingRelease == "" || result.DatasetFingerprint == "" || result.InstallationFingerprint == "") {
		return &Failure{Code: "core_establishment_unknown", Message: "Core did not provide valid installation and Dataset establishment proof"}
	}
	return nil
}
func (m *Manager) privateCall(ctx context.Context, runID string, request coremaintenance.Request) (coremaintenance.Result, error) {
	request.RunID = runID
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	result, err := coremaintenance.Call(callCtx, filepath.Join(m.coreRuntimeDir(), "maintenance.sock"), request)
	if err != nil {
		return result, err
	}
	return result, m.validateCoreResult(result, runID, request.Kind == "setup" || request.Kind == "inspect" && result.InstallationID == "")
}
func (m *Manager) awaitCore(ctx context.Context, id, runID string, allowUninitialized bool) (coremaintenance.Result, error) {
	deadlineCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, err := m.privateCall(deadlineCtx, runID, coremaintenance.Request{ActionID: uuid.NewString(), Kind: "inspect"})
		if err == nil && (allowUninitialized || result.Ready) {
			if err := m.validateCoreResult(result, runID, allowUninitialized); err != nil {
				return result, err
			}
			return result, nil
		}
		container, inspectErr := m.inspectContainer(deadlineCtx, id)
		if inspectErr != nil {
			return coremaintenance.Result{}, inspectErr
		}
		if !container.State.Running {
			return coremaintenance.Result{}, &Failure{Code: "core_start_failed", Message: "owned Core container exited before its private handshake"}
		}
		select {
		case <-deadlineCtx.Done():
			return coremaintenance.Result{}, &Failure{Code: "core_unavailable", Message: "Core private handshake did not become ready"}
		case <-ticker.C:
		}
	}
}

func (m *Manager) maintenance(ctx context.Context, kind string, installation *coremaintenance.Installation, resetID, expectedDataset string) (result coremaintenance.Result, err error) {
	m.mu.Lock()
	run := m.record.Run
	actionID := uuid.NewString()
	if m.record.Active != nil {
		actionID = m.record.Active.ID
	}
	m.mu.Unlock()
	request := coremaintenance.Request{ActionID: actionID, Kind: kind, Installation: installation, ResetID: resetID, ExpectedDatasetID: expectedDataset}
	m.mu.Lock()
	if m.record.Active != nil {
		a := m.record.Active
		request.Activity = &coremaintenance.LocalAction{ActionID: a.ID, Kind: a.Kind, ActorUID: a.Actor.UID, ActorGID: a.Actor.GID, AcceptedAt: a.AcceptedAt.Format(time.RFC3339Nano)}
	}
	m.mu.Unlock()
	if run != nil {
		if _, err := m.inspectContainer(ctx, run.ContainerID); err != nil {
			return coremaintenance.Result{}, err
		}
		return m.privateCall(ctx, run.ID, request)
	}
	runID := uuid.NewString()
	if err := m.writeCompose(ctx, runID); err != nil {
		return coremaintenance.Result{}, err
	}
	if err := m.cleanMaintenanceContainers(ctx); err != nil {
		return coremaintenance.Result{}, err
	}
	if err := os.Remove(filepath.Join(m.coreRuntimeDir(), "maintenance.sock")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return coremaintenance.Result{}, err
	}
	name := m.project() + "-maintenance-" + runID
	args := append([]string{"run", "--pull", "never", "--no-deps", "--detach", "--no-TTY", "--name", name, "core"}, m.coreArguments(runID, true)...)
	id, err := m.compose(ctx, args...)
	if err != nil {
		return coremaintenance.Result{}, err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), terminationGrace+5*time.Second)
		defer cancel()
		cleanupErr := m.stopAndRemoveHelper(cleanupCtx, id)
		err = errors.Join(err, cleanupErr)
	}()
	if _, err := m.awaitCore(ctx, id, runID, true); err != nil {
		return coremaintenance.Result{}, err
	}
	result, err = m.privateCall(ctx, runID, request)
	if err == nil && kind == "reset" && m.options.Checkpoint != nil {
		if loss := m.options.Checkpoint("reset_reply"); loss != nil {
			return coremaintenance.Result{}, &Failure{Code: "core_establishment_unknown", Message: "Reset establishment reply was not received"}
		}
	}
	return result, err
}

func (m *Manager) startCore(ctx context.Context) (coremaintenance.Result, error) {
	m.mu.Lock()
	existing := m.record.Run
	m.mu.Unlock()
	if existing != nil {
		inspection, err := m.inspectContainer(ctx, existing.ContainerID)
		if err != nil {
			return coremaintenance.Result{}, err
		}
		if inspection.State.Running {
			return m.awaitCore(ctx, existing.ContainerID, existing.ID, false)
		}
		m.mu.Lock()
		m.record.Run = nil
		err = m.saveLocked()
		m.mu.Unlock()
		if err != nil {
			return coremaintenance.Result{}, err
		}
	}
	preflight, err := m.maintenance(ctx, "open", nil, "", "")
	if err != nil {
		return preflight, err
	}
	if err := m.removeCoreContainer(ctx, true); err != nil {
		return preflight, err
	}
	runID := uuid.NewString()
	if err := m.writeCompose(ctx, runID); err != nil {
		return preflight, err
	}
	if err := os.Remove(filepath.Join(m.coreRuntimeDir(), "maintenance.sock")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return preflight, err
	}
	m.mu.Lock()
	m.record.Run = &coreRun{ID: runID, ContainerID: m.coreName(), ImageID: m.imageID}
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return preflight, err
	}
	if _, err := m.compose(ctx, "up", "--pull", "never", "--detach", "--no-deps", "--force-recreate", "core"); err != nil {
		return preflight, err
	}
	inspection, err := m.inspectContainer(ctx, m.coreName())
	if err != nil {
		return preflight, err
	}
	m.mu.Lock()
	m.record.Run = &coreRun{ID: runID, ContainerID: inspection.ID, ImageID: m.imageID}
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return preflight, err
	}
	result, err := m.awaitCore(ctx, inspection.ID, runID, false)
	if err != nil {
		return result, err
	}
	if !result.Ready {
		return result, &Failure{Code: "core_not_ready", Message: "Core opened but has not reached operational readiness"}
	}
	if m.options.Extension != nil {
		if err := m.options.Extension.StartForCore(ctx, runID); err != nil {
			return result, err
		}
	}
	if err := writeDurable(filepath.Join(m.options.Root, "core", "local-actions.jsonl"), nil, 0600); err != nil {
		return result, err
	}
	return result, nil
}
func (m *Manager) stopCore(ctx context.Context) error {
	if m.options.Extension != nil {
		if err := m.options.Extension.StopWriters(ctx); err != nil {
			return err
		}
		if err := m.options.Extension.VerifyStopped(ctx); err != nil {
			return err
		}
	}
	m.mu.Lock()
	run := m.record.Run
	m.mu.Unlock()
	if run == nil {
		return nil
	}
	ids, err := m.docker(ctx, "ps", "--all", "--quiet", "--filter", "name=^/"+m.coreName()+"$")
	if err != nil {
		return &Failure{Code: "stop_incomplete", Message: "owned Core container exit cannot be verified"}
	}
	if ids == "" {
		m.mu.Lock()
		m.record.Run = nil
		err = m.saveLocked()
		m.mu.Unlock()
		return err
	}
	inspection, err := m.inspectContainer(ctx, run.ContainerID)
	if err != nil {
		return &Failure{Code: "stop_incomplete", Message: "owned Core container exit cannot be verified"}
	}
	if inspection.State.Running {
		// A private stop drains Core writers. Docker still owns the independent
		// exit proof and enforces the finite whole-installation shutdown grace.
		request := coremaintenance.Request{ActionID: uuid.NewString(), Kind: "stop"}
		m.mu.Lock()
		if a := m.record.Active; a != nil {
			request.ActionID = a.ID
			request.Activity = &coremaintenance.LocalAction{ActionID: a.ID, Kind: a.Kind, ActorUID: a.Actor.UID, ActorGID: a.Actor.GID, AcceptedAt: a.AcceptedAt.Format(time.RFC3339Nano)}
		}
		m.mu.Unlock()
		_, privateErr := m.privateCall(ctx, run.ID, request)
		if _, err := m.docker(ctx, "stop", "--time", "10", run.ContainerID); err != nil {
			return &Failure{Code: "stop_incomplete", Message: "Docker could not confirm owned Core shutdown"}
		}
		if m.options.Checkpoint != nil {
			if err := m.options.Checkpoint("stop_exit_proof"); err != nil {
				return &Failure{Code: "stop_incomplete", Message: "owned Core exit proof was interrupted"}
			}
		}
		inspection, err = m.inspectContainer(ctx, run.ContainerID)
		if err != nil || inspection.State.Running {
			return &Failure{Code: "stop_incomplete", Message: "owned Core writer exit remains unverified"}
		}
		if privateErr != nil && ctx.Err() != nil {
			return privateErr
		}
	}
	m.mu.Lock()
	m.record.Run = nil
	err = m.saveLocked()
	m.mu.Unlock()
	return err
}

func (m *Manager) stopAndRemoveHelper(ctx context.Context, id string) error {
	container, err := m.inspectContainer(ctx, id)
	if err != nil {
		return err
	}
	if container.State.Running {
		if _, err := m.docker(ctx, "stop", "--time", "10", id); err != nil {
			return &Failure{Code: "stop_incomplete", Message: "maintenance Core exit cannot be verified"}
		}
	}
	container, err = m.inspectContainer(ctx, id)
	if err != nil || container.State.Running {
		return &Failure{Code: "stop_incomplete", Message: "maintenance Core exit cannot be verified"}
	}
	_, err = m.docker(ctx, "rm", id)
	return err
}
func (m *Manager) cleanMaintenanceContainers(ctx context.Context) error {
	output, err := m.docker(ctx, "ps", "--all", "--format", "{{.ID}} {{.Names}}", "--filter", "label=atlas.installation_id="+m.options.InstallationID)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if strings.HasPrefix(fields[1], m.project()+"-maintenance-") {
			if err := m.stopAndRemoveHelper(ctx, fields[0]); err != nil {
				return err
			}
		}
	}
	return nil
}
func (m *Manager) removeCoreContainer(ctx context.Context, preserveLogs bool) error {
	ids, err := m.docker(ctx, "ps", "--all", "--quiet", "--filter", "name=^/"+m.coreName()+"$")
	if err != nil {
		return err
	}
	if ids == "" {
		return nil
	}
	for _, id := range strings.Fields(ids) {
		inspection, err := m.inspectContainer(ctx, id)
		if err != nil {
			return err
		}
		if inspection.State.Running {
			return &Failure{Code: "stop_incomplete", Message: "owned Core writer remains running"}
		}
		if preserveLogs {
			if err := m.archiveOwnedLogs(ctx, inspection.ID); err != nil {
				return err
			}
		}
		if _, err := m.docker(ctx, "rm", id); err != nil {
			return err
		}
	}
	return nil
}

type boundedLogWriter struct {
	file      *os.File
	remaining int64
}

func (w *boundedLogWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, errors.New("owned Docker log archive exceeds its bounded rotation allowance")
	}
	n, err := w.file.Write(data)
	w.remaining -= int64(n)
	return n, err
}
func (m *Manager) archiveOwnedLogs(ctx context.Context, id string) error {
	dir := filepath.Join(m.options.Root, "logs")
	file, err := os.CreateTemp(dir, ".docker-archive-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	writer := &boundedLogWriter{file: file, remaining: 40 << 20}
	command := exec.CommandContext(ctx, m.options.Docker.Program, append(append([]string{}, m.options.Docker.Prefix...), "logs", id)...)
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 3 * time.Second
	command.Stdout = writer
	command.Stderr = writer
	err = command.Run()
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return &Failure{Code: "diagnostic_retention_incomplete", Message: "owned Docker logs could not be durably retained"}
	}
	if err := os.Rename(temp, filepath.Join(dir, "core-"+id+".log")); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func (m *Manager) perform(ctx context.Context) error {
	m.mu.Lock()
	if m.record.Active == nil {
		m.mu.Unlock()
		return nil
	}
	a := *m.record.Active
	m.mu.Unlock()
	if a.Kind != "reset" {
		if err := m.appendLocal(a); err != nil {
			return err
		}
	}
	if a.Kind == "setup" {
		if err := m.phase("setup_provisioning"); err != nil {
			return err
		}
		result, err := m.provision(ctx)
		if err != nil {
			return err
		}
		return m.finish(result)
	}
	if a.Kind == "stop" {
		if err := m.phase("stopping"); err != nil {
			return err
		}
		if err := m.stopCore(ctx); err != nil {
			return err
		}
		result, err := m.maintenance(ctx, "inspect", nil, "", "")
		if err != nil {
			return err
		}
		result.Ready = false
		return m.finish(result)
	}
	if a.Kind == "restart" {
		if err := m.phase("stopping"); err != nil {
			return err
		}
		if err := m.stopCore(ctx); err != nil {
			return err
		}
	}
	if a.Kind == "start" || a.Kind == "restart" {
		if err := m.phase("opening_retained"); err != nil {
			return err
		}
		result, err := m.startCore(ctx)
		if err != nil {
			return err
		}
		return m.finish(result)
	}
	if a.Kind != "reset" {
		return errors.New("unrecognized durable action")
	}
	if err := m.phase("reset_stopping"); err != nil {
		return err
	}
	if err := m.stopCore(ctx); err != nil {
		return err
	}
	proof, err := m.maintenance(ctx, "inspect", nil, "", "")
	if err != nil {
		return &Failure{Code: "core_establishment_unknown", Message: "Reset establishment cannot be inspected; cleanup and fresh opening remain blocked"}
	}
	if err := m.validateCoreResult(proof, proof.RunID, false); err != nil {
		return err
	}
	if proof.LastEstablishedResetID != a.ResetID {
		m.mu.Lock()
		expected := m.record.Active.ExpectedDatasetID
		err := m.saveLocked()
		m.mu.Unlock()
		if err != nil {
			return err
		}
		if expected != proof.DatasetID {
			return &Failure{Code: "reset_authority_conflict", Message: "pending Reset targets a Dataset which Core no longer confirms"}
		}
		if err := m.phase("reset_cleaning"); err != nil {
			return err
		}
		if err := m.clearOwnedOperational(ctx); err != nil {
			return err
		}
		if err := m.phase("reset_establishing"); err != nil {
			return err
		}
		proof, err = m.maintenance(ctx, "reset", nil, a.ResetID, expected)
		if err != nil {
			return err
		}
		if proof.LastEstablishedResetID != a.ResetID {
			return &Failure{Code: "core_establishment_unknown", Message: "Core did not confirm this Reset identity"}
		}
	}
	if err := m.phase("reset_established"); err != nil {
		return err
	}
	if err := m.appendLocal(a); err != nil {
		return err
	}
	result, err := m.startCore(ctx)
	if err != nil {
		return err
	}
	if err := m.phase("reset_ready"); err != nil {
		return err
	}
	return m.finish(result)
}
func (m *Manager) clearOwnedOperational(ctx context.Context) error {
	if m.options.Extension != nil {
		if err := m.options.Extension.VerifyStopped(ctx); err != nil {
			return err
		}
		if err := m.options.Extension.ClearOperational(ctx); err != nil {
			return err
		}
	}
	if err := m.removeCoreContainer(ctx, false); err != nil {
		return err
	}
	for _, path := range []string{filepath.Join(m.options.Root, "logs"), filepath.Join(m.options.Root, "core", "local-actions.jsonl")} {
		if !within(path, m.options.Root) {
			return errors.New("cleanup target escapes installation ownership")
		}
		if err := rejectSymlinkAncestors(path); err != nil {
			return err
		}
		if err := filepath.WalkDir(path, func(current string, entry os.DirEntry, walkErr error) error {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return errors.New("cleanup target contains a symlink")
			}
			return nil
		}); err != nil {
			return err
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
		if filepath.Base(path) == "logs" {
			if err := os.Mkdir(path, 0700); err != nil {
				return err
			}
		}
		parent, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		if err := errors.Join(parent.Sync(), parent.Close()); err != nil {
			return err
		}
	}
	return nil
}
