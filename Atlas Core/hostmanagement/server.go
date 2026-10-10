package hostmanagement

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

const managerMessageBound = 65536

type peerContextKey struct{}
type authenticatedListener struct {
	net.Listener
	ownerUID int
	groupGID *int
}

func (l *authenticatedListener) Accept() (net.Conn, error) {
	for {
		connection, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		socket, ok := connection.(*net.UnixConn)
		if !ok {
			connection.Close()
			continue
		}
		raw, err := socket.SyscallConn()
		if err != nil {
			connection.Close()
			continue
		}
		var credential *unix.Ucred
		var controlErr error
		err = raw.Control(func(fd uintptr) {
			credential, controlErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		})
		if err != nil || controlErr != nil || credential == nil {
			connection.Close()
			continue
		}
		if int(credential.Uid) != l.ownerUID && (l.groupGID == nil || int(credential.Gid) != *l.groupGID) {
			connection.Close()
			continue
		}
		return &peerConnection{Conn: connection, actor: Actor{UID: credential.Uid, GID: credential.Gid}}, nil
	}
}

type peerConnection struct {
	net.Conn
	actor Actor
}

// Serve is the installation service. It survives disconnected callers, resumes
// pending actions and never automatically starts Core after a process loss.
func (m *Manager) Serve(ctx context.Context) error {
	socketPath := filepath.Join(m.options.RuntimeRoot, "manager.sock")
	if info, err := os.Lstat(socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("manager socket path is occupied by another resource")
		}
		if err := os.Remove(socketPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	defer os.Remove(socketPath)
	mode := os.FileMode(0600)
	if m.options.ManagementGID != nil {
		mode = 0660
		if err := os.Chown(m.options.RuntimeRoot, m.options.OwnerUID, *m.options.ManagementGID); err != nil {
			listener.Close()
			return err
		}
		if err := os.Chmod(m.options.RuntimeRoot, 0710); err != nil {
			listener.Close()
			return err
		}
		if err := os.Chown(socketPath, m.options.OwnerUID, *m.options.ManagementGID); err != nil {
			listener.Close()
			return err
		}
	}
	if err := os.Chmod(socketPath, mode); err != nil {
		listener.Close()
		return err
	}
	server := &http.Server{Handler: m.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192, ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
		return context.WithValue(ctx, peerContextKey{}, conn.(*peerConnection).actor)
	}}
	serviceCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var joined sync.WaitGroup
	joined.Add(1)
	serverResult := make(chan error, 1)
	go func() {
		defer joined.Done()
		serverResult <- server.Serve(&authenticatedListener{Listener: listener, ownerUID: m.options.OwnerUID, groupGID: m.options.ManagementGID})
	}()
	events := make(chan string, 4)
	eventFailure := make(chan error, 1)
	joined.Add(1)
	go func() { defer joined.Done(); eventFailure <- m.watchDocker(serviceCtx, events) }()
	m.Resume()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	misses := 0
	var serviceErr error
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case err := <-serverResult:
			if !errors.Is(err, http.ErrServerClosed) {
				serviceErr = err
			}
			break loop
		case err := <-eventFailure:
			serviceErr = err
			break loop
		case id := <-events:
			if err := m.supervise(serviceCtx, id, &misses); err != nil {
				serviceErr = err
				break loop
			}
		case <-ticker.C:
			if err := m.supervise(serviceCtx, "", &misses); err != nil {
				serviceErr = err
				break loop
			}
		}
	}
	cancel()
	m.cancel()
	m.work.Wait()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	shutdownErr := server.Shutdown(shutdownCtx)
	stopErr := m.stopCore(shutdownCtx)
	listener.Close()
	joined.Wait()
	// Caller cancellation may win the select while an already-failed event
	// reader is reaping its child. Preserve that failure after joining it.
	select {
	case err := <-eventFailure:
		serviceErr = errors.Join(serviceErr, err)
	default:
	}
	return errors.Join(serviceErr, shutdownErr, stopErr)
}
func (m *Manager) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(writer http.ResponseWriter, request *http.Request) {
		writeReply(writer, m.Inspect(request.URL.Query().Get("action_id")), nil)
	})
	mux.HandleFunc("POST /actions", func(writer http.ResponseWriter, request *http.Request) {
		var action Request
		if err := readRequest(writer, request, &action); err != nil {
			writeReply(writer, nil, err)
			return
		}
		actor := request.Context().Value(peerContextKey{}).(Actor)
		result, err := m.Submit(action, actor)
		writeReply(writer, result, err)
	})
	mux.HandleFunc("GET /ca", func(writer http.ResponseWriter, request *http.Request) {
		certificate, err := os.ReadFile(filepath.Join(m.options.Root, "setup", "ca.crt"))
		saved, setupErr := m.loadSetup()
		writeReply(writer, CAExport{Certificate: certificate, Fingerprint: saved.CAFingerprint}, errors.Join(err, setupErr))
	})
	mux.HandleFunc("POST /enrollment", func(writer http.ResponseWriter, request *http.Request) {
		var grant protocol.EnrollmentGrant
		if err := readRequest(writer, request, &grant); err != nil {
			writeReply(writer, nil, err)
			return
		}
		signed, err := m.SignEnrollment(grant)
		writeReply(writer, signed, err)
	})
	return mux
}

