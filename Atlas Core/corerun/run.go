package corerun

import (
	"bufio"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/api"
	"github.com/atlas-field-systems/atlas-core/coreconfig"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

// Layout of Core's mounts inside its container. Host paths may differ.
const (
	DatabaseFile     = "core/core.sqlite"
	InstallationFile = "setup/installation.json"
	SettingsFile     = "setup/config.json"
	CertificateFile  = "setup/tls/server.crt"
	KeyFile          = "setup/tls/server.key"
	JournalDirectory = "journal"
	SocketFile       = "run/core.sock"
	LogDirectory     = "logs"
)

// InstallationRecord is the nonsecret installation identity file written by
// local setup and mounted read-only into Core.
type InstallationRecord struct {
	Format         int    `json:"format"`
	InstallationID string `json:"installation_id"`
}

// Options configure one Core process.
type Options struct {
	Root       string
	Listen     string
	Release    string
	TestFaults bool
}

// Run is one Core process lifetime.
type Run struct {
	options        Options
	id             string
	installationID string
	faults         *system.Faults

	mu         sync.Mutex
	state      string
	db         *sql.DB
	modules    modules
	server     *http.Server
	served     chan error
	background context.CancelFunc
	joined     chan struct{}
	stop       chan struct{}
	stopOnce   sync.Once
	stopResult error
}

// Main serves the private socket until a private stop or termination signal
// completes an orderly stop.
func Main(ctx context.Context, options Options) error {
	encoded, err := os.ReadFile(filepath.Join(options.Root, InstallationFile))
	if err != nil {
		return fmt.Errorf("read installation identity: %w", err)
	}
	var installation InstallationRecord
	if err := json.Unmarshal(encoded, &installation); err != nil || installation.Format != 1 {
		return fmt.Errorf("installation identity record is unreadable")
	}
	run := &Run{options: options, id: uuid.NewString(), installationID: installation.InstallationID, state: StateMaintenance, stop: make(chan struct{})}
	if options.TestFaults {
		run.faults = system.NewFaults()
	}
	listener, err := listenPrivate(filepath.Join(options.Root, SocketFile))
	if err != nil {
		return err
	}
	log.Printf("Core run %s for installation %s in maintenance; release %s", run.id, run.installationID, options.Release)
	go run.acceptPrivate(listener)
	select {
	case <-ctx.Done():
		run.requestStop()
	case <-run.stop:
	}
	<-run.stopped()
	return errors.Join(run.stopResult, listener.Close())
}

func (r *Run) stopped() chan struct{} {
	r.requestStop()
	return r.joinedChannel()
}

func (r *Run) joinedChannel() chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.joined == nil {
		r.joined = make(chan struct{})
	}
	return r.joined
}

// requestStop performs the orderly stop once: stop admitting HTTPS requests,
// wait for in-flight writers, join background work, then close storage.
func (r *Run) requestStop() {
	r.stopOnce.Do(func() {
		joined := r.joinedChannel()
		r.mu.Lock()
		r.state = StateStopping
		server, background, db := r.server, r.background, r.db
		r.mu.Unlock()
		var errs []error
		if server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := server.Shutdown(ctx); err != nil {
				errs = append(errs, fmt.Errorf("HTTPS writers did not finish: %w", err))
			}
			cancel()
		}
		if background != nil {
			background()
		}
		r.mu.Lock()
		done := r.served
		r.mu.Unlock()
		if done != nil {
			<-done
		}
		if db != nil {
			if err := db.Close(); err != nil {
				errs = append(errs, fmt.Errorf("close Core storage: %w", err))
			}
		}
		r.stopResult = errors.Join(errs...)
		close(r.stop)
		close(joined)
	})
}

func listenPrivate(path string) (net.Listener, error) {
	if conn, err := net.Dial("unix", path); err == nil {
		return nil, errors.Join(errors.New("another Core run owns the private socket"), conn.Close())
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale private socket: %w", err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen on private socket: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, errors.Join(fmt.Errorf("restrict private socket: %w", err), listener.Close())
	}
	return listener, nil
}

func (r *Run) acceptPrivate(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-r.stop:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept private connection: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go r.servePrivate(conn)
	}
}

// peerAllowed accepts only the installation owner, checked with Unix peer
// credentials; private requests carry no public credential.
func peerAllowed(conn net.Conn) bool {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return false
	}
	var credentials *unix.Ucred
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, credentialErr = unix.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || credentialErr != nil {
		return false
	}
	return int(credentials.Uid) == os.Getuid()
}

