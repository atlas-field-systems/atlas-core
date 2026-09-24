// Command atlas-core serves one Core run until it receives SIGINT or SIGTERM.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/app"
)

const release = "0.1.0"

// Startup and shutdown bounds for one Core run.
const (
	openTimeout     = 10 * time.Second
	shutdownTimeout = 10 * time.Second
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	config := app.Config{
		SetupDir:       envOr("ATLAS_SETUP_DIR", "/var/lib/atlas/setup"),
		OperationalDir: envOr("ATLAS_OPERATIONAL_DIR", "/var/lib/atlas/operational"),
		Release:        release,
	}
	var err error
	if len(os.Args) == 2 && os.Args[1] == "check-ready" {
		err = checkReady(config)
	} else {
		err = serve(config, envOr("ATLAS_LISTEN_ADDR", ":8080"), log)
	}
	if err != nil {
		log.Error("atlas-core failed", "error", err)
		os.Exit(1)
	}
}

// checkReady is the private Docker health probe; public monitoring uses the SDK.
func checkReady(config app.Config) error {
	ctx, cancel := context.WithTimeout(context.Background(), openTimeout)
	defer cancel()
	return app.CheckReady(ctx, config)
}

func serve(config app.Config, address string, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	openCtx, cancel := context.WithTimeout(ctx, openTimeout)
	instance, err := app.Open(openCtx, config, log)
	cancel()
	if err != nil {
		return err
	}
	defer instance.Close()
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	// Integration harnesses read the bound address when listening on port 0.
	fmt.Printf("LISTEN_ADDR=%s\n", listener.Addr())
	server := newServer(instance.Handler())
	go shutdownOnSignal(ctx, server, log)
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func newServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func shutdownOnSignal(ctx context.Context, server *http.Server, log *slog.Logger) {
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Error("shutdown failed", "error", err)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
