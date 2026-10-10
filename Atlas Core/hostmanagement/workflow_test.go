//go:build atlas_host_integration

package hostmanagement_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/hostmanagement"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

var hostImage = flag.String("atlas-host-image", "atlas-core:s1", "loaded production Core image for real host integration")
var hostDocker = flag.String("atlas-host-docker", "docker", "actual Docker executable")
var hostSudoDocker = flag.Bool("atlas-host-sudo-docker", false, "invoke actual Docker using sudo -n")
var hostOwnershipManifest = flag.String("atlas-host-ownership-manifest", "", "required surviving owner's private Docker ownership journal")
var hostFixtureRoot = flag.String("atlas-host-fixture-root", "", "required surviving owner's fixture root retained until Docker cleanup")
var hostReadinessBarrier = flag.String("atlas-host-readiness-barrier", "", "optional surviving owner's durable readiness marker before private worker-death probe")
var s1Driver = flag.String("atlas-s1-driver", "", "required SDK/direct Protocol workflow TypeScript entry point")
var s1CLI = flag.String("atlas-s1-cli", "", "required built atlas local CLI for SDK/direct workflow")

type hostFixture struct {
	t           *testing.T
	options     hostmanagement.Options
	manager     *hostmanagement.Manager
	client      *hostmanagement.Client
	cancel      context.CancelFunc
	serviceDone chan error
	key         string
	transport   *http.Transport
	dataset     string
	fault       atomic.Pointer[string]
	blockProof  atomic.Bool
}

func newHostFixture(t *testing.T) *hostFixture {
	if !filepath.IsAbs(*hostOwnershipManifest) || !filepath.IsAbs(*hostFixtureRoot) {
		t.Fatal("host qualification requires absolute ownership-manifest and fixture-root paths from its surviving owner")
	}
	base, err := os.MkdirTemp(*hostFixtureRoot, "atlas-host-")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	docker := hostmanagement.Command{Program: *hostDocker}
	if *hostSudoDocker {
		docker = hostmanagement.Command{Program: "sudo", Prefix: []string{"-n", *hostDocker}}
	}
	f := &hostFixture{t: t, options: hostmanagement.Options{InstallationID: uuid.NewString(), Root: filepath.Join(base, "installation"), RecoveryRoot: filepath.Join(base, "recovery"), RuntimeRoot: filepath.Join(base, "runtime"), Image: *hostImage, BindAddress: "127.0.0.1", Port: port, OwnerUID: os.Getuid(), Docker: docker}}
	// The outer verifier retains mount directories and this synced authority
	// after worker death, until its installation-scoped Docker cleanup succeeds.
	retainFixtureOwnership(t, f.options.InstallationID)
	f.options.Checkpoint = func(phase string) error {
		if phase == "reset_stopping" && f.blockProof.CompareAndSwap(true, false) {
			return os.Chmod(filepath.Join(f.options.RuntimeRoot, "core"), 0500)
		}
		expected := f.fault.Load()
		if expected != nil && *expected == phase && f.fault.CompareAndSwap(expected, nil) {
			return errors.New("scheduled manager interruption")
		}
		return nil
	}
	f.launch()
	t.Cleanup(func() {
		f.shutdown()
		if f.transport != nil {
			f.transport.CloseIdleConnections()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		output, err := f.docker(ctx, "ps", "--all", "--quiet", "--filter", "label=atlas.installation_id="+f.options.InstallationID)
		if err != nil {
			t.Error(err)
			return
		}
		for _, id := range strings.Fields(output) {
			if _, err := f.docker(ctx, "rm", "--force", id); err != nil {
				t.Error(err)
			}
		}
		networks, err := f.docker(ctx, "network", "ls", "--quiet", "--filter", "label=atlas.installation_id="+f.options.InstallationID)
		if err != nil {
			t.Error(err)
			return
		}
		for _, id := range strings.Fields(networks) {
			if _, err := f.docker(ctx, "network", "rm", id); err != nil {
				t.Error(err)
			}
		}
	})
	prepared, err := hostmanagement.PrepareSetup(filepath.Join(base, "operator"), []string{"127.0.0.1", "atlas.local"})
	if err != nil {
		t.Fatal(err)
	}
	f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "setup", Setup: &prepared})
	key, err := os.ReadFile(filepath.Join(base, "operator", "admin.key"))
	if err != nil {
		t.Fatal(err)
	}
	f.key = string(key)
	trust, err := f.client.ExportCA(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(trust.Certificate) {
		t.Fatal("exported CA is invalid")
	}
	f.transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	started := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "start"})
	if !started.Ready {
		t.Fatal("Start did not establish readiness")
	}
	f.dataset = started.DatasetID
	if *hostReadinessBarrier != "" {
		retainReadinessBarrier(t, f.options.InstallationID, f.dataset)
		select {} // The surviving owner schedules death only after real readiness.
	}
	return f
}