func (r *Run) servePrivate(conn net.Conn) {
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(2 * time.Minute)); err != nil {
		return
	}
	var reply Reply
	stopAfter := false
	if !peerAllowed(conn) {
		reply = failure("forbidden", errors.New("the private peer is not the installation owner"))
	} else {
		line, err := bufio.NewReader(io.LimitReader(conn, MaxMessageBytes)).ReadBytes('\n')
		var request Request
		if err == nil {
			err = json.Unmarshal(line, &request)
		}
		if err != nil {
			reply = failure("invalid_request", errors.New("private request is malformed"))
		} else {
			reply = r.handle(request)
			stopAfter = request.Action == ActionStop
		}
	}
	if stopAfter {
		r.requestStop()
		<-r.joinedChannel()
		if r.stopResult != nil {
			reply = failure("stop_incomplete", r.stopResult)
		} else {
			reply.State = StateStopping
		}
	}
	encoded, err := encode(reply)
	if err == nil {
		_, err = conn.Write(encoded)
	}
	if err != nil {
		log.Printf("write private reply: %v", err)
	}
}

func (r *Run) handle(request Request) Reply {
	r.mu.Lock()
	state := r.state
	r.mu.Unlock()
	base := Reply{OK: true, InstallationID: r.installationID, CoreRelease: r.options.Release, RunID: r.id, State: state}
	if request.Action == ActionHello {
		return base
	}
	if request.RunID != r.id {
		return failure("stale_run", errors.New("the request names another Core run"))
	}
	ctx := context.Background()
	switch request.Action {
	case ActionSetup:
		created, err := r.setup(ctx, request)
		if err != nil {
			return failure("setup_failed", err)
		}
		base.Created = created
		return base
	case ActionInspect:
		establishment, err := r.inspect(ctx)
		if err != nil {
			return failure("inspection_failed", err)
		}
		base.Establishment = establishment
		return base
	case ActionOpen:
		return r.open(ctx, request.ResetID, base)
	case ActionRecordActivity:
		if state != StateServing || request.Activity == nil {
			return failure("not_serving", errors.New("activity is recorded while Core serves"))
		}
		if err := r.modules.store.RecordLocal(ctx, system.Activity(*request.Activity)); err != nil {
			return failure("record_failed", err)
		}
		return base
	case ActionActivity:
		if state != StateServing {
			return failure("not_serving", errors.New("activity is read while Core serves"))
		}
		records, err := r.modules.store.ListActivity(ctx)
		if err != nil {
			return failure("read_failed", err)
		}
		base.Activity = records
		return base
	case ActionArmFault:
		if err := r.faults.ArmBeforeCommit(request.Operation, request.Count); err != nil {
			return failure("fault_unavailable", err)
		}
		return base
	case ActionStop:
		return base
	}
	return failure("invalid_request", fmt.Errorf("unknown private action %q", request.Action))
}

// modules are this run's storage owner and Core modules, built once.
type modules struct {
	store    *system.Store
	identity *identity.Module
	entities *entities.Module
	tasks    *tasks.Module
	settings coreconfig.Settings
}

// storage validates settings and opens the database once per run.
func (r *Run) storage(ctx context.Context) (modules, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.modules.store != nil {
		return r.modules, nil
	}
	settings, err := r.settings()
	if err != nil {
		return modules{}, err
	}
	db, err := system.OpenDatabase(ctx, filepath.Join(r.options.Root, DatabaseFile))
	if err != nil {
		return modules{}, err
	}
	store := system.NewStore(db, r.options.Release, time.Now, r.faults)
	entityModule, err := entities.New(store, settings)
	if err != nil {
		return modules{}, errors.Join(err, db.Close())
	}
	built := modules{store: store, identity: identity.New(store), entities: entityModule, tasks: tasks.New(store, entityModule), settings: settings}
	store.Register(built.identity, built.entities, built.tasks)
	r.db, r.modules = db, built
	return built, nil
}

func (r *Run) settings() (coreconfig.Settings, error) {
	encoded, err := os.ReadFile(filepath.Join(r.options.Root, SettingsFile))
	if err != nil {
		return coreconfig.Settings{}, fmt.Errorf("read Core settings: %w", err)
	}
	document, err := coreconfig.Decode(encoded)
	if err != nil {
		return coreconfig.Settings{}, fmt.Errorf("invalid Core settings: %w", err)
	}
	return document.Settings, nil
}