type CAExport struct {
	Certificate []byte `json:"certificate"`
	Fingerprint string `json:"fingerprint"`
}

func readRequest(writer http.ResponseWriter, request *http.Request, dest any) error {
	if request.Header.Get("Content-Type") != "application/json" {
		return &Failure{Code: "invalid_request", Message: "local request must be JSON"}
	}
	data, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, managerMessageBound))
	if err != nil {
		return &Failure{Code: "invalid_request", Message: "local request exceeds its bound"}
	}
	if err := decodeStrict(data, dest); err != nil {
		return &Failure{Code: "invalid_request", Message: "local request JSON is invalid"}
	}
	return nil
}
func writeReply(writer http.ResponseWriter, result any, err error) {
	writer.Header().Set("Content-Type", "application/json")
	if err != nil {
		writer.WriteHeader(http.StatusConflict)
		json.NewEncoder(writer).Encode(safeFailure(err))
		return
	}
	json.NewEncoder(writer).Encode(result)
}

func (m *Manager) SignEnrollment(grant protocol.EnrollmentGrant) (protocol.EnrollmentGrant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record.Active != nil {
		return grant, &Failure{Code: "management_busy", Message: "local lifecycle work is pending"}
	}
	saved, err := m.loadSetup()
	if err != nil {
		return grant, err
	}
	if grant.InstallationId.String() != saved.Installation.InstallationID {
		return grant, &Failure{Code: "enrollment_installation_mismatch", Message: "grant targets a different installation"}
	}
	verifier, err := base64.RawURLEncoding.DecodeString(grant.CredentialVerifier)
	if err != nil || len(verifier) != 32 {
		return grant, &Failure{Code: "invalid_enrollment", Message: "credential verifier must be an unpadded SHA256 digest"}
	}
	recovery, err := base64.RawURLEncoding.DecodeString(grant.RecoveryPublicKey)
	if err != nil || len(recovery) != ed25519.PublicKeySize {
		return grant, &Failure{Code: "invalid_enrollment", Message: "recovery public key must be Ed25519"}
	}
	data, err := os.ReadFile(filepath.Join(m.options.Root, "setup", "enrollment.key"))
	if err != nil {
		return grant, err
	}
	key, err := base64.RawURLEncoding.DecodeString(string(data))
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return grant, errors.New("retained enrollment authority is invalid")
	}
	return identity.SignEnrollmentGrant(grant, ed25519.PrivateKey(key))
}