func retainReadinessBarrier(t *testing.T, installationID, datasetID string) {
	t.Helper()
	if !filepath.IsAbs(*hostReadinessBarrier) {
		t.Fatal("readiness barrier must be an absolute owner path")
	}
	encoded, err := json.Marshal(struct {
		WorkerPID      int    `json:"worker_pid"`
		InstallationID string `json:"installation_id"`
		DatasetID      string `json:"dataset_id"`
	}{os.Getpid(), installationID, datasetID})
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.CreateTemp(filepath.Dir(*hostReadinessBarrier), ".atlas-ready-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file.Name(), *hostReadinessBarrier); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Open(filepath.Dir(*hostReadinessBarrier))
	if err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(directory.Sync(), directory.Close()); err != nil {
		t.Fatal(err)
	}
}

func retainFixtureOwnership(t *testing.T, installationID string) {
	t.Helper()
	fd, err := unix.Open(*hostOwnershipManifest, unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(fd), *hostOwnershipManifest)
	defer file.Close()
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ok || int(owner.Uid) != os.Getuid() {
		t.Fatal("Docker ownership manifest must be an owner-only regular file")
	}
	encoded, err := json.Marshal(struct {
		InstallationID string `json:"installation_id"`
	}{installationID})
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if info.Size()+int64(len(encoded)) > 1024*1024 {
		t.Fatal("Docker ownership manifest exceeds its bound")
	}
	if _, err := file.Write(encoded); err != nil {
		t.Fatal(err)
	}
	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Open(filepath.Dir(*hostOwnershipManifest))
	if err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(directory.Sync(), directory.Close()); err != nil {
		t.Fatal(err)
	}
}
func (f *hostFixture) launch() {
	f.t.Helper()
	manager, err := hostmanagement.New(f.options)
	if err != nil {
		f.t.Fatal(err)
	}
	f.manager = manager
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	f.serviceDone = make(chan error, 1)
	go func() { f.serviceDone <- manager.Serve(ctx) }()
	f.client = hostmanagement.NewClient(filepath.Join(f.options.RuntimeRoot, "manager.sock"))
	deadline := time.Now().Add(10 * time.Second)
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := f.client.Inspect(context.Background(), ""); err == nil {
			return
		}
		select {
		case err := <-f.serviceDone:
			f.t.Fatalf("manager service exited: %v", err)
		case <-ticker.C:
			if time.Now().After(deadline) {
				f.t.Fatal("manager Unix channel did not open")
			}
		}
	}
}
func (f *hostFixture) shutdown() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	select {
	case err := <-f.serviceDone:
		if err != nil {
			f.t.Error(err)
		}
	case <-time.After(30 * time.Second):
		f.t.Error("manager service shutdown exceeded bound")
	}
	if err := f.manager.Close(); err != nil {
		f.t.Error(err)
	}
	f.cancel = nil
}
func (f *hostFixture) action(request hostmanagement.Request) hostmanagement.Result {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := f.client.Submit(ctx, request)
	if err != nil {
		f.t.Fatal(err)
	}
	if result.Status == "running" {
		result, err = f.client.Wait(ctx, result.ActionID)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	if result.Status != "completed" {
		f.t.Fatalf("%s did not complete: %+v", request.Kind, result)
	}
	return result
}
func (f *hostFixture) incomplete(request hostmanagement.Request, phase string) hostmanagement.Result {
	f.t.Helper()
	f.fault.Store(&phase)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := f.client.Submit(ctx, request)
	if err != nil {
		f.t.Fatal(err)
	}
	result, err = f.client.Wait(ctx, result.ActionID)
	if err != nil {
		f.t.Fatal(err)
	}
	if result.Status != "incomplete" {
		f.t.Fatalf("scheduled interruption did not remain pending: %+v", result)
	}
	return result
}
func (f *hostFixture) revision() *uint64 {
	f.t.Helper()
	result, err := f.client.Inspect(context.Background(), "")
	if err != nil {
		f.t.Fatal(err)
	}
	return &result.ResetRevision
}
func (f *hostFixture) url(path string) string {
	return "https://" + net.JoinHostPort("127.0.0.1", fmt.Sprint(f.options.Port)) + path
}
func (f *hostFixture) request(method, path, secret, dataset string, body any) (int, map[string]json.RawMessage) {
	f.t.Helper()
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		input = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, f.url(path), input)
	if err != nil {
		f.t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Atlas-Protocol-Version", "0.1.0")
	if dataset != "" {
		request.Header.Set("Atlas-Dataset-ID", dataset)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Transport: f.transport, Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		f.t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if len(data) != 0 {
		if err := json.Unmarshal(data, &result); err != nil {
			f.t.Fatalf("response was not JSON status=%d", response.StatusCode)
		}
	}
	return response.StatusCode, result
}
func (f *hostFixture) healthDataset() string {
	f.t.Helper()
	status, reply := f.request("GET", "/health", f.key, "", nil)
	if status != 200 {
		f.t.Fatalf("authenticated health failed: %d", status)
	}
	var dataset string
	if err := json.Unmarshal(reply["dataset_id"], &dataset); err != nil {
		f.t.Fatal(err)
	}
	return dataset
}
func (f *hostFixture) docker(ctx context.Context, args ...string) (string, error) {
	command := exec.CommandContext(ctx, f.options.Docker.Program, append(append([]string{}, f.options.Docker.Prefix...), args...)...)
	output, err := command.Output()
	return string(output), err
}
func (f *hostFixture) grant(assetID uuid.UUID) (protocol.EnrollmentGrant, string) {
	f.t.Helper()
	secretBytes := make([]byte, 32)
	rand.Read(secretBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	digest := sha256.Sum256([]byte(secret))
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.t.Fatal(err)
	}
	grant := protocol.EnrollmentGrant{AuthorizationId: uuid.New(), InstallationId: uuid.MustParse(f.options.InstallationID), AssetId: assetID, CredentialId: uuid.New(), CredentialVerifier: base64.RawURLEncoding.EncodeToString(digest[:]), RecoveryPublicKey: base64.RawURLEncoding.EncodeToString(public)}
	signed, err := f.client.Enroll(context.Background(), grant)
	if err != nil {
		f.t.Fatal(err)
	}
	return signed, secret
}

func TestRealLifecyclePreservesSetupAndCompletedResetHasNoEffects(t *testing.T) {
	f := newHostFixture(t)
	if got := f.healthDataset(); got != f.dataset {
		t.Fatal("health and manager disagree on Dataset")
	}
	trust, err := f.client.ExportCA(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"stop", "start", "restart"} {
		result := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: action})
		if result.DatasetID != f.dataset {
			t.Fatalf("%s changed retained Dataset", action)
		}
	}
	id := uuid.NewString()
	reset := f.action(hostmanagement.Request{ActionID: id, Kind: "reset", ExpectedResetRevision: f.revision()})
	if reset.DatasetID == f.dataset {
		t.Fatal("Reset retained old Dataset")
	}
	for _, action := range []string{"stop", "start", "restart"} {
		f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: action})
	}
	replayed := f.action(hostmanagement.Request{ActionID: id, Kind: "retry"})
	if replayed.DatasetID != reset.DatasetID || f.healthDataset() != reset.DatasetID {
		t.Fatal("completed Reset retry had effects")
	}
	bad := uint64(999)
	if _, err := f.client.Submit(context.Background(), hostmanagement.Request{ActionID: uuid.NewString(), Kind: "reset", ExpectedResetRevision: &bad}); err == nil {
		t.Fatal("unreviewed Reset accepted")
	}
	if f.action(hostmanagement.Request{ActionID: id, Kind: "retry"}).DatasetID != reset.DatasetID {
		t.Fatal("refused Reset expired the prior completed result")
	}
	second := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "reset", ExpectedResetRevision: f.revision()})
	expired, err := f.client.Submit(context.Background(), hostmanagement.Request{ActionID: id, Kind: "retry"})
	if err != nil {
		t.Fatal(err)
	}
	if expired.Status != "action_result_expired" || f.healthDataset() != second.DatasetID {
		t.Fatal("expired retry changed Dataset")
	}
	retained, err := f.client.ExportCA(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(retained.Certificate, trust.Certificate) || retained.Fingerprint != trust.Fingerprint {
		t.Fatal("Reset changed retained trust")
	}
	wrong := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool()}}
	defer wrong.CloseIdleConnections()
	if _, err := (&http.Client{Transport: wrong, Timeout: 5 * time.Second}).Get(f.url("/health")); err == nil {
		t.Fatal("real HTTPS accepted wrong CA")
	}
	wrongName := f.transport.Clone()
	wrongName.TLSClientConfig = wrongName.TLSClientConfig.Clone()
	wrongName.TLSClientConfig.ServerName = "wrong.invalid"
	defer wrongName.CloseIdleConnections()
	if _, err := (&http.Client{Transport: wrongName, Timeout: 5 * time.Second}).Get(f.url("/health")); err == nil {
		t.Fatal("real HTTPS accepted wrong hostname")
	}
}

