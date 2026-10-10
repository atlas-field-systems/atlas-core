// Command atlas-manage is the local CLI over Atlas's shared private host
// management: setup, inspection, Start, Stop, Restart and ordinary Reset.
// Results are printed as JSON. Secrets are read from and written to
// owner-only files; they never appear in arguments or output.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/atlas-field-systems/atlas-core/manager"
)

const usage = `usage: atlas-manage <command> --root DIR --recovery DIR [options]

commands:
  setup        provision trust, the first administrator key, enrollment authority and settings
  start        start Core with its retained Dataset
  stop         stop Core after its writers finish
  restart      stop and start Core, retaining its Dataset
  reset        start Core with a new Dataset, retaining installation setup
  inspect      report runtime, Dataset establishment and retained actions
  ca           print the installation CA certificate path and SHA-256 fingerprint
  authorize-enrollment  issue enrollment authorization for one Asset
  activity     list the current Dataset's recorded activity
  arm-fault    arm a private test fault (Core started with --test-faults)`

type multiple []string

func (m *multiple) String() string     { return strings.Join(*m, ",") }
func (m *multiple) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	root := flags.String("root", "", "installation root (owned directories)")
	recovery := flags.String("recovery", "", "external recovery storage for action records")
	var options manager.SetupOptions
	var hostnames, origins multiple
	flags.StringVar(&options.InstallationID, "installation-id", "", "installation identity (generated when omitted)")
	flags.StringVar(&options.Image, "image", "atlas-core:dev", "loaded Core image")
	flags.StringVar(&options.ListenAddress, "address", "127.0.0.1", "local HTTPS address")
	flags.Int64Var(&options.ListenPort, "port", 8443, "local HTTPS port")
	flags.Var(&hostnames, "hostname", "additional certificate name (repeatable)")
	flags.Var(&origins, "allowed-origin", "exact browser origin (repeatable)")
	flags.StringVar(&options.AdminKeyFile, "admin-key-file", "", "owner-only file retaining the first administrator key")
	flags.StringVar(&options.EnrollmentAuthorityFile, "enrollment-authority-file", "", "owner-only file retaining the enrollment authority key")
	flags.StringVar(&options.ServerCertificate, "server-certificate", "", "administrator-supplied server certificate (PEM)")
	flags.StringVar(&options.ServerKey, "server-key", "", "administrator-supplied server key (PEM)")
	flags.BoolVar(&options.TestFaults, "test-faults", false, "enable private test fault injection")
	actionID := flags.String("action-id", "", "Reset action identity for retry or inspection")
	assetID := flags.String("asset-id", "", "Asset ID to authorize")
	recoveryKey := flags.String("recovery-public-key", "", "Asset recovery public key (unpadded base64url)")
	operation := flags.String("operation", "", "commit operation for arm-fault")
	count := flags.Int("count", 1, "number of commits to fail for arm-fault")
	if err := flags.Parse(os.Args[2:]); err != nil {
		os.Exit(2)
	}
	options.Hostnames, options.AllowedOrigins = hostnames, origins
	if *root == "" || *recovery == "" {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	for _, path := range []*string{root, recovery} {
		absolute, err := filepath.Abs(*path)
		if err != nil {
			fail(err)
		}
		*path = absolute
	}
	installation := manager.Installation{Root: *root, Recovery: *recovery}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var result any
	var err error
	switch command {
	case "setup":
		result, err = manager.Setup(ctx, installation, options)
	case "start":
		result, err = manager.Start(ctx, installation)
	case "stop":
		result, err = manager.Stop(ctx, installation)
	case "restart":
		result, err = manager.Restart(ctx, installation)
	case "reset":
		result, err = manager.Reset(ctx, installation, *actionID)
	case "inspect":
		result, err = manager.Inspect(ctx, installation)
	case "ca":
		result, err = manager.CA(installation)
	case "authorize-enrollment":
		result, err = manager.AuthorizeEnrollment(installation, options.EnrollmentAuthorityFile, *assetID, *recoveryKey)
	case "activity":
		result, err = manager.Activity(ctx, installation)
	case "arm-fault":
		err = manager.ArmFault(ctx, installation, *operation, *count)
		result = map[string]bool{"armed": err == nil}
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	encoded, encodeErr := json.MarshalIndent(result, "", "  ")
	if encodeErr == nil {
		fmt.Println(string(encoded))
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	var busy *manager.ErrBusy
	code := 1
	if errors.As(err, &busy) {
		code = 3
	}
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(code)
}