func (r *Run) setup(ctx context.Context, request Request) (bool, error) {
	if request.InstallationID != r.installationID {
		return false, errors.New("setup names another installation")
	}
	built, err := r.storage(ctx)
	if err != nil {
		return false, err
	}
	return built.store.SetUpInstallation(ctx, request.InstallationID, func(tx *sql.Tx, now time.Time) error {
		return identity.SetUp(ctx, tx, system.FormatTime(now), identity.Setup{
			AdminKeyName: request.AdminKeyName, AdminSecret: request.AdminSecret, EnrollmentPublicKey: request.EnrollmentPublicKey,
		})
	})
}

func (r *Run) inspect(ctx context.Context) (*Establishment, error) {
	built, err := r.storage(ctx)
	if err != nil {
		return nil, err
	}
	result, err := built.store.Inspect(ctx)
	if errors.Is(err, system.ErrNotSetUp) {
		return &Establishment{}, nil
	}
	if err != nil {
		return nil, err
	}
	return &Establishment{SetUp: true, InstallationID: result.InstallationID, DatasetID: result.DatasetID, ResetID: result.ResetID, WritingRelease: result.WritingRelease, EstablishedAt: result.EstablishedAt}, nil
}

// open validates settings, opens the Dataset, imports the local activity
// journal and starts HTTPS serving. Serving starts only after every module is
// ready.
func (r *Run) open(ctx context.Context, resetID string, base Reply) Reply {
	r.mu.Lock()
	state := r.state
	r.mu.Unlock()
	if state != StateMaintenance {
		return failure("already_open", errors.New("Core already left maintenance"))
	}
	built, err := r.storage(ctx)
	if err != nil {
		return failure("invalid_configuration", err)
	}
	store, entityModule := built.store, built.entities
	before, inspectErr := store.Inspect(ctx)
	if errors.Is(inspectErr, system.ErrNotSetUp) {
		return failure("not_set_up", inspectErr)
	}
	if inspectErr != nil {
		return failure("open_failed", inspectErr)
	}
	if before.InstallationID != r.installationID {
		return failure("installation_conflict", errors.New("the database belongs to another installation"))
	}
	result, err := store.Open(ctx, resetID)
	if err != nil {
		switch {
		case errors.Is(err, system.ErrReleaseMismatch):
			return failure("release_mismatch", err)
		case errors.Is(err, system.ErrSchemaDrift):
			return failure("schema_drift", err)
		case errors.Is(err, system.ErrNotSetUp):
			return failure("not_set_up", err)
		}
		return failure("open_failed", err)
	}
	if result.InstallationID != r.installationID {
		return failure("installation_conflict", errors.New("the database belongs to another installation"))
	}
	imported, err := store.ImportJournal(ctx, filepath.Join(r.options.Root, JournalDirectory))
	if err != nil {
		return failure("journal_import_failed", err)
	}
	server, err := api.NewServer(store, built.identity, entityModule, built.tasks, built.settings)
	if err != nil {
		return failure("open_failed", err)
	}
	handler, err := server.Handler()
	if err != nil {
		return failure("open_failed", err)
	}
	certificate, err := tls.LoadX509KeyPair(filepath.Join(r.options.Root, CertificateFile), filepath.Join(r.options.Root, KeyFile))
	if err != nil {
		return failure("tls_unavailable", fmt.Errorf("load server certificate: %w", err))
	}
	listener, err := tls.Listen("tcp", r.options.Listen, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}})
	if err != nil {
		return failure("listen_failed", err)
	}
	httpServer := &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
		// HTTP/1.1 keeps content-coding size accounting exact for S1.
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}
	backgroundCtx, cancel := context.WithCancel(context.Background())
	derived := make(chan struct{})
	go func() {
		defer close(derived)
		entityModule.RunCommunications(backgroundCtx, 250*time.Millisecond)
	}()
	served := make(chan error, 1)
	r.mu.Lock()
	r.server, r.state = httpServer, StateServing
	r.background = func() { cancel(); <-derived }
	r.served = served
	r.mu.Unlock()
	go func() {
		err := httpServer.Serve(listener)
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("HTTPS serving stopped: %v", err)
		}
		served <- err
		close(served)
	}()
	log.Printf("Core run %s serving Dataset %s", r.id, result.DatasetID)
	base.State = StateServing
	base.Fresh = before.DatasetID != result.DatasetID
	base.Imported = imported
	base.Establishment = &Establishment{SetUp: true, InstallationID: result.InstallationID, DatasetID: result.DatasetID, ResetID: result.ResetID, WritingRelease: result.WritingRelease, EstablishedAt: result.EstablishedAt}
	return base
}