func (m *Manager) watchDocker(ctx context.Context, events chan<- string) error {
	watchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	args := append(append([]string{}, m.options.Docker.Prefix...), "events", "--filter", "type=container", "--filter", "label=atlas.installation_id="+m.options.InstallationID, "--filter", "event=die", "--filter", "event=stop", "--format", "{{.Actor.ID}}")
	command := exec.CommandContext(watchCtx, m.options.Docker.Program, args...)
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 3 * time.Second
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024), 8192)
	for scanner.Scan() {
		select {
		case events <- scanner.Text():
		case <-ctx.Done():
		}
	}
	scanErr := scanner.Err()
	// Parsing can fail while Docker's events process remains alive. The watcher
	// owns stopping and reaping that process before it reports its failure.
	cancel()
	err = errors.Join(scanErr, command.Wait())
	if scanErr == nil && ctx.Err() != nil {
		return nil
	}
	if err == nil {
		err = errors.New("Docker event stream ended")
	}
	return &Failure{Code: "docker_event_stream_unavailable", Message: "owned container event supervision ended"}
}
func (m *Manager) supervise(ctx context.Context, eventContainer string, misses *int) error {
	m.mu.Lock()
	run := m.record.Run
	busy := m.working || m.preparing
	m.mu.Unlock()
	if run == nil || busy {
		*misses = 0
		return nil
	}
	if m.imageID == "" {
		m.imageID = run.ImageID
	}
	inspection, err := m.inspectContainer(ctx, run.ContainerID)
	lost := err == nil && !inspection.State.Running || eventContainer == run.ContainerID
	if !lost {
		_, err = m.privateCall(ctx, run.ID, coremaintenance.Request{ActionID: uuid.NewString(), Kind: "inspect"})
		if err == nil {
			*misses = 0
			return nil
		}
		*misses++
		if *misses < 3 {
			return nil
		}
	}
	if m.options.Extension != nil {
		if err := m.options.Extension.CoreLost(ctx, run.ID); err != nil {
			return err
		}
	}
	return m.stopCore(ctx)
}

// Client is the only CLI transport. It carries no public API credential and
// does not run lifecycle work in the caller process.
type Client struct{ socket string }

func NewClient(socket string) *Client { return &Client{socket: socket} }
func (c *Client) call(ctx context.Context, method, path string, input, result any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.socket)
	}}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, method, "http://manager"+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Transport: transport, Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return &Failure{Code: "manager_unavailable", Message: "local management channel is unavailable"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, managerMessageBound+1))
	if err != nil || len(data) > managerMessageBound {
		return errors.New("manager response is invalid or over limit")
	}
	if response.StatusCode != http.StatusOK {
		var failure Failure
		if err := decodeStrict(data, &failure); err != nil {
			return errors.New("manager failure response is invalid")
		}
		return &failure
	}
	return decodeStrict(data, result)
}
func (c *Client) Submit(ctx context.Context, request Request) (Result, error) {
	var result Result
	err := c.call(ctx, "POST", "/actions", request, &result)
	return result, err
}
func (c *Client) Inspect(ctx context.Context, actionID string) (Result, error) {
	var result Result
	err := c.call(ctx, "GET", "/status?action_id="+actionID, nil, &result)
	return result, err
}
func (c *Client) ExportCA(ctx context.Context) (CAExport, error) {
	var result CAExport
	err := c.call(ctx, "GET", "/ca", nil, &result)
	return result, err
}
func (c *Client) Enroll(ctx context.Context, grant protocol.EnrollmentGrant) (protocol.EnrollmentGrant, error) {
	var result protocol.EnrollmentGrant
	err := c.call(ctx, "POST", "/enrollment", grant, &result)
	return result, err
}
func (c *Client) Wait(ctx context.Context, actionID string) (Result, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, err := c.Inspect(ctx, actionID)
		if err != nil {
			return result, err
		}
		if result.Status != "running" {
			return result, nil
		}
		select {
		case <-ctx.Done():
			return result, &Failure{Code: "outcome_unknown", Message: "local wait ended; inspect or retry the same action identity"}
		case <-ticker.C:
		}
	}
}