func TestInterruptedEstablishedResetPreservesNewDatasetWorkAndLogs(t *testing.T) {
	f := newHostFixture(t)
	assetID := uuid.New()
	grant, credential := f.grant(assetID)
	id := uuid.NewString()
	f.incomplete(hostmanagement.Request{ActionID: id, Kind: "reset", ExpectedResetRevision: f.revision()}, "reset_ready")
	newDataset := f.healthDataset()
	if newDataset == f.dataset {
		t.Fatal("replacement Dataset not established")
	}
	status, _ := f.request("POST", "/entities", credential, newDataset, map[string]any{"id": assetID, "type": "asset", "registration_id": uuid.New(), "enrollment": grant})
	if status != 201 {
		t.Fatalf("new Dataset work rejected: %d", status)
	}
	logPath := filepath.Join(f.options.Root, "logs", "post-establishment.log")
	if err := os.WriteFile(logPath, []byte("post-establishment evidence\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.shutdown()
	f.launch()
	result, err := f.client.Wait(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || result.DatasetID != newDataset {
		t.Fatalf("established Reset did not recover retained: %+v", result)
	}
	status, _ = f.request("GET", "/entities/"+assetID.String(), f.key, newDataset, nil)
	if status != 200 {
		t.Fatal("recovery erased newly created Entity")
	}
	logs, err := os.ReadFile(logPath)
	if err != nil || string(logs) != "post-establishment evidence\n" {
		t.Fatal("recovery cleared post-establishment logs")
	}
}

func TestInterruptedResetResumesBeforeServingAndLostEstablishmentReplyIsSafe(t *testing.T) {
	f := newHostFixture(t)
	for _, phase := range []string{"reset_cleaning", "reset_establishing", "reset_reply"} {
		logPath := filepath.Join(f.options.Root, "logs", "old.log")
		if err := os.WriteFile(logPath, []byte("old Dataset diagnostic"), 0600); err != nil {
			t.Fatal(err)
		}
		id := uuid.NewString()
		pending := f.incomplete(hostmanagement.Request{ActionID: id, Kind: "reset", ExpectedResetRevision: f.revision()}, phase)
		if phase == "reset_reply" && (pending.Failure == nil || pending.Failure.Code != "core_establishment_unknown") {
			t.Fatal("lost reply did not preserve unknown establishment")
		}
		completed := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "start"})
		if completed.ActionID != id || completed.DatasetID == f.dataset {
			t.Fatal("Start did not resume the pending Reset")
		}
		if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("old log survived Reset cleanup")
		}
		f.dataset = completed.DatasetID
	}
}

