// Command atlas-core runs one Core process inside its container. Host
// management controls it through the private socket; it has no public
// lifecycle or configuration interface.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/atlas-field-systems/atlas-core/corerun"
)

// release identifies this Core build. Release builds set it at link time.
var release = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: atlas-core serve [--root /atlas] [--listen 0.0.0.0:8443]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	root := flags.String("root", "/atlas", "Core's mounted installation root")
	listen := flags.String("listen", "0.0.0.0:8443", "HTTPS listen address inside the container")
	testFaults := flags.Bool("test-faults", false, "enable private test fault injection")
	if err := flags.Parse(os.Args[2:]); err != nil {
		os.Exit(2)
	}
	logFile, err := os.OpenFile(filepath.Join(*root, corerun.LogDirectory, "core.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatalf("open diagnostic log: %v", err)
	}
	log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	err = corerun.Main(ctx, corerun.Options{Root: *root, Listen: *listen, Release: release, TestFaults: *testFaults})
	if closeErr := logFile.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		log.Printf("Core run ended with an error: %v", err)
		os.Exit(1)
	}
}
