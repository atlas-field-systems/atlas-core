// atlas-core serves the public HTTPS contract and owner-only Unix maintenance.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

func run() error {
	state := flag.String("state-dir", "", "Core-owned database directory")
	address := flag.String("listen", "0.0.0.0:8443", "HTTPS listen address")
	certPath := flag.String("tls-cert", "", "server certificate file")
	keyPath := flag.String("tls-key", "", "server private key file")
	socket := flag.String("maintenance-socket", "", "owner-only private Unix socket")
	runID := flag.String("run-id", "", "host-prepared Core run UUID")
	ownerUID := flag.Int("owner-uid", os.Getuid(), "installation owner UID")
	ownerGID := flag.Int("owner-gid", -1, "optional local management GID")
	maintenanceOnly := flag.Bool("maintenance-only", false, "serve private maintenance before operational opening")
	journal := flag.String("activity-journal", "", "owned local activity journal")
	flag.Parse()
	if *state == "" || *socket == "" || *runID == "" {
		return errors.New("state directory, maintenance socket and run identity are required")
	}
	if err := os.MkdirAll(*state, 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(*socket), 0700); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	core, err := systemoperations.Open(ctx, systemoperations.Options{DatabasePath: filepath.Join(*state, "core.sqlite"), RunID: *runID})
	if err != nil {
		return err
	}
	defer core.Close()
	if err = os.Chmod(filepath.Join(*state, "core.sqlite"), 0600); err != nil {
		return err
	}
	stop := make(chan struct{})
	once := sync.Once{}
	maintenance, err := core.Maintenance(*socket, *ownerUID, *ownerGID, func() { once.Do(func() { close(stop) }) })
	if err != nil {
		return err
	}
	defer os.Remove(*socket)
	failures := make(chan error, 2)
	go func() { failures <- maintenance.Serve() }()
	var server *http.Server
	if !*maintenanceOnly {
		inspection, err := core.Maintain(ctx, coremaintenance.Request{RunID: *runID, ActionID: uuid.NewString(), Kind: "inspect"})
		if err != nil {
			return err
		}
		if *address != inspection.Config.ListenAddress {
			return errors.New("public listener differs from retained initial configuration")
		}
		pair, err := tls.LoadX509KeyPair(*certPath, *keyPath)
		if err != nil {
			return fmt.Errorf("load server TLS material: %w", err)
		}
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return err
		}
		public, err := url.Parse(inspection.Config.PublicAddress)
		if err != nil {
			return err
		}
		if err = leaf.VerifyHostname(public.Hostname()); err != nil {
			return fmt.Errorf("configured TLS address: %w", err)
		}
		now := time.Now()
		if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
			return errors.New("server certificate is outside its validity period")
		}
		if err = core.ImportActivity(ctx, *journal); err != nil {
			return err
		}
		handler, err := core.Handler(ctx)
		if err != nil {
			return err
		}
		server = &http.Server{Addr: *address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}, NextProtos: []string{"http/1.1"}}, TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}}
		listener, err := net.Listen("tcp", *address)
		if err != nil {
			return err
		}
		go func() { failures <- core.ServeTLS(server, listener) }()
	}
	select {
	case <-ctx.Done():
	case <-stop:
	case err = <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	var result error
	if server != nil {
		result = server.Shutdown(shutdownCtx)
	}
	result = errors.Join(result, maintenance.HTTP.Shutdown(shutdownCtx))
	return result
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Core:", err)
		os.Exit(1)
	}
}