func TestInterruptedStopRetainsExitUncertaintyUntilVerified(t *testing.T) {
	f := newHostFixture(t)
	actionID := uuid.NewString()
	result := f.incomplete(hostmanagement.Request{ActionID: actionID, Kind: "stop"}, "stop_exit_proof")
	if result.Status != "incomplete" || result.Failure == nil || result.Failure.Code != "stop_incomplete" {
		t.Fatalf("unconfirmed exit was claimed complete: %+v", result)
	}
	completed := f.action(hostmanagement.Request{ActionID: actionID, Kind: "retry"})
	if completed.Ready {
		t.Fatal("Stop completion claims operational readiness")
	}
	started := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "start"})
	if started.DatasetID != f.dataset {
		t.Fatal("recovering incomplete Stop lost Dataset")
	}
}

func TestPrivateManagementRejectsRootAndStaleCoreRun(t *testing.T) {
	f := newHostFixture(t)
	// Root can traverse the owner-only socket path. Peer authorization still
	// refuses it because root is not this installation's configured owner.
	program := "import socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])\ntry:\n s.sendall(b'GET /status HTTP/1.1\\r\\nHost: manager\\r\\nConnection: close\\r\\n\\r\\n'); data=s.recv(65536)\nexcept (ConnectionResetError,BrokenPipeError):\n data=b''\ns.close()\nsys.exit(0 if data==b'' else 1)\n"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "sudo", "-n", "python3", "-c", program, filepath.Join(f.options.RuntimeRoot, "manager.sock"))
	if err := command.Run(); err != nil {
		t.Fatalf("private peer gate allowed root or the credential probe failed: %v", err)
	}
	_, err := coremaintenance.Call(ctx, filepath.Join(f.options.RuntimeRoot, "core", "maintenance.sock"), coremaintenance.Request{ActionID: uuid.NewString(), RunID: uuid.NewString(), Kind: "stop"})
	var failure *coremaintenance.Error
	if !errors.As(err, &failure) || failure.Code != "stale_run" {
		t.Fatalf("stale private Core run was not rejected: %v", err)
	}
	if f.healthDataset() != f.dataset {
		t.Fatal("stale control altered operational state")
	}
}

func TestUnavailableEstablishmentProofPreservesOldWorkUntilPrivateInspectionRecovers(t *testing.T) {
	f := newHostFixture(t)
	logPath := filepath.Join(f.options.Root, "logs", "old.log")
	if err := os.WriteFile(logPath, []byte("retained before private proof\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.blockProof.Store(true)
	id := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	accepted, err := f.client.Submit(ctx, hostmanagement.Request{ActionID: id, Kind: "reset", ExpectedResetRevision: f.revision()})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := f.client.Wait(ctx, accepted.ActionID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Status != "incomplete" || pending.Failure == nil || pending.Failure.Code != "core_establishment_unknown" {
		t.Fatalf("unavailable private proof was not preserved: %+v", pending)
	}
	data, err := os.ReadFile(logPath)
	if err != nil || string(data) != "retained before private proof\n" {
		t.Fatal("unknown establishment authorized destructive cleanup")
	}
	if err := os.Chmod(filepath.Join(f.options.RuntimeRoot, "core"), 0700); err != nil {
		t.Fatal(err)
	}
	completed := f.action(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "start"})
	if completed.ActionID != id || completed.DatasetID == f.dataset {
		t.Fatal("restored private inspection did not safely resume Reset")
	}
}

func TestUnreadablePendingRecoveryAuthorityBlocksManagerStartupWithoutClearingWork(t *testing.T) {
	f := newHostFixture(t)
	logPath := filepath.Join(f.options.Root, "logs", "old.log")
	if err := os.WriteFile(logPath, []byte("old work remains\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.incomplete(hostmanagement.Request{ActionID: uuid.NewString(), Kind: "reset", ExpectedResetRevision: f.revision()}, "reset_cleaning")
	f.shutdown()
	path := filepath.Join(f.options.RecoveryRoot, "state.json")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(original, &record); err != nil {
		t.Fatal(err)
	}
	var active map[string]json.RawMessage
	if err := json.Unmarshal(record["active"], &active); err != nil {
		t.Fatal(err)
	}
	active["expected_dataset_id"] = json.RawMessage(`""`)
	record["active"], err = json.Marshal(active)
	if err != nil {
		t.Fatal(err)
	}
	incomplete, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, damaged := range [][]byte{[]byte("unreadable external authority"), incomplete} {
		if err := os.WriteFile(path, damaged, 0600); err != nil {
			t.Fatal(err)
		}
		manager, err := hostmanagement.New(f.options)
		if manager != nil {
			manager.Close()
			t.Fatal("damaged pending record did not refuse startup")
		}
		var failure *hostmanagement.Failure
		if !errors.As(err, &failure) || failure.Code != "management_record_invalid" {
			t.Fatalf("wrong record refusal: %v", err)
		}
		data, err := os.ReadFile(logPath)
		if err != nil || string(data) != "old work remains\n" {
			t.Fatal("startup refusal cleared work")
		}
	}
	// Restore the exact authority only for fixture cleanup. This does not claim
	// to implement the later local repair workflow.
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestPublicSDKAndDirectProtocol(t *testing.T) {
	if *s1Driver == "" || *s1CLI == "" {
		t.Fatal("full host qualification requires -atlas-s1-driver and -atlas-s1-cli")
	}
	f := newHostFixture(t)
	base := filepath.Dir(f.options.Root)
	trust, err := f.client.ExportCA(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	caPath := filepath.Join(base, "operator", "driver-ca.crt")
	if err := os.WriteFile(caPath, trust.Certificate, 0600); err != nil {
		t.Fatal(err)
	}
	stateDirectory := filepath.Join(base, "asset-retention")
	if err := os.Mkdir(stateDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	config := struct {
		BaseURL        string `json:"baseUrl"`
		CAPath         string `json:"caPath"`
		AdminKeyPath   string `json:"adminKeyPath"`
		InstallationID string `json:"installationId"`
		ManagerSocket  string `json:"managerSocket"`
		AtlasCLI       string `json:"atlasCli"`
		StateDirectory string `json:"stateDirectory"`
	}{f.url(""), caPath, filepath.Join(base, "operator", "admin.key"), f.options.InstallationID, filepath.Join(f.options.RuntimeRoot, "manager.sock"), *s1CLI, stateDirectory}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(base, "driver.json")
	if err := os.WriteFile(configPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	repoRoot := filepath.Dir(filepath.Dir(filepath.Dir(*s1Driver)))
	loader := filepath.Join(repoRoot, "Atlas SDK", "node_modules", "tsx", "dist", "loader.mjs")
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--import", loader, *s1Driver, "--config", configPath)
	command.Dir = repoRoot
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return unix.Kill(-command.Process.Pid, unix.SIGTERM) }
	command.WaitDelay = 5 * time.Second
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("SDK/direct Protocol workflow failed: %v\n%s", err, output.String())
	}
	t.Log(output.String())
}
